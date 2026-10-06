import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const databaseUrl = new URL(url);
  if (databaseUrl.pathname !== "/cheaterfinder_backend_fix_test_20260907" || !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) || !databaseUrl.port || databaseUrl.port === "5432") throw new Error("Guarded scratch database required");
  process.env.DATABASE_URL = url;
}
const users = [randomUUID(), randomUUID()], tracks = [randomUUID(), randomUUID()];
const bot = randomUUID(), requests = [randomUUID(), randomUUID()];
const otherBot = randomUUID(), otherRequest = randomUUID();
const historicalBots = [randomUUID(), randomUUID(), randomUUID()];
(url ? describe : describe.skip)("private follow entitlement and cancellation — real database", () => {
  let pool: typeof import("../../db.js").pool;
  let manager: typeof import("../../bot-manager.js");
  let findGrantedBotId: typeof import("../private-account-access.js").findGrantedBotId;
  let findGrantedBotIds: typeof import("../private-account-access.js").findGrantedBotIds;
  let privateBotHasAccess: typeof import("../private-account-access.js").privateBotHasAccess;
  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    manager = await import("../../bot-manager.js");
    ({ findGrantedBotId, findGrantedBotIds, privateBotHasAccess } = await import("../private-account-access.js"));
    for (let i=0; i<2; i++) {
      await pool.query("INSERT INTO users(id,email,name,hashed_password) VALUES($1,$2,'Follow fixture','fixture')", [users[i],users[i]+"@example.invalid"]);
      await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,is_private,access_status) VALUES($1,$2,$3,true,'pending_access')", [tracks[i],users[i],"fixture_"+i]);
      await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end,trial_ends_at) VALUES($1,$2,$3,'active','standard',now()+interval '1 day',now()+interval '1 day')",[users[i],"cus_"+users[i],"sub_"+users[i]]);
    }
    await pool.query("INSERT INTO bot_accounts(id,ig_username,current_follows,max_follows,status) VALUES($1,$2,2,2,'in_use')",[bot,"fixture_"+bot]);
    await pool.query("INSERT INTO bot_accounts(id,ig_username,current_follows,max_follows,status) VALUES($1,$2,0,2,'available')",[otherBot,"fixture_"+otherBot]);
    for (const id of historicalBots) await pool.query("INSERT INTO bot_accounts(id,ig_username,tier) VALUES($1,$2,'reserve')",[id,"fixture_"+id]);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM bot_follow_requests WHERE tracked_account_id=ANY($1::varchar[])",[tracks]);
    await pool.query("DELETE FROM notifications WHERE user_id=ANY($1::varchar[])",[users]);
    await pool.query("UPDATE subscriptions SET status='active',stripe_subscription_id='sub_'||user_id,current_period_end=now()+interval '1 day',trial_ends_at=now()+interval '1 day' WHERE user_id=ANY($1::varchar[])",[users]);
    await pool.query("UPDATE tracked_accounts SET is_active=true,is_private=true,access_status='pending_access' WHERE id=ANY($1::varchar[])",[tracks]);
    await pool.query("UPDATE bot_accounts SET current_follows=2,status='in_use' WHERE id=$1",[bot]);
    await pool.query("UPDATE bot_accounts SET transport='web',role='scraper',cooldown_until=NULL,last_login_error=NULL,proxy_endpoint=NULL,proxy_expires_at=NULL WHERE id=ANY($1::varchar[])",[[bot,otherBot]]);
    await pool.query("UPDATE bot_accounts SET current_follows=0,status='available',tier='reserve',session_data=NULL,automation_identity=NULL,proxy_url=NULL WHERE id=$1",[otherBot]);
    for (let i=0; i<2; i++) await pool.query("INSERT INTO bot_follow_requests(id,bot_account_id,tracked_account_id,status,expires_at) VALUES($1,$2,$3,'pending',now()-interval '1 second')",[requests[i],bot,tracks[i]]);
  });
  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM bot_follow_requests WHERE tracked_account_id=ANY($1::varchar[])",[tracks]);
    await pool.query("DELETE FROM bot_accounts WHERE id=ANY($1::varchar[])",[[bot,otherBot,...historicalBots]]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])",[users]);
    await pool.end();
  });
  const state = async () => (await pool.query("SELECT status,current_follows FROM bot_accounts WHERE id=$1",[bot])).rows[0];
  const access = async () => (await pool.query("SELECT access_status FROM tracked_accounts WHERE id=$1",[tracks[0]])).rows[0].access_status;
  const addOtherRequest = async (status: "queued" | "pending" | "accepted") => {
    await pool.query("INSERT INTO bot_follow_requests(id,bot_account_id,tracked_account_id,status) VALUES($1,$2,$3,$4)",[otherRequest,otherBot,tracks[0],status]);
    await pool.query("UPDATE bot_accounts SET current_follows=1 WHERE id=$1",[otherBot]);
  };
  const makeRotationBotEligible = async () => {
    // Selection-only fixtures: no runtime provisioning or Instagram requests.
    await pool.query("UPDATE bot_accounts SET tier='worker',session_data='fixture session',automation_identity='{\"identity_version\":1,\"client\":\"instagram-firefox-web\",\"browser_family\":\"firefox\",\"platform\":\"Windows\",\"browser_seed\":123,\"browser_version\":\"128\",\"user_agent\":\"fixture-agent\",\"http_impersonate\":\"firefox\",\"ja3\":\"fixture-ja3\",\"h2_fingerprint\":\"fixture-h2\",\"locale\":\"en-US\",\"timezone\":\"UTC\"}'::jsonb||jsonb_build_object('bot_id',id),proxy_url='http://127.0.0.1:1' WHERE id=$1",[otherBot]);
  };
  const addExhaustedHistory = async () => {
    const statuses = ['failed','rejected','expired'];
    for (let i=0; i<historicalBots.length; i++) await pool.query("INSERT INTO bot_follow_requests(bot_account_id,tracked_account_id,status) VALUES($1,$2,$3)",[historicalBots[i],tracks[0],statuses[i]]);
  };
  const deniedNotifications = async () => (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND title='Access Denied'",[users[0]])).rows[0].n;
  it("rolls back approval, access and notification together when the final write fails", async () => {
    const { db } = await import("../../db.js");
    const { notifications } = await import("../../../shared/schema.js");
    const transaction = db.transaction.bind(db);
    const failing = vi.spyOn(db, "transaction").mockImplementationOnce((callback: any, config: any) =>
      transaction(async tx => {
        const insert = tx.insert.bind(tx);
        tx.insert = ((table: any) => {
          if (table === notifications) throw new Error("fixture interrupted grant");
          return insert(table);
        }) as typeof tx.insert;
        return callback(tx);
      }, config));
    try {
      await expect(manager.markFollowRequestAccepted(requests[0], users[0])).rejects.toThrow("fixture interrupted grant");
    } finally { failing.mockRestore(); }
    expect(await access()).toBe("pending_access");
    expect((await pool.query("SELECT status,resolved_at FROM bot_follow_requests WHERE id=$1", [requests[0]])).rows[0])
      .toEqual({ status: "pending", resolved_at: null });
    await manager.markFollowRequestAccepted(requests[0], users[0]);
    expect(await access()).toBe("has_access");
    expect((await pool.query("SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type='access_granted'", [users[0]])).rows[0].n).toBe(1);
  });
  it("repairs an already accepted interrupted grant once under concurrent recovery", async () => {
    await pool.query("UPDATE bot_follow_requests SET status='accepted',resolved_at=now()-interval '1 hour' WHERE id=$1", [requests[0]]);
    await Promise.all(Array.from({length:5}, () => manager.markFollowRequestAccepted(requests[0], users[0])));
    expect(await access()).toBe("has_access");
    expect((await pool.query("SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type='access_granted'", [users[0]])).rows[0].n).toBe(1);
    expect(await state()).toEqual({status:"in_use",current_follows:2});
  });
  it("recovers an interrupted accepted grant through the periodic collection reconciler", async () => {
    const { reconcilePrivateAccessCollections } = await import("../private-access-collection.js");
    await pool.query("UPDATE bot_follow_requests SET status='accepted',resolved_at=now()-interval '1 hour' WHERE id=$1", [requests[0]]);
    const add = vi.fn().mockResolvedValue({});
    expect(await reconcilePrivateAccessCollections({add})).toBe(1);
    expect(await access()).toBe("has_access");
    expect(add).toHaveBeenCalledExactlyOnceWith("collect-profile",
      {trackedAccountId:tracks[0],force:true,source:"private-access-granted"},
      {jobId:`private-access-${requests[0]}`});
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1", [users[0]]);
    add.mockClear();
    expect(await reconcilePrivateAccessCollections({add})).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });
  it("does not accept a request using another customer's identity", async () => {
    await manager.markFollowRequestAccepted(requests[0], users[1]);
    expect(await access()).toBe("pending_access");
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [requests[0]])).rows[0].status).toBe("pending");
  });
  it.each(["primary", "backup", "rotation"])("excludes invalid identity and empty session from %s admission", async lane => {
    if (lane === "primary") await pool.query("DELETE FROM bot_follow_requests WHERE tracked_account_id=$1", [tracks[0]]);
    await makeRotationBotEligible();
    const assign = () => lane === "rotation" ? manager.rotateBotForTrackedAccount(tracks[0])
      : manager.assignBotToTrackedAccount(tracks[0], {backup:lane === "backup"});
    await pool.query("UPDATE bot_accounts SET automation_identity='{}'::jsonb WHERE id=$1", [otherBot]);
    expect(await assign()).toBeNull();
    await pool.query("UPDATE bot_accounts SET automation_identity='{\"identity_version\":1,\"client\":\"instagram-firefox-web\",\"browser_family\":\"firefox\",\"platform\":\"Windows\",\"browser_seed\":123,\"browser_version\":\"128\",\"user_agent\":\"fixture-agent\",\"http_impersonate\":\"firefox\",\"ja3\":\"fixture-ja3\",\"h2_fingerprint\":\"fixture-h2\",\"locale\":\"en-US\",\"timezone\":\"UTC\"}'::jsonb||jsonb_build_object('bot_id',id),session_data='   ' WHERE id=$1", [otherBot]);
    expect(await assign()).toBeNull();
    expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1", [otherBot])).rows[0].current_follows).toBe(0);
  });
  it.each(["primary", "backup", "rotation"])("does not allocate %s follow work after a target becomes public", async lane => {
    if (lane === "primary") await pool.query("DELETE FROM bot_follow_requests WHERE tracked_account_id=$1", [tracks[0]]);
    await makeRotationBotEligible();
    await pool.query("UPDATE tracked_accounts SET is_private=false,access_status='public' WHERE id=$1", [tracks[0]]);
    const result = lane === "rotation" ? await manager.rotateBotForTrackedAccount(tracks[0])
      : await manager.assignBotToTrackedAccount(tracks[0], {backup:lane === "backup"});
    expect(result).toBeNull();
    expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1", [otherBot])).rows[0].current_follows).toBe(0);
  });
  it.each(["failed", "rejected", "expired"])("does not reuse a %s viewer during primary retry fallback", async status => {
    await pool.query("DELETE FROM bot_follow_requests WHERE tracked_account_id=$1", [tracks[0]]);
    await makeRotationBotEligible();
    await pool.query("INSERT INTO bot_follow_requests(id,bot_account_id,tracked_account_id,status) VALUES($1,$2,$3,$4)", [otherRequest,otherBot,tracks[0],status]);
    expect(await manager.rotateBotForTrackedAccount(tracks[0])).toBeNull();
    expect(await manager.assignBotToTrackedAccount(tracks[0])).toBeNull();
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [otherRequest])).rows[0].status).toBe(status);
    expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1", [otherBot])).rows[0].current_follows).toBe(0);
  });
  it("admits expired timed cooldowns without treating them as permanent bans", async () => {
    await makeRotationBotEligible();
    await pool.query("UPDATE bot_accounts SET cooldown_until=now()-interval '1 second',last_login_error='cooldown: checkpoint_required' WHERE id=$1", [otherBot]);
    expect(await manager.assignBotToTrackedAccount(tracks[0], {backup:true})).toBeTruthy();
    await pool.query("UPDATE bot_follow_requests SET status='accepted',resolved_at=now() WHERE tracked_account_id=$1 AND bot_account_id=$2", [tracks[0],otherBot]);
    await pool.query("UPDATE tracked_accounts SET access_status='has_access' WHERE id=$1", [tracks[0]]);
    expect(await findGrantedBotIds(tracks[0])).toEqual([otherBot]);
    await pool.query("UPDATE bot_accounts SET cooldown_until=now()+interval '1 hour' WHERE id=$1", [otherBot]);
    expect(await findGrantedBotIds(tracks[0])).toEqual([]);
    await pool.query("UPDATE bot_accounts SET cooldown_until=now()-interval '1 second',last_login_error='checkpoint_required' WHERE id=$1", [otherBot]);
    expect(await findGrantedBotIds(tracks[0])).toEqual([]);
  });
  it("authorizes polling only for the exact still-pending entitled private request", async () => {
    const { privateFollowRequestCanProbe } = await import("../private-account-access.js");
    expect(await privateFollowRequestCanProbe(requests[0], tracks[0], bot)).toBe(true);
    expect(await privateFollowRequestCanProbe(requests[0], tracks[1], bot)).toBe(false);
    expect(await privateFollowRequestCanProbe(requests[0], tracks[0], otherBot)).toBe(false);
    await manager.markFollowRequestAccepted(requests[0], users[0]);
    expect(await privateFollowRequestCanProbe(requests[0], tracks[0], bot)).toBe(false);
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1", [users[1]]);
    expect(await privateFollowRequestCanProbe(requests[1], tracks[1], bot)).toBe(false);
  });
  it("rechecks the exact approved viewer and current entitlement between private collection steps", async () => {
    await manager.markFollowRequestAccepted(requests[0], users[0]);
    expect(await privateBotHasAccess(tracks[0], bot)).toBe(true);
    expect(await privateBotHasAccess(tracks[0], otherBot)).toBe(false);
    expect(await privateBotHasAccess(tracks[1], bot)).toBe(false);
    await pool.query("UPDATE bot_accounts SET cooldown_until=now()+interval '1 hour' WHERE id=$1", [bot]);
    expect(await privateBotHasAccess(tracks[0], bot)).toBe(true);
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1", [users[0]]);
    expect(await privateBotHasAccess(tracks[0], bot)).toBe(false);
    await pool.query("UPDATE subscriptions SET status='active' WHERE user_id=$1", [users[0]]);
    await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1", [tracks[0]]);
    expect(await privateBotHasAccess(tracks[0], bot)).toBe(false);
  });
  it("revokes an explicitly removed approval exactly once under concurrent observations", async () => {
    await manager.markFollowRequestAccepted(requests[0], users[0]);
    const results = await Promise.all(Array.from({ length: 5 }, () => manager.revokeAcceptedBotAccess(tracks[0], bot)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await state()).toEqual({ status: "available", current_follows: 1 });
    expect(await access()).toBe("access_denied");
    expect((await pool.query("SELECT status,error FROM bot_follow_requests WHERE id=$1", [requests[0]])).rows[0])
      .toEqual({ status: "failed", error: "Approved follow relationship revoked" });
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [requests[1]])).rows[0].status).toBe("pending");
  });
  it.each(["accepted", "pending", "queued"] as const)("preserves the independent %s backup when an approval is revoked", async status => {
    await manager.markFollowRequestAccepted(requests[0], users[0]);
    await addOtherRequest(status);
    expect(await manager.revokeAcceptedBotAccess(tracks[0], bot)).toBe(true);
    expect(await access()).toBe(status === "accepted" ? "has_access" : "pending_access");
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [otherRequest])).rows[0].status).toBe(status);
    expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1", [otherBot])).rows[0].current_follows).toBe(1);
  });
  it("generic failures cannot revoke an accepted grant", async () => {
    await manager.markFollowRequestAccepted(requests[0], users[0]);
    await manager.markFollowRequestFailed(requests[0], "Temporary provider failure");
    expect(await access()).toBe("has_access");
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [requests[0]])).rows[0].status).toBe("accepted");
    expect(await state()).toEqual({ status: "in_use", current_follows: 2 });
  });
  it('serializes simultaneous primary assignments without duplicate external work',async()=>{
    await pool.query('DELETE FROM bot_follow_requests WHERE tracked_account_id=$1',[tracks[0]]);
    await makeRotationBotEligible();
    const ids=await Promise.all([manager.assignBotToTrackedAccount(tracks[0]),manager.assignBotToTrackedAccount(tracks[0])]);
    expect(ids.filter(Boolean)).toHaveLength(1);
    expect((await pool.query('SELECT current_follows FROM bot_accounts WHERE id=$1',[otherBot])).rows[0].current_follows).toBe(1);
  });
  it('waits until the primary is sent before assigning its backup',async()=>{
    await makeRotationBotEligible();await pool.query("UPDATE bot_follow_requests SET status='queued' WHERE id=$1",[requests[0]]);
    expect(await manager.assignBotToTrackedAccount(tracks[0],{backup:true})).toBeNull();
  });
  it('creates exactly one distinct backup under concurrent sweeps and recovers its enqueue',async()=>{
    await makeRotationBotEligible();
    const ids=await Promise.all(Array.from({length:4},()=>manager.assignBotToTrackedAccount(tracks[0],{backup:true})));
    expect(ids.every(Boolean)).toBe(true);expect(new Set(ids).size).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM bot_follow_requests WHERE tracked_account_id=$1',[tracks[0]])).rows[0].n).toBe(2);
    expect((await pool.query('SELECT current_follows FROM bot_accounts WHERE id=$1',[otherBot])).rows[0].current_follows).toBe(1);
    expect(await manager.assignBotToTrackedAccount(tracks[0],{backup:true})).toBe(ids[0]);
  });
  it('preserves access when adding a backup and accepts an existing relationship without duplicate notification',async()=>{
    await manager.markFollowRequestAccepted(requests[0],users[0]);await makeRotationBotEligible();
    const id=await manager.assignBotToTrackedAccount(tracks[0],{backup:true});expect(id).toBeTruthy();
    expect(await access()).toBe('has_access');
    await manager.markFollowRequestAccepted(id!,users[0]);
    expect((await pool.query('SELECT status FROM bot_follow_requests WHERE id=$1',[id])).rows[0].status).toBe('accepted');
    expect((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND type='access_granted'",[users[0]])).rows[0].n).toBe(1);
  });
  it.each(['mobile','feed_watcher','reels_watcher'])('does not allocate %s accounts to browser follow work',async kind=>{
    await makeRotationBotEligible();
    await pool.query(kind==='mobile'?"UPDATE bot_accounts SET transport='mobile' WHERE id=$1":"UPDATE bot_accounts SET role=$2 WHERE id=$1",kind==='mobile'?[otherBot]:[otherBot,kind]);
    expect(await manager.assignBotToTrackedAccount(tracks[0],{backup:true})).toBeNull();
  });
  it('does not endlessly add backup requests after three failed attempts',async()=>{
    await makeRotationBotEligible();await addExhaustedHistory();
    expect(await manager.assignBotToTrackedAccount(tracks[0],{backup:true})).toBeNull();
  });
  it('exposes both independently approved healthy viewers, then only the backup after expiry',async()=>{
    await addOtherRequest('accepted');
    await pool.query("UPDATE tracked_accounts SET access_status='has_access' WHERE id=$1",[tracks[0]]);
    await pool.query("UPDATE bot_follow_requests SET status='accepted',resolved_at=now()-interval '1 hour' WHERE id=$1",[requests[0]]);
    await pool.query("UPDATE bot_accounts SET status='available',tier='worker',session_data='fixture session',automation_identity='{\"identity_version\":1,\"client\":\"instagram-firefox-web\",\"browser_family\":\"firefox\",\"platform\":\"Windows\",\"browser_seed\":123,\"browser_version\":\"128\",\"user_agent\":\"fixture-agent\",\"http_impersonate\":\"firefox\",\"ja3\":\"fixture-ja3\",\"h2_fingerprint\":\"fixture-h2\",\"locale\":\"en-US\",\"timezone\":\"UTC\"}'::jsonb||jsonb_build_object('bot_id',id),proxy_url='http://127.0.0.1:1' WHERE id=ANY($1::varchar[])",[[bot,otherBot]]);
    expect(await findGrantedBotIds(tracks[0])).toEqual([bot,otherBot]);
    await pool.query("UPDATE bot_accounts SET status='session_expired' WHERE id=$1",[bot]);
    expect(await findGrantedBotIds(tracks[0])).toEqual([otherBot]);
  });
  it.each(["inactive", "canceled", "expired", "trial_expired", "unlinked"])("excludes %s work from probing, rotation and new assignment",async kind => {
    if(kind==='inactive') await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1",[tracks[0]]);
    if(kind==='canceled') await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1",[users[0]]);
    if(kind==='expired') await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 second' WHERE user_id=$1",[users[0]]);
    if(kind==='trial_expired') await pool.query("UPDATE subscriptions SET status='trialing',trial_ends_at=now()-interval '1 second' WHERE user_id=$1",[users[0]]);
    if(kind==='unlinked') await pool.query("UPDATE subscriptions SET stripe_subscription_id=NULL WHERE user_id=$1",[users[0]]);
    expect((await manager.getPendingFollowRequests()).map(x=>x.id)).toContain(requests[1]);
    expect((await manager.getPendingFollowRequests()).map(x=>x.id)).not.toContain(requests[0]);
    expect((await manager.getExpiredFollowRequests()).map(x=>x.id)).not.toContain(requests[0]);
    expect(await manager.assignBotToTrackedAccount(tracks[0])).toBeNull();
    expect(await manager.rotateBotForTrackedAccount(tracks[0])).toBeNull();
    await manager.cancelIneligibleFollowRequests();
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1",[requests[0]])).rows[0].status).toBe('failed');
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1",[requests[1]])).rows[0].status).toBe('pending');
    expect(await state()).toEqual({status:'available',current_follows:1});
    expect(await access()).toBe('pending_access');
  });
  it("makes a failed missing-proxy attempt retryable for an eligible trial without a sent request",async()=>{
    await pool.query("UPDATE subscriptions SET status='trialing' WHERE user_id=$1",[users[0]]);
    await pool.query("UPDATE bot_follow_requests SET status='queued',sent_at=NULL,expires_at=NULL WHERE id=$1",[requests[0]]);
    const error="bot has no proxy_endpoint — refusing to send follow traffic from the datacenter IP";
    await manager.markFollowRequestFailed(requests[0],error);
    expect((await pool.query("SELECT status,error,sent_at FROM bot_follow_requests WHERE id=$1",[requests[0]])).rows[0]).toEqual({status:'failed',error,sent_at:null});
    expect(await access()).toBe('access_denied');
    expect(await state()).toEqual({status:'available',current_follows:1});
    await manager.markFollowRequestFailed(requests[0],error);
    expect(await state()).toEqual({status:'available',current_follows:1});
  });
  it.each(["queued", "pending", "accepted"] as const)("preserves access processing when another %s request exists",async status=>{
    await addOtherRequest(status);
    await manager.markFollowRequestFailed(requests[0],'fixture missing proxy');
    expect(await access()).toBe('pending_access');
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1",[otherRequest])).rows[0].status).toBe(status);
  });
  it.each(["has_access", "public"] as const)("does not replace a target's %s state after an old attempt fails",async status=>{
    await pool.query("UPDATE tracked_accounts SET access_status=$2,is_private=$3 WHERE id=$1",[tracks[0],status,status!=='public']);
    await manager.markFollowRequestFailed(requests[0],'fixture old failure');
    expect(await access()).toBe(status);
  });
  it("exposes retry after concurrent failures of the last two attempts and releases each slot once",async()=>{
    await addOtherRequest('pending');
    await Promise.all([manager.markFollowRequestFailed(requests[0],'fixture missing proxy'),manager.markFollowRequestFailed(otherRequest,'fixture session expired')]);
    expect(await access()).toBe('access_denied');
    expect(await state()).toEqual({status:'available',current_follows:1});
    expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1",[otherBot])).rows[0].current_follows).toBe(0);
  });
  it("preserves another request's successful acceptance when a failure races it",async()=>{
    await addOtherRequest('pending');
    await Promise.all([manager.markFollowRequestFailed(requests[0],'fixture missing proxy'),manager.markFollowRequestAccepted(otherRequest,users[0])]);
    expect(await access()).toBe('has_access');
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1",[otherRequest])).rows[0].status).toBe('accepted');
  });
  it("restores pending access when rotation replaces a terminally failed attempt",async()=>{
    await manager.markFollowRequestFailed(requests[0],'fixture missing proxy');
    expect(await access()).toBe('access_denied');
    await makeRotationBotEligible();
    const replacement=await manager.rotateBotForTrackedAccount(tracks[0]);
    expect(replacement).not.toBeNull();
    expect(await access()).toBe('pending_access');
    expect((await pool.query("SELECT status,bot_account_id FROM bot_follow_requests WHERE id=$1",[replacement])).rows[0]).toEqual({status:'queued',bot_account_id:otherBot});
  });
  it("keeps a replacement pending when rotation races the original attempt's failure",async()=>{
    await makeRotationBotEligible();
    const [,replacement]=await Promise.all([manager.markFollowRequestFailed(requests[0],'fixture missing proxy'),manager.rotateBotForTrackedAccount(tracks[0])]);
    expect(replacement).not.toBeNull();
    expect(await access()).toBe('pending_access');
    expect(await state()).toEqual({status:'available',current_follows:1});
    expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1",[otherBot])).rows[0].current_follows).toBe(1);
  });
  it("does not replace already granted access when a rotation finishes",async()=>{
    await manager.markFollowRequestAccepted(requests[0],users[0]);
    await makeRotationBotEligible();
    expect(await manager.rotateBotForTrackedAccount(tracks[0])).not.toBeNull();
    expect(await access()).toBe('has_access');
  });
  it.each(["healthy", "cooldown", "expired_session", "missing_session", "wrong_identity", "missing_proxy", "mobile", "auth_failure", "reserve", "retired"])("selects only an approved healthy viewer when the original is %s",async kind=>{
    await addOtherRequest('accepted');
    await pool.query("UPDATE tracked_accounts SET access_status='has_access' WHERE id=$1",[tracks[0]]);
    await pool.query("UPDATE bot_follow_requests SET status='accepted',resolved_at=now()-interval '1 hour' WHERE id=$1",[requests[0]]);
    await pool.query("UPDATE bot_follow_requests SET resolved_at=now() WHERE id=$1",[otherRequest]);
    await pool.query("UPDATE bot_accounts SET tier='worker',session_data='fixture session',automation_identity='{\"identity_version\":1,\"client\":\"instagram-firefox-web\",\"browser_family\":\"firefox\",\"platform\":\"Windows\",\"browser_seed\":123,\"browser_version\":\"128\",\"user_agent\":\"fixture-agent\",\"http_impersonate\":\"firefox\",\"ja3\":\"fixture-ja3\",\"h2_fingerprint\":\"fixture-h2\",\"locale\":\"en-US\",\"timezone\":\"UTC\"}'::jsonb||jsonb_build_object('bot_id',id),proxy_url='http://127.0.0.1:1' WHERE id=ANY($1::varchar[])",[[bot,otherBot]]);
    if(kind==='cooldown') await pool.query("UPDATE bot_accounts SET cooldown_until=now()+interval '1 hour' WHERE id=$1",[bot]);
    if(kind==='expired_session') await pool.query("UPDATE bot_accounts SET status='session_expired' WHERE id=$1",[bot]);
    if(kind==='missing_session') await pool.query("UPDATE bot_accounts SET session_data=NULL WHERE id=$1",[bot]);
    if(kind==='wrong_identity') await pool.query("UPDATE bot_accounts SET automation_identity='{}'::jsonb WHERE id=$1",[bot]);
    if(kind==='missing_proxy') await pool.query("UPDATE bot_accounts SET proxy_url=NULL WHERE id=$1",[bot]);
    if(kind==='mobile') await pool.query("UPDATE bot_accounts SET transport='mobile' WHERE id=$1",[bot]);
    if(kind==='auth_failure') await pool.query("UPDATE bot_accounts SET last_login_error='checkpoint_required' WHERE id=$1",[bot]);
    if(kind==='reserve'||kind==='retired') await pool.query("UPDATE bot_accounts SET tier=$2 WHERE id=$1",[bot,kind]);
    expect(await findGrantedBotId(tracks[0])).toBe(kind==='healthy'?bot:otherBot);
    // A healthy but still-unapproved backup must never replace this grant.
    await pool.query("UPDATE bot_follow_requests SET status='queued' WHERE id=$1",[otherRequest]);
    expect(await findGrantedBotId(tracks[0])).toBe(kind==='healthy'?bot:null);
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1",[users[0]]);
    expect(await findGrantedBotId(tracks[0])).toBeNull();
  });
  it.each(["queued", "pending", "accepted"] as const)("preserves a surviving %s request when no rotation bot is available after three failures",async status=>{
    await addExhaustedHistory();
    await pool.query("UPDATE bot_follow_requests SET status=$2 WHERE id=$1",[requests[0],status]);
    expect(await manager.rotateBotForTrackedAccount(tracks[0])).toBeNull();
    expect(await access()).toBe('pending_access');
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1",[requests[0]])).rows[0].status).toBe(status);
    expect(await deniedNotifications()).toBe(0);
    expect(await state()).toEqual({status:'in_use',current_follows:2});
  });
  it("never revokes already granted access when no rotation bot is available",async()=>{
    await addExhaustedHistory();
    await pool.query("UPDATE bot_follow_requests SET status='failed' WHERE id=$1",[requests[0]]);
    await pool.query("UPDATE tracked_accounts SET access_status='has_access' WHERE id=$1",[tracks[0]]);
    expect(await manager.rotateBotForTrackedAccount(tracks[0])).toBeNull();
    expect(await access()).toBe('has_access');
    expect(await deniedNotifications()).toBe(0);
  });
  it.each(["public", "inactive", "canceled", "expired", "trial_expired", "unlinked"])("does not deny %s tracking after exhausted rotation",async kind=>{
    await addExhaustedHistory();
    await pool.query("UPDATE bot_follow_requests SET status='failed' WHERE id=$1",[requests[0]]);
    if(kind==='public') await pool.query("UPDATE tracked_accounts SET is_private=false WHERE id=$1",[tracks[0]]);
    if(kind==='inactive') await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1",[tracks[0]]);
    if(kind==='canceled') await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1",[users[0]]);
    if(kind==='expired') await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 second' WHERE user_id=$1",[users[0]]);
    if(kind==='trial_expired') await pool.query("UPDATE subscriptions SET status='trialing',trial_ends_at=now()-interval '1 second' WHERE user_id=$1",[users[0]]);
    if(kind==='unlinked') await pool.query("UPDATE subscriptions SET stripe_subscription_id=NULL WHERE user_id=$1",[users[0]]);
    expect(await manager.rotateBotForTrackedAccount(tracks[0])).toBeNull();
    expect(await access()).toBe('pending_access');
    expect(await deniedNotifications()).toBe(0);
  });
  it("denies exhausted eligible trial access once under concurrent no-bot rotations",async()=>{
    await addExhaustedHistory();
    await pool.query("UPDATE bot_follow_requests SET status='failed' WHERE id=$1",[requests[0]]);
    await pool.query("UPDATE subscriptions SET status='trialing' WHERE user_id=$1",[users[0]]);
    expect(await Promise.all(Array.from({length:4},()=>manager.rotateBotForTrackedAccount(tracks[0])))).toEqual([null,null,null,null]);
    expect(await access()).toBe('access_denied');
    expect(await deniedNotifications()).toBe(1);
  });
  it("preserves acceptance racing an exhausted no-bot rotation",async()=>{
    await addExhaustedHistory();
    await Promise.all([manager.rotateBotForTrackedAccount(tracks[0]),manager.markFollowRequestAccepted(requests[0],users[0])]);
    expect(await access()).toBe('has_access');
    expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1",[requests[0]])).rows[0].status).toBe('accepted');
    expect(await deniedNotifications()).toBe(0);
  });
  it("releases only one bot slot under concurrent failure and cancellation",async()=>{
    await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1",[tracks[0]]);
    await Promise.all([manager.cancelIneligibleFollowRequests(),manager.cancelIneligibleFollowRequests(),...Array.from({length:8},()=>manager.markFollowRequestFailed(requests[0],'fixture cancel'))]);
    expect(await state()).toEqual({status:'available',current_follows:1});
  });
  it("does not grant private access after expiry, while a Stripe trial can receive acceptance",async()=>{
    await pool.query("UPDATE subscriptions SET status='trialing',trial_ends_at=now()+interval '1 day' WHERE user_id=$1",[users[1]]);
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1",[users[0]]);
    await manager.markFollowRequestAccepted(requests[0],users[0]);
    await manager.markFollowRequestAccepted(requests[1],users[1]);
    const rows=(await pool.query("SELECT id,access_status FROM tracked_accounts WHERE id=ANY($1::varchar[])",[tracks])).rows;
    expect(rows.find(x=>x.id===tracks[0]).access_status).toBe('pending_access');
    expect(rows.find(x=>x.id===tracks[1]).access_status).toBe('has_access');
  });
  it("expires only once and releases one slot when expiry races cancellation",async()=>{
    const results=await Promise.all(Array.from({length:8},()=>manager.markFollowRequestExpired(requests[0])));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await state()).toEqual({status:'available',current_follows:1});
    await Promise.all([manager.markFollowRequestExpired(requests[1]),manager.markFollowRequestFailed(requests[1],'fixture cancellation')]);
    expect(await state()).toEqual({status:'available',current_follows:0});
    const pending=(await pool.query("SELECT count(*)::int AS n FROM bot_follow_requests WHERE id=ANY($1::varchar[]) AND status='pending'",[requests])).rows[0].n;
    expect(pending).toBe(0);
  });
});
