// ─── FollowRequest State Machine ────────────────────────────────────────────
//
// Wave 2: the only place that is allowed to write bot_follow_requests.status.
// Previously every caller (bot-manager, workers, admin-routes) open-coded an
// `UPDATE ... SET status = 'X'`, and the valid transition graph lived as
// convention. That is fragile: a typo or a missed terminal-state check can
// re-open an accepted request, or skip the bot-release step.
//
// Transitions below are enforced via a single atomic compare-and-swap
// (WHERE status = $from). If the row is not in the expected source state
// the UPDATE hits 0 rows and we return a "noop" — this is intentional so
// that BullMQ retries / racing admin actions do not throw on idempotent
// re-application of the same transition.
// ─────────────────────────────────────────────────────────────────────────────

import { and, eq } from "drizzle-orm";
import { botFollowRequests } from "../../shared/schema.js";
import type { PgTransaction } from "drizzle-orm/pg-core";

export type FollowRequestStatus =
  | "queued"
  | "pending"
  | "accepted"
  | "rejected"
  | "expired"
  | "failed";

const VALID_TRANSITIONS: Record<FollowRequestStatus, FollowRequestStatus[]> = {
  // A confirmed existing relationship can be observed before a new request
  // needs sending. markFollowRequestAccepted also handles this idempotently.
  queued: ["pending", "accepted", "failed", "expired"],
  pending: ["accepted", "rejected", "expired", "failed"],
  accepted: [],
  rejected: [],
  expired: [],
  failed: [],
};

export class InvalidTransitionError extends Error {
  readonly from: FollowRequestStatus;
  readonly to: FollowRequestStatus;
  constructor(from: FollowRequestStatus, to: FollowRequestStatus) {
    super(
      `[follow-request-state] invalid transition ${from} -> ${to}; valid targets: ${VALID_TRANSITIONS[from].join(", ") || "<terminal>"}`,
    );
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export interface TransitionPatch {
  sentAt?: Date;
  resolvedAt?: Date;
  expiresAt?: Date;
  error?: string | null;
}

export type DbOrTx =
  | { update: typeof import("../db.js").db.update }
  | PgTransaction<any, any, any>;

export interface TransitionResult {
  changed: boolean;
  reason?: "terminal" | "wrong-source";
}

/**
 * Perform a guarded status transition on a bot_follow_requests row. Uses an
 * atomic compare-and-swap so two concurrent callers cannot both succeed.
 *
 * Throws InvalidTransitionError ONLY when the target is not reachable from
 * the declared source per the state machine. When the DB row simply isn't
 * in the expected source state (e.g. already transitioned by another worker)
 * we return { changed: false, reason: "wrong-source" } — callers should
 * treat this as idempotent no-op.
 */
export async function transitionFollowRequest(
  tx: any,
  id: string,
  from: FollowRequestStatus,
  to: FollowRequestStatus,
  patch: TransitionPatch = {},
): Promise<TransitionResult> {
  const allowed = VALID_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }

  const setClause: Record<string, unknown> = { status: to };
  if (patch.sentAt !== undefined) setClause.sentAt = patch.sentAt;
  if (patch.resolvedAt !== undefined) setClause.resolvedAt = patch.resolvedAt;
  if (patch.expiresAt !== undefined) setClause.expiresAt = patch.expiresAt;
  if (patch.error !== undefined) setClause.error = patch.error;

  const rows = await tx
    .update(botFollowRequests)
    .set(setClause)
    .where(
      and(
        eq(botFollowRequests.id, id),
        eq(botFollowRequests.status, from),
      ),
    )
    .returning({ id: botFollowRequests.id });

  if (rows.length === 0) {
    // Row already transitioned by someone else (BullMQ retry, admin override,
    // expiry sweep). Log at debug, treat as idempotent.
    console.log(
      `[follow-request-state] no-op transition ${from} -> ${to} for ${id} (row not in '${from}')`,
    );
    return { changed: false, reason: "wrong-source" };
  }
  return { changed: true };
}

export function isTerminal(status: FollowRequestStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}

/** Explicit upstream relationship evidence may revoke a prior approval.
 * Keep this separate from generic worker failures: a timeout or expired
 * session does not establish that the target removed its approval. */
export async function revokeAcceptedFollowRequest(
  tx: DbOrTx,
  id: string,
): Promise<TransitionResult> {
  const rows = await tx.update(botFollowRequests).set({
    status: "failed",
    error: "Approved follow relationship revoked",
    resolvedAt: new Date(),
  }).where(and(eq(botFollowRequests.id, id), eq(botFollowRequests.status, "accepted")))
    .returning({ id: botFollowRequests.id });
  return rows.length ? { changed: true } : { changed: false, reason: "wrong-source" };
}
