// ─── Tests for workers.ts self-heal / dedupe fixes (B4, B11, B14) ───────────
//
// Coverage:
//   B11 — enqueueLikesAfterProfile sliding-window throttle:
//     - stable jobId (no epoch bucket component)
//     - schedules when no occupant exists
//     - throttles when a scheduled/active occupant exists
//     - throttles when the last run finished inside the window — including
//       across what used to be an epoch-bucket boundary (regression)
//     - removes a stale husk and re-schedules once the window has elapsed
//   B14 — enqueueDeferredProfileRetry husk-proof re-enqueue:
//     - schedules with the stable id + delay when the slot is empty
//     - dedupes against a genuinely scheduled (delayed/waiting/prioritized) job
//     - removes a completed/failed husk and re-adds (regression: the husk
//       used to silently swallow the re-add and strand the account)
//     - falls back to a collision-proof unique id when the occupant is
//       active or when bookkeeping throws — the retry is never dropped
//     - C11d: carries force/source through every add path (stable id,
//       unique id, bookkeeping-failure fallback); undefined fields omitted
//   C11c — describeProfileTempBackoffClamp: warns only when the env exceeds
//     the 90 min clamp (prod carries 4 h, silently clamped before this)
//   C11a — runHourlyReconcile: sweeps schedulers AND stale collection jobs;
//     one failing never skips the other
//   B4 — probe-success cooldown planning (pure helpers backing the CAS):
//     - classifyCooldownShape mirrors services/bot-cooldown.ts writers
//     - rate-limit-shaped cooldowns clear; checkpoint-shaped shorten at most
//   B8 — emitter 'error' listeners (an unlistened 'error' kills the process):
//     - every Queue created at import time has an 'error' listener
//     - the listener increments the per-emitter counter and survives a
//       throwing logger
//     - registerWorkerErrorHandler wires the same throw-proof listener onto
//       Worker instances
//
// Approach: workers.ts has heavy import-time side effects (Redis connection,
// 11 BullMQ queues) and directly imports modules under concurrent edit, so
// every direct dependency is mocked and only the exported pure/DI'd helpers
// are exercised.

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

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

vi.mock("../db.js", () => ({ db: {}, pool: {} }));

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};
noopLogger.child.mockReturnValue(noopLogger);

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
  // The real getBotWarmerQueue is a lazy singleton; the mock must be too, so
  // the B8 'error' listener registered at workers.ts import time is visible
  // on the same instance that getQueues() later returns.
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

const { formatCooldownReason } = await import("../services/bot-cooldown.js");
const {
  buildLikesAfterProfileJobId,
  enqueueLikesAfterProfile,
  likeEvidenceProgressUpdate,
  isLikeEvidenceListingOutage,
  buildDeferredProfileJobId,
  enqueueDeferredProfileRetry,
  buildDeferredProfileJobData,
  describeProfileTempBackoffClamp,
  runHourlyReconcile,
  profileBackoffAuditUpdate,
  classifyCooldownShape,
  planProbeSuccessCooldownUpdate,
  getQueues,
  getEmitterErrorCounts,
  registerWorkerErrorHandler,
  takeRotatingWindow,
} = await import("../workers.js");

describe("liked-post evidence progress", () => {
  it("does not advance freshness or cursor when every liker read failed", () => {
    expect(likeEvidenceProgressUpdate(20, 25, 0)).toEqual({
      likeEvidenceCursor: 20,
    });
  });

  it("advances both markers after at least one real liker payload", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    expect(likeEvidenceProgressUpdate(20, 25, 1, now)).toEqual({
      likeEvidenceCursor: 25,
      lastLikeEvidenceScanAt: now,
    });
  });

  it("holds the cursor when liker reads were attempted and all failed", () => {
    // Genuine outage: retry the same owners next cycle.
    expect(likeEvidenceProgressUpdate(50, 80, 0, new Date(), 4)).toEqual({
      likeEvidenceCursor: 50,
    });
  });

  it("advances past a window with no readable candidate posts (livelock fix)", () => {
    // No liker read was attempted, so holding would re-scan the identical
    // window forever. Advance, but do not claim a scan happened.
    expect(likeEvidenceProgressUpdate(50, 80, 0, new Date(), 0)).toEqual({
      likeEvidenceCursor: 80,
    });
  });

  it("holds the cursor when every owner errored before a liker read (listing outage)", () => {
    // 2026-09-02: six scans, 216 owners, 0 posts, 216 errors — a lease
    // outage, not an empty window. Advancing would skip the whole window and
    // stamp nothing, so the outage looked like "no readable candidate posts".
    expect(likeEvidenceProgressUpdate(50, 266, 0, new Date(), 0, 216, 216)).toEqual({
      likeEvidenceCursor: 50,
    });
  });

  it("still advances past an empty window where only a few owners errored", () => {
    expect(likeEvidenceProgressUpdate(50, 80, 0, new Date(), 0, 3, 30)).toEqual({
      likeEvidenceCursor: 80,
    });
  });

  it("isLikeEvidenceListingOutage: zero posts and errors covering every scanned owner, nothing else", () => {
    expect(isLikeEvidenceListingOutage(0, 216, 216)).toBe(true);
    expect(isLikeEvidenceListingOutage(0, 31, 30)).toBe(true); // errors may exceed owners
    expect(isLikeEvidenceListingOutage(0, 0, 30)).toBe(false); // empty window, no errors
    expect(isLikeEvidenceListingOutage(0, 3, 30)).toBe(false); // a few flaky owners
    expect(isLikeEvidenceListingOutage(4, 4, 4)).toBe(false); // liker reads were attempted: the postsChecked > 0 rule owns that
    expect(isLikeEvidenceListingOutage(0, 0, 0)).toBe(false); // nothing scanned at all
  });
});

describe("profile scheduler temporary-backoff audit state", () => {
  it("closes recurring scheduler rows because the next tick creates a new audit", () => {
    const now = new Date("2026-08-16T12:00:00.000Z");
    expect(profileBackoffAuditUpdate(true, "no available bot", now)).toEqual({
      status: "failed",
      completedAt: now,
      error: "deferred to next account-refresh tick: no available bot",
    });
  });

  it("keeps manual rows pending for their actual delayed retry", () => {
    expect(profileBackoffAuditUpdate(false, "provider cooldown")).toEqual({
      status: "pending",
      completedAt: null,
      error: "deferred: provider cooldown",
    });
  });
});

// ── Fake DedupeQueueLike ─────────────────────────────────────────────────────

interface FakeJobSpec {
  state: string;
  finishedOn?: number;
  processedOn?: number;
  timestamp?: number;
}

interface AddCall {
  name: string;
  data: { trackedAccountId: string; force?: boolean; source?: string };
  opts: {
    delay?: number;
    jobId: string;
    removeOnComplete: number;
    removeOnFail: number;
  };
}

function makeFakeQueue(
  existing: FakeJobSpec | null,
  behavior: { getJobThrows?: boolean; removeThrows?: boolean } = {},
) {
  const adds: AddCall[] = [];
  const removes: string[] = [];
  const queue = {
    async getJob(jobId: string) {
      if (behavior.getJobThrows) throw new Error("redis hiccup");
      if (!existing) return undefined;
      return {
        getState: async () => existing.state,
        remove: async () => {
          if (behavior.removeThrows) {
            throw new Error("job cannot be removed");
          }
          removes.push(jobId);
        },
        finishedOn: existing.finishedOn,
        processedOn: existing.processedOn,
        timestamp: existing.timestamp,
      };
    },
    async add(name: string, data: AddCall["data"], opts: AddCall["opts"]) {
      adds.push({ name, data, opts });
    },
  };
  return { queue, adds, removes };
}

const ACCT = "acct-123";
const WINDOW_MS = 30 * 60_000;

describe("liked-post evidence roster rotation", () => {
  it("advances through successive non-overlapping windows", () => {
    const roster = ["a", "b", "c", "d", "e"];
    const first = takeRotatingWindow(roster, 0, 2);
    const second = takeRotatingWindow(roster, first.nextCursor, 2);

    expect(first).toEqual({ items: ["a", "b"], nextCursor: 2, start: 0 });
    expect(second).toEqual({ items: ["c", "d"], nextCursor: 4, start: 2 });
  });

  it("wraps at the end and normalizes stale cursors", () => {
    expect(takeRotatingWindow(["a", "b", "c"], 2, 2)).toEqual({
      items: ["c", "a"],
      nextCursor: 1,
      start: 2,
    });
    expect(takeRotatingWindow(["a", "b", "c"], 8, 1)).toEqual({
      items: ["c"],
      start: 2,
      nextCursor: 0,
    });
  });
});

// ── B11: likes-after-profile sliding-window throttle ────────────────────────

describe("B11 buildLikesAfterProfileJobId", () => {
  it("never contains ':' — BullMQ rejects a custom jobId with a colon", () => {
    // Regression: a ':' in any of these ids throws 'Custom Id cannot contain :'
    // at enqueue time, which surfaced as a 500 on POST /api/tracking/accounts.
    expect(buildLikesAfterProfileJobId(ACCT)).not.toContain(":");
    expect(buildDeferredProfileJobId(ACCT)).not.toContain(":");
  });

  it("is stable per account with no time-bucket component", () => {
    expect(buildLikesAfterProfileJobId(ACCT)).toBe(`likes-after-profile_${ACCT}`);
    // Identical at any two instants — the old scheme embedded
    // Math.floor(now / 30min) and changed across epoch boundaries.
    expect(buildLikesAfterProfileJobId(ACCT)).toBe(buildLikesAfterProfileJobId(ACCT));
    expect(buildLikesAfterProfileJobId(ACCT)).not.toMatch(/\d{6,}$/);
  });
});

describe("B11 enqueueLikesAfterProfile", () => {
  it("schedules under the stable jobId when no occupant exists", async () => {
    const { queue, adds } = makeFakeQueue(null);
    const outcome = await enqueueLikesAfterProfile(queue, ACCT, 1_000_000, WINDOW_MS);
    expect(outcome).toBe("scheduled");
    expect(adds).toHaveLength(1);
    expect(adds[0].name).toBe("collect-likes");
    expect(adds[0].data).toEqual({ trackedAccountId: ACCT });
    expect(adds[0].opts.jobId).toBe(`likes-after-profile_${ACCT}`);
  });

  it.each(["delayed", "waiting", "waiting-children", "prioritized", "active"])(
    "throttles when the occupant is %s",
    async (state) => {
      const { queue, adds } = makeFakeQueue({ state });
      const outcome = await enqueueLikesAfterProfile(queue, ACCT, 1_000_000, WINDOW_MS);
      expect(outcome).toBe("throttled");
      expect(adds).toHaveLength(0);
    },
  );

  it("throttles when the last run finished inside the window", async () => {
    const now = 10_000_000;
    const { queue, adds, removes } = makeFakeQueue({
      state: "completed",
      finishedOn: now - (WINDOW_MS - 60_000), // 29 min ago
    });
    const outcome = await enqueueLikesAfterProfile(queue, ACCT, now, WINDOW_MS);
    expect(outcome).toBe("throttled");
    expect(adds).toHaveLength(0);
    expect(removes).toHaveLength(0);
  });

  it("throttles across an old epoch-bucket boundary (regression)", async () => {
    // Old scheme: jobId embedded Math.floor(now / 30min). A run finishing 3s
    // before an exact 30-min epoch boundary and a profile completion 3s after
    // it landed in DIFFERENT buckets → double-enqueue. The sliding window
    // must throttle: only 6 seconds elapsed.
    const boundary = Math.ceil(10_000_000 / WINDOW_MS) * WINDOW_MS;
    const { queue, adds } = makeFakeQueue({
      state: "completed",
      finishedOn: boundary - 3_000,
    });
    const outcome = await enqueueLikesAfterProfile(
      queue,
      ACCT,
      boundary + 3_000,
      WINDOW_MS,
    );
    expect(outcome).toBe("throttled");
    expect(adds).toHaveLength(0);
  });

  it("removes the stale husk and re-schedules once the window has elapsed", async () => {
    const now = 50_000_000;
    const { queue, adds, removes } = makeFakeQueue({
      state: "completed",
      finishedOn: now - (WINDOW_MS + 1_000), // 31 min ago
    });
    const outcome = await enqueueLikesAfterProfile(queue, ACCT, now, WINDOW_MS);
    expect(outcome).toBe("scheduled");
    expect(removes).toEqual([`likes-after-profile_${ACCT}`]);
    expect(adds).toHaveLength(1);
    expect(adds[0].opts.jobId).toBe(`likes-after-profile_${ACCT}`);
  });

  it("falls back to processedOn/timestamp for husks missing finishedOn", async () => {
    const now = 50_000_000;
    const { queue, adds } = makeFakeQueue({
      state: "failed",
      processedOn: now - 60_000, // started 1 min ago
    });
    const outcome = await enqueueLikesAfterProfile(queue, ACCT, now, WINDOW_MS);
    expect(outcome).toBe("throttled");
    expect(adds).toHaveLength(0);
  });
});

// ── B14: husk-proof deferred profile retry ──────────────────────────────────

describe("B14 buildDeferredProfileJobId", () => {
  it("is stable per account with no time-bucket component", () => {
    expect(buildDeferredProfileJobId(ACCT)).toBe(`profile-deferred_${ACCT}`);
  });
});

describe("B14 enqueueDeferredProfileRetry", () => {
  const DELAY_MS = 15 * 60_000;
  const NOW = 77_000_000;

  it("schedules under the stable id with the requested delay when empty", async () => {
    const { queue, adds } = makeFakeQueue(null);
    const outcome = await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW);
    expect(outcome).toBe("scheduled");
    expect(adds).toHaveLength(1);
    expect(adds[0].name).toBe("profile");
    expect(adds[0].opts.jobId).toBe(`profile-deferred_${ACCT}`);
    expect(adds[0].opts.delay).toBe(DELAY_MS);
  });

  it.each(["delayed", "waiting", "waiting-children", "prioritized"])(
    "dedupes when a genuinely scheduled (%s) retry already exists",
    async (state) => {
      const { queue, adds } = makeFakeQueue({ state });
      const outcome = await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW);
      expect(outcome).toBe("deduped");
      expect(adds).toHaveLength(0);
    },
  );

  it.each(["completed", "failed", "unknown"])(
    "removes a %s husk and re-adds under the stable id (regression: husk used to swallow the retry)",
    async (state) => {
      const { queue, adds, removes } = makeFakeQueue({ state });
      const outcome = await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW);
      expect(outcome).toBe("scheduled");
      expect(removes).toEqual([`profile-deferred_${ACCT}`]);
      expect(adds).toHaveLength(1);
      expect(adds[0].opts.jobId).toBe(`profile-deferred_${ACCT}`);
      expect(adds[0].opts.delay).toBe(DELAY_MS);
    },
  );

  it("uses a collision-proof unique id when the occupant is active", async () => {
    // The active occupant may be the very job calling this helper (a deferred
    // retry failing again); it cannot be removed and is no guarantee of
    // future work — the retry must still be scheduled.
    const { queue, adds, removes } = makeFakeQueue({ state: "active" });
    const outcome = await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW);
    expect(outcome).toBe("scheduled");
    expect(removes).toHaveLength(0);
    expect(adds).toHaveLength(1);
    expect(adds[0].opts.jobId).toBe(`profile-deferred_${ACCT}_${NOW}`);
    expect(adds[0].opts.delay).toBe(DELAY_MS);
  });

  it("never drops the retry when getJob throws — unique-id fallback", async () => {
    const { queue, adds } = makeFakeQueue(null, { getJobThrows: true });
    const outcome = await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW);
    expect(outcome).toBe("scheduled");
    expect(adds).toHaveLength(1);
    expect(adds[0].opts.jobId).toBe(`profile-deferred_${ACCT}_${NOW}`);
  });

  it("never drops the retry when husk removal throws — unique-id fallback", async () => {
    const { queue, adds } = makeFakeQueue(
      { state: "completed" },
      { removeThrows: true },
    );
    const outcome = await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW);
    expect(outcome).toBe("scheduled");
    expect(adds).toHaveLength(1);
    expect(adds[0].opts.jobId).toBe(`profile-deferred_${ACCT}_${NOW}`);
  });
});

// ── B8: emitter 'error' listeners (unlistened 'error' kills the process) ────

type OnMock = ReturnType<typeof vi.fn>;

function findErrorListener(on: OnMock): ((err: unknown) => void) | undefined {
  const call = on.mock.calls.find(([event]) => event === "error");
  return call?.[1] as ((err: unknown) => void) | undefined;
}

describe("B8 queue 'error' listeners", () => {
  it("registers an 'error' listener on every queue at import time", () => {
    const queues = getQueues();
    expect(Object.keys(queues).length).toBeGreaterThanOrEqual(13);
    for (const [key, queue] of Object.entries(queues)) {
      const listener = findErrorListener(queue.on as unknown as OnMock);
      expect(listener, `queue "${key}" has no 'error' listener`).toBeTypeOf(
        "function",
      );
    }
  });

  it("counts errors per emitter and never throws — even when the logger throws", () => {
    const { collectionProfileQueue } = getQueues();
    const listener = findErrorListener(
      collectionProfileQueue.on as unknown as OnMock,
    );
    expect(listener).toBeTypeOf("function");
    const key = "queue:collection-profile";
    const before = getEmitterErrorCounts()[key] ?? 0;

    expect(() => listener!(new Error("redis blip"))).not.toThrow();

    noopLogger.error.mockImplementationOnce(() => {
      throw new Error("logger exploded");
    });
    expect(() => listener!("not-even-an-Error")).not.toThrow();

    expect(getEmitterErrorCounts()[key]).toBe(before + 2);
  });
});

describe("B8 registerWorkerErrorHandler", () => {
  it("wires a throw-proof counting 'error' listener onto a worker and returns it", () => {
    const on = vi.fn();
    const worker = { name: "fake-worker", on };
    expect(registerWorkerErrorHandler(worker)).toBe(worker);

    const listener = findErrorListener(on);
    expect(listener).toBeTypeOf("function");

    const before = getEmitterErrorCounts()["worker:fake-worker"] ?? 0;
    noopLogger.error.mockImplementationOnce(() => {
      throw new Error("logger exploded");
    });
    expect(() => listener!(new Error("boom"))).not.toThrow();
    expect(getEmitterErrorCounts()["worker:fake-worker"]).toBe(before + 1);
  });
});

// ── B4: probe-success cooldown planning (backs the CAS UPDATE) ──────────────

describe("B4 classifyCooldownShape", () => {
  it("identifies cooldownBotForRateLimit's stamp as rate-limit-shaped", () => {
    expect(classifyCooldownShape(formatCooldownReason("rate limited; retry-after=14400000ms"))).toBe("rate-limit");
    expect(classifyCooldownShape("rate limited; retry-after=14400000ms")).toBe(
      "rate-limit",
    );
    expect(classifyCooldownShape("Rate Limited; retry-after=1ms")).toBe("rate-limit");
  });

  it("treats checkpoint reasons and anything unidentifiable as checkpoint-shaped", () => {
    expect(classifyCooldownShape("checkpoint_required")).toBe("checkpoint");
    expect(classifyCooldownShape(formatCooldownReason("checkpoint_required"))).toBe("checkpoint");
    expect(classifyCooldownShape("403 forbidden on feed/user")).toBe("checkpoint");
    expect(classifyCooldownShape("")).toBe("checkpoint");
    expect(classifyCooldownShape(null)).toBe("checkpoint");
    expect(classifyCooldownShape(undefined)).toBe("checkpoint");
    // "rate limited" appearing mid-string is not the bot-cooldown stamp.
    expect(classifyCooldownShape("checkpoint after being rate limited")).toBe(
      "checkpoint",
    );
  });
});

describe("B4 planProbeSuccessCooldownUpdate", () => {
  const NOW = 1_700_000_000_000;
  const SHORTEN_MS = 30 * 60_000;

  it("clears rate-limit-shaped cooldowns entirely", () => {
    const observed = new Date(NOW + 4 * 60 * 60_000); // 4h remaining
    const plan = planProbeSuccessCooldownUpdate(
      "rate limited; retry-after=14400000ms",
      observed,
      NOW,
      SHORTEN_MS,
    );
    expect(plan).toEqual({ action: "clear", shape: "rate-limit" });
  });

  it("clears the current prefixed rate-limit stamp only after a successful probe", () => {
    const observed = new Date(NOW + 4 * 60 * 60_000);
    expect(planProbeSuccessCooldownUpdate(
      formatCooldownReason("rate limited; retry-after=14400000ms"), observed, NOW, SHORTEN_MS,
    )).toEqual({ action: "clear", shape: "rate-limit" });
    expect(planProbeSuccessCooldownUpdate(
      formatCooldownReason("checkpoint after being rate limited"), observed, NOW, SHORTEN_MS,
    )).toEqual({ action: "shorten", shape: "checkpoint", until: new Date(NOW + SHORTEN_MS) });
  });

  it("shortens — never clears — a far-future checkpoint cooldown", () => {
    const observed = new Date(NOW + 24 * 60 * 60_000); // 24h remaining
    const plan = planProbeSuccessCooldownUpdate(
      "checkpoint_required",
      observed,
      NOW,
      SHORTEN_MS,
    );
    expect(plan.action).toBe("shorten");
    if (plan.action === "shorten") {
      expect(plan.until.getTime()).toBe(NOW + SHORTEN_MS);
      expect(plan.until.getTime()).toBeLessThan(observed.getTime());
    }
  });

  it("keeps a checkpoint cooldown that is already shorter than the shorten window", () => {
    const observed = new Date(NOW + 10 * 60_000); // 10 min remaining
    const plan = planProbeSuccessCooldownUpdate(
      "checkpoint_required",
      observed,
      NOW,
      SHORTEN_MS,
    );
    expect(plan).toEqual({ action: "keep", shape: "checkpoint" });
  });

  it("keeps at the exact shorten boundary (never lengthens a cooldown)", () => {
    const observed = new Date(NOW + SHORTEN_MS);
    const plan = planProbeSuccessCooldownUpdate(
      "checkpoint_required",
      observed,
      NOW,
      SHORTEN_MS,
    );
    expect(plan).toEqual({ action: "keep", shape: "checkpoint" });
  });

  it("treats an unknown error shape conservatively (shorten, not clear)", () => {
    const observed = new Date(NOW + 24 * 60 * 60_000);
    const plan = planProbeSuccessCooldownUpdate(null, observed, NOW, SHORTEN_MS);
    expect(plan.action).toBe("shorten");
  });
});

// ── C11d: deferred retry keeps force/source ─────────────────────────────────

describe("C11d buildDeferredProfileJobData", () => {
  it("returns the bare id when nothing is carried", () => {
    expect(buildDeferredProfileJobData(ACCT)).toEqual({ trackedAccountId: ACCT });
    expect(buildDeferredProfileJobData(ACCT, {})).toEqual({ trackedAccountId: ACCT });
  });

  it("carries force and source, omitting undefined fields (never null)", () => {
    expect(buildDeferredProfileJobData(ACCT, { force: true, source: "manual-refresh" })).toEqual({
      trackedAccountId: ACCT,
      force: true,
      source: "manual-refresh",
    });
    const forceOnly = buildDeferredProfileJobData(ACCT, { force: false, source: undefined });
    expect(forceOnly).toEqual({ trackedAccountId: ACCT, force: false });
    expect(Object.keys(forceOnly)).not.toContain("source");
  });
});

describe("C11d enqueueDeferredProfileRetry carries force/source", () => {
  const DELAY_MS = 15 * 60_000;
  const NOW = 77_000_000;
  const CARRY = { force: true, source: "manual-refresh" } as const;

  it("on the stable-id path (empty slot)", async () => {
    const { queue, adds } = makeFakeQueue(null);
    await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW, CARRY);
    expect(adds).toHaveLength(1);
    expect(adds[0].opts.jobId).toBe(`profile-deferred_${ACCT}`);
    expect(adds[0].data).toEqual({ trackedAccountId: ACCT, ...CARRY });
  });

  it("on the unique-id path (active occupant)", async () => {
    const { queue, adds } = makeFakeQueue({ state: "active" });
    await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW, CARRY);
    expect(adds).toHaveLength(1);
    expect(adds[0].opts.jobId).toBe(`profile-deferred_${ACCT}_${NOW}`);
    expect(adds[0].data).toEqual({ trackedAccountId: ACCT, ...CARRY });
  });

  it("on the bookkeeping-failure fallback (getJob throws)", async () => {
    const { queue, adds } = makeFakeQueue(null, { getJobThrows: true });
    await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW, CARRY);
    expect(adds).toHaveLength(1);
    expect(adds[0].data).toEqual({ trackedAccountId: ACCT, ...CARRY });
  });

  it("stays a bare-id payload when the caller carries nothing (backward compatible)", async () => {
    const { queue, adds } = makeFakeQueue(null);
    await enqueueDeferredProfileRetry(queue, ACCT, DELAY_MS, NOW);
    expect(adds[0].data).toEqual({ trackedAccountId: ACCT });
  });
});

// ── C11c: PROFILE_TEMP_BACKOFF_MS clamp warning ─────────────────────────────

describe("C11c describeProfileTempBackoffClamp", () => {
  const MAX = 90 * 60 * 1000;

  it("is silent when the env is unset, blank or unparsable", () => {
    expect(describeProfileTempBackoffClamp(undefined, MAX)).toBeNull();
    expect(describeProfileTempBackoffClamp("", MAX)).toBeNull();
    expect(describeProfileTempBackoffClamp("four hours", MAX)).toBeNull();
  });

  it("is silent when the requested value is within the clamp", () => {
    expect(describeProfileTempBackoffClamp("900000", MAX)).toBeNull();
    expect(describeProfileTempBackoffClamp(String(MAX), MAX)).toBeNull();
  });

  it("reports requested vs effective when the env exceeds the clamp (prod: 4 h)", () => {
    expect(describeProfileTempBackoffClamp("14400000", MAX)).toEqual({
      requestedMs: 14_400_000,
      effectiveMs: MAX,
    });
  });

  it("floors fractional milliseconds like readBoundedIntEnv does", () => {
    // 5,400,000 is exactly the clamp (silent); one ms above it is reported floored.
    expect(describeProfileTempBackoffClamp("5400001.9", MAX)).toEqual({
      requestedMs: 5_400_001,
      effectiveMs: MAX,
    });
  });
});

// ── C11a: hourly reconcile also sweeps stale collection jobs ────────────────

describe("C11a runHourlyReconcile", () => {
  const queue = { name: "collection-profile" } as unknown as Parameters<typeof runHourlyReconcile>[0];

  it("runs both sweeps against the profile queue", async () => {
    const deps = {
      reconcileAccountRefreshes: vi.fn(async () => 9),
      reconcileStaleCollectionJobs: vi.fn(async () => 1),
    };
    await runHourlyReconcile(queue, deps);
    expect(deps.reconcileAccountRefreshes).toHaveBeenCalledTimes(1);
    expect(deps.reconcileAccountRefreshes).toHaveBeenCalledWith(queue);
    expect(deps.reconcileStaleCollectionJobs).toHaveBeenCalledTimes(1);
  });

  it("a failing scheduler sweep never skips the stale-job sweep, and vice versa", async () => {
    noopLogger.error.mockClear();
    const first = {
      reconcileAccountRefreshes: vi.fn(async () => {
        throw new Error("redis blip");
      }),
      reconcileStaleCollectionJobs: vi.fn(async () => 0),
    };
    await expect(runHourlyReconcile(queue, first)).resolves.toBeUndefined();
    expect(first.reconcileStaleCollectionJobs).toHaveBeenCalledTimes(1);

    const second = {
      reconcileAccountRefreshes: vi.fn(async () => 0),
      reconcileStaleCollectionJobs: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    await expect(runHourlyReconcile(queue, second)).resolves.toBeUndefined();
    expect(second.reconcileAccountRefreshes).toHaveBeenCalledTimes(1);
    expect(noopLogger.error).toHaveBeenCalledTimes(2);
  });
});
