// Real customer HTTP handlers and isolated PostgreSQL. Upstream and queue writes are mocked.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const databaseUrl = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/cheaterfinder_backend_fix_test_20260907" || !process.env.STRESS_NONCE) throw new Error("Isolated runner required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.WORKERS_DISABLED = "1";
}
const boundary = vi.hoisted(() => ({ upstream: vi.fn(async () => { throw new Error("Provider calls are forbidden in this fixture"); }), enqueue: vi.fn(async () => {}) }));
vi.mock("../public-read-client.js", () => ({ maybeRevalidateTier1: vi.fn(), fetchPublicProfileTier1: vi.fn() }));
vi.mock("../media-cache-jobs.js", async original => ({ ...await original<typeof import("../media-cache-jobs.js")>(), enqueueMediaCacheUrls: boundary.enqueue }));
vi.mock("../../ig-public-scraper.js", async original => ({ ...await original<typeof import("../../ig-public-scraper.js")>(), scrapeUserPostsPage: boundary.upstream, scrapeUserPostsPageWithBot: boundary.upstream }));
const users = Array.from({ length: 4 }, () => randomUUID());
const canonical = randomUUID(), twin = randomUUID(), privateOwner = randomUUID(), privatePending = randomUUID(), inactive = randomUUID();
const username = "posts_" + randomUUID().replaceAll("-", "").slice(0, 18), privateName = username + "p";
const now = new Date(), day = 86400000;
(databaseUrl ? describe : describe.skip)("customer canonical saved-post filters — real HTTP/DB", () => {
  let pool: typeof import("../../db.js").pool, server: Server, origin: string;
  const get = async (path: string, user = users[1]) => {
    const response = await fetch(origin + path, { headers: { "x-fixture-user": user } });
    return { status: response.status, body: await response.json() };
  };
  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    for (let i = 0; i < users.length; i++) {
      await pool.query("INSERT INTO users(id,email,name,hashed_password) VALUES($1,$2,'Posts fixture','unused')", [users[i], users[i] + "@example.invalid"]);
      if (i < 3) await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end) VALUES($1,$2,$3,'active','standard',now()+interval '1 day')", [users[i], "cus_" + users[i], "sub_" + users[i]]);
    }
    const accounts = [
      [canonical, users[0], username, canonical, false, "public", new Date(+now - 3 * day), true],
      [twin, users[1], username, canonical, false, "public", new Date(+now - day), true],
      [privateOwner, users[0], privateName, privateOwner, true, "has_access", new Date(+now - 3 * day), true],
      [privatePending, users[1], privateName, privateOwner, true, "pending_access", new Date(+now - day), true],
      [inactive, users[1], username + "i", inactive, false, "public", now, false],
    ];
    for (const row of accounts) await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,is_private,access_status,tracking_started,is_active,posts_pagination_done) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false)", row);
    for (const id of [canonical, twin]) await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,post_count,snapshot_at) VALUES($1,$2,80,$3)", [id, username, now]);
    // First All preview contains only photos. Every reel is older and must still be discoverable.
    for (let i = 0; i < 51; i++) await pool.query("INSERT INTO posts_cache(tracked_account_id,shortcode,post_type,taken_at,cached_at) VALUES($1,$2,$3,$4,$5)",
      [canonical, "post_" + i.toString().padStart(2, "0"), i < 24 ? "photo" : "reel", new Date(+now - i * 60000), now]);
    await pool.query("INSERT INTO posts_cache(tracked_account_id,shortcode,post_type,taken_at) VALUES($1,'private_only','reel',now())", [privateOwner]);
    const app = express();
    app.use((req, _res, next) => { req.user = { id: String(req.headers["x-fixture-user"]), role: "user" } as Express.User; req.isAuthenticated = (() => true) as typeof req.isAuthenticated; next(); });
    server = createServer(app);
    await (await import("../../routes.js")).registerRoutes(server, app);
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: "Fixture internal error" }));
    await new Promise<void>(resolve => server.listen(Number(process.env.STRESS_FAULT_PORT), "127.0.0.1", resolve));
    origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  }, 60000);
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (pool) { await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [users]); await pool.end(); }
  });
  it("finds older reels before limiting the preview and reports full saved totals", async () => {
    const all = await get("/api/viewer/" + username);
    expect(all.status).toBe(200); expect(all.body.recentPosts).toHaveLength(24);
    expect(all.body.recentPosts.every((post: any) => post.postType === "photo")).toBe(true);
    const reels = await get("/api/viewer/" + username + "?postType=reel");
    expect(reels.status).toBe(200); expect(reels.body.recentPosts).toHaveLength(24);
    expect(reels.body.recentPosts[0].shortcode).toBe("post_24");
    expect(reels.body).toMatchObject({ postsTotal: 51, postCount: 80, postCounts: { all: 51, photo: 24, reel: 27, video: 0, carousel: 0 }, weeklyStats: { totalPosts: 27 }, postsCollection: { savedTotal: 51, recordedProfileCount: 80 } });
  });
  it("pages the filtered canonical cache without requesting upstream history", async () => {
    const first = await get(`/api/tracking/accounts/${twin}/posts?postType=reel&offset=0&limit=24`);
    const second = await get(`/api/tracking/accounts/${twin}/posts?postType=reel&offset=24&limit=12`);
    expect(first.status).toBe(200); expect(first.body).toMatchObject({ total: 27, postsTotal: 51, hasMore: true });
    expect(second.status).toBe(200); expect(second.body).toMatchObject({ total: 27, postsTotal: 51, hasMore: false, offset: 24 });
    expect(second.body.items.map((post: any) => post.shortcode)).toEqual(["post_48", "post_49", "post_50"]);
    expect(new Set([...first.body.items, ...second.body.items].map((post: any) => post.shortcode)).size).toBe(27);
    expect(boundary.upstream).not.toHaveBeenCalled();
  });
  it("does not combine a twin's older profile count with canonical collection evidence", async () => {
    await pool.query("UPDATE profile_snapshots SET post_count=0 WHERE tracked_account_id=$1", [twin]);
    try {
      const result = await get("/api/viewer/" + username + "?postType=reel");
      expect(result.body.postsCollection).toMatchObject({ savedTotal: 51, recordedProfileCount: 80, source: "shared_public_profile" });
      expect(result.body.postsTotal).toBe(51);
    } finally { await pool.query("UPDATE profile_snapshots SET post_count=80 WHERE tracked_account_id=$1", [twin]); }
  });
  it("an empty type is a saved-cache result, preserves other totals, and does not exhaust history", async () => {
    const result = await get(`/api/tracking/accounts/${twin}/posts?postType=video&offset=0&limit=12`);
    expect(result.body).toMatchObject({ items: [], total: 0, postsTotal: 51, hasMore: false, postCounts: { reel: 27 } });
    const viewer = await get("/api/viewer/" + username + "?postType=video");
    expect(viewer.body).toMatchObject({ recentPosts: [], dataSource: "cached", postsTotal: 51, contentCachedAt: { posts: now.toISOString() } });
    expect((await pool.query("SELECT posts_pagination_done FROM tracked_accounts WHERE id=$1", [canonical])).rows[0].posts_pagination_done).toBe(false);
    expect(boundary.upstream).not.toHaveBeenCalled();
  });
  it("does not expose another customer's posts or inactive/unentitled targets", async () => {
    expect((await get(`/api/tracking/accounts/${twin}/posts?postType=reel`, users[2])).status).toBe(404);
    expect((await get(`/api/tracking/accounts/${inactive}/posts?postType=reel`)).status).toBe(404);
    expect((await get(`/api/tracking/accounts/${twin}/posts?postType=reel`, users[3])).status).toBe(402);
    expect((await get("/api/viewer/" + username, users[2])).status).toBe(404);
  });
  it("pending private tracking cannot borrow an approved customer's matching private cache", async () => {
    const result = await get(`/api/tracking/accounts/${privatePending}/posts?postType=reel`);
    expect(result.body).toMatchObject({ items: [], hasMore: false });
    expect(result.body.postsTotal).toBeUndefined();
    const viewer = await get("/api/viewer/" + privateName + "?postType=reel");
    expect(viewer.body).toMatchObject({ recentPosts: [], postsCollection: { state: "waiting_for_access", savedTotal: null } });
    expect(boundary.upstream).not.toHaveBeenCalled();
  });
  it("approved private filtered pages stay on the original customer row", async () => {
    const result = await get(`/api/tracking/accounts/${privateOwner}/posts?postType=reel`, users[0]);
    expect(result.body).toMatchObject({ total: 1, postsTotal: 1, hasMore: false });
    expect(result.body.items.map((post: any) => post.shortcode)).toEqual(["private_only"]);
    expect(boundary.upstream).not.toHaveBeenCalled();
  });
});
