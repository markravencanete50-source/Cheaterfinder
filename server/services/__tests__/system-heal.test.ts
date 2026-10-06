// Unit tests for self-healing reliability fixes:
//
//   1. ig-circuit-breaker auto-recovery — half-open after 60s, then full
//      CLOSED on a successful probe.
//   2. paginateFollowList — breaker-class mid-walk failure triggers ONE
//      long-sleep retry from the same cursor (the breaker auto-resets after
//      60s, so a longer sleep often gets the next page).
//
// Both layers are exercised purely in-memory: no DB, no network, no Redis.
// We mock observability + scrape-retry + ig-http-client error shapes the
// same way the existing pagination tests do.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
// Pin the mid-walk retry budget so call-count assertions stay deterministic
// regardless of the production default (env-tunable, defaults higher in prod).
vi.stubEnv("FOLLOW_MIDWALK_RETRY_BUDGET", "3");

vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock("../scrape-retry.js", () => ({
  withScrapeRetry: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
    fn(),
  ),
}));

vi.mock("../scrape-metrics.js", () => ({
  recordOutcome: vi.fn(),
}));

vi.mock("../../ig-http-client.js", () => ({
  IGAuthExpiredError: class IGAuthExpiredError extends Error {},
  IGHttpError: class IGHttpError extends Error {
    status: number = 0;
    igErrorCode?: string;
  },
}));

const { scrapeUserFollowers } = vi.hoisted(() => ({
  scrapeUserFollowers: vi.fn(),
}));

vi.mock("../../ig-public-scraper.js", () => ({
  scrapeProfile: vi.fn(),
  scrapeUserPosts: vi.fn(),
  scrapeUserClips: vi.fn(),
  scrapeUserTagged: vi.fn(),
  scrapeUserStories: vi.fn(),
  scrapeUserHighlights: vi.fn(),
  scrapeUserFollowers,
  scrapeUserFollowing: vi.fn(),
  scrapeMediaComments: vi.fn(),
  scrapeMediaLikers: vi.fn(),
  IGListRestrictedError: class IGListRestrictedError extends Error {
    botId?: string;
  },
  IGPublicScraperError: class IGPublicScraperError extends Error {
    cause?: unknown;
    constructor(message: string, cause?: unknown) {
      super(message);
      this.name = "IGPublicScraperError";
      this.cause = cause;
    }
  },
}));

// ─── Suite 1: circuit breaker self-healing ─────────────────────────────────

describe("ig-circuit-breaker — half-open after 60s", () => {
  let assertCanCall: typeof import("../../domain/ig-circuit-breaker.js").assertCanCall;
  let recordSuccess: typeof import("../../domain/ig-circuit-breaker.js").recordSuccess;
  let recordFailure: typeof import("../../domain/ig-circuit-breaker.js").recordFailure;
  let getBreakerSnapshot: typeof import("../../domain/ig-circuit-breaker.js").getBreakerSnapshot;
  let resetBreaker: typeof import("../../domain/ig-circuit-breaker.js").resetBreaker;
  let IGCircuitOpenError: typeof import("../../domain/ig-client-port.js").IGCircuitOpenError;

  beforeEach(async () => {
    // Reset module state between tests so the in-memory breaker doesn't
    // leak samples across cases.
    vi.resetModules();
    vi.useFakeTimers();
    const breaker = await import("../../domain/ig-circuit-breaker.js");
    const port = await import("../../domain/ig-client-port.js");
    assertCanCall = breaker.assertCanCall;
    recordSuccess = breaker.recordSuccess;
    recordFailure = breaker.recordFailure;
    getBreakerSnapshot = breaker.getBreakerSnapshot;
    resetBreaker = breaker.resetBreaker;
    IGCircuitOpenError = port.IGCircuitOpenError;
  });

  afterEach(() => {
    resetBreaker();
    vi.useRealTimers();
  });

  // Wave 6: breaker is keyed per (botId, endpointFamily). Tests use a single
  // synthetic key so the per-key state behaves like the legacy global breaker.
  const KEY = "bot-test:profile";

  it("trips OPEN when failure rate exceeds the threshold", () => {
    // 10 failures (>= MIN_SAMPLES, 100% failure rate)
    for (let i = 0; i < 10; i += 1) recordFailure(KEY);
    const snap = getBreakerSnapshot(KEY);
    expect(snap.state).toBe("OPEN");
    expect(snap.openUntil).not.toBeNull();
  });

  it("blocks calls while OPEN with IGCircuitOpenError", () => {
    for (let i = 0; i < 10; i += 1) recordFailure(KEY);
    expect(() => assertCanCall(KEY)).toThrow(IGCircuitOpenError);
  });

  it("transitions OPEN → HALF_OPEN after 60s and allows ONE probe", () => {
    for (let i = 0; i < 10; i += 1) recordFailure(KEY);
    expect(getBreakerSnapshot(KEY).state).toBe("OPEN");

    // Advance past the 60s half-open window.
    vi.advanceTimersByTime(61_000);

    const probe = assertCanCall(KEY);
    expect(probe.probe).toBe(true);
    expect(getBreakerSnapshot(KEY).state).toBe("HALF_OPEN");

    // A second concurrent call during HALF_OPEN must be rejected — only
    // ONE probe is allowed.
    expect(() => assertCanCall(KEY)).toThrow(IGCircuitOpenError);
  });

  it("HALF_OPEN probe success → CLOSED", () => {
    for (let i = 0; i < 10; i += 1) recordFailure(KEY);
    vi.advanceTimersByTime(61_000);
    const probe = assertCanCall(KEY);
    expect(probe.probe).toBe(true);
    recordSuccess(KEY, true);
    expect(getBreakerSnapshot(KEY).state).toBe("CLOSED");
  });

  it("HALF_OPEN probe failure → OPEN again with another 60s timer", () => {
    for (let i = 0; i < 10; i += 1) recordFailure(KEY);
    vi.advanceTimersByTime(61_000);
    assertCanCall(KEY); // grants the probe
    recordFailure(KEY, true);
    expect(getBreakerSnapshot(KEY).state).toBe("OPEN");

    // Still OPEN at +59s into the new timer
    vi.advanceTimersByTime(59_000);
    expect(getBreakerSnapshot(KEY).state).toBe("OPEN");

    // HALF_OPEN again at +61s
    vi.advanceTimersByTime(2_000);
    const probe = assertCanCall(KEY);
    expect(probe.probe).toBe(true);
  });

  it("isolates failures per key — one bad (bot,endpoint) does not trip another", () => {
    const KEY_A = "botA:followers";
    const KEY_B = "botB:profile";
    for (let i = 0; i < 10; i += 1) recordFailure(KEY_A);
    expect(getBreakerSnapshot(KEY_A).state).toBe("OPEN");
    // Independent key stays CLOSED — no global cascade.
    expect(getBreakerSnapshot(KEY_B).state).toBe("CLOSED");
    expect(() => assertCanCall(KEY_B)).not.toThrow();
  });
});

// ─── Suite 2: paginateFollowList breaker-recovery retry ────────────────────

describe("paginateFollowList — breaker-class mid-walk retry", () => {
  beforeEach(() => {
    vi.resetModules();
    scrapeUserFollowers.mockReset();
  });

  it("retries ONCE from the same cursor when the breaker trips mid-walk", async () => {
    // Page 1: success (50 users, cursor=p2)
    // Page 2: breaker open
    // Page 2 (retry): success (30 users, no cursor) — accumulator = 80
    let callIndex = 0;
    scrapeUserFollowers.mockImplementation(async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          users: Array.from({ length: 50 }, (_, i) => ({
            igUserId: `u${i}`,
            username: `u${i}`,
            fullName: "",
            profilePicUrl: "",
            isPrivate: false,
            isVerified: false,
          })),
          nextCursor: "p2",
        };
      }
      if (callIndex === 2) {
        const err = new Error("ig circuit breaker is OPEN — blocked");
        throw err;
      }
      return {
        users: Array.from({ length: 30 }, (_, i) => ({
          igUserId: `v${i}`,
          username: `v${i}`,
          fullName: "",
          profilePicUrl: "",
          isPrivate: false,
          isVerified: false,
        })),
        nextCursor: null,
      };
    });

    const { getAllUserFollowers } = await import("../public-data-service.js");

    // Speed up the retry sleep — pageDelayMaxMs * 3 = 60s by default; we
    // override it to keep the test fast. The recoverySleepMs floor is 60s
    // in the implementation; we mock setTimeout so it returns immediately.
    const setTimeoutSpy = vi
      .spyOn(global, "setTimeout")
      .mockImplementation((cb: (...args: unknown[]) => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const res = await getAllUserFollowers("user", "user-id-123", {
      maxPages: 5,
      maxItems: 1000,
      pageDelayMinMs: 0,
      pageDelayMaxMs: 0,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.length).toBe(80); // 50 + 30
    }
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(3);

    setTimeoutSpy.mockRestore();
  });

  it("returns partial data if the breaker-recovery retry also fails", async () => {
    let callIndex = 0;
    scrapeUserFollowers.mockImplementation(async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          users: Array.from({ length: 25 }, (_, i) => ({
            igUserId: `u${i}`,
            username: `u${i}`,
            fullName: "",
            profilePicUrl: "",
            isPrivate: false,
            isVerified: false,
          })),
          nextCursor: "p2",
        };
      }
      throw new Error("ig circuit breaker is OPEN — still blocked");
    });

    const { getAllUserFollowers } = await import("../public-data-service.js");

    const setTimeoutSpy = vi
      .spyOn(global, "setTimeout")
      .mockImplementation((cb: (...args: unknown[]) => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const res = await getAllUserFollowers("user", "user-id-123", {
      maxPages: 5,
      maxItems: 1000,
      pageDelayMinMs: 0,
      pageDelayMaxMs: 0,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.length).toBe(25); // partial — first page only
    }
    // 1 ok page + 1 failed page + 3 failed same-cursor retries (budget) = 5
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(5);

    setTimeoutSpy.mockRestore();
  });

  it("retries non-breaker mid-walk failures up to the budget, then returns partial", async () => {
    let callIndex = 0;
    scrapeUserFollowers.mockImplementation(async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          users: Array.from({ length: 10 }, (_, i) => ({
            igUserId: `u${i}`,
            username: `u${i}`,
            fullName: "",
            profilePicUrl: "",
            isPrivate: false,
            isVerified: false,
          })),
          nextCursor: "p2",
        };
      }
      // generic error — NOT a breaker error
      throw new Error("network blip");
    });

    const { getAllUserFollowers, __setMidwalkRetrySleepForTests } = await import(
      "../public-data-service.js"
    );
    __setMidwalkRetrySleepForTests(async () => {}); // skip the real backoff

    const res = await getAllUserFollowers("user", "user-id-123", {
      maxPages: 5,
      maxItems: 1000,
      pageDelayMinMs: 0,
      pageDelayMaxMs: 0,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.length).toBe(10);
    // non-breaker failures now retry too: 1 success + 1 failure + 3 retries (budget) = 5
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(5);
  });
});
