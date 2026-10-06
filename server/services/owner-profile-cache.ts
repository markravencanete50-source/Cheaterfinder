import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { logger } from "../observability/logger.js";

/**
 * How long a cached owner privacy verdict stays authoritative. An owner flipping
 * public↔private is rare, and the cost of a stale verdict is one wasted posts
 * call (private) or one missed cycle (newly public) — far cheaper than the
 * hourly profile re-read this replaces. 0 disables the cache (always fetch).
 */
export const OWNER_PROFILE_TTL_HOURS = Math.max(
  0,
  Math.min(Number(process.env.LIKE_EVIDENCE_OWNER_PROFILE_TTL_HOURS ?? "168"), 720),
);
export const OWNER_PROFILE_TTL_MS = OWNER_PROFILE_TTL_HOURS * 3_600_000;

export interface CachedOwnerProfile {
  readonly igUserId: string | null;
  readonly ownerIsPrivate?: boolean | null;
  readonly ownerProfileCheckedAt?: Date | string | null;
}

export interface OwnerProfileVerdict {
  readonly igUserId: string;
  readonly isPrivate: boolean;
}

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Return the cached verdict when it is complete and fresh, else null so the
 * caller fetches the live profile. Fails CLOSED on anything unparseable: an
 * owner we cannot vouch for gets fetched, never guessed.
 */
export function resolveOwnerProfileFromCache(
  owner: CachedOwnerProfile,
  nowMs: number,
  ttlMs: number = OWNER_PROFILE_TTL_MS,
): OwnerProfileVerdict | null {
  if (ttlMs <= 0) return null;
  if (!owner.igUserId) return null;
  if (typeof owner.ownerIsPrivate !== "boolean") return null;
  const checkedMs = toMs(owner.ownerProfileCheckedAt);
  if (checkedMs === null) return null;
  if (nowMs - checkedMs > ttlMs) return null;
  return { igUserId: owner.igUserId, isPrivate: owner.ownerIsPrivate };
}

/**
 * Persist a live verdict for the owner row of THIS tracked account's following
 * roster. Also backfills ig_user_id when the roster row lacked it. Telemetry
 * only: a failed write must never fail the scan, but it is logged so a broken
 * cache shows up as a warning rather than as silently re-fetched profiles.
 */
export async function recordOwnerProfileVerdict(
  trackedAccountId: string,
  ownerUsername: string,
  isPrivate: boolean,
  igUserId: string | null,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE roster_members
         SET owner_is_private = ${isPrivate},
             owner_profile_checked_at = NOW(),
             ig_user_id = COALESCE(ig_user_id, ${igUserId})
       WHERE tracked_account_id = ${trackedAccountId}
         AND dimension = 'following'
         AND username_lower = ${ownerUsername.toLowerCase()}
    `);
  } catch (err) {
    logger.warn(
      {
        trackedAccountId,
        ownerUsername,
        err: err instanceof Error ? err.message : String(err),
      },
      "[owner-profile-cache] verdict write failed; owner will be re-fetched next cycle",
    );
  }
}
