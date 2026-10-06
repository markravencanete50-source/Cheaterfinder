// Remove pre-roster-rewrite enumeration DUMPS from follow_events / follower_events
// and restore the "Recently Followed" boundary so genuine follows surface.
//
// ROOT CAUSE (Issue 2, 2026-07-16): before the roster rewrite, the derived-diff
// mechanism re-emitted the ENTIRE roster as "new follows" whenever its baseline
// drifted — producing dense per-minute batches (@sample_account: 172 follow
// events in one minute). Genuine follows are sparse (1-2 per minute). The
// dumps are noise; the sparse events (like the client's single "sam_shamounian"
// follow) are real.
//
// Separately, resetting roster_sync_state this session forced a re-settle that
// re-stamped following_first_complete_at forward, hiding the sparse genuine
// follows that predate it. persistFollowingDiff is now SET-ONCE so that can't
// recur; this script repairs the already-corrupted boundaries.
//
// Fix: delete dump-cluster events (>= THRESHOLD per account per minute), then
// set each settled account's boundary to just before its earliest surviving
// follow so every genuine follow shows and stays consistent with the feed.
//
//   npx tsx server/scripts/cleanup-follow-dumps.ts [--dry] [--threshold=15]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const thArg = process.argv.find((a) => a.startsWith("--threshold="));
  const threshold = thArg ? Number(thArg.split("=")[1]) : 15;

  for (const table of ["follow_events", "follower_events"]) {
    // Compute dump-minutes ONCE (per account+minute count), then join — a
    // correlated subquery re-runs per row and is O(n^2) on these tables.
    const dumpMinutes = `
      SELECT tracked_account_id AS tid, date_trunc('minute', detected_at) AS m
      FROM ${table} GROUP BY 1, 2 HAVING count(*) >= ${threshold}`;
    const c = await db.execute(
      sql.raw(`
        SELECT count(*)::int AS n
        FROM ${table} e JOIN (${dumpMinutes}) d
          ON d.tid = e.tracked_account_id AND date_trunc('minute', e.detected_at) = d.m`),
    );
    const n = Number((c as unknown as { rows: { n: number }[] }).rows[0].n);
    console.log(`[dumps] ${table}: ${n} dump-cluster event(s) ${dry ? "(dry)" : "to delete"}`);
    if (!dry && n > 0) {
      await db.execute(
        sql.raw(`
          DELETE FROM ${table} e
          USING (${dumpMinutes}) d
          WHERE d.tid = e.tracked_account_id AND date_trunc('minute', e.detected_at) = d.m`),
      );
    }
  }

  // Repair the boundary: for each account that has one, move it to just before
  // its earliest surviving follow so genuine follows are no longer hidden.
  // Accounts with no surviving follows keep their boundary (nothing to show).
  if (!dry) {
    const res = await db.execute(sql`
      UPDATE tracked_accounts ta
      SET following_first_complete_at = sub.min_follow - interval '1 second'
      FROM (
        SELECT tracked_account_id, min(detected_at) AS min_follow
        FROM follow_events GROUP BY 1
      ) sub
      WHERE ta.id = sub.tracked_account_id
        AND ta.following_first_complete_at IS NOT NULL
        AND ta.following_first_complete_at > sub.min_follow
    `);
    const updated = (res as unknown as { rowCount?: number }).rowCount ?? 0;
    console.log(`[dumps] boundary restored for ${updated} account(s)`);
  } else {
    console.log("[dumps] (dry) would restore boundaries for corrupted accounts");
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[dumps] fatal:", err);
  process.exit(1);
});
