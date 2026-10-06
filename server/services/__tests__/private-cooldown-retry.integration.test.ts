import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || !["localhost", "127.0.0.1"].includes(parsed.hostname)
    || !parsed.port || ["5432", "6379"].includes(parsed.port) || !process.env.STRESS_NONCE
    || !(process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(parsed.port)) throw new Error("Isolated stress database required");
  process.env.DATABASE_URL = url;
}
const owner = randomUUID(), otherOwner = randomUUID(), track = randomUUID(), otherTrack = randomUUID();
const bots = [randomUUID(), randomUUID()];
const identity = (id: string) => ({ identity_version: 1, client: "instagram-firefox-web", browser_family: "firefox",
  platform: "Windows", browser_seed: 123, bot_id: id, browser_version: "128", user_agent: "test-agent",
  http_impersonate: "firefox", ja3: "test-ja3", h2_fingerprint: "test-h2", locale: "en-US", timezone: "UTC" });
(url ? describe : describe.skip)("approved private reader cooldown recovery — real database", () => {
  let pool: typeof import("../../db.js").pool;
  let retryAt: typeof import("../private-account-access.js").getPrivateReaderRetryAt;
  let now: Date, first: Date, second: Date;
  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    retryAt = (await import("../private-account-access.js")).getPrivateReaderRetryAt;
    for (const id of [owner, otherOwner]) {
      await pool.query("INSERT INTO users(id,email,name,hashed_password) VALUES($1,$2,'Cooldown fixture','fixture')", [id, `${id}@example.invalid`]);
      await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end) VALUES($1,$2,$3,'active','standard',now()+interval '1 day')", [id, `cus_${id}`, `sub_${id}`]);
    }
    for (const [id, user] of [[track, owner], [otherTrack, otherOwner]]) await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,is_private,is_active,access_status) VALUES($1,$2,$3,true,true,'has_access')", [id, user, `fixture_${id}`]);
    for (const id of bots) await pool.query("INSERT INTO bot_accounts(id,ig_username) VALUES($1,$2)", [id, `fixture_${id}`]);
  });
  beforeEach(async () => {
    now = new Date(); first = new Date(now.getTime() + 60 * 60_000); second = new Date(now.getTime() + 2 * 60 * 60_000);
    await pool.query("DELETE FROM bot_follow_requests WHERE tracked_account_id=ANY($1::varchar[])", [[track, otherTrack]]);
    await pool.query("UPDATE tracked_accounts SET is_active=true,is_private=true,access_status='has_access' WHERE id=ANY($1::varchar[])", [[track, otherTrack]]);
    await pool.query("UPDATE subscriptions SET status='active',stripe_customer_id='cus_'||user_id,stripe_subscription_id='sub_'||user_id,current_period_end=now()+interval '1 day',trial_ends_at=now()+interval '1 day' WHERE user_id=ANY($1::varchar[])", [[owner, otherOwner]]);
    await pool.query("UPDATE bot_accounts SET status='available',tier='worker',role='scraper',transport='web',session_data='fixture session',automation_identity=jsonb_build_object('bot_id',id),proxy_url='http://127.0.0.1:1',proxy_endpoint=NULL,proxy_expires_at=NULL,last_login_error=NULL,cooldown_until=$2 WHERE id=ANY($1::varchar[])", [bots, first]);
    for (const id of bots) await pool.query("UPDATE bot_accounts SET automation_identity=$2::jsonb WHERE id=$1", [id, JSON.stringify(identity(id))]);
    await pool.query("INSERT INTO bot_follow_requests(bot_account_id,tracked_account_id,status,resolved_at) VALUES($1,$2,'accepted',now()-interval '1 hour')", [bots[0], track]);
  });
  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM bot_follow_requests WHERE tracked_account_id=ANY($1::varchar[])", [[track, otherTrack]]);
    await pool.query("DELETE FROM bot_accounts WHERE id=ANY($1::varchar[])", [bots]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [[owner, otherOwner]]);
    await pool.end();
  });
  const backup = async (status = "accepted", cooldown: Date | null = second) => {
    await pool.query("UPDATE bot_accounts SET cooldown_until=$2 WHERE id=$1", [bots[1], cooldown]);
    await pool.query("INSERT INTO bot_follow_requests(bot_account_id,tracked_account_id,status,resolved_at) VALUES($1,$2,$3,now())", [bots[1], track, status]);
  };
  it("returns the accepted reader's observed cooldown exactly", async () => { expect(await retryAt(track, now)).toEqual(first); });
  it("chooses the earliest eligible independently accepted backup", async () => {
    await backup("accepted", new Date(now.getTime() + 10 * 60_000)); expect(await retryAt(track, now)).toEqual(new Date(now.getTime() + 10 * 60_000));
  });
  it.each([null, "past", "equal"])("does not defer when an approved backup can already read (%s)", async value => {
    await backup("accepted", value === null ? null : new Date(now.getTime() - (value === "past" ? 1 : 0)));
    expect(await retryAt(track, now)).toBeNull();
  });
  it("does not let an unapproved available backup cancel the approved viewer's wake-up", async () => {
    await backup("pending", null); expect(await retryAt(track, now)).toEqual(first);
  });
  it.each(["automation_identity=jsonb_build_object('bot_id',id)", "proxy_url='not/a/proxy'", "proxy_url=''"])("ignores a malformed ready backup while retaining the valid cooling reader: %s", async assignment => {
    await backup("accepted", null);
    await pool.query(`UPDATE bot_accounts SET ${assignment} WHERE id=$1`, [bots[1]]);
    expect(await retryAt(track, now)).toEqual(first);
  });
  it("supports a structurally valid approved canary reader", async () => {
    await pool.query("UPDATE bot_accounts SET tier='canary' WHERE id=$1", [bots[0]]); expect(await retryAt(track, now)).toEqual(first);
  });
  it.each(["queued", "pending", "failed", "expired", "rejected"])("requires acceptance, not %s", async status => {
    await pool.query("UPDATE bot_follow_requests SET status=$2 WHERE tracked_account_id=$1", [track, status]); expect(await retryAt(track, now)).toBeNull();
  });
  it.each(["pending_access", "access_denied", "public"])("requires the target grant, not %s", async status => {
    await pool.query("UPDATE tracked_accounts SET access_status=$2 WHERE id=$1", [track, status]); expect(await retryAt(track, now)).toBeNull();
  });
  it.each(["is_active", "is_private"])("does not schedule when %s was revoked", async column => {
    await pool.query(`UPDATE tracked_accounts SET ${column}=false WHERE id=$1`, [track]); expect(await retryAt(track, now)).toBeNull();
  });
  it.each(["past_due", "canceled"])("requires current entitlement, not %s", async status => {
    await pool.query("UPDATE subscriptions SET status=$2 WHERE user_id=$1", [owner, status]); expect(await retryAt(track, now)).toBeNull();
  });
  it("rejects a local subscription without verified provider linkage", async () => {
    await pool.query("UPDATE subscriptions SET stripe_subscription_id=NULL WHERE user_id=$1", [owner]); expect(await retryAt(track, now)).toBeNull();
  });
  it("rejects expired active periods even while another owner remains entitled", async () => {
    await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 second' WHERE user_id=$1", [owner]); expect(await retryAt(track, now)).toBeNull();
  });
  it("rejects expired trials and accepts a current real trial", async () => {
    await pool.query("UPDATE subscriptions SET status='trialing',trial_ends_at=now()-interval '1 second' WHERE user_id=$1", [owner]); expect(await retryAt(track, now)).toBeNull();
    await pool.query("UPDATE subscriptions SET trial_ends_at=now()+interval '1 day' WHERE user_id=$1", [owner]); expect(await retryAt(track, now)).toEqual(first);
  });
  it("does not borrow another customer's accepted viewer", async () => {
    await pool.query("UPDATE bot_follow_requests SET tracked_account_id=$2 WHERE tracked_account_id=$1", [track, otherTrack]); expect(await retryAt(track, now)).toBeNull();
  });
  it.each(["session_data=NULL", "session_data='   '", "automation_identity='{}'::jsonb", "automation_identity=jsonb_build_object('bot_id','wrong')", "proxy_url=NULL", "status='disabled'", "status='session_expired'", "status='banned'", "tier='reserve'", "tier='retired'", "transport='mobile'", "last_login_error='auth rejected'"])("does not wait for an otherwise unusable reader: %s", async assignment => {
    await pool.query(`UPDATE bot_accounts SET ${assignment} WHERE id=$1`, [bots[0]]); expect(await retryAt(track, now)).toBeNull();
  });
  it("accepts an in-use viewer but never attempts to steal its operation lease", async () => {
    await pool.query("UPDATE bot_accounts SET status='in_use' WHERE id=$1", [bots[0]]); expect(await retryAt(track, now)).toEqual(first);
  });
  it("keeps timed checkpoint cooldowns eligible for a later guarded check", async () => {
    await pool.query("UPDATE bot_accounts SET last_login_error='cooldown: checkpoint required' WHERE id=$1", [bots[0]]); expect(await retryAt(track, now)).toEqual(first);
  });
  it("requires a dynamic proxy to survive beyond the reader cooldown", async () => {
    await pool.query("UPDATE bot_accounts SET proxy_url=NULL,proxy_endpoint='127.0.0.1:1',proxy_expires_at=$2 WHERE id=$1", [bots[0], new Date(first.getTime() - 60_000)]);
    expect(await retryAt(track, now)).toBeNull();
    await pool.query("UPDATE bot_accounts SET proxy_expires_at=$2 WHERE id=$1", [bots[0], new Date(first.getTime() + 5 * 60_000)]);
    expect(await retryAt(track, now)).toEqual(first);
  });
});
