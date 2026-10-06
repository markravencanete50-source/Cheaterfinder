// Run the real harvester orchestration with in-memory rows and closed I/O
// boundaries. No database, browser, Instagram or queue connection is opened.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { stateFromFriendship } from "../watcher-follow-policy.js";

const source = readFileSync(new URL("../liked-by-harvester.ts", import.meta.url), "utf8");
function extract(start: string, end?: string) {
  const from = source.indexOf(start), to = end ? source.indexOf(end, from) : source.length;
  if (from < 0 || to <= from) throw new Error(`Missing harvester function: ${start}`);
  return source.slice(from, to).replaceAll("export async function", "async function").replaceAll("export function", "function");
}
const code = transformSync([
  extract("export function roleForKind(", "/**\n * Errors that mean"),
  extract("async function prepareWatcher(", "function buildHttpClient("),
  extract("async function loadActiveTrackedByUsername(", "type LikeEventInsert"),
  extract("export async function harvestLikedBy(", "// ── Public: watcher follow maintenance"),
  extract("async function loadDistinctFollowTargets(", "// Deterministic rotating window"),
  extract("export async function ensureWatcherFollows(", "// ── Public: watcher pool lookup"),
  extract("export async function loadWatcherBotIds("),
].join("\n"), { loader: "ts", format: "cjs" }).code;

type Row = Record<string, any>;
function fixture() {
  let leaseHeld = false;
  const trackedTable = Object.fromEntries(["id", "igUsername", "igUserId", "trackingStarted", "isPrivate", "isActive", "userId", "accessStatus"].map(key => [key, key]));
  const botTable = Object.fromEntries(["id", "role", "status", "cooldownUntil", "lastUsedAt", "deviceId", "deviceUserAgent", "igAppId", "timezone", "locale", "awakeHourStart", "awakeHourEnd"].map(key => [key, key]));
  const bots: Row[] = [
    { id: "feed-bot", role: "feed_watcher", status: "available", lastUsedAt: new Date(0) },
    { id: "reels-bot", role: "reels_watcher", status: "available", lastUsedAt: new Date(1) },
    { id: "approved", role: "worker", status: "in_use", proxyEndpoint: null },
    { id: "cooling", role: "feed_watcher", status: "available", cooldownUntil: new Date(Date.now() + 60_000) },
  ];
  const tracks: Row[] = [
    { id: "original-private", igUsername: "target", igUserId: "123", isPrivate: true, isActive: true, paid: true, accessStatus: "has_access", trackingStarted: new Date(0) },
    { id: "public-twin", igUsername: "target", igUserId: "123", isPrivate: false, isActive: true, paid: true, accessStatus: "public", trackingStarted: new Date(0) },
    { id: "unpaid-private", igUsername: "unpaid", igUserId: "321", isPrivate: true, isActive: true, paid: false, accessStatus: "has_access", trackingStarted: new Date(0) },
    { id: "inactive-private", igUsername: "inactive", igUserId: "456", isPrivate: true, isActive: false, paid: true, accessStatus: "has_access", trackingStarted: new Date(0) },
    { id: "pending-private", igUsername: "pending", igUserId: "789", isPrivate: true, isActive: true, paid: true, accessStatus: "pending_access", trackingStarted: new Date(0) },
  ];
  const grantIds = new Map<string, string | string[] | null>([["original-private", "approved"]]);
  const runtime = {
    botId: "approved", igUsername: "acceptedviewer", sessionData: "saved-session",
    proxyEndpoint: "fixed.example:9000", automationIdentity: { bot_id: "approved", browser_family: "firefox" }, transport: "web",
  };
  const client = {
    fetchFriendshipStatus: vi.fn(async () => ({ following: false, outgoingRequest: false, isPrivate: false })),
    close: vi.fn(async () => {}),
  };
  const medias: Row[] = [{ postId: "observed-post", shortcode: "observed-code", ownerUsername: "post-owner", thumbnailUrl: null, likerUsernames: ["target"], takenAt: new Date() }];
  const ctx: any = {
    Date, Math, Error, Set, Map,
    botAccounts: botTable, trackedAccounts: trackedTable,
    and: (...predicates: Array<(row: Row) => boolean>) => (row: Row) => predicates.every(predicate => predicate(row)),
    eq: (column: string, value: unknown) => (row: Row) => row[column] === value,
    isNotNull: (column: string) => (row: Row) => row[column] != null,
    customerAccessSql: () => (row: Row) => row.paid === true,
    sql: (strings: TemplateStringsArray) => strings.join("").includes("NOW()")
      ? (row: Row) => !row.cooldownUntil || row.cooldownUntil.getTime() < Date.now()
      : (a: Row, b: Row) => Number(a.lastUsedAt ?? -1) - Number(b.lastUsedAt ?? -1),
    db: {
      select: (fields: Record<string, string>) => ({ from: (table: unknown) => ({ where: (predicate: (row: Row) => boolean) => {
        const filtered = (table === botTable ? bots : tracks).filter(predicate);
        const project = (rows: Row[]) => rows.map(row => Object.fromEntries(Object.entries(fields).map(([name, column]) => [name, row[column]])));
        return {
          then: (resolve: (rows: Row[]) => unknown) => Promise.resolve(project(filtered)).then(resolve),
          limit: async (count: number) => project(filtered.slice(0, count)),
          orderBy: async (compare: (a: Row, b: Row) => number) => project([...filtered].sort(compare)),
        };
      } }) }),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    findGrantedBotIds: vi.fn(async (id: string) => {
      const value = grantIds.get(id); return typeof value === 'string' ? [value] : value ?? [];
    }),
    ensureBotReady: vi.fn(async () => runtime),
    resolveFingerprint: vi.fn(() => ({ userAgent: "fixture" })),
    withOperationLease: vi.fn(async (_key: string, operation: () => Promise<unknown>) => {
      if (leaseHeld) throw new Error("unexpected nested bot lease");
      leaseHeld = true;
      try { return await operation(); } finally { leaseHeld = false; }
    }),
    invalidateObservedBotSession: vi.fn(async () => {
      expect(leaseHeld).toBe(true);
      return true;
    }),
    endpointFor: (kind: string) => ({ path: kind, method: "POST", body: "" }),
    fetchFeedRaw: vi.fn(async () => ({ fixture: true })),
    parseLikedByFeed: vi.fn(() => medias),
    isLikedPostAfterTrackingStart: () => true,
    postCreatedAt: () => new Date(),
    buildLikeEventRow: (trackedAccountId: string, media: Row) => ({ trackedAccountId, postId: media.postId }),
    persistLikeEvents: vi.fn(async (rows: Row[]) => rows.length),
    isShuttingDown: () => false,
    loadWatcherFollowState: vi.fn(async () => new Map()),
    readWatcherFollowReverifyMs: () => 24 * 60 * 60 * 1000,
    shouldProbeTarget: () => true,
    rotatingWindow: (targets: Row[], size: number) => targets.slice(0, size),
    buildHttpClient: vi.fn(() => client),
    stateFromFriendship,
    recordWatcherFollowState: vi.fn(async () => {}),
    sendWatcherFollow: vi.fn(async () => "following"),
    harvestErrorDetails: () => ({ errorKind: "fixture" }),
    sleep: vi.fn(async () => {}), humanFollowDelayMs: () => 0,
    closeQuietly: async (value: typeof client) => value.close(),
    isRotateSignal: () => false, isCheckpointError: () => false,
    IGRateLimitedError: class extends Error {},
    IGAuthExpiredError: class extends Error {},
    cooldownBotForCheckpoint: vi.fn(async () => {}),
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return { ctx, bots, tracks, grantIds, runtime, client, medias };
}

describe("approved private viewers in the liked-by squad", () => {
  it.each(["feed", "reels"])("adds the canonical approved viewer to %s while preserving its role watcher", async kind => {
    const f = fixture();
    f.tracks.push({ ...f.tracks[0], id: "second-original" });
    f.grantIds.set("second-original", "approved");
    expect(await f.ctx.loadWatcherBotIds(kind)).toEqual([`${kind}-bot`, "approved"]);
    expect(f.ctx.findGrantedBotIds.mock.calls.map(([id]: [string]) => id)).toEqual(["original-private", "second-original"]);
  });

  it("deduplicates an approved viewer that already has the watcher role", async () => {
    const f = fixture();
    f.grantIds.set("original-private", "feed-bot");
    expect(await f.ctx.loadWatcherBotIds("feed")).toEqual(["feed-bot"]);
  });

  it.each(['feed', 'reels'])('includes both independently accepted viewers for %s coverage', async kind => {
    const f = fixture(); f.grantIds.set('original-private', ['approved', 'backup']);
    expect(await f.ctx.loadWatcherBotIds(kind)).toEqual([`${kind}-bot`, 'approved', 'backup']);
  });

  it("does not use an unapproved or unhealthy viewer rejected by the shared resolver", async () => {
    const f = fixture();
    f.grantIds.set("original-private", null);
    expect(await f.ctx.loadWatcherBotIds("feed")).toEqual(["feed-bot"]);
  });

  it("reuses saved runtime session and fixed proxy without login despite a NULL stored endpoint", async () => {
    const f = fixture();
    await expect(f.ctx.prepareWatcher("approved")).resolves.toMatchObject({ sessionData: "saved-session", proxyEndpoint: "fixed.example:9000", automationIdentity: f.runtime.automationIdentity });
    expect(f.ctx.ensureBotReady).toHaveBeenCalledExactlyOnceWith("approved", { allowLogin: false });
    expect(f.bots.find(bot => bot.id === "approved")!.proxyEndpoint).toBeNull();
  });

  it("refuses a saved session without a canonical proxy", async () => {
    const f = fixture(); f.runtime.proxyEndpoint = "";
    await expect(f.ctx.prepareWatcher("approved")).rejects.toThrow("refusing direct IG egress");
    expect(f.ctx.fetchFeedRaw).not.toHaveBeenCalled();
  });

  it("refuses a runtime for a different bot before building a client", async () => {
    const f = fixture(); f.runtime.botId = "other-bot";
    await expect(f.ctx.prepareWatcher("approved")).rejects.toThrow("does not match assigned bot");
    expect(f.ctx.buildHttpClient).not.toHaveBeenCalled();
    expect(f.ctx.fetchFeedRaw).not.toHaveBeenCalled();
  });

  it("does not enroll the approved private viewer in public follow maintenance", async () => {
    const f = fixture();
    await expect(f.ctx.ensureWatcherFollows("approved", { maxProbes: 10, maxNewFollows: 3 })).resolves.toEqual({ probed: 0, followed: 0, cached: 0 });
    expect(f.ctx.ensureBotReady).not.toHaveBeenCalled();
    expect(f.ctx.sendWatcherFollow).not.toHaveBeenCalled();
    expect(f.client.fetchFriendshipStatus).not.toHaveBeenCalled();
  });
});

describe("public-only watcher follow maintenance", () => {
  it("invalidates only the observed auth-rejected session while holding the bot lease", async () => {
    const f = fixture(); f.runtime.botId = "feed-bot";
    const error = new f.ctx.IGAuthExpiredError("confirmed login redirect");
    f.client.fetchFriendshipStatus.mockRejectedValue(error);
    await expect(f.ctx.ensureWatcherFollows("feed-bot", { maxProbes: 10, maxNewFollows: 2 })).rejects.toBe(error);
    expect(f.ctx.invalidateObservedBotSession).toHaveBeenCalledExactlyOnceWith("feed-bot", "saved-session");
    expect(f.ctx.withOperationLease).toHaveBeenCalledWith("bot:feed-bot", expect.any(Function));
    expect(f.ctx.sendWatcherFollow).not.toHaveBeenCalled();
    expect(f.ctx.recordWatcherFollowState).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("excludes private, unpaid and inactive targets before any friendship traffic", async () => {
    const f = fixture();
    f.runtime.botId = "feed-bot";
    await expect(f.ctx.loadDistinctFollowTargets()).resolves.toEqual([{ igUserId: "123", igUsername: "target" }]);
    await expect(f.ctx.ensureWatcherFollows("feed-bot", { maxProbes: 10, maxNewFollows: 2 })).resolves.toMatchObject({ followed: 1, probed: 1 });
    expect(f.client.fetchFriendshipStatus).toHaveBeenCalledExactlyOnceWith("123");
    expect(f.ctx.sendWatcherFollow).toHaveBeenCalledOnce();
  });

  it("refuses a new follow if the formerly-public target is private at the live probe", async () => {
    const f = fixture(); f.runtime.botId = "feed-bot";
    f.client.fetchFriendshipStatus.mockResolvedValue({ following: false, outgoingRequest: false, isPrivate: true });
    await expect(f.ctx.ensureWatcherFollows("feed-bot", { maxProbes: 10, maxNewFollows: 2 })).resolves.toMatchObject({ followed: 0, probed: 1 });
    expect(f.ctx.sendWatcherFollow).not.toHaveBeenCalled();
    expect(f.ctx.recordWatcherFollowState).toHaveBeenCalledWith("feed-bot", expect.any(Object), "unavailable", expect.stringContaining("private account"));
  });

  it("does not count or persist an unconfirmed browser action as a landed follow", async () => {
    const f = fixture(); f.runtime.botId = "feed-bot";
    f.ctx.sendWatcherFollow.mockRejectedValue(new Error("Browser follow outcome unconfirmed"));
    await expect(f.ctx.ensureWatcherFollows("feed-bot", { maxProbes: 10, maxNewFollows: 2 })).resolves.toMatchObject({ followed: 0, probed: 1 });
    expect(f.ctx.recordWatcherFollowState).toHaveBeenCalledExactlyOnceWith("feed-bot", expect.any(Object), "not_following", "Browser follow outcome unconfirmed");
  });
});

describe("positive private liked-by evidence", () => {
  it("invalidates an observed login redirect inside the lease and records no false evidence", async () => {
    const f = fixture();
    const error = new f.ctx.IGAuthExpiredError("confirmed login redirect");
    f.ctx.fetchFeedRaw.mockRejectedValue(error);
    await expect(f.ctx.harvestLikedBy("approved", "feed")).rejects.toBe(error);
    expect(f.ctx.invalidateObservedBotSession).toHaveBeenCalledExactlyOnceWith("approved", "saved-session");
    expect(f.ctx.parseLikedByFeed).not.toHaveBeenCalled();
    expect(f.ctx.persistLikeEvents).not.toHaveBeenCalled();
  });

  it("still fails the old read if the session was already renewed and CAS returns false", async () => {
    const f = fixture();
    const error = new f.ctx.IGAuthExpiredError("confirmed login redirect");
    f.ctx.fetchFeedRaw.mockRejectedValue(error);
    f.ctx.invalidateObservedBotSession.mockResolvedValue(false);
    await expect(f.ctx.harvestLikedBy("approved", "feed")).rejects.toBe(error);
    expect(f.ctx.invalidateObservedBotSession).toHaveBeenCalledOnce();
    expect(f.ctx.persistLikeEvents).not.toHaveBeenCalled();
  });

  it("does not discard a session just because an upstream response is generic HTML", async () => {
    const f = fixture(), error = new Error("response not JSON");
    f.ctx.fetchFeedRaw.mockRejectedValue(error);
    await expect(f.ctx.harvestLikedBy("approved", "feed")).rejects.toBe(error);
    expect(f.ctx.invalidateObservedBotSession).not.toHaveBeenCalled();
  });

  it("cools a confirmed checkpoint for 24 hours without discarding its saved session", async () => {
    const f = fixture(), error = new Error("Instagram checkpoint_required");
    f.ctx.isCheckpointError = (value: unknown) => value === error;
    f.ctx.fetchFeedRaw.mockRejectedValue(error);
    await expect(f.ctx.harvestLikedBy("approved", "feed")).rejects.toBe(error);
    expect(f.ctx.cooldownBotForCheckpoint).toHaveBeenCalledExactlyOnceWith("approved", "Instagram checkpoint_required", 24);
    expect(f.ctx.invalidateObservedBotSession).not.toHaveBeenCalled();
    expect(f.ctx.persistLikeEvents).not.toHaveBeenCalled();
  });

  it.each(["feed", "reels"])("records observed %s facepiles through the canonical accepted viewer", async kind => {
    const f = fixture();
    const result = await f.ctx.harvestLikedBy("approved", kind);
    expect(result.inserted).toBe(2);
    expect(result.matches.map((match: Row) => match.trackedAccountId)).toEqual(["original-private", "public-twin"]);
    expect(f.ctx.fetchFeedRaw).toHaveBeenCalledWith(expect.objectContaining({ botId: "approved", proxyEndpoint: "fixed.example:9000" }), expect.objectContaining({ path: kind }));
    expect(f.ctx.ensureBotReady).toHaveBeenCalledWith("approved", { allowLogin: false });
  });

  it("does not borrow the public twin's evidence authorization for a private original", async () => {
    const f = fixture(); f.runtime.botId = "feed-bot";
    const result = await f.ctx.harvestLikedBy("feed-bot", "feed");
    expect(result.matches.map((match: Row) => match.trackedAccountId)).toEqual(["public-twin"]);
    expect(f.ctx.findGrantedBotIds).toHaveBeenCalledWith("original-private");
  });

  it("rechecks private access after the feed read before persisting matches", async () => {
    const f = fixture();
    f.ctx.fetchFeedRaw.mockImplementation(async () => { f.grantIds.set("original-private", null); return {}; });
    const result = await f.ctx.harvestLikedBy("approved", "feed");
    expect(result.matches.map((match: Row) => match.trackedAccountId)).toEqual(["public-twin"]);
  });

  it("makes no feed call if the only tracked private account has no approved viewer", async () => {
    const f = fixture(); f.tracks.splice(1); f.grantIds.clear();
    await expect(f.ctx.harvestLikedBy("approved", "feed")).resolves.toMatchObject({ inserted: 0, fetchedPosts: 0 });
    expect(f.ctx.ensureBotReady).not.toHaveBeenCalled();
    expect(f.ctx.fetchFeedRaw).not.toHaveBeenCalled();
  });

  it("does not invent likes when the feed contains no observed facepile matches", async () => {
    const f = fixture(); f.medias[0].likerUsernames = ["someone-else"];
    await expect(f.ctx.harvestLikedBy("approved", "feed")).resolves.toMatchObject({ inserted: 0, matched: 0 });
    expect(f.ctx.persistLikeEvents).toHaveBeenCalledExactlyOnceWith([]);
  });
});
