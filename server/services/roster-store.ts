// ─── Roster store: the roster as real state ─────────────────────────────────
//
// Replaces the derivation that treated the append-only event log as mutable
// state ("currently followed" = a follow_event with no newer unfollow_event).
// That made the diff consume its own output: one short or differently-paginated
// read corrupted the baseline for good, and every later read "repaired" it by
// re-emitting the gap as fresh activity. It never converged. Live proof
// (2026-07-15): @example_account's following sat unchanged at 215 for hours while
// the derived set held 170, and the system invented ~45 follows + ~32 unfollows
// every cycle — 860/859 over a week, none of it real.
//
// Two ideas make this correct, and both matter:
//
//   1. PERSISTENCE. The roster lives in a table. A member seen once stays known
//      even if the next read's pagination happens to omit them. The old set
//      forgot them and had to rediscover them, which is what produced the churn.
//
//   2. CONFIRMATION. Presence is proof (IG returned the member, so they exist),
//      but absence is not — IG's paginated enumeration returns a slightly
//      different subset every pass. A member must be missing from
//      ROSTER_ABSENCE_CONFIRMATIONS consecutive COMPLETE reads before we accept
//      that they are gone. This hysteresis is what turns pagination churn into a
//      non-event instead of an unfollow.
//
// A third safeguard covers the baseline itself. A single paginated read never
// returns the whole roster, so its missing tail would resurface later as fake
// "new follows". Reads are therefore unioned in silence until the union STOPS
// GROWING (ROSTER_SETTLE_READS consecutive reads adding nothing new); only then
// do we believe a change means activity.
//
// Settling deliberately does NOT key off Instagram's reported follower/following
// number. That number is unreachable — it counts ghosts, deactivated, private
// and blocked-from-our-bot accounts that no enumeration returns. Measured
// 2026-07-15: @complex reports 1,090 following and enumerates to 743 (68%);
// @example_account reports 215 and enumerates to ~175 (81%). Requiring 90% of the
// reported number would leave both accounts permanently unsettled and reporting
// nothing at all. Stability is self-calibrating: whatever the enumerable set
// turns out to be, the roster settles on it.
//
// follow_events / unfollow_events are demoted to a derived audit trail of
// CONFIRMED transitions. Nothing may reconstruct roster state from them again.
// ────────────────────────────────────────────────────────────────────────────

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db.js";
import { FOLLOWING_DIFF_LOCK_NS, FOLLOWER_DIFF_LOCK_NS, lockAccountForDiff } from "./roster-diff-lock.js";
import {
  rosterMembers,
  rosterSyncState,
  trackedAccounts,
} from "../../shared/schema.js";
import { logger as baseLogger } from "../observability/logger.js";

/** A transaction handle, matching public-data-persistence's local alias. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const logger = baseLogger.child({ module: "roster-store" });

export type RosterDimension = "following" | "follower";
export type RosterFailureKind =
  | "list_restricted"
  | "rate_limited"
  | "auth"
  | "unavailable"
  // The account's roster is larger than we can ever enumerate (the gate refuses
  // it outright — @tracked_user_4 has 336,541 followers against a 2,000
  // cap). Without an explicit state such an account looks identical to one that
  // is merely still seeding: it sat "unsettled" for 45 DAYS with
  // last_attempt=NEVER, which reads as a broken feature rather than a known
  // limit. This kind exists so the state is honest and the UI can say so.
  | "too_large";

export interface RosterSyncHealth {
  readonly settled: boolean;
  readonly settledAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastCompleteReadAt?: Date | null;
  readonly failureKind: RosterFailureKind | null;
  readonly lastError: string | null;
  readonly nextRetryAt: Date | null;
}

/** A member as returned by a live Instagram enumeration. */
export interface RosterLiveMember {
  readonly username: string;
  readonly fullName?: string | null;
  /** Follower dimension only; kept so the roster can be served without a join. */
  readonly igUserId?: string | null;
  readonly profilePicUrl?: string | null;
}

/** Confirmed arrival: emit a follow/follower event for this. */
export interface RosterArrival {
  readonly username: string;
  readonly displayName: string | null;
  readonly igUserId: string | null;
  readonly pfpUrl: string | null;
}

export interface RosterReconcileResult {
  /** The completed epoch covered enough distinct held members to judge absence. */
  readonly completeRead: boolean;
  /** Confirmed new members. Empty while the baseline is still settling. */
  readonly arrivals: ReadonlyArray<RosterArrival>;
  /** Confirmed departures (lowercased). Empty unless settled AND the read was complete. */
  readonly departures: ReadonlyArray<string>;
  /** Members currently in the roster after this reconcile. */
  readonly currentCount: number;
  /** False while the baseline is still being unioned; callers must stay silent. */
  readonly settled: boolean;
  /** True when this read completed the settle threshold. */
  readonly justSettled: boolean;
}

// ── Read epochs ─────────────────────────────────────────────────────────────
//
// IG refuses deep pagination (HTTP 400 past a few pages), so one roster is read
// across several cycles through a saved cursor (migration 0039). Judged one
// capture at a time, NO capture of such a roster ever covers 90% of what we
// hold, so absence was never evaluated and lost-follower detection was dead for
// 6 of 7 walked accounts (last complete follower read: @example_account 07-25,
// @tracked_user_2 08-15, @sample_account 08-27). An EPOCH is the resumed
// sequence cursor null → … → exhausted, treated as ONE logical read: sightings
// accumulate across its legs (roster_members.last_seen_at >= epoch_started_at)
// and absence, missing_streak, departures and last_complete_read_at are judged
// once, when the epoch ends. The 0.9 coverage rule is unchanged — it is applied
// to the epoch's union. A leg that restarts from a null cursor resets the
// epoch; a partial epoch never emits departures.

/** Which part of a logical read this capture is. */
export interface RosterReadLeg {
  /** The walk began at the top of the list (no resume cursor). */
  readonly startsEpoch: boolean;
  /** The walk exhausted the list (IG returned no next cursor). */
  readonly endsEpoch: boolean;
  /**
   * Head-walk: the first pages of a large roster whose full walk was deferred.
   * Arrivals only — never absence evidence, never touches the epoch state.
   */
  readonly headOnly?: boolean;
}

/** Legacy shape: one capture is one complete logical read. */
export const SINGLE_READ_LEG: RosterReadLeg = { startsEpoch: true, endsEpoch: true };
export const HEAD_WALK_LEG: RosterReadLeg = {
  startsEpoch: false,
  endsEpoch: false,
  headOnly: true,
};

/** Epoch bookkeeping persisted on roster_sync_state (migration 0046). */
export interface RosterEpochState {
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  /** last_member_count when the epoch began; growth is measured across it. */
  readonly startMemberCount: number | null;
  readonly legs: number;
}

export const EMPTY_EPOCH_STATE: RosterEpochState = {
  startedAt: null,
  completedAt: null,
  startMemberCount: null,
  legs: 0,
};

export type RosterEpochWrite = "none" | "begin" | "continue" | "complete";

export interface RosterEpochPlan {
  /** Absence may be judged against this epoch's union of sightings. */
  readonly evaluate: boolean;
  /**
   * Sightings at/after this instant belong to the epoch. `null` = only the
   * capture being reconciled counts (first leg, or legacy single read).
   */
  readonly seenSince: Date | null;
  /** Member count the epoch's growth is measured against (null = unknown). */
  readonly startMemberCount: number | null;
  /** Legs in the epoch including this one. */
  readonly legs: number;
  readonly write: RosterEpochWrite;
  /**
   * A continuation whose epoch start is unknown (code deployed mid-walk, or a
   * cursor that outlived its epoch). Sightings are still recorded; the epoch is
   * not judged and the next walk from the top starts a clean one.
   */
  readonly orphan: boolean;
}

/**
 * Pure: how this leg relates to the roster's epoch and what to persist.
 *
 * @param prevLastMemberCount last_member_count before this leg; a leg that
 *   begins an epoch anchors the epoch's growth measurement on it, exactly as a
 *   single read anchors on the previous read.
 */
export function planEpochLeg(
  leg: RosterReadLeg,
  prev: RosterEpochState,
  prevLastMemberCount: number | null,
): RosterEpochPlan {
  if (leg.headOnly) {
    return {
      evaluate: false,
      seenSince: null,
      startMemberCount: null,
      legs: prev.legs,
      write: "none",
      orphan: false,
    };
  }
  if (leg.startsEpoch) {
    return {
      evaluate: leg.endsEpoch,
      seenSince: null,
      startMemberCount: prevLastMemberCount,
      legs: 1,
      write: leg.endsEpoch ? "complete" : "begin",
      orphan: false,
    };
  }
  const epochOpen = prev.startedAt !== null && prev.completedAt === null;
  if (!epochOpen) {
    return {
      evaluate: false,
      seenSince: null,
      startMemberCount: null,
      legs: prev.legs,
      write: "none",
      orphan: true,
    };
  }
  return {
    evaluate: leg.endsEpoch,
    seenSince: prev.startedAt,
    startMemberCount: prev.startMemberCount,
    legs: prev.legs + 1,
    write: leg.endsEpoch ? "complete" : "continue",
    orphan: false,
  };
}

export interface EpochAbsence {
  /** Distinct members seen in the epoch so far, this capture included. */
  readonly seenCount: number;
  /** Current members seen by NO leg of the epoch (lowercased). */
  readonly absent: ReadonlyArray<string>;
}

/**
 * Pure: split the held roster into "seen somewhere in this epoch" and "absent
 * from the whole epoch". With `seenSince === null` only the live capture counts,
 * which is exactly the single-read rule this generalises.
 */
export function partitionEpochAbsence(
  existing: ReadonlyMap<string, { readonly isCurrent: boolean; readonly lastSeenAt: Date | null }>,
  live: ReadonlyMap<string, unknown>,
  seenSince: Date | null,
): EpochAbsence {
  let seenEarlier = 0;
  const absent: string[] = [];
  for (const [key, member] of existing) {
    if (!member.isCurrent || live.has(key)) continue;
    const seenInEpoch =
      seenSince !== null &&
      member.lastSeenAt !== null &&
      member.lastSeenAt.getTime() >= seenSince.getTime();
    if (seenInEpoch) seenEarlier += 1;
    else absent.push(key);
  }
  return { seenCount: live.size + seenEarlier, absent };
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Fraction of the HELD roster a read must cover before it may be used as
 * evidence of absence. Compared against our own high-water mark rather than IG's
 * reported number, which is unreachable. This still blocks the failure the gate
 * was built for — wire.fluid captured 12 of a held 495 and invented 305
 * unfollows — because 12 is nowhere near 90% of 495.
 */
function readFloatEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

export const ROSTER_READ_COVERAGE = 0.9;

// A roster settles once consecutive complete reads stop ADDING members. For a
// large account that requirement is unreachable: IG refuses deep pagination
// (GET followers -> HTTP 400 past ~6k), so every read returns a slightly
// different slice and the union creeps up forever. stable_reads resets to 0 on
// any growth, settled_at stays NULL, and because arrivals are suppressed until
// settled the account reports NO new followers, NO unfollows and NO recent
// follows — permanently. @sample_account sat at 6,092/9,908 in exactly this
// state with follower_events empty.
//
// Two escapes, both conservative:
//  * GROWTH TOLERANCE — a read that grows the union by <= this fraction is
//    treated as stable. Real churn on a 6k roster is a handful of accounts; a
//    genuinely incomplete baseline grows by far more than 1%.
//  * SEEDING DEADLINE — after this long still unsettled, accept the union we
//    have as the baseline. Being permanently silent is strictly worse than a
//    baseline that is a few members short.
export const ROSTER_SETTLE_GROWTH_TOLERANCE = readFloatEnv(
  "ROSTER_SETTLE_GROWTH_TOLERANCE",
  0.01,
  0,
  0.5,
);
export const ROSTER_SETTLE_MAX_SEEDING_HOURS = readIntEnv(
  "ROSTER_SETTLE_MAX_SEEDING_HOURS",
  48,
  1,
  24 * 30,
);


/**
 * Consecutive COMPLETE reads a member must be absent from before we accept the
 * departure. 2 is the minimum that distinguishes "pagination dropped them" from
 * "they are gone", since a single omission is routine.
 */
export const ROSTER_ABSENCE_CONFIRMATIONS = readIntEnv(
  "ROSTER_ABSENCE_CONFIRMATIONS",
  2,
  1,
  10,
);

/**
 * Consecutive complete reads that must add NOTHING new before the baseline is
 * trusted. 2 means the union has to be confirmed stable twice, which covers the
 * pagination variance we measured (~10-16% of a roster rotating per read).
 */
export const ROSTER_SETTLE_READS = readIntEnv("ROSTER_SETTLE_READS", 2, 1, 20);

// Bulk upserts are chunked to stay well under Postgres' 65535 bind-parameter
// cap: ~7 params/row, so 500 rows ≈ 3.5k params.
const UPSERT_CHUNK = 500;

interface ExistingMember {
  readonly usernameLower: string;
  readonly isCurrent: boolean;
  readonly missingStreak: number;
  /** Last sighting (stamped by upsertSeenMembers); the epoch's seen-set key. */
  readonly lastSeenAt: Date | null;
}

interface SyncState {
  readonly seededAt: Date | null;
  readonly settledAt: Date | null;
  readonly completeReads: number;
  readonly stableReads: number;
  readonly lastMemberCount: number | null;
  readonly epoch: RosterEpochState;
}

/** pg hands timestamptz back as Date; tolerate a string in case a parser is swapped. */
function toDateOrNull(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

async function loadSyncState(
  tx: Tx,
  trackedAccountId: string,
  dimension: RosterDimension,
): Promise<SyncState> {
  // The epoch columns (migration 0046) are addressed by name until the drizzle
  // schema carries them; the row is read in the reconcile transaction.
  const [row] = await tx
    .select({
      seededAt: rosterSyncState.seededAt,
      settledAt: rosterSyncState.settledAt,
      completeReads: rosterSyncState.completeReads,
      stableReads: rosterSyncState.stableReads,
      lastMemberCount: rosterSyncState.lastMemberCount,
      epochStartedAt: sql<unknown>`${rosterSyncState}.epoch_started_at`,
      epochCompletedAt: sql<unknown>`${rosterSyncState}.epoch_completed_at`,
      epochStartMemberCount: sql<number | null>`${rosterSyncState}.epoch_start_member_count`,
      epochLegs: sql<number | null>`${rosterSyncState}.epoch_legs`,
    })
    .from(rosterSyncState)
    .where(
      and(
        eq(rosterSyncState.trackedAccountId, trackedAccountId),
        eq(rosterSyncState.dimension, dimension),
      ),
    );
  if (!row) {
    return {
      seededAt: null,
      settledAt: null,
      completeReads: 0,
      stableReads: 0,
      lastMemberCount: null,
      epoch: EMPTY_EPOCH_STATE,
    };
  }
  return {
    seededAt: row.seededAt,
    settledAt: row.settledAt,
    completeReads: row.completeReads,
    stableReads: row.stableReads,
    lastMemberCount: row.lastMemberCount,
    epoch: {
      startedAt: toDateOrNull(row.epochStartedAt),
      completedAt: toDateOrNull(row.epochCompletedAt),
      startMemberCount:
        typeof row.epochStartMemberCount === "number" ? row.epochStartMemberCount : null,
      legs: typeof row.epochLegs === "number" ? row.epochLegs : 0,
    },
  };
}

export function classifyRosterFailure(error: string): RosterFailureKind {
  const message = error.toLowerCase();
  if (
    message.includes("special_empty_state") ||
    message.includes("list restricted by instagram")
  ) {
    return "list_restricted";
  }
  if (/rate.?limit|429|throttl/.test(message)) return "rate_limited";
  if (/login_required|auth.?expired|checkpoint|challenge|\b401\b|\b403\b/.test(message)) {
    return "auth";
  }
  return "unavailable";
}

function retryMsFor(kind: RosterFailureKind): number {
  const envName = kind === "list_restricted"
    ? "ROSTER_RESTRICTED_RETRY_SEC"
    : "ROSTER_FAILURE_RETRY_SEC";
  const fallbackSec = kind === "list_restricted" ? 12 * 60 * 60 : 60 * 60;
  const raw = Number(process.env[envName]);
  const seconds = Number.isFinite(raw)
    ? Math.min(Math.max(Math.floor(raw), 15 * 60), 48 * 60 * 60)
    : fallbackSec;
  return seconds * 1_000;
}

/** Read the materialized-baseline and latest target-specific fetch state. */
export async function getRosterSyncHealth(
  trackedAccountId: string,
  dimension: RosterDimension,
): Promise<RosterSyncHealth> {
  const [row] = await db
    .select({
      settledAt: rosterSyncState.settledAt,
      lastAttemptAt: rosterSyncState.lastAttemptAt,
      lastSuccessAt: rosterSyncState.lastSuccessAt,
      lastCompleteReadAt: rosterSyncState.lastCompleteReadAt,
      failureKind: rosterSyncState.failureKind,
      lastError: rosterSyncState.lastError,
      nextRetryAt: rosterSyncState.nextRetryAt,
    })
    .from(rosterSyncState)
    .where(
      and(
        eq(rosterSyncState.trackedAccountId, trackedAccountId),
        eq(rosterSyncState.dimension, dimension),
      ),
    );
  const failureKind = row?.failureKind;
  return {
    settled: row?.settledAt != null,
    settledAt: row?.settledAt ?? null,
    lastAttemptAt: row?.lastAttemptAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastCompleteReadAt: row?.lastCompleteReadAt ?? null,
    failureKind:
      failureKind === "list_restricted" ||
      failureKind === "rate_limited" ||
      failureKind === "auth" ||
      failureKind === "unavailable" ||
      failureKind === "too_large"
        ? failureKind
        : null,
    lastError: row?.lastError ?? null,
    nextRetryAt: row?.nextRetryAt ?? null,
  };
}

/** Persist a failed graph attempt so the scheduler does not storm the target. */
/**
 * How long a saved pagination cursor stays usable. IG cursors go stale; a very
 * old one yields an immediate error and would strand the walk at that offset
 * forever, so past this age we drop it and start a fresh pass from the top.
 */
export const ROSTER_CURSOR_TTL_HOURS = readIntEnv(
  "ROSTER_CURSOR_TTL_HOURS",
  12,
  1,
  24 * 7,
);

/** Resume point for a roster walk, or null when a fresh pass should start. */
export async function loadRosterCursor(
  trackedAccountId: string,
  dimension: RosterDimension,
  options?: { readonly maxAgeHours?: number; readonly viewerBotId?: string },
): Promise<string | null> {
  const [row] = await db
    .select({
      nextCursor: rosterSyncState.nextCursor,
      cursorUpdatedAt: rosterSyncState.cursorUpdatedAt,
      viewerBotId: rosterSyncState.viewerBotId,
    })
    .from(rosterSyncState)
    .where(
      and(
        eq(rosterSyncState.trackedAccountId, trackedAccountId),
        eq(rosterSyncState.dimension, dimension),
      ),
    )
    .limit(1);
  if (!row?.nextCursor || !row.cursorUpdatedAt) return null;
  // Pagination tokens belong to the viewer that obtained them. A replacement
  // approved reader starts a new pass; saved roster members remain available
  // for deduplication and no absence is inferred from that partial pass.
  if (options?.viewerBotId && row.viewerBotId !== options.viewerBotId) return null;
  const ageMs = Date.now() - row.cursorUpdatedAt.getTime();
  const requestedAge = options?.maxAgeHours ?? ROSTER_CURSOR_TTL_HOURS;
  const maxAgeHours = Number.isFinite(requestedAge) ? Math.max(1, Math.min(24 * 7, requestedAge)) : ROSTER_CURSOR_TTL_HOURS;
  if (ageMs >= maxAgeHours * 3_600_000) return null;
  return row.nextCursor;
}

/**
 * Persist where a walk stopped. `null` clears it, which is what an exhausted
 * walk reports so the next cycle re-reads the list from the beginning.
 */
export async function saveRosterCursor(
  trackedAccountId: string,
  dimension: RosterDimension,
  nextCursor: string | null,
  viewerBotId?: string | null,
  tx?: Tx,
): Promise<void> {
  const now = new Date();
  const viewer = nextCursor ? viewerBotId ?? null : null;
  await (tx ?? db)
    .insert(rosterSyncState)
    .values({ trackedAccountId, dimension, nextCursor, cursorUpdatedAt: now, viewerBotId: viewer })
    .onConflictDoUpdate({
      target: [rosterSyncState.trackedAccountId, rosterSyncState.dimension],
      set: { nextCursor, cursorUpdatedAt: now, viewerBotId: viewer },
    });
}

export async function loadRosterViewer(trackedAccountId: string, dimension: RosterDimension): Promise<string | null> {
  const [row] = await db.select({ viewerBotId: rosterSyncState.viewerBotId }).from(rosterSyncState)
    .where(and(eq(rosterSyncState.trackedAccountId, trackedAccountId), eq(rosterSyncState.dimension, dimension))).limit(1);
  return row?.viewerBotId ?? null;
}

/**
 * Record that a roster is beyond the enumeration ceiling. Distinct from a
 * failure: nothing is wrong and retrying cannot help, so no backoff clock is
 * set. Written once so the state stops looking like an in-progress seed.
 */
export async function markRosterTooLarge(
  trackedAccountId: string,
  dimension: RosterDimension,
  reportedCount: number,
): Promise<void> {
  const now = new Date();
  const lastError = `roster of ${reportedCount} exceeds the enumeration cap; not attempted`;
  await db
    .insert(rosterSyncState)
    .values({
      trackedAccountId,
      dimension,
      lastAttemptAt: now,
      failureKind: "too_large",
      lastError,
    })
    .onConflictDoUpdate({
      target: [rosterSyncState.trackedAccountId, rosterSyncState.dimension],
      set: { lastAttemptAt: now, failureKind: "too_large", lastError },
    });
}

export async function recordRosterFetchFailure(
  trackedAccountId: string,
  dimension: RosterDimension,
  error: string,
): Promise<RosterSyncHealth> {
  const kind = classifyRosterFailure(error);
  const now = new Date();
  const nextRetryAt = new Date(now.getTime() + retryMsFor(kind));
  const lastError = error.slice(0, 2_000);

  // A roster whose reads keep FAILING can never settle through the success
  // path (advanceSyncState runs only inside reconcileRoster). For a large
  // account that is a permanent dead end: @sample_account's followers walk
  // dies on IG's HTTP 400 for deep pagination, so it stayed unsettled for days
  // with 6,092 members held and every follower panel blank. Once seeding has
  // run past the deadline and we hold a real roster, accept that union as the
  // baseline here too — otherwise repeated failure is indistinguishable from
  // "never had data" and the account reports nothing forever.
  const prior = await db
    .select({
      seededAt: rosterSyncState.seededAt,
      settledAt: rosterSyncState.settledAt,
      lastMemberCount: rosterSyncState.lastMemberCount,
    })
    .from(rosterSyncState)
    .where(
      and(
        eq(rosterSyncState.trackedAccountId, trackedAccountId),
        eq(rosterSyncState.dimension, dimension),
      ),
    )
    .limit(1);
  const priorRow = prior[0];
  const seedingExpired =
    priorRow?.settledAt == null &&
    priorRow?.seededAt != null &&
    (priorRow.lastMemberCount ?? 0) > 0 &&
    now.getTime() - priorRow.seededAt.getTime() >=
      ROSTER_SETTLE_MAX_SEEDING_HOURS * 3_600_000;

  await db
    .insert(rosterSyncState)
    .values({
      trackedAccountId,
      dimension,
      lastAttemptAt: now,
      failureKind: kind,
      lastError,
      nextRetryAt,
    })
    .onConflictDoUpdate({
      target: [rosterSyncState.trackedAccountId, rosterSyncState.dimension],
      set: {
        lastAttemptAt: now,
        failureKind: kind,
        lastError,
        nextRetryAt,
        ...(seedingExpired
          ? {
              settledAt: now,
              stableReads: ROSTER_SETTLE_READS,
            }
          : {}),
      },
    });
  if (seedingExpired) {
    logger.info(
      {
        trackedAccountId,
        dimension,
        heldMembers: priorRow?.lastMemberCount ?? 0,
        seededAt: priorRow?.seededAt,
      },
      "[roster] seeding deadline reached while failing; accepting held union as baseline",
    );
  }
  logger.warn(
    { trackedAccountId, dimension, kind, nextRetryAt, error: lastError },
    "roster fetch failed; target-specific backoff recorded",
  );
  return {
    settled: false,
    settledAt: null,
    lastAttemptAt: now,
    lastSuccessAt: null,
    failureKind: kind,
    lastError,
    nextRetryAt,
  };
}

/**
 * A full external roster is paid data. Keep it fresh without purchasing the
 * same unchanged list on every ordinary profile refresh. `failureKind` remains
 * null, so the UI continues to show the successfully imported roster as healthy;
 * `nextRetryAt` is used only by the enumeration scheduler.
 */
export async function recordExternalRosterSuccessCooldown(
  trackedAccountId: string,
  dimension: RosterDimension,
): Promise<Date> {
  const raw = Number(process.env.APIFY_GRAPH_REFRESH_SEC);
  const seconds = Number.isFinite(raw)
    ? Math.min(Math.max(Math.floor(raw), 60 * 60), 7 * 24 * 60 * 60)
    : 24 * 60 * 60;
  const nextRetryAt = new Date(Date.now() + seconds * 1_000);
  await db
    .update(rosterSyncState)
    .set({ nextRetryAt })
    .where(
      and(
        eq(rosterSyncState.trackedAccountId, trackedAccountId),
        eq(rosterSyncState.dimension, dimension),
      ),
    );
  return nextRetryAt;
}

export interface ReusedSiblingRoster {
  readonly follower: number;
  readonly following: number;
}

/**
 * Reuse a settled public roster when another customer tracks the same IG
 * account. The graph is stored per tracking row for tenant isolation, but its
 * public membership is identical; making every new row scrape from zero caused
 * the second @tracked_user_1 record to show "Loaded 0 of 1,868" indefinitely.
 *
 * Only a settled sibling may seed an unsettled target. The copy is silent and
 * creates no activity events, so baseline discovery cannot become a fake
 * recent follow or unfollow.
 */
export async function reuseSettledRosterFromSibling(
  trackedAccountId: string,
): Promise<ReusedSiblingRoster> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        igUserId: trackedAccounts.igUserId,
        igUsername: trackedAccounts.igUsername,
      })
      .from(trackedAccounts)
      .where(eq(trackedAccounts.id, trackedAccountId))
      .limit(1);
    if (!target) return { follower: 0, following: 0 };

    const reused: Record<RosterDimension, number> = {
      follower: 0,
      following: 0,
    };
    const now = new Date();

    for (const dimension of ["follower", "following"] as const) {
      const [targetState] = await tx
        .select({ settledAt: rosterSyncState.settledAt })
        .from(rosterSyncState)
        .where(
          and(
            eq(rosterSyncState.trackedAccountId, trackedAccountId),
            eq(rosterSyncState.dimension, dimension),
          ),
        )
        .limit(1);
      if (targetState?.settledAt) continue;

      const identityMatch = target.igUserId
        ? sql`ta.ig_user_id = ${target.igUserId}`
        : sql`lower(ta.ig_username) = lower(${target.igUsername})`;
      const sourceResult = await tx.execute(sql`
        SELECT ta.id
        FROM tracked_accounts ta
        JOIN roster_sync_state rss
          ON rss.tracked_account_id = ta.id
         AND rss.dimension = ${dimension}
        WHERE ta.id <> ${trackedAccountId}
          AND rss.settled_at IS NOT NULL
          AND ${identityMatch}
          AND EXISTS (
            SELECT 1
            FROM roster_members rm
            WHERE rm.tracked_account_id = ta.id
              AND rm.dimension = ${dimension}
              AND rm.is_current = true
          )
        ORDER BY rss.last_success_at DESC NULLS LAST, rss.settled_at DESC
        LIMIT 1
      `);
      const sourceRows = Array.isArray(sourceResult)
        ? sourceResult
        : (sourceResult as unknown as { rows?: Array<{ id: string }> }).rows ?? [];
      const sourceId = (sourceRows[0] as { id?: string } | undefined)?.id;
      if (!sourceId) continue;

      await tx.execute(sql`
        INSERT INTO roster_members (
          tracked_account_id,
          dimension,
          username_lower,
          username,
          display_name,
          ig_user_id,
          pfp_url,
          first_seen_at,
          last_seen_at,
          missing_streak,
          is_current,
          left_at
        )
        SELECT
          ${trackedAccountId},
          rm.dimension,
          rm.username_lower,
          rm.username,
          rm.display_name,
          rm.ig_user_id,
          rm.pfp_url,
          rm.first_seen_at,
          ${now},
          0,
          true,
          NULL
        FROM roster_members rm
        WHERE rm.tracked_account_id = ${sourceId}
          AND rm.dimension = ${dimension}
          AND rm.is_current = true
        ON CONFLICT (tracked_account_id, dimension, username_lower)
        DO UPDATE SET
          username = EXCLUDED.username,
          display_name = COALESCE(EXCLUDED.display_name, roster_members.display_name),
          ig_user_id = COALESCE(EXCLUDED.ig_user_id, roster_members.ig_user_id),
          pfp_url = COALESCE(EXCLUDED.pfp_url, roster_members.pfp_url),
          last_seen_at = EXCLUDED.last_seen_at,
          missing_streak = 0,
          is_current = true,
          left_at = NULL
      `);

      const [countRow] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(rosterMembers)
        .where(
          and(
            eq(rosterMembers.trackedAccountId, trackedAccountId),
            eq(rosterMembers.dimension, dimension),
            eq(rosterMembers.isCurrent, true),
          ),
        );
      const currentCount = countRow?.value ?? 0;
      if (currentCount === 0) continue;

      await tx.execute(sql`
        INSERT INTO roster_sync_state (
          tracked_account_id,
          dimension,
          seeded_at,
          complete_reads,
          stable_reads,
          settled_at,
          last_complete_read_at,
          last_member_count,
          last_attempt_at,
          last_success_at,
          failure_kind,
          last_error,
          next_retry_at
        ) VALUES (
          ${trackedAccountId},
          ${dimension},
          ${now},
          ${ROSTER_SETTLE_READS},
          ${ROSTER_SETTLE_READS},
          ${now},
          ${now},
          ${currentCount},
          ${now},
          ${now},
          NULL,
          NULL,
          NULL
        )
        ON CONFLICT (tracked_account_id, dimension)
        DO UPDATE SET
          seeded_at = COALESCE(roster_sync_state.seeded_at, EXCLUDED.seeded_at),
          complete_reads = GREATEST(roster_sync_state.complete_reads, EXCLUDED.complete_reads),
          stable_reads = GREATEST(roster_sync_state.stable_reads, EXCLUDED.stable_reads),
          settled_at = COALESCE(roster_sync_state.settled_at, EXCLUDED.settled_at),
          last_complete_read_at = EXCLUDED.last_complete_read_at,
          last_member_count = EXCLUDED.last_member_count,
          last_attempt_at = EXCLUDED.last_attempt_at,
          last_success_at = EXCLUDED.last_success_at,
          failure_kind = NULL,
          last_error = NULL,
          next_retry_at = NULL
      `);
      reused[dimension] = currentCount;
    }

    if (reused.follower > 0 || reused.following > 0) {
      await tx
        .update(trackedAccounts)
        .set({
          lastFollowersRefreshAt: reused.follower > 0 ? now : undefined,
          lastFollowingRefreshAt: reused.following > 0 ? now : undefined,
          lastGraphRefreshAt:
            reused.follower > 0 && reused.following > 0 ? now : undefined,
          followingFirstCompleteAt:
            reused.following > 0 ? now : undefined,
          updatedAt: now,
        })
        .where(eq(trackedAccounts.id, trackedAccountId));
      logger.info(
        { trackedAccountId, ...reused },
        "reused settled public roster from sibling tracking record",
      );
    }

    return reused;
  });
}

export interface CopiedSiblingRoster {
  /** roster_members rows copied — current AND departed history. */
  readonly members: number;
  /** Of those, rows with `is_current IS TRUE`. */
  readonly currentMembers: number;
  /** False when the sibling had no sync state to inherit (target left intact). */
  readonly syncStateCopied: boolean;
}

/**
 * Replace `to`'s roster for one dimension with an exact copy of `from`'s, in
 * ONE transaction: every roster_members row (current AND departed, so the
 * `missing_streak` hysteresis and `left_at` history survive) and the
 * roster_sync_state row including the read epoch (0046) and the saved cursor,
 * so an interrupted multi-leg walk resumes on the new holder as the same
 * epoch. Used when a twin is promoted to canonical after holding a frozen
 * roster (audit 2026-09-02 C7): without the copy its first walk would report
 * every member who arrived since the freeze as a new follower and lag every
 * departure.
 *
 * Emits no events. Refuses to copy from a sibling with no sync state (a row
 * that never walked has nothing to inherit) and leaves the target untouched in
 * that case. Callers decide WHICH sibling qualifies
 * (tracked-account-twins `pickRosterInheritanceDonor`); this only copies.
 * Nothing references roster_members / roster_sync_state by FK, so deleting
 * the target's rows cascades nowhere.
 */
export async function copyRosterFromSibling(
  fromTrackedAccountId: string,
  toTrackedAccountId: string,
  dimension: RosterDimension,
  options: { transactionGuard?: (tx: Tx) => Promise<void>; copyBackgroundProgress?: boolean } = {},
): Promise<CopiedSiblingRoster> {
  if (fromTrackedAccountId === toTrackedAccountId) {
    throw new Error("copyRosterFromSibling: source and target are the same row");
  }
  const nothing: CopiedSiblingRoster = {
    members: 0,
    currentMembers: 0,
    syncStateCopied: false,
  };

  return db.transaction(async (tx) => {
    await options.transactionGuard?.(tx);
    // Serialize both sides in a stable order against head/diff writes. This is
    // a local database copy, never a lock held over Instagram I/O.
    const namespace=dimension === "follower" ? FOLLOWER_DIFF_LOCK_NS : FOLLOWING_DIFF_LOCK_NS;
    for (const id of [fromTrackedAccountId,toTrackedAccountId].sort()) await lockAccountForDiff(tx,namespace,id);
    const [source] = await tx
      .select({ lastSuccessAt: rosterSyncState.lastSuccessAt })
      .from(rosterSyncState)
      .where(
        and(
          eq(rosterSyncState.trackedAccountId, fromTrackedAccountId),
          eq(rosterSyncState.dimension, dimension),
        ),
      )
      .limit(1);
    if (!source) return nothing;

    await tx.execute(sql`
      DELETE FROM roster_members
      WHERE tracked_account_id = ${toTrackedAccountId}
        AND dimension = ${dimension}
    `);
    // Explicit column list: `id` is regenerated, `tracked_account_id` is
    // re-keyed, everything else is copied verbatim (schema 1434ff.).
    await tx.execute(sql`
      INSERT INTO roster_members (
        tracked_account_id, dimension, username_lower, username, display_name,
        ig_user_id, pfp_url, first_seen_at, last_seen_at, missing_streak,
        is_current, left_at, last_post_at, posts_checked_at, owner_is_private,
        owner_profile_checked_at
      )
      SELECT
        ${toTrackedAccountId}, rm.dimension, rm.username_lower, rm.username,
        rm.display_name, rm.ig_user_id, rm.pfp_url, rm.first_seen_at,
        rm.last_seen_at, rm.missing_streak, rm.is_current, rm.left_at,
        rm.last_post_at, rm.posts_checked_at, rm.owner_is_private,
        rm.owner_profile_checked_at
      FROM roster_members rm
      WHERE rm.tracked_account_id = ${fromTrackedAccountId}
        AND rm.dimension = ${dimension}
    `);

    await tx.execute(sql`
      DELETE FROM roster_sync_state
      WHERE tracked_account_id = ${toTrackedAccountId}
        AND dimension = ${dimension}
    `);
    await tx.execute(sql`
      INSERT INTO roster_sync_state (
        tracked_account_id, dimension, seeded_at, complete_reads, settled_at,
        last_complete_read_at, last_member_count, stable_reads, last_attempt_at,
        last_success_at, failure_kind, last_error, next_retry_at, next_cursor, viewer_bot_id,
        cursor_updated_at, epoch_started_at, epoch_completed_at,
        epoch_start_member_count, epoch_legs
      )
      SELECT
        ${toTrackedAccountId}, rss.dimension, rss.seeded_at, rss.complete_reads,
        rss.settled_at, rss.last_complete_read_at, rss.last_member_count,
        rss.stable_reads, rss.last_attempt_at, rss.last_success_at,
        rss.failure_kind, rss.last_error, rss.next_retry_at, rss.next_cursor, rss.viewer_bot_id,
        rss.cursor_updated_at, rss.epoch_started_at, rss.epoch_completed_at,
        rss.epoch_start_member_count, rss.epoch_legs
      FROM roster_sync_state rss
      WHERE rss.tracked_account_id = ${fromTrackedAccountId}
        AND rss.dimension = ${dimension}
    `);

    if (options.copyBackgroundProgress) {
      await tx.execute(sql`UPDATE roster_background_sync target SET
        source=source.source,status=source.status,baseline_complete_at=source.baseline_complete_at,
        next_run_at=source.next_run_at,epoch_expected_count=source.epoch_expected_count,
        epoch_seen_count=source.epoch_seen_count,pages_completed=source.pages_completed,
        last_batch_count=source.last_batch_count,last_started_at=source.last_started_at,
        last_progress_at=source.last_progress_at,last_error=source.last_error,
        next_head_run_at=source.next_head_run_at,last_head_read_at=source.last_head_read_at,
        last_head_count=source.last_head_count,head_status=source.head_status
        FROM roster_background_sync source
        WHERE target.tracked_account_id=${toTrackedAccountId} AND target.dimension=${dimension}
          AND source.tracked_account_id=${fromTrackedAccountId} AND source.dimension=target.dimension`);
    }

    const [counts] = await tx
      .select({
        members: sql<number>`count(*)::int`,
        currentMembers: sql<number>`count(*) FILTER (WHERE ${rosterMembers.isCurrent} IS TRUE)::int`,
      })
      .from(rosterMembers)
      .where(
        and(
          eq(rosterMembers.trackedAccountId, toTrackedAccountId),
          eq(rosterMembers.dimension, dimension),
        ),
      );

    const copied: CopiedSiblingRoster = {
      members: counts?.members ?? 0,
      currentMembers: counts?.currentMembers ?? 0,
      syncStateCopied: true,
    };
    logger.info(
      {
        fromTrackedAccountId,
        toTrackedAccountId,
        dimension,
        sourceLastSuccessAt: source.lastSuccessAt,
        ...copied,
      },
      "copied roster from sibling tracking record",
    );
    return copied;
  });
}

async function loadExistingMembers(
  tx: Tx,
  trackedAccountId: string,
  dimension: RosterDimension,
  onlyUsernames?: readonly string[],
): Promise<Map<string, ExistingMember>> {
  if (onlyUsernames?.length === 0) return new Map();
  const rows = await tx
    .select({
      usernameLower: rosterMembers.usernameLower,
      isCurrent: rosterMembers.isCurrent,
      missingStreak: rosterMembers.missingStreak,
      lastSeenAt: rosterMembers.lastSeenAt,
    })
    .from(rosterMembers)
    .where(
      and(
        eq(rosterMembers.trackedAccountId, trackedAccountId),
        eq(rosterMembers.dimension, dimension),
        onlyUsernames ? inArray(rosterMembers.usernameLower, [...onlyUsernames]) : undefined,
      ),
    );
  return new Map(rows.map((r) => [r.usernameLower, r]));
}

/** Collapse duplicates from a live capture, keeping the richest display name. */
function dedupeLive(
  live: ReadonlyArray<RosterLiveMember>,
): Map<string, RosterArrival> {
  const out = new Map<string, RosterArrival>();
  for (const m of live) {
    const username = m.username?.trim();
    if (!username) continue;
    const key = username.toLowerCase();
    const prev = out.get(key);
    // Later sightings win, but a blank field must never erase a known value.
    out.set(key, {
      username,
      displayName: m.fullName?.trim() || prev?.displayName || null,
      igUserId: m.igUserId?.trim() || prev?.igUserId || null,
      pfpUrl: m.profilePicUrl?.trim() || prev?.pfpUrl || null,
    });
  }
  return out;
}

/**
 * Fold one live capture into the stored roster.
 *
 * Must be called inside a transaction that already holds the per-account
 * advisory lock, so concurrent cycles cannot interleave half-applied reconciles.
 *
 * @param callerSaysComplete The caller's own completeness verdict (measured
 *   against IG's reported count). Treated as a VETO only: a read this rejects is
 *   never used as evidence of absence. It cannot force a read to count as
 *   complete, because IG's number is unreachable and would keep every roster
 *   permanently unsettled.
 */
export async function reconcileRoster(
  tx: Tx,
  trackedAccountId: string,
  dimension: RosterDimension,
  live: ReadonlyArray<RosterLiveMember>,
  callerSaysComplete: boolean,
  options: {
    readonly trustedBaseline?: boolean;
    /** Managed backfill must cover the reported roster, not just a tiny held prefix. */
    readonly minimumCompleteReadMembers?: number;
    /** Silent baseline discovery; no fabricated arrivals or departures. */
    readonly baselineOnly?: boolean;
    /**
     * Optional check: does the roster we now HOLD cover the count Instagram
     * reports? Judged on the union rather than one capture, so an account
     * enumerated across several partial reads can still finish seeding.
     */
    readonly heldCoversExpected?: (heldCount: number) => Promise<boolean>;
    /**
     * Where this capture sits in a multi-cycle walk (see "Read epochs"). Omitted
     * = a single complete logical read, today's behaviour for every caller that
     * does not walk with a resume cursor.
     */
    readonly leg?: RosterReadLeg;
  } = {},
): Promise<RosterReconcileResult> {
  const state = await loadSyncState(tx, trackedAccountId, dimension);
  const liveMap = dedupeLive(live);
  const leg = options.leg ?? SINGLE_READ_LEG;
  const epoch = planEpochLeg(leg, state.epoch, state.lastMemberCount);
  // A partial/head batch cannot judge absences. Fetch only its matching keys,
  // not hundreds of thousands of held rows on every checkpoint. The whole
  // epoch is evaluated once, at its end; counts remain DB aggregates.
  const partial = !epoch.evaluate && options.trustedBaseline !== true;
  const existing = await loadExistingMembers(tx, trackedAccountId, dimension, partial ? [...liveMap.keys()] : undefined);
  const heldCurrent = partial ? await countCurrent(tx, trackedAccountId, dimension) : countCurrentIn(existing);
  // Sightings from earlier legs of the same epoch count as coverage; members
  // no leg has seen are the epoch's absentees. For a single read this is just
  // "held minus captured".
  const epochAbsence = partial
    ? { seenCount: liveMap.size, absent: [] as string[] }
    : partitionEpochAbsence(existing, liveMap, epoch.seenSince);
  // Coverage is judged against what we HOLD, never against IG's reported number:
  // that number is unreachable (@complex reports 1,090 following, enumerates to
  // 743), so letting it veto would keep the roster permanently unsettled and
  // reporting nothing. The first read has nothing to cover, so it seeds.
  //
  // `callerSaysComplete` is kept for telemetry only, for the same reason.
  // A leg that does not END its epoch is never a complete read, however much it
  // captured: absence cannot be judged before the whole list has been walked.
  const isCompleteRead =
    options.trustedBaseline === true ||
    (epoch.evaluate &&
      epochAbsence.seenCount >= (options.minimumCompleteReadMembers ?? 0) &&
      (heldCurrent === 0 || epochAbsence.seenCount >= heldCurrent * ROSTER_READ_COVERAGE));

  // Settled state is evaluated BEFORE this read is counted: the read that
  // reaches the threshold is still part of the union, so it stays silent.
  const settled = state.settledAt !== null || state.stableReads >= ROSTER_SETTLE_READS;

  const arrivals: RosterArrival[] = [];
  for (const [key, member] of liveMap) {
    const prev = existing.get(key);
    // Arrival = never seen, or previously confirmed gone and now back.
    if (!prev || !prev.isCurrent) arrivals.push(member);
  }

  // Absence is only meaningful in a complete read (of the whole epoch).
  const departures: string[] = [];
  const absent: ReadonlyArray<string> = isCompleteRead && !options.baselineOnly ? epochAbsence.absent : [];

  await upsertSeenMembers(tx, trackedAccountId, dimension, liveMap);

  if (options.baselineOnly && isCompleteRead) {
    // A newly verified baseline must not inherit absence strikes from the
    // old, incomplete prefix. Future departures still need the full normal
    // sequence of complete reads; no rows/events are deleted here.
    await tx.update(rosterMembers).set({ missingStreak: 0 }).where(and(
      eq(rosterMembers.trackedAccountId, trackedAccountId),
      eq(rosterMembers.dimension, dimension),
      eq(rosterMembers.isCurrent, true),
      sql`${rosterMembers.missingStreak} > 0`,
    ));
  }

  for (const keys of chunk(absent, UPSERT_CHUNK)) {
    // One more consecutive miss for each. Presence resets this to 0 in the
    // upsert above, so a streak only survives genuinely repeated absence.
    await tx
      .update(rosterMembers)
      .set({ missingStreak: sql`${rosterMembers.missingStreak} + 1` })
      .where(
        and(
          eq(rosterMembers.trackedAccountId, trackedAccountId),
          eq(rosterMembers.dimension, dimension),
          inArray(rosterMembers.usernameLower, keys),
        ),
      );

    if (!settled) continue;
    // Confirmed gone: missing from enough consecutive complete reads.
    const confirmed = await tx
      .update(rosterMembers)
      .set({ isCurrent: false, leftAt: new Date() })
      .where(
        and(
          eq(rosterMembers.trackedAccountId, trackedAccountId),
          eq(rosterMembers.dimension, dimension),
          eq(rosterMembers.isCurrent, true),
          inArray(rosterMembers.usernameLower, keys),
          sql`${rosterMembers.missingStreak} >= ${ROSTER_ABSENCE_CONFIRMATIONS}`,
        ),
      )
      .returning({ usernameLower: rosterMembers.usernameLower });
    departures.push(...confirmed.map((r) => r.usernameLower));
  }

  const currentCount = await countCurrent(tx, trackedAccountId, dimension);
  // Union-level completeness beats per-read completeness for settling.
  const unionCoversExpected = options.heldCoversExpected
    ? await options.heldCoversExpected(currentCount).catch(() => false)
    : false;
  // Growth is measured across the whole epoch: a read that spans several
  // cycles must compare against the count when it BEGAN, or each leg's small
  // increment would look like stability and a still-seeding roster could settle
  // on an incomplete baseline.
  const growthBaseline =
    epoch.evaluate && epoch.startMemberCount !== null
      ? { ...state, lastMemberCount: epoch.startMemberCount }
      : state;
  const { justSettled, stableReads } = await advanceSyncState(
    tx,
    trackedAccountId,
    dimension,
    growthBaseline,
    isCompleteRead,
    currentCount,
    options.trustedBaseline === true,
    callerSaysComplete || unionCoversExpected,
    leg.headOnly === true,
  );
  await writeEpochState(tx, trackedAccountId, dimension, epoch);

  if (epoch.evaluate && epoch.legs > 1) {
    logger.info(
      {
        trackedAccountId,
        dimension,
        legs: epoch.legs,
        epochSeen: epochAbsence.seenCount,
        held: heldCurrent,
        coverage:
          heldCurrent > 0
            ? Number((epochAbsence.seenCount / heldCurrent).toFixed(3))
            : null,
        isCompleteRead,
        absent: absent.length,
        departures: departures.length,
        settled,
      },
      isCompleteRead
        ? "[roster] epoch complete: absence judged on the union of all legs"
        : "[roster] epoch ended below coverage; no absence evidence taken",
    );
  } else if (epoch.orphan) {
    logger.info(
      { trackedAccountId, dimension, captured: liveMap.size },
      "[roster] continuation leg with no open epoch; recorded sightings only",
    );
  }

  if (!settled) {
    logger.info(
      {
        trackedAccountId,
        dimension,
        captured: liveMap.size,
        held: heldCurrent,
        isCompleteRead,
        igGateSaidComplete: callerSaysComplete,
        stableReads,
        needed: ROSTER_SETTLE_READS,
        currentCount,
        absorbed: arrivals.length,
      },
      justSettled
        ? "[roster] baseline settled; activity from here is real"
        : "[roster] baseline still settling; absorbing members without emitting events",
    );
  }

  return {
    // Until settled we are unioning reads into a baseline, not observing
    // activity — every "arrival" is just discovery. Stay silent.
    completeRead: isCompleteRead,
    arrivals: settled && !options.baselineOnly ? arrivals : [],
    departures,
    currentCount,
    settled,
    justSettled,
  };
}

/** Split a key list into IN-sized chunks; rosters run to thousands of members. */
function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function upsertSeenMembers(
  tx: Tx,
  trackedAccountId: string,
  dimension: RosterDimension,
  liveMap: Map<string, RosterArrival>,
): Promise<void> {
  const rows = Array.from(liveMap.entries()).map(([usernameLower, m]) => ({
    trackedAccountId,
    dimension,
    usernameLower,
    username: m.username,
    displayName: m.displayName,
    igUserId: m.igUserId,
    pfpUrl: m.pfpUrl,
  }));

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await tx
      .insert(rosterMembers)
      .values(rows.slice(i, i + UPSERT_CHUNK))
      .onConflictDoUpdate({
        target: [
          rosterMembers.trackedAccountId,
          rosterMembers.dimension,
          rosterMembers.usernameLower,
        ],
        set: {
          username: sql`EXCLUDED.username`,
          // Never let a blank capture erase known display data. A pfp URL is
          // re-signed by IG on every scrape, so the freshest one always wins.
          displayName: sql`COALESCE(EXCLUDED.display_name, ${rosterMembers.displayName})`,
          igUserId: sql`COALESCE(EXCLUDED.ig_user_id, ${rosterMembers.igUserId})`,
          pfpUrl: sql`COALESCE(EXCLUDED.pfp_url, ${rosterMembers.pfpUrl})`,
          lastSeenAt: sql`now()`,
          // Presence is proof: any sighting clears the absence streak.
          missingStreak: sql`0`,
          isCurrent: sql`true`,
          leftAt: sql`NULL`,
          // Keep the original discovery time while continuously present; a
          // member who left and came back is genuinely new again, so their
          // "recently followed" position should reflect the re-follow.
          firstSeenAt: sql`CASE WHEN ${rosterMembers.isCurrent} THEN ${rosterMembers.firstSeenAt} ELSE now() END`,
        },
      });
  }
}

async function countCurrent(
  tx: Tx,
  trackedAccountId: string,
  dimension: RosterDimension,
): Promise<number> {
  const [row] = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(rosterMembers)
    .where(
      and(
        eq(rosterMembers.trackedAccountId, trackedAccountId),
        eq(rosterMembers.dimension, dimension),
        eq(rosterMembers.isCurrent, true),
      ),
    );
  return row?.value ?? 0;
}

/** @returns whether this read settled the roster, and the new stability streak. */
async function advanceSyncState(
  tx: Tx,
  trackedAccountId: string,
  dimension: RosterDimension,
  prev: SyncState,
  isCompleteRead: boolean,
  currentCount: number,
  trustedBaseline: boolean,
  igGateSaidComplete = false,
  preserveFetchFailure = false,
): Promise<{ justSettled: boolean; stableReads: number }> {
  const completeReads = prev.completeReads + (isCompleteRead ? 1 : 0);

  // The union grew => the baseline was not complete => stability restarts.
  // Only complete reads can testify to stability; a short capture adding
  // nothing new proves nothing.
  //
  // "Grew" is measured with a tolerance: on a large roster IG hands back a
  // slightly different slice every read, so demanding EXACTLY zero growth means
  // stable_reads can never advance and the account never settles (see the
  // ROSTER_SETTLE_GROWTH_TOLERANCE note above). Growth within the tolerance is
  // ordinary churn/jitter, not evidence of an incomplete baseline.
  const prevCount = prev.lastMemberCount ?? -1;
  const growthAllowance =
    prevCount > 0 ? Math.ceil(prevCount * ROSTER_SETTLE_GROWTH_TOLERANCE) : 0;
  const grew = currentCount > prevCount + growthAllowance;

  // A roster that has been seeding past the deadline is accepted as-is: some
  // lists simply cannot be enumerated in full, and staying unsettled means the
  // account reports no activity at all.
  const seedingSince = prev.seededAt ?? null;
  const seedingExpired =
    prev.settledAt === null &&
    seedingSince !== null &&
    Date.now() - seedingSince.getTime() >=
      ROSTER_SETTLE_MAX_SEEDING_HOURS * 3_600_000;

  // IG's reported follower count is unusable as a VETO (it is routinely
  // unreachable, which would keep large rosters permanently unsettled), but it
  // is perfectly good as CONFIRMATION: when a capture reaches the reported
  // total we know the baseline is done and there is nothing to gain by waiting.
  //
  // Without this, a small new account never settles. @tracked_user_3 (121
  // followers, added 3.5h earlier) went 91 -> 109 members; each read discovered
  // more people, so `grew` stayed true, stable_reads stayed 0, and because
  // arrivals are suppressed until settled the customer saw an empty
  // followers/unfollows panel and reported the product as broken.
  const igConfirmsComplete = igGateSaidComplete && currentCount > 0;

  const stableReads = trustedBaseline
    ? Math.max(prev.stableReads, ROSTER_SETTLE_READS)
    : seedingExpired || igConfirmsComplete
      ? Math.max(prev.stableReads, ROSTER_SETTLE_READS)
      : !isCompleteRead
        ? prev.stableReads
        : grew
          ? 0
          : prev.stableReads + 1;

  const justSettled =
    prev.settledAt === null && stableReads >= ROSTER_SETTLE_READS;
  const now = new Date();

  await tx
    .insert(rosterSyncState)
    .values({
      trackedAccountId,
      dimension,
      seededAt: now,
      completeReads,
      stableReads,
      settledAt: justSettled ? now : null,
      lastCompleteReadAt: isCompleteRead ? now : null,
      lastMemberCount: currentCount,
      lastAttemptAt: now,
      lastSuccessAt: now,
      failureKind: null,
      lastError: null,
      nextRetryAt: null,
    })
    .onConflictDoUpdate({
      target: [rosterSyncState.trackedAccountId, rosterSyncState.dimension],
      set: {
        seededAt: sql`COALESCE(${rosterSyncState.seededAt}, EXCLUDED.seeded_at)`,
        completeReads: sql`EXCLUDED.complete_reads`,
        stableReads: sql`EXCLUDED.stable_reads`,
        settledAt: sql`COALESCE(${rosterSyncState.settledAt}, EXCLUDED.settled_at)`,
        lastCompleteReadAt: sql`COALESCE(EXCLUDED.last_complete_read_at, ${rosterSyncState.lastCompleteReadAt})`,
        lastMemberCount: sql`EXCLUDED.last_member_count`,
        lastAttemptAt: sql`EXCLUDED.last_attempt_at`,
        lastSuccessAt: sql`EXCLUDED.last_success_at`,
        ...(preserveFetchFailure ? {} : {
          failureKind: sql`NULL`,
          lastError: sql`NULL`,
          nextRetryAt: sql`NULL`,
        }),
      },
    });

  return { justSettled, stableReads };
}

/**
 * Persist the epoch bookkeeping for this leg (migration 0046). Runs after
 * advanceSyncState, so the row exists. `now()` is the transaction timestamp —
 * identical to the `last_seen_at` stamps written by upsertSeenMembers in this
 * same transaction, which is what makes `last_seen_at >= epoch_started_at` an
 * exact membership test for the epoch's first leg.
 */
async function writeEpochState(
  tx: Tx,
  trackedAccountId: string,
  dimension: RosterDimension,
  plan: RosterEpochPlan,
): Promise<void> {
  if (plan.write === "none") return;
  const scope = sql`tracked_account_id = ${trackedAccountId} AND dimension = ${dimension}`;
  if (plan.write === "begin") {
    await tx.execute(sql`
      UPDATE roster_sync_state
      SET epoch_started_at = now(),
          epoch_completed_at = NULL,
          epoch_start_member_count = ${plan.startMemberCount},
          epoch_legs = 1
      WHERE ${scope}
    `);
    return;
  }
  if (plan.write === "continue") {
    await tx.execute(sql`
      UPDATE roster_sync_state
      SET epoch_legs = epoch_legs + 1
      WHERE ${scope}
    `);
    return;
  }
  // "complete": a single read both begins and ends its epoch (legs = 1); a
  // multi-leg epoch keeps its start and gains its final leg.
  await tx.execute(sql`
    UPDATE roster_sync_state
    SET epoch_started_at = CASE WHEN ${plan.legs} = 1 THEN now() ELSE epoch_started_at END,
        epoch_start_member_count = CASE
          WHEN ${plan.legs} = 1 THEN ${plan.startMemberCount}
          ELSE epoch_start_member_count
        END,
        epoch_legs = ${plan.legs},
        epoch_completed_at = now()
    WHERE ${scope}
  `);
}

/** Current members among an already-loaded snapshot of the roster. */
function countCurrentIn(existing: Map<string, ExistingMember>): number {
  let n = 0;
  for (const m of existing.values()) if (m.isCurrent) n++;
  return n;
}

/**
 * The current roster as a set of lowercased usernames.
 *
 * Replaces fetchKnownFollowingSet/fetchKnownFollowerSet, which rebuilt this from
 * the event log.
 */
export async function fetchRosterSet(
  tx: Tx,
  trackedAccountId: string,
  dimension: RosterDimension,
): Promise<Set<string>> {
  const rows = await tx
    .select({ usernameLower: rosterMembers.usernameLower })
    .from(rosterMembers)
    .where(
      and(
        eq(rosterMembers.trackedAccountId, trackedAccountId),
        eq(rosterMembers.dimension, dimension),
        eq(rosterMembers.isCurrent, true),
      ),
    );
  return new Set(rows.map((r) => r.usernameLower));
}
