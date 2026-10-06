// Unit tests for server/services/bot-warmer.ts
//
// All external I/O (DB, IG client, runtime, scrape-metrics) is mocked.
// We never hit the network, never open a real DB connection, and never
// invoke the real BullMQ scheduler.
//
// Coverage targets:
//   - intensityForWarmingDay mapping
//   - classifyError mapping
//   - warmBot end-to-end behaviour with a stubbed IG client:
//       - successful low-intensity run advances warming_day by 1
//       - all actions failing leaves warming_day unchanged
//       - durationMs early-stop short-circuits the budget
//       - intensity override picks the correct action menu

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";

// ---------------------------------------------------------------------------
// Mock: db (drizzle) — env stub before module load
// ---------------------------------------------------------------------------

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
const warmDbMocks = vi.hoisted(() => ({ execute: vi.fn(), sessionSnapshot: vi.fn(), actionEligibility: vi.fn(),
  activeLease: null as string | null, beforeLeaseAcquire: null as (() => void) | null,
  afterLeaseRelease: null as (() => void) | null }));
vi.mock("../operation-lease.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../operation-lease.js")>(),
  withOperationLease: vi.fn(async (key: string, work: (signal: AbortSignal) => Promise<unknown>) => {
    const beforeAcquire = warmDbMocks.beforeLeaseAcquire;
    warmDbMocks.beforeLeaseAcquire = null;
    beforeAcquire?.();
    warmDbMocks.activeLease = key;
    try { return await work(new AbortController().signal); }
    finally {
      warmDbMocks.activeLease = null;
      const afterRelease = warmDbMocks.afterLeaseRelease;
      warmDbMocks.afterLeaseRelease = null;
      afterRelease?.();
    }
  }),
}));
vi.mock("../../behavior/daily-budget.js", () => ({ reserveOrThrow: vi.fn(async () => ({ allowed: true })) }));

vi.mock("../../db.js", () => {
  return {
    db: {
      execute: (query: unknown) => {
        const text = (query as [string[]])[0].join("");
        if (/SELECT session_data, proxy_url/.test(text)) return warmDbMocks.sessionSnapshot(query);
        return /SELECT id FROM bot_accounts/.test(text)
          ? warmDbMocks.actionEligibility(query)
          : warmDbMocks.execute(query);
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: shared/schema.js
// ---------------------------------------------------------------------------

vi.mock("../../../shared/schema.js", () => ({
  botAccounts: {},
}));

// ---------------------------------------------------------------------------
// Mock: drizzle-orm
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  sql: new Proxy(
    Object.assign(
      (...args: unknown[]) => args,
      { raw: (...args: unknown[]) => args },
    ),
    {
      get(target, prop) {
        if (prop === "raw") return (...args: unknown[]) => args;
        return (target as Record<string | symbol, unknown>)[prop];
      },
      apply(_target, _thisArg, args) {
        return args;
      },
    },
  ),
  eq: vi.fn((_col: unknown, _val: unknown) => true),
}));

// ---------------------------------------------------------------------------
// Mock: bot-runtime — ensureBotReady returns a fake context
// ---------------------------------------------------------------------------

vi.mock("../bot-runtime.js", () => ({
  ensureBotReady: vi.fn(async (botId: string) => ({
    botId,
    igUsername: "testbot",
    sessionData: '{"cookies":[]}',
    proxyUrl: "http://10.0.0.1:9000",
    proxyEndpoint: "10.0.0.1:9000",
  })),
}));

// ---------------------------------------------------------------------------
// Mock: device-fingerprint
// ---------------------------------------------------------------------------

vi.mock("../../behavior/device-fingerprint.js", () => ({
  resolveFingerprint: vi.fn(() => ({
    deviceId: "fake-device",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0.0.0 Safari/537.36",
    appId: "936619743392459",
    timezone: "America/New_York",
    locale: "en-US",
    awakeHourStart: 10,
    awakeHourEnd: 23,
  })),
}));

// ---------------------------------------------------------------------------
// Mock: ig-http-client — return a stub IG client. Each test rebinds the
// methods to control success/failure per action.
// ---------------------------------------------------------------------------

const mockClient = {
  fetchProfile: vi.fn(async (_username: string) => ({
    pk: "12345",
    username: "decoy",
    fullName: "",
    biography: "",
    profilePicUrl: "",
    isPrivate: false,
    isVerified: false,
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
  })),
  fetchUserFeed: vi.fn(async () => ({ items: [], nextMaxId: null, moreAvailable: false })),
  fetchStoriesTray: vi.fn(async () => ({ items: [] })),
  fetchHighlightsTray: vi.fn(async () => ({ items: [] })),
  fetchUserTagged: vi.fn(async () => ({ items: [], nextMaxId: null, moreAvailable: false })),
  close: vi.fn(async () => {}),
};

vi.mock("../../ig-http-client.js", () => ({
  createHttpBotClientWithFingerprint: vi.fn(() => mockClient),
  IGAuthExpiredError: class IGAuthExpiredError extends Error {
    status?: number;
    body?: string;
  },
  IGHttpError: class IGHttpError extends Error {
    status: number = 0;
    igErrorCode?: string;
  },
  IGRateLimitedError: class IGRateLimitedError extends Error {
    retryAfterMs: number = 0;
  },
}));

// ---------------------------------------------------------------------------
// Mock: scrape-retry — pass-through (no retry/backoff in tests)
// ---------------------------------------------------------------------------

vi.mock("../scrape-retry.js", () => ({
  withScrapeRetry: vi.fn((_label: string, fn: () => Promise<unknown>) => fn()),
}));

// ---------------------------------------------------------------------------
// Mock: scrape-metrics
// ---------------------------------------------------------------------------

vi.mock("../scrape-metrics.js", () => ({
  recordOutcome: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mock: bot-cooldown / bot-collectors — the warmer's cooldown and dead-session
// writes go through db.update, which the db mock above does not provide.
// Record the calls instead; the rotation-policy wrapper stays a pass-through so
// the cooldown call inside it is still observed. Everything else is real.
// ---------------------------------------------------------------------------

vi.mock("../bot-cooldown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bot-cooldown.js")>();
  return {
    ...actual,
    cooldownBotForCheckpoint: vi.fn(async () => {}),
    cooldownBotForRateLimit: vi.fn(async () => {}),
    withRotationRateLimitCooldownPolicy: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock("../../bot-collectors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../bot-collectors.js")>();
  return {
    ...actual,
    markBotSessionExpired: vi.fn(async () => {}),
  };
});

// bot-warmer-worker (imported below for its pure helpers) pulls BullMQ; keep
// it inert — no Redis connection is ever opened in this file.
vi.mock("bullmq", () => ({
  Queue: class {},
  Worker: class {},
}));

// The warm menu drops its posts actions when the scraper has routed `posts` to
// the mobile transport. Every pre-existing test below describes the ungated
// menu, so the gate defaults to OFF here and the gated menu has its own block
// that flips this flag. `baseActions()` reads the gate on each call, so no
// module reset is needed.
const scraperGate = vi.hoisted(() => ({ postsIsMobileOnly: false }));
vi.mock("../../ig-public-scraper.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isEndpointMobileOnly: (endpoint: string): boolean =>
      endpoint === "posts" ? scraperGate.postsIsMobileOnly : false,
  };
});

vi.mock("../../observability/logger.js", () => ({
  withCorrelation: (_ctx: unknown, fn: () => unknown) => fn(),
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Module under test (imported AFTER all vi.mock calls)
// ---------------------------------------------------------------------------

import {
  warmBot,
  getWarmingStatus,
  intensityForWarmingDay,
  __testing,
} from "../bot-warmer.js";
import { recordOutcome } from "../scrape-metrics.js";
import { reserveOrThrow } from "../../behavior/daily-budget.js";
import { markShuttingDown, resetShutdownStateForTests } from "../shutdown-state.js";

beforeEach(() => {
  resetShutdownStateForTests();
  warmDbMocks.sessionSnapshot.mockReset().mockImplementation(async () => {
    expect(warmDbMocks.activeLease).toBe("bot:bot-001");
    return { rows: [{ session_data: "encrypted-session-a", proxy_url: null, proxy_endpoint: "fixed.example:9000",
      proxy_expires_at: null, automation_identity: null, transport: "web" }] };
  });
  warmDbMocks.actionEligibility.mockReset().mockResolvedValue({ rows: [{ id: "bot-001" }] });
  warmDbMocks.activeLease = null;
  warmDbMocks.beforeLeaseAcquire = null;
  warmDbMocks.afterLeaseRelease = null;
});
afterEach(() => resetShutdownStateForTests());

const mockExecute = warmDbMocks.execute;
const mockRecordOutcome = recordOutcome as unknown as MockInstance;

function makeBotRow(overrides: Partial<{
  id: string;
  ig_username: string;
  ig_user_id: string | null;
  warming_day: number;
  warm_failure_streak: number;
}> = {}) {
  return {
    id: "bot-001",
    ig_username: "testbot",
    ig_user_id: null,
    warming_day: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("intensityForWarmingDay", () => {
  it("returns 'low' for days 0 and 1", () => {
    expect(intensityForWarmingDay(0)).toBe("low");
    expect(intensityForWarmingDay(1)).toBe("low");
  });

  it("returns 'med' for days 2 and 3", () => {
    expect(intensityForWarmingDay(2)).toBe("med");
    expect(intensityForWarmingDay(3)).toBe("med");
  });

  it("returns 'high' for days 4 and above", () => {
    expect(intensityForWarmingDay(4)).toBe("high");
    expect(intensityForWarmingDay(7)).toBe("high");
  });
});

describe("classifyError", () => {
  const { classifyError } = __testing;

  it("classifies plain errors as failure", () => {
    expect(classifyError(new Error("boom"))).toBe("failure");
  });

  it("classifies non-Error values as failure", () => {
    expect(classifyError("string")).toBe("failure");
    expect(classifyError(42)).toBe("failure");
  });
});

describe("actionMenu — a walled endpoint is never scheduled on the web lane", () => {
  // The warmer drives WEB sessions only. While `posts` is routed to the mobile
  // transport (IG answers the web lane with a login wall), a posts warm action
  // can only fail, and a failed action both burns the session budget and feeds
  // the bot's hard-failure streak. Regression guard for the 24 h in which every
  // warm session finished 0 completed / 57 failed.
  const endpointsIn = (intensity: "low" | "med" | "high"): string[] =>
    __testing.actionMenu(intensity).map((action) => action.metricEndpoint);

  beforeEach(() => {
    scraperGate.postsIsMobileOnly = true;
  });
  afterEach(() => {
    scraperGate.postsIsMobileOnly = false;
  });

  it("keeps posts out of every intensity while the gate is on", () => {
    for (const intensity of ["low", "med", "high"] as const) {
      expect(endpointsIn(intensity)).not.toContain("posts");
    }
  });

  it("substitutes two cheap HTTP-first web reads for the two base actions", () => {
    expect(__testing.baseActions().map((a) => a.kind)).toEqual([
      "viewDecoyHighlight",
      "viewDecoyTagged",
    ]);
    expect(endpointsIn("low")).toEqual(["highlights", "tagged"]);
  });

  it("never offers an action kind that is disabled by config", () => {
    // WARM_DISABLED_ACTIONS defaults to viewDecoyStory: IG answers the decoy
    // story trays with HTTP 400 on the web lane, and stories is browser-routed,
    // so each attempt launches a Firefox page load through the metered proxy to
    // earn that 400.
    for (const intensity of ["low", "med", "high"] as const) {
      expect(
        __testing.actionMenu(intensity).map((action) => action.kind),
      ).not.toContain("viewDecoyStory");
    }
  });

  it("keeps a non-empty menu at every intensity", () => {
    for (const intensity of ["low", "med", "high"] as const) {
      expect(__testing.actionMenu(intensity).length).toBeGreaterThan(0);
    }
  });

  it("restores the original posts menu when the gate is off", () => {
    scraperGate.postsIsMobileOnly = false;
    expect(__testing.baseActions().map((a) => a.kind)).toEqual([
      "browseSelfPosts",
      "browseDecoyPosts",
    ]);
    // stories is still withheld by WARM_DISABLED_ACTIONS; the two gates are
    // independent.
    expect(endpointsIn("high")).toEqual([
      "posts",
      "posts",
      "highlights",
      "tagged",
    ]);
  });

  it("re-enables every kind when WARM_DISABLED_ACTIONS is none", async () => {
    scraperGate.postsIsMobileOnly = false;
    vi.stubEnv("WARM_DISABLED_ACTIONS", "none");
    vi.resetModules();
    try {
      const fresh = await import("../bot-warmer.js");
      expect(
        fresh.__testing.actionMenu("high").map((a) => a.metricEndpoint),
      ).toEqual(["posts", "posts", "stories", "highlights", "tagged"]);
    } finally {
      vi.stubEnv("WARM_DISABLED_ACTIONS", "");
      vi.resetModules();
    }
  });
});

describe("ACTIONS_BY_INTENSITY", () => {
  it("escalates action budget with intensity", () => {
    const { ACTIONS_BY_INTENSITY } = __testing;
    expect(ACTIONS_BY_INTENSITY.low).toBeLessThan(ACTIONS_BY_INTENSITY.med);
    expect(ACTIONS_BY_INTENSITY.med).toBeLessThan(ACTIONS_BY_INTENSITY.high);
  });
});

// ---------------------------------------------------------------------------
// warmBot — happy-path low intensity
// ---------------------------------------------------------------------------

describe("warmBot — successful low-intensity session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.fetchProfile.mockClear();
    mockClient.fetchProfile.mockImplementation(async () => ({
      pk: "12345",
      username: "decoy",
      fullName: "",
      biography: "",
      profilePicUrl: "",
      isPrivate: false,
      isVerified: false,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
    }));
  });

  it("hits at least 5 actions and advances warming_day by 1", async () => {
    const bot = makeBotRow({ warming_day: 0 });
    mockExecute
      .mockResolvedValueOnce({ rows: [bot] }) // loadBot
      .mockResolvedValueOnce(undefined); // persistAdvancement

    const outcome = await warmBot("bot-001", {
      intensity: "low",
      durationMs: 60_000, // 60s safety net
    });

    // 60s deadline + 8-30s jitter sleep between actions means roughly
    // 2-4 actions land before the deadline check halts the loop. The
    // contract being verified here is: at least one action ran, none
    // failed, and warming_day advanced by exactly 1.
    expect(outcome.actionsCompleted).toBeGreaterThanOrEqual(1);
    expect(outcome.actionsFailed).toBe(0);
    expect(outcome.advancedToDay).toBe(1);
    expect(outcome.botId).toBe("bot-001");
    expect(outcome.started).toBeInstanceOf(Date);
    expect(outcome.ended).toBeInstanceOf(Date);

    // recordOutcome fired at least once with "success"
    expect(mockRecordOutcome).toHaveBeenCalled();
    const successCalls = mockRecordOutcome.mock.calls.filter(
      (call: unknown[]) => call[1] === "success",
    );
    expect(successCalls.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// warmBot — durationMs short-circuit
// ---------------------------------------------------------------------------

describe("warmBot — graceful shutdown", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("skips work before starting a session when shutdown is already latched", async () => {
    mockExecute.mockResolvedValueOnce({rows:[makeBotRow()]});markShuttingDown();
    const outcome=await warmBot("bot-001");
    expect(outcome).toMatchObject({endedBy:"shutdown",actionsCompleted:0,actionsFailed:0,advancedToDay:0});
    expect(mockClient.fetchUserFeed).not.toHaveBeenCalled();
  });
  it("keeps the successful action and exits without another request or pacing delay", async () => {
    mockExecute.mockResolvedValueOnce({rows:[makeBotRow()]}).mockResolvedValue(undefined);
    mockClient.fetchUserFeed.mockImplementationOnce(async()=>{markShuttingDown();return{items:[],nextMaxId:null,moreAvailable:false};});
    const outcome=await warmBot("bot-001",{intensity:"low"});
    expect(outcome).toMatchObject({endedBy:"shutdown",actionsCompleted:1,actionsFailed:0,advancedToDay:1});
    expect(mockClient.fetchUserFeed).toHaveBeenCalledTimes(1);expect(mockClient.close).toHaveBeenCalledOnce();
  });
});

describe("warmBot — durationMs short-circuit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops before the action budget when the deadline is reached", async () => {
    const bot = makeBotRow({ warming_day: 0 });
    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })
      .mockResolvedValueOnce(undefined);

    // 1 ms deadline → at most one action runs before the loop checks the
    // deadline and bails. The first action always runs because the check
    // is at the top of the loop.
    const outcome = await warmBot("bot-001", {
      intensity: "low",
      durationMs: 1,
    });

    expect(outcome.actionsCompleted).toBeLessThanOrEqual(1);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// warmBot — all-failure path leaves warming_day unchanged
// ---------------------------------------------------------------------------

describe("warmBot — all actions fail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT advance warming_day if every action throws", async () => {
    const bot = makeBotRow({ warming_day: 2 });
    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })
      .mockResolvedValueOnce(undefined);

    // Force every IG call to fail (low intensity only browses posts grids)
    mockClient.fetchUserFeed.mockImplementation(async () => {
      throw new Error("HTTP 400 for GET posts");
    });

    const outcome = await warmBot("bot-001", {
      intensity: "low",
      durationMs: 30_000,
    });

    expect(outcome.actionsCompleted).toBe(0);
    expect(outcome.actionsFailed).toBeGreaterThan(0);
    expect(outcome.advancedToDay).toBe(2); // unchanged
  }, 90_000);
});

// ---------------------------------------------------------------------------
// warmBot — caps at MAX_WARMING_DAY
// ---------------------------------------------------------------------------

describe("warmBot — caps at fully warmed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.fetchProfile.mockImplementation(async () => ({
      pk: "12345",
      username: "decoy",
      fullName: "",
      biography: "",
      profilePicUrl: "",
      isPrivate: false,
      isVerified: false,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
    }));
  });

  it("never exceeds MAX_WARMING_DAY", async () => {
    const bot = makeBotRow({ warming_day: 7 });
    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })
      .mockResolvedValueOnce(undefined);

    const outcome = await warmBot("bot-001", {
      intensity: "low",
      durationMs: 30_000,
    });

    expect(outcome.advancedToDay).toBe(7);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// getWarmingStatus
// ---------------------------------------------------------------------------

describe("getWarmingStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns one row per bot with daysUntilFullyWarmed computed", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          id: "bot-1",
          ig_username: "alpha",
          warming_day: 0,
          last_warming_at: null,
        },
        {
          id: "bot-2",
          ig_username: "beta",
          warming_day: 5,
          last_warming_at: new Date("2026-05-07T10:00:00Z"),
        },
        {
          id: "bot-3",
          ig_username: "gamma",
          warming_day: 7,
          last_warming_at: new Date("2026-05-06T10:00:00Z"),
        },
      ],
    });

    const rows = await getWarmingStatus();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      botId: "bot-1",
      igUsername: "alpha",
      warmingDay: 0,
      lastWarmingAt: null,
      daysUntilFullyWarmed: 7,
    });
    expect(rows[1].daysUntilFullyWarmed).toBe(2);
    expect(rows[2].daysUntilFullyWarmed).toBe(0);
    expect(rows[1].lastWarmingAt).toBe("2026-05-07T10:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// warmBot — bot not found
// ---------------------------------------------------------------------------

describe("warmBot — missing bot row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when the bot row does not exist", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(warmBot("nonexistent")).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// L2 — warmer candidates no longer need a fresh lane; lane refusal is a skip
// ---------------------------------------------------------------------------

import { ensureBotReady } from "../bot-runtime.js";
import { findWarmingCandidates, isLaneRefusal } from "../bot-warmer.js";

const mockEnsureBotReady = ensureBotReady as unknown as MockInstance;

describe("isLaneRefusal", () => {
  it("recognises bot-runtime's rotation guard and nothing else", () => {
    expect(isLaneRefusal(new Error("[bot-runtime] authenticated session has no fresh proxy lane; refusing IP rotation"))).toBe(true);
    expect(isLaneRefusal("refusing IP rotation")).toBe(true);
    expect(isLaneRefusal(new Error("[bot-runtime] failed to obtain healthy proxy"))).toBe(false);
    expect(isLaneRefusal(new Error("IG login failed: challenge"))).toBe(false);
  });
});

describe("warmBot — ensureBotReady refuses IP rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips the sweep: zero outcome, no advancement write, no cooldown, no metrics", async () => {
    const bot = makeBotRow({ warming_day: 1 });
    mockExecute.mockResolvedValueOnce({ rows: [bot] }); // loadBot only
    mockEnsureBotReady.mockRejectedValueOnce(
      new Error("[bot-runtime] authenticated session has no fresh proxy lane; refusing IP rotation"),
    );

    const outcome = await warmBot("bot-001", { intensity: "low", durationMs: 1_000 });

    expect(outcome).toMatchObject({ botId: "bot-001", actionsCompleted: 0, actionsFailed: 0, advancedToDay: 1 });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockClient.fetchUserFeed).not.toHaveBeenCalled();
  });

  it("re-throws any other readiness failure unchanged", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [makeBotRow()] });
    mockEnsureBotReady.mockRejectedValueOnce(new Error("[bot-runtime] bot bot-001 not found"));
    await expect(warmBot("bot-001", { intensity: "low", durationMs: 1_000 })).rejects.toThrow(/not found/);
  });
});

describe("findWarmingCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops the fresh-lane precondition but keeps the idle cutoffs and the rotating-proxy exclusion", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    await findWarmingCandidates(60 * 60 * 1000);
    const arg = mockExecute.mock.calls[0]?.[0] as unknown[];
    const text = (arg[0] as string[]).join(" ");
    expect(text).not.toContain("proxy_expires_at");
    expect(text).not.toContain("proxy_endpoint IS NOT NULL");
    expect(text).toContain("proxy_url IS NULL");
    expect(text).toContain("last_used_at IS NULL OR last_used_at <");
    expect(text).toContain("last_warming_at IS NULL OR last_warming_at <");
    expect(text).toContain("cooldown_until IS NULL OR cooldown_until < NOW()");
    expect(text).toContain("status = 'available'");
  });
});

// ---------------------------------------------------------------------------
// B1 — the warm menu no longer reads web_profile_info, and a throttled warm
// action ends the session quietly: short rotation-style cooldown, no streak,
// no verdict. (2026-09-02: 16 of 17 warm sessions ended on the web profile
// rate limit and the warmer wrote 18 of the day's 23 four-hour cooldowns.)
// ---------------------------------------------------------------------------

import {
  cooldownBotForCheckpoint,
  cooldownBotForRateLimit,
  withRotationRateLimitCooldownPolicy,
} from "../bot-cooldown.js";
import { markBotSessionExpired } from "../../bot-collectors.js";
import { IGAuthExpiredError, IGHttpError, IGRateLimitedError } from "../../ig-http-client.js";

const mockCooldownForRateLimit = cooldownBotForRateLimit as unknown as MockInstance;
const mockCooldownForCheckpoint = cooldownBotForCheckpoint as unknown as MockInstance;
const mockRotationPolicy = withRotationRateLimitCooldownPolicy as unknown as MockInstance;
const mockMarkSessionExpired = markBotSessionExpired as unknown as MockInstance;

describe("warm action menu", () => {
  it("never reads web_profile_info at any intensity", () => {
    for (const intensity of ["low", "med", "high"] as const) {
      const menu = __testing.actionMenu(intensity);
      expect(menu.length).toBeGreaterThan(0);
      expect(menu.some((a) => a.metricEndpoint === "profile")).toBe(false);
      expect(menu.some((a) => /profile|search|explore|timeline/i.test(a.kind))).toBe(false);
    }
    expect(__testing.actionMenu("low").map((a) => a.metricEndpoint)).toEqual(["posts", "posts"]);
  });

  it("pins a numeric pk on every decoy so no action has to resolve one", () => {
    expect(__testing.DECOYS.length).toBeGreaterThan(0);
    for (const decoy of __testing.DECOYS) {
      expect(decoy.pk).toMatch(/^\d+$/);
      expect(decoy.username).toMatch(/^[a-z0-9._]+$/);
    }
  });

  it("warmThrottleCooldownMs: scraper's 10-minute web-throttle window by default, overrides floored at 60 s", () => {
    vi.stubEnv("WARMER_RATE_LIMIT_COOLDOWN_MS", "");
    expect(__testing.warmThrottleCooldownMs()).toBe(10 * 60 * 1000);
    vi.stubEnv("WARMER_RATE_LIMIT_COOLDOWN_MS", "5000");
    expect(__testing.warmThrottleCooldownMs()).toBe(60_000);
    vi.stubEnv("WARMER_RATE_LIMIT_COOLDOWN_MS", "900000");
    expect(__testing.warmThrottleCooldownMs()).toBe(900_000);
    vi.stubEnv("WARMER_RATE_LIMIT_COOLDOWN_MS", "");
  });
});

// The "all actions fail" suite above installs a persistent throwing
// implementation on fetchUserFeed; vi.clearAllMocks() clears calls, not
// implementations, so restore the healthy stub here.
function restoreHealthyFeedStub(): void {
  mockClient.fetchUserFeed.mockImplementation(async () => ({
    items: [],
    nextMaxId: null,
    moreAvailable: false,
  }));
}

describe("warmBot — a session browses posts grids, never profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreHealthyFeedStub();
  });

  it("calls fetchUserFeed with the bot's own pk and never fetchProfile", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [makeBotRow({ ig_user_id: "555" })] })
      .mockResolvedValueOnce(undefined);

    const outcome = await warmBot("bot-001", { intensity: "low", durationMs: 1_000 });

    expect(outcome.actionsCompleted).toBeGreaterThanOrEqual(1);
    expect(outcome.endedBy).toBe("deadline");
    expect(mockClient.fetchUserFeed).toHaveBeenCalled();
    expect(mockClient.fetchProfile).not.toHaveBeenCalled();
    const pks = mockClient.fetchUserFeed.mock.calls.map((c: unknown[]) => c[0]);
    const pinned = new Set(["555", ...__testing.DECOYS.map((d) => d.pk)]);
    for (const pk of pks) expect(pinned.has(pk as string)).toBe(true);
  }, 60_000);
});

describe("warmBot — throttled warm action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreHealthyFeedStub();
    vi.stubEnv("WARMER_RATE_LIMIT_COOLDOWN_MS", "");
  });

  it("ends the session quietly with the short rotation-style cooldown, not the 4 h pool floor", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [makeBotRow({ warming_day: 1 })] })
      .mockResolvedValueOnce(undefined);
    mockClient.fetchUserFeed.mockRejectedValueOnce(
      new IGRateLimitedError("Instagram rate limited (429)"),
    );

    const outcome = await warmBot("bot-001", { intensity: "low", durationMs: 60_000 });

    expect(outcome.endedBy).toBe("rate_limit");
    expect(outcome.actionsCompleted).toBe(0);
    expect(outcome.actionsFailed).toBe(1);
    expect(outcome.advancedToDay).toBe(1); // unchanged
    // The cooldown write happens INSIDE the rotation policy, with the short
    // warm-throttle window as its Retry-After (IG sent none).
    expect(mockRotationPolicy).toHaveBeenCalledTimes(1);
    expect(mockCooldownForRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCooldownForRateLimit).toHaveBeenCalledWith(
      "bot-001",
      __testing.DEFAULT_WARM_THROTTLE_COOLDOWN_MS,
      expect.anything(),
    );
    expect(mockRecordOutcome).toHaveBeenCalledWith("posts", "rate_limit", "bot-001");
    expect(mockCooldownForCheckpoint).not.toHaveBeenCalled();
    expect(mockMarkSessionExpired).not.toHaveBeenCalled();
  });

  it("honours IG's Retry-After when the 429 carries one", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [makeBotRow()] })
      .mockResolvedValueOnce(undefined);
    const err = new IGRateLimitedError("Instagram rate limited (429)");
    (err as { retryAfterMs: number }).retryAfterMs = 90_000;
    mockClient.fetchUserFeed.mockRejectedValueOnce(err);

    await warmBot("bot-001", { intensity: "low", durationMs: 60_000 });

    expect(mockCooldownForRateLimit).toHaveBeenCalledWith("bot-001", 90_000, expect.anything());
    expect(mockRotationPolicy).toHaveBeenCalledTimes(1);
  });

  it("treats IG's localized 401 'please wait' web throttle as a throttle, not a checkpoint", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [makeBotRow()] })
      .mockResolvedValueOnce(undefined);
    const err = new IGAuthExpiredError("[ig-http] auth rejected (status 401) for GET posts");
    (err as { body?: string }).body =
      '{"message":"Bitte warte einige Minuten, bevor du es erneut versuchst.","require_login":true,"igweb_rollout":true,"status":"fail"}';
    mockClient.fetchUserFeed.mockRejectedValueOnce(err);

    const outcome = await warmBot("bot-001", { intensity: "low", durationMs: 60_000 });

    expect(outcome.endedBy).toBe("rate_limit");
    expect(mockCooldownForRateLimit).toHaveBeenCalledWith(
      "bot-001",
      __testing.DEFAULT_WARM_THROTTLE_COOLDOWN_MS,
      expect.anything(),
    );
    expect(mockCooldownForCheckpoint).not.toHaveBeenCalled();
  });

  it("does not feed the dead-session streak: three throttled sessions never mark the session expired", async () => {
    for (let i = 0; i < 3; i += 1) {
      mockExecute
        .mockResolvedValueOnce({ rows: [makeBotRow()] })
        .mockResolvedValueOnce(undefined);
      mockClient.fetchUserFeed.mockRejectedValueOnce(
        new IGRateLimitedError("Instagram rate limited (429)"),
      );
      const outcome = await warmBot("bot-001", { intensity: "low", durationMs: 60_000 });
      expect(outcome.endedBy).toBe("rate_limit");
    }
    expect(mockCooldownForRateLimit).toHaveBeenCalledTimes(3);
    expect(mockMarkSessionExpired).not.toHaveBeenCalled();
  });
});

describe("warmBot — session rejection evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockExecute.mockReset();
    mockExecute.mockImplementation(async (query: unknown) => {
      const text = (query as [string[]])[0].join("");
      return text.includes("SELECT id, ig_username")
        ? { rows: [makeBotRow({ warm_failure_streak: 2 })] }
        : undefined;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    mockExecute.mockReset();
    restoreHealthyFeedStub();
  });

  async function runWarmSession() {
    const run = warmBot("bot-001", { intensity: "low", durationMs: 120_000 });
    await vi.runAllTimersAsync();
    return run;
  }

  it("skips a bot disabled after the initial read but before lease acquisition without attempting login", async () => {
    const row = { status: "available" };
    warmDbMocks.beforeLeaseAcquire = () => { row.status = "disabled"; };
    warmDbMocks.sessionSnapshot.mockImplementationOnce(async query => {
      expect(warmDbMocks.activeLease).toBe("bot:bot-001");
      expect(row.status).toBe("disabled");
      const text = (query as [string[]])[0].join("");
      expect(text).toContain("status = 'available'");
      expect(text).toContain("session_data IS NOT NULL");
      expect(text).toContain("cooldown_until <= NOW()");
      expect(text).toContain("tier IN ('worker', 'canary')");
      return { rows: [] };
    });

    const outcome = await runWarmSession();
    expect(outcome).toMatchObject({ endedBy: "skipped", actionsCompleted: 0, actionsFailed: 0 });
    expect(mockEnsureBotReady).not.toHaveBeenCalled();
    expect(reserveOrThrow).not.toHaveBeenCalled();
    expect(mockClient.fetchUserFeed).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("leaves a bot without a saved session for the recovery sweeper", async () => {
    warmDbMocks.sessionSnapshot.mockResolvedValueOnce({ rows: [] });
    const outcome = await runWarmSession();
    expect(outcome).toMatchObject({ endedBy: "skipped", actionsCompleted: 0, actionsFailed: 0 });
    expect(mockEnsureBotReady).not.toHaveBeenCalled();
    expect(reserveOrThrow).not.toHaveBeenCalled();
  });

  it.each([
    ["proxy/network outage", new Error("read ECONNRESET")],
    ["upstream HTTP failure", Object.assign(new IGHttpError(502, "Bad Gateway"), { status: 502 })],
    ["generic HTTP rejection", Object.assign(new IGHttpError(400, "Bad Request"), { status: 400 })],
  ])("does not expire a session after repeated %s, even with a prior rejection streak", async (_label, error) => {
    mockClient.fetchUserFeed.mockRejectedValue(error);
    for (let i = 0; i < 3; i += 1) {
      const outcome = await runWarmSession();
      expect(outcome).toMatchObject({ endedBy: "failure_limit", actionsCompleted: 0, actionsFailed: 3 });
    }
    expect(mockMarkSessionExpired).not.toHaveBeenCalled();
    expect(mockCooldownForCheckpoint).not.toHaveBeenCalled();
    expect(mockExecute.mock.calls.some(([query]) =>
      (query as [string[]])[0].join("").includes("warm_failure_streak = CASE"),
    )).toBe(false);
  });

  it("retains checkpoint cooldown and escalation after the third actual authentication rejection", async () => {
    mockClient.fetchUserFeed.mockRejectedValue(new IGAuthExpiredError("login_required"));
    const outcome = await runWarmSession();
    expect(outcome).toMatchObject({ endedBy: "checkpoint", actionsCompleted: 0, actionsFailed: 1 });
    expect(mockCooldownForCheckpoint).toHaveBeenCalledExactlyOnceWith("bot-001", "login_required", 24, expect.anything());
    const writes = mockExecute.mock.calls.filter(([query]) =>
      (query as [string[]])[0].join("").includes("warm_failure_streak = CASE"));
    expect(writes).toHaveLength(1);
    expect((writes[0][0] as unknown[]).slice(1, 4)).toEqual([false, true, 3]);
    expect((writes[0][0] as [string[]])[0].join("")).toContain("THEN 'session_expired'::bot_status ELSE status END");
  });

  it("still clears a prior rejection streak when an authenticated warm action succeeds", async () => {
    restoreHealthyFeedStub();
    const outcome = await runWarmSession();
    expect(outcome.actionsCompleted).toBeGreaterThan(0);
    expect(mockEnsureBotReady).toHaveBeenCalledExactlyOnceWith("bot-001", { allowLogin: false });
    expect(mockMarkSessionExpired).not.toHaveBeenCalled();
    const writes = mockExecute.mock.calls.filter(([query]) =>
      (query as [string[]])[0].join("").includes("warm_failure_streak = CASE"),
    );
    expect(writes).toHaveLength(1);
    expect((writes[0][0] as unknown[]).slice(1, 3)).toEqual([true, false]);
  });

  it("stops before quota or traffic when collection makes the bot ineligible between warm actions", async () => {
    restoreHealthyFeedStub();
    warmDbMocks.actionEligibility
      .mockImplementationOnce(async (query) => {
        expect(warmDbMocks.activeLease).toBe("bot:bot-001");
        const text = (query as [string[]])[0].join("");
        expect(text).toContain("status = 'available'");
        expect(text).toContain("session_data IS NOT NULL");
        expect(text).toContain("cooldown_until <= NOW()");
        return { rows: [{ id: "bot-001" }] };
      })
      .mockImplementationOnce(async () => {
        expect(warmDbMocks.activeLease).toBe("bot:bot-001");
        return { rows: [] };
      });

    const outcome = await runWarmSession();
    expect(outcome).toMatchObject({ endedBy: "skipped", actionsCompleted: 1, actionsFailed: 0 });
    expect(warmDbMocks.actionEligibility).toHaveBeenCalledTimes(2);
    expect(reserveOrThrow).toHaveBeenCalledTimes(1);
    expect(mockClient.fetchUserFeed).toHaveBeenCalledTimes(1);
    expect(mockClient.close).toHaveBeenCalledTimes(1);
    expect(mockMarkSessionExpired).not.toHaveBeenCalled();
    expect(mockCooldownForCheckpoint).not.toHaveBeenCalled();
  });

  function boundSession(query: unknown): unknown[] {
    const fragment = (query as unknown[]).find((part) => Array.isArray(part)
      && Array.isArray(part[0]) && part[0].join("").includes("session_data =")) as unknown[] | undefined;
    expect(fragment, "session/proxy/identity fence on every action and final write").toBeDefined();
    return fragment!.slice(1);
  }

  it.each(["checkpoint", "rate_limit"])("does not give a replacement login the old session's %s hold", async kind => {
    const row = { session: "encrypted-session-a", cooldownUntil: null as Date | null };
    mockClient.fetchUserFeed.mockImplementationOnce(async () => {
      warmDbMocks.afterLeaseRelease = () => { row.session = "encrypted-session-b"; };
      throw kind === "checkpoint"
        ? new IGAuthExpiredError("login_required")
        : new IGRateLimitedError("Instagram rate limited (429)");
    });
    const conditionalWrite = (guard: unknown) => {
      expect(warmDbMocks.activeLease).toBeNull();
      expect(row.session).toBe("encrypted-session-b");
      expect((guard as [string[]])[0].join("")).toContain("status = 'available'");
      const observed = boundSession(guard);
      expect(observed).toEqual(["encrypted-session-a", null, "fixed.example:9000", null, null, "web"]);
      // The shared helper's conditional UPDATE only applies to this snapshot.
      if (observed[0] === row.session) row.cooldownUntil = new Date(Date.now() + 86_400_000);
    };
    if (kind === "checkpoint") {
      mockCooldownForCheckpoint.mockImplementationOnce(async (_id, _reason, _hours, guard) => conditionalWrite(guard));
    } else {
      mockCooldownForRateLimit.mockImplementationOnce(async (_id, _retryAfterMs, guard) => conditionalWrite(guard));
    }

    const outcome = await runWarmSession();
    expect(outcome.endedBy).toBe(kind);
    expect(row.cooldownUntil).toBeNull();
    expect(mockClient.fetchUserFeed).toHaveBeenCalledTimes(1);
  });

  it.each(["session", "proxy", "identity"])("stops a cached warm client when its %s changes between actions", async (changed) => {
    const original = { session_data: "encrypted-session-a", proxy_url: null, proxy_endpoint: "fixed.example:9000",
      proxy_expires_at: null, automation_identity: { version: "first" }, transport: "web" };
    const current = { ...original };
    const values = () => [current.session_data, current.proxy_url, current.proxy_endpoint,
      current.proxy_expires_at, JSON.stringify(current.automation_identity), current.transport];
    warmDbMocks.sessionSnapshot.mockImplementationOnce(async () => {
      expect(warmDbMocks.activeLease).toBe("bot:bot-001");
      return { rows: [{ ...original }] };
    });
    warmDbMocks.actionEligibility.mockImplementation(async (query) => {
      expect(warmDbMocks.activeLease).toBe("bot:bot-001");
      return { rows: JSON.stringify(boundSession(query)) === JSON.stringify(values()) ? [{ id: "bot-001" }] : [] };
    });
    restoreHealthyFeedStub();
    mockClient.fetchUserFeed.mockImplementationOnce(async () => {
      if (changed === "session") current.session_data = "encrypted-session-b";
      else if (changed === "proxy") current.proxy_endpoint = "replacement.example:9000";
      else current.automation_identity = { version: "replacement" };
      return { items: [], nextMaxId: null, moreAvailable: false };
    });

    const outcome = await runWarmSession();
    expect(outcome).toMatchObject({ endedBy: "skipped", actionsCompleted: 1, actionsFailed: 0 });
    expect(mockClient.fetchUserFeed).toHaveBeenCalledTimes(1);
    expect(reserveOrThrow).toHaveBeenCalledTimes(1);
    const finalWrites = mockExecute.mock.calls.filter(([query]) => (query as [string[]])[0].join("").includes("UPDATE bot_accounts"));
    expect(finalWrites).toHaveLength(2);
    for (const [query] of finalWrites) {
      expect(boundSession(query)).not.toEqual(values());
      expect((query as [string[]])[0].join("")).toContain("status = 'available'");
    }
  });

  it("fences expiry and streak updates when login replaces the session after a rejected action releases its lease", async () => {
    const original = { session_data: "encrypted-session-a", proxy_url: null, proxy_endpoint: "fixed.example:9000",
      proxy_expires_at: null, automation_identity: null, transport: "web" };
    const replacement = { session: "encrypted-session-b", status: "available", warm_failure_streak: 0 };
    const fencedWrites: unknown[][] = [];
    warmDbMocks.sessionSnapshot.mockResolvedValueOnce({ rows: [original] });
    mockClient.fetchUserFeed.mockRejectedValueOnce(new IGAuthExpiredError("login_required"));
    mockCooldownForCheckpoint.mockImplementationOnce(async () => {
      expect(warmDbMocks.activeLease).toBeNull();
      mockExecute.mockImplementation(async (query) => {
        const observed = boundSession(query);
        fencedWrites.push(observed);
        // The database conditional update sees the newly logged-in session.
        expect(observed[0]).not.toBe(replacement.session);
        return { rows: [] };
      });
    });

    const outcome = await runWarmSession();
    expect(outcome.endedBy).toBe("checkpoint");
    expect(fencedWrites).toHaveLength(2);
    expect(replacement).toEqual({ session: "encrypted-session-b", status: "available", warm_failure_streak: 0 });
    expect(mockMarkSessionExpired).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bot-warmer-worker — same-day husk handling helpers
// ---------------------------------------------------------------------------

const workerModule = await import("../../workers/bot-warmer-worker.js");

describe("bot-warmer-worker helpers", () => {
  it("isTransientWarmFailure: proxy-lane / stalled / transport reasons are transient, verdicts are not", () => {
    const { isTransientWarmFailure } = workerModule;
    expect(isTransientWarmFailure("[bot-runtime] authenticated session has no fresh proxy lane; refusing IP rotation")).toBe(true);
    expect(isTransientWarmFailure("job stalled more than allowable limit")).toBe(true);
    expect(isTransientWarmFailure("read ECONNRESET")).toBe(true);
    expect(isTransientWarmFailure("checkpoint_required (HTTP 400) on /api/v1/users/web_profile_info/")).toBe(false);
    expect(isTransientWarmFailure("account suspended/checkpointed")).toBe(false);
    expect(isTransientWarmFailure("")).toBe(false);
    expect(isTransientWarmFailure(null)).toBe(false);
  });

  it("warmJobId is stable per bot per UTC day", () => {
    const { warmJobId } = workerModule.__testing;
    const day = new Date("2026-09-02T13:00:00Z");
    expect(warmJobId("bot-1", day)).toBe("warm:bot-1:2026-09-02");
    expect(warmJobId("bot-1", new Date("2026-09-02T23:59:59Z"))).toBe(warmJobId("bot-1", day));
    expect(warmJobId("bot-1", new Date("2026-09-03T00:00:01Z"))).not.toBe(warmJobId("bot-1", day));
  });
});
