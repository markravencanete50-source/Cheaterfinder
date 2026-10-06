import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import express from "express";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
const cacheDir = path.join(process.env.STRESS_OUTPUT_DIR ?? "/tmp", "media-http-" + randomUUID());
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.port === "5432") throw Error("Guarded scratch database required");
  process.env.DATABASE_URL = url;
  process.env.MEDIA_CACHE_DIR = cacheDir;
  process.env.WORKERS_DISABLED = "1";
  process.env.SESSION_SECRET = "isolated-private-media-http-only";
  process.env.HTTPS_ENABLED = "false";
  process.env.ALLOW_INTERACTIVE_SCRAPE = "false";
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.ADMIN_EMAIL;
}
vi.mock("../public-read-client.js", () => ({ maybeRevalidateTier1: vi.fn(), fetchPublicProfileTier1: vi.fn() }));
vi.mock("../media-cache-jobs.js", async original => ({ ...await original<typeof import("../media-cache-jobs.js")>(), enqueueMediaCacheUrls: vi.fn(async () => {}) }));
vi.mock("../../stripe.js", async original => ({ ...await original<typeof import("../../stripe.js")>(), stripe: null }));

const users = [randomUUID(), randomUUID()];
const tracks = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const reports = [randomUUID(), randomUUID()];
const privateName = "fixture_private_" + randomUUID().replaceAll("-", "");
const publicName = "fixture_public_" + randomUUID().replaceAll("-", "");
const assetUrl = "https://scontent.cdninstagram.com/v/fixture-" + randomUUID() + ".jpg";
const privateCode = "fixture_private_" + randomUUID(), publicCode = "fixture_public_" + randomUUID();
const password = "Fixture-private-media-password";
const imageBody = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/2sAAAAASUVORK5CYII=", "base64");

(url ? describe : describe.skip)("customer-bound media and private cache isolation — real HTTP/DB", () => {
  let pool: typeof import("../../db.js").pool, server: Server, origin: string;
  let signMediaUrl: typeof import("../media-access.js").signMediaUrl;
  let key: string;
  const cookies: string[] = [];
  const request = (route: string, user = 0) => fetch(origin + route, { headers: { cookie: cookies[user] ?? "" } });
  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    ({ signMediaUrl } = await import("../media-access.js"));
    key = (await import("../media-cache.js")).mediaCacheKey(assetUrl);
    await mkdir(cacheDir, { recursive: true });
    const body = imageBody;
    const localPath = path.join(cacheDir, key + ".png");
    await writeFile(localPath, body);
    const hashed = await bcrypt.hash(password, 4);
    for (const user of users) {
      await pool.query("INSERT INTO users(id,email,name,hashed_password) VALUES($1,$2,'Media fixture',$3)", [user,user + "@example.invalid",hashed]);
      await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end) VALUES($1,$2,$3,'active','standard',now()+interval '1 day')", [user,"cus_"+user,"sub_"+user]);
    }
    for (let i = 0; i < tracks.length; i++) {
      const isPrivate = i < 2;
      await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,is_private,access_status,tracking_started,posts_pagination_done) VALUES($1,$2,$3,$4,$5,$6,now()-($7::int*interval '1 hour'),true)",
        [tracks[i],users[i===4?1:i%2],i===4?privateName+"_stale":isPrivate?privateName:publicName,isPrivate||i===4?"99910001":"99910002",isPrivate,isPrivate?(i===0?"has_access":"pending_access"):"public",10-i]);
    }
    for (const [i,shortcode] of [[0,privateCode],[2,publicCode]] as const) {
      await pool.query("INSERT INTO posts_cache(tracked_account_id,shortcode,media_id,post_type,thumbnail_url,display_url,taken_at) VALUES($1,$2,'999199','photo',$3,$3,now())", [tracks[i],shortcode,assetUrl]);
    }
    await pool.query("INSERT INTO media_assets(original_url,cache_key,local_path,content_type,byte_size,status) VALUES($1,$2,$3,'image/png',$4,'cached')", [assetUrl,key,localPath,body.length]);
    await pool.query("INSERT INTO stories_cache(tracked_account_id,story_id,media_type,media_url,taken_at,expires_at) VALUES($1,'private-story','photo',$2,now(),now()+interval '12 hours')",[tracks[0],assetUrl]);
    await pool.query("INSERT INTO highlights_cache(tracked_account_id,highlight_id,title,cover_url,media_count) VALUES($1,'private-highlight','Private highlight',$2,1)",[tracks[0],assetUrl]);
    await pool.query("UPDATE tracked_accounts SET profile_pic_url=$2 WHERE id=ANY($1::varchar[])",[tracks,assetUrl]);
    await pool.query("INSERT INTO like_events(tracked_account_id,post_id,owner_username,thumbnail_url,post_taken_at) VALUES($1,'private-like','private-fixture-owner',$2,now())",[tracks[0],assetUrl]);
    await pool.query("INSERT INTO like_events(tracked_account_id,post_id,owner_username,thumbnail_url,post_taken_at) VALUES($1,'public-like','public-fixture-owner',$2,now())",[tracks[2],assetUrl]);
    for (const code of [privateCode,publicCode]) {
      await pool.query("INSERT INTO comments_cache(post_shortcode,ig_comment_pk,author_username,author_pfp_url,text) VALUES($1,'fixture-comment','fixture-author',$2,'Fixture comment')",[code,assetUrl]);
      await pool.query("INSERT INTO likers_cache(post_shortcode,liker_username,liker_pfp_url) VALUES($1,'fixture-liker',$2)",[code,assetUrl]);
    }
    for(const dimension of ['follower','following']) {
      await pool.query("INSERT INTO roster_members(tracked_account_id,dimension,username_lower,username,pfp_url) VALUES($1,$2,'private-fixture-member','private-fixture-member',$3)",[tracks[0],dimension,assetUrl]);
    }
    for (let i=0;i<reports.length;i++) {
      await pool.query("INSERT INTO reports(id,tracked_account_id,type,period_start,period_end,status,metrics) VALUES($1,$2,'weekly',now()-interval '7 days',now(),'ready',$3)",
        [reports[i],tracks[i*2],JSON.stringify({likesLeaderboard:[{username:"fixture",count:1,thumbnails:[assetUrl]}]})]);
    }
    const app=express();app.use(express.json());
    (await import("../../auth.js")).setupAuth(app);
    server=createServer(app);await (await import("../../routes.js")).registerRoutes(server,app);
    app.use((_err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(500).json({message:"Fixture internal error"}));
    await new Promise<void>(resolve=>server.listen(Number(process.env.STRESS_FAULT_PORT ?? 0),"127.0.0.1",resolve));
    origin="http://127.0.0.1:"+(server.address() as {port:number}).port;
    for (const user of users) {
      const r=await fetch(origin+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:user+"@example.invalid",password})});
      expect(r.status).toBe(200);cookies.push(r.headers.getSetCookie().map(x=>x.split(";")[0]).join("; "));await r.arrayBuffer();
    }
  },60000);
  beforeEach(async()=>{
    await pool.query("UPDATE tracked_accounts SET is_active=true,access_status='has_access' WHERE id=$1",[tracks[0]]);
    await pool.query("UPDATE subscriptions SET status='active' WHERE user_id=ANY($1::varchar[])",[users]);
  });
  afterAll(async()=>{
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(pool){
      await pool.query("DELETE FROM session WHERE sess::jsonb #>> '{passport,user,id}'=ANY($1::text[])",[users]);
      await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])",[users]);
      await pool.query("DELETE FROM comments_cache WHERE post_shortcode=ANY($1::text[])",[[privateCode,publicCode]]);
      await pool.query("DELETE FROM likers_cache WHERE post_shortcode=ANY($1::text[])",[[privateCode,publicCode]]);
      await pool.query("DELETE FROM media_assets WHERE cache_key=$1",[key]);await pool.end();
    }
    await rm(cacheDir,{recursive:true,force:true});
  });
  const signed=()=>signMediaUrl(key,{userId:users[0],trackedAccountId:tracks[0]});
  it("serves signed media to its entitled owner but rejects unsigned links and copied links",async()=>{
    const good=await request(signed());expect(good.status).toBe(200);expect(Buffer.from(await good.arrayBuffer())).toEqual(imageBody);
    expect(good.headers.get("content-type")).toMatch(/^image\/png/);
    expect(good.headers.get("cache-control")).toBe("private, no-store");
    expect((await request("/api/media/"+key)).status).toBe(404);
    expect((await request(signed(),1)).status).toBe(404);
    expect((await request(signed().replace(tracks[0],tracks[1]),1)).status).toBe(404);
  });
  it("returns durable customer-bound Activity thumbnails that revoke with private access",async()=>{
    const feed=await request('/api/tracking/accounts/'+tracks[0]+'/feed');expect(feed.status).toBe(200);
    const item=(await feed.json()).items.find((entry:any)=>entry.eventType==='like');
    expect(item.thumbnailUrl).toBe(signed());
    expect((await request(item.thumbnailUrl)).status).toBe(200);
    expect((await request(item.thumbnailUrl,1)).status).toBe(404);
    await pool.query("UPDATE tracked_accounts SET access_status='pending_access' WHERE id=$1",[tracks[0]]);
    expect((await request(item.thumbnailUrl)).status).toBe(404);
  });
  it("signs public twin Activity thumbnails for the requesting customer's own row",async()=>{
    const feed=await request('/api/tracking/accounts/'+tracks[3]+'/feed',1);expect(feed.status).toBe(200);
    const item=(await feed.json()).items.find((entry:any)=>entry.eventType==='like');
    expect(new URL(item.thumbnailUrl,origin).searchParams.get('trackedAccountId')).toBe(tracks[3]);
    expect((await request(item.thumbnailUrl,1)).status).toBe(200);
    expect((await request(item.thumbnailUrl,0)).status).toBe(404);
  });
  it("serves an admin's retained media without a customer subscription while preserving customer and signed-media gates",async()=>{
    await pool.query("UPDATE users SET role='admin' WHERE id=$1",[users[1]]);
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1",[users[1]]);
    try {
      const image=await request('/api/img-proxy?url='+encodeURIComponent(assetUrl),1);
      expect(image.status).toBe(200);expect(Buffer.from(await image.arrayBuffer())).toEqual(imageBody);
      expect((await request('/api/tracking/accounts',1)).status).toBe(402);
      expect((await request('/api/media/'+key,1)).status).toBe(404);
      expect((await request(signed(),1)).status).toBe(404);
    } finally {
      await pool.query("UPDATE users SET role='user' WHERE id=$1",[users[1]]);
      await pool.query("UPDATE subscriptions SET status='active' WHERE user_id=$1",[users[1]]);
    }
  });
  it.each(['comments','likers'])("signs %s avatars for the approved owner and public twin requester only",async kind=>{
    const {enqueueMediaCacheUrls}=await import('../media-cache-jobs.js');vi.mocked(enqueueMediaCacheUrls).mockClear();
    const own=await request('/api/tracking/posts/'+privateCode+'/'+kind);expect(own.status).toBe(200);
    const ownAvatar=(await own.json()).items[0].pfpUrl;expect(ownAvatar).toBe(signed());
    expect((await request(ownAvatar)).status).toBe(200);expect((await request(ownAvatar,1)).status).toBe(404);
    const twin=await request('/api/tracking/posts/'+publicCode+'/'+kind,1);expect(twin.status).toBe(200);
    const twinAvatar=(await twin.json()).items[0].pfpUrl;
    expect(new URL(twinAvatar,origin).searchParams.get('trackedAccountId')).toBe(tracks[3]);
    expect((await request(twinAvatar,1)).status).toBe(200);
    expect(enqueueMediaCacheUrls).not.toHaveBeenCalled(); // Cache display never starts provider recovery.
    await pool.query("UPDATE tracked_accounts SET access_status='pending_access' WHERE id=$1",[tracks[0]]);
    expect((await request('/api/tracking/posts/'+privateCode+'/'+kind)).status).toBe(404);
    expect((await request(ownAvatar)).status).toBe(404);
  });
  it.each(["inactive","pending_access","access_denied","unpaid"])("revokes an issued media link when the account becomes %s",async kind=>{
    const media=signed();
    if(kind==='inactive')await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1",[tracks[0]]);
    else if(kind==='unpaid')await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1",[users[0]]);
    else await pool.query("UPDATE tracked_accounts SET access_status=$2 WHERE id=$1",[tracks[0],kind]);
    expect((await request(media)).status).toBe(kind==='unpaid'?402:404);
  });
  it("does not borrow another customer's private posts or engagement before approval",async()=>{
    const response=await request('/api/tracking/accounts/'+tracks[1]+'/posts',1);
    expect(response.status).toBe(200);expect((await response.json()).items).toEqual([]);
    expect((await request('/api/tracking/posts/'+privateCode+'/comments',1)).status).toBe(404);
    expect((await request('/api/tracking/posts/'+privateCode+'/likers',1)).status).toBe(404);
  });
  it.each(['pending_access','access_denied'])("hides previously collected private content and exports after access changes to %s",async status=>{
    const before=await (await request('/api/viewer/'+privateName)).json();
    expect(before.recentPosts).toHaveLength(1);expect(before.stories).toHaveLength(1);expect(before.highlights).toHaveLength(1);expect(before.recentLikes).toHaveLength(1);
    await pool.query("UPDATE tracked_accounts SET access_status=$2 WHERE id=$1",[tracks[0],status]);
    const postResponse=await request('/api/tracking/accounts/'+tracks[0]+'/posts');expect(postResponse.status).toBe(200);
    expect((await postResponse.json()).items).toEqual([]);
    const viewerResponse=await request('/api/viewer/'+privateName);expect(viewerResponse.status).toBe(200);
    const viewer=await viewerResponse.json();expect(viewer.igUsername).toBe(privateName);
    for(const field of ['recentPosts','stories','highlights','recentLikes'])expect(viewer[field]).toEqual([]);
    for(const route of ['feed','followers/roster','following/roster']) {
      const response=await request('/api/tracking/accounts/'+tracks[0]+'/'+route);expect(response.status).toBe(200);
      expect((await response.json()).items).toEqual([]);
    }
    expect((await request('/api/tracking/posts/'+privateCode+'/comments')).status).toBe(404);
    expect((await request('/api/tracking/posts/'+privateCode+'/likers')).status).toBe(404);
    const reportResponse=await request('/api/reports');expect(reportResponse.status).toBe(200);
    expect((await reportResponse.json()).items.map((r:any)=>r.id)).toEqual([reports[1]]);
    for(const format of ['csv','pdf'])expect((await request('/api/reports/'+reports[0]+'/'+format)).status).toBe(404);
  });
  it("keeps private viewer content on its original account even after it becomes approved",async()=>{
    const own=await request('/api/viewer/'+privateName,0);expect(own.status).toBe(200);
    const ownData=await own.json();expect(ownData.recentPosts).toHaveLength(1);expect(ownData.stories).toHaveLength(1);expect(ownData.highlights).toHaveLength(1);
    await pool.query("UPDATE tracked_accounts SET access_status='has_access' WHERE id=$1",[tracks[1]]);
    const response=await request('/api/viewer/'+privateName,1);expect(response.status).toBe(200);
    const data=await response.json();expect(data.recentPosts).toEqual([]);expect(data.stories).toEqual([]);expect(data.highlights).toEqual([]);
    await pool.query("UPDATE tracked_accounts SET access_status='pending_access' WHERE id=$1",[tracks[1]]);
  });
  it("never backfills a public requesting row from a private sibling with the same Instagram ID",async()=>{
    const response=await request('/api/tracking/accounts/'+tracks[4]+'/posts',1);expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual([]);
    const stored=await pool.query("SELECT count(*)::int AS n FROM posts_cache WHERE tracked_account_id=$1",[tracks[4]]);expect(stored.rows[0].n).toBe(0);
  });
  it("keeps the public profile avatar usable while private content awaits approval",async()=>{
    const response=await request('/api/viewer/'+privateName,1);expect(response.status).toBe(200);
    const data=await response.json();expect(data.profilePicUrl).toBe(assetUrl);expect(data.recentPosts).toEqual([]);
  });
  it.each(['has_access','pending_access'])("uses a nonempty snapshot avatar when the account URL is blank (%s)",async accessStatus=>{
    const inserted=await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,profile_pic_url,profile_pic_url_hd) VALUES($1,$2,'',$3) RETURNING id",[tracks[0],privateName,assetUrl]);
    try {
      await pool.query("UPDATE tracked_accounts SET profile_pic_url='   ',access_status=$2 WHERE id=$1",[tracks[0],accessStatus]);
      const viewer=await request('/api/viewer/'+privateName);expect(viewer.status).toBe(200);
      const data=await viewer.json();
      if(accessStatus==='has_access'){
        expect(data.profilePicUrl).toBe(signed());expect((await request(data.profilePicUrl)).status).toBe(200);
      } else {
        expect(data.profilePicUrl).toBe(assetUrl);expect(data.recentPosts).toEqual([]);expect(data.recentLikes).toEqual([]);
        expect((await request(signed())).status).toBe(404);
      }
    } finally {
      await pool.query("DELETE FROM profile_snapshots WHERE id=$1",[inserted.rows[0].id]);
      await pool.query("UPDATE tracked_accounts SET profile_pic_url=$2 WHERE id=$1",[tracks[0],assetUrl]);
    }
  });
  it("binds account-list cached avatars to each original customer row and preserves pending private metadata",async()=>{
    for (const user of [0,1]) {
      const response=await request('/api/tracking/accounts',user);expect(response.status).toBe(200);
      const accounts=await response.json();
      for (const account of accounts) {
        if(account.isPrivate&&account.accessStatus!=='has_access') {
          expect(account.profilePicUrl).toBe(assetUrl);continue;
        }
        const link=account.profilePicUrl;
        expect(new URL(link,origin).pathname).toBe('/api/media/'+key);
        expect(new URL(link,origin).searchParams.get('trackedAccountId')).toBe(account.id);
        expect((await request(link,user)).status).toBe(200);
        expect((await request(link,1-user)).status).toBe(404);
      }
    }
  });
  it("decodes the account-list avatar in Chromium after a genuine isolated customer login",async()=>{
    const { chromium }=await import('playwright');
    const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH,args:['--no-sandbox']});
    try {
      const context=await browser.newContext();
      await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
      const login=await context.request.post(origin+'/api/auth/login',{data:{email:users[0]+'@example.invalid',password}});
      expect(login.status()).toBe(200);
      const page=await context.newPage();
      await page.goto(origin+'/api/health');
      const rendered=await page.evaluate(async trackedAccountId=>{
        const response=await fetch('/api/tracking/accounts');
        const accounts=await response.json();
        const account=accounts.find((row:{id:string})=>row.id===trackedAccountId);
        const img=document.createElement('img');img.src=account.profilePicUrl;document.body.append(img);
        await img.decode();
        return {width:img.naturalWidth,height:img.naturalHeight,path:new URL(img.src).pathname};
      },tracks[2]);
      expect(rendered).toEqual({width:1,height:1,path:'/api/media/'+key});
    } finally {await browser.close();}
  },30000);
  it("queues missing eligible avatars without queuing pending private metadata or failing the account list",async()=>{
    const { enqueueMediaCacheUrls }=await import('../media-cache-jobs.js');
    const enqueue=vi.mocked(enqueueMediaCacheUrls);enqueue.mockClear();
    enqueue.mockRejectedValueOnce(new Error('fixture queue unavailable'));
    await pool.query("UPDATE media_assets SET status='failed' WHERE cache_key=$1",[key]);
    try {
      for(const user of [0,1]) {
        const response=await request('/api/tracking/accounts',user);expect(response.status).toBe(200);
        for(const account of await response.json())expect(account.profilePicUrl).toBe(assetUrl);
      }
      // Two eligible rows per customer; the pending private fifth row is excluded.
      expect(enqueue).toHaveBeenCalledTimes(4);
      for(const args of enqueue.mock.calls)expect(args).toEqual([[assetUrl],'account-list']);
    } finally {await pool.query("UPDATE media_assets SET status='cached' WHERE cache_key=$1",[key]);}
  });
  it("serves customer-bound cached dashboard report avatars for public and approved private accounts",async()=>{
    for(const track of [tracks[0],tracks[2]]) {
      const response=await request('/api/tracking/accounts/'+track+'/report');expect(response.status).toBe(200);
      const report=await response.json();const link=report.profilePicUrl;
      expect(new URL(link,origin).pathname).toBe('/api/media/'+key);
      expect(new URL(link,origin).searchParams.get('trackedAccountId')).toBe(track);
      const image=await request(link);expect(image.status).toBe(200);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(imageBody);
      expect((await request(link,1)).status).toBe(404);
      expect((await request('/api/tracking/accounts/'+track+'/report',1)).status).toBe(404);
    }
  });
  it("repairs missing report avatars while keeping pending private profile metadata unchanged",async()=>{
    const { enqueueMediaCacheUrls }=await import('../media-cache-jobs.js');
    const enqueue=vi.mocked(enqueueMediaCacheUrls);enqueue.mockClear();
    await pool.query("UPDATE media_assets SET status='failed' WHERE cache_key=$1",[key]);
    try {
      const pending=await request('/api/tracking/accounts/'+tracks[1]+'/report',1);expect(pending.status).toBe(200);
      expect((await pending.json()).profilePicUrl).toBe(assetUrl);expect(enqueue).not.toHaveBeenCalled();
      enqueue.mockRejectedValueOnce(new Error('fixture queue unavailable'));
      const publicReport=await request('/api/tracking/accounts/'+tracks[2]+'/report');expect(publicReport.status).toBe(200);
      expect((await publicReport.json()).profilePicUrl).toBe(assetUrl);
      expect(enqueue).toHaveBeenCalledExactlyOnceWith([assetUrl],'account-report');
    } finally {await pool.query("UPDATE media_assets SET status='cached' WHERE cache_key=$1",[key]);}
  });
  it("preserves public twin reuse and signs media for the requesting customer's own row",async()=>{
    const response=await request('/api/tracking/accounts/'+tracks[3]+'/posts',1);expect(response.status).toBe(200);
    const data=await response.json();expect(data.items).toHaveLength(1);
    const link=data.items[0].thumbnailUrl;expect(new URL(link,origin).searchParams.get('trackedAccountId')).toBe(tracks[3]);
    expect((await request(link,1)).status).toBe(200);expect((await request(link,0)).status).toBe(404);
  });
  it("binds duplicate media in separate reports to each report's original tracked account",async()=>{
    const response=await request('/api/reports');expect(response.status).toBe(200);
    const data=await response.json();expect(data.items).toHaveLength(2);
    const links=data.items.map((r:any)=>r.metrics.likesLeaderboard[0].thumbnails[0]);
    expect(new Set(links).size).toBe(2);
    expect(new Set(links.map((x:string)=>new URL(x,origin).searchParams.get('trackedAccountId')))).toEqual(new Set([tracks[0],tracks[2]]));
    for(const link of links){expect((await request(link)).status).toBe(200);expect((await request(link,1)).status).toBe(404);}
  });
});
