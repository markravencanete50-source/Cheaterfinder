// Tests for the cache-upsert helpers in public-data-persistence.ts.
//
// D6: persistPosts / persistStories / persistHighlights upsert with
// ON CONFLICT DO UPDATE and discriminate insert vs update via
// `(xmax = 0)` in RETURNING — realtime events must fire only for rows
// that were genuinely inserted, never for refresh-updates of rows that
// already existed (previously every collection cycle re-fired
// posts.added / stories.changed / highlights.changed).
//
// D9: the highlight-items refresh (delete stale items, re-insert fresh
// ones) must run as ONE transaction with a single batched delete and a
// single batched insert — never an interleaved per-highlight
// delete/insert sequence outside a transaction.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Env / module-load order stubs ──────────────────────────────────────────

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const { emitRealtime } = vi.hoisted(() => ({ emitRealtime: vi.fn() }));
vi.mock("../realtime-events.js", () => ({ emitRealtime }));
vi.mock("../media-cache-jobs.js", () => ({ enqueueMediaCacheUrls: vi.fn(async () => 0) }));

// ─── Mocked DB ──────────────────────────────────────────────────────────────
//
// Upserts resolve to fixtures.upsertReturning[table] so each test controls
// the inserted/updated mix the RETURNING clause reports. Deletes and inserts
// are recorded (tagged with whether they ran inside db.transaction) so the
// D9 atomicity/batching assertions can inspect them.

const fixtures = vi.hoisted(() => {
  return {
    upsertReturning: {} as Record<string, Array<Record<string, unknown>>>,
    insertCalls: [] as Array<{
      table: string;
      rows: ReadonlyArray<unknown>;
      inTx: boolean;
    }>,
    deleteCalls: [] as Array<{ table: string; inTx: boolean }>,
    transactionCount: 0,
    // Rows a `.where()`-terminated select resolves to (e.g.
    // loadSavedHighlightMediaCounts). Defaults to [] so unrelated flows are
    // unaffected.
    selectRows: [] as Array<Record<string, unknown>>,
    reset: function () {
      this.upsertReturning = {};
      this.insertCalls = [];
      this.deleteCalls = [];
      this.transactionCount = 0;
      this.selectRows = [];
    },
  };
});

const dbMock = vi.hoisted(() => {
  function tableNameOf(table: unknown): string {
    return (table as { __tableName?: string }).__tableName ?? "";
  }

  function buildInsert(table: unknown, inTx: boolean) {
    const tableName = tableNameOf(table);
    return {
      values(rows: ReadonlyArray<unknown>) {
        fixtures.insertCalls.push({ table: tableName, rows, inTx });
        // The chain is both thenable (plain `await insert().values()`) and
        // upsert-capable (`.onConflictDoUpdate().returning()`).
        const returning = () =>
          Promise.resolve(fixtures.upsertReturning[tableName] ?? []);
        return {
          onConflictDoUpdate: (_cfg: unknown) => ({ returning }),
          onConflictDoNothing: (_cfg: unknown) => ({ returning }),
          then(
            resolve: (v: unknown) => unknown,
            reject?: (e: unknown) => unknown,
          ) {
            return Promise.resolve(undefined).then(resolve, reject);
          },
        };
      },
    };
  }

  function buildDelete(table: unknown, inTx: boolean) {
    const tableName = tableNameOf(table);
    return {
      where(_cond: unknown) {
        fixtures.deleteCalls.push({ table: tableName, inTx });
        return Promise.resolve();
      },
    };
  }

  function buildSelect(_columns: unknown) {
    // The builder is chainable (.from/.where return it) AND thenable: a chain
    // that ends at `.where()` (loadSavedHighlightMediaCounts) resolves to
    // fixtures.selectRows. lookupUsername still ends at `.limit()`.
    const builder: {
      from: (t: unknown) => typeof builder;
      where: (c: unknown) => typeof builder;
      limit: (n: number) => Promise<ReadonlyArray<unknown>>;
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise<unknown>;
    } = {
      from: (_t: unknown) => builder,
      where: (_c: unknown) => builder,
      // Only lookupUsername (trackedAccounts) selects with a trailing limit.
      limit: (_n: number) =>
        Promise.resolve([{ igUsername: "test_user" }] as const),
      then: (resolve, reject) =>
        Promise.resolve(fixtures.selectRows).then(resolve, reject),
    };
    return builder;
  }

  const tx = {
    insert: vi.fn((t: unknown) => buildInsert(t, true)),
    delete: vi.fn((t: unknown) => buildDelete(t, true)),
  };

  return {
    db: {
      insert: vi.fn((t: unknown) => buildInsert(t, false)),
      delete: vi.fn((t: unknown) => buildDelete(t, false)),
      select: vi.fn(buildSelect),
      transaction: vi.fn(async (fn: (txc: typeof tx) => Promise<unknown>) => {
        fixtures.transactionCount += 1;
        return fn(tx);
      }),
    },
  };
});

vi.mock("../../db.js", () => dbMock);

// ─── Mocked schema (identifiable table tokens; columns are inert) ───────────

vi.mock("../../../shared/schema.js", () => {
  const tag = (name: string) => ({ __tableName: name, id: {} });
  return {
    commentsCache: { ...tag("commentsCache"), postShortcode: {}, igCommentPk: {} },
    followEvents: tag("followEvents"),
    followerEvents: tag("followerEvents"),
    followerUnfollowEvents: tag("followerUnfollowEvents"),
    highlightItemsCache: { ...tag("highlightItemsCache"), highlightCacheId: {} },
    highlightsCache: {
      ...tag("highlightsCache"),
      trackedAccountId: {},
      highlightId: {},
    },
    likersCache: { ...tag("likersCache"), postShortcode: {}, likerUsername: {} },
    postsCache: { ...tag("postsCache"), trackedAccountId: {}, shortcode: {} },
    storiesCache: {
      ...tag("storiesCache"),
      trackedAccountId: {},
      storyId: {},
      expiresAt: {},
    },
    trackedAccounts: { ...tag("trackedAccounts"), igUsername: {} },
    unfollowEvents: tag("unfollowEvents"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => ({ __op: "and" }),
  asc: (..._args: unknown[]) => ({ __op: "asc" }),
  desc: (..._args: unknown[]) => ({ __op: "desc" }),
  eq: (..._args: unknown[]) => ({ __op: "eq" }),
  inArray: (..._args: unknown[]) => ({ __op: "inArray" }),
  lt: (..._args: unknown[]) => ({ __op: "lt" }),
  sql: Object.assign(
    (strings: unknown, ...values: unknown[]) => ({
      __op: "sql",
      text: Array.isArray(strings) ? strings.join("?") : String(strings ?? ""),
      values,
    }),
    { raw: (s: string) => s },
  ),
}));

// ─── Module under test (after mocks) ────────────────────────────────────────

import {
  LruCache,
  loadSavedHighlightMediaCounts,
  persistHighlights,
  persistPosts,
  persistStories,
} from "../public-data-persistence.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePost(shortcode: string) {
  return {
    shortcode,
    mediaId: `m-${shortcode}`,
    postType: "image" as const,
    thumbnailUrl: null,
    displayUrl: null,
    videoUrl: null,
    caption: null,
    likeCount: 0,
    commentCount: 0,
    videoViewCount: null,
    takenAt: new Date("2026-01-01T00:00:00Z"),
    locationName: null,
    hashtags: [] as string[],
  };
}

function makeStory(storyId: string) {
  return {
    storyId,
    mediaType: "image" as const,
    mediaUrl: `https://cdn.example/${storyId}.jpg`,
    thumbnailUrl: null,
    takenAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: new Date("2026-01-02T00:00:00Z"),
  };
}

function makeHighlight(
  highlightId: string,
  itemIds: ReadonlyArray<string> = [],
) {
  return {
    highlightId,
    title: `h-${highlightId}`,
    coverUrl: null,
    mediaCount: itemIds.length,
    items: itemIds.map((storyId) => ({
      storyId,
      mediaType: "image" as const,
      mediaUrl: null,
      thumbnailUrl: null,
      takenAt: new Date("2026-01-01T00:00:00Z"),
    })),
  };
}

beforeEach(() => {
  fixtures.reset();
  emitRealtime.mockClear();
  dbMock.db.transaction.mockClear();
});

// ─── D6: insert-vs-update discrimination via (xmax = 0) ─────────────────────

describe("persistPosts realtime gating (D6)", () => {
  it("emits posts.added counting ONLY genuinely inserted rows", async () => {
    fixtures.upsertReturning.postsCache = [
      { id: "p1", inserted: true },
      { id: "p2", inserted: false }, // refreshed existing row
      { id: "p3", inserted: false },
    ];

    const upserted = await persistPosts("acct-1", [
      makePost("a"),
      makePost("b"),
      makePost("c"),
    ]);

    expect(upserted).toBe(3);
    expect(emitRealtime).toHaveBeenCalledTimes(1);
    expect(emitRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "posts.added", count: 1 }),
    );
  });

  it("emits NOTHING when every row was a refresh-update (steady-state cycle)", async () => {
    fixtures.upsertReturning.postsCache = [
      { id: "p1", inserted: false },
      { id: "p2", inserted: false },
    ];

    const upserted = await persistPosts("acct-1", [
      makePost("a"),
      makePost("b"),
    ]);

    expect(upserted).toBe(2);
    expect(emitRealtime).not.toHaveBeenCalled();
  });
});

describe("persistStories realtime gating (D6)", () => {
  it("does not re-fire stories.changed for refreshed stories", async () => {
    fixtures.upsertReturning.storiesCache = [
      { id: "s1", inserted: false },
      { id: "s2", inserted: false },
    ];

    await persistStories("acct-1", [makeStory("s1"), makeStory("s2")]);

    expect(emitRealtime).not.toHaveBeenCalled();
  });

  it("fires stories.changed with the inserted count only", async () => {
    fixtures.upsertReturning.storiesCache = [
      { id: "s1", inserted: true },
      { id: "s2", inserted: false },
    ];

    await persistStories("acct-1", [makeStory("s1"), makeStory("s2")]);

    expect(emitRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stories.changed", count: 1 }),
    );
  });
});

// ─── D9: transactional, batched highlight-items refresh ─────────────────────

describe("persistHighlights items refresh (D9)", () => {
  it("refreshes items with ONE transaction: single batched delete + single batched insert", async () => {
    fixtures.upsertReturning.highlightsCache = [
      { id: "hc-1", highlightId: "h1", inserted: false },
      { id: "hc-2", highlightId: "h2", inserted: false },
    ];

    await persistHighlights("acct-1", [
      makeHighlight("h1", ["i1", "i2"]),
      makeHighlight("h2", ["i3"]),
    ]);

    expect(fixtures.transactionCount).toBe(1);

    // One delete covering ALL parent ids, inside the transaction.
    const deletes = fixtures.deleteCalls.filter(
      (d) => d.table === "highlightItemsCache",
    );
    expect(deletes).toEqual([{ table: "highlightItemsCache", inTx: true }]);

    // One insert carrying ALL item rows across both highlights, inside the
    // same transaction (previously: one delete + one insert per highlight,
    // each on the plain db client).
    const itemInserts = fixtures.insertCalls.filter(
      (c) => c.table === "highlightItemsCache",
    );
    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0]?.inTx).toBe(true);
    expect(itemInserts[0]?.rows).toHaveLength(3);
    expect(itemInserts[0]?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ highlightCacheId: "hc-1", storyId: "i1" }),
        expect.objectContaining({ highlightCacheId: "hc-1", storyId: "i2" }),
        expect.objectContaining({ highlightCacheId: "hc-2", storyId: "i3" }),
      ]),
    );
  });

  it("skips the items transaction entirely when no highlight has items", async () => {
    fixtures.upsertReturning.highlightsCache = [
      { id: "hc-1", highlightId: "h1", inserted: false },
    ];

    await persistHighlights("acct-1", [makeHighlight("h1")]);

    expect(fixtures.transactionCount).toBe(0);
    expect(fixtures.deleteCalls).toHaveLength(0);
  });

  it("emits highlights.changed only for genuinely inserted highlights (D6)", async () => {
    fixtures.upsertReturning.highlightsCache = [
      { id: "hc-1", highlightId: "h1", inserted: true },
      { id: "hc-2", highlightId: "h2", inserted: false },
    ];

    await persistHighlights("acct-1", [
      makeHighlight("h1"),
      makeHighlight("h2"),
    ]);

    expect(emitRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "highlights.changed", count: 1 }),
    );
  });

  it("emits nothing when all highlights were mere refreshes", async () => {
    fixtures.upsertReturning.highlightsCache = [
      { id: "hc-1", highlightId: "h1", inserted: false },
    ];

    await persistHighlights("acct-1", [makeHighlight("h1")]);

    expect(emitRealtime).not.toHaveBeenCalled();
  });
});

// ─── loadSavedHighlightMediaCounts (content-incremental baseline) ────────────
//
// The collector reads this per-highlight media_count baseline (a SELECT that
// ends at `.where()`) to decide whether the cheap tray changed before paying
// for the expensive reels fetch. These assert the row→Map shaping and the
// null-mediaCount coalescing the comparison relies on.

describe("loadSavedHighlightMediaCounts", () => {
  it("maps each cached row to highlightId → mediaCount", async () => {
    fixtures.selectRows = [
      { highlightId: "h1", mediaCount: 5 },
      { highlightId: "h2", mediaCount: 3 },
    ];

    const out = await loadSavedHighlightMediaCounts("acct-1");

    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(2);
    expect(out.get("h1")).toBe(5);
    expect(out.get("h2")).toBe(3);
  });

  it("returns an empty Map when the account has no cached highlights", async () => {
    fixtures.selectRows = [];

    const out = await loadSavedHighlightMediaCounts("acct-1");

    expect(out.size).toBe(0);
  });

  it("coalesces a null media_count to 0 so the fingerprint stays comparable", async () => {
    fixtures.selectRows = [{ highlightId: "h1", mediaCount: null }];

    const out = await loadSavedHighlightMediaCounts("acct-1");

    expect(out.get("h1")).toBe(0);
  });
});

// ─── LruCache (B6a) ─────────────────────────────────────────────────────────
//
// The module-level usernameCache is bounded by this LRU so a long-lived,
// multi-tenant process can't grow it unbounded (one entry per username ever
// seen). These assert the three invariants the bound relies on: a hard cap,
// LRU eviction order, and get-refreshes-recency.

describe("LruCache (B6a username-cache bound)", () => {
  it("never exceeds the configured cap", () => {
    const cache = new LruCache<string>(3);
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, `v${i}`);
    expect(cache.size).toBe(3);
  });

  it("evicts the least-recently-INSERTED key first when no reads happen", () => {
    const cache = new LruCache<string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // Inserting a 4th key evicts "a" (oldest insertion = least recent).
    cache.set("d", "4");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
  });

  it("get() refreshes recency so a recently-read key survives eviction", () => {
    const cache = new LruCache<string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // Read "a": it is now the most-recently-used, so the next insert must
    // instead evict "b" (the new least-recently-used).
    expect(cache.get("a")).toBe("1");
    cache.set("d", "4");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
  });

  it("re-setting an existing key refreshes recency without growing size", () => {
    const cache = new LruCache<string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // Overwrite "a": size stays 3 and "a" becomes most-recent, so "b" is the
    // eviction target on the next insert.
    cache.set("a", "1-updated");
    expect(cache.size).toBe(3);
    cache.set("d", "4");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1-updated");
  });

  it("missing keys return undefined and do not affect recency", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.get("nope")).toBeUndefined();
    // No mutation from the miss: inserting "c" evicts the true LRU ("a").
    cache.set("c", "3");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });
});
