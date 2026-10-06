import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (target.pathname !== "/cheaterfinder_backend_fix_test_20260907" || !["localhost", "127.0.0.1"].includes(target.hostname) || !target.port || target.port === "5432") throw Error("Private scratch database required");
  process.env.DATABASE_URL = url;
}
const userId = randomUUID(), accountId = randomUUID(), jobId = randomUUID();
const fixtureUsers = [userId], fixtureBots: string[] = [], outcomeIds: string[] = [];

(url ? describe : describe.skip)("collection health evidence (Postgres)", () => {
  let pool: typeof import("../../db.js").pool;
  let readHealth: typeof import("../collection-health.js").readCollectionHealth;
  beforeAll(async () => {
    ({ pool } = await import("../../db.js"));
    ({ readCollectionHealth: readHealth } = await import("../collection-health.js"));
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Collection health test')", [userId, userId + "@example.invalid"]);
    await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end) VALUES($1,$2,$3,'active','standard',now()+interval '1 day')",[userId,'cus_'+userId,'sub_'+userId]);
    await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username) VALUES($1,$2,$3)", [accountId, userId, "health_" + accountId]);
  });
  afterAll(async () => { if (pool) { await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [fixtureUsers]); await pool.query("DELETE FROM bot_accounts WHERE id=ANY($1::varchar[])",[fixtureBots]); await pool.query("DELETE FROM scrape_outcome_log WHERE id=ANY($1::bigint[])",[outcomeIds]); await pool.end(); } });
  const target = async (options: {private?: boolean; access?: string; baseline?: boolean; paid?: boolean; active?: boolean; identity?: string; ageDays?: number} = {}) => {
    const owner=randomUUID(),id=randomUUID(),identity=options.identity??BigInt('0x'+randomUUID().replaceAll('-','').slice(0,15)).toString();fixtureUsers.push(owner);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Health fixture')",[owner,owner+'@example.invalid']);
    if(options.paid!==false)await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end) VALUES($1,$2,$3,'active','standard',now()+interval '1 day')",[owner,'cus_'+owner,'sub_'+owner]);
    await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,is_private,access_status,is_active,tracking_started) VALUES($1,$2,$3,$4,$5,$6,$7,now()-$8*interval '1 day')",[id,owner,'health_'+id,options.baseline===false?null:identity,options.private??false,options.access??(options.private?'pending_access':'public'),options.active??true,options.ageDays??1]);
    if(options.baseline!==false)await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,following_count) VALUES($1,$2,20,10)",[id,'health_'+id]);
    return {id,owner,identity};
  };
  const complete = async (id:string, hours=1) => {
    for(const dimension of ['follower','following'])await pool.query("INSERT INTO roster_sync_state(tracked_account_id,dimension,last_complete_read_at) VALUES($1,$2,now()-$3*interval '1 hour') ON CONFLICT(tracked_account_id,dimension) DO UPDATE SET last_complete_read_at=excluded.last_complete_read_at",[id,dimension,hours]);
  };
  const reader = async (id:string,cooldown=false) => {
    const bot=randomUUID();fixtureBots.push(bot);
    await pool.query("INSERT INTO bot_accounts(id,ig_username,transport,status,tier,session_data,automation_identity,proxy_url,cooldown_until) VALUES($1,$2,'web','in_use','worker','fixture session','{\"identity_version\":1,\"client\":\"instagram-firefox-web\",\"browser_family\":\"firefox\",\"platform\":\"Windows\",\"browser_seed\":123,\"browser_version\":\"128\",\"user_agent\":\"fixture-agent\",\"http_impersonate\":\"firefox\",\"ja3\":\"fixture-ja3\",\"h2_fingerprint\":\"fixture-h2\",\"locale\":\"en-US\",\"timezone\":\"UTC\"}'::jsonb||jsonb_build_object('bot_id',$1::varchar),'http://fixed.example.invalid:15003',CASE WHEN $3 THEN now()+interval '2 hours' ELSE NULL END)",[bot,'health_'+bot,cooldown]);
    await pool.query("INSERT INTO bot_follow_requests(bot_account_id,tracked_account_id,status,resolved_at) VALUES($1,$2,'accepted',now())",[bot,id]);return bot;
  };
  it("returns explicit per-feature evidence rather than treating no data as success", async () => {
    const health = await readHealth();
    expect(health.features.map(f => f.feature).sort()).toEqual(["comments", "highlights", "likers", "posts", "profile", "stories"]);
    for (const feature of health.features) {
      expect(feature.successes).toBeGreaterThanOrEqual(0);
      if (feature.successes === 0) expect(feature.lastSuccessAt).toBeNull();
    }
    expect(health.profiles.some(p => p.username === "health_" + accountId)).toBe(true);
  });
  it("keeps partial collection degraded through later freshness skips, then recovers after an actual complete cycle", async () => {
    const before = await readHealth();
    await pool.query("INSERT INTO collection_jobs(id,tracked_account_id,job_type,status,started_at,completed_at,error) VALUES($1,$2,'profile','failed',now()-interval '20 minutes',now()-interval '19 minutes','partial collection: posts: HTTP 500')", [jobId, accountId]);
    await pool.query("INSERT INTO collection_jobs(id,tracked_account_id,job_type,status,started_at,completed_at,error) VALUES($1,$2,'profile','completed',now()-interval '2 minutes',now()-interval '1 minute','skipped: snapshot still fresh')", [randomUUID(), accountId]);
    const partial = await readHealth();
    expect(partial.verification).toBe("degraded");
    expect(partial.incompleteProfiles).toBeGreaterThanOrEqual(before.incompleteProfiles + 1);
    await pool.query("INSERT INTO collection_jobs(id,tracked_account_id,job_type,status,started_at,completed_at) VALUES($1,$2,'profile','completed',now(),now())", [randomUUID(), accountId]);
    const recovered = await readHealth();
    expect(recovered.incompleteProfiles).toBe(partial.incompleteProfiles - 1);
  });
  it("never verifies unavailable collection merely because all global feature probes succeeded",async()=>{
    await pool.query("UPDATE tracked_accounts SET ig_user_id='1234567890' WHERE id=$1",[accountId]);
    await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username) VALUES($1,$2)",[accountId,'health_'+accountId]);await complete(accountId);
    for(const feature of ['profile','posts','stories','highlights','likers','comments'])outcomeIds.push((await pool.query("INSERT INTO scrape_outcome_log(endpoint,outcome) VALUES($1,'success') RETURNING id",[feature])).rows[0].id);
    expect((await readHealth()).verification).toBe('verified');
    await complete(accountId,49);const stale=await readHealth();expect(stale.features.every(f=>f.successes>0)).toBe(true);expect(stale.incompleteProfiles).toBe(0);expect(stale.verification).toBe('degraded');
    await complete(accountId);expect((await readHealth()).verification).toBe('verified');
    for(const options of [{private:true},{private:true,access:'access_denied'},{baseline:false},{private:true,access:'has_access'}]){
      const blocked=await target(options);const health=await readHealth();expect(health.incompleteProfiles).toBe(0);expect(health.features.every(f=>f.successes>0)).toBe(true);expect(health.verification).toBe('degraded');
      await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1",[blocked.id]);expect((await readHealth()).verification).toBe('verified');
    }
  });
  it("separates pending approval and profile bootstrap from eligible freshness without hiding blocked collection",async()=>{
    const before=await readHealth();
    const pendingA=await target({private:true,baseline:false}),pendingB=await target({private:true,baseline:false}),pendingCached=await target({private:true});
    await complete(pendingCached.id,72);
    const bootstrap=await target({baseline:false}),approved=await target({private:true,access:'has_access'});await reader(approved.id,true);await complete(approved.id);
    await pool.query("INSERT INTO collection_jobs(tracked_account_id,job_type,status,started_at,error) VALUES($1,'profile','failed',now(),'partial collection: reader cooling')",[approved.id]);
    const health=await readHealth();expect(health.activeProfiles-before.activeProfiles).toBe(5);expect(health.rosterEligibleProfiles-before.rosterEligibleProfiles).toBe(1);
    expect(health.awaitingApprovalProfiles-before.awaitingApprovalProfiles).toBe(3);expect(health.missingProfileBaselines-before.missingProfileBaselines).toBe(1);expect(health.blockedPrivateReaders-before.blockedPrivateReaders).toBe(1);
    expect(health.staleFollowerRosters).toBe(before.staleFollowerRosters);expect(health.staleFollowingRosters).toBe(before.staleFollowingRosters);expect(health.incompleteProfiles-before.incompleteProfiles).toBe(1);expect(health.verification).toBe('degraded');
    for(const pending of [pendingA,pendingB,pendingCached])expect(health.profiles.find(p=>p.trackingId===pending.id)).toMatchObject({state:'awaiting_approval',rosterEligible:false});
    expect(health.profiles.find(p=>p.trackingId===pendingCached.id)?.followersCompleteAt).not.toBeNull();
    expect(health.profiles.find(p=>p.trackingId===bootstrap.id)?.state).toBe('awaiting_profile');expect(health.profiles.find(p=>p.trackingId===approved.id)?.state).toBe('reader_unavailable');
  });
  it("retains stale counts and provider evidence while an approved reader is cooling",async()=>{
    const before=await readHealth(),account=await target({private:true,access:'has_access'}),bot=await reader(account.id,true);await complete(account.id,49);
    await pool.query("UPDATE roster_sync_state SET failure_kind='rate_limited',next_retry_at=now()+interval '2 hours' WHERE tracked_account_id=$1 AND dimension='follower'",[account.id]);
    const health=await readHealth();expect(health.staleFollowerRosters-before.staleFollowerRosters).toBe(1);expect(health.staleFollowingRosters-before.staleFollowingRosters).toBe(1);expect(health.providerBlockedProfiles-before.providerBlockedProfiles).toBe(1);
    expect(health.profiles.find(p=>p.trackingId===account.id)).toMatchObject({state:'reader_unavailable',rosterEligible:true,followersFailureKind:'rate_limited'});
    expect(health.profiles.find(p=>p.trackingId===account.id)?.followersRetryAt).not.toBeNull();
    const {findGrantedBotId}=await import('../private-account-access.js');expect(await findGrantedBotId(account.id)).toBeNull();
    await pool.query("UPDATE bot_accounts SET cooldown_until=now()-interval '1 second' WHERE id=$1",[bot]);expect(await findGrantedBotId(account.id)).toBe(bot);
    const recovered=await readHealth();expect(recovered.blockedPrivateReaders).toBe(health.blockedPrivateReaders-1);expect(recovered.staleFollowerRosters).toBe(health.staleFollowerRosters);expect(recovered.profiles.find(p=>p.trackingId===account.id)?.state).toBe('provider_blocked');
  });
  it("elects only the oldest active paid public twin and never collapses private tracking into it",async()=>{
    const before=await readHealth(),identity=BigInt('0x'+randomUUID().replaceAll('-','').slice(0,15)).toString();
    const unpaid=await target({paid:false,identity,ageDays:8}),inactive=await target({active:false,identity,ageDays:7}),privateRow=await target({private:true,identity,ageDays:6});
    const canonical=await target({identity,ageDays:5}),newer=await target({identity,ageDays:4});await complete(canonical.id);
    const health=await readHealth();expect(health.activeProfiles-before.activeProfiles).toBe(2);expect(health.rosterEligibleProfiles-before.rosterEligibleProfiles).toBe(1);expect(health.staleFollowerRosters).toBe(before.staleFollowerRosters);
    for(const hidden of [unpaid,inactive,newer])expect(health.profiles.some(p=>p.trackingId===hidden.id)).toBe(false);
    expect(health.profiles.some(p=>p.trackingId===canonical.id)).toBe(true);expect(health.profiles.some(p=>p.trackingId===privateRow.id)).toBe(true);expect(health.excludedSubscriptionTrackings-before.excludedSubscriptionTrackings).toBe(1);
  });
  it("keeps each customer's approved private roster independent even for the same identity",async()=>{
    const before=await readHealth(),a=await target({private:true,access:'has_access'}),b=await target({private:true,access:'has_access',identity:a.identity});
    await reader(a.id);await reader(b.id);await complete(a.id);await complete(b.id,49);
    const health=await readHealth();expect(health.activeProfiles-before.activeProfiles).toBe(2);expect(health.rosterEligibleProfiles-before.rosterEligibleProfiles).toBe(2);expect(health.staleFollowerRosters-before.staleFollowerRosters).toBe(1);
    expect(health.profiles.filter(p=>[a.id,b.id].includes(p.trackingId))).toHaveLength(2);
  });
  it("excludes expired active/trial and unlinked subscriptions while retaining a current trial",async()=>{
    const before=await readHealth(),expired=await target(),trialExpired=await target(),unlinked=await target(),currentTrial=await target();
    await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 hour' WHERE user_id=$1",[expired.owner]);
    await pool.query("UPDATE subscriptions SET status='trialing',trial_ends_at=now()-interval '1 hour' WHERE user_id=$1",[trialExpired.owner]);
    await pool.query("UPDATE subscriptions SET stripe_subscription_id=NULL WHERE user_id=$1",[unlinked.owner]);
    await pool.query("UPDATE subscriptions SET status='trialing',trial_ends_at=now()+interval '1 hour' WHERE user_id=$1",[currentTrial.owner]);
    const health=await readHealth();expect(health.activeProfiles-before.activeProfiles).toBe(1);expect(health.excludedSubscriptionTrackings-before.excludedSubscriptionTrackings).toBe(3);
    for(const denied of [expired,trialExpired,unlinked])expect(health.profiles.some(p=>p.trackingId===denied.id)).toBe(false);
    expect(health.profiles.some(p=>p.trackingId===currentTrial.id)).toBe(true);
  });
  it("distinguishes denied access and missing accepted readers without treating either as current data",async()=>{
    const before=await readHealth(),denied=await target({private:true,access:'access_denied'}),unapproved=await target({private:true,access:'has_access'});
    const health=await readHealth();expect(health.accessDeniedProfiles-before.accessDeniedProfiles).toBe(1);expect(health.blockedPrivateReaders-before.blockedPrivateReaders).toBe(1);expect(health.rosterEligibleProfiles).toBe(before.rosterEligibleProfiles);expect(health.staleFollowerRosters).toBe(before.staleFollowerRosters);
    expect(health.profiles.find(p=>p.trackingId===denied.id)?.state).toBe('access_denied');expect(health.profiles.find(p=>p.trackingId===unapproved.id)?.state).toBe('reader_unavailable');
  });
  it("requires a numeric profile identity and actual profile snapshot before counting roster freshness",async()=>{
    const before=await readHealth(),badId=await target({identity:'not-a-numeric-id'}),missingSnapshot=await target();
    await pool.query("DELETE FROM profile_snapshots WHERE tracked_account_id=$1",[missingSnapshot.id]);
    const health=await readHealth();expect(health.missingProfileBaselines-before.missingProfileBaselines).toBe(2);expect(health.rosterEligibleProfiles).toBe(before.rosterEligibleProfiles);expect(health.staleFollowerRosters).toBe(before.staleFollowerRosters);
    for(const account of [badId,missingSnapshot])expect(health.profiles.find(p=>p.trackingId===account.id)).toMatchObject({state:'awaiting_profile',rosterEligible:false});
  });
  it("keeps bounded background source limits visible with their saved progress",async()=>{
    const before=await readHealth(),account=await target();await complete(account.id,49);
    await pool.query("INSERT INTO roster_background_sync(tracked_account_id,dimension,source,status,last_started_at) VALUES($1,'follower','auto','source_limited',now())",[account.id]);
    const health=await readHealth();expect(health.providerBlockedProfiles-before.providerBlockedProfiles).toBe(1);expect(health.staleFollowerRosters-before.staleFollowerRosters).toBe(1);
    expect(health.profiles.find(p=>p.trackingId===account.id)).toMatchObject({state:'provider_blocked',backgroundFollowers:{enabled:true,status:'source_limited'}});
  });
  it.each(['identity','static_proxy','dynamic_proxy'])("does not label an approved reader healthy with invalid %s metadata",async kind=>{
    const account=await target({private:true,access:'has_access'}),bot=await reader(account.id);await complete(account.id);
    const before=await readHealth();expect(before.profiles.find(p=>p.trackingId===account.id)?.state).toBe('eligible');
    if(kind==='identity')await pool.query("UPDATE bot_accounts SET automation_identity=jsonb_build_object('bot_id',id) WHERE id=$1",[bot]);
    if(kind==='static_proxy')await pool.query("UPDATE bot_accounts SET proxy_url='not a proxy' WHERE id=$1",[bot]);
    if(kind==='dynamic_proxy')await pool.query("UPDATE bot_accounts SET proxy_url=NULL,proxy_endpoint='not a proxy',proxy_expires_at=now()+interval '1 day' WHERE id=$1",[bot]);
    const health=await readHealth();expect(health.blockedPrivateReaders-before.blockedPrivateReaders).toBe(1);expect(health.profiles.find(p=>p.trackingId===account.id)?.state).toBe('reader_unavailable');expect(health.verification).toBe('degraded');
  });
});
