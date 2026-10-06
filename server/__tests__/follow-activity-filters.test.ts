// Unit tests for the follow-activity gates in server/services/roster.ts.
//
// Regression context: unfollows shown to customers already came from
// roster_members gated by a settled-roster boundary and an unfollow-trust flag,
// but follows were still read from the raw follow_events log with none of the
// gates applied on the report/CSV paths — and 20 of @tracked_user_1's 89
// follow_events had an unfollow_events row for the same username inside the
// prior 14 days (pagination churn, not activity). These tests pin the pure
// pieces: the flip-flop predicate, the env-driven window, the boundary/trust
// derivation, and the SQL twin of the predicate.

import { describe, it, expect, afterEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../db.js", () => ({
  db: {
    select: () => {
      throw new Error("pure tests must not touch the database");
    },
    execute: () => {
      throw new Error("pure tests must not touch the database");
    },
  },
}));

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => stubLogger,
};
vi.mock("../observability/logger.js", () => ({ logger: stubLogger }));

const {
  isFlipFlopFollow,
  followFlipFlopWindowDays,
  deriveFollowActivityFilters,
  followActivityBoundary,
  isUnfollowRosterTrusted,
  visibleFollowEventsSql,
} = await import("../services/roster.js");

const dialect = new PgDialect();
const DAY_MS = 24 * 60 * 60 * 1000;

const ROW = "1dbb5e56-64c1-4aa4-b641-566b81a1f384";
const ROSTER_ROW = "dd8c9e98-07da-4784-b800-40ed4c9473ba";
const SEP_01 = new Date("2026-09-01T12:00:00Z");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
});

describe("isFlipFlopFollow", () => {
  const window = 14 * DAY_MS;

  it("suppresses a follow that lands inside the window after an unfollow", () => {
    const unfollow = new Date(SEP_01.getTime() - 3 * DAY_MS);
    expect(isFlipFlopFollow(SEP_01, unfollow, window)).toBe(true);
  });

  it("treats the window edge as a flip-flop", () => {
    const unfollow = new Date(SEP_01.getTime() - window);
    expect(isFlipFlopFollow(SEP_01, unfollow, window)).toBe(true);
  });

  it("keeps a follow whose prior unfollow is older than the window", () => {
    const unfollow = new Date(SEP_01.getTime() - window - 1);
    expect(isFlipFlopFollow(SEP_01, unfollow, window)).toBe(false);
  });

  it("keeps a follow with no prior unfollow", () => {
    expect(isFlipFlopFollow(SEP_01, null, window)).toBe(false);
  });

  it("does not let a LATER unfollow suppress the follow (that is a real unfollow)", () => {
    const later = new Date(SEP_01.getTime() + DAY_MS);
    expect(isFlipFlopFollow(SEP_01, later, window)).toBe(false);
  });

  it("suppresses only the exact same instant when the window is zero", () => {
    expect(isFlipFlopFollow(SEP_01, SEP_01, 0)).toBe(true);
    expect(isFlipFlopFollow(SEP_01, new Date(SEP_01.getTime() - 1), 0)).toBe(false);
  });
});

describe("followFlipFlopWindowDays", () => {
  it("defaults to 14 days", () => {
    vi.stubEnv("FOLLOW_FLIPFLOP_WINDOW_DAYS", "");
    expect(followFlipFlopWindowDays()).toBe(14);
  });

  it("reads FOLLOW_FLIPFLOP_WINDOW_DAYS", () => {
    vi.stubEnv("FOLLOW_FLIPFLOP_WINDOW_DAYS", "7");
    expect(followFlipFlopWindowDays()).toBe(7);
  });

  it("floors fractional days and rejects garbage or negatives", () => {
    vi.stubEnv("FOLLOW_FLIPFLOP_WINDOW_DAYS", "2.9");
    expect(followFlipFlopWindowDays()).toBe(2);
    vi.stubEnv("FOLLOW_FLIPFLOP_WINDOW_DAYS", "soon");
    expect(followFlipFlopWindowDays()).toBe(14);
    vi.stubEnv("FOLLOW_FLIPFLOP_WINDOW_DAYS", "-3");
    expect(followFlipFlopWindowDays()).toBe(14);
  });
});

describe("followActivityBoundary / deriveFollowActivityFilters", () => {
  const firstComplete = new Date("2026-07-01T00:00:00Z");
  const settled = new Date("2026-08-15T00:00:00Z");

  it("uses the LATER of first-complete and roster-settled", () => {
    expect(followActivityBoundary(firstComplete, settled)).toEqual(settled);
    expect(followActivityBoundary(settled, firstComplete)).toEqual(settled);
  });

  it("falls back to whichever anchor exists", () => {
    expect(followActivityBoundary(null, settled)).toEqual(settled);
    expect(followActivityBoundary(firstComplete, null)).toEqual(firstComplete);
  });

  it("has no boundary when neither anchor exists", () => {
    expect(followActivityBoundary(null, null)).toBeNull();
    expect(followActivityBoundary(undefined, undefined)).toBeNull();
  });

  it("does not trust unfollows while the roster baseline is unsettled", () => {
    const filters = deriveFollowActivityFilters({
      followingFirstCompleteAt: firstComplete,
      lastFollowingRefreshAt: SEP_01,
      rosterSettled: false,
      rosterSettledAt: null,
      rosterTotal: 900,
      snapshotFollowingCount: 900,
    });
    expect(filters.boundary).toEqual(firstComplete);
    expect(filters.unfollowsTrusted).toBe(false);
  });

  it("trusts unfollows once the settled roster holds the reported total", () => {
    const filters = deriveFollowActivityFilters({
      followingFirstCompleteAt: firstComplete,
      lastFollowingRefreshAt: SEP_01,
      rosterSettled: true,
      rosterSettledAt: settled,
      rosterTotal: 900,
      snapshotFollowingCount: 900,
    });
    expect(filters.boundary).toEqual(settled);
    expect(filters.unfollowsTrusted).toBe(true);
  });
});

describe("isUnfollowRosterTrusted", () => {
  it("is never trusted while the baseline is explicitly unsettled", () => {
    expect(isUnfollowRosterTrusted(100, 100, SEP_01, false)).toBe(false);
  });

  it("is trusted with no reported total to compare against", () => {
    expect(isUnfollowRosterTrusted(5, null, SEP_01, true)).toBe(true);
  });

  it("requires an empty roster when IG reports zero", () => {
    expect(isUnfollowRosterTrusted(0, 0, SEP_01, true)).toBe(true);
    expect(isUnfollowRosterTrusted(3, 0, SEP_01, true)).toBe(false);
  });
});

describe("visibleFollowEventsSql", () => {
  function render(boundary: Date | null) {
    return dialect.sqlToQuery(
      visibleFollowEventsSql({
        trackedAccountId: ROW,
        rosterAccountId: ROSTER_ROW,
        boundary,
      }),
    );
  }

  it("stays per-row, applies the boundary, and gates on both suppressions", () => {
    vi.stubEnv("FOLLOW_FLIPFLOP_WINDOW_DAYS", "14");
    const { sql, params } = render(SEP_01);

    expect(sql).toContain('"follow_events"."tracked_account_id" = ');
    // follow_events are written for the canonical roster row only (C1), so the
    // read keys on ROSTER_ROW; the per-row boundary still applies.
    expect(params).toContain(ROSTER_ROW);
    expect(sql).toContain('"follow_events"."detected_at" > ');
    // The boundary is bound as a parameter (drizzle may hand the driver a Date
    // or its ISO form).
    expect(
      params.some((p) =>
        p instanceof Date
          ? p.getTime() === SEP_01.getTime()
          : String(p).startsWith("2026-09-01T12:00:00"),
      ),
    ).toBe(true);
    // Flip-flop: an unfollow of the same lower(username) within the prior window.
    expect(sql).toContain('FROM "unfollow_events" ue');
    expect(sql).toContain("lower(ue.unfollowed_username) = lower(");
    expect(sql).toContain("interval '1 day' * 14");
    // Roster contradiction: the canonical twin's roster says not followed.
    expect(sql).toContain('FROM "roster_members" rm');
    expect(sql).toContain("rm.is_current = false");
    expect(params).toContain(ROSTER_ROW);
  });

  it("matches nothing when there is no boundary", () => {
    const { sql } = render(null);
    expect(sql).toContain("false");
    expect(sql).not.toContain('"follow_events"."detected_at" > ');
  });

  it("honours FOLLOW_FLIPFLOP_WINDOW_DAYS", () => {
    vi.stubEnv("FOLLOW_FLIPFLOP_WINDOW_DAYS", "7");
    expect(render(SEP_01).sql).toContain("interval '1 day' * 7");
  });
});
