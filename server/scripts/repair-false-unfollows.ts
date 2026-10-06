// Purge false-positive unfollow events that the roster (source of truth,
// migration 0029) contradicts.
//
// ROOT CAUSE (Issue 1, 2026-07-16): the pre-roster-rewrite diff, and boundary
// flapping during settling, wrote unfollow_events for accounts that were never
// actually unfollowed — an account marked departed that later reappeared stays
// in the event log while roster_members correctly shows is_current=true. The
// "Unfollowed Accounts" section (and the weekly unfollow count / activity feed /
// reports, which still read the event log) then listed ~50 accounts the client
// still follows.
//
// An unfollow event whose target is CURRENTLY a live roster member is false by
// definition: the roster says they're still followed. Delete those. Genuine
// departures (roster is_current=false) are untouched.
//
//   npx tsx server/scripts/repair-false-unfollows.ts [--dry]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

interface Target {
  readonly label: string;
  readonly table: string;
  readonly col: string;
  readonly dimension: "following" | "follower";
}

const TARGETS: ReadonlyArray<Target> = [
  { label: "following unfollows", table: "unfollow_events", col: "unfollowed_username", dimension: "following" },
  { label: "follower unfollows", table: "follower_unfollow_events", col: "unfollower_username", dimension: "follower" },
];

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  let total = 0;

  for (const t of TARGETS) {
    const contradicted = `
      EXISTS (
        SELECT 1 FROM roster_members rm
        WHERE rm.tracked_account_id = e.tracked_account_id
          AND rm.dimension = '${t.dimension}'
          AND rm.username_lower = lower(e.${t.col})
          AND rm.is_current = true
      )`;

    const countRes = await db.execute(
      sql.raw(`SELECT count(*)::int AS n FROM ${t.table} e WHERE ${contradicted}`),
    );
    const n = Number((countRes as unknown as { rows: { n: number }[] }).rows[0].n);
    console.log(`[repair] ${t.label}: ${n} false event(s) ${dry ? "(dry)" : "to delete"}`);

    if (!dry && n > 0) {
      await db.execute(
        sql.raw(`DELETE FROM ${t.table} e WHERE ${contradicted}`),
      );
    }
    total += n;
  }

  console.log(`[repair] ${dry ? "DRY — would delete" : "deleted"} ${total} false unfollow event(s)`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[repair] fatal:", err);
  process.exit(1);
});
