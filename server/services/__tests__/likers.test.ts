// Wave 5: tests for likers scraping + persistence.
//
// Mirrors comments.test.ts but for IG's /api/v1/media/<media_id>/likers/
// endpoint. The scraper boundary `scrapeMediaLikers` is mocked so the unit
// tests stay deterministic and don't require Postgres or a real bot.
//
// Coverage:
//   - getPostLikers empty response → empty array, ok=true
//   - getPostLikers 50 users surfaced through service result
//   - persistLikers idempotent: re-running with same input inserts only once
//   - persistLikers skips entries with empty username
//   - persistLikers returns 0 on empty input (no DB call)

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

vi.mock("../scrape-retry.js", () => ({
  withScrapeRetry: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
    fn(),
  ),
}));

vi.mock("../scrape-metrics.js", () => ({
  recordOutcome: vi.fn(),
}));

vi.mock("../../ig-http-client.js", () => ({
  IGAuthExpiredError: class IGAuthExpiredError extends Error {},
  IGHttpError: class IGHttpError extends Error {
    status: number = 0;
    igErrorCode?: string;
  },
}));

// ─── Mocked scraper boundary ────────────────────────────────────────────────

const { scrapeMediaLikers } = vi.hoisted(() => ({
  scrapeMediaLikers: vi.fn(),
}));

vi.mock("../../ig-public-scraper.js", () => ({
  scrapeProfile: vi.fn(),
  scrapeUserPosts: vi.fn(),
  scrapeUserClips: vi.fn(),
  scrapeUserTagged: vi.fn(),
  scrapeUserStories: vi.fn(),
  scrapeUserHighlights: vi.fn(),
  scrapeUserFollowers: vi.fn(),
  scrapeUserFollowing: vi.fn(),
  scrapeMediaComments: vi.fn(),
  scrapeMediaLikers,
  IGListRestrictedError: class IGListRestrictedError extends Error {
    botId?: string;
  },
  IGPublicScraperError: class IGPublicScraperError extends Error {
    cause?: unknown;
    constructor(message: string, cause?: unknown) {
      super(message);
      this.name = "IGPublicScraperError";
      this.cause = cause;
    }
  },
}));

// ─── Mocked DB for persistence ──────────────────────────────────────────────
//
// Same fake-db pattern as comments.test.ts: track composite keys we've
// already inserted so the second call returns no new rows (mirroring
// "ON CONFLICT DO NOTHING" in postgres). Hoisted so vi.mock factories can
// reference these symbols.

const fakeDbState = vi.hoisted(() => {
  const insertedKeys = new Set<string>();
  let lastValuesCalled: Array<{
    postShortcode: string;
    likerUsername: string;
  }> = [];

  function makeKey(row: {
    postShortcode: string;
    likerUsername: string;
  }): string {
    return `${row.postShortcode}::${row.likerUsername}`;
  }

  return {
    insertedKeys,
    getLastValuesCalled: () => lastValuesCalled,
    setLastValuesCalled: (
      v: Array<{ postShortcode: string; likerUsername: string }>,
    ) => {
      lastValuesCalled = v;
    },
    makeKey,
    reset: () => {
      insertedKeys.clear();
      lastValuesCalled = [];
    },
  };
});

const dbInsertMock = vi.hoisted(() =>
  vi.fn(() => ({
    values: (
      rows: Array<{ postShortcode: string; likerUsername: string }>,
    ) => {
      fakeDbState.setLastValuesCalled(rows);
      return {
        onConflictDoNothing: () => ({
          returning: async () => {
            const newlyInserted: Array<{
              postShortcode: string;
              likerUsername: string;
            }> = [];
            for (const r of rows) {
              const k = fakeDbState.makeKey(r);
              if (!fakeDbState.insertedKeys.has(k)) {
                fakeDbState.insertedKeys.add(k);
                newlyInserted.push(r);
              }
            }
            return newlyInserted.map((_, i) => ({ id: i + 1 }));
          },
        }),
      };
    },
  })),
);

vi.mock("../../db.js", () => ({
  db: {
    insert: dbInsertMock,
  },
}));

vi.mock("../realtime-events.js", () => ({
  emitRealtime: vi.fn(),
}));

// Module under test (after mocks are registered).
import { getPostLikers } from "../public-data-service.js";
import { persistLikers } from "../public-data-persistence.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

interface IGUserLike {
  pk: string;
  username: string;
  fullName: string | null;
  profilePicUrl: string | null;
  isVerified: boolean;
  isPrivate: boolean;
}

function buildLikers(
  count: number,
  prefix: string,
): ReadonlyArray<IGUserLike> {
  return Array.from({ length: count }, (_, i) => ({
    pk: `${prefix}-pk-${i}`,
    username: `${prefix}_user_${i}`,
    fullName: `Display ${i}`,
    profilePicUrl: null,
    isVerified: i % 5 === 0,
    isPrivate: false,
  }));
}

beforeEach(() => {
  scrapeMediaLikers.mockReset();
  dbInsertMock.mockClear();
  fakeDbState.reset();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("getPostLikers", () => {
  it("returns empty array when scraper finds no likers", async () => {
    scrapeMediaLikers.mockResolvedValue([]);

    const result = await getPostLikers("shortcodeA", "media-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toEqual([]);
    expect(scrapeMediaLikers).toHaveBeenCalledWith("shortcodeA", "media-1");
  });

  it("returns the 50-user array the scraper produced", async () => {
    const fifty = buildLikers(50, "p1");
    scrapeMediaLikers.mockResolvedValue(fifty);

    const result = await getPostLikers("shortcodeB", "media-2");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(50);
    expect(scrapeMediaLikers).toHaveBeenCalledTimes(1);
  });

  it("surfaces scraper failure as ok=false", async () => {
    scrapeMediaLikers.mockRejectedValue(new Error("auth expired"));

    const result = await getPostLikers("shortcodeC", "media-3");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.error).toMatch(/auth expired/i);
  });
});

describe("persistLikers", () => {
  it("inserts 50 rows on first run and 0 on identical re-run", async () => {
    const likers = buildLikers(50, "x");

    const first = await persistLikers("shortcodeX", likers);
    expect(first.inserted).toBe(50);

    const second = await persistLikers("shortcodeX", likers);
    expect(second.inserted).toBe(0);
  });

  it("skips rows missing username (defensive filter)", async () => {
    const valid = buildLikers(2, "valid");
    const invalid = [
      { ...buildLikers(1, "noUser")[0], username: "" },
    ];
    const combined = [...valid, ...invalid];

    const result = await persistLikers("shortcodeFilter", combined);

    expect(result.inserted).toBe(2);
    const captured = fakeDbState.getLastValuesCalled();
    expect(captured).toHaveLength(2);
    expect(
      captured.every((r) => r.postShortcode === "shortcodeFilter"),
    ).toBe(true);
  });

  it("returns 0 when given an empty list (no insert call)", async () => {
    const result = await persistLikers("shortcodeEmpty", []);
    expect(result.inserted).toBe(0);
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it("rejects empty shortcode", async () => {
    const likers = buildLikers(2, "y");
    await expect(persistLikers("", likers)).rejects.toThrow(/shortcode/);
  });
});
