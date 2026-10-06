// Unit tests for getPublicProfile in public-data-service.ts (audit fixes
// A3 / A5 / A7 / A4-wiring).
//
// Coverage:
//   - A3: HTTP leg rate-limited + browser leg failing for an UNRELATED
//     reason (empty pool / client build) → failure carries rateLimited:true
//     and the error message retains the rate-limit shape.
//   - A3 guard: browser leg proving the profile permanently gone
//     (404 / not found) → rateLimited:false (hard failure, no cache).
//   - A5: browser leg attempts are capped (initial + 1 rotation = 2
//     Chromium launches max), never the legacy 7.
//   - A4 wiring: the HTTP rotation leg runs under
//     withRotationRateLimitCooldownPolicy; non-rotating calls do not.
//   - A7: parseEnvInt allows an explicit 0 (Number(x) || fallback did not).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

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

// scrape-retry pass-through — rotation behavior is what we are testing.
vi.mock("../scrape-retry.js", () => ({
  withScrapeRetry: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
    fn(),
  ),
}));

vi.mock("../scrape-metrics.js", () => ({
  recordOutcome: vi.fn(),
}));

vi.mock("../../ig-http-client.js", () => ({
  IGAuthExpiredError: class IGAuthExpiredError extends Error {
    status?: number;
    body?: string;
    constructor(message: string, options?: { status?: number; body?: string }) {
      super(message); this.status = options?.status; this.body = options?.body;
    }
  },
  IGHttpError: class IGHttpError extends Error {
    status: number;
    body?: string;
    igErrorCode?: string;
    constructor(
      status = 0,
      message = "Instagram request failed",
      options?: { body?: string; igErrorCode?: string },
    ) {
      super(message);
      this.name = "IGHttpError";
      this.status = status;
      this.body = options?.body;
      this.igErrorCode = options?.igErrorCode;
    }
  },
  IGRateLimitedError: class IGRateLimitedError extends Error {
    retryAfterMs: number;
    constructor(retryAfterMs = 0) {
      super(`rate limited (429); retry-after=${retryAfterMs}ms`);
      this.name = "IGRateLimitedError";
      this.retryAfterMs = retryAfterMs;
    }
  },
}));

// bot-cooldown: recording passthrough so we can assert the rotation policy
// wrap fires (and the db.js import chain never loads).
const { withRotationRateLimitCooldownPolicy } = vi.hoisted(() => ({
  withRotationRateLimitCooldownPolicy: vi.fn(
    async (fn: () => Promise<unknown>) => fn(),
  ),
}));

vi.mock("../bot-cooldown.js", () => ({
  withRotationRateLimitCooldownPolicy,
  cooldownBotForRateLimit: vi.fn(),
  cooldownBotForCheckpoint: vi.fn(),
  resolveRateLimitCooldownMs: vi.fn(),
}));

const {
  scrapeProfile,
  scrapeProfileById,
  scrapeProfileViaBrowser,
  scrapeUserPosts,
  scrapeUserFollowing,
  MockIGPublicScraperError,
  MockIGListRestrictedError,
} = vi.hoisted(() => {
  class MockIGPublicScraperError extends Error {
    cause?: unknown;
    constructor(message: string, cause?: unknown) {
      super(message);
      this.name = "IGPublicScraperError";
      this.cause = cause;
    }
  }
  class MockIGListRestrictedError extends MockIGPublicScraperError {
    botId: string | null;
    constructor(botId: string) {
      super("following list restricted by Instagram (special_empty_state)");
      this.name = "IGListRestrictedError";
      this.botId = botId;
    }
  }
  return {
    scrapeProfile: vi.fn(),
    scrapeProfileById: vi.fn(),
    scrapeProfileViaBrowser: vi.fn(),
    scrapeUserPosts: vi.fn(),
    scrapeUserFollowing: vi.fn(),
    MockIGPublicScraperError,
    MockIGListRestrictedError,
  };
});

vi.mock("../../ig-public-scraper.js", () => ({
  scrapeProfile,
  scrapeProfileById,
  scrapeProfileViaBrowser,
  scrapeUserPosts,
  scrapeUserClips: vi.fn(),
  scrapeUserTagged: vi.fn(),
  scrapeUserStories: vi.fn(),
  scrapeUserHighlights: vi.fn(),
  scrapeUserFollowers: vi.fn(),
  scrapeUserFollowing,
  scrapeMediaComments: vi.fn(),
  scrapeMediaLikers: vi.fn(),
  scrapeUserPostsWithBot: vi.fn(),
  scrapeUserStoriesWithBot: vi.fn(),
  scrapeUserHighlightsWithBot: vi.fn(),
  scrapeMediaLikersWithBot: vi.fn(),
  scrapeMediaCommentsWithBot: vi.fn(),
  scrapeUserFollowersWithBot: vi.fn(),
  scrapeUserFollowingWithBot: vi.fn(),
  IGPublicScraperError: MockIGPublicScraperError,
  IGListRestrictedError: MockIGListRestrictedError,
}));

import {
  getPublicProfile,
  getUserPosts,
  getUserFollowing,
  parseEnvInt,
  __testingProfileBreaker,
} from "../public-data-service.js";
import { IGAuthExpiredError, IGHttpError, IGRateLimitedError } from "../../ig-http-client.js";

function rateLimitError(): MockIGPublicScraperError {
  return new MockIGPublicScraperError(
    "profile scrape failed: rate limited (429)",
    new (IGRateLimitedError as unknown as new (ms?: number) => Error)(1000),
  );
}

const PROFILE_FIXTURE = {
  igUserId: "igu-1",
  username: "target",
  fullName: "Target User",
  biography: "",
  profilePicUrl: "",
  profilePicUrlHd: "",
  isPrivate: false,
  isVerified: false,
  isBusinessAccount: false,
  externalUrl: null,
  followerCount: 10,
  followingCount: 5,
  postCount: 3,
};

beforeEach(() => {
  scrapeProfile.mockReset();
  scrapeProfileById.mockReset();
  scrapeProfileViaBrowser.mockReset();
  scrapeUserPosts.mockReset();
  scrapeUserFollowing.mockReset();
  withRotationRateLimitCooldownPolicy.mockClear();
  // The web_profile_info breaker is process-global; reset it between tests so a
  // rate-limit in one test does not leak a paused state into the next.
  __testingProfileBreaker.reset();
});

describe("getPublicProfile — web_profile_info global circuit breaker", () => {
  it("skips web_profile_info on the next call after it rate-limits, going straight to browser", async () => {
    // First call: web rate-limited, browser also fails → breaker trips.
    scrapeProfile.mockRejectedValue(rateLimitError());
    scrapeProfileViaBrowser.mockRejectedValue(
      new MockIGPublicScraperError("no available bot in the pool"),
    );

    const first = await getPublicProfile("target");
    expect(first.ok).toBe(false);
    // web leg rotates internally (initial + rotations) — the point is it WAS
    // exercised and the rate-limit tripped the breaker.
    expect(scrapeProfile).toHaveBeenCalled();
    expect(__testingProfileBreaker.isPaused()).toBe(true);

    // Second call while paused: web_profile_info must NOT be hit again; we go
    // straight to the browser leg (which now succeeds).
    scrapeProfile.mockClear();
    scrapeProfileViaBrowser.mockReset();
    scrapeProfileViaBrowser.mockResolvedValue(PROFILE_FIXTURE);

    const second = await getPublicProfile("target");
    expect(second.ok).toBe(true);
    expect(scrapeProfile).not.toHaveBeenCalled();
    expect(scrapeProfileViaBrowser).toHaveBeenCalledTimes(1);
  });

  it("does not trip the breaker when web_profile_info succeeds", async () => {
    scrapeProfile.mockResolvedValue(PROFILE_FIXTURE);
    const result = await getPublicProfile("target");
    expect(result.ok).toBe(true);
    expect(__testingProfileBreaker.isPaused()).toBe(false);
  });
});

describe("getPublicProfile — mobile-API-first when igUserId is known", () => {
  it("uses the mobile-API /info/ endpoint first and skips web_profile_info on success", async () => {
    scrapeProfileById.mockResolvedValue(PROFILE_FIXTURE);
    scrapeProfile.mockRejectedValue(rateLimitError());

    const result = await getPublicProfile("target", "igu-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data.igUserId).toBe("igu-1");
    // The whole point of the fix: we must NOT burn a web_profile_info call
    // (which IG 429s on nearly every request) when the info endpoint resolved.
    expect(scrapeProfileById).toHaveBeenCalledTimes(1);
    expect(scrapeProfile).not.toHaveBeenCalled();
    expect(scrapeProfileViaBrowser).not.toHaveBeenCalled();
  });

  it("falls back to web_profile_info when the info endpoint returns all-zero counts", async () => {
    scrapeProfileById.mockResolvedValue({
      ...PROFILE_FIXTURE,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
    });
    scrapeProfile.mockResolvedValue(PROFILE_FIXTURE);

    const result = await getPublicProfile("target", "igu-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data.followerCount).toBe(10);
    expect(scrapeProfileById).toHaveBeenCalledTimes(1);
    expect(scrapeProfile).toHaveBeenCalledTimes(1);
  });

  it("falls back to web_profile_info when the info endpoint is rate-limited", async () => {
    scrapeProfileById.mockRejectedValue(rateLimitError());
    scrapeProfile.mockResolvedValue(PROFILE_FIXTURE);

    const result = await getPublicProfile("target", "igu-1");

    expect(result.ok).toBe(true);
    expect(scrapeProfileById).toHaveBeenCalled();
    expect(scrapeProfile).toHaveBeenCalledTimes(1);
  });

  it("never calls the info endpoint when igUserId is absent", async () => {
    scrapeProfile.mockResolvedValue(PROFILE_FIXTURE);

    const result = await getPublicProfile("target");

    expect(result.ok).toBe(true);
    expect(scrapeProfileById).not.toHaveBeenCalled();
    expect(scrapeProfile).toHaveBeenCalledTimes(1);
  });
});

describe("getPublicProfile — rate-limit shape preservation (A3)", () => {
  it("browser leg failing with empty pool keeps rateLimited:true", async () => {
    scrapeProfile.mockRejectedValue(rateLimitError());
    scrapeProfileViaBrowser.mockRejectedValue(
      new MockIGPublicScraperError("no available bot in the pool"),
    );

    const result = await getPublicProfile("target");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.rateLimited).toBe(true);
    // Legacy message sniffers must still see the rate-limit shape.
    expect(result.error).toMatch(/rate limit/i);
    expect(result.error).toMatch(/no available bot/i);
  });

  it("browser leg failing with client-build error keeps rateLimited:true", async () => {
    scrapeProfile.mockRejectedValue(rateLimitError());
    scrapeProfileViaBrowser.mockRejectedValue(
      new MockIGPublicScraperError("failed to build IG client for bot xyz"),
    );

    const result = await getPublicProfile("target");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.rateLimited).toBe(true);
  });

  it("browser leg proving the profile gone downgrades to a hard failure", async () => {
    scrapeProfile.mockRejectedValue(rateLimitError());
    scrapeProfileViaBrowser.mockRejectedValue(
      new MockIGPublicScraperError("page error: user not found (404)"),
    );

    const result = await getPublicProfile("target");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.rateLimited).toBe(false);
  });

  it("non-rate-limit HTTP failure skips the browser leg, rateLimited:false", async () => {
    scrapeProfile.mockRejectedValue(
      new MockIGPublicScraperError("profile scrape failed: boom"),
    );

    const result = await getPublicProfile("target");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.rateLimited).toBe(false);
    expect(scrapeProfileViaBrowser).not.toHaveBeenCalled();
  });

  it("browser leg success recovers the fetch", async () => {
    scrapeProfile.mockRejectedValue(rateLimitError());
    scrapeProfileViaBrowser.mockResolvedValue(PROFILE_FIXTURE);

    const result = await getPublicProfile("target");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data.igUserId).toBe("igu-1");
  });
});

describe("getPublicProfile — browser attempt cap (A5)", () => {
  it("launches at most 2 browser attempts even on rotate-eligible errors", async () => {
    scrapeProfile.mockRejectedValue(rateLimitError());
    // "network error" matches isCheckpointOrAuthCause → would rotate up to
    // MAX_BOT_ROTATIONS (6) without the explicit cap.
    scrapeProfileViaBrowser.mockRejectedValue(
      new MockIGPublicScraperError(
        "browser scrape failed",
        new Error("network error during chromium navigation"),
      ),
    );

    const result = await getPublicProfile("target");

    expect(result.ok).toBe(false);
    expect(scrapeProfileViaBrowser).toHaveBeenCalledTimes(2);
  });
});

describe("rotation cooldown policy wiring (A4)", () => {
  it("profile HTTP rotation leg runs under the rotation cooldown policy", async () => {
    scrapeProfile.mockResolvedValue(PROFILE_FIXTURE);

    const result = await getPublicProfile("target");

    expect(result.ok).toBe(true);
    expect(withRotationRateLimitCooldownPolicy).toHaveBeenCalled();
  });

  it("non-rotating calls (posts) keep the pool-wide default policy", async () => {
    scrapeUserPosts.mockResolvedValue([]);

    const result = await getUserPosts("target", "igu-1");

    expect(result.ok).toBe(true);
    expect(withRotationRateLimitCooldownPolicy).not.toHaveBeenCalled();
  });

  it("stops after the first confirmed suspended-account checkpoint", async () => {
    const suspension = new IGHttpError(400, "checkpoint required", {
      igErrorCode: "checkpoint_required",
      body: JSON.stringify({
        message: "checkpoint_required",
        checkpoint_url: "/accounts/suspended/",
        lock: true,
      }),
    });
    scrapeUserPosts.mockRejectedValue(
      new MockIGPublicScraperError("post scrape failed", suspension),
    );

    const result = await getUserPosts("target", "igu-1");

    expect(result.ok).toBe(false);
    expect(scrapeUserPosts).toHaveBeenCalledTimes(1);
  });
});

describe("posts refusal recovery without auth-rotation cascades", () => {
  const throttle = () => new MockIGPublicScraperError("auth rejected (status 401)",
    new IGAuthExpiredError("auth rejected", { status: 401,
      body: '{"message":"Please wait","require_login":true,"igweb_rollout":true,"status":"fail"}' }));

  it("bounds a soft-throttle cascade at three reads and leaves a temporary failure", async () => {
    scrapeUserPosts.mockRejectedValue(throttle());
    const result = await getUserPosts("target", "igu-1");
    expect(scrapeUserPosts).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^rate limited:/) });
    expect(withRotationRateLimitCooldownPolicy).not.toHaveBeenCalled();
  });

  it("recovers through a healthy reader and retries a previous failure on the next call", async () => {
    scrapeUserPosts.mockRejectedValue(throttle());
    expect((await getUserPosts("target", "igu-1")).ok).toBe(false);
    scrapeUserPosts.mockReset().mockRejectedValueOnce(throttle()).mockResolvedValueOnce([]);
    expect(await getUserPosts("target", "igu-1")).toMatchObject({ ok: true, data: [] });
    expect(scrapeUserPosts).toHaveBeenCalledTimes(2);
  });

  it("does not misclassify genuine session expiry or change its fallback budget", async () => {
    scrapeUserPosts.mockRejectedValue(new MockIGPublicScraperError("session expired",
      new IGAuthExpiredError("login_required", { status: 401, body: '{"message":"login_required"}' })));
    expect((await getUserPosts("target", "igu-1")).ok).toBe(false);
    expect(scrapeUserPosts).toHaveBeenCalledTimes(7);
  });

  it("still stops a hard 429 immediately, without a new pool-wide probe cascade", async () => {
    scrapeUserPosts.mockRejectedValue(rateLimitError());
    expect((await getUserPosts("target", "igu-1")).ok).toBe(false);
    expect(scrapeUserPosts).toHaveBeenCalledTimes(1);
  });
});

describe("restricted graph-list rotation", () => {
  it("uses distinct bot exclusions and succeeds on a later observer", async () => {
    scrapeUserFollowing
      .mockRejectedValueOnce(new MockIGListRestrictedError("bot-a"))
      .mockRejectedValueOnce(new MockIGListRestrictedError("bot-b"))
      .mockResolvedValueOnce({ users: [], nextCursor: null });

    const result = await getUserFollowing("target-id");

    expect(result.ok).toBe(true);
    expect(scrapeUserFollowing).toHaveBeenCalledTimes(3);
    expect(scrapeUserFollowing.mock.calls[1]?.[2]).toEqual(
      new Set(["bot-a"]),
    );
    expect(scrapeUserFollowing.mock.calls[2]?.[2]).toEqual(
      new Set(["bot-a", "bot-b"]),
    );
  });
});

describe("parseEnvInt (A7)", () => {
  it("an explicit 0 is representable", () => {
    vi.stubEnv("TEST_KNOB_A7", "0");
    expect(parseEnvInt("TEST_KNOB_A7", 2, 0, 3)).toBe(0);
  });

  it("missing / blank / garbage fall back", () => {
    vi.stubEnv("TEST_KNOB_A7", "");
    expect(parseEnvInt("TEST_KNOB_A7", 2, 0, 3)).toBe(2);
    vi.stubEnv("TEST_KNOB_A7", "abc");
    expect(parseEnvInt("TEST_KNOB_A7", 2, 0, 3)).toBe(2);
  });

  it("clamps to [min, max] and truncates", () => {
    vi.stubEnv("TEST_KNOB_A7", "99");
    expect(parseEnvInt("TEST_KNOB_A7", 2, 0, 3)).toBe(3);
    vi.stubEnv("TEST_KNOB_A7", "-5");
    expect(parseEnvInt("TEST_KNOB_A7", 2, 0, 3)).toBe(0);
    vi.stubEnv("TEST_KNOB_A7", "1.9");
    expect(parseEnvInt("TEST_KNOB_A7", 2, 0, 3)).toBe(1);
  });
});
