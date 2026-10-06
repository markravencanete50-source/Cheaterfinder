// Integration tests for the roster reconcile engine, against real Postgres.
//
// WHY A REAL DATABASE: every interesting failure mode of this engine lives in
// the SQL — the ON CONFLICT target, the firstSeenAt CASE expression, the
// chunked inArray, the streak arithmetic. A mocked db would assert that the
// query builder was called, which is exactly the kind of test that let the
// original bug survive for months.
//
// THE BUG THIS GUARDS (2026-07-15): the roster was re-derived from its own
// event log, so a differently-paginated read looked like mass activity.
// @example_account's following was unchanged at 215 for hours while the system
// reported ~45 follows + ~32 unfollows every cycle — 860/859 over a week, all
// fabricated. The `pagination churn` test below reproduces that exact pattern
// and requires ZERO events.
//
// Requires a scratch DB; skipped automatically when ROSTER_TEST_DATABASE_URL is
// unset so CI without Postgres stays green:
//   createdb cheaterfinder_roster_test && pg_dump --schema-only cheaterfinder_ai | psql cheaterfinder_roster_test
//   ROSTER_TEST_DATABASE_URL=postgres://... npx vitest run roster-store.integration

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const TEST_DB_URL = process.env.ROSTER_TEST_DATABASE_URL;
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// The engine imports ../db.js at module load, which reads DATABASE_URL. Point it
// at the scratch database BEFORE any import of the module graph happens.
if (TEST_DB_URL) process.env.DATABASE_URL = TEST_DB_URL;
// Deterministic thresholds regardless of the operator's .env (this codebase has
// been bitten twice by real .env values bleeding into tests).
process.env.ROSTER_ABSENCE_CONFIRMATIONS = "2";
process.env.ROSTER_SETTLE_READS = "2";
process.env.ROSTER_SETTLE_GROWTH_TOLERANCE = "0.01";
process.env.ROSTER_SETTLE_MAX_SEEDING_HOURS = "48";

describeIfDb("reconcileRoster (real Postgres)", () => {
  let db: typeof import("../../db.js").db;
  let reconcileRoster: typeof import("../roster-store.js").reconcileRoster;
  let fetchRosterSet: typeof import("../roster-store.js").fetchRosterSet;

  const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
  const USER_ID = "00000000-0000-4000-8000-000000000002";

  beforeAll(async () => {
    ({ db } = await import("../../db.js"));
    ({ reconcileRoster, fetchRosterSet } = await import("../roster-store.js"));

    // Minimal FK parents for roster_members.tracked_account_id.
    await db.execute(
      sql`INSERT INTO users (id, email, name)
          VALUES (${USER_ID}, 'roster-test@example.invalid', 'Roster Test')
          ON CONFLICT (id) DO NOTHING`,
    );
    await db.execute(
      sql`INSERT INTO tracked_accounts (id, user_id, ig_username)
          VALUES (${ACCOUNT_ID}, ${USER_ID}, 'roster_test_account')
          ON CONFLICT (id) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  });

  beforeEach(async () => {
    await db.execute(
      sql`DELETE FROM roster_members WHERE tracked_account_id = ${ACCOUNT_ID}`,
    );
    await db.execute(
      sql`DELETE FROM roster_sync_state WHERE tracked_account_id = ${ACCOUNT_ID}`,
    );
  });

  /** A finished walk is not automatically confirmation that the reported
   * roster total was reached. Keep that separate from held-roster coverage so
   * stability tests actually exercise settling, not the confirmed-baseline path.
   */
  const run = (live: { username: string; fullName?: string | null }[], igConfirmsComplete = false) =>
    db.transaction((tx) =>
      reconcileRoster(tx, ACCOUNT_ID, "following", live, igConfirmsComplete),
    );

  const roster = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ username: `user${i}` }));

  /** Drop a rotating slice — IG returning a different subset each pass. */
  const omitSlice = (all: { username: string }[], start: number, count: number) =>
    all.filter((_, i) => i < start || i >= start + count);

  /**
   * Absorb the settle window so later reads report real activity.
   * Read 1 grows the union from nothing (stability restarts), reads 2-3 add
   * nothing new => stable_reads reaches 2 and the roster settles on read 3.
   */
  const settleWith = async (all: { username: string }[]) => {
    for (let i = 0; i < 3; i++) await run(all);
  };

  it("seeds silently: members are stored but no events are reported", async () => {
    const r = await run(roster(215));
    expect(r.settled).toBe(false);
    expect(r.arrivals).toEqual([]);
    expect(r.departures).toEqual([]);
    expect(r.currentCount).toBe(215);
  });

  it("a confirmed complete baseline settles silently, then reports only later arrivals", async () => {
    const all = roster(30);
    const baseline = await run(all, true);
    expect(baseline.settled).toBe(false);
    expect(baseline.justSettled).toBe(true);
    expect(baseline.arrivals).toEqual([]);
    expect(baseline.departures).toEqual([]);
    const next = await run([...all, { username: "after_baseline" }], true);
    expect(next.settled).toBe(true);
    expect(next.arrivals.map(member => member.username)).toEqual(["after_baseline"]);
  });

  it("stays silent across the whole settle window, then goes live", async () => {
    const all = roster(50);
    for (let i = 0; i < 3; i++) {
      const r = await run(all);
      expect(r.settled).toBe(false);
      expect(r.arrivals).toEqual([]);
    }
    const live = await run(all);
    expect(live.settled).toBe(true);
    expect(live.arrivals).toEqual([]);
    expect(live.departures).toEqual([]);
  });

  it("settles on STABILITY, not on a fraction of IG's reported count", async () => {
    // @complex reports 1,090 following but only ever enumerates ~743. Nothing
    // here knows or cares about 1,090: once the union stops growing, the roster
    // is as complete as it will ever be and must start reporting.
    const enumerable = roster(60);
    for (let i = 0; i < 3; i++) await run(enumerable);
    const live = await run(enumerable);
    expect(live.settled).toBe(true);
    expect(live.currentCount).toBe(60);
  });

  it("restarts the stability streak whenever the union grows", async () => {
    // A roster that keeps revealing new members is NOT stable, so it must not
    // settle and start calling that discovery "activity".
    for (let i = 1; i <= 4; i++) {
      const r = await run(roster(10 * i)); // grows every read
      expect(r.settled).toBe(false);
      expect(r.arrivals).toEqual([]);
    }
  });

  // ── The regression that motivated the rewrite ────────────────────────────
  it("emits NOTHING for pagination churn on an unchanged roster", async () => {
    const all = roster(215);
    await settleWith(all);

    // Each read omits a different ~16% slice: the measured @example_account
    // pattern that used to fabricate ~45 follows + ~32 unfollows per cycle.
    for (const read of [
      omitSlice(all, 0, 35),
      omitSlice(all, 35, 35),
      omitSlice(all, 70, 35),
    ]) {
      const r = await run(read);
      expect(r.arrivals).toEqual([]);
      expect(r.departures).toEqual([]);
    }

    const final = await run(all);
    expect(final.currentCount).toBe(215);
    expect(final.arrivals).toEqual([]);
  });

  it("does not resurrect briefly-omitted members as new follows", async () => {
    const all = roster(100);
    await settleWith(all);

    await run(omitSlice(all, 0, 20)); // streak = 1, below the threshold
    const back = await run(all);
    expect(back.arrivals).toEqual([]);
    expect(back.departures).toEqual([]);
  });

  it("reports a genuine new follow exactly once", async () => {
    const all = roster(30);
    await settleWith(all);

    const withNew = [...all, { username: "brand_new" }];
    const first = await run(withNew);
    expect(first.arrivals.map((a) => a.username)).toEqual(["brand_new"]);
    expect((await run(withNew)).arrivals).toEqual([]);
    expect((await run(withNew)).arrivals).toEqual([]);
  });

  it("confirms an unfollow only after repeated absence, and only once", async () => {
    const all = roster(30);
    await settleWith(all);
    const without = all.filter((m) => m.username !== "user7");

    expect((await run(without)).departures).toEqual([]); // 1 miss: not enough
    expect((await run(without)).departures).toEqual(["user7"]); // confirmed
    expect((await run(without)).departures).toEqual([]); // not re-reported
    expect((await run(without)).currentCount).toBe(29);
  });

  it("never confirms departures from an INCOMPLETE read", async () => {
    const all = roster(100);
    await settleWith(all);

    // The wire.fluid case: 12 captured of an expected 495.
    for (let i = 0; i < 5; i++) {
      const r = await run(all.slice(0, 12), false);
      expect(r.departures).toEqual([]);
    }
    expect((await run(all)).currentCount).toBe(100);
  });

  it("treats a genuine re-follow as a fresh arrival", async () => {
    const all = roster(20);
    await settleWith(all);
    const without = all.filter((m) => m.username !== "user3");

    await run(without);
    expect((await run(without)).departures).toEqual(["user3"]);

    const back = await run(all);
    expect(back.arrivals.map((a) => a.username)).toEqual(["user3"]);
    expect(back.currentCount).toBe(20);
  });

  it("keeps a known display name when a later capture omits it", async () => {
    await settleWith([{ username: "u1", fullName: "Real Name" }]);
    await run([{ username: "u1", fullName: null }]);
    const res = await db.execute(
      sql`SELECT display_name FROM roster_members
          WHERE tracked_account_id = ${ACCOUNT_ID} AND username_lower = 'u1'`,
    );
    const rows = (res as unknown as { rows?: { display_name: string }[] }).rows
      ?? (res as unknown as { display_name: string }[]);
    expect(rows[0]?.display_name).toBe("Real Name");
  });

  it("is case-insensitive: casing changes are not new members", async () => {
    await settleWith([{ username: "MixedCase" }]);
    const r = await run([{ username: "mixedcase" }]);
    expect(r.arrivals).toEqual([]);
    expect(r.departures).toEqual([]);
    expect(r.currentCount).toBe(1);
  });

  it("handles rosters larger than the upsert chunk size", async () => {
    // 1,200 members exercises the chunked insert and chunked inArray paths.
    const all = roster(1200);
    await settleWith(all);
    expect((await run(all)).currentCount).toBe(1200);

    // Drop 100 (1,100 captured = 92% of held, so the read still counts).
    const without = all.slice(0, 1100);
    await run(without);
    const confirmed = await run(without);
    expect(confirmed.departures).toHaveLength(100);
    expect(confirmed.currentCount).toBe(1100);
  });

  it("refuses to treat a half-sized capture as evidence of absence", async () => {
    // The wire.fluid failure (12 captured of 495 held → 305 false unfollows),
    // now caught by coverage measured against the HELD roster rather than IG's
    // reported number. Real accounts do not lose half their roster at once; a
    // read this short means the scrape was truncated.
    const all = roster(100);
    await settleWith(all);

    const half = all.slice(0, 50);
    for (let i = 0; i < 4; i++) {
      const r = await run(half);
      expect(r.departures).toEqual([]);
    }
    expect((await run(all)).currentCount).toBe(100);
  });

  it("fetchRosterSet returns only current members", async () => {
    const all = roster(10);
    await settleWith(all);
    const without = all.filter((m) => m.username !== "user4");
    await run(without);
    await run(without); // confirm departure

    const set = await db.transaction((tx) =>
      fetchRosterSet(tx, ACCOUNT_ID, "following"),
    );
    expect(set.has("user4")).toBe(false);
    expect(set.size).toBe(9);
  });
});
