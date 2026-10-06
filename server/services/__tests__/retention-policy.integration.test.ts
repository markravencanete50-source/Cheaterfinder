import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  if (new URL(url).pathname !== "/cheaterfinder_backend_fix_test_20260907") {
    throw new Error("Guarded scratch database required for retention deletes");
  }
  process.env.DATABASE_URL = url;
}

// Exercise the actual daily cleanup against an isolated schema. In particular,
// expiry must not erase roster baselines or make the policy promise a full
// subscription-long archive of likes and snapshots.
(url ? describe : describe.skip)("published retention policy — real database", () => {
  let pool: typeof import("../../db.js").pool;
  let prune: typeof import("../../workers/retention-worker.js").pruneOldEvents;
  let deleteAccount: typeof import("../customer-billing-lifecycle.js").deleteCustomerAccount;
  const users = [randomUUID(), randomUUID()];
  const tracks = [randomUUID(), randomUUID()];
  const endpoint = "retention_fixture_" + randomUUID();
  const rosterTables = [
    ["follow_events", "followed_username"],
    ["unfollow_events", "unfollowed_username"],
    ["follower_events", "follower_username"],
    ["follower_unfollow_events", "unfollower_username"],
  ] as const;

  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    prune = (await import("../../workers/retention-worker.js")).pruneOldEvents;
    deleteAccount = (await import("../customer-billing-lifecycle.js")).deleteCustomerAccount;
  });

  beforeEach(async () => {
    for (const name of ["RETENTION_DAYS_EVENTS", "RETENTION_DAYS_SCRAPE_OUTCOMES", "RETENTION_DAYS_COLLECTION_JOBS"]) {
      vi.stubEnv(name, "");
    }
    for (let i = 0; i < users.length; i++) {
      await pool.query("INSERT INTO users(id,email,name,hashed_password) VALUES($1,$2,'Retention fixture','fixture')", [users[i], users[i] + "@example.invalid"]);
      await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,is_active) VALUES($1,$2,$3,$4)", [tracks[i], users[i], "retention_fixture_" + i, i === 0]);
      await pool.query("INSERT INTO subscriptions(user_id,status,plan,current_period_end) VALUES($1,$2,'standard',now()+interval '1 day')", [users[i], i === 0 ? "active" : "canceled"]);
      for (const age of [89, 91]) {
        await pool.query("INSERT INTO like_events(tracked_account_id,post_id,owner_username,detected_at) VALUES($1,$2,'fixture',now()-$3*interval '1 day')", [tracks[i], "age_" + age, age]);
        await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,snapshot_at) VALUES($1,'fixture',now()-$2*interval '1 day')", [tracks[i], age]);
      }
      for (const [table, column] of rosterTables) {
        await pool.query(`INSERT INTO ${table}(tracked_account_id,${column},detected_at) VALUES($1,'fixture_member',now()-interval '200 days')`, [tracks[i]]);
      }
      await pool.query("INSERT INTO reports(tracked_account_id,type,period_start,period_end,created_at,status,metrics) VALUES($1,'weekly',now()-interval '200 days',now()-interval '193 days',now()-interval '193 days','ready','{\"fixture\":true}')", [tracks[i]]);
    }
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [users]);
    await pool.query("DELETE FROM scrape_outcome_log WHERE endpoint=$1", [endpoint]);
  });
  afterAll(async () => { await pool?.end(); });

  it("prunes likes and snapshots after 90 days for active and cancelled subscriptions", async () => {
    // Stripe links make the first fixture a real entitlement, without calling Stripe.
    await pool.query("UPDATE subscriptions SET stripe_customer_id='cus_fixture',stripe_subscription_id='sub_fixture' WHERE user_id=$1", [users[0]]);
    const result = await prune();
    expect(result.retentionDays).toBe(90);
    expect(result.likeEvents).toBe(2);
    expect(result.profileSnapshots).toBe(2);
    for (const track of tracks) {
      expect((await pool.query("SELECT post_id FROM like_events WHERE tracked_account_id=$1", [track])).rows).toEqual([{ post_id: "age_89" }]);
      expect((await pool.query("SELECT count(*)::int AS n FROM profile_snapshots WHERE tracked_account_id=$1", [track])).rows[0].n).toBe(1);
    }
    const repeat = await prune();
    expect(repeat.likeEvents + repeat.profileSnapshots).toBe(0);
  });

  it("retains saved reports and all four roster histories until account deletion", async () => {
    await prune();
    for (const table of ["reports", ...rosterTables.map(([table]) => table)]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tracked_account_id=ANY($1::varchar[])`, [tracks])).rows[0].n).toBe(2);
    }
    await deleteAccount(users[0], null);
    for (const table of ["reports", "like_events", "profile_snapshots", ...rosterTables.map(([table]) => table)]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tracked_account_id=$1`, [tracks[0]])).rows[0].n).toBe(0);
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tracked_account_id=$1`, [tracks[1]])).rows[0].n).toBe(1);
    }
  });

  it("prunes terminal jobs and collection outcomes after 14 days while preserving live jobs", async () => {
    for (const status of ["pending", "running", "completed", "failed"]) {
      await pool.query("INSERT INTO collection_jobs(tracked_account_id,job_type,status,started_at,completed_at) VALUES($1,'profile',$2::job_status,now()-interval '15 days',CASE WHEN $2::text IN ('completed','failed') THEN now()-interval '15 days' END)", [tracks[0], status]);
    }
    await pool.query("INSERT INTO collection_jobs(tracked_account_id,job_type,status,started_at,completed_at) VALUES($1,'profile','completed',now()-interval '13 days',now()-interval '13 days')", [tracks[0]]);
    await pool.query("INSERT INTO scrape_outcome_log(endpoint,outcome,occurred_at) VALUES($1,'success',now()-interval '15 days'),($1,'success',now()-interval '13 days')", [endpoint]);
    const result = await prune();
    expect(result.collectionJobRetentionDays).toBe(14);
    expect(result.scrapeOutcomeRetentionDays).toBe(14);
    expect(result.collectionJobs).toBe(2);
    expect(result.scrapeOutcomeLog).toBe(1);
    expect((await pool.query("SELECT status FROM collection_jobs WHERE tracked_account_id=$1 ORDER BY status::text", [tracks[0]])).rows.map(row => row.status)).toEqual(["completed", "pending", "running"]);
  });
});
