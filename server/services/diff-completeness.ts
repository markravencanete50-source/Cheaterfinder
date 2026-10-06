// ─── Diff completeness gate ─────────────────────────────────────────────────
//
// Guards the unfollow-detection logic in persistFollowerDiff /
// persistFollowingDiff against false positives caused by incomplete scrapes.
//
// Real-world bug (2026-05): tracked `wire.fluid` (495 actual followers).
// Three scrapes captured 22 / 484 / 12 followers. The 12-follower scrape
// triggered 305 false-positive unfollow events because the diff logic
// interpreted "previously seen but absent in this scrape = unfollowed".
//
// Fix: only run the unfollow side of the diff when the live capture is
// "complete enough" relative to the most recent profile snapshot's expected
// count. Newly-discovered followers are always additive-safe to insert and
// pass through this gate untouched at the call site.
// ────────────────────────────────────────────────────────────────────────────

import { and, desc, eq, lte } from "drizzle-orm";

import { db } from "../db.js";
import { profileSnapshots } from "../../shared/schema.js";

// Threshold: the live capture must contain at least this fraction of the
// expected count for unfollow detection to be considered safe. 0.90 was
// chosen as a conservative default that tolerates small natural drift
// (a handful of churn between scrapes) without admitting catastrophically
// short captures (50%, 25%, 5%).
export const COMPLETENESS_THRESHOLD = 0.9;

// Identifies which dimension we are gating: inbound followers or outbound
// following list.
export type DiffKind = "follower" | "following";

export interface CompletenessDecision {
  readonly allowUnfollowDiff: boolean;
  readonly liveCount: number;
  readonly expectedCount: number | null;
  readonly completeness: number | null;
}

/**
 * Pure decision function: given the live capture size and the expected
 * baseline (from the latest profile snapshot), decide whether to compute
 * the unfollow side of the diff.
 *
 * Rules:
 *   - No baseline (null expected)        → allow (we have nothing to compare).
 *   - expected === 0                     → allow only when live is also 0.
 *   - liveCount / expectedCount >= 0.90  → allow.
 *   - otherwise                          → skip unfollow detection.
 */
export function shouldComputeUnfollowDiff(
  liveCount: number,
  expectedCount: number | null,
): CompletenessDecision {
  if (expectedCount === null) {
    return {
      allowUnfollowDiff: true,
      liveCount,
      expectedCount: null,
      completeness: null,
    };
  }
  if (expectedCount === 0) {
    return {
      allowUnfollowDiff: liveCount === 0,
      liveCount,
      expectedCount: 0,
      completeness: null,
    };
  }
  const completeness = liveCount / expectedCount;
  return {
    allowUnfollowDiff: completeness >= COMPLETENESS_THRESHOLD,
    liveCount,
    expectedCount,
    completeness,
  };
}

/**
 * Resolves the expected baseline count for the given tracked account from
 * the most recent profile_snapshots row. Returns `null` when no snapshot
 * exists yet — the first capture for an account has no prior baseline,
 * so the gate must allow the diff through.
 */
export async function fetchExpectedCount(
  trackedAccountId: string,
  kind: DiffKind,
  executor: Pick<typeof db, "select"> = db,
): Promise<number | null> {
  const column =
    kind === "follower"
      ? profileSnapshots.followerCount
      : profileSnapshots.followingCount;

  const [row] = await executor
    .select({ value: column })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.trackedAccountId, trackedAccountId))
    .orderBy(desc(profileSnapshots.snapshotAt))
    .limit(1);

  if (!row) return null;
  return row.value ?? null;
}

// ─── Diff-aware enumeration gate (Phase 2: recurring-cost savings) ───────────
//
// Follower/following enumeration is by far the most expensive scrape (paginated
// over residential proxy, up to hundreds of pages). Most refresh cycles see no
// change at all, so re-enumerating every cycle burns bandwidth for nothing. We
// use the profile counts (which we get for free from the profile fetch) as a
// cheap change signal: if the count is identical to the last snapshot AND we
// already hold a complete-enough roster, skip the enumeration entirely.
//
// Two guards keep this safe:
//   - completeness: never skip while the stored roster is short of the expected
//     count (e.g. the first capture only got a partial roster).
//   - force-full valve: periodically re-enumerate anyway, so an equal-count
//     composition swap (one follower in, one out → net zero) is still caught.
// ────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

/** Lower bound for any force-full valve (env values below it are clamped). */
export const FORCE_FULL_ENUM_TTL_MIN_MS = 30 * 60 * 1000;
/**
 * Default valve for a SETTLED roster. Was 6 h: on 2026-09-02 that forced 33
 * full walks whose counts had not moved (e.g. @tracked_user_4 following, 44
 * pages) purely to catch equal-count composition swaps, which are rare. 24 h
 * bounds that cost; `ROSTER_FORCE_FULL_TTL_MS` overrides it.
 */
export const FORCE_FULL_ENUM_TTL_DEFAULT_MS = 24 * HOUR_MS;
/**
 * Valve for a roster that has NOT settled yet. Seeding needs its complete
 * reads on the historical cadence to reach `stable_reads` (lesson 6), so the
 * longer settled default must not slow it down.
 */
export const SEEDING_FORCE_FULL_ENUM_TTL_MS = 6 * HOUR_MS;

/** Parse `ROSTER_FORCE_FULL_TTL_MS`: blank/garbage/non-positive → fallback. */
export function resolveForceFullTtlMs(
  raw: string | undefined,
  fallback: number = FORCE_FULL_ENUM_TTL_DEFAULT_MS,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(FORCE_FULL_ENUM_TTL_MIN_MS, Math.trunc(parsed));
}

/** How long a stable, complete roster may be reused before we force a full
 *  re-enumeration to catch equal-count composition swaps. */
export const DEFAULT_FORCE_FULL_ENUM_TTL_MS = resolveForceFullTtlMs(
  process.env.ROSTER_FORCE_FULL_TTL_MS,
);

/**
 * Force-full valve for one roster: the (env-tunable) settled TTL once the
 * baseline has settled; while seeding, the historical 6 h — or the operator's
 * value when they asked for something even shorter.
 */
export function forceFullTtlFor(
  settled: boolean,
  settledTtlMs: number = DEFAULT_FORCE_FULL_ENUM_TTL_MS,
): number {
  return settled
    ? settledTtlMs
    : Math.min(settledTtlMs, SEEDING_FORCE_FULL_ENUM_TTL_MS);
}

export type RosterEnumReason =
  | "no-baseline"
  | "never-captured"
  | "count-changed"
  | "roster-incomplete"
  | "over-enumeration-cap"
  | "force-full-valve"
  | "restricted-backoff"
  | "background-sync"
  /** Rosters live on the canonical twin; this row does not walk them. */
  | "non-canonical-twin"
  /** Large roster already complete; next re-walk waits for the rewalk window. */
  | "complete-rewalk-deferred"
  /**
   * A saved resume cursor exists: the previous cycle's walk stopped mid-list,
   * so this cycle continues it regardless of counts. A resumed sequence is one
   * logical read (an "epoch", roster-store.ts) and only counts once it ends.
   */
  | "walk-in-progress"
  | "unchanged";

export interface RosterEnumDecision {
  readonly fetch: boolean;
  readonly reason: RosterEnumReason;
}

export interface SnapshotCounts {
  readonly postCount: number | null;
  readonly followerCount: number | null;
  readonly followingCount: number | null;
  readonly snapshotAt: Date | null;
}

/**
 * Read the most recent snapshot's counts (post/follower/following). Returns
 * null when no snapshot exists yet — the caller treats that as "no baseline →
 * must enumerate". Read this BEFORE inserting the current cycle's snapshot, or
 * the comparison is always zero.
 */
export async function fetchLastSnapshotCounts(
  trackedAccountId: string,
): Promise<SnapshotCounts | null> {
  const [row] = await db
    .select({
      postCount: profileSnapshots.postCount,
      followerCount: profileSnapshots.followerCount,
      followingCount: profileSnapshots.followingCount,
      snapshotAt: profileSnapshots.snapshotAt,
    })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.trackedAccountId, trackedAccountId))
    .orderBy(desc(profileSnapshots.snapshotAt))
    .limit(1);
  if (!row) return null;
  return {
    postCount: row.postCount ?? null,
    followerCount: row.followerCount ?? null,
    followingCount: row.followingCount ?? null,
    snapshotAt: row.snapshotAt ?? null,
  };
}

/**
 * Pure decision: should we run the (expensive) roster enumeration this cycle?
 *
 * Enumerate when ANY of:
 *   - no baseline count yet (first cycle),
 *   - we have never captured a roster (no events),
 *   - the live count changed since the last snapshot,
 *   - the stored roster is below the completeness threshold of the live count,
 *   - the stored roster has gone stale past the force-full TTL.
 * Otherwise skip — count is stable and we already hold a complete roster.
 */
export function shouldEnumerateRoster(params: {
  readonly currentCount: number;
  readonly prevCount: number | null;
  readonly liveRosterTotal: number;
  readonly lastCaptureAtMs: number | null;
  readonly nowMs: number;
  readonly forceFullTtlMs?: number;
  /**
   * The most followers/following a single enumeration can capture (the
   * scraper's pagination cap). Once the held roster reaches this, we have
   * captured everything we are configured to fetch — re-enumerating cannot grow
   * it, so the completeness check stops firing. This prevents the M2 failure:
   * IG's reported count can exceed what is actually enumerable (ghost/bot
   * followers, deactivated accounts, the cap itself), which would otherwise keep
   * `liveRosterTotal < 0.9 * currentCount` true forever and re-enumerate every
   * cycle for large accounts — yielding zero savings exactly where enumeration
   * is most expensive.
   */
  readonly maxEnumerableItems?: number;
}): RosterEnumDecision {
  const ttl = params.forceFullTtlMs ?? DEFAULT_FORCE_FULL_ENUM_TTL_MS;
  if (params.prevCount === null) return { fetch: true, reason: "no-baseline" };
  if (params.lastCaptureAtMs === null) {
    return { fetch: true, reason: "never-captured" };
  }
  if (params.currentCount !== params.prevCount) {
    return { fetch: true, reason: "count-changed" };
  }
  const hitEnumerableCap =
    params.maxEnumerableItems !== undefined &&
    params.liveRosterTotal >= params.maxEnumerableItems;
  if (
    params.currentCount > 0 &&
    params.liveRosterTotal < COMPLETENESS_THRESHOLD * params.currentCount &&
    !hitEnumerableCap
  ) {
    return { fetch: true, reason: "roster-incomplete" };
  }
  if (params.nowMs - params.lastCaptureAtMs > ttl) {
    return { fetch: true, reason: "force-full-valve" };
  }
  return { fetch: false, reason: "unchanged" };
}

// ────────────────────────────────────────────────────────────────────────────
// Re-walk policy for LARGE rosters that are already complete
// ────────────────────────────────────────────────────────────────────────────
//
// Context (CLAUDE.md "Known pipeline gaps", 2026-09-02): @sample_account
// (9.9k followers) held 97% of IG's count — "complete" per
// computeRosterSyncState — yet its reported count drifted by 1-3 every 3h, so
// `count-changed` fired a fresh 240-page walk each cycle (~180-285 follower
// pages / 6h, 60% of the followers budget). Every one of those walks ended
// "scrape incomplete, skipping unfollow diff": a roster that cannot be read in
// ONE walk can never satisfy the 90%-of-held complete-read gate, so the
// re-walk only ever produced additive arrivals we would have caught anyway.
//
// Policy: once a roster that does NOT fit a single walk is complete, start a
// new walk at most once per ROSTER_COMPLETE_REWALK_HOURS, unless IG's reported
// count has moved by at least ROSTER_REWALK_MIN_DELTA since the last complete
// walk (a mass follow/unfollow is worth reading now). Rosters that fit one walk
// are untouched: their every walk yields a real complete read and unfollow diff.
//
// `lastWalkAt` must be the per-roster anchor that advances only when a walk
// EXHAUSTS the cursor (tracked_accounts.last_{followers,following}_refresh_at).
// A multi-cycle walk therefore stays "due" until it finishes, so continuation
// legs are never deferred and a saved cursor is never left to go stale.

function readClampedIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** Hours between full re-walks of a complete large roster (env, 3..168). */
export const ROSTER_COMPLETE_REWALK_HOURS = readClampedIntEnv(
  "ROSTER_COMPLETE_REWALK_HOURS",
  24,
  3,
  168,
);
export const ROSTER_COMPLETE_REWALK_MS = ROSTER_COMPLETE_REWALK_HOURS * 60 * 60 * 1000;

// ── Head-walk for deferred large rosters ────────────────────────────────────
//
// IG lists followers newest-first, so a large roster's recent arrivals sit in
// its first pages: @sample_account gained 14 followers in 5 h and every one
// of them was on pages 1-2, while the re-walk policy above (correctly) held
// the 400-page full walk for up to 24 h. When the policy DEFERS a followers
// walk, the collector still reads the first ROSTER_HEAD_PAGES pages and
// persists ARRIVALS only — no departures, no cursor change, no complete-read
// stamp (roster-store `HEAD_WALK_LEG`). 0 disables the peek.

export const ROSTER_HEAD_PAGES_DEFAULT = 3;
export const ROSTER_HEAD_PAGES_MAX = 20;

/** Parse `ROSTER_HEAD_PAGES`: blank/garbage → default; clamped to 0..MAX. */
export function resolveHeadPages(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return ROSTER_HEAD_PAGES_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return ROSTER_HEAD_PAGES_DEFAULT;
  return Math.min(ROSTER_HEAD_PAGES_MAX, Math.max(0, Math.trunc(parsed)));
}

/** Pages to peek at the head of a deferred large followers roster (0 = off). */
export const ROSTER_HEAD_PAGES = resolveHeadPages(process.env.ROSTER_HEAD_PAGES);

/** Floor for the default per-roster delta when the env override is unset. */
export const ROSTER_REWALK_MIN_DELTA_FLOOR = 25;
/** Fraction of the held roster used for the default delta (0.5%). */
export const ROSTER_REWALK_MIN_DELTA_RATIO = 0.005;

/** Operator override for the count delta (env). `null` = derive per roster. */
export const ROSTER_REWALK_MIN_DELTA_OVERRIDE: number | null = (() => {
  const raw = process.env.ROSTER_REWALK_MIN_DELTA;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.trunc(parsed);
})();

/**
 * How far IG's reported count must move since the last complete walk before a
 * complete large roster is re-walked early: the env override when set, else
 * max(25, 0.5% of the held roster).
 */
export function resolveRewalkMinDelta(
  heldCount: number,
  override: number | null = ROSTER_REWALK_MIN_DELTA_OVERRIDE,
): number {
  if (override !== null && Number.isFinite(override) && override >= 1) {
    return Math.trunc(override);
  }
  const held = Number.isFinite(heldCount) ? Math.max(0, heldCount) : 0;
  return Math.max(
    ROSTER_REWALK_MIN_DELTA_FLOOR,
    Math.ceil(held * ROSTER_REWALK_MIN_DELTA_RATIO),
  );
}

/**
 * Can a roster of `reportedCount` members be read in ONE walk of `maxPages`
 * pages at `itemsPerPage`? Such rosters keep today's behaviour: every walk is a
 * complete read, so re-walking on every count change is what detects unfollows.
 */
export function rosterFitsSingleWalk(
  reportedCount: number,
  maxPages: number,
  itemsPerPage: number,
): boolean {
  if (!Number.isFinite(reportedCount) || reportedCount <= 0) return true;
  const capacity = Math.max(0, Math.floor(maxPages)) * Math.max(0, Math.floor(itemsPerPage));
  return reportedCount <= capacity;
}

export interface RewalkCompleteRosterParams {
  /** When the last walk of this roster EXHAUSTED its cursor; null = never. */
  readonly lastWalkAt: Date | number | null;
  /** IG's reported count this cycle. */
  readonly reportedCount: number;
  /** Members currently held for this roster. */
  readonly heldCount: number;
  /**
   * IG's reported count at the time of the last complete walk (the profile
   * snapshot taken that cycle). Unknown → the delta rule cannot judge, so the
   * decision falls back to the time window alone (fails open, see below).
   */
  readonly reportedAtLastWalk?: number | null;
  readonly nowMs: number;
  /** Minimum spacing between walks that start from the top. */
  readonly rewalkMs: number;
  /** Count movement since the last complete walk that justifies an early walk. */
  readonly minDelta: number;
}

/**
 * Pure decision: should a COMPLETE roster that cannot be read in one walk be
 * (re-)walked this cycle?
 *
 *   - never completed a walk, or nothing held        → walk (nothing to defer)
 *   - rewalk window elapsed since the last complete walk → walk
 *   - reported count moved ≥ minDelta since that walk   → walk
 *   - reported count at the last walk unknown           → walk (fail open)
 *   - otherwise                                          → defer
 *
 * The caller decides whether the roster is complete and large; this function
 * only applies the cadence once those preconditions hold.
 */
export function shouldRewalkCompleteRoster(
  params: RewalkCompleteRosterParams,
): boolean {
  const lastWalkMs =
    params.lastWalkAt === null
      ? null
      : params.lastWalkAt instanceof Date
        ? params.lastWalkAt.getTime()
        : params.lastWalkAt;
  if (lastWalkMs === null || !Number.isFinite(lastWalkMs)) return true;
  if (!Number.isFinite(params.heldCount) || params.heldCount <= 0) return true;
  if (params.nowMs - lastWalkMs >= params.rewalkMs) return true;
  const baseline = params.reportedAtLastWalk;
  if (baseline === undefined || baseline === null || !Number.isFinite(baseline)) {
    return true;
  }
  return Math.abs(params.reportedCount - baseline) >= params.minDelta;
}

/**
 * IG's reported follower/following count as of `atMs`: the latest profile
 * snapshot taken at or before that instant. Snapshots are written before the
 * roster walk of the same cycle, so the snapshot at/before a walk's completion
 * anchor is the count that walk was measured against. Null when no snapshot
 * that old exists (the caller then fails open).
 */
export async function fetchReportedCountAt(
  trackedAccountId: string,
  kind: DiffKind,
  atMs: number,
): Promise<number | null> {
  const column =
    kind === "follower"
      ? profileSnapshots.followerCount
      : profileSnapshots.followingCount;
  const [row] = await db
    .select({ count: column })
    .from(profileSnapshots)
    .where(
      and(
        eq(profileSnapshots.trackedAccountId, trackedAccountId),
        lte(profileSnapshots.snapshotAt, new Date(atMs)),
      ),
    )
    .orderBy(desc(profileSnapshots.snapshotAt))
    .limit(1);
  const count = row?.count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}
