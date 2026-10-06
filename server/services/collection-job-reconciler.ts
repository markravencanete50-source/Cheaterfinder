// Reconcile audit rows left in `running` when a worker/process dies before its
// completion write. This is database bookkeeping only; it never touches Redis
// jobs or performs Instagram requests.

import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { db } from "../db.js";
import { collectionJobs } from "../../shared/schema.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "collection-job-reconciler" });

const DEFAULT_STALE_AGE_MS = 2 * 60 * 60 * 1000;

export async function reconcileStaleCollectionJobs(
  staleAgeMs: number = DEFAULT_STALE_AGE_MS,
  now: Date = new Date(),
): Promise<number> {
  const safeAgeMs = Math.max(30 * 60 * 1000, Math.trunc(staleAgeMs));
  const cutoff = new Date(now.getTime() - safeAgeMs);
  const rows = await db
    .update(collectionJobs)
    .set({
      status: "failed",
      // The worker disappeared before it wrote a completion time. Keep that
      // fact explicit instead of stamping the reconciliation time, which would
      // make months-old orphan rows look like brand-new production failures in
      // the 24-hour admin health metric.
      completedAt: null,
      error: "reconciled: worker exited before collection job completed",
    })
    .where(
      and(
        eq(collectionJobs.status, "running"),
        isNull(collectionJobs.completedAt),
        lt(collectionJobs.startedAt, cutoff),
      ),
    )
    .returning({ id: collectionJobs.id });

  if (rows.length > 0) {
    logger.warn(
      { count: rows.length, cutoff: cutoff.toISOString() },
      "reconciled stale running collection jobs",
    );
  }
  return rows.length;
}

/**
 * Reports left in `generating` by a worker that died mid-render never complete:
 * nothing re-drives them and the UI shows a spinner forever (two rows had sat
 * that way since 2026-05-08). Anything still generating after `maxAgeMs` is
 * marked failed so the user can regenerate.
 */
export async function reconcileStaleGeneratingReports(
  maxAgeMs = 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const result = await db.execute(sql`
    UPDATE reports SET status = 'failed'
     WHERE status = 'generating' AND created_at < ${cutoff}
  `);
  const count = Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  if (count > 0) {
    logger.warn({ count, cutoff: cutoff.toISOString() }, "reconciled stale generating reports");
  }
  return count;
}
