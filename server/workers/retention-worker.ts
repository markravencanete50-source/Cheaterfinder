// ─── Event retention prune ────────────────────────────────────────────────────
//
// Deletes rows older than a per-table retention window from each *true*
// event/log table. Idempotent and safe to run on empty tables — DELETE
// with no matches is a no-op.
//
// Retention matrix:
//   - like_events          RETENTION_DAYS_EVENTS           (default 90 days)
//   - profile_snapshots    RETENTION_DAYS_EVENTS           (default 90 days)
//   - scrape_outcome_log   RETENTION_DAYS_SCRAPE_OUTCOMES  (default 14 days)
//   - collection_jobs      RETENTION_DAYS_COLLECTION_JOBS  (default 14 days,
//                          terminal-status rows only — pending/running rows
//                          are never touched)
//   - like_evidence_post_checks (0041)  scan bookkeeping, window derived from
//                          LIKE_EVIDENCE_RECHECK_HOURS (>= 7 days)
//   - post_engagement_checks (0042)     engagement-scrape bookkeeping, window
//                          derived from ENGAGEMENT_RECHECK_HOURS (>= 7 days)
//
// NOT pruned here, deliberately:
//   - follow_events / unfollow_events: despite the "_events" name these are
//     NOT an append-only log — they are the durable source of truth for the
//     current following roster. buildFollowingRoster
//     (server/services/roster.ts) and the diff "known set" in
//     persistFollowingDiff (server/services/public-data-persistence.ts) both
//     reconstruct the roster as follow_events MINUS unfollow_events over ALL
//     history. Age-pruning an old follow row makes that target vanish from
//     the known set, so the next enumeration re-detects them as a false
//     "new follow" with a wrong detected-at date. The inbound
//     follower_events / follower_unfollow_events tables carry the same
//     roster semantics and are excluded for the same reason. Any future
//     pruning of these four tables must be compaction-aware (fold old
//     history into a roster snapshot first) — never a bare age cutoff.
//
// Invoked by the `retention` BullMQ queue once per day, and can also be run
// ad-hoc from a shell for operational cleanup.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  likeEvents,
  likeEvidencePostChecks,
  collectionJobs,
  postEngagementChecks,
  profileSnapshots,
} from "../../shared/schema.js";
import { logger } from "../observability/logger.js";

export interface RetentionSummary {
  retentionDays: number;
  scrapeOutcomeRetentionDays: number;
  collectionJobRetentionDays: number;
  likeEvents: number;
  profileSnapshots: number;
  scrapeOutcomeLog: number;
  collectionJobs: number;
  /** Migration 0041: liked-post scan bookkeeping rows removed. */
  likeEvidencePostChecks: number;
  /** Migration 0042: engagement re-scrape bookkeeping rows removed. */
  postEngagementChecks: number;
}

/**
 * Delete in bounded chunks so a large backlog (first run after deploy) never
 * holds a long-running DELETE lock or materializes tens of thousands of
 * returned rows in memory.
 */
const DELETE_BATCH_SIZE = 10_000;

function readRetentionDays(envName: string, fallbackDays: number): number {
  const raw = process.env[envName];
  if (!raw) return fallbackDays;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallbackDays;
  // Cap absurdly large values so a typo can't accidentally become 10000 days.
  return Math.min(parsed, 3650);
}

function getRetentionDays(): number {
  return readRetentionDays("RETENTION_DAYS_EVENTS", 90);
}

function getScrapeOutcomeRetentionDays(): number {
  return readRetentionDays("RETENTION_DAYS_SCRAPE_OUTCOMES", 14);
}

function getCollectionJobRetentionDays(): number {
  return readRetentionDays("RETENTION_DAYS_COLLECTION_JOBS", 14);
}

function cutoffFor(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Retention window for a "have we already scraped this?" bookkeeping table
 * (0041 like_evidence_post_checks, 0042 post_engagement_checks).
 *
 * A row is only useful while it can still suppress a re-read — that is, for its
 * feature's recheck window. A flat 7-day prune would SILENTLY truncate that
 * window if the knob were ever raised above it, so the floor tracks the knob:
 * one day of headroom above the configured window, clamped to [7, 31] days.
 * At both features' 24h defaults this evaluates to 7 days, i.e. unchanged.
 */
function bookkeepingRetentionDays(recheckHoursEnvName: string): number {
  const raw = Number(process.env[recheckHoursEnvName]);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 24;
  return Math.min(31, Math.max(7, Math.ceil(hours / 24) + 1));
}

function deletedCount(result: unknown): number {
  const count = (result as { rowCount?: number | null }).rowCount;
  return typeof count === "number" && count > 0 ? count : 0;
}

/**
 * Prune `scrape_outcome_log` (one row per outbound IG call — pure telemetry,
 * read only by ops dashboards) in batches. Safe to re-run.
 */
async function pruneScrapeOutcomeLog(cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM scrape_outcome_log
      WHERE id IN (
        SELECT id FROM scrape_outcome_log
        WHERE occurred_at < ${cutoff}
        LIMIT ${DELETE_BATCH_SIZE}
      )
    `);
    const deleted = deletedCount(result);
    total += deleted;
    if (deleted < DELETE_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Prune `collection_jobs` audit rows (one row per scheduler tick) in batches.
 * Only terminal rows are eligible — pending/running rows are live scheduler
 * state and must never be deleted regardless of age. Terminal rows always
 * carry `completed_at`; `started_at` is a defensive fallback.
 */
async function pruneCollectionJobs(cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM ${collectionJobs}
      WHERE ${collectionJobs.id} IN (
        SELECT ${collectionJobs.id} FROM ${collectionJobs}
        WHERE ${collectionJobs.status} IN ('completed', 'failed')
          AND COALESCE(${collectionJobs.completedAt}, ${collectionJobs.startedAt}) < ${cutoff}
        LIMIT ${DELETE_BATCH_SIZE}
      )
    `);
    const deleted = deletedCount(result);
    total += deleted;
    if (deleted < DELETE_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Delete events older than the retention window from every prunable event
 * table. Returns a summary of rows removed per table. Safe to re-run.
 */
export async function pruneOldEvents(): Promise<RetentionSummary> {
  // Safety bookkeeping has independent bounded retention; do not delete any
  // follow/unfollow baseline or reduce customer-visible event retention.
  await db.execute(sql`DELETE FROM scrape_capacity_log WHERE occurred_at < now() - interval '14 days'`);
  await db.execute(sql`DELETE FROM backend_operation_leases WHERE expires_at < now() - interval '1 day'`);
  await db.execute(sql`DELETE FROM interactive_refresh_state WHERE succeeded_at < now() - interval '7 days'`);
  await db.execute(sql`DELETE FROM mobile_auth_sessions WHERE expires_at < now() - interval '1 day'`);
  await db.execute(sql`DELETE FROM mobile_legacy_revocations WHERE revoked_before < now() - interval '61 days'`);
  const retentionDays = getRetentionDays();
  const scrapeOutcomeRetentionDays = getScrapeOutcomeRetentionDays();
  const collectionJobRetentionDays = getCollectionJobRetentionDays();
  const cutoff = cutoffFor(retentionDays);

  const log = logger.child({
    module: "retention",
    retentionDays,
    scrapeOutcomeRetentionDays,
    collectionJobRetentionDays,
    cutoff: cutoff.toISOString(),
  });
  log.info("starting prune");

  const likes = await db
    .delete(likeEvents)
    .where(sql`${likeEvents.detectedAt} < ${cutoff}`)
    .returning({ id: likeEvents.id });

  // follow_events / unfollow_events intentionally NOT pruned — they are
  // roster state, not events. See the header comment of this file.

  const snapshots = await db
    .delete(profileSnapshots)
    .where(sql`${profileSnapshots.snapshotAt} < ${cutoff}`)
    .returning({ id: profileSnapshots.id });

  const scrapeOutcomes = await pruneScrapeOutcomeLog(
    cutoffFor(scrapeOutcomeRetentionDays),
  );

  const jobs = await pruneCollectionJobs(cutoffFor(collectionJobRetentionDays));

  // Migration 0041 bookkeeping. A row only suppresses a re-read for
  // LIKE_EVIDENCE_RECHECK_HOURS, so anything older than that window is dead
  // weight; the floor keeps generous headroom above the 24h default.
  const postCheckCutoff = cutoffFor(
    bookkeepingRetentionDays("LIKE_EVIDENCE_RECHECK_HOURS"),
  );
  const postChecks = await db
    .delete(likeEvidencePostChecks)
    .where(sql`${likeEvidencePostChecks.checkedAt} < ${postCheckCutoff}`)
    .returning({ mediaId: likeEvidencePostChecks.mediaId });

  // Migration 0042 bookkeeping, same shape: a row only suppresses an
  // engagement re-scrape for ENGAGEMENT_RECHECK_HOURS. Dropping a row early
  // costs one duplicate scrape, never lost data, so this is safe to prune
  // aggressively — but never below the configured recheck window, or the
  // memory would expire behind the feature's back.
  const engagementCheckCutoff = cutoffFor(
    bookkeepingRetentionDays("ENGAGEMENT_RECHECK_HOURS"),
  );
  const engagementChecks = await db
    .delete(postEngagementChecks)
    .where(sql`${postEngagementChecks.checkedAt} < ${engagementCheckCutoff}`)
    .returning({ mediaId: postEngagementChecks.mediaId });

  const summary: RetentionSummary = {
    retentionDays,
    scrapeOutcomeRetentionDays,
    collectionJobRetentionDays,
    likeEvents: likes.length,
    profileSnapshots: snapshots.length,
    scrapeOutcomeLog: scrapeOutcomes,
    collectionJobs: jobs,
    likeEvidencePostChecks: postChecks.length,
    postEngagementChecks: engagementChecks.length,
  };

  log.info(summary, "prune complete");
  return summary;
}
