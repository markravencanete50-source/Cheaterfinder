// Unit tests for the complete-large-roster re-walk policy.
//
// Regression context (CLAUDE.md "Known pipeline gaps", 2026-09-02):
// @sample_account (9,947 followers, 9,677 held = 97% → "complete") saw its
// reported count drift by 1-3 every 3h, so `count-changed` started a fresh
// 240-page walk each cycle (~180-285 follower pages / 6h, 60% of the followers
// budget). No single walk can read >= 90% of a 9.9k roster, so every walk ended
// "scrape incomplete, skipping unfollow diff" — additive re-confirmation only.
//
// The policy is pure; the DB module is mocked only because diff-completeness
// also exports DB-backed helpers.

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => [] }),
        }),
      }),
    }),
  },
}));

const {
  shouldRewalkCompleteRoster,
  resolveRewalkMinDelta,
  rosterFitsSingleWalk,
  ROSTER_REWALK_MIN_DELTA_FLOOR,
} = await import("../services/diff-completeness.js");

const HOUR_MS = 60 * 60 * 1000;
const REWALK_MS = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 8, 2, 18, 0, 0);

/** sample_account as observed on 2026-09-02: last complete walk 1.5h ago. */
const sample = {
  lastWalkAt: NOW - 1.5 * HOUR_MS,
  reportedCount: 9_947,
  heldCount: 9_677,
  reportedAtLastWalk: 9_945,
  nowMs: NOW,
  rewalkMs: REWALK_MS,
  minDelta: 49,
} as const;

describe("shouldRewalkCompleteRoster", () => {
  it("defers a complete large roster whose count only drifted by a few", () => {
    expect(shouldRewalkCompleteRoster(sample)).toBe(false);
  });

  it("defers when the count did not move at all", () => {
    expect(
      shouldRewalkCompleteRoster({ ...sample, reportedCount: 9_945 }),
    ).toBe(false);
  });

  it("walks once the rewalk window has elapsed (at the boundary too)", () => {
    expect(
      shouldRewalkCompleteRoster({ ...sample, lastWalkAt: NOW - REWALK_MS }),
    ).toBe(true);
    expect(
      shouldRewalkCompleteRoster({ ...sample, lastWalkAt: NOW - REWALK_MS - 1 }),
    ).toBe(true);
  });

  it("stays deferred one millisecond before the window elapses", () => {
    expect(
      shouldRewalkCompleteRoster({ ...sample, lastWalkAt: NOW - REWALK_MS + 1 }),
    ).toBe(false);
  });

  it("walks early when the count moved by at least minDelta (either direction)", () => {
    expect(
      shouldRewalkCompleteRoster({ ...sample, reportedCount: 9_945 + 49 }),
    ).toBe(true);
    // Mass unfollow is just as much a reason to look now.
    expect(
      shouldRewalkCompleteRoster({ ...sample, reportedCount: 9_945 - 49 }),
    ).toBe(true);
    expect(
      shouldRewalkCompleteRoster({ ...sample, reportedCount: 9_945 + 48 }),
    ).toBe(false);
  });

  it("measures the delta against the count at the last walk, not the held roster", () => {
    // reported − held is a permanent ghost offset (270 here); it must not fire.
    expect(
      shouldRewalkCompleteRoster({ ...sample, reportedCount: 9_945, heldCount: 9_000 }),
    ).toBe(false);
  });

  it("walks when no complete walk was ever recorded", () => {
    expect(shouldRewalkCompleteRoster({ ...sample, lastWalkAt: null })).toBe(true);
    expect(
      shouldRewalkCompleteRoster({ ...sample, lastWalkAt: Number.NaN }),
    ).toBe(true);
  });

  it("walks when nothing is held (there is nothing to defer for)", () => {
    expect(shouldRewalkCompleteRoster({ ...sample, heldCount: 0 })).toBe(true);
  });

  it("fails open when the count at the last walk is unknown", () => {
    expect(
      shouldRewalkCompleteRoster({ ...sample, reportedAtLastWalk: null }),
    ).toBe(true);
    expect(
      shouldRewalkCompleteRoster({ ...sample, reportedAtLastWalk: undefined }),
    ).toBe(true);
    expect(
      shouldRewalkCompleteRoster({ ...sample, reportedAtLastWalk: Number.NaN }),
    ).toBe(true);
  });

  it("accepts the anchor as a Date", () => {
    expect(
      shouldRewalkCompleteRoster({ ...sample, lastWalkAt: new Date(sample.lastWalkAt) }),
    ).toBe(false);
    expect(
      shouldRewalkCompleteRoster({
        ...sample,
        lastWalkAt: new Date(NOW - REWALK_MS),
      }),
    ).toBe(true);
  });

  it("keeps a multi-cycle walk due until it completes (anchor only moves on exhaustion)", () => {
    // Leg 1 ran because the window elapsed; the anchor is untouched until the
    // cursor is exhausted, so the continuation leg 3h later is still due.
    const legOneAt = NOW - REWALK_MS - HOUR_MS;
    expect(
      shouldRewalkCompleteRoster({ ...sample, lastWalkAt: legOneAt - 3 * HOUR_MS }),
    ).toBe(true);
    expect(
      shouldRewalkCompleteRoster({
        ...sample,
        lastWalkAt: legOneAt - 3 * HOUR_MS,
        nowMs: NOW + 3 * HOUR_MS,
      }),
    ).toBe(true);
  });

  it("does not mutate its input", () => {
    const input = { ...sample };
    shouldRewalkCompleteRoster(input);
    expect(input).toEqual(sample);
  });
});

describe("resolveRewalkMinDelta", () => {
  it("floors at 25 for small rosters", () => {
    expect(ROSTER_REWALK_MIN_DELTA_FLOOR).toBe(25);
    expect(resolveRewalkMinDelta(100, null)).toBe(25);
    expect(resolveRewalkMinDelta(4_999, null)).toBe(25);
  });

  it("uses 0.5% of the held roster once that exceeds the floor", () => {
    expect(resolveRewalkMinDelta(5_001, null)).toBe(26);
    expect(resolveRewalkMinDelta(9_677, null)).toBe(49);
  });

  it("lets the operator override win when it is a positive integer", () => {
    expect(resolveRewalkMinDelta(9_677, 10)).toBe(10);
    expect(resolveRewalkMinDelta(9_677, 500.9)).toBe(500);
  });

  it("ignores an unusable override and derives the default", () => {
    expect(resolveRewalkMinDelta(9_677, 0)).toBe(49);
    expect(resolveRewalkMinDelta(9_677, -3)).toBe(49);
    expect(resolveRewalkMinDelta(9_677, Number.NaN)).toBe(49);
  });

  it("treats an invalid held count as an empty roster", () => {
    expect(resolveRewalkMinDelta(Number.NaN, null)).toBe(25);
    expect(resolveRewalkMinDelta(-10, null)).toBe(25);
  });
});

describe("rosterFitsSingleWalk", () => {
  const PAGES = 240;
  const PER_PAGE = 24;

  it("keeps mid-size rosters (all live accounts under 2k) on today's path", () => {
    expect(rosterFitsSingleWalk(1_856, PAGES, PER_PAGE)).toBe(true);
    expect(rosterFitsSingleWalk(128, PAGES, PER_PAGE)).toBe(true);
  });

  it("flags rosters beyond one walk's capacity", () => {
    expect(rosterFitsSingleWalk(9_947, PAGES, PER_PAGE)).toBe(false);
    expect(rosterFitsSingleWalk(PAGES * PER_PAGE + 1, PAGES, PER_PAGE)).toBe(false);
  });

  it("is inclusive at exact capacity", () => {
    expect(rosterFitsSingleWalk(PAGES * PER_PAGE, PAGES, PER_PAGE)).toBe(true);
  });

  it("treats empty or invalid counts as fitting (nothing to walk)", () => {
    expect(rosterFitsSingleWalk(0, PAGES, PER_PAGE)).toBe(true);
    expect(rosterFitsSingleWalk(Number.NaN, PAGES, PER_PAGE)).toBe(true);
  });

  it("shows why a 40-page cap would break mid-size accounts", () => {
    // The reason FOLLOW_GRAPH_MAX_PAGES keeps its 240 floor.
    expect(rosterFitsSingleWalk(1_856, 40, PER_PAGE)).toBe(false);
  });
});

describe("ROSTER_COMPLETE_REWALK_HOURS env clamp", () => {
  const load = async (value: string | undefined) => {
    vi.resetModules();
    if (value === undefined) vi.stubEnv("ROSTER_COMPLETE_REWALK_HOURS", "");
    else vi.stubEnv("ROSTER_COMPLETE_REWALK_HOURS", value);
    const mod = await import("../services/diff-completeness.js");
    return mod.ROSTER_COMPLETE_REWALK_HOURS;
  };

  it("defaults to 24h", async () => {
    expect(await load(undefined)).toBe(24);
  });

  it("clamps into 3..168 and ignores garbage", async () => {
    expect(await load("1")).toBe(3);
    expect(await load("999")).toBe(168);
    expect(await load("abc")).toBe(24);
    expect(await load("72")).toBe(72);
  });
});
