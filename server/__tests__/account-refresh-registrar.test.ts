// Unit tests for the per-account refresh scheduler's phase derivation.
//
// Regression context (audit 2026-09-02): all nine per-account `every`
// schedulers on collection-profile fired within 24 ms of each other. Reconcile
// created them in one synchronous loop and BullMQ v5 pins an `every`
// scheduler's phase to its first tick (`firstTick % every`), so they all
// inherited one phase. The fix hands BullMQ an explicit `startDate` whose
// phase is a stable hash of the account id. These tests pin: determinism,
// independence from wall-clock, spread across the interval, the "slot already
// passed this interval" edge (BullMQ clamps a past startDate to `now`, which
// would re-collapse the phase), and that nothing else in the upsert changed.
//
// All external I/O is mocked. No real DB, no real Redis.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

const dbMock = vi.hoisted(() => ({ where: vi.fn() }));
vi.mock("../db.js", () => ({
  db: { select: () => ({ from: () => ({ where: dbMock.where }) }) },
}));

const loggerMock = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
};
vi.mock("../observability/logger.js", () => ({ logger: loggerMock }));

// Live production cadence: system_settings.scraper.refreshIntervalSec = 10800.
const EVERY_SEC = 10_800;
const EVERY_MS = EVERY_SEC * 1000;
vi.mock("../services/refresh-config.js", () => ({
  getCachedRefreshIntervalSec: () => EVERY_SEC,
  clampRefreshSec: (sec: number) => sec,
  DEFAULT_REFRESH_SEC: 1800,
}));

const {
  stableHash,
  computeRefreshOffsetMs,
  computeRefreshStartDate,
  registerAccountRefresh,
  reconcileAccountRefreshes,
  buildSchedulerId,
  ACCOUNT_REFRESH_JOB_NAME,
} = await import("../workers/account-refresh-registrar.js");

// The nine live tracked-account ids from the audit (the test only needs nine
// distinct strings).
const LIVE_IDS = [
  "97956f92-b7f7-40c4-a7e2-ef585a7a57a5",
  "f0bf8805-261d-44c3-9c90-814f9e488a11",
  "3b3ef18e-932b-4ccd-b3a1-6fd547421077",
  "850bf538-74a0-424c-bd94-4b44b101957a",
  "6cb465e0-58c4-449b-a3d2-1a2b3c4d5e6f",
  "1dbb5e56-64c1-4aa4-b641-566b81a1f384",
  "dd8c9e98-07da-4784-b800-40ed4c9473ba",
  "b92286d1-1bb6-4ddd-a002-68a7635fcc08",
  "ad3a8c3f-5d2e-4ec7-8c0d-84aa2a7b44a2",
];

const TEN_MINUTES_MS = 10 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("stableHash (FNV-1a 32-bit)", () => {
  it("matches the published FNV-1a test vectors", () => {
    // https://tools.ietf.org/html/draft-eastlake-fnv — 32-bit FNV-1a.
    expect(stableHash("")).toBe(0x811c9dc5);
    expect(stableHash("a")).toBe(0xe40c292c);
    expect(stableHash("foobar")).toBe(0xbf9cf968);
  });

  it("is deterministic across calls", () => {
    for (const id of LIVE_IDS) {
      expect(stableHash(id)).toBe(stableHash(id));
    }
  });

  it("returns an unsigned 32-bit integer", () => {
    for (const id of [...LIVE_IDS, "", "x", "🙂"]) {
      const h = stableHash(id);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("gives distinct hashes to the nine live ids", () => {
    expect(new Set(LIVE_IDS.map(stableHash)).size).toBe(LIVE_IDS.length);
  });
});

describe("computeRefreshOffsetMs", () => {
  it("is in [0, every) and depends only on (id, every)", () => {
    for (const id of LIVE_IDS) {
      const off = computeRefreshOffsetMs(id, EVERY_MS);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThan(EVERY_MS);
      expect(off).toBe(computeRefreshOffsetMs(id, EVERY_MS));
      expect(off).toBe(stableHash(id) % EVERY_MS);
    }
  });

  it("spreads the nine live ids over at least 6 distinct 10-minute buckets of a 3h interval", () => {
    const buckets = new Set(
      LIVE_IDS.map((id) =>
        Math.floor(computeRefreshOffsetMs(id, EVERY_MS) / TEN_MINUTES_MS),
      ),
    );
    expect(buckets.size).toBeGreaterThanOrEqual(6);
  });

  it("degrades to 0 on an invalid interval instead of throwing", () => {
    expect(computeRefreshOffsetMs(LIVE_IDS[0], 0)).toBe(0);
    expect(computeRefreshOffsetMs(LIVE_IDS[0], Number.NaN)).toBe(0);
    expect(computeRefreshOffsetMs(LIVE_IDS[0], -5)).toBe(0);
  });
});

describe("computeRefreshStartDate", () => {
  // A fixed "now" that is NOT aligned to the interval.
  const NOW = Date.UTC(2026, 8, 2, 13, 37, 11, 456);
  const ALIGNED_NOW = Math.floor(NOW / EVERY_MS) * EVERY_MS;

  it("is strictly after now, at most one interval away, and carries the account's phase", () => {
    for (const id of LIVE_IDS) {
      const t = computeRefreshStartDate(id, EVERY_MS, NOW).getTime();
      expect(t).toBeGreaterThan(NOW);
      expect(t - NOW).toBeLessThanOrEqual(EVERY_MS);
      expect(t % EVERY_MS).toBe(computeRefreshOffsetMs(id, EVERY_MS));
    }
  });

  it("phase (startDate % every) is identical no matter what Date.now() is", () => {
    const nows = [
      NOW,
      NOW + 47 * 60 * 1000,
      NOW + 5 * EVERY_MS + 1,
      ALIGNED_NOW, // exactly on an interval boundary
      ALIGNED_NOW - 1, // just before a boundary
      Date.UTC(2031, 0, 1),
    ];
    for (const id of LIVE_IDS) {
      const phases = new Set(
        nows.map((n) => computeRefreshStartDate(id, EVERY_MS, n).getTime() % EVERY_MS),
      );
      expect(phases.size).toBe(1);
      expect([...phases][0]).toBe(computeRefreshOffsetMs(id, EVERY_MS));
    }
  });

  it("uses this interval's slot when it is still ahead of now", () => {
    const id = LIVE_IDS[0];
    const off = computeRefreshOffsetMs(id, EVERY_MS);
    const justBeforeSlot = ALIGNED_NOW + off - 1;
    expect(computeRefreshStartDate(id, EVERY_MS, justBeforeSlot).getTime()).toBe(
      ALIGNED_NOW + off,
    );
  });

  it("rolls to the NEXT interval when this interval's slot has already passed (BullMQ would clamp a past startDate to now and lose the phase)", () => {
    const id = LIVE_IDS[0];
    const off = computeRefreshOffsetMs(id, EVERY_MS);
    // exactly on the slot counts as passed: must be STRICTLY in the future
    expect(computeRefreshStartDate(id, EVERY_MS, ALIGNED_NOW + off).getTime()).toBe(
      ALIGNED_NOW + EVERY_MS + off,
    );
    expect(
      computeRefreshStartDate(id, EVERY_MS, ALIGNED_NOW + off + 1).getTime(),
    ).toBe(ALIGNED_NOW + EVERY_MS + off);
  });

  it("gives every live id a different first tick when all are registered in the same instant", () => {
    const ticks = new Set(
      LIVE_IDS.map((id) => computeRefreshStartDate(id, EVERY_MS, NOW).getTime()),
    );
    expect(ticks.size).toBe(LIVE_IDS.length);
  });

  it("falls back to now on an invalid interval instead of dividing by zero", () => {
    expect(computeRefreshStartDate(LIVE_IDS[0], 0, NOW).getTime()).toBe(NOW);
  });
});

describe("registerAccountRefresh", () => {
  const NOW = Date.UTC(2026, 8, 2, 13, 37, 11, 456);

  function makeQueue() {
    return {
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      removeJobScheduler: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("upserts with the unchanged every/jobId/removeOn* and a phase-carrying startDate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const id = LIVE_IDS[0];
    const queue = makeQueue();

    await expect(registerAccountRefresh(queue as never, id)).resolves.toBe(true);

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [schedulerId, repeatOpts, template] =
      queue.upsertJobScheduler.mock.calls[0];

    expect(schedulerId).toBe(buildSchedulerId(id));
    expect(schedulerId).toBe(`account-refresh:${id}`);

    // Cadence identical; only the phase is new.
    expect(Object.keys(repeatOpts).sort()).toEqual(["every", "startDate"]);
    expect(repeatOpts.every).toBe(EVERY_MS);
    expect(repeatOpts.startDate).toBeInstanceOf(Date);
    const t = (repeatOpts.startDate as Date).getTime();
    expect(t).toBeGreaterThan(NOW);
    expect(t - NOW).toBeLessThanOrEqual(EVERY_MS);
    expect(t % EVERY_MS).toBe(computeRefreshOffsetMs(id, EVERY_MS));

    // Job template must be byte-for-byte what it was before this change.
    expect(template).toEqual({
      name: ACCOUNT_REFRESH_JOB_NAME,
      data: { trackedAccountId: id, source: "account-refresh" },
      opts: {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 25 },
      },
    });
  });

  it("derives the same phase for the same account on a later rebuild", async () => {
    const id = LIVE_IDS[3];
    const phases: number[] = [];
    for (const when of [NOW, NOW + 47 * 60 * 1000, NOW + 9 * EVERY_MS + 12_345]) {
      vi.useFakeTimers();
      vi.setSystemTime(when);
      const queue = makeQueue();
      await registerAccountRefresh(queue as never, id);
      const [, repeatOpts] = queue.upsertJobScheduler.mock.calls[0];
      phases.push((repeatOpts.startDate as Date).getTime() % EVERY_MS);
      vi.useRealTimers();
    }
    expect(new Set(phases).size).toBe(1);
    expect(phases[0]).toBe(computeRefreshOffsetMs(id, EVERY_MS));
  });

  it("registers nine accounts in one synchronous loop with nine distinct first ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const queue = makeQueue();
    for (const id of LIVE_IDS) {
      await registerAccountRefresh(queue as never, id);
    }
    const ticks = queue.upsertJobScheduler.mock.calls.map(
      ([, repeatOpts]) => (repeatOpts.startDate as Date).getTime(),
    );
    expect(new Set(ticks).size).toBe(LIVE_IDS.length);
    // ...and no two within the same 10-minute bucket more than the hash allows
    const buckets = new Set(
      ticks.map((t) => Math.floor((t % EVERY_MS) / TEN_MINUTES_MS)),
    );
    expect(buckets.size).toBeGreaterThanOrEqual(6);
  });

  it("reports an upsert failure without throwing to an onboarding caller", async () => {
    const queue = makeQueue();
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      registerAccountRefresh(queue as never, LIVE_IDS[0]),
    ).resolves.toBe(false);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.error.mock.calls[0][0]).toMatchObject({
      module: "account-refresh-registrar",
      trackedAccountId: LIVE_IDS[0],
      err: "redis down",
    });
  });
});

describe("reconcileAccountRefreshes failure recovery", () => {
  function makeQueue() {
    return {
      getJobSchedulers: vi.fn().mockResolvedValue([]),
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
      removeJobScheduler: vi.fn().mockResolvedValue(true),
    };
  }

  it("repairs other accounts after a failed add and retries the missing scheduler on the next sweep", async () => {
    dbMock.where.mockResolvedValue([{ id: "first" }, { id: "second" }]);
    const queue = makeQueue();
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error("connection reset"));

    await expect(reconcileAccountRefreshes(queue as never)).rejects.toThrow("1 scheduler operation");
    expect(queue.upsertJobScheduler.mock.calls.map(([id]) => id)).toEqual([
      "account-refresh:first", "account-refresh:second",
    ]);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ active: 2, added: 1, removed: 0, failed: 1 }),
      "per-account refresh reconciliation incomplete",
    );

    queue.getJobSchedulers.mockResolvedValue([
      { key: "account-refresh:second", every: EVERY_MS, next: Date.now() + EVERY_MS },
    ]);
    queue.upsertJobScheduler.mockClear();
    await expect(reconcileAccountRefreshes(queue as never)).resolves.toEqual({ added: 1, removed: 0, active: 2 });
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler.mock.calls[0][0]).toBe("account-refresh:first");
  });

  it("reports an orphan removal failure while still registering another account", async () => {
    dbMock.where.mockResolvedValue([{ id: "active" }]);
    const queue = makeQueue();
    queue.getJobSchedulers.mockResolvedValue([{ key: "account-refresh:inactive" }]);
    queue.removeJobScheduler.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(reconcileAccountRefreshes(queue as never)).rejects.toThrow("1 scheduler operation");
    expect(queue.upsertJobScheduler.mock.calls[0][0]).toBe("account-refresh:active");
  });

  it("does not upsert over a stalled scheduler whose removal failed", async () => {
    dbMock.where.mockResolvedValue([{ id: "stalled" }, { id: "new" }]);
    const queue = makeQueue();
    queue.getJobSchedulers.mockResolvedValue([
      { key: "account-refresh:stalled", every: EVERY_MS, next: Date.now() - 4 * EVERY_MS },
    ]);
    queue.removeJobScheduler.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(reconcileAccountRefreshes(queue as never)).rejects.toThrow("1 scheduler operation");
    expect(queue.upsertJobScheduler.mock.calls.map(([id]) => id)).toEqual(["account-refresh:new"]);
  });

  it("keeps the watchdog degraded until a failed scheduler operation actually succeeds", async () => {
    const { runRecoverySweep, recoveryStatus } = await import("../services/recovery-watchdog.js");
    const queue = makeQueue();
    dbMock.where.mockResolvedValue([{ id: "active" }]);
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis unavailable"));
    const previousSuccess = recoveryStatus().lastSuccessAt;
    await runRecoverySweep({ refresh: () => reconcileAccountRefreshes(queue as never) });
    expect(recoveryStatus()).toMatchObject({ failedSteps: ["refresh"], lastSuccessAt: previousSuccess });
    await runRecoverySweep({ refresh: () => reconcileAccountRefreshes(queue as never) });
    expect(recoveryStatus().failedSteps).toEqual([]);
    expect(recoveryStatus().lastSuccessAt).not.toBeNull();
  });
});
