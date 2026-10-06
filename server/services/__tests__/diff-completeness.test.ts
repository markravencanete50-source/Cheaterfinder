// Tests for the completeness gate, and for how the persistence layer feeds it
// into the roster reconcile engine.
//
// Bug context 1 (2026-05): a 12-follower capture against a 495-follower account
// produced 305 false-positive unfollow_events. The gate requires the live
// capture to hold >= 90% of the expected baseline (latest profile_snapshots
// row) before absence may be considered at all.
//
// Bug context 2 (2026-07-15): the gate alone was NOT enough, and this file's
// original premise — "new-follower inserts are additive-safe in all cases" —
// was the reason. Roster state was reconstructed from the event log, so once
// the derived baseline drifted low, every complete read re-reported
// long-standing follows as brand new. @example_account: 860 follows / 859
// unfollows in a week on a following count that never left 215.
//
// So persistence no longer diffs anything itself. It decides whether the read
// is complete, hands the capture to reconcileRoster (roster-store.ts), and
// writes events for CONFIRMED transitions only. These tests cover that contract
// with the engine mocked; the engine's own semantics are covered against real
// Postgres in roster-store.integration.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Env / module-load order stubs ──────────────────────────────────────────

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../../observability/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock("../realtime-events.js", () => ({
  emitRealtime: vi.fn(),
}));

// The reconcile engine is unit-isolated here: these tests assert what
// persistence does with its VERDICT, not how the verdict is reached.
// Churn cancellation is unit-isolated here (its real behaviour is covered
// against Postgres in churn-cancel.integration.test.ts). Pass everything
// through unchanged so these tests assert persistence's own contract.
vi.mock("../roster-churn.js", () => ({
  cancelChurn: vi.fn(
    async (
      _tx: unknown,
      _accountId: string,
      arrivals: string[],
      departures: string[],
    ) => ({ arrivals, departures }),
  ),
}));

vi.mock("../roster-store.js", () => ({
  reconcileRoster: vi.fn(
    async (
      _tx: unknown,
      _accountId: string,
      dimension: string,
      live: ReadonlyArray<unknown>,
      isCompleteRead: boolean,
    ) => {
      fixtures.reconcileCalls.push({ dimension, isCompleteRead, live });
      return fixtures.rosterResult;
    },
  ),
}));

// ─── Mocked DB ──────────────────────────────────────────────────────────────
//
// The persistence helpers issue several distinct queries:
//   1. SELECT ... FROM profile_snapshots (expected baseline lookup, plain db)
//   2. db.transaction(tx):
//        a. tx.execute(pg_advisory_xact_lock)         (D2 serialization)
//        b. tx.execute(SQL known-set reconstruction)  (D5)
//        c. tx.insert(event tables)
//        d. tx.select(follower_events)                (unfollower enrichment)
//   3. SELECT ... FROM tracked_accounts (username cache lookup, post-commit)
//
// knownFollowers / knownFollowed ARE the membership sets the SQL known-set
// query would return (latest follow strictly newer than latest unfollow);
// tx.execute lowercases them like the real `lower(username)` projection.
// Insert calls are recorded per-table; selects route on the FROM table.

const fixtures = vi.hoisted(() => {
  return {
    knownFollowers: [] as Array<{ username: string }>,
    knownFollowed: [] as Array<{ username: string }>,
    profileSnapshot: null as { value: number | null } | null,
    trackedAccount: { igUsername: "test_user" },
    followerDetails: [] as Array<unknown>,
    insertCalls: [] as Array<{ table: string; rows: ReadonlyArray<unknown> }>,
    executeCalls: [] as Array<{ text: string; values: ReadonlyArray<unknown> }>,
    updateCalls: [] as Array<{ table: string; values: unknown }>,
    // What the mocked reconcileRoster reports back.
    rosterResult: {
      arrivals: [] as Array<{ username: string; displayName: string | null }>,
      departures: [] as string[],
      currentCount: 0,
      settled: true,
      justSettled: false,
    },
    reconcileCalls: [] as Array<{
      dimension: string;
      isCompleteRead: boolean;
      live: ReadonlyArray<unknown>;
    }>,
    reset: function () {
      this.knownFollowers = [];
      this.knownFollowed = [];
      this.profileSnapshot = null;
      this.followerDetails = [];
      this.insertCalls = [];
      this.executeCalls = [];
      this.updateCalls = [];
      this.reconcileCalls = [];
      this.rosterResult = {
        arrivals: [],
        departures: [],
        currentCount: 0,
        settled: true,
        justSettled: false,
      };
    },
  };
});

function tableNameOf(symbol: unknown): string {
  // Drizzle table objects expose a Symbol-keyed name. The schema mock below
  // attaches a plain `__tableName` for easy identification in tests.
  const t = symbol as { __tableName?: string } | undefined;
  return t?.__tableName ?? "";
}

const dbMock = vi.hoisted(() => {
  // Build a thenable select-builder chain that resolves to the right fixture.
  function buildSelect(_columns: unknown) {
    let fromTable = "";
    const builder: {
      from: (t: unknown) => typeof builder;
      where: (..._args: unknown[]) => typeof builder;
      orderBy: (..._args: unknown[]) => typeof builder;
      limit: (_n: number) => Promise<ReadonlyArray<unknown>>;
      then: (
        resolve: (rows: ReadonlyArray<unknown>) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise<unknown>;
    } = {
      from(t: unknown) {
        const flagged = t as { __tableName?: string };
        fromTable = flagged.__tableName ?? "";
        return builder;
      },
      where(..._args: unknown[]) {
        return builder;
      },
      orderBy(..._args: unknown[]) {
        return builder;
      },
      async limit(_n: number) {
        return resolveRows(fromTable);
      },
      then(resolve, reject) {
        try {
          return Promise.resolve(resolveRows(fromTable)).then(resolve, reject);
        } catch (e) {
          if (reject) return Promise.resolve(reject(e));
          return Promise.reject(e);
        }
      },
    };
    return builder;
  }

  function resolveRows(tableName: string): ReadonlyArray<unknown> {
    switch (tableName) {
      case "followerEvents":
        // The known set is now read via tx.execute (SQL reconstruction), so
        // the only followerEvents SELECT left is the unfollower enrichment.
        return fixtures.followerDetails;
      case "profileSnapshots":
        return fixtures.profileSnapshot ? [fixtures.profileSnapshot] : [];
      case "trackedAccounts":
        return [fixtures.trackedAccount];
      default:
        return [];
    }
  }

  function buildInsert(table: unknown) {
    const tableName = (table as { __tableName?: string }).__tableName ?? "";
    return {
      values(rows: ReadonlyArray<unknown>) {
        fixtures.insertCalls.push({ table: tableName, rows });
        return Promise.resolve();
      },
    };
  }

  // tx.execute routes on the captured SQL text: the advisory lock is a
  // no-op, and the two known-set reconstructions return the membership
  // fixtures lowercased — exactly what the real lower(username) projection
  // would produce.
  async function execute(query: unknown): Promise<{ rows: unknown[] }> {
    const q = query as { text?: string; values?: ReadonlyArray<unknown> };
    fixtures.executeCalls.push({
      text: q?.text ?? "",
      values: q?.values ?? [],
    });
    const text = q?.text ?? "";
    if (text.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }
    if (text.includes("followed_username")) {
      return {
        rows: fixtures.knownFollowed.map((r) => ({
          u: r.username.toLowerCase(),
        })),
      };
    }
    if (text.includes("follower_username")) {
      return {
        rows: fixtures.knownFollowers.map((r) => ({
          u: r.username.toLowerCase(),
        })),
      };
    }
    return { rows: [] };
  }

  function buildUpdate(table: unknown) {
    const tableName = (table as { __tableName?: string }).__tableName ?? "";
    const builder = {
      set(values: unknown) {
        fixtures.updateCalls.push({ table: tableName, values });
        return builder;
      },
      where(..._args: unknown[]) {
        return Promise.resolve();
      },
    };
    return builder;
  }

  const tx = {
    execute: vi.fn(execute),
    select: vi.fn(buildSelect),
    insert: vi.fn(buildInsert),
    update: vi.fn(buildUpdate),
  };

  return {
    db: {
      select: vi.fn(buildSelect),
      insert: vi.fn(buildInsert),
      execute: vi.fn(execute),
      transaction: vi.fn(
        async (fn: (txClient: typeof tx) => Promise<unknown>) => fn(tx),
      ),
    },
  };
});

vi.mock("../../db.js", () => dbMock);

// ─── Mocked schema (provides identifiable table tokens) ─────────────────────
//
// We don't need the real Drizzle schema here — we just need each table
// reference to carry an identifying tag so the mock db can route reads.

vi.mock("../../../shared/schema.js", () => {
  const tag = (name: string) => ({
    __tableName: name,
    // Column placeholders. Drizzle calls like `.where(eq(table.col, ...))`
    // never inspect their inner shape in our mock, so empty objects are fine.
    id: {},
  });
  return {
    commentsCache: tag("commentsCache"),
    followEvents: { ...tag("followEvents"), followedUsername: {} },
    followerEvents: {
      ...tag("followerEvents"),
      followerUsername: {},
      followerDisplayName: {},
      followerIgUserId: {},
      followerPfpUrl: {},
      trackedAccountId: {},
    },
    followerUnfollowEvents: {
      ...tag("followerUnfollowEvents"),
      unfollowerUsername: {},
    },
    highlightItemsCache: tag("highlightItemsCache"),
    highlightsCache: tag("highlightsCache"),
    postsCache: tag("postsCache"),
    storiesCache: tag("storiesCache"),
    trackedAccounts: { ...tag("trackedAccounts"), igUsername: {} },
    unfollowEvents: {
      ...tag("unfollowEvents"),
      unfollowedUsername: {},
    },
    profileSnapshots: {
      ...tag("profileSnapshots"),
      followerCount: { __tableName: "profileSnapshots" },
      followingCount: { __tableName: "profileSnapshots" },
      trackedAccountId: {},
      snapshotAt: {},
    },
  };
});

// drizzle-orm helpers used throughout — return inert markers. The `sql`
// template tag must preserve the literal SQL text and interpolated values:
// the mock db's execute() routes on that text (advisory lock vs the two
// known-set reconstructions).
vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => ({ __op: "and" }),
  asc: (..._args: unknown[]) => ({ __op: "asc" }),
  eq: (..._args: unknown[]) => ({ __op: "eq" }),
  desc: (..._args: unknown[]) => ({ __op: "desc" }),
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

// ─── Modules under test (after mocks) ───────────────────────────────────────

import {
  shouldComputeUnfollowDiff,
  shouldEnumerateRoster,
  COMPLETENESS_THRESHOLD,
} from "../diff-completeness.js";
import {
  persistFollowerDiff,
  persistFollowingDiff,
} from "../public-data-persistence.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function liveFollowers(usernames: ReadonlyArray<string>) {
  return usernames.map((u) => ({
    username: u,
    fullName: null,
    igUserId: null,
    profilePicUrl: null,
  }));
}

beforeEach(() => {
  fixtures.reset();
});

// ─── Pure decision tests ────────────────────────────────────────────────────

describe("shouldComputeUnfollowDiff", () => {
  it("allows the diff when no baseline is present (first scrape)", () => {
    const d = shouldComputeUnfollowDiff(0, null);
    expect(d.allowUnfollowDiff).toBe(true);
    expect(d.expectedCount).toBeNull();
  });

  it("allows the diff at exactly 90% completeness", () => {
    const d = shouldComputeUnfollowDiff(90, 100);
    expect(d.allowUnfollowDiff).toBe(true);
    expect(d.completeness).toBeCloseTo(0.9);
  });

  it("allows the diff well above the threshold (95%)", () => {
    const d = shouldComputeUnfollowDiff(95, 100);
    expect(d.allowUnfollowDiff).toBe(true);
  });

  it("blocks the diff at 50% completeness", () => {
    const d = shouldComputeUnfollowDiff(50, 100);
    expect(d.allowUnfollowDiff).toBe(false);
    expect(d.completeness).toBeCloseTo(0.5);
  });

  it("blocks the diff in the wire.fluid scenario (12/495)", () => {
    const d = shouldComputeUnfollowDiff(12, 495);
    expect(d.allowUnfollowDiff).toBe(false);
    expect(d.completeness).toBeLessThan(0.05);
  });

  it("special-cases expected=0: only allow when live=0", () => {
    // expected=0 + live=0: account has no followers and we captured none →
    // diff is trivially safe (nothing to detect).
    expect(shouldComputeUnfollowDiff(0, 0).allowUnfollowDiff).toBe(true);
    // expected=0 + live>0: would mean we're suddenly seeing followers for
    // an account previously known to have zero. New rows are additive-safe
    // and inserted at the call site, but the gate blocks the unfollow side
    // because the baseline (0) gives no meaningful divisor.
    expect(shouldComputeUnfollowDiff(5, 0).allowUnfollowDiff).toBe(false);
  });

  it("uses the documented threshold constant", () => {
    expect(COMPLETENESS_THRESHOLD).toBe(0.9);
  });
});

// ─── Diff-aware enumeration gate (Phase 2) ──────────────────────────────────

describe("shouldEnumerateRoster", () => {
  const NOW = 1_000_000_000_000;
  const TTL = 6 * 60 * 60 * 1000;
  const base = {
    currentCount: 100,
    prevCount: 100,
    liveRosterTotal: 100,
    lastCaptureAtMs: NOW - 60_000, // 1 min ago — fresh
    nowMs: NOW,
    forceFullTtlMs: TTL,
  };

  it("enumerates on the first cycle (no baseline)", () => {
    const d = shouldEnumerateRoster({ ...base, prevCount: null });
    expect(d).toEqual({ fetch: true, reason: "no-baseline" });
  });

  it("enumerates when no roster has ever been captured", () => {
    const d = shouldEnumerateRoster({ ...base, lastCaptureAtMs: null });
    expect(d).toEqual({ fetch: true, reason: "never-captured" });
  });

  it("enumerates when the count changed", () => {
    const d = shouldEnumerateRoster({ ...base, currentCount: 101 });
    expect(d).toEqual({ fetch: true, reason: "count-changed" });
  });

  it("enumerates when the stored roster is below the completeness threshold", () => {
    // count stable at 100 but only 50 held (50% < 90%)
    const d = shouldEnumerateRoster({ ...base, liveRosterTotal: 50 });
    expect(d).toEqual({ fetch: true, reason: "roster-incomplete" });
  });

  it("enumerates via the force-full valve once the held roster goes stale", () => {
    const d = shouldEnumerateRoster({
      ...base,
      lastCaptureAtMs: NOW - (TTL + 1),
    });
    expect(d).toEqual({ fetch: true, reason: "force-full-valve" });
  });

  it("SKIPS when count is stable, roster complete, and capture is fresh", () => {
    const d = shouldEnumerateRoster(base);
    expect(d).toEqual({ fetch: false, reason: "unchanged" });
  });

  it("treats exactly-90% held roster as complete enough to skip", () => {
    const d = shouldEnumerateRoster({ ...base, liveRosterTotal: 90 });
    expect(d.fetch).toBe(false);
  });

  it("skips a zero-follower account without a divide-by-zero (count=0)", () => {
    const d = shouldEnumerateRoster({
      ...base,
      currentCount: 0,
      prevCount: 0,
      liveRosterTotal: 0,
    });
    expect(d).toEqual({ fetch: false, reason: "unchanged" });
  });

  it("does NOT keep re-enumerating once the held roster hits the enumerable cap (M2)", () => {
    // IG reports 50000 but the pagination cap is 15000 — holding 15000 is the
    // most we can ever capture, so stop forcing re-fetch (would be 0 savings).
    const d = shouldEnumerateRoster({
      ...base,
      currentCount: 50_000,
      prevCount: 50_000,
      liveRosterTotal: 15_000,
      maxEnumerableItems: 15_000,
    });
    expect(d.fetch).toBe(false);
  });

  it("still re-enumerates an incomplete roster that is below the cap", () => {
    const d = shouldEnumerateRoster({
      ...base,
      currentCount: 50_000,
      prevCount: 50_000,
      liveRosterTotal: 10_000,
      maxEnumerableItems: 15_000,
    });
    expect(d).toEqual({ fetch: true, reason: "roster-incomplete" });
  });
});

// ─── Integration: persistFollowerDiff under the gate ────────────────────────

// ─── Persistence -> reconcile engine contract ───────────────────────────────
//
// persistence's whole job now: judge completeness, hand the capture over, and
// write events for whatever the engine CONFIRMS. It must never decide for
// itself who is new or who left.

describe("persistFollowerDiff -> reconcile", () => {
  it("passes isCompleteRead=true when the capture meets the threshold", async () => {
    fixtures.profileSnapshot = { value: 3 };
    await persistFollowerDiff("acct-1", liveFollowers(["alice", "bob", "carol"]));

    expect(fixtures.reconcileCalls).toHaveLength(1);
    expect(fixtures.reconcileCalls[0]?.dimension).toBe("follower");
    expect(fixtures.reconcileCalls[0]?.isCompleteRead).toBe(true);
  });

  it("passes isCompleteRead=false for the wire.fluid capture (12/495)", async () => {
    fixtures.profileSnapshot = { value: 495 };
    const live = liveFollowers(Array.from({ length: 12 }, (_, i) => `f_${i}`));

    const out = await persistFollowerDiff("acct-2", live);

    // The engine is told the read proves nothing about absence...
    expect(fixtures.reconcileCalls[0]?.isCompleteRead).toBe(false);
    // ...and with no confirmed departures, no unfollow rows are written.
    expect(out.newFollowerUnfollows).toBe(0);
    expect(
      fixtures.insertCalls.filter((c) => c.table === "followerUnfollowEvents"),
    ).toHaveLength(0);
  });

  it("measures completeness on DISTINCT members, not raw capture length", async () => {
    fixtures.profileSnapshot = { value: 100 };
    // 95 raw rows, but pagination overlap means only 60 distinct accounts.
    // Raw length would score 95/100 = complete; real coverage is 60/100 = 60%.
    // @example_account hit exactly this: 215 rows collapsing to 175 distinct.
    const dupes = Array.from({ length: 35 }, (_, i) => `f_${i}`);
    const live = liveFollowers([
      ...Array.from({ length: 60 }, (_, i) => `f_${i}`),
      ...dupes,
    ]);

    await persistFollowerDiff("acct-dupe-gate", live);

    expect(fixtures.reconcileCalls[0]?.live).toHaveLength(60);
    expect(fixtures.reconcileCalls[0]?.isCompleteRead).toBe(false);
  });

  it("treats a missing baseline snapshot as a complete read", async () => {
    fixtures.profileSnapshot = null; // never scraped before
    await persistFollowerDiff("acct-4", liveFollowers(["bob"]));
    expect(fixtures.reconcileCalls[0]?.isCompleteRead).toBe(true);
  });

  it("writes follower_events for confirmed arrivals, enriched from the capture", async () => {
    fixtures.profileSnapshot = { value: 2 };
    fixtures.rosterResult.arrivals = [{ username: "dave", displayName: "Dave" }];

    const out = await persistFollowerDiff("acct-5", [
      {
        username: "dave",
        fullName: "Dave",
        igUserId: "ig-9",
        profilePicUrl: "https://pfp.example/dave.jpg",
      },
    ]);

    expect(out.newFollowers).toBe(1);
    const insert = fixtures.insertCalls.find((c) => c.table === "followerEvents");
    // ig_user_id / pfp live only on the capture, not in roster_members — they
    // must be mapped back rather than lost.
    expect(insert?.rows).toEqual([
      {
        trackedAccountId: "acct-5",
        followerUsername: "dave",
        followerDisplayName: "Dave",
        followerIgUserId: "ig-9",
        followerPfpUrl: "https://pfp.example/dave.jpg",
      },
    ]);
  });

  it("writes NOTHING while the roster baseline is still settling", async () => {
    fixtures.profileSnapshot = { value: 2 };
    // A settling roster reports no arrivals/departures at all.
    fixtures.rosterResult = {
      arrivals: [],
      departures: [],
      currentCount: 2,
      settled: false,
      justSettled: false,
    };

    const out = await persistFollowerDiff("acct-6", liveFollowers(["a", "b"]));

    expect(out.newFollowers).toBe(0);
    expect(out.newFollowerUnfollows).toBe(0);
    expect(fixtures.insertCalls).toHaveLength(0);
  });
});

describe("persistFollowingDiff -> reconcile", () => {
  it("passes isCompleteRead=false on an incomplete following capture", async () => {
    fixtures.profileSnapshot = { value: 200 };
    const live = liveFollowers(Array.from({ length: 30 }, (_, i) => `t_${i}`));

    const out = await persistFollowingDiff("acct-7", live);

    expect(fixtures.reconcileCalls[0]?.dimension).toBe("following");
    expect(fixtures.reconcileCalls[0]?.isCompleteRead).toBe(false);
    expect(out.newUnfollows).toBe(0);
  });

  it("writes follow/unfollow events for confirmed transitions only", async () => {
    fixtures.profileSnapshot = { value: 10 };
    fixtures.rosterResult.arrivals = [{ username: "New_Guy", displayName: "New" }];
    fixtures.rosterResult.departures = ["gone_guy"];

    const out = await persistFollowingDiff(
      "acct-8",
      liveFollowers(Array.from({ length: 10 }, (_, i) => `u${i}`)),
    );

    expect(out.newFollows).toBe(1);
    expect(out.newUnfollows).toBe(1);
    expect(
      fixtures.insertCalls.find((c) => c.table === "followEvents")?.rows,
    ).toEqual([
      {
        trackedAccountId: "acct-8",
        followedUsername: "New_Guy",
        followedDisplayName: "New",
      },
    ]);
    expect(
      fixtures.insertCalls.find((c) => c.table === "unfollowEvents")?.rows,
    ).toEqual([{ trackedAccountId: "acct-8", unfollowedUsername: "gone_guy" }]);
  });

  it("stamps the 'genuinely new follows' boundary when the roster settles", async () => {
    fixtures.profileSnapshot = { value: 1 };
    fixtures.rosterResult.justSettled = true;

    await persistFollowingDiff("acct-9", liveFollowers(["x"]));

    // Migration 0027's boundary must line up with the moment the roster became
    // believable — before it, no follow_event can be proven genuine.
    const update = fixtures.updateCalls.find((c) => c.table === "trackedAccounts");
    expect(update).toBeDefined();
    expect(Object.keys(update?.values as object)).toContain(
      "followingFirstCompleteAt",
    );
  });

  it("does not touch the boundary on an ordinary cycle", async () => {
    fixtures.profileSnapshot = { value: 1 };
    fixtures.rosterResult.justSettled = false;

    await persistFollowingDiff("acct-10", liveFollowers(["x"]));

    expect(fixtures.updateCalls).toHaveLength(0);
  });
});

// ─── D2: transaction + advisory-lock serialization ──────────────────────────

describe("diff transaction + advisory lock (D2)", () => {
  it("takes the per-(dimension, account) advisory lock FIRST, inside a transaction", async () => {
    dbMock.db.transaction.mockClear();
    dbMock.db.insert.mockClear();
    fixtures.profileSnapshot = { value: 2 };
    fixtures.rosterResult.arrivals = [{ username: "bob", displayName: null }];

    await persistFollowerDiff("acct-lock-1", liveFollowers(["alice", "bob"]));

    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
    // The lock is held before the reconcile touches roster state.
    expect(fixtures.executeCalls[0]?.text).toContain("pg_advisory_xact_lock");
    expect(fixtures.executeCalls[0]?.values).toEqual([
      0x4c4b0002, // FOLLOWER_DIFF_LOCK_NS
      "acct-lock-1",
    ]);
    // Event inserts go through the transaction client, never the plain db.
    expect(dbMock.db.insert).not.toHaveBeenCalled();
    expect(fixtures.insertCalls.map((c) => c.table)).toContain("followerEvents");
  });

  it("uses a distinct lock namespace for the following dimension", async () => {
    fixtures.profileSnapshot = { value: 1 };

    await persistFollowingDiff("acct-lock-2", liveFollowers(["x"]));

    expect(fixtures.executeCalls[0]?.text).toContain("pg_advisory_xact_lock");
    expect(fixtures.executeCalls[0]?.values).toEqual([
      0x4c4b0001, // FOLLOWING_DIFF_LOCK_NS
      "acct-lock-2",
    ]);
  });

  it("hands the engine a de-duplicated capture (pagination overlap)", async () => {
    fixtures.profileSnapshot = null;
    // "dave" appears twice with different casing.
    await persistFollowerDiff("acct-dupe", liveFollowers(["dave", "DAVE"]));

    expect(fixtures.reconcileCalls[0]?.live).toHaveLength(1);
  });
});

// ─── D12: case-insensitive unfollower-detail enrichment ─────────────────────
//
// Departures come back lowercased (roster_members.username_lower), while
// follower_events stores the original casing — so the unfollow row is rebuilt
// from the newest matching follower_events row.

describe("unfollower enrichment casing (D12)", () => {
  it("restores original casing and keeps the latest display data", async () => {
    fixtures.profileSnapshot = { value: 2 };
    fixtures.rosterResult.departures = ["alice_x"];
    // Enrichment rows arrive detected_at ASC — the later row must win.
    fixtures.followerDetails = [
      {
        followerUsername: "Alice_X",
        followerDisplayName: "Old Name",
        followerIgUserId: null,
        followerPfpUrl: null,
      },
      {
        followerUsername: "Alice_X",
        followerDisplayName: "Alice",
        followerIgUserId: "ig-123",
        followerPfpUrl: "https://pfp.example/alice.jpg",
      },
    ];

    const out = await persistFollowerDiff("acct-case", liveFollowers(["bob"]));

    expect(out.newFollowerUnfollows).toBe(1);
    expect(
      fixtures.insertCalls.find((c) => c.table === "followerUnfollowEvents")?.rows,
    ).toEqual([
      {
        trackedAccountId: "acct-case",
        unfollowerUsername: "Alice_X", // original casing restored
        unfollowerDisplayName: "Alice", // latest row wins
        unfollowerIgUserId: "ig-123",
        unfollowerPfpUrl: "https://pfp.example/alice.jpg",
      },
    ]);
  });

  it("falls back to the lowercased name when no row matches", async () => {
    fixtures.profileSnapshot = { value: 1 };
    fixtures.rosterResult.departures = ["ghost_user"];
    fixtures.followerDetails = []; // enrichment finds nothing

    const out = await persistFollowerDiff("acct-ghost", liveFollowers(["someone_else"]));

    expect(out.newFollowerUnfollows).toBe(1);
    expect(
      fixtures.insertCalls.find((c) => c.table === "followerUnfollowEvents")?.rows,
    ).toEqual([
      {
        trackedAccountId: "acct-ghost",
        unfollowerUsername: "ghost_user",
        unfollowerDisplayName: null,
        unfollowerIgUserId: null,
        unfollowerPfpUrl: null,
      },
    ]);
  });
});
