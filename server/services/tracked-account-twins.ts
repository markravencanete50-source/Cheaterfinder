import { customerAccessSql } from "./subscription-access.js";
// ─── Twin tracked accounts ───────────────────────────────────────────────────
//
// `like_events` rows are keyed by `tracked_account_id`, but liked-post evidence
// is a property of the INSTAGRAM USER, not of who happens to track them. When
// two customers track the same IG account, each `tracked_accounts` row runs its
// own independent like-evidence scan and discovers a different subset of that
// person's likes: @tracked_user_1 was tracked by two rows against the same
// `ig_user_id`, one holding 23 posts and the other 27, with only 13 in common
// and a union of 37. One customer's dashboard grew a liked post the other never
// saw, which reads as the product losing data.
//
// The fix is read-side: public liked-post reads union public ACTIVE "twins"
// observing the same IG user and dedupe by post id. Private evidence always
// belongs to the original customer row and never participates in that union.
// Nothing about the write path or the per-row visibility predicate changes; a
// customer still only sees likes observed after THEIR tracking started.

import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";

import { db } from "../db.js";
import { likeEvents, trackedAccounts } from "../../shared/schema.js";
import { logger as baseLogger } from "../observability/logger.js";
import { likedPostAfterJoinedAccountTrackingStart } from "./like-event-policy.js";

const logger = baseLogger.child({ module: "tracked-account-twins" });

/** The subset of a like_events row the dedupe needs. */
export interface LikedPostIdentity {
  postId: string;
  postTakenAt: Date | null;
  detectedAt: Date;
}

/**
 * Public ACTIVE tracked-account ids observing the same IG user as a public
 * `accountId`. A private anchor returns only itself.
 *
 * Keyed on `ig_user_id`; falls back to `ig_username` when `ig_user_id` is null
 * (rows added before the pk was resolved). Always includes `accountId` itself,
 * even when that row is inactive — the caller asked about it. Never throws: on
 * a DB error it returns `[accountId]` and warns, so a twin-lookup failure
 * degrades to the previous single-row behaviour rather than emptying a panel.
 */
export async function twinTrackedAccountIds(
  accountId: string,
): Promise<string[]> {
  try {
    const [anchor] = await db
      .select({
        igUserId: trackedAccounts.igUserId,
        igUsername: trackedAccounts.igUsername,
        isPrivate: trackedAccounts.isPrivate,
      })
      .from(trackedAccounts)
      .where(eq(trackedAccounts.id, accountId))
      .limit(1);

    if (!anchor || anchor.isPrivate) return [accountId];

    const sameIgUser =
      anchor.igUserId && anchor.igUserId.trim() !== ""
        ? eq(trackedAccounts.igUserId, anchor.igUserId)
        : eq(trackedAccounts.igUsername, anchor.igUsername);

    const rows = await db
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(and(sameIgUser, eq(trackedAccounts.isActive, true),
        eq(trackedAccounts.isPrivate, false)));

    return Array.from(new Set<string>([accountId, ...rows.map((r) => r.id)]));
  } catch (err) {
    logger.warn(
      { accountId, err },
      "twin tracked-account lookup failed; using the single account",
    );
    return [accountId];
  }
}

/**
 * Ranking used to pick the surviving row for a post id, mirroring the SQL
 * ordering the read paths already use: newest POST first (`post_taken_at DESC
 * NULLS LAST`), tie-broken by newest detection. Returns < 0 when `a` outranks
 * `b`. A row we cannot date always loses to one we can — a legacy pre-0030 row
 * must never shadow a twin's fully-populated copy of the same post.
 */
export function compareLikedPosts(
  a: LikedPostIdentity,
  b: LikedPostIdentity,
): number {
  const aTaken = a.postTakenAt instanceof Date ? a.postTakenAt.getTime() : null;
  const bTaken = b.postTakenAt instanceof Date ? b.postTakenAt.getTime() : null;
  if (aTaken !== bTaken) {
    if (aTaken === null) return 1;
    if (bTaken === null) return -1;
    return bTaken - aTaken;
  }
  return b.detectedAt.getTime() - a.detectedAt.getTime();
}

/**
 * Collapse a twin-union of like_events to one row per post id, keeping the
 * best-ranked copy. The input is not mutated and the first-seen position of
 * each post id is preserved, so a caller that fetched in sorted order keeps
 * that order.
 */
export function dedupeLikedPostsByPostId<T extends LikedPostIdentity>(
  rows: readonly T[],
): T[] {
  const bestByPostId = new Map<string, T>();
  for (const row of rows) {
    const current = bestByPostId.get(row.postId);
    if (current === undefined || compareLikedPosts(row, current) < 0) {
      bestByPostId.set(row.postId, row);
    }
  }
  return Array.from(bestByPostId.values());
}

// ─── Canonical twin ──────────────────────────────────────────────────────────
//
// Public rosters (roster_members / roster_sync_state) are ALSO a property of
// the IG user, but unlike like_events they cannot be unioned: two rows walking the
// same following list would double-count every member. Instead one row is the
// canonical holder of the roster — the OLDEST active row for that IG user — and
// every roster READ keyed by a request's row resolves to it first. Collection
// is free to stop walking rosters for the non-canonical public twins. Private
// rosters remain on each original customer row.

const CANONICAL_CACHE_TTL_MS = 60_000;

interface CanonicalCacheEntry {
  readonly id: string;
  readonly expiresAt: number;
}

/**
 * Process-local memo of `canonicalTwinId`. Roster reads hit this several times
 * per request; a 60 s TTL bounds election staleness after an account is added.
 * Every hit revalidates anchor privacy and cached-candidate eligibility.
 */
const canonicalCache = new Map<string, CanonicalCacheEntry>();

/** Test hook: forget every cached canonical id. */
export function resetCanonicalTwinCache(): void {
  canonicalCache.clear();
}

function hasIgUserId<T extends { igUserId: string | null }>(
  row: T,
): row is T & { igUserId: string } {
  return typeof row.igUserId === "string" && row.igUserId.trim() !== "";
}

/**
 * The canonical row for an IG user: the OLDEST active tracked row sharing
 * `ig_user_id` (username fallback). Private rows always resolve to themselves;
 * public rows only borrow from active paid public rows. Returns the id itself
 * when it has no twins or on DB error. Cached elections never cache privacy.
 */
export async function canonicalTwinId(trackedAccountId: string): Promise<string> {
  const now = Date.now();
  const cached = canonicalCache.get(trackedAccountId);

  try {
    const [anchor] = await db
      .select({
        igUserId: trackedAccounts.igUserId,
        igUsername: trackedAccounts.igUsername,
        isPrivate: trackedAccounts.isPrivate,
      })
      .from(trackedAccounts)
      .where(eq(trackedAccounts.id, trackedAccountId))
      .limit(1);

    if (!anchor || anchor.isPrivate) {
      canonicalCache.delete(trackedAccountId);
      return trackedAccountId;
    }

    const sameIgUser = hasIgUserId(anchor)
      ? eq(trackedAccounts.igUserId, anchor.igUserId)
      : eq(trackedAccounts.igUsername, anchor.igUsername);

    if (cached !== undefined && cached.expiresAt > now) {
      const [stillEligible] = await db.select({ id: trackedAccounts.id })
        .from(trackedAccounts)
        .where(and(eq(trackedAccounts.id, cached.id), sameIgUser,
          eq(trackedAccounts.isActive, true), eq(trackedAccounts.isPrivate, false),
          customerAccessSql(trackedAccounts.userId)))
        .limit(1);
      if (stillEligible) return stillEligible.id;
      canonicalCache.delete(trackedAccountId);
    }

    // Oldest tracking start wins; the id is a deterministic tie-break so two
    // rows created in the same instant always resolve to the same canonical.
    const [oldest] = await db
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(and(sameIgUser, eq(trackedAccounts.isActive, true),
        eq(trackedAccounts.isPrivate, false), customerAccessSql(trackedAccounts.userId)))
      .orderBy(asc(trackedAccounts.trackingStarted), asc(trackedAccounts.id))
      .limit(1);

    const id = oldest?.id ?? trackedAccountId;
    canonicalCache.set(trackedAccountId, {
      id,
      expiresAt: now + CANONICAL_CACHE_TTL_MS,
    });
    return id;
  } catch (err) {
    logger.warn(
      { trackedAccountId, err },
      "canonical twin lookup failed; using the requested account",
    );
    return trackedAccountId;
  }
}

// ─── Batched helpers for list endpoints ──────────────────────────────────────

/**
 * `twinTrackedAccountIds` for many rows in two queries instead of 2×N. Same
 * rules (public active rows only, private anchors isolated, `ig_user_id` with
 * a username fallback, every input id present in its own set) and the same
 * fallback: on error every id maps to `[id]`.
 */
export async function twinTrackedAccountIdMap(
  accountIds: readonly string[],
): Promise<Map<string, string[]>> {
  const unique = Array.from(new Set(accountIds));
  const fallback = new Map<string, string[]>(unique.map((id) => [id, [id]]));
  if (unique.length === 0) return fallback;

  try {
    const anchors = await db
      .select({
        id: trackedAccounts.id,
        igUserId: trackedAccounts.igUserId,
        igUsername: trackedAccounts.igUsername,
        isPrivate: trackedAccounts.isPrivate,
      })
      .from(trackedAccounts)
      .where(inArray(trackedAccounts.id, unique));

    const publicAnchors = anchors.filter((anchor) => !anchor.isPrivate);
    const pkKeys = publicAnchors.filter(hasIgUserId).map((a) => a.igUserId);
    const nameKeys = publicAnchors
      .filter((a) => !hasIgUserId(a))
      .map((a) => a.igUsername);
    const keyMatch = [
      pkKeys.length > 0 ? inArray(trackedAccounts.igUserId, pkKeys) : undefined,
      nameKeys.length > 0
        ? inArray(trackedAccounts.igUsername, nameKeys)
        : undefined,
    ].filter((c) => c !== undefined);
    if (keyMatch.length === 0) return fallback;

    const rows = await db
      .select({
        id: trackedAccounts.id,
        igUserId: trackedAccounts.igUserId,
        igUsername: trackedAccounts.igUsername,
      })
      .from(trackedAccounts)
      .where(and(or(...keyMatch), eq(trackedAccounts.isActive, true),
        eq(trackedAccounts.isPrivate, false), customerAccessSql(trackedAccounts.userId)));

    const byPk = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    for (const row of rows) {
      if (hasIgUserId(row)) {
        byPk.set(row.igUserId, [...(byPk.get(row.igUserId) ?? []), row.id]);
      }
      byName.set(row.igUsername, [
        ...(byName.get(row.igUsername) ?? []),
        row.id,
      ]);
    }

    const resolved = anchors.map((anchor): [string, string[]] => {
      if (anchor.isPrivate) return [anchor.id, [anchor.id]];
      const twins = hasIgUserId(anchor)
        ? byPk.get(anchor.igUserId)
        : byName.get(anchor.igUsername);
      return [
        anchor.id,
        Array.from(new Set<string>([anchor.id, ...(twins ?? [])])),
      ];
    });
    return new Map<string, string[]>([...fallback, ...resolved]);
  } catch (err) {
    logger.warn(
      { accountIds: unique, err },
      "batched twin lookup failed; using single accounts",
    );
    return fallback;
  }
}

/**
 * Visible liked-post count per requesting row, as the dashboard header counts
 * it: the twin union, deduped by post id, gated by the REQUESTING row's
 * tracking start (`likedPostAfterJoinedAccountTrackingStart` joined to the
 * anchor row). One statement for the whole list. Rows with no visible likes
 * are absent from the map.
 */
export async function countVisibleLikedPostsByAccount(
  accountIds: readonly string[],
): Promise<Map<string, number>> {
  const twinMap = await twinTrackedAccountIdMap(accountIds);
  const pairs = Array.from(twinMap.entries()).flatMap(([anchorId, twins]) =>
    twins.map((twinId) => sql`(${anchorId}::text, ${twinId}::text)`),
  );
  if (pairs.length === 0) return new Map();

  const result = await db.execute<{ anchor_id: string; n: number }>(sql`
    SELECT p.anchor_id AS anchor_id,
           count(DISTINCT ${likeEvents.postId})::int AS n
    FROM (VALUES ${sql.join(pairs, sql`, `)}) AS p(anchor_id, twin_id)
    JOIN ${trackedAccounts} ON ${trackedAccounts.id} = p.anchor_id
    JOIN ${likeEvents} ON ${likeEvents.trackedAccountId} = p.twin_id
    WHERE ${likedPostAfterJoinedAccountTrackingStart()}
    GROUP BY p.anchor_id
  `);
  // db.execute returns either an array (drizzle) or { rows }. Normalise.
  const rows: Array<{ anchor_id: string; n: number }> = Array.isArray(result)
    ? result
    : ((result as { rows?: Array<{ anchor_id: string; n: number }> }).rows ??
      []);
  return new Map(rows.map((r) => [String(r.anchor_id), Number(r.n)]));
}

// ─── Roster inheritance on promotion (audit 2026-09-02, C7) ──────────────────
//
// A non-canonical twin never walks, so its roster_members / roster_sync_state
// freeze at the moment it lost the election (ash: 128 members held vs 139 on
// the canonical row). If the canonical row is then deactivated,
// `canonicalTwinId` promotes the frozen row, and its first walk would report
// every member who arrived since the freeze as a fresh arrival and lag every
// departure behind the absence hysteresis. The promoted row therefore inherits
// the freshest sibling roster first (roster-store `copyRosterFromSibling`).
// The policy of WHICH sibling qualifies is the pure function below so it can
// be unit-tested without a DB; the collector wires it to the live states.

/**
 * Every OTHER public tracked row observing the same IG user as a public
 * `accountId`, ACTIVE OR NOT — a deactivated former canonical is exactly the
 * row whose roster a promoted twin needs. Private anchors have no donors.
 * Same identity rule as `twinTrackedAccountIds` (pk with a username fallback).
 * Fails CLOSED to `[]`: inheritance with no donor is skipped, never guessed.
 */
export async function siblingTrackedAccountIds(
  accountId: string,
): Promise<string[]> {
  try {
    const [anchor] = await db
      .select({
        igUserId: trackedAccounts.igUserId,
        igUsername: trackedAccounts.igUsername,
        isPrivate: trackedAccounts.isPrivate,
      })
      .from(trackedAccounts)
      .where(eq(trackedAccounts.id, accountId))
      .limit(1);

    if (!anchor || anchor.isPrivate) return [];

    const sameIgUser = hasIgUserId(anchor)
      ? eq(trackedAccounts.igUserId, anchor.igUserId)
      : eq(trackedAccounts.igUsername, anchor.igUsername);

    const rows = await db
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(and(sameIgUser, ne(trackedAccounts.id, accountId),
        eq(trackedAccounts.isPrivate, false)));

    return rows.map((r) => r.id);
  } catch (err) {
    logger.warn(
      { accountId, err },
      "sibling tracked-account lookup failed; no roster inheritance this cycle",
    );
    return [];
  }
}

/** One sibling's roster_sync_state, as the donor policy needs it. */
export interface RosterDonorCandidate {
  readonly trackedAccountId: string;
  readonly lastSuccessAt: Date | null;
  /** roster_members rows with `is_current IS TRUE` — an empty roster never donates. */
  readonly currentMembers: number;
}

export interface RosterInheritancePolicy {
  /** A donor whose last successful read is older than this is itself stale. */
  readonly maxDonorAgeMs: number;
  /**
   * The donor must lead the target's own last success by at least this much.
   * Two rows that walked in the same cycle before the walk collapse shipped
   * (tracked_user_1: 400 ms apart) hold the same roster; replacing one with the
   * other would only churn `last_seen_at`.
   */
  readonly minLeadMs: number;
}

export const DEFAULT_ROSTER_INHERITANCE_POLICY: RosterInheritancePolicy = {
  maxDonorAgeMs: 72 * 60 * 60 * 1000,
  minLeadMs: 30 * 60 * 1000,
};

/**
 * Choose the sibling whose roster a freshly promoted canonical row should
 * inherit, or `null` when none qualifies. A candidate qualifies when it has a
 * successful read at all, that read is not stale (`maxDonorAgeMs`), it holds
 * at least one current member, and it leads the target's own last success by
 * `minLeadMs` (a target with no success yet is led by any success). The
 * freshest qualifying candidate wins; ties break on id so the choice is
 * deterministic. Pure: no I/O, inputs are not mutated.
 */
export function pickRosterInheritanceDonor(
  candidates: readonly RosterDonorCandidate[],
  targetLastSuccessAt: Date | null,
  now: Date,
  policy: RosterInheritancePolicy = DEFAULT_ROSTER_INHERITANCE_POLICY,
): RosterDonorCandidate | null {
  const targetMs =
    targetLastSuccessAt instanceof Date
      ? targetLastSuccessAt.getTime()
      : Number.NEGATIVE_INFINITY;
  const oldestAcceptableMs = now.getTime() - policy.maxDonorAgeMs;

  const qualifying = candidates.filter((c) => {
    if (!(c.lastSuccessAt instanceof Date)) return false;
    const successMs = c.lastSuccessAt.getTime();
    if (!Number.isFinite(successMs)) return false;
    if (successMs < oldestAcceptableMs) return false;
    if (c.currentMembers <= 0) return false;
    return successMs - targetMs >= policy.minLeadMs;
  });
  if (qualifying.length === 0) return null;

  return [...qualifying].sort((a, b) => {
    const byFreshness =
      (b.lastSuccessAt as Date).getTime() - (a.lastSuccessAt as Date).getTime();
    if (byFreshness !== 0) return byFreshness;
    return a.trackedAccountId < b.trackedAccountId ? -1 : 1;
  })[0];
}
