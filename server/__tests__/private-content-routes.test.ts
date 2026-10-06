// Execute the production route handlers with DB and transport boundaries mocked.
// Importing routes.ts starts queues; extracting registrations avoids live services.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");
function extract(start: string, end: string): string {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Missing route boundary: ${start}`);
  return source.slice(from, to);
}
const code = transformSync([
  extract("function privateContentUnavailable(", "// Private engagement uses"),
  extract("async function findGrantedPostBot(", "// Fix #14:"),
  extract("  // GET /api/tracking/accounts/:id/feed", "  // GET /api/tracking/accounts/:id/access-status"),
  extract("  // GET /api/tracking/accounts/:id/followers/roster", "  // GET /api/tracking/accounts/:id/posts?"),
  extract("  // GET /api/tracking/accounts/:id/posts?", "  // GET /api/tracking/posts/:shortcode/comments"),
  extract("  // GET /api/tracking/posts/:shortcode/comments", "  // POST /api/tracking/accounts/:id/retry-access"),
  extract("  // POST /api/tracking/accounts/:id/retry-access", "  // ══════════════════════════════════════════════════════════════════════════\n  // ACCOUNT ROUTES"),
  extract("  // GET /api/viewer/:username", "  // ══════════════════════════════════════════════════════════════════════════\n  // STRIPE WEBHOOK"),
].join("\n"), { loader: "ts", format: "cjs" }).code;

function fixture(selectRows: unknown[][]) {
  const handlers = new Map<string, Function>();
  const updates: Record<string, unknown>[] = [];
  const table = new Proxy({}, { get: (_t, key) => String(key) });
  const select = vi.fn(() => {
    let used: Promise<unknown[]> | undefined;
    const chain: any = {
      from: () => chain, innerJoin: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain,
      then: (resolve: Function, reject: Function) => (used ??= Promise.resolve(selectRows.shift() ?? [])).then(resolve as any, reject as any),
    };
    return chain;
  });
  const ctx: any = {
    app: { get: (path: string, ...fns: Function[]) => handlers.set(path, fns.at(-1)!), post: (path: string, ...fns: Function[]) => handlers.set(path, fns.at(-1)!) },
    isAuthenticated: () => {}, db: { select, update: () => ({ set: (value: any) => ({ where: async () => { updates.push(value); } }) }) },
    trackedAccounts: table, postsCache: table, commentsCache: table, likersCache: table, botFollowRequests: table, profileSnapshots: table,
    eq: () => true, and: () => true, or: () => true, asc: () => true, desc: () => true, inArray: () => true, sql: () => true,
    firstParam: (v: unknown) => v, pinnedFirstPosts: (posts: unknown[]) => posts,
    ROSTER_ENUMERABLE_CAP: 10000, parsePagination: () => ({ limit: 12, offset: 0 }),
    validateTimezone: () => "UTC", parsePostTypeFilter: (value: string) => ["photo", "video", "reel", "carousel"].includes(value) ? value : "all", maybeRevalidateTier1: vi.fn(),
    buildFollowersRoster: vi.fn(), buildFollowingRoster: vi.fn(), readBackgroundRosterView: vi.fn(),
    canonicalTwinId: vi.fn(async (id: string) => id), findGrantedBotId: vi.fn(async () => "approved-bot"),
    postOwnedByUserOrTwinSql: () => true, interactiveScrapeEnabled: true,
    refreshEngagementOnce: vi.fn(async (_id: string, _kind: string, fn: Function) => fn()),
    scrapeUserPostsPage: vi.fn(async () => ({ posts: [], nextMaxId: null, moreAvailable: false })),
    scrapeUserPostsPageWithBot: vi.fn(async () => ({ posts: [], nextMaxId: null, moreAvailable: false })),
    getPostComments: vi.fn(async () => ({ ok: true, data: [] })), getPostCommentsAsBot: vi.fn(async () => ({ ok: true, data: [] })),
    getPostLikers: vi.fn(async () => ({ ok: true, data: [] })), getPostLikersAsBot: vi.fn(async () => ({ ok: true, data: [] })),
    backfillPostsFromSiblings: vi.fn(async () => {}), persistPosts: vi.fn(async () => {}), persistComments: vi.fn(async () => {}), persistLikers: vi.fn(async () => {}),
    resolveCachedMediaUrls: vi.fn(async () => new Map()), enqueueMediaCacheUrls: vi.fn(async () => {}),
    rotateBotForTrackedAccount: vi.fn(async () => null), assignBotToTrackedAccount: vi.fn(async () => null), botFollowRequestQueue: { add: vi.fn(async () => {}) },
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const res: any = { statusCode: 200, payload: undefined, status(n: number) { this.statusCode = n; return this; }, json(data: unknown) { this.payload = data; }, set() {} };
  async function call(path: string, query: Record<string, string> = {}) {
    await handlers.get(path)!({ user: { id: "customer" }, params: { id: "account", shortcode: "ABC", username: "target" }, query }, res);
    return res;
  }
  return { ctx, call, res, updates };
}
const account = { id: "account", igUserId: "123", isPrivate: true, isActive: true, accessStatus: "has_access", postsPaginationDone: false, postsNextCursor: "older-page" };

describe("private account posts pagination", () => {
  it.each(["pending_access", "access_denied"])("does not read retained post caches when private access is %s", async accessStatus => {
    const f = fixture([[{ ...account, accessStatus }], [{ shortcode: "old-private", caption: "private retained caption" }]]);
    await f.call("/api/tracking/accounts/:id/posts", { limit: "9", offset: "2" });
    expect(f.res.payload).toEqual({ items: [], offset: 2, limit: 9, hasMore: false });
    expect(f.ctx.db.select).toHaveBeenCalledTimes(1);
    expect(f.ctx.findGrantedBotId).not.toHaveBeenCalled();
    expect(f.ctx.resolveCachedMediaUrls).not.toHaveBeenCalled();
    expect(f.ctx.scrapeUserPostsPageWithBot).not.toHaveBeenCalled();
    expect(f.ctx.scrapeUserPostsPage).not.toHaveBeenCalled();
  });
  it("uses the requesting account's approved bot for older private posts", async () => {
    const f = fixture([[account], [], []]);
    await f.call("/api/tracking/accounts/:id/posts");
    expect(f.ctx.findGrantedBotId).toHaveBeenCalledWith("account");
    expect(f.ctx.scrapeUserPostsPageWithBot).toHaveBeenCalledWith("approved-bot", "123", { maxId: "older-page", count: 24 });
    expect(f.ctx.scrapeUserPostsPage).not.toHaveBeenCalled();
    expect(f.ctx.backfillPostsFromSiblings).not.toHaveBeenCalled();
    expect(f.res.statusCode).toBe(200);
  });
  it("keeps the cursor retryable when no healthy accepted bot is available", async () => {
    const f = fixture([[account], [], []]); f.ctx.findGrantedBotId.mockResolvedValue(null);
    await f.call("/api/tracking/accounts/:id/posts");
    expect(f.ctx.scrapeUserPostsPageWithBot).not.toHaveBeenCalled();
    expect(f.ctx.scrapeUserPostsPage).not.toHaveBeenCalled();
    expect(f.updates).toEqual([]);
    expect(f.res.payload.hasMore).toBe(true);
  });
  it("preserves the existing public posts path", async () => {
    const f = fixture([[{ ...account, isPrivate: false }], [], [], []]);
    await f.call("/api/tracking/accounts/:id/posts");
    expect(f.ctx.scrapeUserPostsPage).toHaveBeenCalled();
    expect(f.ctx.findGrantedBotId).not.toHaveBeenCalled();
  });
  it("keeps a failed private read retryable without changing pagination state", async () => {
    const f = fixture([[account], [], []]); f.ctx.scrapeUserPostsPageWithBot.mockRejectedValue(new Error("cooldown"));
    await f.call("/api/tracking/accounts/:id/posts");
    expect(f.updates).toEqual([]); expect(f.res.payload.hasMore).toBe(true);
    expect(f.ctx.scrapeUserPostsPage).not.toHaveBeenCalled();
  });
  it.each([
    { label: "missing cursor", nextMaxId: null, posts: [{ shortcode: "new-page" }] },
    { label: "repeated stored cursor", nextMaxId: "older-page", posts: [{ shortcode: "new-page" }] },
    { label: "empty continuation", nextMaxId: "next-page", posts: [] },
  ])("keeps public history retryable on $label", async ({ nextMaxId, posts }) => {
    const f = fixture([[{ ...account, isPrivate: false }], [], [], []]);
    f.ctx.scrapeUserPostsPage.mockResolvedValue({ posts, nextMaxId, moreAvailable: true });
    await f.call("/api/tracking/accounts/:id/posts");
    expect(f.ctx.scrapeUserPostsPage).toHaveBeenCalledTimes(1);
    expect(f.ctx.persistPosts).not.toHaveBeenCalled();
    expect(f.updates).toEqual([]);
    expect(f.res.payload.hasMore).toBe(true);
    expect(f.res.statusCode).toBe(200);
  });
  it("stops a cursor cycle across older private pages without declaring exhaustion", async () => {
    const f = fixture([[account], [], []]);
    f.ctx.scrapeUserPostsPageWithBot
      .mockResolvedValueOnce({ posts: [{ shortcode: "one" }], nextMaxId: "next-page", moreAvailable: true })
      .mockResolvedValueOnce({ posts: [{ shortcode: "two" }], nextMaxId: "older-page", moreAvailable: true });
    await f.call("/api/tracking/accounts/:id/posts");
    expect(f.ctx.scrapeUserPostsPageWithBot).toHaveBeenCalledTimes(2);
    expect(f.ctx.persistPosts).toHaveBeenCalledTimes(1);
    expect(f.updates).toEqual([]);
    expect(f.res.payload.hasMore).toBe(true);
  });
  it("accepts an explicitly terminal empty history page and clears its cursor", async () => {
    const f = fixture([[account], [], []]);
    f.ctx.scrapeUserPostsPageWithBot.mockResolvedValue({ posts: [], nextMaxId: "ignored-terminal-cursor", moreAvailable: false });
    await f.call("/api/tracking/accounts/:id/posts");
    expect(f.updates).toEqual([expect.objectContaining({ postsNextCursor: null, postsPaginationDone: true })]);
    expect(f.res.payload.hasMore).toBe(false);
  });
});

describe("private cached reads after grant revocation", () => {
  it.each(["followers", "following"])("returns an empty restricted %s roster before consulting private caches", async dimension => {
    const f = fixture([[{ ...account, accessStatus: "pending_access" }]]);
    await f.call(`/api/tracking/accounts/:id/${dimension}/roster`);
    expect(f.res.payload).toMatchObject({ items: [], total: 0, nextCursor: null, syncState: "restricted", isPartial: true });
    expect(f.ctx.db.select).toHaveBeenCalledTimes(1);
    expect(f.ctx.canonicalTwinId).not.toHaveBeenCalled();
    expect(f.ctx.buildFollowersRoster).not.toHaveBeenCalled();
    expect(f.ctx.buildFollowingRoster).not.toHaveBeenCalled();
    expect(f.ctx.readBackgroundRosterView).not.toHaveBeenCalled();
  });

  it("does not expose old private activity through the feed", async () => {
    const f = fixture([[{ ...account, accessStatus: "access_denied" }]]);
    await f.call("/api/tracking/accounts/:id/feed");
    expect(f.res.payload).toEqual({ items: [], limit: 12, offset: 0 });
    expect(f.ctx.db.select).toHaveBeenCalledTimes(1);
    expect(f.ctx.canonicalTwinId).not.toHaveBeenCalled();
  });

  it.each(["pending_access", "access_denied"])("retains public profile metadata but reads no private viewer content when %s", async accessStatus => {
    const f = fixture([[{ ...account, accessStatus, displayName: "Public profile", profilePicUrl: "https://cdninstagram.com/avatar.jpg" }],
      [{ fullName: "Public name", followerCount: 12, followingCount: 9, postCount: 3 }],
      [{ shortcode: "private-retained-post" }]]);
    await f.call("/api/viewer/:username");
    expect(f.res.payload).toMatchObject({ displayName: "Public profile", profilePicUrl: "https://cdninstagram.com/avatar.jpg", followerCount: 12, followingCount: 9,
      recentPosts: [], stories: [], highlights: [], recentLikes: [], recentFollows: [], recentFollowers: [], recentUnfollows: [], recentFollowerUnfollows: [],
      topNiche: null, peakActivityHour: null,
      weeklyStats: { totalLikes: 0, totalFollows: 0, totalUnfollows: 0, totalPosts: 0 }, dataSource: "none" });
    expect(f.ctx.db.select).toHaveBeenCalledTimes(2);
    expect(f.ctx.canonicalTwinId).not.toHaveBeenCalled();
    expect(f.ctx.resolveCachedMediaUrls).not.toHaveBeenCalled();
    expect(f.ctx.enqueueMediaCacheUrls).not.toHaveBeenCalled();
    expect(f.ctx.readBackgroundRosterView).not.toHaveBeenCalled();
  });
});

describe("private post engagement refresh", () => {
  it.each([["comments", "getPostComments"], ["likers", "getPostLikers"]])("pins %s to the requesting customer's grant", async (kind, name) => {
    const f = fixture([[{ trackedAccountId: "account", igUserId: "123", isPrivate: true, mediaId: "99", commentCount: 0, likeCount: 0 }], [{ id: "account" }], []]);
    await f.call(`/api/tracking/posts/:shortcode/${kind}`, { refresh: "true" });
    expect(f.ctx.findGrantedBotId).toHaveBeenCalledWith("account");
    expect(f.ctx[name + "AsBot"]).toHaveBeenCalledWith("ABC", "99", "approved-bot");
    expect(f.ctx[name]).not.toHaveBeenCalled(); expect(f.res.statusCode).toBe(200);
  });
  it.each([["comments", "getPostComments"], ["likers", "getPostLikers"]])("never falls back to a random bot for private %s", async (kind, name) => {
    const f = fixture([[{ trackedAccountId: "account", igUserId: "123", isPrivate: true, mediaId: "99" }], [{ id: "account" }], []]);
    f.ctx.findGrantedBotId.mockResolvedValue(null);
    await f.call(`/api/tracking/posts/:shortcode/${kind}`, { refresh: "true" });
    expect(f.ctx[name + "AsBot"]).not.toHaveBeenCalled(); expect(f.ctx[name]).not.toHaveBeenCalled();
    expect(f.res.statusCode).toBe(200);
  });
});

describe("private access customer retry", () => {
  it("preserves approved access without resetting or sending another request", async () => {
    const f = fixture([[account]]); await f.call("/api/tracking/accounts/:id/retry-access");
    expect(f.res.payload.status).toBe("has_access"); expect(f.updates).toEqual([]);
    expect(f.ctx.rotateBotForTrackedAccount).not.toHaveBeenCalled(); expect(f.ctx.botFollowRequestQueue.add).not.toHaveBeenCalled();
  });
  it.each(["queued", "pending", "accepted"])("does not duplicate an existing %s request", async (status) => {
    const f = fixture([[{ ...account, accessStatus: "access_denied" }], [{ status }]]);
    await f.call("/api/tracking/accounts/:id/retry-access");
    expect(f.ctx.rotateBotForTrackedAccount).not.toHaveBeenCalled(); expect(f.ctx.botFollowRequestQueue.add).not.toHaveBeenCalled();
    expect(f.updates).toEqual([]);
    expect(f.res.payload.status).toBe(status === "accepted" ? "has_access" : "pending_access");
  });
  it("retains failure status if no new bot can be reserved", async () => {
    const f = fixture([[{ ...account, accessStatus: "access_denied" }], []]);
    await f.call("/api/tracking/accounts/:id/retry-access");
    expect(f.res.statusCode).toBe(503); expect(f.updates).toEqual([]);
  });
});
