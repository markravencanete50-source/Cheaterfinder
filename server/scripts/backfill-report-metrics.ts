// Backfill reports.metrics for rows generated before migration 0028.
//
// Those reports only ever stored four numbers, two of which (total_follows /
// total_unfollows) are roster-DISCOVERY counts and can be flatly wrong — a
// 674-follower account was credited with "+3,251 new followers". The Reports
// UI therefore refuses to render them and falls back to a stub, which is why
// every existing card still looked thin after the redesign.
//
// buildReportData recomputes the honest payload from the data we still hold
// (profile snapshots, likes, posts), so old reports can be filled in rather
// than regenerated or discarded.
//
// Usage:  npx tsx server/scripts/backfill-report-metrics.ts [--dry]

import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db.js";
import { reports, trackedAccounts } from "../../shared/schema.js";
import {
  buildReportData,
  toReportMetrics,
} from "../services/report-data.js";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  // --force re-computes metrics for ALL ready reports (not only those missing
  // metrics), so a schema change to the payload (e.g. adding the likes
  // leaderboard) reaches existing rows without a destructive NULL-then-refill.
  const force = process.argv.includes("--force");

  const rows = await db
    .select({
      id: reports.id,
      trackedAccountId: reports.trackedAccountId,
      igUsername: trackedAccounts.igUsername,
      periodStart: reports.periodStart,
      periodEnd: reports.periodEnd,
      type: reports.type,
    })
    .from(reports)
    .innerJoin(trackedAccounts, eq(reports.trackedAccountId, trackedAccounts.id))
    .where(
      force
        ? eq(reports.status, "ready")
        : and(eq(reports.status, "ready"), isNull(reports.metrics)),
    );

  console.log(
    `[backfill] ${rows.length} ready report(s) ${force ? "(force: all)" : "without metrics"}`,
  );
  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const data = await buildReportData(
        row.trackedAccountId,
        row.periodStart,
        row.periodEnd,
        row.type ?? "weekly",
      );
      const metrics = toReportMetrics(data);

      if (!dry) {
        await db
          .update(reports)
          .set({
            metrics: metrics as never,
            // top_niche shipped hardcoded NULL for these rows.
            topNiche: data.topInterests[0]?.label ?? null,
          })
          .where(eq(reports.id, row.id));
      }

      ok++;
      console.log(
        `[backfill] ${dry ? "would fill" : "filled"} @${row.igUsername} ` +
          `${row.periodStart.toISOString().slice(0, 10)} → ` +
          `net ${metrics.summary.netFollowerChange ?? "n/a"} followers, ` +
          `${metrics.summary.totalLikes} likes, ` +
          `${metrics.ownPosts.publishedInPeriod} posts`,
      );
    } catch (err) {
      failed++;
      console.error(
        `[backfill] FAILED ${row.id} (@${row.igUsername}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log(`[backfill] done: ${ok} filled, ${failed} failed`);
  process.exit(failed > 0 && ok === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
