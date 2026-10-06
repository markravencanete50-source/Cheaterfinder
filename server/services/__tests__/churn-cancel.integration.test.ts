// Real-Postgres tests for churn cancellation (public-data-persistence.ts).
//
// THE BUG THIS GUARDS (2026-07-16, after the roster rewrite): an account on
// Instagram's pagination boundary still oscillated — a confirmed departure
// (unfollow event) followed by a re-appearance (follow event), a net-zero PAIR
// on the same username. @sample_account produced 14 follows + 14 unfollows in
// a day, all the same usernames flapping. cancelChurn removes both sides of such
// a pair inside the churn window, and MUST leave genuine one-directional
// transitions — and out-of-window reversals — untouched.
//
// Requires a scratch DB (see roster-store.integration.test.ts); skipped when
// ROSTER_TEST_DATABASE_URL is unset.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const TEST_DB_URL = process.env.ROSTER_TEST_DATABASE_URL;
const describeIfDb = TEST_DB_URL ? describe : describe.skip;
if (TEST_DB_URL) process.env.DATABASE_URL = TEST_DB_URL;

describeIfDb("cancelChurn (real Postgres)", () => {
  let db: typeof import("../../db.js").db;
  let cancelChurn: typeof import("../roster-churn.js").cancelChurn;
  let schema: typeof import("../../../shared/schema.js");

  const ACCOUNT_ID = "00000000-0000-4000-8000-0000000000c1";
  const USER_ID = "00000000-0000-4000-8000-0000000000c2";

  const refs = () => ({
    followTable: schema.followEvents,
    followUsername: schema.followEvents.followedUsername,
    followDetectedAt: schema.followEvents.detectedAt,
    unfollowTable: schema.unfollowEvents,
    unfollowUsername: schema.unfollowEvents.unfollowedUsername,
    unfollowDetectedAt: schema.unfollowEvents.detectedAt,
  });

  const run = (arrivals: string[], departures: string[]) =>
    db.transaction((tx) =>
      cancelChurn(tx, ACCOUNT_ID, arrivals, departures, refs()),
    );

  const followEvt = (username: string, ageMs = 0) =>
    db.execute(sql`
      INSERT INTO follow_events (tracked_account_id, followed_username, detected_at)
      VALUES (${ACCOUNT_ID}, ${username}, now() - (${ageMs} || ' milliseconds')::interval)`);
  const unfollowEvt = (username: string, ageMs = 0) =>
    db.execute(sql`
      INSERT INTO unfollow_events (tracked_account_id, unfollowed_username, detected_at)
      VALUES (${ACCOUNT_ID}, ${username}, now() - (${ageMs} || ' milliseconds')::interval)`);

  const countFollow = async (username: string) => {
    const r = await db.execute(sql`
      SELECT count(*)::int AS n FROM follow_events
      WHERE tracked_account_id = ${ACCOUNT_ID} AND lower(followed_username) = ${username}`);
    return Number((r as unknown as { rows: { n: number }[] }).rows[0].n);
  };
  const countUnfollow = async (username: string) => {
    const r = await db.execute(sql`
      SELECT count(*)::int AS n FROM unfollow_events
      WHERE tracked_account_id = ${ACCOUNT_ID} AND lower(unfollowed_username) = ${username}`);
    return Number((r as unknown as { rows: { n: number }[] }).rows[0].n);
  };

  beforeAll(async () => {
    ({ db } = await import("../../db.js"));
    ({ cancelChurn } = await import("../roster-churn.js"));
    schema = await import("../../../shared/schema.js");
    await db.execute(sql`INSERT INTO users (id, email, name) VALUES (${USER_ID}, 'churn-test@example.invalid', 'Churn') ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO tracked_accounts (id, user_id, ig_username) VALUES (${ACCOUNT_ID}, ${USER_ID}, 'churn_test') ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM follow_events WHERE tracked_account_id = ${ACCOUNT_ID}`);
    await db.execute(sql`DELETE FROM unfollow_events WHERE tracked_account_id = ${ACCOUNT_ID}`);
  });

  it("an arrival cancels a recent unfollow (deletes it, drops the arrival)", async () => {
    await unfollowEvt("flapper"); // they 'left' moments ago
    const out = await run(["flapper"], []);
    expect(out.arrivals).toEqual([]); // arrival suppressed
    expect(await countUnfollow("flapper")).toBe(0); // false unfollow deleted
  });

  it("a departure cancels a recent follow (deletes it, drops the departure)", async () => {
    await followEvt("flapper"); // they were 'followed' moments ago
    const out = await run([], ["flapper"]);
    expect(out.departures).toEqual([]); // departure suppressed
    expect(await countFollow("flapper")).toBe(0); // false follow deleted
  });

  it("leaves a genuine arrival with no opposing event untouched", async () => {
    const out = await run(["newreal"], []);
    expect(out.arrivals).toEqual(["newreal"]);
  });

  it("leaves a genuine departure with no opposing event untouched", async () => {
    const out = await run([], ["goneforgood"]);
    expect(out.departures).toEqual(["goneforgood"]);
  });

  it("does NOT cancel a reversal older than the churn window", async () => {
    // A follow 10 days ago, unfollow now — that's a real, slow reversal, not
    // pagination flapping. Window default is 2 days.
    await followEvt("slowreversal", 10 * 24 * 60 * 60 * 1000);
    const out = await run([], ["slowreversal"]);
    expect(out.departures).toEqual(["slowreversal"]); // survives
    expect(await countFollow("slowreversal")).toBe(1); // old follow kept
  });

  it("is case-insensitive when matching the opposite event", async () => {
    await unfollowEvt("MixedCase");
    const out = await run(["mixedcase"], []);
    expect(out.arrivals).toEqual([]);
    expect(await countUnfollow("mixedcase")).toBe(0);
  });

  it("cancels only the churned members in a mixed batch", async () => {
    await unfollowEvt("returner"); // will be cancelled by its arrival
    const out = await run(["returner", "genuinelynew"], ["genuinelygone"]);
    expect(out.arrivals.sort()).toEqual(["genuinelynew"]);
    expect(out.departures).toEqual(["genuinelygone"]);
    expect(await countUnfollow("returner")).toBe(0);
  });
});
