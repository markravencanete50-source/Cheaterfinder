// Unit tests for the roster walk's shutdown yield (2026-09-02 audit, lane C4).
//
// Regression context: a large follower/following walk runs ~100 pages x 9-16 s,
// the shutdown drain budget is 170 s, and the resume cursor was saved only when
// the walk returned — so a deploy mid-walk SIGKILLed the job and the next boot
// re-walked from page 1. `paginateFollowList` now polls `opts.shouldStop`
// between pages (and before a mid-walk retry sleep) and returns the pages it
// has as a TRUNCATED leg with `stopReason: "shutdown"` and the first unread
// page as `nextCursor`, which the collector persists like any other leg.
//
// Approach: public-data-service.ts imports the scraper/http stack, so every
// direct dependency is mocked; the walk itself is driven by a fake fetcher.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

const { noopLogger } = vi.hoisted(() => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  noopLogger.child.mockReturnValue(noopLogger);
  return { noopLogger };
});

vi.mock("../observability/logger.js", () => ({ logger: noopLogger }));
vi.mock("../ig-public-scraper.js", () => ({
  scrapeProfile: vi.fn(),
  scrapeProfileById: vi.fn(),
  scrapeProfileViaBrowser: vi.fn(),
  scrapeUserPosts: vi.fn(),
  scrapeUserClips: vi.fn(),
  scrapeUserTagged: vi.fn(),
  scrapeUserStories: vi.fn(),
  scrapeUserHighlights: vi.fn(),
  scrapeUserFollowers: vi.fn(),
  scrapeUserFollowing: vi.fn(),
  scrapeMediaComments: vi.fn(),
  scrapeMediaLikers: vi.fn(),
  scrapeUserPostsWithBot: vi.fn(),
  scrapeUserStoriesWithBot: vi.fn(),
  scrapeUserHighlightsWithBot: vi.fn(),
  scrapeMediaLikersWithBot: vi.fn(),
  scrapeMediaCommentsWithBot: vi.fn(),
  scrapeUserFollowersWithBot: vi.fn(),
  scrapeUserFollowingWithBot: vi.fn(),
  IGListRestrictedError: class IGListRestrictedError extends Error {},
  IGPublicScraperError: class IGPublicScraperError extends Error {},
}));
vi.mock("../ig-http-client.js", () => ({
  IGAuthExpiredError: class IGAuthExpiredError extends Error {},
  IGHttpError: class IGHttpError extends Error {},
  IGRateLimitedError: class IGRateLimitedError extends Error {},
}));
vi.mock("../domain/ig-client-port.js", () => ({
  IGCircuitOpenError: class IGCircuitOpenError extends Error {},
}));
vi.mock("../services/follow-capture-share.js", () => ({
  buildShareKey: vi.fn(),
  withSharedFollowCapture: vi.fn(),
}));
vi.mock("../services/scrape-retry.js", () => ({ withScrapeRetry: vi.fn() }));
vi.mock("../services/bot-cooldown.js", () => ({
  withRotationRateLimitCooldownPolicy: vi.fn(),
}));
vi.mock("../services/apify-graph-fallback.js", () => ({
  fetchApifyGraph: vi.fn(),
  isApifyGraphFallbackEnabled: vi.fn(() => false),
  resolveApifyGraphLimit: vi.fn(),
}));

const { paginateFollowList } = await import("../services/public-data-service.js");

// ── Fake IG list: three pages, cursors "c1" → "c2" → end ────────────────────

interface FakeUser {
  readonly igUserId: string;
  readonly username: string;
  readonly fullName: string;
  readonly isPrivate: boolean;
  readonly isVerified: boolean;
  readonly profilePicUrl: string;
}

const user = (username: string): FakeUser => ({
  igUserId: `id-${username}`,
  username,
  fullName: username,
  isPrivate: false,
  isVerified: false,
  profilePicUrl: "",
});

const PAGES: Record<string, { users: FakeUser[]; nextCursor: string | null }> = {
  start: { users: [user("a"), user("b")], nextCursor: "c1" },
  c1: { users: [user("c"), user("d")], nextCursor: "c2" },
  c2: { users: [user("e")], nextCursor: null },
};

interface FetcherBehavior {
  /** Cursor key ("start" for the first page) whose fetch fails. */
  readonly failOn?: string;
  /** Called after each fetch is recorded; lets a test flip the shutdown flag. */
  readonly onFetch?: (fetchCount: number) => void;
}

function makeFetcher(behavior: FetcherBehavior = {}) {
  const calls: Array<string | undefined> = [];
  const fetcher = async (cursor: string | undefined) => {
    calls.push(cursor);
    behavior.onFetch?.(calls.length);
    const key = cursor ?? "start";
    if (behavior.failOn === key) {
      return { ok: false as const, error: "ig web throttle (HTTP 429)", source: "bot" as const };
    }
    return { ok: true as const, data: PAGES[key], source: "bot" as const };
  };
  return { fetcher, calls };
}

const NO_DELAY = { pageDelayMinMs: 0, pageDelayMaxMs: 0, maxPages: 10, maxItems: 100 };

const usernames = (res: { ok: boolean; data?: ReadonlyArray<{ username: string }> }) =>
  res.ok && res.data ? res.data.map((u) => u.username) : [];

describe("paginateFollowList shutdown yield (C4)", () => {
  beforeEach(() => {
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
  });

  it("walks to exhaustion when shouldStop never fires (baseline)", async () => {
    const { fetcher, calls } = makeFetcher();
    const res = await paginateFollowList("test", fetcher, { ...NO_DELAY, shouldStop: () => false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.complete).toBe(true);
    expect(res.stopReason).toBe("exhausted");
    expect(res.nextCursor).toBeNull();
    expect(usernames(res)).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls).toEqual([undefined, "c1", "c2"]);
  });

  it("stops after the page during which shutdown began and resumes at the first UNREAD page", async () => {
    let shuttingDown = false;
    const { fetcher, calls } = makeFetcher({
      onFetch: (n) => {
        if (n === 2) shuttingDown = true; // flag flips while page 2 is in flight
      },
    });
    const res = await paginateFollowList("test", fetcher, {
      ...NO_DELAY,
      shouldStop: () => shuttingDown,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.complete).toBe(false);
    expect(res.stopReason).toBe("shutdown");
    // Page 2 (cursor c1) was captured in full → resume at c2, never re-read c1.
    expect(res.nextCursor).toBe("c2");
    expect(usernames(res)).toEqual(["a", "b", "c", "d"]);
    expect(calls).toEqual([undefined, "c1"]);
    expect(noopLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ label: "test", pagesFetched: 2, itemsFetched: 4, hasResumeCursor: true }),
      expect.stringContaining("stopped for process shutdown"),
    );
  });

  it("always fetches the first page so a walk starting mid-shutdown leaves sightings, not an empty leg", async () => {
    const { fetcher, calls } = makeFetcher();
    const res = await paginateFollowList("test", fetcher, { ...NO_DELAY, shouldStop: () => true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stopReason).toBe("shutdown");
    expect(res.nextCursor).toBe("c1");
    expect(usernames(res)).toEqual(["a", "b"]);
    expect(calls).toEqual([undefined]);
  });

  it("skips the mid-walk retry sleep on shutdown and re-requests the failing page next boot", async () => {
    let shuttingDown = false;
    const { fetcher, calls } = makeFetcher({
      failOn: "c1",
      onFetch: (n) => {
        if (n === 2) shuttingDown = true;
      },
    });
    const res = await paginateFollowList("test", fetcher, {
      ...NO_DELAY,
      shouldStop: () => shuttingDown,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stopReason).toBe("shutdown");
    // The failing page yielded nothing → it is the resume point.
    expect(res.nextCursor).toBe("c1");
    expect(usernames(res)).toEqual(["a", "b"]);
    // No same-cursor retries were spent inside the drain budget.
    expect(calls).toEqual([undefined, "c1"]);
  });

  it("leaves the page-cap classification untouched when shouldStop is absent", async () => {
    const { fetcher } = makeFetcher();
    const res = await paginateFollowList("test", fetcher, { ...NO_DELAY, maxPages: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stopReason).toBe("page_cap");
    expect(res.nextCursor).toBe("c2");
    expect(usernames(res)).toEqual(["a", "b", "c", "d"]);
  });
});
