import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  const guarded = Boolean(process.env.STRESS_NONCE) && parsed.port !== "5432" &&
    (process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(parsed.port);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" ||
      !["127.0.0.1", "localhost"].includes(parsed.hostname) || !guarded) {
    throw new Error("Guarded isolated admin content database required");
  }
  process.env.DATABASE_URL = url;
  process.env.WORKERS_DISABLED = "1";
  process.env.LIKE_EVENT_WINDOW = "observed";
  delete process.env.STRIPE_SECRET_KEY;
}
const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../../workers.js", () => ({ collectionProfileQueue: { add: enqueue }, getQueues: () => ({}) }));
vi.mock("../media-cache-jobs.js", () => ({ enqueueMediaCacheUrls: enqueue }));

(url ? describe : describe.skip)("admin collected content — real HTTP and isolated PostgreSQL", () => {
  let pool: typeof import("../../db.js").pool;
  let server: Server;
  let origin: string;
  const owner = randomUUID(), otherOwner = randomUUID();
  const canonical = randomUUID(), twin = randomUUID(), privateA = randomUUID(), privateB = randomUUID(), paused = randomUUID();
  const name = "content_" + canonical.replaceAll("-", "");
  const baseline = new Date("2026-01-01T00:00:00Z"), detected = new Date("2026-01-06T00:00:00Z");
  const shortcode = "Fixture" + canonical.replaceAll("-", "");
  const get = async (id: string, path: string, role = "admin") => {
    const response = await fetch(`${origin}/api/admin/tracked-accounts/${id}${path}`, { headers: { "x-fixture-role": role } });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  };
  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    for (const id of [owner, otherOwner]) {
      await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Content fixture')", [id, id + "@example.invalid"]);
      await pool.query(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end)
        VALUES($1,$2,$3,'active','standard',now()+interval '1 day')`, [id, "cus_fixture_" + id, "sub_fixture_" + id]);
    }
    for (const [index, id] of [canonical, twin, privateA, privateB, paused].entries()) {
      const isPrivate = id === privateA || id === privateB;
      await pool.query(`INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,is_private,access_status,is_active,tracking_started,following_first_complete_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, id === privateB ? otherOwner : owner,
        id === paused ? name + "_paused" : name, id === paused ? paused : canonical,
        isPrivate, isPrivate ? "has_access" : "public", id !== paused, new Date(baseline.getTime() + index * 1000), baseline]);
    }
    for (const id of [canonical, privateA, privateB, paused]) {
      await pool.query(`INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,following_count,post_count,snapshot_at)
        VALUES($1,$2,12,8,30,$3)`, [id, name, detected]);
      await pool.query(`INSERT INTO posts_cache(tracked_account_id,shortcode,post_type,thumbnail_url,display_url,like_count,comment_count,taken_at,cached_at,is_pinned)
        SELECT $1,$2 || '_' || n,CASE WHEN n%2=0 THEN 'photo'::post_type ELSE 'reel'::post_type END,
        'https://scontent.cdninstagram.com/fixture.jpg',NULL,4,3,$3,$4,n=29 FROM generate_series(0,29) n`, [id, id === canonical ? shortcode : id.replaceAll("-", ""), detected, baseline]);
    }
    await pool.query(`INSERT INTO stories_cache(tracked_account_id,story_id,media_type,media_url,taken_at,expires_at,cached_at) VALUES
      ($1,'active','image','https://scontent.cdninstagram.com/story.jpg',now(),now()+interval '1 hour',$2),
      ($1,'expired','image','https://scontent.cdninstagram.com/expired.jpg',now()-interval '2 days',now()-interval '1 day',$2)`, [canonical, baseline]);
    const highlightId = randomUUID();
    await pool.query("INSERT INTO highlights_cache(id,tracked_account_id,highlight_id,title,media_count,cached_at) VALUES($1,$2,'highlight','Fixture highlight',1,$3)", [highlightId, canonical, baseline]);
    await pool.query("INSERT INTO highlight_items_cache(highlight_cache_id,story_id,media_type,media_url,taken_at,cached_at) VALUES($1,'highlight_item','image','https://scontent.cdninstagram.com/highlight.jpg',$2,$3)", [highlightId, baseline, detected]);
    await pool.query(`INSERT INTO comments_cache(post_shortcode,ig_comment_pk,author_username,text) VALUES($1,'1','commenter','Collected comment')`, [shortcode + "_0"]);
    await pool.query(`INSERT INTO likers_cache(post_shortcode,liker_username) VALUES($1,'liker')`, [shortcode + "_0"]);
    for (const id of [canonical, privateA, privateB]) {
      await pool.query("INSERT INTO roster_sync_state(tracked_account_id,dimension,settled_at,last_success_at,last_complete_read_at) VALUES($1,'following',$2,$3,$3)", [id, baseline, detected]);
      await pool.query(`INSERT INTO roster_members(tracked_account_id,dimension,username,username_lower,is_current,left_at) VALUES
        ($1,'following','CurrentA','currenta',true,NULL),($1,'following','CurrentB','currentb',true,NULL),
        ($1,'following','Gone','gone',false,$2)`, [id, detected]);
      await pool.query(`INSERT INTO follow_events(tracked_account_id,followed_username,detected_at) VALUES
        ($1,'real_follow',$2),($1,'seed_noise',$3)`, [id, detected, new Date("2025-01-01")]);
      await pool.query("INSERT INTO like_events(tracked_account_id,post_id,owner_username,detected_at) VALUES($1,'shared_like','fixture_owner',$2)", [id, detected]);
    }
    await pool.query("INSERT INTO like_events(tracked_account_id,post_id,owner_username,detected_at) VALUES($1,'twin_only','fixture_owner',$2)", [twin, detected]);
    const app = express();
    app.use((req, _res, next) => {
      const role = req.get("x-fixture-role");
      req.isAuthenticated = (() => role === "admin" || role === "user") as typeof req.isAuthenticated;
      if (req.isAuthenticated()) req.user = { id: owner, role } as Express.User;
      next();
    });
    (await import("../../admin-routes.js")).registerAdminRoutes(app);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(Number(process.env.STRESS_FAULT_PORT), "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30_000);
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (pool) {
      await pool.query("DELETE FROM comments_cache WHERE post_shortcode=$1", [shortcode + "_0"]);
      await pool.query("DELETE FROM likers_cache WHERE post_shortcode=$1", [shortcode + "_0"]);
      await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [[owner, otherOwner]]);
      await pool.end();
    }
  });
  it("requires authentication and the admin role", async () => {
    expect((await get(canonical, "/content", "anonymous")).status).toBe(401);
    expect((await get(canonical, "/content", "user")).status).toBe(403);
  });
  it("returns collected customer media from the canonical public row, with real per-dimension dates", async () => {
    const result = await get(twin, "/content");
    expect(result.status).toBe(200); expect(result.cache).toBe("private, no-store");
    expect(result.body).toMatchObject({ access: { allowed: true, reason: null }, postsTotal: 30,
      postCounts: { all: 30, photo: 15, reel: 15, video: 0, carousel: 0 } });
    expect(result.body.viewer.recentPosts).toHaveLength(24);
    expect(result.body.viewer.recentPosts[0].shortcode).toBe(shortcode + "_29");
    expect(result.body.viewer.stories.map((item: { storyId: string }) => item.storyId)).toEqual(["active"]);
    expect(result.body.viewer.highlights[0].items[0].storyId).toBe("highlight_item");
    expect(result.body.viewer.contentCachedAt).toEqual({ posts: baseline.toISOString(), stories: baseline.toISOString(), highlights: detected.toISOString() });
    expect(result.body.viewer.cachedAt).toBe(detected.toISOString());
    expect(result.body.viewer.postsCollection).toMatchObject({ state: "available", savedTotal: 30,
      recordedProfileCount: 30, recordedProfileAt: detected.toISOString(), lastPostsReadAt: null,
      source: "shared_public_profile", trackingActive: true });
  });
  it("paginates deterministically including pinned and tied-time posts and filtered types", async () => {
    const first = await get(twin, "/posts?limit=24");
    const last = await get(twin, "/posts?limit=24&offset=24");
    expect(first.body.hasMore).toBe(true); expect(last.body.hasMore).toBe(false);
    expect(new Set([...first.body.items, ...last.body.items].map(row => row.shortcode)).size).toBe(30);
    const photos = await get(twin, "/posts?postType=photo&offset=10&limit=10");
    expect(photos.body.items).toHaveLength(5);
    expect(photos.body.postsCollection).toMatchObject({ savedTotal: 30, recordedProfileCount: 30, source: "shared_public_profile" });
    expect(photos.body.items.every((row: { postType: string }) => row.postType === "photo")).toBe(true);
    expect((await get(twin, "/posts?offset=999999")).body).toMatchObject({ items: [], hasMore: false });
  });
  it("authorizes cached engagement by the selected target's own post", async () => {
    const comments = await get(twin, `/posts/${shortcode}_0/comments`);
    expect(comments.body).toMatchObject({ total: 1, expectedTotal: 3, isPartial: true,
      items: [{ author: "commenter", text: "Collected comment" }] });
    expect((await get(twin, `/posts/${shortcode}_0/likers`)).body).toMatchObject({ total: 1, expectedTotal: 4, isPartial: true });
    expect((await get(privateA, `/posts/${shortcode}_0/comments`)).status).toBe(404);
  });
  it("returns materialized roster pages, excludes departed members and reports actual completeness", async () => {
    const result = await get(twin, "/roster?dimension=following&limit=1");
    expect(result.body).toMatchObject({ total: 2, expectedTotal: 8, hasMore: true, baselineSettled: true, isPartial: true, syncState: "capped" });
    const next = await get(twin, "/roster?dimension=following&limit=1&offset=1");
    expect(next.body.items[0].username).not.toBe(result.body.items[0].username);
    expect(next.body.hasMore).toBe(false);
    expect(Object.keys(result.body.items[0]).sort()).toEqual(["displayName", "igUserId", "pfpUrl", "username"]);
  });
  it("scopes activity before dedupe, retaining private row evidence and suppressing seeded follows", async () => {
    const pub = await get(twin, "/activity");
    expect(pub.body.total).toBe(4); // union likes + canonical follow + confirmed departure
    expect(pub.body.items.some((row: { followedUsername?: string }) => row.followedUsername === "seed_noise")).toBe(false);
    const priv = await get(privateB, "/activity");
    expect(priv.body.total).toBe(3);
    expect(priv.body.items.every((row: { trackedAccountId: string }) => row.trackedAccountId === privateB)).toBe(true);
    expect(priv.body.items.some((row: Record<string, unknown>) => "userEmail" in row || "userId" in row)).toBe(false);
  });
  it("isolates private content and liked posts from public and other customer twins", async () => {
    const content = await get(privateB, "/content");
    expect(content.body.viewer.recentPosts.every((row: { shortcode: string }) => row.shortcode.startsWith(privateB.replaceAll("-", "")))).toBe(true);
    expect(content.body.viewer.stories).toEqual([]);
    expect((await get(privateB, "/liked-posts")).body.total).toBe(1);
  });
  it("denies every private child endpoint immediately after grant revocation", async () => {
    await pool.query("UPDATE tracked_accounts SET access_status='pending_access' WHERE id=$1", [privateA]);
    try {
      expect((await get(privateA, "/content")).body).toMatchObject({ viewer: null, access: { allowed: false, reason: "private_access_required" } });
      for (const path of ["/posts", "/roster?dimension=follower", "/activity", "/liked-posts", "/posts/none/likers", "/posts/none/comments"]) {
        expect((await get(privateA, path)).status, path).toBe(403);
      }
    } finally { await pool.query("UPDATE tracked_accounts SET access_status='has_access' WHERE id=$1", [privateA]); }
  });
  it("gates paused and unentitled private rows but preserves public cached history", async () => {
    await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1", [privateB]);
    expect((await get(privateB, "/content")).body.access.reason).toBe("tracking_inactive");
    await pool.query("UPDATE tracked_accounts SET is_active=true WHERE id=$1", [privateB]);
    await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1", [otherOwner]);
    try { expect((await get(privateB, "/content")).body.access.reason).toBe("subscription_required"); }
    finally { await pool.query("UPDATE subscriptions SET status='active' WHERE user_id=$1", [otherOwner]); }
    expect((await get(paused, "/content")).body).toMatchObject({ access: { allowed: true }, postsTotal: 30 });
  });
  it("rejects unknown targets, malformed pages and unsupported dimensions", async () => {
    expect((await get(randomUUID(), "/liked-posts")).status).toBe(404);
    expect((await get(randomUUID(), "/content")).status).toBe(404);
    expect((await get("invalid", "/content")).status).toBe(400);
    for (const path of ["/posts?limit=0", "/posts?offset=-1", "/posts?limit=1.5", "/posts?postType=unknown", "/roster?dimension=unknown"]) {
      expect((await get(twin, path)).status, path).toBe(400);
    }
  });
  it("uses snapshot metadata when a stored account avatar is blank", async () => {
    await pool.query("UPDATE tracked_accounts SET profile_pic_url=' ', display_name='' WHERE id=$1", [twin]);
    await pool.query("UPDATE profile_snapshots SET profile_pic_url='https://scontent.cdninstagram.com/avatar.jpg',full_name='Saved name' WHERE tracked_account_id=$1", [canonical]);
    const result = await get(twin, "");
    expect(result.body.account).toMatchObject({ profilePicUrl: "https://scontent.cdninstagram.com/avatar.jpg", displayName: "Saved name" });
    expect((await get(twin, "/content")).body.viewer.profilePicUrl).toBe("https://scontent.cdninstagram.com/avatar.jpg");
  });
  it("keeps legacy story/tagged post types in All without invalid filter counters", async () => {
    await pool.query("UPDATE posts_cache SET post_type='tagged_post' WHERE tracked_account_id=$1 AND shortcode=$2", [canonical, shortcode + "_0"]);
    const content = await get(twin, "/content");
    expect(content.body).toMatchObject({ postsTotal: 30, postCounts: { all: 30, photo: 14, reel: 15 } });
    expect(Object.keys(content.body.postCounts).sort()).toEqual(["all", "carousel", "photo", "reel", "video"]);
    expect(content.body.viewer.recentPosts.some((row: { postType: string }) => row.postType === "tagged_post")).toBe(true);
  });
  it("represents an unobserved roster count as unknown rather than reported zero", async () => {
    await pool.query("DELETE FROM profile_snapshots WHERE tracked_account_id=$1", [paused]);
    const result = await get(paused, "/roster?dimension=following");
    expect(result.body).toMatchObject({ expectedTotal: null, syncState: "unknown", isPartial: true, total: 0 });
  });
  it("does not enqueue collection or media refresh when an admin browses collected evidence", () => {
    expect(enqueue).not.toHaveBeenCalled();
  });
});
