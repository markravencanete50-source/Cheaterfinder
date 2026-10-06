// Unit tests for the dedicated liked-post detection cadence.
//
// Regression context: likes ran only as a tail of the profile refresh, so the
// flagship feature inherited the admin profile cadence (6h). With clustered
// per-account schedulers that produced a 4.7h window with zero liker reads
// while every bot sat under its daily cap. The sweep decouples the cadence but
// MUST reuse the existing per-account dedupe so the two enqueue paths can never
// double-spend liker budget on one account.
//
// All external I/O is mocked. No real DB, no real Redis.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { computeSweepBootDelayMs } from "../workers/likes-sweeper.js";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

const selectRows = vi.fn<() => Promise<Array<{ id: string }>>>();

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => selectRows(),
      }),
    }),
  },
}));

vi.mock("../observability/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Twin leader election (lesson 13): rows sharing an IG user resolve to one
// canonical row. Default = every row is its own canonical (no twins).
const canonicalOf = new Map<string, string>();
const canonicalTwinIdMock = vi.fn(async (id: string) => canonicalOf.get(id) ?? id);

vi.mock("../services/tracked-account-twins.js", () => ({
  canonicalTwinId: (id: string) => canonicalTwinIdMock(id),
}));

const {
  sweepLikes,
  collapseToCanonical,
  readLikesSweepMs,
  DEFAULT_LIKES_SWEEP_SEC,
} = await import("../workers/likes-sweeper.js");

const queue = {} as never;

beforeEach(() => {
  selectRows.mockReset();
  canonicalOf.clear();
  canonicalTwinIdMock.mockClear();
  canonicalTwinIdMock.mockImplementation(async (id: string) => canonicalOf.get(id) ?? id);
});

describe("readLikesSweepMs", () => {
  it("defaults to 1h, independent of the profile refresh interval", () => {
    expect(readLikesSweepMs({} as NodeJS.ProcessEnv)).toBe(3_600 * 1000);
    expect(DEFAULT_LIKES_SWEEP_SEC).toBe(3_600);
  });

  it("honours an explicit LIKES_SWEEP_SEC", () => {
    expect(
      readLikesSweepMs({ LIKES_SWEEP_SEC: "1800" } as NodeJS.ProcessEnv),
    ).toBe(1800 * 1000);
  });

  it("clamps below the floor rather than hammering the dedupe window", () => {
    expect(readLikesSweepMs({ LIKES_SWEEP_SEC: "5" } as NodeJS.ProcessEnv)).toBe(
      900 * 1000,
    );
  });

  it("clamps above the 24h ceiling", () => {
    expect(
      readLikesSweepMs({ LIKES_SWEEP_SEC: "999999" } as NodeJS.ProcessEnv),
    ).toBe(86_400 * 1000);
  });

  it("falls back to the default on garbage rather than disabling the sweep", () => {
    for (const bad of ["abc", "", "0", "-60"]) {
      expect(
        readLikesSweepMs({ LIKES_SWEEP_SEC: bad } as NodeJS.ProcessEnv),
      ).toBe(DEFAULT_LIKES_SWEEP_SEC * 1000);
    }
  });
});

describe("sweepLikes", () => {
  it("enqueues one scan per active account", async () => {
    selectRows.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const enqueue = vi.fn().mockResolvedValue("scheduled");

    const result = await sweepLikes(queue, enqueue);

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls.map((c) => c[1])).toEqual(["a", "b", "c"]);
    expect(result).toEqual({
      active: 3,
      collapsed: 0,
      scheduled: 3,
      throttled: 0,
      failed: 0,
    });
  });

  it("collapses twin rows onto their canonical twin and reports how many", async () => {
    // Two live twin pairs (tracked_user_1, tracked_user_3) plus two singletons.
    selectRows.mockResolvedValue([
      { id: "iso-canon" },
      { id: "solo-1" },
      { id: "iso-twin" },
      { id: "ash-twin" },
      { id: "ash-canon" },
      { id: "solo-2" },
    ]);
    canonicalOf.set("iso-twin", "iso-canon");
    canonicalOf.set("ash-twin", "ash-canon");
    const enqueue = vi.fn().mockResolvedValue("scheduled");

    const result = await sweepLikes(queue, enqueue);

    // Canonical ids only, once each, in first-seen order — the ash pair is
    // keyed by the canonical id even though the twin row was listed first.
    expect(enqueue.mock.calls.map((c) => c[1])).toEqual([
      "iso-canon",
      "solo-1",
      "ash-canon",
      "solo-2",
    ]);
    expect(result).toEqual({
      active: 6,
      collapsed: 2,
      scheduled: 4,
      throttled: 0,
      failed: 0,
    });
  });

  it("never drops a row when its canonical lookup throws (fails open to itself)", async () => {
    selectRows.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    canonicalTwinIdMock.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("db down");
      return id;
    });
    const enqueue = vi.fn().mockResolvedValue("scheduled");

    const result = await sweepLikes(queue, enqueue);

    expect(enqueue.mock.calls.map((c) => c[1])).toEqual(["a", "b"]);
    expect(result.collapsed).toBe(0);
    expect(result.scheduled).toBe(2);
  });

  it("counts dedupe throttles separately from scheduled runs", async () => {
    selectRows.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce("scheduled")
      .mockResolvedValueOnce("throttled");

    const result = await sweepLikes(queue, enqueue);

    expect(result.scheduled).toBe(1);
    expect(result.throttled).toBe(1);
  });

  it("does not double-spend: a fully throttled sweep schedules nothing", async () => {
    selectRows.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const enqueue = vi.fn().mockResolvedValue("throttled");

    const result = await sweepLikes(queue, enqueue);

    expect(result).toEqual({
      active: 2,
      collapsed: 0,
      scheduled: 0,
      throttled: 2,
      failed: 0,
    });
  });

  it("keeps sweeping after one account fails", async () => {
    selectRows.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const enqueue = vi
      .fn()
      .mockResolvedValueOnce("scheduled")
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce("scheduled");

    const result = await sweepLikes(queue, enqueue);

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      active: 3,
      collapsed: 0,
      scheduled: 2,
      throttled: 0,
      failed: 1,
    });
  });

  it("is a no-op when no accounts are active", async () => {
    selectRows.mockResolvedValue([]);
    const enqueue = vi.fn();

    const result = await sweepLikes(queue, enqueue);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result.active).toBe(0);
    expect(result.collapsed).toBe(0);
  });
});

describe("collapseToCanonical", () => {
  it("keeps each canonical once, in first-seen order", () => {
    const canonical = new Map([
      ["b", "a"],
      ["d", "c"],
    ]);
    expect(collapseToCanonical(["a", "b", "c", "d"], canonical)).toEqual(["a", "c"]);
  });

  it("is order-stable when the twin appears before its canonical", () => {
    const canonical = new Map([["twin", "canon"]]);
    expect(collapseToCanonical(["twin", "x", "canon"], canonical)).toEqual([
      "canon",
      "x",
    ]);
  });

  it("treats ids missing from the map as their own canonical", () => {
    expect(collapseToCanonical(["a", "b"], new Map())).toEqual(["a", "b"]);
  });

  it("dedupes repeated ids even without twins", () => {
    expect(collapseToCanonical(["a", "a", "b"], new Map())).toEqual(["a", "b"]);
  });

  it("returns an empty list for no ids and does not mutate its inputs", () => {
    const ids = Object.freeze(["a", "b"]) as readonly string[];
    const canonical = new Map([["b", "a"]]);
    expect(collapseToCanonical([], canonical)).toEqual([]);
    expect(collapseToCanonical(ids, canonical)).toEqual(["a"]);
    expect(ids).toEqual(["a", "b"]);
    expect(canonical.size).toBe(1);
  });
});


describe("computeSweepBootDelayMs", () => {
  const H = 3_600_000;
  it("sweeps immediately when nothing was recorded", () => {
    expect(computeSweepBootDelayMs(null, 10 * H, H)).toBe(0);
  });
  it("sweeps immediately when a full interval has elapsed", () => {
    expect(computeSweepBootDelayMs(8 * H, 10 * H, H)).toBe(0);
  });
  it("waits out the remainder of the interval otherwise (keeps the cadence)", () => {
    expect(computeSweepBootDelayMs(10 * H - 20 * 60_000, 10 * H, H)).toBe(40 * 60_000);
  });
  it("ignores a future or invalid timestamp", () => {
    expect(computeSweepBootDelayMs(11 * H, 10 * H, H)).toBe(0);
    expect(computeSweepBootDelayMs(Number.NaN, 10 * H, H)).toBe(0);
  });
});
