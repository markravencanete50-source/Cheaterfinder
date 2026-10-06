import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  if (new URL(url).pathname !== "/cheaterfinder_backend_fix_test_20260907") throw new Error("Scratch database required");
  process.env.DATABASE_URL = url;
  process.env.LIKE_EVENT_WINDOW = "observed";
}
(url ? describe : describe.skip)("Activity and reader priority against Postgres", () => {
  let db: typeof import("../../db.js").db;
  let pool: typeof import("../../db.js").pool;
  let read: typeof import("../admin-activity.js").readAdminActivity;
  const userA = randomUUID(), userB = randomUUID(), accountA = randomUUID(), accountB = randomUUID();
  const goodBot = randomUUID(), failedBot = randomUUID();
  const username = `activity_${randomUUID().replaceAll("-", "")}`;
  const before = new Date("2026-09-01T00:00:00Z"), detected = new Date("2026-09-05T00:00:00Z");
  beforeAll(async () => {
    ({ db, pool } = await import("../../db.js"));
    ({ readAdminActivity: read } = await import("../admin-activity.js"));
    const s = await import("../../../shared/schema.js");
    await db.insert(s.users).values([userA,userB].map(id=>({id,email:`${id}@example.invalid`,name:"Activity test",hashedPassword:"test"})));
    await db.insert(s.trackedAccounts).values([
      {id:accountA,userId:userA,igUsername:username,igUserId:"test_"+accountA,trackingStarted:before,followingFirstCompleteAt:before},
      {id:accountB,userId:userB,igUsername:username,igUserId:"test_"+accountA,trackingStarted:new Date(before.getTime()+1000),followingFirstCompleteAt:before},
    ]);
    await db.insert(s.rosterSyncState).values(["following","follower"].map(dimension=>({trackedAccountId:accountA,dimension,settledAt:before})));
    await db.insert(s.likeEvents).values([
      {trackedAccountId:accountA,postId:"old-post-new-detection",ownerUsername:"owner",detectedAt:detected,postTakenAt:new Date("2025-01-01")},
      {trackedAccountId:accountB,postId:"old-post-new-detection",ownerUsername:"owner",detectedAt:new Date(detected.getTime()+1000)},
      {trackedAccountId:accountA,postId:"new-post-old-detection",ownerUsername:"owner",detectedAt:new Date("2026-09-04"),postTakenAt:new Date("2026-09-03")},
    ]);
    await db.insert(s.followEvents).values([
      {trackedAccountId:accountA,followedUsername:"real_follow",detectedAt:detected},
      {trackedAccountId:accountA,followedUsername:"seed_noise",detectedAt:new Date("2026-08-31")},
      {trackedAccountId:accountA,followedUsername:"flip_flop",detectedAt:detected},
    ]);
    await db.insert(s.unfollowEvents).values([
      {trackedAccountId:accountA,unfollowedUsername:"flip_flop",detectedAt:new Date("2026-09-04")},
      {trackedAccountId:accountA,unfollowedUsername:"returned_user",detectedAt:detected},
      {trackedAccountId:accountA,unfollowedUsername:"real_departure",detectedAt:detected},
    ]);
    await db.insert(s.rosterMembers).values([
      {trackedAccountId:accountA,dimension:"following",username:"returned_user",usernameLower:"returned_user",isCurrent:true},
      {trackedAccountId:accountA,dimension:"following",username:"real_departure",usernameLower:"real_departure",isCurrent:false,leftAt:detected},
      {trackedAccountId:accountA,dimension:"follower",username:"lost_follower",usernameLower:"lost_follower",isCurrent:false},
    ]);
    await db.insert(s.followerEvents).values({trackedAccountId:accountA,followerUsername:"new_follower",detectedAt:detected});
    await db.insert(s.followerUnfollowEvents).values({trackedAccountId:accountA,unfollowerUsername:"lost_follower",detectedAt:detected});
  });
  afterAll(async () => {
    if (!db) return;
    await db.execute(sql`DELETE FROM scrape_outcome_log WHERE bot_id IN (${goodBot},${failedBot})`);
    await db.execute(sql`DELETE FROM bot_accounts WHERE id IN (${goodBot},${failedBot})`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${userA},${userB})`);
    await pool.end();
  });
  it("deduplicates twin likes and sorts by detection before pagination", async () => {
    const first = await read({type:"like",search:username,limit:1,offset:0});
    const next = await read({type:"like",search:username,limit:1,offset:1});
    expect(first.total).toBe(2);
    expect(first.items[0]).toMatchObject({postId:"old-post-new-detection"});
    expect(next.items[0]).toMatchObject({postId:"new-post-old-detection"});
    expect((await read({type:"like",search:username,limit:1,offset:999}))).toMatchObject({total:2,items:[]});
  });
  it("includes both follower directions and suppresses seeded/contradicted activity", async () => {
    const result = await read({type:"all",search:username,limit:100,offset:0});
    expect(result.total).toBe(6);
    expect(result.items).toHaveLength(6);
    expect(result.summary).toMatchObject({totalLikes:2,totalFollows:1,totalUnfollows:1,totalFollowers:1,totalFollowerUnfollows:1});
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({eventType:"follower",followerUsername:"new_follower"}),
      expect.objectContaining({eventType:"follower_unfollow",unfollowerUsername:"lost_follower"}),
      expect.objectContaining({eventType:"follow",followedUsername:"real_follow"}),
      expect.objectContaining({eventType:"unfollow",unfollowedUsername:"real_departure"}),
    ]));
    expect(JSON.stringify(result.items)).not.toMatch(/seed_noise|flip_flop|returned_user/);
  });
  it("escapes search wildcards and gives stable, nonoverlapping tied pages", async () => {
    expect((await read({type:"all",search:"%",limit:30,offset:0})).total).toBe(0);
    const first = await read({type:"all",search:username,limit:3,offset:0});
    const second = await read({type:"all",search:username,limit:3,offset:3});
    const again = await read({type:"all",search:username,limit:3,offset:0});
    expect(again.items).toEqual(first.items);
    const ids = [...first.items,...second.items].map(x=>(x as {id:string}).id);
    expect(new Set(ids).size).toBe(6);
  });
  it("keeps existing open clients on event types their shipped bundle supports", async () => {
    const result = await read({type:"all",search:username,limit:100,offset:0,includeFollowers:false});
    expect(result.total).toBe(4);
    expect(result.items.every(x=>["like","follow","unfollow"].includes((x as {eventType:string}).eventType))).toBe(true);
  });
  it.each([
    ["approved active",true,true,"has_access","active",true,true],
    ["approved trial",true,true,"has_access","trialing",true,true],
    ["pending approval",true,true,"pending_access","active",true,false],
    ["denied access",true,true,"access_denied","active",true,false],
    ["inactive private",true,false,"has_access","active",true,false],
    ["past due private",true,true,"has_access","past_due",true,false],
    ["expired trial",true,true,"has_access","trialing",false,false],
    ["expired active",true,true,"has_access","active",false,false],
    ["unlinked private",true,true,"has_access","unlinked",true,false],
    ["inactive unpaid public history",false,false,"public","canceled",false,true],
  ] as const)("applies current private eligibility to all five global/scoped event types: %s",async(_label,isPrivate,isActive,accessStatus,status,current,allowed)=>{
    const s=await import("../../../shared/schema.js");
    const user=randomUUID(),target=randomUUID(),name="privacy_"+randomUUID().replaceAll("-","");
    await db.insert(s.users).values({id:user,email:user+"@example.invalid",name:"Activity policy fixture",hashedPassword:"test"});
    try {
      const expires=new Date(Date.now()+(current?3600000:-3600000));
      await db.insert(s.subscriptions).values({userId:user,status:status==="unlinked"?"active":status,plan:"standard",
        stripeCustomerId:status==="unlinked"?null:"cus_"+user,stripeSubscriptionId:status==="unlinked"?null:"sub_"+user,
        currentPeriodEnd:expires,trialEndsAt:expires});
      await db.insert(s.trackedAccounts).values({id:target,userId:user,igUsername:name,igUserId:"fixture_"+target,isPrivate,isActive,accessStatus,
        trackingStarted:before,followingFirstCompleteAt:before});
      await db.insert(s.rosterSyncState).values(["following","follower"].map(dimension=>({trackedAccountId:target,dimension,settledAt:before})));
      await db.insert(s.likeEvents).values({trackedAccountId:target,postId:"private-fixture-post",ownerUsername:"fixture-owner",caption:"Private fixture caption",thumbnailUrl:"https://cdninstagram.com/fixture.png",detectedAt:detected});
      await db.insert(s.followEvents).values({trackedAccountId:target,followedUsername:"fixture-follow",detectedAt:detected});
      await db.insert(s.followerEvents).values({trackedAccountId:target,followerUsername:"fixture-follower",detectedAt:detected});
      await db.insert(s.followerUnfollowEvents).values({trackedAccountId:target,unfollowerUsername:"fixture-lost",detectedAt:detected});
      await db.insert(s.rosterMembers).values([
        {trackedAccountId:target,dimension:"following",username:"fixture-departed",usernameLower:"fixture-departed",isCurrent:false,leftAt:detected},
        {trackedAccountId:target,dimension:"follower",username:"fixture-lost",usernameLower:"fixture-lost",isCurrent:false,leftAt:detected},
      ]);
      const global=await read({type:"all",search:name,limit:100,offset:0});
      const scoped=await read({type:"all",search:"",limit:100,offset:0,trackedAccountIds:[target],canonicalAccountId:target});
      for(const result of [global,scoped]){
        expect(result.total).toBe(allowed?5:0);expect(result.items).toHaveLength(allowed?5:0);
        if(allowed)expect(new Set(result.items.map((item:any)=>item.eventType))).toEqual(new Set(["like","follow","unfollow","follower","follower_unfollow"]));
        else expect(JSON.stringify(result.items)).not.toContain("Private fixture caption");
      }
      expect(scoped.collectionHealth).toBeNull();
    } finally {await db.execute(sql`DELETE FROM users WHERE id=${user}`);}
  });
  it("prefers proven mobile posts readers without bypassing caps or excluding recovered readers", async () => {
    const {botAccounts,botDailyCalls,scrapeOutcomeLog} = await import("../../../shared/schema.js");
    const {buildLeaseCandidateQuery} = await import("../../ig-public-scraper.js");
    const now = new Date();
    await db.insert(botAccounts).values([
      {id:goodBot,igUsername:"good_"+goodBot,role:"scraper",tier:"worker",transport:"mobile",status:"available",sessionData:"scratch-only",proxyUrl:"http://fixed.example.invalid:15000",lastUsedAt:new Date(now.getTime()-60_000)},
      {id:failedBot,igUsername:"fail_"+failedBot,role:"scraper",tier:"worker",transport:"mobile",status:"available",sessionData:"scratch-only",proxyUrl:"http://fixed.example.invalid:15000",lastUsedAt:new Date(now.getTime()-120_000)},
    ]);
    await db.insert(scrapeOutcomeLog).values([
      {botId:goodBot,endpoint:"posts",outcome:"success",occurredAt:now},
      {botId:failedBot,endpoint:"posts",outcome:"failure",errorKind:"rate_limit",occurredAt:now},
    ]);
    const select = async (at=now) => { const q=buildLeaseCandidateQuery(db,{label:"posts",now:at}).toSQL();return (await pool.query(q.sql,q.params)).rows[0]?.id; };
    expect(await select()).toBe(goodBot);
    expect(await select(new Date(now.getTime()+61*60_000))).toBe(failedBot);
    await db.insert(botDailyCalls).values({botId:goodBot,endpoint:"posts",day:now.toISOString().slice(0,10),count:100000});
    expect(await select()).toBe(failedBot);
  });
});
