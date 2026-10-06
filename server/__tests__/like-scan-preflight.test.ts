// ─── Tests for the likers-capacity pre-flight in workers.ts ─────────────────
//
// Coverage:
//   - likersDailyCapForPreflight mirrors daily-budget's LIKERS_DAILY_CAP parse
//     (default 60, trunc + clamp [1, 100], DAILY_CAP_MULTIPLIER scaling)
//   - likersCapacityRemaining returns the counted bots, binds the parsed cap,
//     and fails OPEN (Infinity + warn) when the query throws or has no row
//   - buildSkippedScanResult yields all-zero counters + skippedReason so the
//     likes worker's "no readable candidate posts" branch treats it as a no-op
//
// Approach: workers.ts has heavy import-time side effects (Redis connection,
// BullMQ queues), so every direct dependency is mocked exactly as in
// workers-dedupe.test.ts; only db.execute is a live vi.fn we drive per test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

const { mockExecute, noopLogger } = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { mockExecute: vi.fn(), noopLogger: logger };
});

// ── Mocks for every direct import of server/workers.ts ──────────────────────

vi.mock("bullmq", () => {
  class MockQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    on = vi.fn();
    add = vi.fn();
    getJob = vi.fn();
    close = vi.fn();
  }
  class MockWorker {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    on = vi.fn();
    close = vi.fn();
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

vi.mock("ioredis", () => ({
  default: class MockRedis {
    on(): this {
      return this;
    }
    async quit(): Promise<void> {}
  },
}));

vi.mock("../db.js", () => ({ db: { execute: mockExecute }, pool: {} }));

vi.mock("../observability/logger.js", () => ({
  logger: noopLogger,
  withCorrelation: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../services/public-data-collector.js", () => ({
  collectPublicData: vi.fn(),
}));
vi.mock("../services/public-data-service.js", () => ({
  getPostLikers: vi.fn(),
  getPublicProfile: vi.fn(),
  getUserPosts: vi.fn(),
}));
vi.mock("../bot-manager.js", () => ({
  assignBotToTrackedAccount: vi.fn(),
  getAcceptedBotSession: vi.fn(),
  markFollowRequestAccepted: vi.fn(),
  markFollowRequestFailed: vi.fn(),
  getPendingFollowRequests: vi.fn(),
  getExpiredFollowRequests: vi.fn(),
  releaseBotFromTrackedAccount: vi.fn(),
  rotateBotForTrackedAccount: vi.fn(),
}));
vi.mock("../bot-collectors.js", () => ({
  createBotCollectors: vi.fn(() => ({
    collectFollowsViaBotSession: vi.fn(),
    sendFollowForRequest: vi.fn(),
  })),
}));
vi.mock("../ig-http-client.js", () => ({
  createBotClient: vi.fn(),
  createHttpBotClient: vi.fn(),
  IGRateLimitedError: class IGRateLimitedError extends Error {},
}));
vi.mock("../domain/ig-client-port.js", () => ({
  IGCircuitOpenError: class IGCircuitOpenError extends Error {},
}));
vi.mock("../domain/follow-request-state.js", () => ({
  transitionFollowRequest: vi.fn(),
}));
vi.mock("../ig-public-scraper.js", () => ({
  scrapeProfile: vi.fn(),
  scrapeUserPostsWithBot: vi.fn(),
}));
vi.mock("../services/bot-runtime.js", () => ({ ensureBotReady: vi.fn() }));
vi.mock("../behavior/device-fingerprint.js", () => ({
  resolveFingerprint: vi.fn(),
}));
vi.mock("../integrations.js", () => ({ isResendConfigured: vi.fn(() => false) }));
vi.mock("../workers/retention-worker.js", () => ({ pruneOldEvents: vi.fn() }));
vi.mock("../workers/bot-warmer-worker.js", () => {
  const botWarmerQueue = { name: "bot-warming", on: vi.fn() };
  return {
    getBotWarmerQueue: vi.fn(() => botWarmerQueue),
    startBotWarmerWorker: vi.fn(),
  };
});
vi.mock("../workers/account-refresh-registrar.js", () => ({
  ACCOUNT_REFRESH_JOB_NAME: "account-refresh",
  reconcileAccountRefreshes: vi.fn(),
}));
vi.mock("../services/media-cache.js", () => ({ cacheMediaUrl: vi.fn() }));
vi.mock("../services/media-cache-jobs.js", () => ({
  mediaCacheQueue: { name: "media-cache", on: vi.fn() },
}));
vi.mock("../services/bandwidth-meter.js", () => ({
  startBandwidthMeter: vi.fn(),
  withScrapeContext: vi.fn(),
}));
vi.mock("../services/refresh-config.js", () => ({
  initRefreshConfig: vi.fn(async () => {}),
}));
vi.mock("../services/roster.js", () => ({
  buildFollowersRoster: vi.fn(),
  buildFollowingRoster: vi.fn(),
}));

const { likersCapacityRemaining, likersDailyCapForPreflight, buildSkippedScanResult } =
  await import("../workers.js");

describe("likersDailyCapForPreflight", () => {
  it("defaults to 60 when LIKERS_DAILY_CAP is unset or blank", () => {
    expect(likersDailyCapForPreflight({})).toBe(60);
    expect(likersDailyCapForPreflight({ LIKERS_DAILY_CAP: "   " })).toBe(60);
  });

  it("uses a valid override, truncated and clamped to [1, 100]", () => {
    expect(likersDailyCapForPreflight({ LIKERS_DAILY_CAP: "30" })).toBe(30);
    expect(likersDailyCapForPreflight({ LIKERS_DAILY_CAP: "12.9" })).toBe(12);
    expect(likersDailyCapForPreflight({ LIKERS_DAILY_CAP: "500" })).toBe(100);
  });

  it("falls back to 60 for invalid or non-positive values", () => {
    expect(likersDailyCapForPreflight({ LIKERS_DAILY_CAP: "abc" })).toBe(60);
    expect(likersDailyCapForPreflight({ LIKERS_DAILY_CAP: "0" })).toBe(60);
    expect(likersDailyCapForPreflight({ LIKERS_DAILY_CAP: "-5" })).toBe(60);
  });

  it("scales by DAILY_CAP_MULTIPLIER exactly as daily-budget does", () => {
    const base = { LIKERS_DAILY_CAP: "60" };
    expect(likersDailyCapForPreflight({ ...base, DAILY_CAP_MULTIPLIER: "2" })).toBe(120);
    // below 1 and non-numeric are ignored; above 10 is clamped to 10
    expect(likersDailyCapForPreflight({ ...base, DAILY_CAP_MULTIPLIER: "0.5" })).toBe(60);
    expect(likersDailyCapForPreflight({ ...base, DAILY_CAP_MULTIPLIER: "nope" })).toBe(60);
    expect(likersDailyCapForPreflight({ ...base, DAILY_CAP_MULTIPLIER: "99" })).toBe(600);
  });
});

describe("likersCapacityRemaining", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    noopLogger.warn.mockClear();
  });
  afterEach(() => {
    vi.stubEnv("LIKERS_DAILY_CAP", undefined);
  });

  it("returns the number of web bots still under today's likers cap", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ n: 7 }] });
    await expect(likersCapacityRemaining()).resolves.toBe(7);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(noopLogger.warn).not.toHaveBeenCalled();
  });

  it("returns 0 when every eligible bot has hit the cap", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    await expect(likersCapacityRemaining()).resolves.toBe(0);
    expect(noopLogger.warn).not.toHaveBeenCalled();
  });

  it("binds the parsed LIKERS_DAILY_CAP as the query parameter", async () => {
    vi.stubEnv("LIKERS_DAILY_CAP", "45");
    mockExecute.mockResolvedValueOnce({ rows: [{ n: 1 }] });
    await likersCapacityRemaining();
    // drizzle's sql`` tag keeps interpolated values as raw chunks (they are
    // wrapped into Params only when the query is built for a dialect).
    const query = mockExecute.mock.calls[0]?.[0] as { queryChunks: unknown[] };
    const bound = query.queryChunks.filter((chunk) => typeof chunk === "number");
    expect(bound).toEqual([45]);
  });

  it("fails open with Infinity and a warning when the query throws", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection refused"));
    await expect(likersCapacityRemaining()).resolves.toBe(Number.POSITIVE_INFINITY);
    expect(noopLogger.warn).toHaveBeenCalledTimes(1);
  });

  it("fails open when the query returns no count row", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(likersCapacityRemaining()).resolves.toBe(Number.POSITIVE_INFINITY);
    expect(noopLogger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("buildSkippedScanResult", () => {
  it("returns all-zero counters tagged with the skip reason", () => {
    expect(buildSkippedScanResult("likers_pool_exhausted")).toEqual({
      inserted: 0,
      ownersScanned: 0,
      postsChecked: 0,
      errors: 0,
      successfulLikerReads: 0,
      skippedReason: "likers_pool_exhausted",
    });
  });

  it("lands in the likes worker's clean no-op branch, not its outage branch", () => {
    const result = buildSkippedScanResult("likers_pool_exhausted");
    // createLikesWorker throws only when postsChecked > 0 with no liker reads.
    expect(result.successfulLikerReads <= 0 && result.postsChecked > 0).toBe(false);
    expect(result.successfulLikerReads).toBeLessThanOrEqual(0);
  });
});
