import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  if (new URL(url).pathname !== "/cheaterfinder_backend_fix_test_20260907") throw new Error("Scratch database required");
  process.env.DATABASE_URL = url;
}
vi.mock("../realtime-events.js", () => ({ emitRealtime: vi.fn() }));
vi.mock("../media-cache-jobs.js", () => ({ enqueueMediaCacheUrls: vi.fn() }));
const userId = randomUUID(), accountId = randomUUID();
const member = (username: string) => ({ username, igUserId: username, fullName: username, profilePicUrl: "", isPrivate: false, isVerified: false });

(url ? describe : describe.skip)("roster persistence reliability (real Postgres)", () => {
  let db: typeof import("../../db.js").db, pool: typeof import("../../db.js").pool;
  let store: typeof import("../roster-store.js"), persistence: typeof import("../public-data-persistence.js");
  beforeAll(async () => {
    ({ db, pool } = await import("../../db.js"));
    store = await import("../roster-store.js"); persistence = await import("../public-data-persistence.js");
    await db.execute(sql`INSERT INTO users(id,email,name) VALUES(${userId},${userId + "@example.invalid"},'Roster reliability')`);
    await db.execute(sql`INSERT INTO tracked_accounts(id,user_id,ig_username) VALUES(${accountId},${userId},${"roster_" + accountId})`);
  });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM roster_members WHERE tracked_account_id=${accountId}`);
    await db.execute(sql`DELETE FROM roster_sync_state WHERE tracked_account_id=${accountId}`);
  });
  afterAll(async () => { if (db) await db.execute(sql`DELETE FROM users WHERE id=${userId}`); await pool?.end(); });

  it("resumes an opaque cursor only with its original viewer and retains prior observations", async () => {
    await persistence.persistFollowerDiff(accountId, [member("saved")], { leg: { startsEpoch: true, endsEpoch: false }, cursor: { nextCursor: "page-2", viewerBotId: "reader-a" } });
    expect(await store.loadRosterCursor(accountId, "follower", { viewerBotId: "reader-a" })).toBe("page-2");
    expect(await store.loadRosterCursor(accountId, "follower", { viewerBotId: "reader-b" })).toBeNull();
    expect((await db.transaction(tx => store.fetchRosterSet(tx, accountId, "follower"))).size).toBe(1);
    await store.saveRosterCursor(accountId, "follower", "legacy-page", null);
    expect(await store.loadRosterCursor(accountId, "follower", { viewerBotId: "reader-b" })).toBeNull();
  });

  it.each(["follower", "following"] as const)("first partial %s read stores sightings without claiming complete freshness", async dimension => {
    await db.transaction(tx => store.reconcileRoster(tx, accountId, dimension, [member("first")], false, { leg: { startsEpoch: true, endsEpoch: false } }));
    const row = (await pool.query("SELECT last_complete_read_at,complete_reads,epoch_completed_at FROM roster_sync_state WHERE tracked_account_id=$1 AND dimension=$2", [accountId, dimension])).rows[0];
    expect(row.last_complete_read_at).toBeNull(); expect(row.complete_reads).toBe(0); expect(row.epoch_completed_at).toBeNull();
    expect((await db.transaction(tx => store.fetchRosterSet(tx, accountId, dimension))).size).toBe(1);
  });

  it.each(["follower", "following"] as const)("%s cursor commits with sightings and rolls back if the checkpoint cannot be saved", async dimension => {
    const persist = dimension === "follower" ? persistence.persistFollowerDiff : persistence.persistFollowingDiff;
    await persist(accountId, [member("first")], { leg: { startsEpoch: true, endsEpoch: false }, cursor: { nextCursor: "C1" } });
    await expect(persist(accountId, [member("must_rollback")], { leg: { startsEpoch: false, endsEpoch: false }, cursor: { nextCursor: "C2", viewerBotId: "x".repeat(80) } })).rejects.toThrow();
    expect(await store.loadRosterCursor(accountId, dimension)).toBe("C1");
    expect(await db.transaction(tx => store.fetchRosterSet(tx, accountId, dimension))).toEqual(new Set(["first"]));
    await persist(accountId, [member("last")], { leg: { startsEpoch: false, endsEpoch: true }, cursor: { nextCursor: null } });
    expect(await store.loadRosterCursor(accountId, dimension)).toBeNull();
    expect(await db.transaction(tx => store.fetchRosterSet(tx, accountId, dimension))).toEqual(new Set(["first", "last"]));
    const row = (await pool.query("SELECT last_complete_read_at,epoch_legs FROM roster_sync_state WHERE tracked_account_id=$1 AND dimension=$2", [accountId, dimension])).rows[0];
    expect(row.last_complete_read_at).not.toBeNull(); expect(row.epoch_legs).toBe(2);
  });

  it("health reports the same stale complete-read evidence instead of a successful attempt", async () => {
    // Freshness applies after entitled profile discovery, independently of a
    // successful partial page. Unpaid/bootstrap rows have separate health states.
    await db.execute(sql`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end)
      VALUES(${userId},${"cus_" + userId},${"sub_" + userId},'active','standard',now()+interval '1 day')`);
    await db.execute(sql`UPDATE tracked_accounts SET ig_user_id='1234567890' WHERE id=${accountId}`);
    await db.execute(sql`INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,following_count)
      VALUES(${accountId},${"roster_" + accountId},2,2)`);
    try {
      await persistence.persistFollowerDiff(accountId, [member("first")], { leg: { startsEpoch: true, endsEpoch: false }, cursor: { nextCursor: "C1" } });
      const { readCollectionHealth } = await import("../collection-health.js");
      const health = await readCollectionHealth();
      expect(health.profiles.find(p => p.username === "roster_" + accountId)).toMatchObject({ rosterEligible: true, followersCompleteAt: null, followingCompleteAt: null });
      expect(health.staleFollowerRosters).toBeGreaterThanOrEqual(1);
      expect(health.staleFollowingRosters).toBeGreaterThanOrEqual(1);
    } finally {
      await db.execute(sql`DELETE FROM profile_snapshots WHERE tracked_account_id=${accountId}`);
      await db.execute(sql`UPDATE tracked_accounts SET ig_user_id=NULL WHERE id=${accountId}`);
      await db.execute(sql`DELETE FROM subscriptions WHERE user_id=${userId}`);
    }
  });

  it("a head sighting cannot erase a full-scan failure or retry deadline", async () => {
    const next=new Date(Date.now()+3600_000);
    await pool.query("INSERT INTO roster_sync_state(tracked_account_id,dimension,failure_kind,last_error,next_retry_at) VALUES($1,'follower','list_restricted','Source restricted',$2)",[accountId,next]);
    await persistence.persistFollowerDiff(accountId,[member("head")],{leg:{startsEpoch:false,endsEpoch:false,headOnly:true}});
    const health=await store.getRosterSyncHealth(accountId,"follower");
    expect(health.failureKind).toBe("list_restricted");expect(health.nextRetryAt?.getTime()).toBe(+next);expect(health.lastCompleteReadAt).toBeNull();
  });

  it("silent backfill on a settled roster emits no discoveries and resets obsolete absence strikes only at verification", async()=>{
    const members=Array.from({length:10},(_,i)=>member(`baseline_${i}`));
    await persistence.persistFollowerDiff(accountId,members,{leg:{startsEpoch:true,endsEpoch:true}});
    await pool.query("UPDATE roster_members SET missing_streak=2 WHERE tracked_account_id=$1 AND username_lower='baseline_9'",[accountId]);
    const result=await persistence.persistFollowerDiff(accountId,members.slice(0,9),{baselineOnly:true,minimumCompleteReadMembers:9,leg:{startsEpoch:true,endsEpoch:true}});
    expect(result).toEqual({completeRead:true,newFollowers:0,newFollowerUnfollows:0});
    expect((await pool.query("SELECT is_current,missing_streak FROM roster_members WHERE tracked_account_id=$1 AND username_lower='baseline_9'",[accountId])).rows[0]).toEqual({is_current:true,missing_streak:0});
    expect(await persistence.persistFollowerDiff(accountId,[member("old_discovery")],{baselineOnly:true,leg:{startsEpoch:true,endsEpoch:false}})).toEqual({completeRead:false,newFollowers:0,newFollowerUnfollows:0});
  });

  it.each(["follower", "following"] as const)("%s returns failed completeness for exhausted 369–413-of-481 captures without losing saved members", async dimension => {
    const persist = dimension === "follower" ? persistence.persistFollowerDiff : persistence.persistFollowingDiff;
    const members = Array.from({ length: 481 }, (_, i) => member(`coverage_${i}`));
    expect((await persist(accountId, members, { leg: { startsEpoch: true, endsEpoch: true } })).completeRead).toBe(true);
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    await pool.query("UPDATE roster_sync_state SET last_complete_read_at=$3,settled_at=$3 WHERE tracked_account_id=$1 AND dimension=$2", [accountId, dimension, old]);
    for (const captured of [369, 400, 413]) {
      const result = await persist(accountId, members.slice(0, captured), { leg: { startsEpoch: true, endsEpoch: true }, cursor: { nextCursor: null } });
      expect(result.completeRead).toBe(false);
      expect(dimension === "follower" ? (result as { newFollowerUnfollows: number }).newFollowerUnfollows : (result as { newUnfollows: number }).newUnfollows).toBe(0);
      expect((await store.getRosterSyncHealth(accountId, dimension)).lastCompleteReadAt?.getTime()).toBe(old.getTime());
      expect((await db.transaction(tx => store.fetchRosterSet(tx, accountId, dimension))).size).toBe(481);
    }
    expect((await persist(accountId, members, { leg: { startsEpoch: true, endsEpoch: true } })).completeRead).toBe(true);
    expect((await store.getRosterSyncHealth(accountId, dimension)).lastCompleteReadAt!.getTime()).toBeGreaterThan(old.getTime());
  });

  it.each(["follower", "following"] as const)("%s accepts a genuine empty baseline and an empty final continuation after full coverage", async dimension => {
    const persist = dimension === "follower" ? persistence.persistFollowerDiff : persistence.persistFollowingDiff;
    expect((await persist(accountId, [], { leg: { startsEpoch: true, endsEpoch: true } })).completeRead).toBe(true);
    const members = Array.from({ length: 10 }, (_, i) => member(`continued_${i}`));
    expect((await persist(accountId, members, { leg: { startsEpoch: true, endsEpoch: false }, cursor: { nextCursor: "last" } })).completeRead).toBe(false);
    expect((await persist(accountId, [], { leg: { startsEpoch: false, endsEpoch: true }, cursor: { nextCursor: null } })).completeRead).toBe(true);
    expect((await db.transaction(tx => store.fetchRosterSet(tx, accountId, dimension))).size).toBe(10);
  });

  it.each(["follower", "following"] as const)("%s stays stale after an exhausted low-coverage or head read, then freshens on verified coverage", async dimension => {
    const persist = dimension === "follower" ? persistence.persistFollowerDiff : persistence.persistFollowingDiff;
    const members = Array.from({ length: 10 }, (_, i) => member(`member_${i}`));
    await persist(accountId, members, { leg: { startsEpoch: true, endsEpoch: true } });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    await pool.query("UPDATE roster_sync_state SET last_complete_read_at=$3 WHERE tracked_account_id=$1 AND dimension=$2", [accountId, dimension, old]);

    await persist(accountId, members.slice(0, 7), { leg: { startsEpoch: true, endsEpoch: true } });
    expect((await store.getRosterSyncHealth(accountId, dimension)).lastCompleteReadAt?.getTime()).toBe(old.getTime());
    await persist(accountId, members.slice(0, 1), { leg: { startsEpoch: false, endsEpoch: false, headOnly: true } });
    const afterHead = await store.getRosterSyncHealth(accountId, dimension);
    expect(afterHead.lastCompleteReadAt?.getTime()).toBe(old.getTime());
    expect(afterHead.lastSuccessAt!.getTime()).toBeGreaterThan(old.getTime());

    await persist(accountId, members.slice(0, 9), { leg: { startsEpoch: true, endsEpoch: true }, cursor: { nextCursor: null } });
    expect((await store.getRosterSyncHealth(accountId, dimension)).lastCompleteReadAt!.getTime()).toBeGreaterThan(old.getTime());
    expect((await store.getRosterSyncHealth(accountId, dimension === "follower" ? "following" : "follower")).lastCompleteReadAt).toBeNull();
  });
});
