// Unit tests for collectHighlightsIncremental in public-data-collector.ts.
//
// CONTENT-INCREMENTAL highlights: highlights are ~68% of all scrape bandwidth
// because the full reels fetch (withItems=true) walks every reel. The cheap
// tray (withItems=false) is one request. When the tray's per-highlight
// media_count fingerprint matches a recent cached baseline, the full fetch
// can be skipped until the normal refresh interval expires.
//
// Coverage (per the task spec):
//   (a) unchanged tray == saved      → NO full fetch, NO persist, count = tray length
//   (b) changed mediaCount           → full fetch + persist
//   (c) new highlight id             → full fetch + persist
//   (d) tray fetch error             → NO persist, error propagated (saved data NOT wiped)
//   (e) first-time (saved empty)     → full fetch + persist
//   plus: tray empty + saved empty   → no-op, no fetch/persist
//
// Everything below the collector (service / persistence / db / realtime) is
// mocked. The fetcher distinguishes the cheap tray (withItems=false) from the
// full reels (withItems=true) by the 3rd arg so the test can assert exactly
// which call was (or was NOT) made.

import { describe, it, expect, beforeEach, vi } from "vitest";
const freshness = vi.hoisted(() => ({ read: vi.fn(), interval: vi.fn() }));
vi.mock("../refresh-config.js", () => ({ getCachedRefreshIntervalSec: freshness.interval }));
const privateBotHasAccess = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../private-account-access.js", () => ({ privateBotHasAccess, findGrantedBotId: vi.fn(), findGrantedBotIds: vi.fn() }));

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

vi.mock("../../db.js", () => ({
  db: {
    select: () => {
      throw new Error("unexpected db.select in incremental test");
    },
    update: () => ({ set: () => ({ where: async () => [] }) }),
    insert: () => ({ values: async () => [] }),
    execute: freshness.read,
  },
}));

vi.mock("../../../shared/schema.js", () => ({
  botFollowRequests: {},
  profileSnapshots: {},
  trackedAccounts: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ args }),
  desc: (c: unknown) => c,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    strings,
    vals,
  }),
}));

vi.mock("../public-data-service.js", () => ({
  parseEnvInt: (_name: string, fallback: number) => fallback,
  getPublicProfile: vi.fn(),
  getUserPosts: vi.fn(),
  getUserStories: vi.fn(),
  getUserHighlights: vi.fn(),
  getAllUserFollowers: vi.fn(),
  getAllUserFollowing: vi.fn(),
  getPostComments: vi.fn(),
  getPostLikers: vi.fn(),
  getUserPostsAsBot: vi.fn(),
  getUserStoriesAsBot: vi.fn(),
  getUserHighlightsAsBot: vi.fn(),
  getAllUserFollowersAsBot: vi.fn(),
  getAllUserFollowingAsBot: vi.fn(),
  getPostCommentsAsBot: vi.fn(),
  getPostLikersAsBot: vi.fn(),
}));

vi.mock("../public-data-persistence.js", () => ({
  loadSavedHighlightMediaCounts: vi.fn(async () => new Map<string, number>()),
  persistComments: vi.fn(async () => ({ inserted: 0 })),
  persistFollowerDiff: vi.fn(async () => ({
    completeRead: true,
    newFollowers: 0,
    newFollowerUnfollows: 0,
  })),
  persistFollowingDiff: vi.fn(async () => ({ completeRead: true, newFollows: 0, newUnfollows: 0 })),
  persistHighlights: vi.fn(async () => 0),
  persistLikers: vi.fn(async () => ({ inserted: 0 })),
  persistPosts: vi.fn(async () => 0),
  persistStories: vi.fn(async () => 0),
}));

vi.mock("../media-cache-jobs.js", () => ({
  enqueueMediaCacheUrls: vi.fn(async () => 0),
}));

vi.mock("../realtime-events.js", () => ({
  emitRealtime: vi.fn(),
}));

vi.mock("../bandwidth-meter.js", () => ({
  withScrapeContext: vi.fn(
    async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

vi.mock("../diff-completeness.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../diff-completeness.js")>();
  return {
    ...actual,
    fetchLastSnapshotCounts: vi.fn(async () => null),
    fetchExpectedCount: vi.fn(async () => null),
  };
});

import { collectHighlightsIncremental } from "../public-data-collector.js";
import {
  getUserHighlights,
  getUserHighlightsAsBot,
} from "../public-data-service.js";
import {
  loadSavedHighlightMediaCounts,
  persistHighlights,
} from "../public-data-persistence.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Highlight {
  highlightId: string;
  title: string;
  coverUrl: string;
  mediaCount: number;
  items: ReadonlyArray<unknown>;
}

function trayHighlight(id: string, mediaCount: number): Highlight {
  // Cheap tray shape: items always [] (withItems=false).
  return { highlightId: id, title: `H ${id}`, coverUrl: "", mediaCount, items: [] };
}

function fullHighlight(id: string, mediaCount: number): Highlight {
  // Full shape: items populated (withItems=true).
  return {
    highlightId: id,
    title: `H ${id}`,
    coverUrl: `https://cover/${id}`,
    mediaCount,
    items: Array.from({ length: mediaCount }, (_, i) => ({
      storyId: `${id}-${i}`,
      mediaType: "image",
      mediaUrl: `https://m/${id}/${i}`,
      thumbnailUrl: `https://t/${id}/${i}`,
      takenAt: new Date(),
    })),
  };
}

function okResult(data: ReadonlyArray<Highlight>) {
  return { ok: true as const, data, source: "bot" as const };
}

function errResult(error: string) {
  return { ok: false as const, error, source: "bot" as const };
}

const TRACKED = "acct-1";
const USERNAME = "target";
const IG_USER_ID = "igu-1";

const getUserHighlightsMock = vi.mocked(getUserHighlights);
const getUserHighlightsAsBotMock = vi.mocked(getUserHighlightsAsBot);
const loadSavedHighlightMediaCountsMock = vi.mocked(
  loadSavedHighlightMediaCounts,
);
const persistHighlightsMock = vi.mocked(persistHighlights);

/**
 * Route the service mock by the withItems flag: tray (false) vs full (true).
 * Returns the call so a test can assert exactly which leg ran.
 */
function wireFetcher(opts: {
  tray: ReturnType<typeof okResult> | ReturnType<typeof errResult>;
  full: ReturnType<typeof okResult> | ReturnType<typeof errResult>;
}) {
  getUserHighlightsMock.mockImplementation(
    async (_u: string, _id: string, withItems?: boolean) =>
      (withItems ? opts.full : opts.tray) as never,
  );
  getUserHighlightsAsBotMock.mockImplementation(
    async (_u: string, _id: string, _bot: string, withItems?: boolean) =>
      (withItems ? opts.full : opts.tray) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  privateBotHasAccess.mockReset().mockResolvedValue(true);
  freshness.read.mockResolvedValue({ rows: [{ lastFullReadAt: new Date() }] });
  freshness.interval.mockReturnValue(1800);
  loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map());
  persistHighlightsMock.mockResolvedValue(0);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("collectHighlightsIncremental", () => {
  it("does not persist reels received after private access ends", async () => {
    getUserHighlightsAsBotMock.mockImplementation(async (_u, _id, _bot, withItems) => {
      if (withItems) privateBotHasAccess.mockResolvedValue(false);
      return okResult(withItems ? [fullHighlight("h1", 2)] : [trayHighlight("h1", 2)]) as never;
    });
    await expect(collectHighlightsIncremental(TRACKED, USERNAME, IG_USER_ID, "approved-bot"))
      .rejects.toThrow("Private collection access ended");
    expect(persistHighlightsMock).not.toHaveBeenCalled();
    expect(getUserHighlightsMock).not.toHaveBeenCalled();
  });
  it("does not treat a native tray without counts as unchanged empty reels", async () => {
    const tray = [{ ...trayHighlight("h1", 0), mediaCountKnown: false }];
    const full = [fullHighlight("h1", 2)];
    wireFetcher({ tray: okResult(tray), full: okResult(full) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 0]]));
    const out = await collectHighlightsIncremental(TRACKED, USERNAME, IG_USER_ID);
    expect(getUserHighlightsMock).toHaveBeenCalledWith(USERNAME, IG_USER_ID, true);
    expect(persistHighlightsMock).toHaveBeenCalledWith(TRACKED, full);
    expect(out.highlights).toEqual(full);
  });

  it("refreshes same-count metadata and replaced items after the configured content interval", async () => {
    const full = [{ ...fullHighlight("h1", 1), title: "Updated title", coverUrl: "https://cover/new", items: [{
      storyId: "replacement", mediaType: "image", mediaUrl: "https://m/new", thumbnailUrl: "https://t/new", takenAt: new Date(),
    }] }];
    wireFetcher({ tray: okResult([trayHighlight("h1", 1)]), full: okResult(full) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 1]]));
    freshness.interval.mockReturnValue(3 * 3600);
    freshness.read.mockResolvedValue({ rows: [{ lastFullReadAt: new Date(Date.now() - 3 * 3600_000 - 1) }] });
    const out = await collectHighlightsIncremental(TRACKED, USERNAME, IG_USER_ID);
    expect(persistHighlightsMock).toHaveBeenCalledWith(TRACKED, full);
    expect(out.highlights).toEqual(full);
    expect(getUserHighlightsMock).toHaveBeenCalledTimes(2);
  });

  it("signature rotation and forced reads inside the configured interval do not rewalk reels", async () => {
    const tray = [{ ...trayHighlight("h1", 1), coverUrl: "https://scontent.cdninstagram.com/a.jpg?sig=renewed" }];
    wireFetcher({ tray: okResult(tray), full: okResult([fullHighlight("h1", 1)]) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 1]]));
    freshness.interval.mockReturnValue(3 * 3600);
    freshness.read.mockResolvedValue({ rows: [{ lastFullReadAt: new Date(Date.now() - 2 * 3600_000) }] });
    expect(await collectHighlightsIncremental(TRACKED, USERNAME, IG_USER_ID)).toEqual({ count: 1, source: "cache" });
    expect(persistHighlightsMock).not.toHaveBeenCalled();
    expect(getUserHighlightsMock).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "missing", "partial", "duplicate"])("a periodic %s full read preserves saved reels", async mode => {
    const partial = fullHighlight("h1", 2);
    const incomplete = { ...partial, items: mode === "duplicate" ? [partial.items[0], partial.items[0]] : partial.items.slice(0, 1) };
    wireFetcher({ tray: okResult([trayHighlight("h1", 2)]), full: mode === "failed" ? errResult("reader unavailable") : okResult(mode === "missing" ? [] : [incomplete]) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 2]]));
    freshness.read.mockResolvedValue({ rows: [{ lastFullReadAt: null }] });
    const out = await collectHighlightsIncremental(TRACKED, USERNAME, IG_USER_ID);
    expect(out.error).toMatch(mode === "failed" ? /reader unavailable/ : /incomplete highlight reels/);
    expect(out.highlights).toBeUndefined();
    expect(persistHighlightsMock).not.toHaveBeenCalled();
  });

  it("a failed freshness query conservatively refreshes through the approved private reader", async () => {
    const full = [fullHighlight("h1", 1)];
    wireFetcher({ tray: okResult([trayHighlight("h1", 1)]), full: okResult(full) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 1]]));
    freshness.read.mockRejectedValueOnce(new Error("query unavailable"));
    await collectHighlightsIncremental(TRACKED, USERNAME, IG_USER_ID, "approved-bot");
    expect(getUserHighlightsMock).not.toHaveBeenCalled();
    expect(getUserHighlightsAsBotMock).toHaveBeenCalledWith(USERNAME, IG_USER_ID, "approved-bot", true);
    expect(persistHighlightsMock).toHaveBeenCalledWith(TRACKED, full);
  });

  it("(a) unchanged tray == saved → no full fetch, no persist, count = tray length", async () => {
    const tray = [trayHighlight("h1", 5), trayHighlight("h2", 3)];
    wireFetcher({ tray: okResult(tray), full: okResult([]) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(
      new Map([
        ["h1", 5],
        ["h2", 3],
      ]),
    );

    const out = await collectHighlightsIncremental(
      TRACKED,
      USERNAME,
      IG_USER_ID,
    );

    expect(out).toEqual({ count: 2, source: "cache" });
    // Tray was fetched once (withItems=false); the full reels fetch must NOT run.
    expect(getUserHighlightsMock).toHaveBeenCalledTimes(1);
    expect(getUserHighlightsMock).toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      false,
    );
    expect(getUserHighlightsMock).not.toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      true,
    );
    // Critically: persist is NEVER called on the unchanged path (it would
    // otherwise delete-then-reinsert the cached items).
    expect(persistHighlightsMock).not.toHaveBeenCalled();
  });

  it("(a') order-independent: reordered tray with same fingerprint is still unchanged", async () => {
    // Tray comes back in a different order than the baseline Map.
    const tray = [trayHighlight("h2", 3), trayHighlight("h1", 5)];
    wireFetcher({ tray: okResult(tray), full: okResult([]) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(
      new Map([
        ["h1", 5],
        ["h2", 3],
      ]),
    );

    const out = await collectHighlightsIncremental(
      TRACKED,
      USERNAME,
      IG_USER_ID,
    );

    expect(out).toEqual({ count: 2, source: "cache" });
    expect(persistHighlightsMock).not.toHaveBeenCalled();
  });

  it("(b) changed mediaCount → full fetch + persist", async () => {
    const tray = [trayHighlight("h1", 6)]; // was 5, now 6
    const full = [fullHighlight("h1", 6)];
    wireFetcher({ tray: okResult(tray), full: okResult(full) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 5]]));
    persistHighlightsMock.mockResolvedValue(1);

    const out = await collectHighlightsIncremental(
      TRACKED,
      USERNAME,
      IG_USER_ID,
    );

    expect(out.count).toBe(1);
    expect(out.source).toBe("bot");
    expect(out.error).toBeUndefined();
    // Both the tray and the full reels fetch ran.
    expect(getUserHighlightsMock).toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      false,
    );
    expect(getUserHighlightsMock).toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      true,
    );
    expect(persistHighlightsMock).toHaveBeenCalledTimes(1);
    expect(persistHighlightsMock).toHaveBeenCalledWith(TRACKED, full);
  });

  it("(c) new highlight id → full fetch + persist", async () => {
    const tray = [trayHighlight("h1", 5), trayHighlight("h2", 2)]; // h2 is new
    const full = [fullHighlight("h1", 5), fullHighlight("h2", 2)];
    wireFetcher({ tray: okResult(tray), full: okResult(full) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 5]]));
    persistHighlightsMock.mockResolvedValue(2);

    const out = await collectHighlightsIncremental(
      TRACKED,
      USERNAME,
      IG_USER_ID,
    );

    expect(out.count).toBe(2);
    expect(out.source).toBe("bot");
    expect(getUserHighlightsMock).toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      true,
    );
    expect(persistHighlightsMock).toHaveBeenCalledWith(TRACKED, full);
  });

  it("(d) tray fetch error → no persist, error propagated (saved data not wiped)", async () => {
    wireFetcher({
      tray: errResult("rate limited"),
      full: okResult([fullHighlight("h1", 5)]),
    });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 5]]));

    const out = await collectHighlightsIncremental(
      TRACKED,
      USERNAME,
      IG_USER_ID,
    );

    expect(out).toEqual({ count: 0, source: "bot", error: "rate limited" });
    // The full fetch must NOT run, and persist must NOT be called — a transient
    // tray failure must never wipe the cached highlights.
    expect(getUserHighlightsMock).not.toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      true,
    );
    expect(persistHighlightsMock).not.toHaveBeenCalled();
    // The baseline read is skipped because we bail right after the tray failure.
    expect(loadSavedHighlightMediaCountsMock).not.toHaveBeenCalled();
  });

  it("(e) first-time (saved empty, tray non-empty) → full fetch + persist", async () => {
    const tray = [trayHighlight("h1", 5)];
    const full = [fullHighlight("h1", 5)];
    wireFetcher({ tray: okResult(tray), full: okResult(full) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map()); // empty baseline
    persistHighlightsMock.mockResolvedValue(1);

    const out = await collectHighlightsIncremental(
      TRACKED,
      USERNAME,
      IG_USER_ID,
    );

    expect(out.count).toBe(1);
    expect(out.source).toBe("bot");
    expect(getUserHighlightsMock).toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      true,
    );
    expect(persistHighlightsMock).toHaveBeenCalledWith(TRACKED, full);
  });

  it("(f) tray empty AND saved empty → no-op, no full fetch, no persist", async () => {
    wireFetcher({ tray: okResult([]), full: okResult([]) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map());

    const out = await collectHighlightsIncremental(
      TRACKED,
      USERNAME,
      IG_USER_ID,
    );

    expect(out).toEqual({ count: 0, source: "bot" });
    expect(getUserHighlightsMock).not.toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      true,
    );
    expect(persistHighlightsMock).not.toHaveBeenCalled();
  });

  it("(g) tray empty but saved non-empty (account removed all highlights) → full path persists removal", async () => {
    wireFetcher({ tray: okResult([]), full: okResult([]) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 5]]));
    persistHighlightsMock.mockResolvedValue(0);

    const out = await collectHighlightsIncremental(
      TRACKED,
      USERNAME,
      IG_USER_ID,
    );

    // Falls through to the full path so persist reflects the removal.
    expect(getUserHighlightsMock).toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      true,
    );
    expect(out.source).toBe("bot");
  });

  it("(h) private path threads botAccountId through getUserHighlightsAsBot", async () => {
    const tray = [trayHighlight("h1", 5)];
    wireFetcher({ tray: okResult(tray), full: okResult([]) });
    loadSavedHighlightMediaCountsMock.mockResolvedValue(new Map([["h1", 5]]));

    const out = await collectHighlightsIncremental(
      TRACKED,
      USERNAME,
      IG_USER_ID,
      "bot-9",
    );

    expect(out).toEqual({ count: 1, source: "cache" });
    // The bot-aware fetcher is used; the public fetcher is never touched.
    expect(getUserHighlightsAsBotMock).toHaveBeenCalledWith(
      USERNAME,
      IG_USER_ID,
      "bot-9",
      false,
    );
    expect(getUserHighlightsMock).not.toHaveBeenCalled();
    expect(persistHighlightsMock).not.toHaveBeenCalled();
  });
});
