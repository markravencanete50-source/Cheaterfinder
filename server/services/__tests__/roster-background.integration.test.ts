// Real Postgres, mocked Instagram boundary. Only the designated scratch DB.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  if (new URL(url).pathname !== "/cheaterfinder_backend_fix_test_20260907") throw new Error("Scratch database required");
  process.env.DATABASE_URL = url;
}
const { followers, following } = vi.hoisted(() => ({followers:vi.fn(),following:vi.fn()}));
vi.mock("../public-data-service.js", () => ({getAllUserFollowers:followers,getAllUserFollowing:following}));
vi.mock("../realtime-events.js", () => ({emitRealtime:vi.fn()}));
vi.mock("../media-cache-jobs.js", () => ({enqueueMediaCacheUrls:vi.fn()}));
// Network boundary is mocked; omit only inter-lane spacing, never DB work.
vi.mock("node:timers/promises",async importOriginal=>({...await importOriginal<typeof import("node:timers/promises")>(),setTimeout:vi.fn(async()=>{})}));
const userId=randomUUID(), id=randomUUID(), twin=randomUUID(), reader=randomUUID();
const username="bg_"+id.replaceAll("-","").slice(0,20), epochOld=new Date("2020-01-01T00:00:00Z");
const identity={identity_version:1,client:"instagram-firefox-web",browser_family:"firefox",platform:"Windows",
  browser_seed:123,bot_id:reader,browser_version:"140",user_agent:"fixture",http_impersonate:"firefox",
  ja3:"fixture",h2_fingerprint:"fixture",locale:"en-US",timezone:"UTC"};
const members=(n:number,prefix="member",offset=0)=>Array.from({length:n},(_,i)=>({username:`${prefix}_${offset+i}`,igUserId:`${offset+i}`,fullName:`Member ${offset+i}`,profilePicUrl:"",isPrivate:false,isVerified:false}));
const capture=(data:ReturnType<typeof members>,complete=false,cursor:string|null="gql:C1",startedFromTop=true)=>({
  ok:true,source:"bot",data,complete,nextCursor:cursor,startedFromTop,viewerBotId:reader,pagesFetched:1,stopReason:complete?"exhausted":"page_cap",
});

(url?describe:describe.skip)("durable background roster batches (real Postgres)",()=>{
  let db:typeof import("../../db.js").db,pool:typeof import("../../db.js").pool;
  let sync:typeof import("../roster-background-sync.js"),store:typeof import("../roster-store.js"),persist:typeof import("../public-data-persistence.js"),leases:typeof import("../operation-lease.js");
  beforeAll(async()=>{
    ({db,pool}=await import("../../db.js")); sync=await import("../roster-background-sync.js");
    store=await import("../roster-store.js");persist=await import("../public-data-persistence.js");leases=await import("../operation-lease.js");
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Background roster fixture')",[userId,userId+"@example.invalid"]);
    await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end) VALUES($1,$2,$3,'active','pro',now()+interval '30 days') ON CONFLICT (user_id) DO UPDATE SET current_period_end=EXCLUDED.current_period_end",[userId,'cus_roster_'+userId,'sub_roster_'+userId]);
    await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,tracking_started) VALUES($1,$3,$4,$5,'2020-01-01'),($2,$3,$4,$5,'2020-01-02')",[id,twin,userId,username,id]);
    await pool.query("INSERT INTO bot_accounts(id,ig_username,tier,session_data) VALUES($1,$2,'worker','fixture-saved-session')",[reader,'bg_reader_'+reader]);
  });
  beforeEach(async()=>{
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS",`${username}:follower:graphql`);
    followers.mockReset();following.mockReset();
    for(const table of ["roster_background_sync","roster_members","roster_sync_state","profile_snapshots","follower_events","follower_unfollow_events"])
      await pool.query(`DELETE FROM ${table} WHERE tracked_account_id=ANY($1::varchar[])`,[[id,twin]]);
    await pool.query("UPDATE tracked_accounts SET is_active=true,is_private=false WHERE id=ANY($1::varchar[])",[[id,twin]]);
    await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,following_count,snapshot_at) VALUES($1,$2,10,0,now())",[id,username]);
    await pool.query("INSERT INTO bot_accounts(id,ig_username,tier,session_data) VALUES($1,$2,'worker','fixture-saved-session') ON CONFLICT (id) DO UPDATE SET cooldown_until=NULL,status='available',tier='worker',role='scraper',session_data='fixture-saved-session'",[reader,'bg_reader_'+reader]);
    await pool.query("UPDATE bot_accounts SET automation_identity=$2,proxy_url='http://fixture-proxy.invalid:10000',proxy_endpoint=NULL,proxy_expires_at=NULL,last_login_error=NULL,transport='web',last_used_at=now() WHERE id=$1",[reader,JSON.stringify(identity)]);
  });
  afterAll(async()=>{
    vi.unstubAllEnvs();
    if(pool){await pool.query("DELETE FROM backend_operation_leases WHERE key=$1",[`roster-background:${id}:follower`]);await pool.query("DELETE FROM users WHERE id=$1",[userId]);await pool.query("DELETE FROM bot_accounts WHERE id=$1",[reader]);await pool.end();}
  });
  const due=()=>pool.query("UPDATE roster_background_sync SET next_run_at=now()-interval '1 second' WHERE tracked_account_id=$1",[id]);
  const roster=async()=>Number((await pool.query("SELECT count(*)::int n FROM roster_members WHERE tracked_account_id=$1",[id])).rows[0].n);
  const events=async()=>Number((await pool.query("SELECT count(*)::int n FROM follower_events WHERE tracked_account_id=$1",[id])).rows[0].n);

  it.each(["no available bot in the pool", "circuit breaker OPEN"])("a failed first batch (%s) defers both clocks and releases the next due target",async error=>{
    const otherId=randomUUID(),otherUsername="bg_other_"+otherId.replaceAll("-","").slice(0,12);
    await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,tracking_started) VALUES($1,$2,$3,$4,'2020-01-01')",[otherId,userId,otherUsername,otherId]);
    try {
      await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,following_count,snapshot_at) VALUES($1,$2,10,0,now())",[otherId,otherUsername]);
      vi.stubEnv("ROSTER_BACKGROUND_TARGETS",`${username}:follower:graphql,${otherUsername}:follower:graphql`);
      await sync.reconcileBackgroundRosters();
      await pool.query("UPDATE roster_background_sync SET next_run_at=now()-interval '2 minutes',next_head_run_at=now()-interval '2 minutes' WHERE tracked_account_id=$1",[id]);
      await pool.query("UPDATE roster_background_sync SET next_run_at=now()-interval '1 minute',next_head_run_at=now()-interval '1 minute' WHERE tracked_account_id=$1",[otherId]);
      followers.mockResolvedValueOnce({ok:false,source:"bot",error})
        .mockResolvedValueOnce(capture(members(3)));
      const startedAt=Date.now();
      expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"read-or-persistence",username});
      const failed=await sync.readBackgroundRosterProgress(id,"follower");
      expect(failed).toMatchObject({status:"cooldown",pages:0,lastProgressAt:null,lastHeadReadAt:null,baselineCompleteAt:null});
      expect(+new Date(failed!.nextHeadRunAt)).toBe(+new Date(failed!.nextRunAt));
      expect(+new Date(failed!.nextRunAt)).toBeGreaterThanOrEqual(startedAt+15*60_000);
      expect(+new Date(failed!.nextRunAt)).toBeLessThanOrEqual(Date.now()+15*60_000);
      const query=new PgDialect().sqlToQuery(sync.dueBackgroundRosterQuery());
      expect((await pool.query(query.sql,query.params)).rows[0].id).toBe(otherId);
      expect(await sync.runBackgroundRosterBatch()).toMatchObject({username:otherUsername,status:"syncing",membersObserved:3});
      expect(followers).toHaveBeenCalledTimes(2);
      expect(followers.mock.calls[1][0]).toBe(otherUsername);
      const progressed=await sync.readBackgroundRosterProgress(otherId,"follower");
      expect(progressed).toMatchObject({pages:1,seenCount:3,headStatus:"checked",lastHeadCount:3});
      expect(progressed!.lastProgressAt).not.toBeNull();
      expect(+new Date(progressed!.nextHeadRunAt)).toBeGreaterThan(Date.now());
      expect(await store.loadRosterCursor(otherId,"follower")).toBe("gql:C1");
      expect(await store.loadRosterViewer(otherId,"follower")).toBe(reader);
      expect(await roster()).toBe(0);
    } finally {
      await pool.query("DELETE FROM tracked_accounts WHERE id=$1",[otherId]);
    }
  });

  it.each(["banned","session_expired","disabled","missing-session","missing-reader"])("restarts a %s viewer's epoch without handing its cursor to another reader",async state=>{
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS",`${username}:follower:auto`);
    followers.mockResolvedValueOnce(capture(members(8),false,"REST-CURSOR"));await sync.runBackgroundRosterBatch();
    await pool.query("UPDATE roster_members SET last_seen_at=now()-interval '1 hour' WHERE tracked_account_id=$1",[id]);
    if(state==="missing-reader")await pool.query("DELETE FROM bot_accounts WHERE id=$1",[reader]);
    else if(state==="missing-session")await pool.query("UPDATE bot_accounts SET session_data=NULL WHERE id=$1",[reader]);
    else await pool.query("UPDATE bot_accounts SET status=$2,cooldown_until=now()+interval '12 hours' WHERE id=$1",[reader,state]);
    // A due head discovers a terminal reader even if its generic full retry is later.
    await pool.query("UPDATE roster_background_sync SET next_run_at=now()+interval '15 minutes',next_head_run_at=now() WHERE tracked_account_id=$1",[id]);
    const replacement=randomUUID();
    followers.mockResolvedValueOnce({...capture(members(2,"replacement",100),true,null),viewerBotId:replacement});
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({status:"source_limited",resumed:false});
    expect(followers).toHaveBeenCalledTimes(2);
    expect(followers.mock.calls[1][2]).toMatchObject({startCursor:null,viewerBotId:null,rosterSource:"auto",pinViewer:true,savedSessionOnly:true,maxPages:5});
    expect(await sync.readBackgroundRosterProgress(id,"follower")).toMatchObject({pages:1,seenCount:2,baselineCompleteAt:null});
    expect(await roster()).toBe(10);expect(await events()).toBe(0);
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toBeNull();
    expect((await pool.query("SELECT count(*)::int n FROM follower_unfollow_events WHERE tracked_account_id=$1",[id])).rows[0].n).toBe(0);
  });

  it("a failed replacement leaves the old viewer, cursor, epoch and observations available for later recovery",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();
    const before=await sync.readBackgroundRosterProgress(id,"follower");
    await pool.query("UPDATE bot_accounts SET status='session_expired' WHERE id=$1",[reader]);
    await pool.query("UPDATE roster_background_sync SET next_head_run_at=now() WHERE tracked_account_id=$1",[id]);
    await due();followers.mockResolvedValueOnce({ok:false,source:"bot",error:"no eligible replacement reader"});
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"read-or-persistence"});
    expect(followers.mock.calls[1][2]).toMatchObject({startCursor:null,viewerBotId:null,rosterSource:"graphql",savedSessionOnly:true});
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
    expect(await store.loadRosterViewer(id,"follower")).toBe(reader);
    expect(await sync.readBackgroundRosterProgress(id,"follower")).toMatchObject({pages:1,seenCount:3,epochStartedAt:before!.epochStartedAt,lastProgressAt:before!.lastProgressAt});
    expect(await roster()).toBe(3);expect(await events()).toBe(0);
    expect(await sync.runBackgroundRosterBatch()).toEqual({skipped:"nothing-due"});
    expect(followers).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing identity", "automation_identity=NULL"],
    ["malformed identity", "automation_identity='{}'::jsonb"],
    ["another reader's identity", "automation_identity=jsonb_set(automation_identity,'{bot_id}','\"another-reader\"')"],
    ["missing proxy", "proxy_url=NULL,proxy_endpoint=NULL"],
    ["invalid proxy", "proxy_url='not/a/proxy'"],
    ["rotating proxy", "proxy_url='http://gateway.dataimpulse.com:823'"],
    ["expired assigned proxy", "proxy_url=NULL,proxy_endpoint='fixture-proxy.invalid:10000:user:pass',proxy_expires_at=now()-interval '1 minute'"],
    ["invalid assigned proxy", "proxy_url=NULL,proxy_endpoint='invalid',proxy_expires_at=now()+interval '1 year'"],
    ["terminal login verdict", "last_login_error='checkpoint_required'"],
    ["non-scraper role", "role='feed_watcher'"],
    ["unpromoted tier", "tier='reserve'"],
    ["non-public status", "status='in_use'"],
    ["mobile reader for GraphQL", "transport='mobile',automation_identity=NULL"],
  ])("restarts after %s without transferring a saved cursor",async(_label,change)=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();
    await pool.query(`UPDATE bot_accounts SET ${change} WHERE id=$1`,[reader]);
    const replacement=randomUUID();
    followers.mockResolvedValueOnce({...capture(members(2,"replacement",100),false,"gql:NEW"),viewerBotId:replacement});
    await due();
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({status:"syncing",resumed:false});
    expect(followers.mock.calls[1][2]).toMatchObject({viewerBotId:null,startCursor:null,rosterSource:"graphql",savedSessionOnly:true});
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:NEW");
    expect(await store.loadRosterViewer(id,"follower")).toBe(replacement);
    expect(await roster()).toBe(5);expect(await events()).toBe(0);
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toBeNull();
  });

  it.each(["daily-budget", "operation-busy"])("retains the exact viewer and cursor for a temporary %s rejection",async reason=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();
    const before=await sync.readBackgroundRosterProgress(id,"follower");
    const {buildLeaseCandidateQuery,maxEndpointDailyCap}=await import("../../ig-public-scraper.js");
    const leaseNow=new Date();
    const query=buildLeaseCandidateQuery(db,{label:"followers",now:leaseNow,viewer:{botId:reader,pin:true,rosterSource:"graphql",savedSessionOnly:true}}).toSQL();
    expect((await pool.query(query.sql,query.params)).rows.map(row=>row.id)).toEqual([reader]);
    try {
      if(reason==="daily-budget") await pool.query("INSERT INTO bot_daily_calls(bot_id,day,endpoint,count) VALUES($1,$2::date,'followers',$3) ON CONFLICT(bot_id,day,endpoint) DO UPDATE SET count=EXCLUDED.count",[reader,leaseNow.toISOString().slice(0,10),maxEndpointDailyCap("followers",leaseNow,"web")]);
      else await pool.query("INSERT INTO backend_operation_leases(key,token,expires_at) VALUES($1,'fixture-owner',now()+interval '2 minutes') ON CONFLICT(key) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at",[`bot:${reader}`]);
      expect((await pool.query(query.sql,query.params)).rows).toEqual([]);
      followers.mockResolvedValueOnce({ok:false,source:"bot",error:reason});await due();
      const startedAt=Date.now();
      expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"read-or-persistence"});
      expect(followers.mock.calls[1][2]).toMatchObject({viewerBotId:reader,startCursor:"gql:C1"});
      expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
      expect(await store.loadRosterViewer(id,"follower")).toBe(reader);
      const after=await sync.readBackgroundRosterProgress(id,"follower");
      expect(after).toMatchObject({pages:1,seenCount:3,epochStartedAt:before!.epochStartedAt,lastProgressAt:before!.lastProgressAt});
      expect(+new Date(after!.nextRunAt)).toBeGreaterThanOrEqual(startedAt+15*60_000);
      expect(await roster()).toBe(3);
    } finally {
      await pool.query("DELETE FROM bot_daily_calls WHERE bot_id=$1",[reader]);
      await pool.query("DELETE FROM backend_operation_leases WHERE key=$1",[`bot:${reader}`]);
    }
  });

  it.each(["REST-C1", "gql:C1"])("uses the effective source of auto cursor %s when checking a mobile reader",async cursor=>{
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS",`${username}:follower:auto`);
    followers.mockResolvedValueOnce(capture(members(3),false,cursor));await sync.runBackgroundRosterBatch();
    await pool.query("UPDATE bot_accounts SET transport='mobile',automation_identity=NULL WHERE id=$1",[reader]);
    const graphql=cursor.startsWith("gql:"),nextViewer=graphql?randomUUID():reader;
    followers.mockResolvedValueOnce({...capture(members(2,"new",10),false,"NEXT",graphql),viewerBotId:nextViewer});await due();
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({status:"syncing",resumed:!graphql});
    expect(followers.mock.calls[1][2]).toMatchObject({viewerBotId:graphql?null:reader,startCursor:graphql?null:cursor,rosterSource:graphql?"graphql":"auto"});
    expect(await store.loadRosterViewer(id,"follower")).toBe(nextViewer);
  });

  it("resumes the same viewer after a timed checkpoint cooldown and accepts its durable assigned proxy",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();
    await pool.query("UPDATE bot_accounts SET cooldown_until=now()-interval '1 minute',last_login_error='cooldown: checkpoint_required',proxy_url=NULL,proxy_endpoint='fixture-proxy.invalid:10000:user:pass',proxy_expires_at=now()+interval '1 year' WHERE id=$1",[reader]);
    followers.mockResolvedValueOnce(capture(members(3,"member",3),false,"gql:C2",false));await due();
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({status:"syncing",resumed:true});
    expect(followers.mock.calls[1][2]).toMatchObject({viewerBotId:reader,startCursor:"gql:C1"});
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C2");
    expect(await store.loadRosterViewer(id,"follower")).toBe(reader);
    expect(await sync.readBackgroundRosterProgress(id,"follower")).toMatchObject({pages:2,seenCount:6});
  });

  it("defers both due lanes before capture while their exact saved reader is cooling",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();
    const before=await sync.readBackgroundRosterProgress(id,"follower"),cooldown=new Date(Date.now()+7*60_000);
    await pool.query("UPDATE bot_accounts SET cooldown_until=$2 WHERE id=$1",[reader,cooldown]);
    await pool.query("UPDATE roster_background_sync SET next_run_at=now(),next_head_run_at=now() WHERE tracked_account_id=$1",[id]);
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"reader-cooldown"});
    expect(followers).toHaveBeenCalledTimes(1);
    const after=await sync.readBackgroundRosterProgress(id,"follower");
    expect(after).toMatchObject({pages:1,seenCount:3,lastProgressAt:before!.lastProgressAt,lastHeadReadAt:before!.lastHeadReadAt});
    expect(+new Date(after!.nextRunAt)).toBe(+cooldown+1_000);
    expect(+new Date(after!.nextHeadRunAt)).toBe(+cooldown+1_000);
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
    expect(await store.loadRosterViewer(id,"follower")).toBe(reader);
  });

  it("a partially read head that cools the viewer cannot immediately start the deep lane",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();
    await pool.query("UPDATE roster_background_sync SET next_run_at=now(),next_head_run_at=now() WHERE tracked_account_id=$1",[id]);
    const cooldown=new Date(Date.now()+20*60_000);
    followers.mockImplementationOnce(async()=>{
      await pool.query("UPDATE bot_accounts SET cooldown_until=$2 WHERE id=$1",[reader,cooldown]);
      return {...capture(members(2,"head",100),false,"gql:HEAD"),stopReason:"page_error",pagesFetched:2,pagesSucceeded:1};
    });
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"reader-cooldown",recentCheck:"partial"});
    expect(followers).toHaveBeenCalledTimes(2);
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
    expect(await store.loadRosterViewer(id,"follower")).toBe(reader);
    const after=await sync.readBackgroundRosterProgress(id,"follower");
    expect(after).toMatchObject({pages:1,headStatus:"partial",lastHeadCount:2});
    expect(+new Date(after!.nextRunAt)).toBe(+cooldown+1_000);
    expect(await roster()).toBe(5);expect(await events()).toBe(0);
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toBeNull();
  });

  it("resumes a failed deep page at the actual cooldown without losing its cursor or adding 15 minutes",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();await due();
    const cooldown=new Date(Date.now()+3*60_000);
    followers.mockImplementationOnce(async()=>{
      await pool.query("UPDATE bot_accounts SET cooldown_until=$2 WHERE id=$1",[reader,cooldown]);
      return {ok:false,source:"bot",error:"reader rate limited"};
    });
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"read-or-persistence"});
    const after=await sync.readBackgroundRosterProgress(id,"follower");
    expect(after).toMatchObject({pages:1,seenCount:3,baselineCompleteAt:null});
    expect(+new Date(after!.nextRunAt)).toBe(+cooldown+1_000);
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
    expect(await store.loadRosterViewer(id,"follower")).toBe(reader);
    expect(await events()).toBe(0);
  });

  it("commits successful deep pages before a later rate limit and protects both clocks",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();await due();
    const cooldown=new Date(Date.now()+20*60_000);
    followers.mockImplementationOnce(async()=>{
      await pool.query("UPDATE bot_accounts SET cooldown_until=$2 WHERE id=$1",[reader,cooldown]);
      return {...capture(members(2,"member",3),false,"gql:C2",false),stopReason:"page_error",pagesFetched:2,pagesSucceeded:1};
    });
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({status:"syncing",resumed:true});
    const after=await sync.readBackgroundRosterProgress(id,"follower");
    expect(after).toMatchObject({pages:2,seenCount:5,baselineCompleteAt:null});
    expect(+new Date(after!.nextRunAt)).toBe(+cooldown+1_000);
    expect(+new Date(after!.nextHeadRunAt)).toBe(+cooldown+1_000);
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C2");
    expect(await store.loadRosterViewer(id,"follower")).toBe(reader);
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toBeNull();
    expect((await pool.query("SELECT count(*)::int n FROM follower_unfollow_events WHERE tracked_account_id=$1",[id])).rows[0].n).toBe(0);
  });

  it("an already queued tick resumes an unfinished batch without a false nothing-due minute",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)))
      .mockResolvedValueOnce(capture(members(2,"member",3),false,"gql:C2",false));
    await sync.runBackgroundRosterBatch();
    // No manual next_run_at update: this reproduces BullMQ's catch-up tick.
    const result=await sync.runBackgroundRosterBatch();
    expect(result).toMatchObject({status:"syncing",pages:1,resumed:true});
    expect(followers).toHaveBeenCalledTimes(2);
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C2");
    expect((await sync.readBackgroundRosterProgress(id,"follower"))!.pages).toBe(2);
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toBeNull();
  });

  it("recent checks preserve the deep cursor/epoch and both lanes share five pages",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));
    await sync.runBackgroundRosterBatch();
    const before=await sync.readBackgroundRosterProgress(id,"follower");
    await pool.query("UPDATE roster_background_sync SET next_run_at=now(),next_head_run_at=now() WHERE tracked_account_id=$1",[id]);
    followers.mockResolvedValueOnce(capture(members(2,"head",100))).mockImplementationOnce(async()=>{
      expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
      expect(await store.loadRosterViewer(id,"follower")).toBe(reader);
      expect((await sync.readBackgroundRosterProgress(id,"follower"))!.epochStartedAt).toEqual(before!.epochStartedAt);
      expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toBeNull();
      return capture(members(2,"member",3),false,"gql:C2",false);
    });
    await sync.runBackgroundRosterBatch();
    expect(followers.mock.calls[1][2]).toMatchObject({startCursor:null,viewerBotId:reader,maxPages:2,maxMidwalkRetries:0});
    expect(followers.mock.calls[2][2]).toMatchObject({startCursor:"gql:C1",viewerBotId:reader,maxPages:3,maxMidwalkRetries:0});
    expect(await sync.readBackgroundRosterProgress(id,"follower")).toMatchObject({pages:2,lastHeadCount:2,headStatus:"checked",baselineCompleteAt:null});
    expect(await roster()).toBe(7);expect(await events()).toBe(0);
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C2");
    const view=await sync.readBackgroundRosterView(id,username,"follower");
    const {readCollectionHealth}=await import("../collection-health.js");
    const admin=(await readCollectionHealth()).profiles.find(p=>p.username===username)!.backgroundFollowers!;
    expect(admin.lastHeadCount).toBe(view!.lastHeadCount);
    expect(admin.headStatus).toBe(view!.headStatus);
    expect(+new Date(admin.lastHeadReadAt!)).toBe(+new Date(view!.lastHeadReadAt!));
    expect(+new Date(admin.epochStartedAt!)).toBe(+new Date(view!.epochStartedAt!));
  });
  it("recent failure keeps its old clock while the full continuation still advances",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();
    const before=await sync.readBackgroundRosterProgress(id,"follower");
    await pool.query("UPDATE roster_background_sync SET next_run_at=now(),next_head_run_at=now() WHERE tracked_account_id=$1",[id]);
    followers.mockResolvedValueOnce({ok:false,source:"bot",error:"reader unavailable"})
      .mockResolvedValueOnce(capture(members(2,"member",3),false,"gql:C2",false));
    await sync.runBackgroundRosterBatch();
    expect(await sync.readBackgroundRosterProgress(id,"follower")).toMatchObject({status:"syncing",headStatus:"retrying",lastHeadReadAt:before!.lastHeadReadAt,pages:2});
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C2");
    expect(await events()).toBe(0);
  });
  it("a head-only tick stays due independently without refreshing the verified full clock",async()=>{
    followers.mockResolvedValueOnce(capture(members(9),true,null));await sync.runBackgroundRosterBatch();
    const before=await store.getRosterSyncHealth(id,"follower");
    await pool.query("UPDATE roster_background_sync SET next_head_run_at=now() WHERE tracked_account_id=$1",[id]);
    followers.mockResolvedValueOnce(capture(members(2),true,null));
    await sync.runBackgroundRosterBatch();
    expect(followers).toHaveBeenCalledTimes(2);
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toEqual(before.lastCompleteReadAt);
    expect(await store.loadRosterCursor(id,"follower")).toBeNull();
    expect((await sync.readBackgroundRosterProgress(id,"follower"))!.lastHeadCount).toBe(2);
    expect(await roster()).toBe(9);
  });
  it("an actual exhausted multi-day epoch is immediately eligible for its next full pass",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();
    await pool.query("UPDATE roster_sync_state SET epoch_started_at=now()-interval '30 hours' WHERE tracked_account_id=$1",[id]);
    followers.mockResolvedValueOnce(capture(members(6,"member",3),true,null,false));
    await due();await sync.runBackgroundRosterBatch();
    const progress=await sync.readBackgroundRosterProgress(id,"follower");
    expect(progress!.status).toBe("complete");
    expect(+new Date(progress!.nextRunAt)-Date.now()).toBeLessThanOrEqual(1_000);
    expect(await events()).toBe(0);
  });

  it("commits/resumes multiple batches with the saved viewer and verifies only the covered exhausted epoch",async()=>{
    followers.mockResolvedValueOnce(capture(members(3))).mockResolvedValueOnce(capture(members(6,"member",3),true,null,false));
    await sync.runBackgroundRosterBatch();
    expect(await roster()).toBe(3);expect(await events()).toBe(0);
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
    expect(await sync.readBackgroundRosterProgress(id,"follower")).toMatchObject({status:"syncing",seenCount:3,pages:1,baselineCompleteAt:null});
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toBeNull();
    await due();await sync.runBackgroundRosterBatch();
    expect(followers.mock.calls[1][2]).toMatchObject({startCursor:"gql:C1",viewerBotId:reader,pinViewer:true,rosterSource:"graphql",nativeOnly:true,savedSessionOnly:true,maxPages:5,maxItems:500});
    const progress=await sync.readBackgroundRosterProgress(id,"follower");
    expect(progress).toMatchObject({status:"complete",seenCount:9,pages:2});expect(progress!.baselineCompleteAt).not.toBeNull();
    expect(await roster()).toBe(9);expect(await events()).toBe(0);expect(await store.loadRosterCursor(id,"follower")).toBeNull();
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).not.toBeNull();
    expect(await sync.runBackgroundRosterBatch()).toEqual({skipped:"nothing-due"});
    expect(followers).toHaveBeenCalledTimes(2);
  });
  it("a 48-member prefix cannot refresh a reported 335k roster or generate backfill activity",async()=>{
    await pool.query("UPDATE profile_snapshots SET follower_count=335603 WHERE tracked_account_id=$1",[id]);
    await pool.query("INSERT INTO roster_sync_state(tracked_account_id,dimension,settled_at,last_complete_read_at) VALUES($1,'follower',$2,$2)",[id,epochOld]);
    followers.mockResolvedValue(capture(members(48),true,null));
    await sync.runBackgroundRosterBatch();
    expect(await roster()).toBe(48);expect(await events()).toBe(0);
    expect(await sync.readBackgroundRosterProgress(id,"follower")).toMatchObject({status:"source_limited",seenCount:48,baselineCompleteAt:null,expectedCount:335603});
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt?.getTime()).toBe(+epochOld);
  });
  it("retains sightings and cursor when a later read fails and records a deferred retry",async()=>{
    followers.mockResolvedValueOnce(capture(members(3))).mockResolvedValueOnce({ok:false,source:"bot",error:"no available bot in the pool"});
    await sync.runBackgroundRosterBatch();await due();await sync.runBackgroundRosterBatch();
    expect(await roster()).toBe(3);expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
    expect(await sync.readBackgroundRosterProgress(id,"follower")).toMatchObject({status:"cooldown",seenCount:3,pages:1,baselineCompleteAt:null});
  });
  it("rolls data, cursor and progress back together on a failed checkpoint",async()=>{
    followers.mockResolvedValueOnce(capture(members(3)));await sync.runBackgroundRosterBatch();
    await expect(persist.persistFollowerDiff(id,members(2,"rollback"),{
      baselineOnly:true,leg:{startsEpoch:false,endsEpoch:false},cursor:{nextCursor:"gql:MUST_ROLL_BACK",viewerBotId:reader},
      transactionCheckpoint:async tx=>{await tx.execute(sql`UPDATE roster_background_sync SET pages_completed=999 WHERE tracked_account_id=${id}`);throw new Error("checkpoint failed");},
    })).rejects.toThrow("checkpoint failed");
    expect(await roster()).toBe(3);expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
    expect((await sync.readBackgroundRosterProgress(id,"follower"))!.pages).toBe(1);
  });
  it.each(["expired","replaced"])("%s owner cannot commit stale sightings or progress",async mode=>{
    followers.mockImplementation(async()=>{
      if(mode==="expired")await pool.query("UPDATE backend_operation_leases SET expires_at=now()-interval '1 second' WHERE key=$1",[`roster-background:${id}:follower`]);
      else await pool.query("UPDATE backend_operation_leases SET token='successor' WHERE key=$1",[`roster-background:${id}:follower`]);
      return capture(members(3));
    });
    await expect(sync.runBackgroundRosterBatch()).rejects.toThrow("execution lease lost before persistence");
    expect(await roster()).toBe(0);expect((await sync.readBackgroundRosterProgress(id,"follower"))!.pages).toBe(0);
    await pool.query("DELETE FROM backend_operation_leases WHERE key=$1",[`roster-background:${id}:follower`]);
  });
  it("canonical twins get one durable task; inactive/private/disabled targets make no IG calls",async()=>{
    await sync.reconcileBackgroundRosters();
    expect((await pool.query("SELECT tracked_account_id FROM roster_background_sync WHERE tracked_account_id=ANY($1::varchar[])",[[id,twin]])).rows).toEqual([{tracked_account_id:id}]);
    const query=new PgDialect().sqlToQuery(sync.dueBackgroundRosterQuery());
    await pool.query("EXPLAIN "+query.sql,query.params);expect((await pool.query(query.sql,query.params)).rows[0].id).toBe(id);
    await pool.query("UPDATE tracked_accounts SET is_private=true WHERE id=ANY($1::varchar[])",[[id,twin]]);
    expect(await sync.runBackgroundRosterBatch()).toEqual({skipped:"nothing-due"});
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS","");expect(await sync.runBackgroundRosterBatch()).toEqual({skipped:"nothing-due"});
    expect(followers).not.toHaveBeenCalled();
  });
  it("waits for a recent profile count and respects a real target backoff",async()=>{
    await pool.query("UPDATE profile_snapshots SET snapshot_at=now()-interval '7 hours' WHERE tracked_account_id=$1",[id]);
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"profile-count"});
    await pool.query("UPDATE profile_snapshots SET snapshot_at=now() WHERE tracked_account_id=$1",[id]);await due();
    await pool.query("INSERT INTO roster_sync_state(tracked_account_id,dimension,failure_kind,next_retry_at) VALUES($1,'follower','restricted',now()+interval '2 hours')",[id]);
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"target-backoff"});expect(followers).not.toHaveBeenCalled();
  });
  it("replaces only the old size cap, not reader safety or incomplete coverage",async()=>{
    await pool.query("INSERT INTO roster_sync_state(tracked_account_id,dimension,failure_kind,next_retry_at) VALUES($1,'follower','too_large',now()+interval '2 hours')",[id]);
    followers.mockResolvedValue(capture(members(3)));await sync.runBackgroundRosterBatch();
    expect(followers).toHaveBeenCalledTimes(1);expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toBeNull();
  });
  it("a promoted canonical twin inherits data, cursor, viewer and progress before the next batch",async()=>{
    followers.mockResolvedValueOnce(capture(members(3))).mockResolvedValueOnce(capture(members(3,"member",3),false,"gql:C2",false));
    await sync.runBackgroundRosterBatch();await due();
    await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1",[id]);
    await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,snapshot_at) VALUES($1,$2,10,now())",[twin,username]);
    await sync.runBackgroundRosterBatch();
    expect(followers.mock.calls[1][2]).toMatchObject({startCursor:"gql:C1",viewerBotId:reader});
    expect(await sync.readBackgroundRosterProgress(twin,"follower")).toMatchObject({seenCount:6,pages:2,baselineCompleteAt:null});
    expect(await store.loadRosterCursor(twin,"follower")).toBe("gql:C2");
    expect(await store.loadRosterViewer(twin,"follower")).toBe(reader);
    expect((await pool.query("SELECT count(*)::int n FROM roster_members WHERE tracked_account_id=$1",[twin])).rows[0].n).toBe(6);
    expect((await pool.query("SELECT count(*)::int n FROM follower_events WHERE tracked_account_id=$1",[twin])).rows[0].n).toBe(0);
  });
  it("a target made private during a read cannot commit public-roster sightings",async()=>{
    followers.mockImplementation(async()=>{await pool.query("UPDATE tracked_accounts SET is_private=true WHERE id=$1",[id]);return capture(members(3));});
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"read-or-persistence"});expect(await roster()).toBe(0);
  });
  it("does not send an existing REST cursor into explicit GraphQL",async()=>{
    await persist.persistFollowerDiff(id,members(3),{baselineOnly:true,leg:{startsEpoch:true,endsEpoch:false},cursor:{nextCursor:"REST-CURSOR",viewerBotId:reader}});
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({deferred:"cursor-context"});expect(followers).not.toHaveBeenCalled();
    expect(await store.loadRosterCursor(id,"follower")).toBe("REST-CURSOR");
  });
  it("a repeating batch cursor saves observations but stops the minute-by-minute loop",async()=>{
    followers.mockResolvedValueOnce(capture(members(3))).mockResolvedValueOnce(capture(members(3),false,"gql:C1",false));
    await sync.runBackgroundRosterBatch();await due();await sync.runBackgroundRosterBatch();
    const progress=await sync.readBackgroundRosterProgress(id,"follower");
    expect(progress).toMatchObject({status:"source_limited",seenCount:3,baselineCompleteAt:null});
    expect(new Date(progress!.nextRunAt).getTime()-Date.now()).toBeGreaterThan(50*60_000);
    expect(await store.loadRosterCursor(id,"follower")).toBe("gql:C1");
  });

  it("automatically resumes an unconfigured paid public cursor with its saved viewer",async()=>{
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS","");
    await persist.persistFollowerDiff(id,members(3),{baselineOnly:true,leg:{startsEpoch:true,endsEpoch:false},cursor:{nextCursor:"gql:C1",viewerBotId:reader}});
    followers.mockResolvedValue(capture(members(6,"member",3),true,null,false));
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({status:"complete",resumed:true});
    expect(followers.mock.calls[0][2]).toMatchObject({startCursor:"gql:C1",viewerBotId:reader,rosterSource:"graphql",pinViewer:true,savedSessionOnly:true,maxPages:5});
    expect(await sync.readBackgroundRosterView(id,username,"follower")).toMatchObject({enabled:true,status:"complete",source:"auto"});
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).not.toBeNull();
    expect(await events()).toBe(0);
  });

  it("restarts an unpinned legacy cursor without treating old sightings as complete coverage",async()=>{
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS","");
    await persist.persistFollowerDiff(id,members(8),{baselineOnly:true,leg:{startsEpoch:true,endsEpoch:false},cursor:{nextCursor:"LEGACY"}});
    await pool.query("UPDATE roster_members SET last_seen_at=now()-interval '1 hour' WHERE tracked_account_id=$1",[id]);
    followers.mockResolvedValueOnce(capture(members(2),true,null));
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({status:"source_limited",resumed:false});
    expect(followers.mock.calls[0][2]).toMatchObject({startCursor:null,viewerBotId:null,pinViewer:true,savedSessionOnly:true});
    expect(await roster()).toBe(8);
    expect((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt).toBeNull();
    expect(await events()).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM follower_unfollow_events WHERE tracked_account_id=$1",[id])).rows[0].n).toBe(0);
  });

  it("an older private twin neither suppresses the public canonical nor donates its saved roster",async()=>{
    followers.mockResolvedValueOnce(capture(members(3,"private")));
    await sync.runBackgroundRosterBatch();
    await pool.query("UPDATE tracked_accounts SET is_private=true WHERE id=$1",[id]);
    await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,snapshot_at) VALUES($1,$2,10,now())",[twin,username]);
    followers.mockResolvedValueOnce(capture(members(3,"public")));
    expect(await sync.runBackgroundRosterBatch()).toMatchObject({status:"syncing"});
    expect(followers.mock.calls[1][2]).toMatchObject({startCursor:null,viewerBotId:null});
    expect((await pool.query("SELECT username FROM roster_members WHERE tracked_account_id=$1 ORDER BY username",[twin])).rows).toEqual(members(3,"public").map(m=>({username:m.username})));
    expect(await sync.readBackgroundRosterProgress(twin,"follower")).toMatchObject({seenCount:3,pages:1});
  });

  it("automatic continuation honors the graph switch and current paid access before any read",async()=>{
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS","");
    await persist.persistFollowerDiff(id,members(3),{baselineOnly:true,leg:{startsEpoch:true,endsEpoch:false},cursor:{nextCursor:"gql:C1",viewerBotId:reader}});
    vi.stubEnv("FOLLOW_GRAPH_ENABLED","false");
    expect(await sync.runBackgroundRosterBatch()).toEqual({skipped:"disabled-or-draining"});
    vi.stubEnv("FOLLOW_GRAPH_ENABLED","true");
    await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 hour' WHERE user_id=$1",[userId]);
    try {
      expect(await sync.runBackgroundRosterBatch()).toEqual({skipped:"nothing-due"});
      expect(followers).not.toHaveBeenCalled();
    } finally {
      await pool.query("UPDATE subscriptions SET current_period_end=now()+interval '30 days' WHERE user_id=$1",[userId]);
    }
  });
});
