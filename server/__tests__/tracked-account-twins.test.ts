// Unit tests for the twin-tracked-account union.
//
// Regression context: `like_events` rows are keyed by tracked_account_id, but
// liked-post evidence belongs to the IG USER. @tracked_user_1 was tracked by two
// rows against the same ig_user_id (45486294500); each ran its own scan and
// held a different subset — 23 posts vs 27, 13 shared, 37 in the union. One
// customer's dashboard grew a liked post the other never saw. These tests pin
// the read-side union: which rows count as twins, and how the union collapses
// back to one row per post.
//
// The DB is mocked. Because the "only ACTIVE rows" and "key on ig_user_id"
// rules live in SQL rather than in JS, the WHERE clause handed to drizzle is
// rendered with the real PgDialect and asserted directly — a mock that just
// returns rows would happily pass even if the predicate were dropped.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

type QueuedResponse = unknown[] | Error;

/** FIFO of results, one per `db.select(...)` the helper issues. */
const responses: QueuedResponse[] = [];
/** Every WHERE condition drizzle was handed, in call order. */
const whereConditions: SQL[] = [];

function nextResponse(): Promise<unknown[]> {
  const next = responses.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

/** Every ORDER BY drizzle was handed (canonicalTwinId orders oldest-first). */
const orderBys: unknown[][] = [];

/**
 * Thenable that also answers `.limit(n)` and `.orderBy(...)` — the anchor
 * query chains `.limit`, the canonical query chains `.orderBy().limit`.
 */
function whereResult(condition: SQL) {
  whereConditions.push(condition);
  const promise = nextResponse();
  const chain: Promise<unknown[]> & {
    limit: () => Promise<unknown[]>;
    orderBy: (...cols: unknown[]) => typeof chain;
  } = Object.assign(promise, {
    limit: () => promise,
    orderBy: (...cols: unknown[]) => {
      orderBys.push(cols);
      return chain;
    },
  });
  return chain;
}

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => whereResult(condition),
      }),
    }),
  },
}));

const loggerWarn = vi.fn();
const stubLogger = {
  info: vi.fn(),
  warn: loggerWarn,
  error: vi.fn(),
  debug: vi.fn(),
  child: () => stubLogger,
};

vi.mock("../observability/logger.js", () => ({ logger: stubLogger }));

const {
  twinTrackedAccountIds,
  dedupeLikedPostsByPostId,
  compareLikedPosts,
  canonicalTwinId,
  resetCanonicalTwinCache,
  siblingTrackedAccountIds,
  pickRosterInheritanceDonor,
  DEFAULT_ROSTER_INHERITANCE_POLICY,
} = await import("../services/tracked-account-twins.js");

const dialect = new PgDialect();
function renderedWhere(index: number): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(whereConditions[index]);
  return { sql, params };
}

// The live rows that exposed the defect.
const KALEZ_ROW = "1dbb5e56-64c1-4aa4-b641-566b81a1f384";
const ROB_ROW = "dd8c9e98-07da-4784-b800-40ed4c9473ba";
const ISOJELENE_PK = "45486294500";

beforeEach(() => {
  responses.length = 0;
  whereConditions.length = 0;
  orderBys.length = 0;
  loggerWarn.mockReset();
  resetCanonicalTwinCache();
});

// ── canonical twin ───────────────────────────────────────────────────────────

describe("canonicalTwinId", () => {
  it("resolves to the OLDEST active row sharing the ig_user_id", async () => {
    // Rob's row started tracking first, so it holds the roster for both.
    responses.push(
      [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }],
      [{ id: ROB_ROW }],
    );

    await expect(canonicalTwinId(KALEZ_ROW)).resolves.toBe(ROB_ROW);

    const twinWhere = renderedWhere(1);
    expect(twinWhere.sql).toContain('"tracked_accounts"."ig_user_id" = ');
    expect(twinWhere.sql).toContain('"tracked_accounts"."is_active" = ');
    expect(twinWhere.params).toContain(ISOJELENE_PK);
    // Oldest-first, id as the deterministic tie-break.
    const order = orderBys[0].map((c) => dialect.sqlToQuery(c as SQL).sql);
    expect(order[0]).toContain('"tracked_accounts"."tracking_started" asc');
    expect(order[1]).toContain('"tracked_accounts"."id" asc');
  });

  it("returns the row itself when it has no twins", async () => {
    responses.push(
      [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }],
      [{ id: KALEZ_ROW }],
    );

    await expect(canonicalTwinId(KALEZ_ROW)).resolves.toBe(KALEZ_ROW);
  });

  it("returns the row itself when no active row matches (e.g. it is inactive)", async () => {
    responses.push([{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }], []);

    await expect(canonicalTwinId(KALEZ_ROW)).resolves.toBe(KALEZ_ROW);
  });

  it("returns the row itself when the anchor row is missing", async () => {
    responses.push([]);

    await expect(canonicalTwinId(KALEZ_ROW)).resolves.toBe(KALEZ_ROW);
    expect(whereConditions).toHaveLength(1);
  });

  it("falls back to ig_username when ig_user_id is null", async () => {
    responses.push([{ igUserId: null, igUsername: "tracked_user_1" }], [{ id: ROB_ROW }]);

    await expect(canonicalTwinId(KALEZ_ROW)).resolves.toBe(ROB_ROW);
    const twinWhere = renderedWhere(1);
    expect(twinWhere.sql).toContain('"tracked_accounts"."ig_username" = ');
    expect(twinWhere.sql).not.toContain('"tracked_accounts"."ig_user_id"');
  });

  it("fails open to the row itself on a DB error, and warns", async () => {
    responses.push(new Error("connection terminated"));

    await expect(canonicalTwinId(KALEZ_ROW)).resolves.toBe(KALEZ_ROW);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup", async () => {
    responses.push(new Error("statement timeout"));
    await canonicalTwinId(KALEZ_ROW);

    responses.push(
      [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }],
      [{ id: ROB_ROW }],
    );
    await expect(canonicalTwinId(KALEZ_ROW)).resolves.toBe(ROB_ROW);
  });

  it("revalidates anchor privacy and cached eligibility before reusing an election", async () => {
    responses.push(
      [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }],
      [{ id: ROB_ROW }],
    );
    await canonicalTwinId(KALEZ_ROW);
    const queriesAfterFirst = whereConditions.length;

    responses.push(
      [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1", isPrivate: false }],
      [{ id: ROB_ROW }],
    );
    await expect(canonicalTwinId(KALEZ_ROW)).resolves.toBe(ROB_ROW);
    expect(whereConditions).toHaveLength(queriesAfterFirst + 2);
    expect(orderBys).toHaveLength(1);
    expect(renderedWhere(3).sql).toContain('"tracked_accounts"."is_private" = ');
    expect(renderedWhere(3).sql).toContain("subscriptions entitlement");
  });

  it("expires the cache after 60 s", async () => {
    vi.useFakeTimers();
    try {
      responses.push(
        [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }],
        [{ id: ROB_ROW }],
      );
      await canonicalTwinId(KALEZ_ROW);
      vi.advanceTimersByTime(60_001);

      responses.push(
        [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }],
        [{ id: KALEZ_ROW }],
      );
      await expect(canonicalTwinId(KALEZ_ROW)).resolves.toBe(KALEZ_ROW);
      expect(whereConditions).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("twinTrackedAccountIds", () => {
  it("finds every active row observing the same ig_user_id", async () => {
    responses.push(
      [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }],
      [{ id: KALEZ_ROW }, { id: ROB_ROW }],
    );

    const ids = await twinTrackedAccountIds(KALEZ_ROW);

    expect(ids).toEqual([KALEZ_ROW, ROB_ROW]);
    const twinWhere = renderedWhere(1);
    expect(twinWhere.sql).toContain('"tracked_accounts"."ig_user_id" = ');
    expect(twinWhere.params).toContain(ISOJELENE_PK);
  });

  it("always includes the requested account, even with no twins", async () => {
    responses.push([{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }], []);

    await expect(twinTrackedAccountIds(ROB_ROW)).resolves.toEqual([ROB_ROW]);
  });

  it("does not duplicate the requested account when the query returns it", async () => {
    responses.push(
      [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }],
      [{ id: ROB_ROW }, { id: KALEZ_ROW }, { id: ROB_ROW }],
    );

    await expect(twinTrackedAccountIds(ROB_ROW)).resolves.toEqual([
      ROB_ROW,
      KALEZ_ROW,
    ]);
  });

  it("falls back to ig_username when ig_user_id is null", async () => {
    responses.push(
      [{ igUserId: null, igUsername: "tracked_user_1" }],
      [{ id: KALEZ_ROW }, { id: ROB_ROW }],
    );

    const ids = await twinTrackedAccountIds(KALEZ_ROW);

    expect(ids).toEqual([KALEZ_ROW, ROB_ROW]);
    const twinWhere = renderedWhere(1);
    expect(twinWhere.sql).toContain('"tracked_accounts"."ig_username" = ');
    expect(twinWhere.sql).not.toContain('"tracked_accounts"."ig_user_id"');
    expect(twinWhere.params).toContain("tracked_user_1");
  });

  it("treats a blank ig_user_id like a null one", async () => {
    responses.push([{ igUserId: "   ", igUsername: "tracked_user_1" }], []);

    await twinTrackedAccountIds(KALEZ_ROW);

    expect(renderedWhere(1).sql).toContain('"tracked_accounts"."ig_username" = ');
  });

  it("excludes inactive rows", async () => {
    responses.push([{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }], []);

    await twinTrackedAccountIds(KALEZ_ROW);

    const twinWhere = renderedWhere(1);
    expect(twinWhere.sql).toContain('"tracked_accounts"."is_active" = ');
    expect(twinWhere.params).toContain(true);
  });

  it("returns the single account when the anchor row is missing", async () => {
    responses.push([]);

    await expect(twinTrackedAccountIds(KALEZ_ROW)).resolves.toEqual([KALEZ_ROW]);
    // No second query is issued for a row that does not exist.
    expect(whereConditions).toHaveLength(1);
  });

  it("fails open to the single account on a DB error, and warns", async () => {
    responses.push(new Error("connection terminated"));

    await expect(twinTrackedAccountIds(KALEZ_ROW)).resolves.toEqual([KALEZ_ROW]);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("fails open when the twin query itself throws", async () => {
    responses.push(
      [{ igUserId: ISOJELENE_PK, igUsername: "tracked_user_1" }],
      new Error("statement timeout"),
    );

    await expect(twinTrackedAccountIds(ROB_ROW)).resolves.toEqual([ROB_ROW]);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });
});

// ── dedupe ───────────────────────────────────────────────────────────────────

const AUG_01 = new Date("2026-08-01T00:00:00Z");
const AUG_02 = new Date("2026-08-02T00:00:00Z");
const SEP_01 = new Date("2026-09-01T00:00:00Z");
const SEP_02 = new Date("2026-09-02T00:00:00Z");

function likeRow(
  postId: string,
  postTakenAt: Date | null,
  detectedAt: Date,
  owner = "twin-a",
) {
  return { postId, postTakenAt, detectedAt, owner };
}

describe("dedupeLikedPostsByPostId", () => {
  it("keeps one row per post id", () => {
    const rows = [
      likeRow("p1", AUG_01, SEP_01),
      likeRow("p1", AUG_01, SEP_01, "twin-b"),
      likeRow("p2", AUG_02, SEP_01),
    ];

    expect(dedupeLikedPostsByPostId(rows).map((r) => r.postId)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("keeps the row with the newest postTakenAt", () => {
    const rows = [
      likeRow("p1", AUG_01, SEP_02, "stale"),
      likeRow("p1", AUG_02, SEP_01, "fresh"),
    ];

    expect(dedupeLikedPostsByPostId(rows)[0].owner).toBe("fresh");
  });

  it("tie-breaks equal post dates on the newest detectedAt", () => {
    const rows = [
      likeRow("p1", AUG_01, SEP_01, "older-sighting"),
      likeRow("p1", AUG_01, SEP_02, "newer-sighting"),
    ];

    expect(dedupeLikedPostsByPostId(rows)[0].owner).toBe("newer-sighting");
  });

  it("prefers a dated row over an undated legacy one, whatever the order", () => {
    const datedFirst = [
      likeRow("p1", AUG_01, SEP_01, "dated"),
      likeRow("p1", null, SEP_02, "legacy"),
    ];
    const legacyFirst = [
      likeRow("p1", null, SEP_02, "legacy"),
      likeRow("p1", AUG_01, SEP_01, "dated"),
    ];

    expect(dedupeLikedPostsByPostId(datedFirst)[0].owner).toBe("dated");
    expect(dedupeLikedPostsByPostId(legacyFirst)[0].owner).toBe("dated");
  });

  it("preserves first-seen order and does not mutate the input", () => {
    const rows = Object.freeze([
      likeRow("p2", AUG_02, SEP_01),
      likeRow("p1", SEP_01, SEP_02),
      likeRow("p2", AUG_02, SEP_02, "newer"),
    ]);

    const deduped = dedupeLikedPostsByPostId(rows);

    expect(deduped.map((r) => r.postId)).toEqual(["p2", "p1"]);
    expect(deduped[0].owner).toBe("newer");
    expect(rows).toHaveLength(3);
  });

  it("returns an empty array for no rows", () => {
    expect(dedupeLikedPostsByPostId([])).toEqual([]);
  });
});

describe("compareLikedPosts", () => {
  it("orders newest post first and sinks undated rows", () => {
    const rows = [
      likeRow("p1", null, SEP_02),
      likeRow("p2", AUG_01, SEP_01),
      likeRow("p3", SEP_01, SEP_01),
    ];

    expect([...rows].sort(compareLikedPosts).map((r) => r.postId)).toEqual([
      "p3",
      "p2",
      "p1",
    ]);
  });
});

// ── roster inheritance on promotion (audit 2026-09-02, C7) ───────────────────

// The live tracked_user_3 rows: canonical, its active twin, two deactivated.
const ASH_PK = "15852445480";
const ASH_CANON = "97956f92-b7f7-40c4-a7e2-ef585a7a57a5";
const ASH_TWIN = "f0bf8805-261d-44c3-9c90-814f9e488a11";
const ASH_OLD_A = "2d56784a-93a8-43e1-af0d-574eb475b8b7";
const ASH_OLD_B = "a235fdc5-70dc-44ff-b35e-a5771e4a7edb";

describe("siblingTrackedAccountIds", () => {
  it("returns every OTHER row for the IG user, active or not", async () => {
    responses.push(
      [{ igUserId: ASH_PK, igUsername: "tracked_user_3" }],
      [{ id: ASH_OLD_A }, { id: ASH_OLD_B }, { id: ASH_TWIN }],
    );

    await expect(siblingTrackedAccountIds(ASH_CANON)).resolves.toEqual([
      ASH_OLD_A,
      ASH_OLD_B,
      ASH_TWIN,
    ]);

    const where = renderedWhere(1);
    expect(where.sql).toContain('"tracked_accounts"."ig_user_id" = ');
    expect(where.sql).toContain('"tracked_accounts"."id" <> ');
    // A deactivated former canonical is exactly the donor a promoted twin
    // needs, so — unlike twinTrackedAccountIds — no is_active filter.
    expect(where.sql).not.toContain("is_active");
    expect(where.params).toEqual([ASH_PK, ASH_CANON, false]);
    expect(where.sql).toContain('"tracked_accounts"."is_private" = ');
  });

  it("falls back to the username when the row has no ig_user_id", async () => {
    responses.push([{ igUserId: null, igUsername: "tracked_user_3" }], [{ id: ASH_TWIN }]);

    await expect(siblingTrackedAccountIds(ASH_CANON)).resolves.toEqual([ASH_TWIN]);

    const where = renderedWhere(1);
    expect(where.sql).toContain('"tracked_accounts"."ig_username" = ');
    expect(where.params).toEqual(["tracked_user_3", ASH_CANON, false]);
  });

  it("returns [] for an unknown row", async () => {
    responses.push([]);
    await expect(siblingTrackedAccountIds("no-such-row")).resolves.toEqual([]);
  });

  it("fails CLOSED to [] on a DB error and warns", async () => {
    responses.push(new Error("connection reset"));

    await expect(siblingTrackedAccountIds(ASH_CANON)).resolves.toEqual([]);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });
});

describe("pickRosterInheritanceDonor", () => {
  const NOW = new Date("2026-09-03T02:00:00Z");
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  const candidate = (
    trackedAccountId: string,
    lastSuccessAt: Date | null,
    currentMembers = 140,
  ) => ({ trackedAccountId, lastSuccessAt, currentMembers });

  it("live ash pair today: the canonical row is fresher than its twin, so nothing is inherited", () => {
    // 97956f92 walked at 01:54 (canonical); f0bf8805 froze at 17:52 the day before.
    const donor = pickRosterInheritanceDonor(
      [candidate(ASH_TWIN, hoursAgo(8), 128)],
      hoursAgo(0.1),
      NOW,
    );
    expect(donor).toBeNull();
  });

  it("promotion: a frozen target inherits the deactivated former canonical's roster", () => {
    // 97956f92 deactivated → f0bf8805 promoted with its 128-member roster from
    // yesterday; the former canonical read 140 members 6 minutes ago.
    const former = candidate(ASH_CANON, hoursAgo(0.1), 140);
    const donor = pickRosterInheritanceDonor([former], hoursAgo(8), NOW);
    expect(donor).toBe(former);
  });

  it("a target that never walked inherits from any fresh donor", () => {
    const former = candidate(ASH_CANON, hoursAgo(2));
    expect(pickRosterInheritanceDonor([former], null, NOW)).toBe(former);
  });

  it("refuses a donor that is itself stale", () => {
    // Deactivated weeks ago: its roster is no better a baseline than a fresh walk.
    const donor = pickRosterInheritanceDonor(
      [candidate(ASH_OLD_A, hoursAgo(24 * 14))],
      hoursAgo(24 * 20),
      NOW,
    );
    expect(donor).toBeNull();
  });

  it("refuses an empty donor", () => {
    const donor = pickRosterInheritanceDonor(
      [candidate(ASH_CANON, hoursAgo(1), 0)],
      hoursAgo(8),
      NOW,
    );
    expect(donor).toBeNull();
  });

  it("ignores a candidate without a successful read", () => {
    expect(pickRosterInheritanceDonor([candidate(ASH_CANON, null)], null, NOW)).toBeNull();
  });

  it("requires a real lead: two rows that walked in the same cycle do not inherit", () => {
    // tracked_user_1's twins walked 400 ms apart before the walk collapse shipped.
    const target = hoursAgo(8);
    const donor = pickRosterInheritanceDonor(
      [candidate(ASH_TWIN, new Date(target.getTime() + 400))],
      target,
      NOW,
    );
    expect(donor).toBeNull();
    expect(DEFAULT_ROSTER_INHERITANCE_POLICY.minLeadMs).toBe(30 * 60 * 1000);
  });

  it("picks the freshest qualifying donor, ties broken by id", () => {
    const fresher = candidate(ASH_OLD_B, hoursAgo(1));
    const older = candidate(ASH_OLD_A, hoursAgo(3));
    expect(pickRosterInheritanceDonor([older, fresher], hoursAgo(24), NOW)).toBe(fresher);

    const tieA = candidate(ASH_OLD_B, hoursAgo(1));
    const tieB = candidate(ASH_OLD_A, hoursAgo(1));
    expect(pickRosterInheritanceDonor([tieA, tieB], hoursAgo(24), NOW)).toBe(tieB);
  });

  it("honours a custom policy", () => {
    const donor = candidate(ASH_CANON, hoursAgo(2));
    expect(
      pickRosterInheritanceDonor([donor], hoursAgo(24), NOW, {
        maxDonorAgeMs: 60 * 60 * 1000,
        minLeadMs: 0,
      }),
    ).toBeNull();
    expect(
      pickRosterInheritanceDonor([donor], hoursAgo(24), NOW, {
        maxDonorAgeMs: 3 * 60 * 60 * 1000,
        minLeadMs: 0,
      }),
    ).toBe(donor);
  });

  it("does not mutate its input", () => {
    const input = [candidate(ASH_OLD_A, hoursAgo(3)), candidate(ASH_OLD_B, hoursAgo(1))];
    const snapshot = input.map((c) => ({ ...c }));
    pickRosterInheritanceDonor(input, null, NOW);
    expect(input).toEqual(snapshot);
  });
});
