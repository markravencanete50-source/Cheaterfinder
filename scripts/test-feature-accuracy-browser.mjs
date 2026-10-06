// Real compiled app/Chromium, deterministic APIs and SSE, no production writes.
import assert from "node:assert/strict";
import express from "express";
import {readFile} from "node:fs/promises";
import {chromium} from "playwright";
const root=process.env.FEATURE_TEST_BUILD ?? "/tmp/cheaterfinder-feature-health-build-20260907";
const app=express(); app.use(express.static(root));
const shell=await readFile(root+"/index.html","utf8"); app.use((_req,res)=>res.type("html").send(shell));
const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
const origin="http://127.0.0.1:"+server.address().port;
const browser=await chromium.launch({args:["--no-sandbox"]});
const now=new Date().toISOString();
let overviewCount=41,overviewStatus=200,viewerVersion=1,viewerStatus=200;
let backgroundMode=false,backgroundSeen=250,profileReported=335609;
let rosterVersion=1,rosterStatus=200;
let headStatus="checked",headReadAt=now,headCount=100;
const requests=[];
const account={id:"customer-row",igUsername:"fixture_profile",displayName:"Fixture profile",isActive:true,trackingStarted:"2026-09-01T00:00:00Z",profileSnapshots:[{snapshotAt:now,followerCount:100,followingCount:50,postCount:0}]};
const viewer=()=>({igUsername:account.igUsername,displayName:account.displayName,profilePicUrl:"",followerCount:backgroundMode?profileReported:100,followingCount:50,postCount:0,
  topNiche:"general",peakActivityHour:12,recentLikes:[],recentPosts:[],stories:[],highlights:[],
  recentFollows:[{followedUsername:"outgoing_follow",detectedAt:now}],
  recentUnfollows:[{unfollowedUsername:"outgoing_unfollow",detectedAt:now}],
  recentFollowers:[{followerUsername:"incoming_"+viewerVersion,detectedAt:now}],
  recentFollowerUnfollows:[{unfollowerUsername:"lost_incoming",detectedAt:now}],
  weeklyStats:{totalLikes:0,totalFollows:1,totalUnfollows:1,totalPosts:0},activityByHour:[],activityByDate:[],dataSource:"cached",cachedAt:now,
  rosterStatus:{followers:{loadedTotal:backgroundMode?backgroundSeen:100,expectedTotal:backgroundMode?profileReported:100,isPartial:backgroundMode,syncState:backgroundMode?"syncing":"complete",unfollowDetectionTrusted:true,lastCompleteReadAt:null,
    ...(backgroundMode?{background:{enabled:true,status:"syncing",source:"graphql",baselineCompleteAt:null,expectedCount:335609,seenCount:backgroundSeen,pages:5,lastProgressAt:now,nextRunAt:now,
      lastHeadReadAt:headReadAt,lastHeadCount:headCount,headStatus,nextHeadRunAt:new Date(Date.now()+15*60_000).toISOString()}}:{})},following:{loadedTotal:50,expectedTotal:50,isPartial:false,syncState:"complete",unfollowDetectionTrusted:true,lastCompleteReadAt:now}}});
const overview=()=>({users:{total:1,newThisWeek:1,activeThisMonth:1},subscriptions:{total:0},trackedAccounts:{total:1,active:1,private:0,pendingAccess:0},
  events:{totalLikes:1,likesLast24h:1,totalFollows:2,followsLast24h:2,totalUnfollows:3,unfollowsLast24h:3,totalFollowers:overviewCount,followersLast24h:overviewCount,totalFollowerUnfollows:7,followerUnfollowsLast24h:7},
  bots:{total:10,available:2,inUse:0,cooldown:1,sessionExpired:1,banned:1,disabled:5},jobs:{total:0}});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}}), errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(()=>{
    class FixtureEventSource extends EventTarget { static CLOSED=2; readyState=1;
      constructor(){super();window.fixtureEvents=this;} close(){this.readyState=2;}
    } window.EventSource=FixtureEventSource;
  });
  await page.route("**/*",route=>{
    const url=new URL(route.request().url()); if(url.origin!==origin)return route.abort();
    if(!url.pathname.startsWith("/api/"))return route.continue();
    requests.push(url.pathname);
    if(url.pathname==="/api/auth/me")return route.fulfill({json:{id:"fixture-admin",email:"fixture@example.invalid",role:"admin"}});
    if(url.pathname==="/api/admin/overview")return route.fulfill({status:overviewStatus,json:overviewStatus===200?overview():{message:"Fixture error"}});
    if(url.pathname.startsWith("/api/viewer/"))return route.fulfill({status:viewerStatus,json:viewerStatus===200?viewer():{message:"Fixture error"}});
    if(url.pathname==="/api/tracking/accounts")return route.fulfill({json:[account]});
    if(url.pathname.endsWith("/report"))return route.fulfill({json:{...account,profileSnapshots:[{
      ...account.profileSnapshots[0],followerCount:backgroundMode?profileReported:100,
    }]}});
    if(url.pathname.endsWith("/feed"))return route.fulfill({json:{items:[]}});
    if(url.pathname.endsWith("/followers/roster"))return route.fulfill({status:rosterStatus,json:rosterStatus===200?{
      ...viewer().rosterStatus.followers,items:[{username:"roster_"+rosterVersion,displayName:"Observed member",firstSeenAt:now}],total:backgroundSeen,nextCursor:null,
    }:{message:"Fixture roster error"}});
    if(url.pathname.endsWith("/followers")||url.pathname.endsWith("/following"))return route.fulfill({json:{items:[{username:"roster_member",displayName:"Roster member",firstSeenAt:now}],total:1,nextCursor:null,syncState:"complete"}});
    return route.fulfill({json:{}});
  });
  await page.goto(origin+"/admin");
  const gained=page.getByText("Followers gained",{exact:true}).locator("..");
  await gained.getByText("41",{exact:true}).waitFor();
  await page.getByText("Followers lost",{exact:true}).waitFor();
  overviewCount=42;
  await gained.getByText("42",{exact:true}).waitFor({timeout:20_000});
  await page.screenshot({path:"/tmp/cheaterfinder-overview-accuracy-after.png",fullPage:true});
  overviewStatus=500;
  await page.getByRole("alert").filter({hasText:"Overview refresh failed"}).waitFor({timeout:20_000});
  assert.match(await gained.innerText(),/42/);
  await page.goto(origin+"/dashboard/customer-row");
  await page.getByText("@incoming_1",{exact:true}).waitFor();
  assert.equal(await page.getByText(/Last checked/).count(),0,"A profile/follower timestamp falsely freshened empty media sections");
  const direction=async(title,username)=>{
    const panel=page.getByRole("heading",{name:title,exact:true}).locator("../../..");
    assert.match(await panel.innerText(),new RegExp(username));
  };
  await direction("Accounts unfollowed","outgoing_unfollow");
  await direction("Lost followers","lost_incoming");
  await page.getByRole("status").filter({hasText:"over 48 hours old"}).waitFor();
  const before=requests.filter(p=>p.startsWith("/api/viewer/")).length;
  viewerVersion=2;
  await page.evaluate(()=>window.fixtureEvents.dispatchEvent(new MessageEvent("followers.changed",{data:JSON.stringify({kind:"followers.changed",trackedAccountId:"customer-row",igUsername:"fixture_profile",count:1,at:new Date().toISOString()})})));
  await page.getByText("@incoming_2",{exact:true}).waitFor();
  assert(requests.filter(p=>p.startsWith("/api/viewer/")).length>before);
  await page.screenshot({path:"/tmp/cheaterfinder-customer-accuracy-after.png",fullPage:true});
  viewerVersion=3;
  await page.getByText("@incoming_3",{exact:true}).waitFor({timeout:40_000});
  backgroundMode=true;
  await page.evaluate(()=>window.fixtureEvents.dispatchEvent(new MessageEvent("followers.changed",{data:JSON.stringify({kind:"followers.changed",trackedAccountId:"customer-row",igUsername:"fixture_profile",count:0,at:new Date().toISOString()})})));
  const progress=page.getByTestId("roster-sync-progress");
  await progress.getByText(/250 distinct members observed/).waitFor();
  assert.match(await progress.innerText(),/not new followers/);
  assert.match(await progress.innerText(),/not yet verified/);
  const recent=progress.getByTestId("roster-recent-check");
  await recent.getByText(/100 checked/).waitFor();
  assert.match(await recent.innerText(),/cannot verify every change/);
  headStatus="retrying";headReadAt=new Date(Date.now()-25*60_000).toISOString();
  await page.evaluate(()=>window.fixtureEvents.dispatchEvent(new MessageEvent("followers.changed",{data:JSON.stringify({kind:"followers.changed",trackedAccountId:"customer-row",igUsername:"fixture_profile",count:0,at:new Date().toISOString()})})));
  await recent.getByRole("alert").filter({hasText:"Recent check delayed"}).waitFor({timeout:40_000});
  assert.match(await progress.innerText(),/Initial full roster is not yet verified/);
  headStatus="checked";headReadAt=new Date().toISOString();headCount=98;
  await page.evaluate(()=>window.fixtureEvents.dispatchEvent(new MessageEvent("followers.changed",{data:JSON.stringify({kind:"followers.changed",trackedAccountId:"customer-row",igUsername:"fixture_profile",count:0,at:new Date().toISOString()})})));
  await recent.getByText(/98 checked/).waitFor({timeout:40_000});
  assert.equal(await recent.getByRole("alert").count(),0);
  console.log(JSON.stringify({recentChecksPassed:["independent recent observation clock","recent delay cannot hide behind fresh full progress","recent recovery retains incomplete baseline"]}));
  assert.equal(await page.getByText(/network is too large to pull completely/).count(),0);
  await page.getByText("335,609",{exact:true}).waitFor({timeout:40_000});
  profileReported=335601;
  await page.evaluate(()=>window.fixtureEvents.dispatchEvent(new MessageEvent("profile.updated",{data:JSON.stringify({kind:"profile.updated",trackedAccountId:"customer-row",igUsername:"fixture_profile",count:1,at:new Date().toISOString()})})));
  await page.getByText("335,601",{exact:true}).waitFor({timeout:40_000});
  assert.match(await progress.innerText(),/335,609 reported at scan start/);
  await page.screenshot({path:"/tmp/cheaterfinder-long-roster-customer-fixture.png",fullPage:true});
  backgroundSeen=500;
  await progress.getByText(/500 distinct members observed/).waitFor({timeout:40_000});
  viewerStatus=500;
  await page.evaluate(()=>window.fixtureEvents.dispatchEvent(new MessageEvent("following.changed",{data:JSON.stringify({kind:"following.changed",trackedAccountId:"customer-row",igUsername:"fixture_profile",count:1,at:new Date().toISOString()})})));
  await page.getByRole("alert").filter({hasText:"Some data could not refresh"}).waitFor({timeout:15_000});
  assert.equal(await page.getByText("@incoming_3",{exact:true}).count(),1);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:"/tmp/cheaterfinder-customer-accuracy-mobile.png",fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  viewerStatus=200;
  await page.getByRole("tab",{name:"All followers",exact:true}).click();
  await page.getByText("@roster_1",{exact:true}).waitFor();
  await page.getByTestId("roster-sync-progress").getByText(/500 distinct members observed/).waitFor();
  rosterVersion=2;
  await page.getByText("@roster_2",{exact:true}).waitFor({timeout:40_000});
  rosterStatus=500;
  await page.getByRole("alert").filter({hasText:"Roster refresh failed"}).waitFor({timeout:45_000});
  assert.equal(await page.getByText("@roster_2",{exact:true}).count(),1);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:["Overview all five directions","Overview polls new counters","Overview stale error preserves counts","separate incoming/outgoing unfollows","customer freshness warning","roster SSE refreshes activity","missed-event poll backstop","background observations are not new followers","background progress is not complete/capped","profile header refreshes reported count","scan-start denominator distinct from latest profile count","background progress polls without new activity","customer refresh error preserves data","mobile layout","all-followers progress","first roster page polls","roster refresh error preserves rows"],errors}));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
