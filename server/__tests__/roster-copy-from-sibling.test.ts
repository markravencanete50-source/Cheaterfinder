// Unit tests for roster-store `copyRosterFromSibling` (audit 2026-09-02, C7).
//
// Regression context: a non-canonical twin never walks, so its roster freezes
// (tracked_user_3: 128 members held on f0bf8805 vs 139-140 on the canonical
// 97956f92). When the canonical row is deactivated the frozen row is promoted
// and, walked as-is, would report the 12 members who arrived since as fake new
// followers. The copy must therefore be an EXACT replacement — members with
// their hysteresis state, and the sync state INCLUDING the read epoch and the
// saved cursor — inside one transaction, and must refuse to wipe the target
// when the sibling has nothing to give.
//
// The DB is mocked; every statement handed to `tx.execute` is rendered with the
// real PgDialect so the column lists and parameter order are asserted, not
// just "something ran".

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

const executed: SQL[] = [];
const selectResponses: unknown[][] = [];
let transactions = 0;

function selectChain() {
  const promise = Promise.resolve(selectResponses.shift() ?? []);
  const chain = Object.assign(promise, { limit: () => promise });
  return { from: () => ({ where: () => chain }) };
}

const tx = {
  select: () => selectChain(),
  execute: (statement: SQL) => {
    executed.push(statement);
    return Promise.resolve({ rows: [] });
  },
};

vi.mock("../db.js", () => ({
  db: {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      return fn(tx);
    },
  },
}));

const loggerInfo = vi.fn();
vi.mock("../observability/logger.js", () => {
  const sink = { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...sink, child: () => sink } };
});

const { copyRosterFromSibling } = await import("../services/roster-store.js");

const dialect = new PgDialect();
const render = (statement: SQL) => dialect.sqlToQuery(statement);
const verb = (sqlText: string) => sqlText.trim().split(/\s+/).slice(0, 2).join(" ");

// The live tracked_user_3 pair.
const CANON = "97956f92-b7f7-40c4-a7e2-ef585a7a57a5";
const TWIN = "f0bf8805-261d-44c3-9c90-814f9e488a11";

const MEMBER_COLUMNS = [
  "username_lower",
  "username",
  "display_name",
  "ig_user_id",
  "pfp_url",
  "first_seen_at",
  "last_seen_at",
  "missing_streak",
  "is_current",
  "left_at",
  "last_post_at",
  "posts_checked_at",
  "owner_is_private",
  "owner_profile_checked_at",
];
const SYNC_STATE_COLUMNS = [
  "seeded_at",
  "complete_reads",
  "settled_at",
  "last_complete_read_at",
  "last_member_count",
  "stable_reads",
  "last_attempt_at",
  "last_success_at",
  "failure_kind",
  "last_error",
  "next_retry_at",
  "next_cursor",
  "viewer_bot_id",
  "cursor_updated_at",
  "epoch_started_at",
  "epoch_completed_at",
  "epoch_start_member_count",
  "epoch_legs",
];

beforeEach(() => {
  executed.length = 0;
  selectResponses.length = 0;
  transactions = 0;
  loggerInfo.mockReset();
});

describe("copyRosterFromSibling", () => {
  it("replaces the target's members and sync state with the sibling's, in one transaction", async () => {
    selectResponses.push(
      [{ lastSuccessAt: new Date("2026-09-02T23:54:57Z") }], // source sync state exists
      [{ members: 140, currentMembers: 140 }], // post-copy count
    );

    const result = await copyRosterFromSibling(CANON, TWIN, "follower");

    expect(result).toEqual({ members: 140, currentMembers: 140, syncStateCopied: true });
    expect(transactions).toBe(1);

    const allStatements = executed.map(render);
    expect(allStatements.slice(0,2).map(statement=>statement.params)).toEqual(
      [CANON,TWIN].sort().map(id=>[0x4c4b0002,id]),
    );
    expect(allStatements.slice(0,2).every(statement=>statement.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    const statements = allStatements.slice(2);
    // Delete-then-insert for members, then delete-then-insert for the state:
    // the target never holds a mix of its old rows and the sibling's.
    expect(statements.map((s) => verb(s.sql))).toEqual([
      "DELETE FROM",
      "INSERT INTO",
      "DELETE FROM",
      "INSERT INTO",
    ]);

    expect(statements[0].sql).toContain("DELETE FROM roster_members");
    expect(statements[0].params).toEqual([TWIN, "follower"]);

    expect(statements[1].sql).toContain("INSERT INTO roster_members");
    // Re-keyed to the target, read from the source, one dimension only.
    expect(statements[1].params).toEqual([TWIN, CANON, "follower"]);
    for (const column of MEMBER_COLUMNS) {
      expect(statements[1].sql).toContain(`rm.${column}`);
    }
    // `id` is regenerated, never copied.
    expect(statements[1].sql).not.toContain("rm.id");

    expect(statements[2].sql).toContain("DELETE FROM roster_sync_state");
    expect(statements[2].params).toEqual([TWIN, "follower"]);

    expect(statements[3].sql).toContain("INSERT INTO roster_sync_state");
    expect(statements[3].params).toEqual([TWIN, CANON, "follower"]);
    for (const column of SYNC_STATE_COLUMNS) {
      expect(statements[3].sql).toContain(`rss.${column}`);
    }

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTrackedAccountId: CANON,
        toTrackedAccountId: TWIN,
        dimension: "follower",
        members: 140,
      }),
      "copied roster from sibling tracking record",
    );
  });

  it("copies the requested dimension only", async () => {
    selectResponses.push([{ lastSuccessAt: new Date() }], [{ members: 91, currentMembers: 91 }]);

    await copyRosterFromSibling(CANON, TWIN, "following");

    expect(executed.slice(0,2).map(render).map(s=>s.params[0])).toEqual([0x4c4b0001,0x4c4b0001]);
    for (const statement of executed.slice(2).map(render)) {
      expect(statement.params).toContain("following");
      expect(statement.params).not.toContain("follower");
    }
  });

  it("leaves the target untouched when the sibling has no sync state", async () => {
    selectResponses.push([]); // no roster_sync_state row on the source

    const result = await copyRosterFromSibling(CANON, TWIN, "follower");

    expect(result).toEqual({ members: 0, currentMembers: 0, syncStateCopied: false });
    expect(executed).toHaveLength(2);
    expect(executed.map(render).every(s=>s.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("reports zero members when the sibling's roster is empty", async () => {
    selectResponses.push([{ lastSuccessAt: new Date() }], [{ members: 0, currentMembers: 0 }]);

    await expect(copyRosterFromSibling(CANON, TWIN, "follower")).resolves.toEqual({
      members: 0,
      currentMembers: 0,
      syncStateCopied: true,
    });
  });

  it("refuses to copy a row onto itself", async () => {
    await expect(copyRosterFromSibling(CANON, CANON, "follower")).rejects.toThrow(
      /same row/,
    );
    expect(transactions).toBe(0);
    expect(executed).toHaveLength(0);
  });
});
