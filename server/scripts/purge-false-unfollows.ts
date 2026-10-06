// Purge FALSE unfollow events produced by truncated follower scrapes.
//
// A row is false when the roster contradicts it: the person is CURRENTLY a
// follower, the roster never recorded them leaving (left_at IS NULL), and we
// first saw them BEFORE the supposed unfollow. That combination can only mean
// the diff was fed a short capture and mistook missing-from-page for gone.
//
// Deliberately NOT deleted: rows where the member later re-followed (left_at
// set, or first_seen_at after the event). Those unfollows really happened and
// are legitimate history.
//
// Usage: npx tsx server/scripts/purge-false-unfollows.ts [--apply]
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

const FALSE_POSITIVE_FILTER = sql`
  EXISTS (
    SELECT 1 FROM roster_members r
    WHERE r.tracked_account_id = u.tracked_account_id
      AND r.dimension = 'follower'
      AND r.username_lower = lower(u.unfollower_username)
      AND r.is_current = true
      AND r.left_at IS NULL
      AND r.first_seen_at <= u.detected_at
  )
`;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const { rows: preview } = (await db.execute(sql`
    SELECT t.ig_username,
           COUNT(*) AS false_rows,
           (SELECT COUNT(*) FROM follower_unfollow_events x WHERE x.tracked_account_id = t.id) AS total_rows
    FROM follower_unfollow_events u
    JOIN tracked_accounts t ON t.id = u.tracked_account_id
    WHERE ${FALSE_POSITIVE_FILTER}
    GROUP BY t.id, t.ig_username
    ORDER BY 2 DESC
  `)) as any;

  if (preview.length === 0) {
    console.log("[purge] no false unfollow rows found");
    return;
  }
  for (const r of preview) {
    console.log(`[purge] @${r.ig_username}: ${r.false_rows} false of ${r.total_rows} total`);
  }
  const totalFalse = preview.reduce((n: number, r: any) => n + Number(r.false_rows), 0);
  console.log(`[purge] TOTAL false rows: ${totalFalse}`);

  if (!apply) {
    console.log("[purge] dry-run — re-run with --apply to delete");
    return;
  }
  const res = (await db.execute(sql`
    DELETE FROM follower_unfollow_events u WHERE ${FALSE_POSITIVE_FILTER}
  `)) as any;
  console.log(`[purge] DELETED ${res.rowCount ?? totalFalse} false unfollow rows`);
}

main().catch((e) => { console.error("[purge] ERR", e instanceof Error ? e.message : String(e)); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); });
