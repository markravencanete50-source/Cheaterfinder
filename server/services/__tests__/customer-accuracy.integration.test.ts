// Real Express handlers + scratch Postgres. Never starts workers or fetches IG.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  if (new URL(url).pathname !== "/cheaterfinder_backend_fix_test_20260907") throw new Error("Scratch database required");
  process.env.DATABASE_URL = url;
  process.env.WORKERS_DISABLED = "1";
  process.env.LIKE_EVENT_WINDOW = "observed";
}
vi.mock("../public-read-client.js", () => ({ maybeRevalidateTier1: vi.fn(), fetchPublicProfileTier1: vi.fn() }));
vi.mock("../media-cache-jobs.js", async importOriginal => ({
  ...await importOriginal<typeof import("../media-cache-jobs.js")>(),
  enqueueMediaCacheUrls: vi.fn(async () => {}),
}));
const userA = randomUUID(), userB = randomUUID(), unrelated = randomUUID();
const accountA = randomUUID(), accountB = randomUUID(), username = "accuracy_" + randomUUID().replaceAll("-", "").slice(0,20);
const day = 86_400_000, now = new Date(), start = new Date(+now - 6 * day), eventAt = new Date(+now - day);
(url ? describe : describe.skip)("customer/admin evidence consistency", () => {
  let pool: typeof import("../../db.js").pool, server: Server, origin: string;
  beforeAll(async () => {
    const { db, pool: p } = await import("../../db.js"); pool = p;
    const s = await import("../../../shared/schema.js");
    await db.insert(s.users).values([userA,userB,unrelated].map(id => ({ id, email:id+"@example.invalid", name:"Accuracy fixture" })));
    await db.insert(s.subscriptions).values([userA,userB,unrelated].map(userId => ({userId, stripeCustomerId:"cus_fixture_"+userId, stripeSubscriptionId:"sub_fixture_"+userId, status:"active" as const, plan:"standard" as const, currentPeriodEnd:new Date(Date.now()+30*day)})));
    await db.insert(s.trackedAccounts).values([
      { id:accountA,userId:userA,igUsername:username,igUserId:accountA,trackingStarted:start,followingFirstCompleteAt:start,lastFollowersRefreshAt:now,lastFollowingRefreshAt:now },
      { id:accountB,userId:userB,igUsername:username,igUserId:accountA,trackingStarted:new Date(+start+day),followingFirstCompleteAt:start,lastFollowersRefreshAt:now,lastFollowingRefreshAt:now },
    ]);
    await db.insert(s.profileSnapshots).values([accountA,accountB].map(trackedAccountId => ({trackedAccountId,igUsername:username,followerCount:2,followingCount:2,postCount:0,snapshotAt:now})));
    await db.insert(s.rosterSyncState).values(["following","follower"].map(dimension => ({trackedAccountId:accountA,dimension,settledAt:start,seededAt:start,lastCompleteReadAt:now})));
    await db.insert(s.rosterMembers).values([
      ...["real_follow","returned_account"].map(username => ({trackedAccountId:accountA,dimension:"following",username,usernameLower:username,isCurrent:true})),
      {trackedAccountId:accountA,dimension:"following",username:"real_departure",usernameLower:"real_departure",isCurrent:false,leftAt:eventAt},
      ...["new_follower","returned_follower"].map(username => ({trackedAccountId:accountA,dimension:"follower",username,usernameLower:username,isCurrent:true})),
      {trackedAccountId:accountA,dimension:"follower",username:"lost_follower",usernameLower:"lost_follower",isCurrent:false,leftAt:eventAt},
    ]);
    await db.insert(s.followEvents).values({trackedAccountId:accountA,followedUsername:"real_follow",detectedAt:eventAt});
    await db.insert(s.unfollowEvents).values([
      {trackedAccountId:accountA,unfollowedUsername:"real_departure",detectedAt:eventAt},
      {trackedAccountId:accountA,unfollowedUsername:"returned_account",detectedAt:eventAt},
    ]);
    await db.insert(s.followerEvents).values({trackedAccountId:accountA,followerUsername:"new_follower",detectedAt:eventAt});
    await db.insert(s.followerUnfollowEvents).values(["lost_follower","returned_follower","unconfirmed_missing"].map(unfollowerUsername=>({trackedAccountId:accountA,unfollowerUsername,detectedAt:eventAt})));
    const app = express();
    app.use((req,_res,next) => {
      req.user = {id:String(req.headers["x-fixture-user"] ?? unrelated),role:"user"} as Express.User;
      req.isAuthenticated = (() => true) as typeof req.isAuthenticated;
      next();
    });
    server = createServer(app);
    const {registerRoutes} = await import("../../routes.js"); await registerRoutes(server,app);
    await new Promise<void>(resolve=>server.listen(Number(process.env.STRESS_FAULT_PORT ?? 0),"127.0.0.1",resolve));
    origin = "http://127.0.0.1:"+(server.address() as {port:number}).port;
  }, 60_000);
  afterAll(async () => {
    if(server) await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(pool) { await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])",[[userA,userB,unrelated]]); await pool.end(); }
  });
  const get = async (path:string, user=userB) => {
    const res=await fetch(origin+path,{headers:{"x-fixture-user":user}});
    return {status:res.status,body:await res.json()};
  };
  it("a noncanonical customer's viewer shows the same confirmed follow directions", async () => {
    const {status,body} = await get("/api/viewer/"+username);
    expect(status).toBe(200);
    expect(body.recentFollows.map((x:any)=>x.followedUsername)).toEqual(["real_follow"]);
    expect(body.recentUnfollows.map((x:any)=>x.unfollowedUsername)).toEqual(["real_departure"]);
    expect(body.recentFollowers.map((x:any)=>x.followerUsername)).toEqual(["new_follower"]);
    expect(body.recentFollowerUnfollows.map((x:any)=>x.unfollowerUsername)).toEqual(["lost_follower"]);
    expect(body.weeklyStats).toMatchObject({totalFollows:1,totalUnfollows:1});
    expect(body.rosterStatus.followers.lastCompleteReadAt).not.toBeNull();
    expect(body.cachedAt).toBeTruthy();
    expect(body.contentCachedAt).toEqual({posts:null,stories:null,highlights:null});
  });
  it("customer feed excludes contradicted historical unfollows and agrees with the viewer", async () => {
    const {status,body}=await get(`/api/tracking/accounts/${accountB}/feed?limit=50`);
    expect(status).toBe(200);
    expect(body.items.filter((x:any)=>x.eventType==="unfollow").map((x:any)=>x.unfollowedUsername)).toEqual(["real_departure"]);
  });
  it("report follower totals and samples use the same canonical, confirmed data", async () => {
    const {buildReportData}=await import("../report-data.js");
    const report=await buildReportData(accountB,new Date(+now-4*day),now,"weekly");
    expect(report.newFollowerSample).toEqual(["new_follower"]);
    expect(report.lostFollowerSample).toEqual(["lost_follower"]);
    expect(report.unfollowedAccounts.map(x=>x.username)).toEqual(["real_departure"]);
    expect(report.summary).toMatchObject({followersDetected:1,followersLost:1});
  });
  it("admin Activity uses the same confirmed departures as the customer", async () => {
    const {readAdminActivity}=await import("../admin-activity.js");
    const activity=await readAdminActivity({type:"all",search:username,limit:30,offset:0});
    expect(activity.summary).toMatchObject({totalFollows:1,totalUnfollows:1,totalFollowers:1,totalFollowerUnfollows:1});
  });
  it("a different customer cannot access this profile or feed", async () => {
    expect((await get("/api/viewer/"+username,unrelated)).status).toBe(404);
    expect([403,404]).toContain((await get(`/api/tracking/accounts/${accountB}/feed`,unrelated)).status);
  });
  it("viewer, paged roster and health show the canonical background progress without a false cap or full-read clock", async()=>{
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS",`${username}:follower:graphql`);
    await pool.query("INSERT INTO roster_background_sync(tracked_account_id,dimension,source,status,epoch_expected_count,epoch_seen_count,pages_completed,last_progress_at) VALUES($1,'follower','graphql','syncing',335603,2,5,now())",[accountA]);
    await pool.query("UPDATE profile_snapshots SET follower_count=335603 WHERE tracked_account_id=ANY($1::varchar[])",[[accountA,accountB]]);
    try {
      const viewer=await get("/api/viewer/"+username),paged=await get(`/api/tracking/accounts/${accountB}/followers/roster?limit=10`);
      expect(viewer.status).toBe(200);expect(paged.status).toBe(200);
      expect(viewer.body.rosterStatus.followers).toMatchObject({syncState:"syncing",isPartial:true,background:{enabled:true,seenCount:2,pages:5,baselineCompleteAt:null}});
      expect(paged.body).toMatchObject({syncState:"syncing",enumerableCap:null,reachableTotal:335603,background:{seenCount:2,pages:5}});
      expect(paged.body.lastCompleteReadAt).toBe(viewer.body.rosterStatus.followers.lastCompleteReadAt);
      const {readCollectionHealth}=await import("../collection-health.js");
      const health=await readCollectionHealth();
      expect(health.profiles.find(p=>p.username===username)?.backgroundFollowers).toMatchObject({enabled:true,seenCount:2,pages:5,baselineCompleteAt:null});
      expect(JSON.stringify(viewer.body.rosterStatus.followers.background)).not.toMatch(/cursor|botId|lastError/);
    } finally {
      vi.unstubAllEnvs();
      await pool.query("DELETE FROM roster_background_sync WHERE tracked_account_id=$1",[accountA]);
      await pool.query("UPDATE profile_snapshots SET follower_count=2 WHERE tracked_account_id=ANY($1::varchar[])",[[accountA,accountB]]);
    }
  });
});
