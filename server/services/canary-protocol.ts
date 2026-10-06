// Wave 6: Canary Protocol
//
// Limits the blast radius of risky Instagram endpoint changes. New or
// recently-broken endpoints stay locked behind the canary tier until the
// canary has tested them ≥ 3 times in the trailing 24h window with ≥ 80%
// success rate. Workers refuse to call endpoints that aren't yet
// pool-approved — the canary probes them on the workers' behalf.
//
// State is persisted in `endpoint_canary_state` (migration 0012b). Each row
// holds aggregated success/failure counts plus a pool_approved boolean. The
// counts represent the trailing-24h window: if the last_tested_at slips
// outside that window we treat the row as stale and reset on the next
// trial outcome so a long-cold endpoint has to re-prove itself.

import { db } from "../db.js";
import { endpointCanaryState } from "../../shared/schema.js";
import { eq, sql } from "drizzle-orm";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "canary-protocol" });

// ─── Tunables ────────────────────────────────────────────────────────────────

const TRIAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h trailing window
const MIN_TRIALS = 3;
const MIN_SUCCESS_RATE = 0.8;

export type CanaryOutcome = "success" | "failure";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface CanaryRow {
  endpoint: string;
  lastTestedAt: Date | null;
  successCount: number;
  failureCount: number;
  poolApproved: boolean;
  poolApprovedAt: Date | null;
}

/**
 * Decide whether the trailing-24h counts on the row are still fresh. If
 * lastTestedAt is null or older than the trial window, the row is stale and
 * its counters should be reset on the next outcome to keep the window
 * meaningful.
 */
function isWindowFresh(row: Pick<CanaryRow, "lastTestedAt">, now: Date): boolean {
  if (!row.lastTestedAt) return false;
  return now.getTime() - row.lastTestedAt.getTime() <= TRIAL_WINDOW_MS;
}

function isApprovable(successCount: number, failureCount: number): boolean {
  const total = successCount + failureCount;
  if (total < MIN_TRIALS) return false;
  return successCount / total >= MIN_SUCCESS_RATE;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Record the outcome of a canary trial against a given endpoint. Updates
 * the trailing counts and flips pool_approved to true once the threshold is
 * met. Idempotent and safe to call concurrently — the upsert serialises
 * concurrent writes via the primary key.
 *
 * A failure inside the active window does NOT automatically revoke a prior
 * approval. Approval revocation is an ops decision (DELETE the row, or call
 * with a fresh window). This keeps a single transient failure from
 * yanking a stable endpoint out from under the worker pool.
 */
export async function markEndpointTested(
  endpoint: string,
  outcome: CanaryOutcome,
): Promise<void> {
  const now = new Date();
  const successDelta = outcome === "success" ? 1 : 0;
  const failureDelta = outcome === "failure" ? 1 : 0;

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(endpointCanaryState)
      .where(eq(endpointCanaryState.endpoint, endpoint))
      .limit(1)
      .for("update");

    // First time we've seen this endpoint — insert a fresh row.
    if (!existing) {
      await tx.insert(endpointCanaryState).values({
        endpoint,
        lastTestedAt: now,
        successCount: successDelta,
        failureCount: failureDelta,
        poolApproved: false,
      });

      logger.info(
        { endpoint, outcome, successCount: successDelta, failureCount: failureDelta },
        "canary: first trial recorded",
      );
      return;
    }

    // Row exists. Decide whether to reset the trailing window or accumulate.
    const fresh = isWindowFresh({ lastTestedAt: existing.lastTestedAt }, now);
    const nextSuccess = (fresh ? existing.successCount : 0) + successDelta;
    const nextFailure = (fresh ? existing.failureCount : 0) + failureDelta;

    const shouldApprove =
      !existing.poolApproved && isApprovable(nextSuccess, nextFailure);

    await tx
      .update(endpointCanaryState)
      .set({
        lastTestedAt: now,
        successCount: nextSuccess,
        failureCount: nextFailure,
        ...(shouldApprove
          ? { poolApproved: true, poolApprovedAt: now }
          : {}),
      })
      .where(eq(endpointCanaryState.endpoint, endpoint));

    if (shouldApprove) {
      logger.info(
        { endpoint, successCount: nextSuccess, failureCount: nextFailure },
        "canary: endpoint pool-approved",
      );
    } else {
      logger.debug(
        {
          endpoint,
          outcome,
          successCount: nextSuccess,
          failureCount: nextFailure,
          windowReset: !fresh,
        },
        "canary: trial recorded",
      );
    }
  });
}

/**
 * Returns true when workers are allowed to call this endpoint. Hard rule:
 * the row must exist, pool_approved must be true, and the most recent trial
 * must be inside the trailing 24h window. A stale approval (no trials in
 * the last 24h) is NOT trusted — the canary has to re-validate first.
 */
export async function isEndpointPoolApproved(endpoint: string): Promise<boolean> {
  const [row] = await db
    .select({
      lastTestedAt: endpointCanaryState.lastTestedAt,
      successCount: endpointCanaryState.successCount,
      failureCount: endpointCanaryState.failureCount,
      poolApproved: endpointCanaryState.poolApproved,
    })
    .from(endpointCanaryState)
    .where(eq(endpointCanaryState.endpoint, endpoint))
    .limit(1);

  if (!row || !row.poolApproved) return false;

  const now = new Date();
  if (!isWindowFresh({ lastTestedAt: row.lastTestedAt }, now)) {
    logger.debug({ endpoint }, "canary: pool-approval stale, requires re-validation");
    return false;
  }

  // Re-check the success rate against the live counts in case the row was
  // updated by a parallel canary run.
  return isApprovable(row.successCount, row.failureCount);
}

// ─── Test-only export: tunables for unit tests to inspect ───────────────────

export const __canaryProtocolTunables = Object.freeze({
  TRIAL_WINDOW_MS,
  MIN_TRIALS,
  MIN_SUCCESS_RATE,
});

// Suppress unused-import warning when the module is consumed without using sql.
void sql;
