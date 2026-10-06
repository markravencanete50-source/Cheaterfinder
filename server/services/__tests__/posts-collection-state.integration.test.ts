import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  const allowed = Boolean(process.env.STRESS_NONCE) && parsed.port !== "5432" &&
    (process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(parsed.port);
  const redis = new URL(process.env.REDIS_URL ?? "http://invalid");
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || !["127.0.0.1", "localhost"].includes(parsed.hostname) || !allowed ||
    !["127.0.0.1", "localhost"].includes(redis.hostname) || !(process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(redis.port)) {
    throw new Error("Isolated PostgreSQL and Redis required for posts state fixtures");
  }
  process.env.DATABASE_URL = url;
  process.env.WORKERS_DISABLED = "1";
}

(url ? describe : describe.skip)("posts state — real persisted evidence and BullMQ scheduler", () => {
  let pool: typeof import("../../db.js").pool;
  let read: typeof import("../posts-collection-state.js").readPostsCollectionState;
  let queue: import("bullmq").Queue;
  let redis: import("ioredis").default;
  const owner = randomUUID(), canonical = randomUUID(), twin = randomUUID(), priv = randomUUID();
  const snapshotAt = new Date(Date.now() - 120_000), readAt = new Date(Date.now() - 60_000);
  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    read = (await import("../posts-collection-state.js")).readPostsCollectionState;
    const { Queue } = await import("bullmq");
    const { default: Redis } = await import("ioredis");
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue("collection-profile", { connection: redis });
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Posts state fixture')", [owner, owner + "@example.invalid"]);
    await pool.query(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end)
      VALUES($1,$2,$3,'active','standard',now()+interval '1 day')`, [owner, "cus_fixture_" + owner, "sub_fixture_" + owner]);
    for (const [index, id] of [canonical, twin, priv].entries()) {
      await pool.query(`INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,is_private,access_status,is_active,tracking_started)
        VALUES($1,$2,$3,'999999',$4,$5,true,$6)`, [id, owner, "fixture_" + canonical.replaceAll("-", ""), id === priv,
        id === priv ? "pending_access" : "public", new Date(snapshotAt.getTime() + index * 1000)]);
    }
  });
  afterAll(async () => {
    if (queue) { await queue.removeJobScheduler(`account-refresh:${canonical}`); await queue.close(); }
    if (redis) await redis.quit();
    if (pool) { await pool.query("DELETE FROM users WHERE id=$1", [owner]); await pool.end(); }
  });
  it("keeps missing snapshots unknown even when a profile-only job completed", async () => {
    await pool.query("INSERT INTO collection_jobs(tracked_account_id,job_type,status,started_at,completed_at) VALUES($1,'profile','completed',$2,$3)", [canonical, snapshotAt, readAt]);
    expect(await read(twin)).toMatchObject({ state: "not_collected", savedTotal: 0, recordedProfileCount: null,
      recordedProfileAt: null, lastPostsReadAt: null, source: "shared_public_profile" });
  });
  it("keeps default recorded zero separate from empty read evidence", async () => {
    await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,snapshot_at) VALUES($1,'fixture',$2)", [canonical, snapshotAt]);
    expect(await read(twin)).toMatchObject({ state: "not_collected", recordedProfileCount: 0 });
    await pool.query("UPDATE tracked_accounts SET last_content_refresh_at=$2 WHERE id=$1", [canonical, readAt]);
    expect(await read(twin)).toMatchObject({ state: "empty_observed", lastPostsReadAt: readAt.toISOString() });
  });
  it("reports a newer contradictory empty-feed failure and ignores newer skipped bookkeeping", async () => {
    await pool.query("UPDATE profile_snapshots SET post_count=23 WHERE tracked_account_id=$1", [canonical]);
    await pool.query(`INSERT INTO collection_jobs(tracked_account_id,job_type,status,started_at,completed_at,error) VALUES
      ($1,'profile','failed',now()-interval '10 seconds',now()-interval '5 seconds','partial collection: posts: rejected empty feed'),
      ($1,'profile','completed',now(),now(),'skipped: bookkeeping')`, [canonical]);
    const state = await read(twin);
    expect(state).toMatchObject({ state: "failed", savedTotal: 0, recordedProfileCount: 23, lastPostsReadAt: readAt.toISOString() });
    expect(JSON.stringify(state)).not.toContain("rejected");
  });
  it("verifies an actual installed BullMQ scheduler as a future check", async () => {
    const due = Date.now() + 3600_000;
    await queue.upsertJobScheduler(`account-refresh:${canonical}`, { every: 3 * 3600_000, startDate: due },
      { name: "account-refresh", data: { trackedAccountId: canonical, source: "account-refresh" } });
    const state = await read(twin);
    expect(state.state).toBe("delayed");
    expect(state.nextRetryAt).not.toBeNull();
    expect(Date.parse(state.nextRetryAt!)).toBeGreaterThan(Date.now());
    await queue.pause();
    expect((await read(twin)).nextRetryAt).toBeNull();
    await queue.resume();
    await queue.removeJobScheduler(`account-refresh:${canonical}`);
    expect((await read(twin)).nextRetryAt).toBeNull();
  });
  it("never accepts public counts for an inaccessible private twin", async () => {
    await pool.query(`INSERT INTO posts_cache(tracked_account_id,shortcode,post_type) VALUES($1,'HiddenPrivateFixture','photo')`, [priv]);
    expect(await read(priv, { contentAccountId: canonical, savedTotal: 123, profileSnapshot: { postCount: 123, snapshotAt } }))
      .toMatchObject({ state: "waiting_for_access", savedTotal: null, recordedProfileCount: null, lastPostsReadAt: null, source: "account" });
    await pool.query("UPDATE tracked_accounts SET access_status='has_access' WHERE id=$1", [priv]);
    expect(await read(priv, { contentAccountId: canonical, savedTotal: 123 })).toMatchObject({ state: "available", savedTotal: 1, source: "account" });
    await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 second' WHERE user_id=$1", [owner]);
    expect(await read(priv)).toMatchObject({ state: "unavailable", savedTotal: null, recordedProfileCount: null });
    await pool.query("UPDATE subscriptions SET current_period_end=now()+interval '1 day' WHERE user_id=$1", [owner]);
  });
  it("preserves historical public data while the original tracking row is paused", async () => {
    await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1", [twin]);
    await pool.query("INSERT INTO posts_cache(tracked_account_id,shortcode,post_type) VALUES($1,'SavedPublicFixture','photo')", [canonical]);
    expect(await read(twin)).toMatchObject({ state: "available", savedTotal: 1, recordedProfileCount: 23, trackingActive: false, nextRetryAt: null });
  });
});
