// Retroactively cancel churn that was recorded BEFORE the churn-cancellation fix
// (2026-07-16) shipped. A username with BOTH a follow and an unfollow event
// inside the window is pagination flapping, not activity (see roster-churn.ts) —
// both events are deleted so the "recently followed/unfollowed" lists and the
// report counts reflect only genuine transitions.
//
// Same rule the live path now enforces at write time; this just backfills the
// correction for events already on disk.
//
//   npx tsx server/scripts/cleanup-flapping-events.ts [--dry] [--days=2]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

interface Dimension {
  readonly label: string;
  readonly followTable: string;
  readonly followCol: string;
  readonly unfollowTable: string;
  readonly unfollowCol: string;
}

const DIMENSIONS: ReadonlyArray<Dimension> = [
  {
    label: "following",
    followTable: "follow_events",
    followCol: "followed_username",
    unfollowTable: "unfollow_events",
    unfollowCol: "unfollowed_username",
  },
  {
    label: "follower",
    followTable: "follower_events",
    followCol: "follower_username",
    unfollowTable: "follower_unfollow_events",
    unfollowCol: "unfollower_username",
  },
];

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? Number(daysArg.split("=")[1]) : 2;
  const cutoff = `now() - interval '${Number.isFinite(days) ? days : 2} days'`;

  let totalDeleted = 0;

  for (const d of DIMENSIONS) {
    // Usernames (per account) present in BOTH tables inside the window = churn.
    const pairs = await db.execute(
      sql.raw(`
        SELECT f.tracked_account_id, lower(f.${d.followCol}) AS u
        FROM ${d.followTable} f
        WHERE f.detected_at > ${cutoff}
          AND EXISTS (
            SELECT 1 FROM ${d.unfollowTable} uf
            WHERE uf.tracked_account_id = f.tracked_account_id
              AND lower(uf.${d.unfollowCol}) = lower(f.${d.followCol})
              AND uf.detected_at > ${cutoff}
          )
        GROUP BY f.tracked_account_id, lower(f.${d.followCol})
      `),
    );
    const rows = (pairs as unknown as { rows: { tracked_account_id: string; u: string }[] }).rows;
    console.log(`[cleanup] ${d.label}: ${rows.length} flapping username(s) across accounts`);

    for (const r of rows) {
      if (dry) continue;
      await db.execute(
        sql.raw(`
          DELETE FROM ${d.followTable}
          WHERE tracked_account_id = '${r.tracked_account_id}'
            AND lower(${d.followCol}) = '${r.u.replace(/'/g, "''")}'
            AND detected_at > ${cutoff}
        `),
      );
      await db.execute(
        sql.raw(`
          DELETE FROM ${d.unfollowTable}
          WHERE tracked_account_id = '${r.tracked_account_id}'
            AND lower(${d.unfollowCol}) = '${r.u.replace(/'/g, "''")}'
            AND detected_at > ${cutoff}
        `),
      );
      totalDeleted += 1;
    }
  }

  console.log(
    `[cleanup] ${dry ? "DRY — would cancel" : "cancelled"} ${totalDeleted} flapping pair-set(s)`,
  );
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[cleanup] fatal:", err);
  process.exit(1);
});
