// Wave 5: tests for comments scraping + persistence.
//
// We mock the scraper boundary (`scrapeMediaComments`) and the database
// `db.insert(...)` chain so the unit tests stay deterministic and don't
// require Postgres.
//
// Coverage:
//   - getPostComments empty response → empty array, ok=true
//   - getPostComments three pages aggregated by the scraper → all comments
//     surfaced through the service result
//   - getPostComments respects maxItems cap when forwarded
//   - persistComments idempotent: running twice with the same input only
//     inserts on first call (ON CONFLICT DO NOTHING returns 0 rows)

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

const { scrapeMediaComments } = vi.hoisted(() => ({
  scrapeMediaComments: vi.fn(),
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
  scrapeMediaComments,
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
// We simulate "ON CONFLICT DO NOTHING" semantics by tracking which composite
// keys we've already inserted; second-call inserts of the same rows return
// an empty array, mirroring postgres behaviour. Hoisted so vi.mock factory
// can reference these symbols safely.

const fakeDbState = vi.hoisted(() => {
  const insertedKeys = new Set<string>();
  let lastValuesCalled: Array<{ postShortcode: string; igCommentPk: string }> =
    [];

  function makeKey(row: { postShortcode: string; igCommentPk: string }): string {
    return `${row.postShortcode}::${row.igCommentPk}`;
  }

  return {
    insertedKeys,
    getLastValuesCalled: () => lastValuesCalled,
    setLastValuesCalled: (
      v: Array<{ postShortcode: string; igCommentPk: string }>,
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
    values: (rows: Array<{ postShortcode: string; igCommentPk: string }>) => {
      fakeDbState.setLastValuesCalled(rows);
      return {
        onConflictDoNothing: () => ({
          returning: async () => {
            const newlyInserted: Array<{
              postShortcode: string;
              igCommentPk: string;
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
import { getPostComments } from "../public-data-service.js";
import { persistComments } from "../public-data-persistence.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

interface IGCommentLike {
  pk: string;
  username: string;
  displayName: string | null;
  pfpUrl: string | null;
  text: string;
  likeCount: number;
  createdAt: number;
}

function buildComments(
  count: number,
  prefix: string,
): ReadonlyArray<IGCommentLike> {
  return Array.from({ length: count }, (_, i) => ({
    pk: `${prefix}-pk-${i}`,
    username: `${prefix}_user_${i}`,
    displayName: `Display ${i}`,
    pfpUrl: null,
    text: `comment ${prefix} ${i}`,
    likeCount: i,
    createdAt: 1714_000_000 + i,
  }));
}

beforeEach(() => {
  scrapeMediaComments.mockReset();
  dbInsertMock.mockClear();
  fakeDbState.reset();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("getPostComments", () => {
  it("returns empty array when scraper finds no comments", async () => {
    scrapeMediaComments.mockResolvedValue([]);

    const result = await getPostComments("shortcodeA", "media-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toEqual([]);
    expect(scrapeMediaComments).toHaveBeenCalledWith(
      "shortcodeA",
      "media-1",
      undefined,
    );
  });

  it("aggregates comments produced across multiple internal pages", async () => {
    // The scraper itself walks pagination internally; here we simulate it
    // returning the union of three pages (50 + 50 + 30 = 130 comments).
    const aggregated = [
      ...buildComments(50, "p1"),
      ...buildComments(50, "p2"),
      ...buildComments(30, "p3"),
    ];
    scrapeMediaComments.mockResolvedValue(aggregated);

    const result = await getPostComments("shortcodeB", "media-2");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(130);
    expect(scrapeMediaComments).toHaveBeenCalledTimes(1);
  });

  it("forwards maxItems option to the scraper", async () => {
    scrapeMediaComments.mockImplementation(
      async (
        _shortcode: string,
        _mediaId: string,
        opts?: { maxItems?: number },
      ) => buildComments(opts?.maxItems ?? 200, "cap"),
    );

    const result = await getPostComments("shortcodeC", "media-3", {
      maxItems: 5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(5);
    expect(scrapeMediaComments).toHaveBeenCalledWith("shortcodeC", "media-3", {
      maxItems: 5,
    });
  });

  it("surfaces scraper failure as ok=false", async () => {
    scrapeMediaComments.mockRejectedValue(new Error("auth expired"));

    const result = await getPostComments("shortcodeD", "media-4");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.error).toMatch(/auth expired/i);
  });
});

describe("persistComments", () => {
  it("inserts new rows on first run, then returns 0 on identical re-run", async () => {
    const comments = buildComments(10, "x");

    const first = await persistComments("shortcodeX", comments);
    expect(first.inserted).toBe(10);

    const second = await persistComments("shortcodeX", comments);
    expect(second.inserted).toBe(0);
  });

  it("skips rows missing pk or username (defensive filter)", async () => {
    const valid = buildComments(2, "valid");
    const invalid = [
      { ...buildComments(1, "noPk")[0], pk: "" },
      { ...buildComments(1, "noUser")[0], username: "" },
    ];
    const combined = [...valid, ...invalid];

    const result = await persistComments("shortcodeFilter", combined);

    expect(result.inserted).toBe(2);
    const captured = fakeDbState.getLastValuesCalled();
    expect(captured).toHaveLength(2);
    expect(captured.every((r) => r.postShortcode === "shortcodeFilter")).toBe(
      true,
    );
  });

  it("returns 0 when given an empty list (no insert call)", async () => {
    const result = await persistComments("shortcodeEmpty", []);
    expect(result.inserted).toBe(0);
    expect(dbInsertMock).not.toHaveBeenCalled();
  });
});
