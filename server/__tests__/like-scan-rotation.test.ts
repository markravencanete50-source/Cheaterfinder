// ─── Tests for the like-scan rotation + first-visit id hint (audit A4/A5) ──
//
// Coverage:
//   - LIKE_EVIDENCE_REVISIT_HOURS parse (default 12, clamp [0, 720], NaN → 12)
//   - selectLikeEvidenceWindow: "activity" takes the head of the DUE list and
//     ignores the cursor; "cursor" delegates to takeRotatingWindow unchanged
//   - resolveLikeEvidenceAdvancedCursor: odometer in "activity" (wraps before
//     int4 overflow), position bookkeeping in "cursor" incl. early stop
//   - buildFollowingEvidenceRosterSql renders the exact statement the scan
//     runs: IS TRUE (never-profiled owners survive), the revisit clause only
//     when hours > 0, no bare literal in ORDER BY (lesson 22)
//   - buildDeferFailedOwnersSql / buildFollowingRosterExistsSql param binding
//   - rosterIgUserIdHint prefers a non-blank roster id (A5)
//
// Lesson-22 hook: with LIKE_SCAN_SQL_DUMP_DIR set, the rendered SQL + params
// are written there so the statements can be PREPAREd/EXECUTEd against the
// live DB (see the file names below). Off by default; no effect on assertions.
//
// Approach: workers.ts has heavy import-time side effects (Redis connection,
// BullMQ queues), so every direct dependency is mocked exactly as in
// like-scan-preflight.test.ts.

import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

const { mockExecute, noopLogger } = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { mockExecute: vi.fn(), noopLogger: logger };
});

// ── Mocks for every direct import of server/workers.ts ──────────────────────

vi.mock("bullmq", () => {
  class MockQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    on = vi.fn();
    add = vi.fn();
    getJob = vi.fn();
    close = vi.fn();
  }
  class MockWorker {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    on = vi.fn();
    close = vi.fn();
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

vi.mock("ioredis", () => ({
  default: class MockRedis {
    on(): this {
      return this;
    }
    async quit(): Promise<void> {}
  },
}));

vi.mock("../db.js", () => ({ db: { execute: mockExecute }, pool: {} }));

vi.mock("../observability/logger.js", () => ({
  logger: noopLogger,
  withCorrelation: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../services/public-data-collector.js", () => ({
  collectPublicData: vi.fn(),
}));
vi.mock("../services/public-data-service.js", () => ({
  getPostLikers: vi.fn(),
  getPublicProfile: vi.fn(),
  getUserPosts: vi.fn(),
}));
vi.mock("../bot-manager.js", () => ({
  assignBotToTrackedAccount: vi.fn(),
  getAcceptedBotSession: vi.fn(),
  markFollowRequestAccepted: vi.fn(),
  markFollowRequestFailed: vi.fn(),
  getPendingFollowRequests: vi.fn(),
  getExpiredFollowRequests: vi.fn(),
  releaseBotFromTrackedAccount: vi.fn(),
  rotateBotForTrackedAccount: vi.fn(),
}));
vi.mock("../bot-collectors.js", () => ({
  createBotCollectors: vi.fn(() => ({
    collectFollowsViaBotSession: vi.fn(),
    sendFollowForRequest: vi.fn(),
  })),
}));
vi.mock("../ig-http-client.js", () => ({
  createBotClient: vi.fn(),
  createHttpBotClient: vi.fn(),
  IGRateLimitedError: class IGRateLimitedError extends Error {},
}));
vi.mock("../domain/ig-client-port.js", () => ({
  IGCircuitOpenError: class IGCircuitOpenError extends Error {},
}));
vi.mock("../domain/follow-request-state.js", () => ({
  transitionFollowRequest: vi.fn(),
}));
vi.mock("../ig-public-scraper.js", () => ({
  scrapeProfile: vi.fn(),
  scrapeUserPostsWithBot: vi.fn(),
}));
vi.mock("../services/bot-runtime.js", () => ({ ensureBotReady: vi.fn() }));
vi.mock("../behavior/device-fingerprint.js", () => ({
  resolveFingerprint: vi.fn(),
}));
vi.mock("../integrations.js", () => ({ isResendConfigured: vi.fn(() => false) }));
vi.mock("../workers/retention-worker.js", () => ({ pruneOldEvents: vi.fn() }));
vi.mock("../workers/bot-warmer-worker.js", () => {
  const botWarmerQueue = { name: "bot-warming", on: vi.fn() };
  return {
    getBotWarmerQueue: vi.fn(() => botWarmerQueue),
    startBotWarmerWorker: vi.fn(),
  };
});
vi.mock("../workers/account-refresh-registrar.js", () => ({
  ACCOUNT_REFRESH_JOB_NAME: "account-refresh",
  reconcileAccountRefreshes: vi.fn(),
}));
vi.mock("../services/media-cache.js", () => ({ cacheMediaUrl: vi.fn() }));
vi.mock("../services/media-cache-jobs.js", () => ({
  mediaCacheQueue: { name: "media-cache", on: vi.fn() },
}));
vi.mock("../services/bandwidth-meter.js", () => ({
  startBandwidthMeter: vi.fn(),
  withScrapeContext: vi.fn(),
}));
vi.mock("../services/refresh-config.js", () => ({
  initRefreshConfig: vi.fn(async () => {}),
}));
vi.mock("../services/roster.js", () => ({
  buildFollowersRoster: vi.fn(),
  buildFollowingRoster: vi.fn(),
}));
const {
  LIKE_EVIDENCE_ODOMETER_WRAP,
  LIKE_EVIDENCE_REVISIT_HOURS_DEFAULT,
  buildDeferFailedOwnersSql,
  buildFollowingEvidenceRosterSql,
  buildFollowingRosterExistsSql,
  isLikeEvidenceActivityOrderingOn,
  resolveLikeEvidenceAdvancedCursor,
  resolveLikeEvidenceRevisitHours,
  rosterIgUserIdHint,
  selectLikeEvidenceWindow,
  takeRotatingWindow,
} = await import("../workers.js");

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(q);

function dumpSql(name: string, rendered: { sql: string; params: unknown[] }): void {
  const dir = process.env.LIKE_SCAN_SQL_DUMP_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.sql`), rendered.sql);
  writeFileSync(join(dir, `${name}.params.json`), JSON.stringify(rendered.params));
}

const ACCT = "acct-1dbb5e56";

describe("resolveLikeEvidenceRevisitHours", () => {
  it("defaults to 12 when unset, blank or unparseable", () => {
    expect(LIKE_EVIDENCE_REVISIT_HOURS_DEFAULT).toBe(12);
    expect(resolveLikeEvidenceRevisitHours({})).toBe(12);
    expect(resolveLikeEvidenceRevisitHours({ LIKE_EVIDENCE_REVISIT_HOURS: "  " })).toBe(12);
    expect(resolveLikeEvidenceRevisitHours({ LIKE_EVIDENCE_REVISIT_HOURS: "abc" })).toBe(12);
  });

  it("honours 0 (filter disabled) and clamps to [0, 720]", () => {
    expect(resolveLikeEvidenceRevisitHours({ LIKE_EVIDENCE_REVISIT_HOURS: "0" })).toBe(0);
    expect(resolveLikeEvidenceRevisitHours({ LIKE_EVIDENCE_REVISIT_HOURS: "6" })).toBe(6);
    expect(resolveLikeEvidenceRevisitHours({ LIKE_EVIDENCE_REVISIT_HOURS: "-3" })).toBe(0);
    expect(resolveLikeEvidenceRevisitHours({ LIKE_EVIDENCE_REVISIT_HOURS: "9999" })).toBe(720);
  });
});

describe("isLikeEvidenceActivityOrderingOn", () => {
  it("is on unless the env is exactly 'off'", () => {
    expect(isLikeEvidenceActivityOrderingOn({})).toBe(true);
    expect(isLikeEvidenceActivityOrderingOn({ LIKE_EVIDENCE_ACTIVITY_ORDERING: "on" })).toBe(true);
    expect(isLikeEvidenceActivityOrderingOn({ LIKE_EVIDENCE_ACTIVITY_ORDERING: "off" })).toBe(false);
  });
});

describe("selectLikeEvidenceWindow", () => {
  const due = ["never1", "never2", "old1", "old2", "old3"];

  it("activity: takes the head of the due list and ignores the cursor", () => {
    expect(selectLikeEvidenceWindow(due, 322, 2, "activity")).toEqual({
      items: ["never1", "never2"],
      start: 0,
      nextCursor: 0,
      rotation: "activity",
    });
    // A stale cursor from the old rotation must not shift the window.
    expect(selectLikeEvidenceWindow(due, 1282, 2, "activity").items).toEqual([
      "never1",
      "never2",
    ]);
  });

  it("activity: a limit past the due count takes everything, 0 takes nothing", () => {
    expect(selectLikeEvidenceWindow(due, 0, 50, "activity").items).toEqual(due);
    expect(selectLikeEvidenceWindow(due, 0, 0, "activity").items).toEqual([]);
    expect(selectLikeEvidenceWindow([], 7, 10, "activity").items).toEqual([]);
  });

  it("cursor: is takeRotatingWindow with the rotation tag", () => {
    expect(selectLikeEvidenceWindow(due, 4, 2, "cursor")).toEqual({
      ...takeRotatingWindow(due, 4, 2),
      rotation: "cursor",
    });
    expect(selectLikeEvidenceWindow(due, 4, 2, "cursor").items).toEqual(["old3", "never1"]);
  });
});

describe("resolveLikeEvidenceAdvancedCursor", () => {
  const base = {
    windowStart: 0,
    windowNextCursor: 0,
    ownersCompleted: 50,
    ownersScanned: 48,
    stoppedEarly: false,
    rosterSize: 1414,
  };

  it("activity: is an odometer of owners visited, whatever the stale position was", () => {
    expect(
      resolveLikeEvidenceAdvancedCursor({ ...base, rotation: "activity", currentCursor: 322 }),
    ).toBe(370);
    expect(
      resolveLikeEvidenceAdvancedCursor({
        ...base,
        rotation: "activity",
        currentCursor: 322,
        stoppedEarly: true,
        ownersScanned: 7,
      }),
    ).toBe(329);
  });

  it("activity: tolerates a garbage current value and wraps before int4 overflow", () => {
    expect(
      resolveLikeEvidenceAdvancedCursor({ ...base, rotation: "activity", currentCursor: NaN }),
    ).toBe(48);
    expect(
      resolveLikeEvidenceAdvancedCursor({
        ...base,
        rotation: "activity",
        currentCursor: LIKE_EVIDENCE_ODOMETER_WRAP - 10,
      }),
    ).toBe(48);
  });

  it("cursor: full window advances to nextCursor; early stop advances past finished owners only", () => {
    expect(
      resolveLikeEvidenceAdvancedCursor({
        ...base,
        rotation: "cursor",
        currentCursor: 100,
        windowStart: 100,
        windowNextCursor: 150,
      }),
    ).toBe(150);
    expect(
      resolveLikeEvidenceAdvancedCursor({
        ...base,
        rotation: "cursor",
        currentCursor: 1400,
        windowStart: 1400,
        windowNextCursor: 36,
        stoppedEarly: true,
        ownersCompleted: 20,
      }),
    ).toBe(6);
    expect(
      resolveLikeEvidenceAdvancedCursor({
        ...base,
        rotation: "cursor",
        currentCursor: 9,
        stoppedEarly: true,
        rosterSize: 0,
      }),
    ).toBe(9);
  });
});

describe("buildFollowingEvidenceRosterSql", () => {
  it("survives never-profiled owners (IS TRUE) and binds ttl/revisit/age/limit in order", () => {
    const rendered = render(
      buildFollowingEvidenceRosterSql(ACCT, {
        ownerProfileTtlHours: 168,
        revisitHours: 12,
        maxPostAgeHours: 720,
        maxItems: 15_000,
      }),
    );
    dumpSql("roster-revisit12", rendered);
    expect(rendered.sql).toContain("owner_is_private IS TRUE");
    expect(rendered.sql).not.toMatch(/owner_is_private\s*=\s*true/);
    expect(rendered.sql).toContain("owner_profile_checked_at IS NOT NULL");
    expect(rendered.sql).toMatch(
      /posts_checked_at IS NULL\s+OR posts_checked_at < NOW\(\) - \(\$3 \|\| ' hours'\)::interval/,
    );
    expect(rendered.params).toEqual([ACCT, 168, 12, 720, 15_000]);
  });

  it("omits the revisit clause entirely when the window is 0", () => {
    const rendered = render(
      buildFollowingEvidenceRosterSql(ACCT, {
        ownerProfileTtlHours: 168,
        revisitHours: 0,
        maxPostAgeHours: 720,
        maxItems: 15_000,
      }),
    );
    dumpSql("roster-revisit0", rendered);
    expect(rendered.sql).not.toMatch(/posts_checked_at IS NULL\s+OR/);
    expect(rendered.params).toEqual([ACCT, 168, 720, 15_000]);
  });

  it("keeps the band order and never puts a bare literal in ORDER BY (lesson 22)", () => {
    const { sql } = render(buildFollowingEvidenceRosterSql(ACCT));
    // Strip the inline SQL comments first; they sit between the terms.
    const orderBy = sql
      .slice(sql.indexOf("ORDER BY"), sql.indexOf("LIMIT"))
      .replace(/--[^\n]*/g, "");
    expect(orderBy).toMatch(/CASE[\s\S]*END,\s*posts_checked_at ASC NULLS FIRST,\s*username_lower ASC/);
    // Each ORDER BY term must be an expression: reject a term that is only digits.
    const terms = orderBy
      .replace(/^ORDER BY/, "")
      .split(/,(?![^()]*\))/)
      .map((t) => t.trim());
    expect(terms.some((t) => /^\d+$/.test(t))).toBe(false);
    expect(orderBy).toContain("WHEN owner_is_private IS TRUE THEN 3");
  });
});

describe("deferral + existence statements", () => {
  it("buildDeferFailedOwnersSql stamps only posts_checked_at for the named owners", () => {
    const rendered = render(buildDeferFailedOwnersSql(ACCT, ["dead_a", "dead_b"]));
    dumpSql("defer-failed-owners", rendered);
    expect(rendered.sql).toMatch(/UPDATE roster_members\s+SET posts_checked_at = NOW\(\)/);
    expect(rendered.sql).not.toContain("last_post_at");
    expect(rendered.sql).toMatch(/username_lower IN \(\$2, \$3\)/);
    expect(rendered.params).toEqual([ACCT, "dead_a", "dead_b"]);
  });

  it("buildFollowingRosterExistsSql binds the account and limits to one row", () => {
    const rendered = render(buildFollowingRosterExistsSql(ACCT));
    dumpSql("roster-exists", rendered);
    expect(rendered.sql).toMatch(/LIMIT 1/);
    expect(rendered.params).toEqual([ACCT]);
  });
});

describe("rosterIgUserIdHint (A5)", () => {
  it("returns a trimmed non-blank roster id and null otherwise", () => {
    expect(rosterIgUserIdHint(" 1234567 ")).toBe("1234567");
    expect(rosterIgUserIdHint("")).toBeNull();
    expect(rosterIgUserIdHint("   ")).toBeNull();
    expect(rosterIgUserIdHint(null)).toBeNull();
    expect(rosterIgUserIdHint(undefined)).toBeNull();
  });
});
