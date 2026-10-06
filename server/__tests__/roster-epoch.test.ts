// Unit tests for roster READ EPOCHS (audit 2026-09-02, lane C2).
//
// Regression context: IG truncates follower walks after a few pages, so one
// roster is read across several cycles through a saved cursor (0039). Judged
// per capture, no leg of such a walk ever covers 90% of the held roster, so
// absence was never evaluated — @example_account (704 followers, ~200 per leg)
// had its last complete follower read on 07-25 although its walks reached the
// end of the list every day. An epoch folds the legs of one walk into one
// logical read; these tests pin the pure planning and partition logic.

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../db.js", () => ({ db: {} }));
vi.mock("../observability/logger.js", () => {
  const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...sink, child: () => sink } };
});

const {
  planEpochLeg,
  partitionEpochAbsence,
  SINGLE_READ_LEG,
  HEAD_WALK_LEG,
  EMPTY_EPOCH_STATE,
  ROSTER_READ_COVERAGE,
} = await import("../services/roster-store.js");

const T0 = new Date("2026-09-03T00:00:00Z");
const T1 = new Date("2026-09-03T03:00:00Z");
const BEFORE = new Date("2026-09-02T20:00:00Z");

const openEpoch = {
  startedAt: T0,
  completedAt: null,
  startMemberCount: 700,
  legs: 2,
} as const;

describe("planEpochLeg", () => {
  it("treats the legacy single read as an epoch that begins and ends now", () => {
    const plan = planEpochLeg(SINGLE_READ_LEG, EMPTY_EPOCH_STATE, 704);
    expect(plan).toMatchObject({
      evaluate: true,
      seenSince: null,
      startMemberCount: 704,
      legs: 1,
      write: "complete",
      orphan: false,
    });
  });

  it("a walk from the top that did not exhaust the list BEGINS an epoch and is not judged", () => {
    const plan = planEpochLeg(
      { startsEpoch: true, endsEpoch: false },
      EMPTY_EPOCH_STATE,
      704,
    );
    expect(plan).toMatchObject({
      evaluate: false,
      seenSince: null,
      startMemberCount: 704,
      legs: 1,
      write: "begin",
    });
  });

  it("a resumed leg continues the open epoch and inherits its start", () => {
    const plan = planEpochLeg(
      { startsEpoch: false, endsEpoch: false },
      openEpoch,
      710,
    );
    expect(plan).toMatchObject({
      evaluate: false,
      seenSince: T0,
      startMemberCount: 700,
      legs: 3,
      write: "continue",
      orphan: false,
    });
  });

  it("the leg that exhausts the list COMPLETES the epoch and is judged against the epoch start", () => {
    const plan = planEpochLeg(
      { startsEpoch: false, endsEpoch: true },
      openEpoch,
      710,
    );
    expect(plan).toMatchObject({
      evaluate: true,
      seenSince: T0,
      startMemberCount: 700,
      legs: 3,
      write: "complete",
    });
  });

  it("a restart from a null cursor RESETS an open epoch instead of continuing it", () => {
    const plan = planEpochLeg(
      { startsEpoch: true, endsEpoch: false },
      openEpoch,
      710,
    );
    expect(plan).toMatchObject({
      evaluate: false,
      seenSince: null,
      startMemberCount: 710,
      legs: 1,
      write: "begin",
    });
  });

  it("a continuation with no open epoch is an orphan: sightings only, nothing judged", () => {
    const afterDeploy = planEpochLeg(
      { startsEpoch: false, endsEpoch: true },
      EMPTY_EPOCH_STATE,
      704,
    );
    expect(afterDeploy).toMatchObject({ evaluate: false, write: "none", orphan: true });

    const afterCompleted = planEpochLeg(
      { startsEpoch: false, endsEpoch: true },
      { ...openEpoch, completedAt: T1 },
      704,
    );
    expect(afterCompleted).toMatchObject({ evaluate: false, write: "none", orphan: true });
  });

  it("a head-walk never judges absence and never touches the epoch", () => {
    for (const state of [EMPTY_EPOCH_STATE, openEpoch]) {
      const plan = planEpochLeg(HEAD_WALK_LEG, state, 9_677);
      expect(plan).toMatchObject({
        evaluate: false,
        seenSince: null,
        write: "none",
        orphan: false,
      });
      expect(plan.legs).toBe(state.legs);
    }
  });
});

function member(isCurrent: boolean, lastSeenAt: Date | null) {
  return { isCurrent, lastSeenAt };
}

describe("partitionEpochAbsence", () => {
  const live = new Map([["c", 1], ["d", 1], ["new", 1]]);
  const existing = new Map([
    ["a", member(true, BEFORE)], // held, not in this capture, seen before the epoch
    ["b", member(true, T0)], // held, seen by an earlier leg of THIS epoch
    ["c", member(true, BEFORE)], // held, in this capture
    ["gone", member(false, BEFORE)], // already departed: never absent again
    ["never", member(true, null)], // no sighting at all
  ]);

  it("single read (no epoch start): only the live capture counts as seen", () => {
    const out = partitionEpochAbsence(existing, live, null);
    expect(out.seenCount).toBe(live.size);
    expect([...out.absent].sort()).toEqual(["a", "b", "never"]);
  });

  it("inside an epoch, members seen by an earlier leg are covered, not absent", () => {
    const out = partitionEpochAbsence(existing, live, T0);
    expect(out.seenCount).toBe(live.size + 1); // + "b"
    expect([...out.absent].sort()).toEqual(["a", "never"]);
  });

  it("a sighting exactly at the epoch start belongs to the epoch (first-leg stamps share now())", () => {
    const out = partitionEpochAbsence(new Map([["x", member(true, T0)]]), new Map(), T0);
    expect(out.absent).toEqual([]);
    expect(out.seenCount).toBe(1);
  });
});

describe("epoch coverage — the example_account shape", () => {
  // 704 held, IG hands back ~200 per leg. Per-capture coverage is 0.28; the
  // epoch's union is 1.0.
  const held = 704;
  const all = Array.from({ length: held }, (_, i) => `u${i}`);
  const legs = [all.slice(0, 200), all.slice(200, 400), all.slice(400, 600), all.slice(600)];

  it("no single leg qualifies as a complete read", () => {
    for (const leg of legs) {
      expect(leg.length >= held * ROSTER_READ_COVERAGE).toBe(false);
    }
  });

  it("the union at epoch end does, and a member missing from every leg is the only absentee", () => {
    const existing = new Map(all.map((u) => [u, member(true, BEFORE)]));
    // Legs 1-3 were reconciled earlier in the epoch: their sightings carry the
    // epoch start stamp. Leg 4 is the capture being reconciled now, minus one
    // member that left.
    for (const u of [...legs[0], ...legs[1], ...legs[2]]) existing.set(u, member(true, T0));
    const finalLeg = new Map(legs[3].filter((u) => u !== "u700").map((u) => [u, 1]));

    const out = partitionEpochAbsence(existing, finalLeg, T0);
    expect(out.seenCount).toBe(held - 1);
    expect(out.seenCount >= held * ROSTER_READ_COVERAGE).toBe(true);
    expect(out.absent).toEqual(["u700"]);
  });

  it("a partial epoch (walk restarted from the top) is never judged", () => {
    const plan = planEpochLeg(
      { startsEpoch: true, endsEpoch: false },
      { startedAt: T0, completedAt: null, startMemberCount: held, legs: 3 },
      held,
    );
    expect(plan.evaluate).toBe(false);
    expect(plan.write).toBe("begin");
  });
});
