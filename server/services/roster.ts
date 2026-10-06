// ─── Roster builders ────────────────────────────────────────────────────────
//
// Pure read-only helpers that derive the *current* followers / following
// roster for a tracked account from the append-only event tables.
//
// Set semantics mirror persistFollowerDiff / persistFollowingDiff in
// public-data-persistence.ts: a username is "currently a follower" if it
// has at least one follow event strictly newer (detected_at) than its
// latest unfollow event (case-insensitive compare). For an account that
// follows, unfollows, then follows again, the latest follow wins because
// the unfollow row is older.
//
// D4 fix: aggregation, pagination, and counting all happen in SQL. The old
// implementation selected EVERY event row for the account and aggregated in
// JS — ~10-23k rows per call on live accounts, invoked with {limit: 1} just
// to read `total` on hot paths. The reconstruction below is:
//
//   lu      = latest unfollow per lower(username)
//   entries = per lower(username): min(detected_at) among follow rows that
//             are strictly newer than the latest unfollow ("surviving" rows),
//             truncated to millisecond precision (matching the old JS code,
//             which only ever saw driver-truncated ms timestamps)
//   stats   = count(entries) + max(first_seen)   → total / lastUpdatedAt
//   page    = entries ordered first_seen DESC, cursor-filtered, LIMIT n
//   enrich  = display fields for page usernames only: per field, the value
//             from the latest surviving row where that field is non-empty
//             (mirrors the JS "latest non-null display fields win" rule;
//             surviving ≡ detected_at >= first_seen, since first_seen is
//             already past the latest unfollow)
//
// Cursor format: `${firstSeenAtIso}|${usernameLower}` (opaque to clients).
// Bulk diff inserts give thousands of entries the same detected_at, so a
// bare timestamp cursor (`first_seen < ts` — the old JS behavior) silently
// drops every tied entry after a page boundary. The composite cursor resumes
// exactly after the last returned row instead. Legacy bare-ISO cursors are
// still accepted with the old strict-< semantics.
//
// Use getFollowersRosterStats / getFollowingRosterStats when only the total
// (and lastUpdatedAt) is needed — it skips the page/enrichment work.
// ─────────────────────────────────────────────────────────────────────────────

import { and, desc, eq, gt, gte, lt, lte, sql, type SQL } from "drizzle-orm";

import { db } from "../db.js";
import {
  followEvents,
  followerUnfollowEvents,
  profileSnapshots,
  rosterMembers,
  trackedAccounts,
  unfollowEvents,
} from "../../shared/schema.js";
import { getRosterSyncHealth } from "./roster-store.js";
import { canonicalTwinId } from "./tracked-account-twins.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

// ── Roster completeness ─────────────────────────────────────────────────────
//
// The serving layer used to mark a roster "partial" whenever the held count
// was below Instagram's *reported* follower/following number. That number is
// almost always unreachable: enumeration is capped (FOLLOW_GRAPH_MAX_ITEMS),
// IG won't paginate huge public accounts that deep, and the reported total
// counts ghost/deactivated/blocked-from-bot users that never appear in any
// enumeration. The result was a "still syncing the rest in the background"
// banner that showed forever even after collection had captured everything it
// ever could. computeRosterSyncState replaces that with an honest tri-state.
//
// Mirrors the collector's pagination cap (same env var) so the two never drift.
export const ROSTER_ENUMERABLE_CAP = (() => {
  const n = Number(process.env.FOLLOW_GRAPH_MAX_ITEMS ?? "15000");
  if (!Number.isFinite(n) || n <= 0) return 15000;
  // Same floor as the collector's page/item clamps: an operator value below
  // 15,000 would make every mid-size roster "capped" here while the walk still
  // enumerates it in full, and "capped" bypassed the re-walk policy (sample).
  return Math.min(Math.max(Math.floor(n), 15000), 50000);
})();

// Treat the held roster as "as complete as it will get" once it covers this
// fraction of the reachable total. IG's reported count routinely overshoots the
// enumerable set by a few percent (ghosts/private), so an exact match is rare.
const ROSTER_COMPLETE_RATIO = 0.9;

export type RosterSyncState = "complete" | "capped" | "syncing" | "restricted";

/**
 * Decide how honest the UI should be about a roster's completeness.
 *
 *  - "capped":   IG reports more than we can ever enumerate (huge account), OR a
 *                full enumeration has completed yet we're still short — IG won't
 *                hand over the rest. The list will not grow further; do not claim
 *                we're "still syncing".
 *  - "complete": we hold (effectively) everything reachable.
 *  - "syncing":  a full enumeration has not completed yet and more is reachable,
 *                so the background importer is genuinely still working.
 */
export function computeRosterSyncState(params: {
  loadedTotal: number;
  reportedTotal: number;
  lastGraphRefreshAt: Date | string | null | undefined;
  /** False when migration 0029's materialized baseline has not settled yet. */
  baselineSettled?: boolean;
  failureKind?: string | null;
  nextRetryAt?: Date | string | null;
  cap?: number;
}): RosterSyncState {
  const cap = params.cap ?? ROSTER_ENUMERABLE_CAP;
  const loaded = Math.max(0, params.loadedTotal);
  const reported = Math.max(0, params.reportedTotal);

  // The collector has a hard enumerable ceiling. If Instagram reports more
  // than that ceiling, a full roster is impossible by construction; surface a
  // permanent capped state immediately instead of promising background sync
  // that can never finish (e.g. natgeo's 268M followers).
  if (reported > cap) return "capped";

  const retryAt = params.nextRetryAt
    ? new Date(params.nextRetryAt).getTime()
    : Number.NaN;
  if (
    Boolean(params.failureKind) &&
    Number.isFinite(retryAt) &&
    retryAt > Date.now()
  ) {
    return "restricted";
  }

  // A real 0/0 roster is complete even before it needs a materialized row.
  if (loaded === 0 && reported === 0) return "complete";

  // We already hold (effectively) everything Instagram says exists. Use ceil so
  // a tiny reported count can't round its threshold down to 0 and mark a
  // never-enumerated account "complete" (e.g. reported=1 → ceil(0.9)=1, so 0
  // loaded stays "syncing"). This check intentionally comes before the
  // baseline-settled guard: settlement controls whether churn/departures are
  // trusted, but it must not leave a fully loaded 675-of-674 roster displaying
  // an impossible "still syncing" message forever.
  if (loaded >= Math.ceil(reported * ROSTER_COMPLETE_RATIO)) return "complete";

  // Legacy refresh anchors predate the materialized roster and cannot certify
  // an actually short list. Until roster_sync_state settles, stay visibly
  // syncing and keep churn detection disabled.
  if (params.baselineSettled === false) return "syncing";

  // Short of IG's count. Either the enumeration has finished (the rest is
  // unreachable — ghosts/private/blocked/over the enumeration cap) so the list
  // will not grow, or we are genuinely still importing in the background.
  const enumerationFinished =
    Boolean(params.lastGraphRefreshAt) || loaded >= cap;
  return enumerationFinished ? "capped" : "syncing";
}

export interface RosterEntry {
  username: string;
  displayName: string | null;
  igUserId?: string | null;
  pfpUrl?: string | null;
  /** ISO-8601 timestamp of the earliest detection of this user. */
  firstSeenAt: string;
}

export interface RosterPage {
  items: RosterEntry[];
  /** Opaque cursor for the next page if more rows remain, else null. */
  nextCursor: string | null;
  /** Total roster size after exclusions (NOT page size). */
  total: number;
  /** Most recent time a row entered this roster, if any. */
  lastUpdatedAt: string | null;
}

export interface RosterOptions {
  /** Page size, default 500, capped at 5000. */
  limit?: number;
  /**
   * Opaque cursor from a previous page's nextCursor
   * (`${firstSeenAtIso}|${usernameLower}`; bare ISO accepted for legacy).
   */
  cursor?: string;
}

/** Cheap roster summary — computed by a single SQL aggregate. */
export interface RosterStats {
  /** Current roster size (same value as RosterPage.total). */
  total: number;
  /** Most recent firstSeenAt across the roster (RosterPage.lastUpdatedAt). */
  lastUpdatedAt: string | null;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  const truncated = Math.floor(limit);
  if (truncated > MAX_LIMIT) return MAX_LIMIT;
  return truncated;
}

interface ParsedCursor {
  firstSeen: Date;
  /** Lowercased username of the last returned row; null for legacy cursors. */
  usernameLower: string | null;
}

/**
 * Cursors are `${iso}|${usernameLower}`. ISO timestamps never contain `|`
 * and IG usernames cannot either, so splitting on the first `|` is safe.
 * A bare ISO string (legacy cursor) yields usernameLower = null.
 */
function parseCursor(cursor: string | undefined): ParsedCursor | null {
  if (!cursor) return null;
  const sep = cursor.indexOf("|");
  const isoPart = sep === -1 ? cursor : cursor.slice(0, sep);
  const ms = Date.parse(isoPart);
  if (Number.isNaN(ms)) return null;
  return {
    firstSeen: new Date(ms),
    usernameLower: sep === -1 ? null : cursor.slice(sep + 1),
  };
}

/** node-postgres returns { rows }, some drivers return the array directly. */
function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result as Array<Record<string, unknown>>;
  }
  return (
    (result as { rows?: Array<Record<string, unknown>> }).rows ?? []
  );
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ── Shared SQL fragments ────────────────────────────────────────────────────
//
// The followers and following dimensions read different tables/columns, so
// each builder assembles its own statement from these per-kind fragments.

interface RosterSqlConfig {
  /** CTEs `lu` (latest unfollow) and `entries` (current roster skeleton). */
  entriesCte: (trackedAccountId: string) => SQL;
  /** Display-field enrichment join over the page usernames. */
  enrichedCte: (trackedAccountId: string) => SQL;
  /** Columns the enriched CTE exposes besides u/first_seen/username. */
  enrichedSelect: SQL;
}

const followersSql: RosterSqlConfig = {
  entriesCte: (trackedAccountId) => sql`
    lu AS (
      SELECT lower(unfollower_username) AS u, max(detected_at) AS t
      FROM follower_unfollow_events
      WHERE tracked_account_id = ${trackedAccountId}
      GROUP BY 1
    ),
    entries AS (
      -- date_trunc to ms: detected_at carries microseconds (defaultNow()),
      -- but cursors/ISO output are ms-precision. Truncating here makes the
      -- cursor round-trip exact and matches the old JS (driver-truncated)
      -- ordering semantics.
      SELECT lower(fe.follower_username) AS u,
             date_trunc('milliseconds', min(fe.detected_at)) AS first_seen
      FROM follower_events fe
      LEFT JOIN lu ON lu.u = lower(fe.follower_username)
      WHERE fe.tracked_account_id = ${trackedAccountId}
        AND (lu.t IS NULL OR fe.detected_at > lu.t)
      GROUP BY 1
    )`,
  enrichedCte: (trackedAccountId) => sql`
    enriched AS (
      SELECT
        p.u,
        p.first_seen,
        (array_agg(fe.follower_username ORDER BY fe.detected_at ASC, fe.id ASC))[1]
          AS username,
        (array_agg(NULLIF(fe.follower_display_name, '')
            ORDER BY fe.detected_at DESC, fe.id DESC)
          FILTER (WHERE NULLIF(fe.follower_display_name, '') IS NOT NULL))[1]
          AS display_name,
        (array_agg(NULLIF(fe.follower_ig_user_id, '')
            ORDER BY fe.detected_at DESC, fe.id DESC)
          FILTER (WHERE NULLIF(fe.follower_ig_user_id, '') IS NOT NULL))[1]
          AS ig_user_id,
        (array_agg(NULLIF(fe.follower_pfp_url, '')
            ORDER BY fe.detected_at DESC, fe.id DESC)
          FILTER (WHERE NULLIF(fe.follower_pfp_url, '') IS NOT NULL))[1]
          AS pfp_url
      FROM page p
      JOIN follower_events fe
        ON fe.tracked_account_id = ${trackedAccountId}
       AND lower(fe.follower_username) = p.u
       AND fe.detected_at >= p.first_seen
      GROUP BY p.u, p.first_seen
    )`,
  enrichedSelect: sql`e.display_name, e.ig_user_id, e.pfp_url`,
};

const followingSql: RosterSqlConfig = {
  entriesCte: (trackedAccountId) => sql`
    lu AS (
      SELECT lower(unfollowed_username) AS u, max(detected_at) AS t
      FROM unfollow_events
      WHERE tracked_account_id = ${trackedAccountId}
      GROUP BY 1
    ),
    entries AS (
      -- See followersSql.entriesCte for the date_trunc rationale.
      SELECT lower(fe.followed_username) AS u,
             date_trunc('milliseconds', min(fe.detected_at)) AS first_seen
      FROM follow_events fe
      LEFT JOIN lu ON lu.u = lower(fe.followed_username)
      WHERE fe.tracked_account_id = ${trackedAccountId}
        AND (lu.t IS NULL OR fe.detected_at > lu.t)
      GROUP BY 1
    )`,
  enrichedCte: (trackedAccountId) => sql`
    enriched AS (
      SELECT
        p.u,
        p.first_seen,
        (array_agg(fe.followed_username ORDER BY fe.detected_at ASC, fe.id ASC))[1]
          AS username,
        (array_agg(NULLIF(fe.followed_display_name, '')
            ORDER BY fe.detected_at DESC, fe.id DESC)
          FILTER (WHERE NULLIF(fe.followed_display_name, '') IS NOT NULL))[1]
          AS display_name
      FROM page p
      JOIN follow_events fe
        ON fe.tracked_account_id = ${trackedAccountId}
       AND lower(fe.followed_username) = p.u
       AND fe.detected_at >= p.first_seen
      GROUP BY p.u, p.first_seen
    )`,
  enrichedSelect: sql`e.display_name`,
};

// ── Roster-backed fragments (migration 0029) ────────────────────────────────
//
// The two configs above reconstruct the roster from the event log. That is the
// bug this replaces: the log was being used as mutable state, so a
// differently-paginated read looked like mass activity (@example_account showed
// 860 follows / 859 unfollows in a week while steadily following 215).
//
// roster_members holds the roster directly, so `entries` is a plain filtered
// read and enrichment is a lookup on the same row — no aggregation, no
// latest-follow-vs-latest-unfollow reasoning, and no way for a read to rewrite
// its own baseline.
//
// The display fields are read from roster_members rather than joined back out
// of the event tables on purpose: a silently-seeded member has no event row, so
// an event-sourced enrichment join would return an empty roster.
function rosterBackedSql(
  dimension: "following" | "follower",
  enrichedSelect: SQL,
): RosterSqlConfig {
  return {
    entriesCte: (trackedAccountId) => sql`
      entries AS (
        -- date_trunc to ms keeps cursor round-trips exact (see followersSql).
        SELECT username_lower AS u,
               date_trunc('milliseconds', first_seen_at) AS first_seen
        FROM roster_members
        WHERE tracked_account_id = ${trackedAccountId}
          AND dimension = ${dimension}
          AND is_current
      )`,
    enrichedCte: (trackedAccountId) => sql`
      enriched AS (
        SELECT p.u, p.first_seen, rm.username, rm.display_name,
               rm.ig_user_id, rm.pfp_url
        FROM page p
        JOIN roster_members rm
          ON rm.tracked_account_id = ${trackedAccountId}
         AND rm.dimension = ${dimension}
         AND rm.username_lower = p.u
      )`,
    enrichedSelect,
  };
}

const followersRosterSql = rosterBackedSql(
  "follower",
  sql`e.display_name, e.ig_user_id, e.pfp_url`,
);
const followingRosterSql = rosterBackedSql(
  "following",
  sql`e.display_name, e.ig_user_id, e.pfp_url`,
);

/**
 * Does this (account, dimension) have a materialized baseline we can serve?
 *
 * Rollout safety, and why this checks settled_at rather than seeded_at: the
 * `seeded_at` means at least one completeness-gated read has been absorbed into
 * roster_members. It is safe to SERVE that union immediately while labeling it
 * syncing/partial; `settled_at` is still required before we TRUST absence and
 * emit follow/unfollow activity. Keeping those decisions separate matters:
 * the legacy event log can be empty or badly polluted by pagination churn, so
 * falling back to it until settle hid 900 imported tracked_user_1 rows and showed
 * only 118 of the canary account's 675 held followers.
 *
 * Accounts without even a seeded baseline still use the legacy fragments for
 * rollout compatibility. Remove that fallback once every active account has a
 * roster_sync_state seed.
 */
async function hasMaterializedBaseline(
  trackedAccountId: string,
  dimension: "following" | "follower",
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM roster_sync_state
    WHERE tracked_account_id = ${trackedAccountId}
      AND dimension = ${dimension}
      AND seeded_at IS NOT NULL
    LIMIT 1
  `);
  return resultRows(result).length > 0;
}

async function configFor(
  trackedAccountId: string,
  dimension: "following" | "follower",
): Promise<RosterSqlConfig> {
  const seeded = await hasMaterializedBaseline(trackedAccountId, dimension);
  if (dimension === "follower") {
    return seeded ? followersRosterSql : followersSql;
  }
  return seeded ? followingRosterSql : followingSql;
}

// ── Stats (count) queries ───────────────────────────────────────────────────

async function fetchRosterStats(
  config: RosterSqlConfig,
  trackedAccountId: string,
): Promise<RosterStats> {
  const result = await db.execute(sql`
    WITH ${config.entriesCte(trackedAccountId)}
    SELECT count(*)::int AS total, max(first_seen) AS last_updated_at
    FROM entries
  `);
  const rows = resultRows(result);
  return {
    total: Number(rows[0]?.total ?? 0),
    lastUpdatedAt: toIsoOrNull(rows[0]?.last_updated_at),
  };
}

/** Current followers-roster size + freshness without materializing rows. */
export async function getFollowersRosterStats(
  trackedAccountId: string,
): Promise<RosterStats> {
  return fetchRosterStats(
    await configFor(trackedAccountId, "follower"),
    trackedAccountId,
  );
}

/** Current following-roster size + freshness without materializing rows. */
export async function getFollowingRosterStats(
  trackedAccountId: string,
): Promise<RosterStats> {
  return fetchRosterStats(
    await configFor(trackedAccountId, "following"),
    trackedAccountId,
  );
}

// ── Paged roster queries ────────────────────────────────────────────────────
//
// Single statement: `entries` is computed once and reused by both `stats`
// (total / lastUpdatedAt ignore the cursor, matching the old JS behavior)
// and `page`. The `stats LEFT JOIN enriched` shape guarantees at least one
// row comes back so the totals survive an empty page.

interface RawPageRow {
  total: number;
  lastUpdatedAt: string | null;
  /** Lowercased username (entries key) — used to build the next cursor. */
  usernameLower: string | null;
  username: string | null;
  displayName: string | null;
  igUserId: string | null;
  pfpUrl: string | null;
  firstSeenAt: string | null;
}

function buildCursorFilter(cursor: ParsedCursor | null): SQL {
  if (!cursor) return sql``;
  if (cursor.usernameLower === null) {
    // Legacy bare-ISO cursor: old strict-< semantics (drops timestamp ties).
    return sql`WHERE first_seen < ${cursor.firstSeen}`;
  }
  // Composite cursor: resume exactly after (first_seen DESC, u ASC).
  return sql`WHERE (
    first_seen < ${cursor.firstSeen}
    OR (first_seen = ${cursor.firstSeen} AND u > ${cursor.usernameLower})
  )`;
}

async function fetchRosterPage(
  config: RosterSqlConfig,
  trackedAccountId: string,
  options?: RosterOptions,
): Promise<{ limit: number; rows: RawPageRow[] }> {
  const limit = normalizeLimit(options?.limit);
  const cursorFilter = buildCursorFilter(parseCursor(options?.cursor));

  const result = await db.execute(sql`
    WITH ${config.entriesCte(trackedAccountId)},
    stats AS (
      SELECT count(*)::int AS total, max(first_seen) AS last_updated_at
      FROM entries
    ),
    page AS (
      SELECT u, first_seen
      FROM entries
      ${cursorFilter}
      ORDER BY first_seen DESC, u ASC
      LIMIT ${limit}
    ),
    ${config.enrichedCte(trackedAccountId)}
    SELECT
      s.total,
      s.last_updated_at,
      e.u,
      e.first_seen,
      e.username,
      ${config.enrichedSelect}
    FROM stats s
    LEFT JOIN enriched e ON true
    ORDER BY e.first_seen DESC, e.u ASC
  `);

  const rows = resultRows(result).map((row): RawPageRow => ({
    total: Number(row.total ?? 0),
    lastUpdatedAt: toIsoOrNull(row.last_updated_at),
    usernameLower: toStringOrNull(row.u),
    username: toStringOrNull(row.username),
    displayName: toStringOrNull(row.display_name),
    igUserId: toStringOrNull(row.ig_user_id),
    pfpUrl: toStringOrNull(row.pfp_url),
    firstSeenAt: toIsoOrNull(row.first_seen),
  }));

  return { limit, rows };
}

function assemblePage(
  limit: number,
  rows: RawPageRow[],
  toEntry: (row: RawPageRow, firstSeenAt: string) => RosterEntry,
): RosterPage {
  const items: RosterEntry[] = [];
  let lastRow: RawPageRow | null = null;
  for (const row of rows) {
    // The empty-page sentinel row carries stats only (username is NULL).
    if (row.username === null || row.firstSeenAt === null) continue;
    items.push(toEntry(row, row.firstSeenAt));
    lastRow = row;
  }

  const nextCursor =
    items.length === limit && lastRow !== null
      ? `${lastRow.firstSeenAt}|${lastRow.usernameLower ?? ""}`
      : null;

  return {
    items,
    nextCursor,
    total: rows[0]?.total ?? 0,
    lastUpdatedAt: rows[0]?.lastUpdatedAt ?? null,
  };
}

// ── Followers roster ────────────────────────────────────────────────────────

export async function buildFollowersRoster(
  trackedAccountId: string,
  options?: RosterOptions,
): Promise<RosterPage> {
  const { limit, rows } = await fetchRosterPage(
    await configFor(trackedAccountId, "follower"),
    trackedAccountId,
    options,
  );
  return assemblePage(limit, rows, (row, firstSeenAt) => ({
    username: row.username as string,
    displayName: row.displayName,
    igUserId: row.igUserId,
    pfpUrl: row.pfpUrl,
    firstSeenAt,
  }));
}

// ── Following roster ────────────────────────────────────────────────────────

export async function buildFollowingRoster(
  trackedAccountId: string,
  options?: RosterOptions,
): Promise<RosterPage> {
  const { limit, rows } = await fetchRosterPage(
    await configFor(trackedAccountId, "following"),
    trackedAccountId,
    options,
  );
  return assemblePage(limit, rows, (row, firstSeenAt) => ({
    username: row.username as string,
    displayName: row.displayName,
    ...(row.igUserId ? { igUserId: row.igUserId } : {}),
    ...(row.pfpUrl ? { pfpUrl: row.pfpUrl } : {}),
    firstSeenAt,
  }));
}

// ── Unfollow trust ──────────────────────────────────────────────────────────

const unfollowTrustCompleteness = 0.9;

/**
 * Whether the FOLLOWING roster is complete enough that a member's departure
 * can be reported as a real unfollow. Shared by the viewer, the feed, and the
 * report/CSV builders so every surface answers the same way.
 */
export function isUnfollowRosterTrusted(
  loadedTotal: number,
  expectedTotal: number | null | undefined,
  lastGraphRefreshAt?: Date | string | null,
  baselineSettled?: boolean,
): boolean {
  // Migration 0029 intentionally did not backfill from the corrupted legacy
  // event-derived roster. Old refresh anchors therefore cannot make the new
  // baseline trustworthy; only roster_sync_state.settled_at can.
  if (baselineSettled === false) return false;
  if (expectedTotal === null || expectedTotal === undefined) return true;
  if (expectedTotal === 0) return loadedTotal === 0;
  // Trust unfollow detection once a full enumeration has COMPLETED, not only at
  // 90% of IG's reported count. IG's number is inflated by ghost/deactivated/
  // private followers that never appear in any enumeration, so large accounts
  // whose reachable set is < 90% of that inflated total would otherwise stay
  // paused forever. computeRosterSyncState returns "complete"/"capped" only when
  // the walk exhausted the cursor (below the enumeration cap = we hold every
  // reachable follower), which is exactly when the diff is safe to trust.
  const syncState = computeRosterSyncState({
    loadedTotal,
    reportedTotal: expectedTotal,
    lastGraphRefreshAt,
    baselineSettled,
  });
  if (syncState === "complete" || syncState === "capped") return true;
  return loadedTotal / expectedTotal >= unfollowTrustCompleteness;
}

// ── Follow-activity gates ───────────────────────────────────────────────────
//
// follow_events / unfollow_events also record roster DISCOVERY, so the raw log
// is not activity. Two gates make it so, and every customer-facing surface
// (viewer, feed, report, CSV) must apply BOTH the same way:
//   boundary        — only events after the roster provably settled are real.
//   unfollowsTrusted — departures are reported only once the held roster is
//                      complete enough to vouch for them.

export interface FollowActivityFilters {
  readonly boundary: Date | null;
  readonly unfollowsTrusted: boolean;
}

export interface FollowActivityInputs {
  readonly trackingStarted?: Date;
  readonly followingFirstCompleteAt: Date | null | undefined;
  readonly lastFollowingRefreshAt: Date | string | null | undefined;
  readonly rosterSettled: boolean;
  readonly rosterSettledAt: Date | null;
  readonly rosterTotal: number;
  readonly snapshotFollowingCount: number | null | undefined;
}

/**
 * Only activity after the materialized roster settled is provable;
 * `followingFirstCompleteAt` predates the roster rewrite on older accounts and
 * admitted historical pagination noise (the canary account's false follows/unfollows), so
 * the LATER of the two anchors is the boundary. No anchor → no boundary → no
 * follow activity is shown rather than passing discovery noise off as real.
 */
export function followActivityBoundary(
  followingFirstCompleteAt: Date | null | undefined,
  rosterSettledAt: Date | null | undefined,
): Date | null {
  return (
    [followingFirstCompleteAt, rosterSettledAt]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
  );
}

/**
 * Pure construction of both gates from already-loaded inputs — the viewer has
 * every input in hand for its own output and must not re-query.
 */
export function deriveFollowActivityFilters(
  inputs: FollowActivityInputs,
): FollowActivityFilters {
  const settledBoundary = followActivityBoundary(inputs.followingFirstCompleteAt, inputs.rosterSettledAt);
  const boundary = settledBoundary ? followActivityBoundary(settledBoundary, inputs.trackingStarted) : null;
  // Following-derived unfollows key off the FOLLOWING anchor only — never the
  // shared both-rosters anchor (see migration 0025).
  const unfollowsTrusted = isUnfollowRosterTrusted(
    inputs.rosterTotal,
    inputs.snapshotFollowingCount,
    inputs.lastFollowingRefreshAt,
    inputs.rosterSettled,
  );
  return { boundary, unfollowsTrusted };
}

/**
 * The gates for one tracked row, loaded exactly as the viewer loads them.
 * Roster state is read from the canonical twin (the row that holds the
 * roster); the account anchors and the profile snapshot stay per-row.
 */
export async function followActivityFilters(
  trackedAccountId: string,
): Promise<FollowActivityFilters> {
  const rosterAccountId = await canonicalTwinId(trackedAccountId);
  const [[account], [snapshot], health, stats] = await Promise.all([
    db
      .select({
        followingFirstCompleteAt: trackedAccounts.followingFirstCompleteAt,
        lastFollowingRefreshAt: trackedAccounts.lastFollowingRefreshAt,
        trackingStarted: trackedAccounts.trackingStarted,
      })
      .from(trackedAccounts)
      .where(eq(trackedAccounts.id, trackedAccountId))
      .limit(1),
    db
      .select({ followingCount: profileSnapshots.followingCount })
      .from(profileSnapshots)
      .where(eq(profileSnapshots.trackedAccountId, trackedAccountId))
      .orderBy(desc(profileSnapshots.snapshotAt))
      .limit(1),
    getRosterSyncHealth(rosterAccountId, "following"),
    getFollowingRosterStats(rosterAccountId),
  ]);
  return deriveFollowActivityFilters({
    trackingStarted: account?.trackingStarted,
    followingFirstCompleteAt: account?.followingFirstCompleteAt,
    lastFollowingRefreshAt: account?.lastFollowingRefreshAt,
    rosterSettled: health.settled,
    rosterSettledAt: health.settledAt,
    rosterTotal: stats.total,
    snapshotFollowingCount: snapshot?.followingCount,
  });
}

// ── Follow flip-flop suppression ────────────────────────────────────────────
//
// A "follow" that lands within days of an "unfollow" of the same username is
// pagination churn, not activity: the member fell out of one enumeration and
// came back in the next. @tracked_user_1: 20 of 89 follow_events had an unfollow of
// the same username inside the prior 14 days.

const DEFAULT_FLIPFLOP_WINDOW_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days from FOLLOW_FLIPFLOP_WINDOW_DAYS (default 14); non-negative integer. */
export function followFlipFlopWindowDays(): number {
  const raw = process.env.FOLLOW_FLIPFLOP_WINDOW_DAYS;
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FLIPFLOP_WINDOW_DAYS;
  return Math.floor(parsed);
}

/**
 * True when a follow detected at `followDetectedAt` is preceded by an unfollow
 * of the same account at `priorUnfollowAt` no more than `windowMs` earlier.
 * An unfollow AFTER the follow is a different story (a real unfollow) and does
 * not suppress it.
 */
export function isFlipFlopFollow(
  followDetectedAt: Date,
  priorUnfollowAt: Date | null,
  windowMs: number,
): boolean {
  if (!(priorUnfollowAt instanceof Date)) return false;
  const gap = followDetectedAt.getTime() - priorUnfollowAt.getTime();
  return gap >= 0 && gap <= windowMs;
}

export interface VisibleFollowEventsParams {
  /** The row whose follow_events are being read (per-row, never unioned). */
  readonly trackedAccountId: string;
  /** The canonical twin holding roster_members for this IG user. */
  readonly rosterAccountId: string;
  readonly boundary: Date | null;
}

/**
 * WHERE for follow_events that count as real activity for a row: after the
 * boundary (none → nothing), not a flip-flop of an unfollow_events row for the
 * same `(tracked_account_id, lower(username))` in the prior window, and not
 * contradicted by a roster_members row that says the account is no longer
 * followed. SQL twin of `isFlipFlopFollow`.
 */
export function visibleFollowEventsSql(params: VisibleFollowEventsParams): SQL {
  // Validated integer, so it is safe to inline as an interval literal.
  const windowDays = sql.raw(String(followFlipFlopWindowDays()));
  return and(
    // Lesson 13/C1: follow_events are written for the canonical twin only (the
    // non-canonical row skips its roster walks), so the read must key on the
    // roster row too. The tracking-start boundary below stays per requesting row.
    eq(followEvents.trackedAccountId, params.rosterAccountId),
    params.boundary ? gt(followEvents.detectedAt, params.boundary) : sql`false`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${unfollowEvents} ue
      WHERE ue.tracked_account_id = ${followEvents.trackedAccountId}
        AND lower(ue.unfollowed_username) = lower(${followEvents.followedUsername})
        AND ue.detected_at <= ${followEvents.detectedAt}
        AND ue.detected_at >= ${followEvents.detectedAt} - interval '1 day' * ${windowDays}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${rosterMembers} rm
      WHERE rm.tracked_account_id = ${params.rosterAccountId}
        AND rm.dimension = 'following'
        AND rm.username_lower = lower(${followEvents.followedUsername})
        AND rm.is_current = false
    )`,
  ) as SQL;
}

/** Real follows for a row inside [start, end) or [start, end] (inclusiveEnd). */
export async function countVisibleFollowEvents(
  params: VisibleFollowEventsParams,
  start: Date,
  end: Date,
  inclusiveEnd = false,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(followEvents)
    .where(
      and(
        visibleFollowEventsSql(params),
        gte(followEvents.detectedAt, start),
        inclusiveEnd ? lte(followEvents.detectedAt, end) : lt(followEvents.detectedAt, end),
      ),
    );
  return row?.n ?? 0;
}

// ── Roster departures (the customer-facing "unfollowed accounts") ───────────
//
// Served from roster_members (is_current=false), never the unfollow_events log:
// the log keeps false positives for accounts that later reappeared, while a
// roster row with is_current=false cannot be a still-followed account.

export interface RosterDeparture {
  readonly username: string;
  readonly displayName: string | null;
  readonly leftAt: Date;
}

export interface RosterDeparturesParams {
  readonly rosterAccountId: string;
  readonly unfollowsTrusted: boolean;
  readonly start: Date;
  readonly end: Date;
  readonly inclusiveEnd?: boolean;
}

/** The same confirmed following departures for feed, viewer and aggregates. */
export function visibleRosterDeparturesSql(rosterAccountId: string, boundary: Date | null): SQL {
  return and(
    eq(rosterMembers.trackedAccountId, rosterAccountId),
    eq(rosterMembers.dimension, "following"),
    eq(rosterMembers.isCurrent, false),
    boundary ? gt(rosterMembers.leftAt, boundary) : sql`false`,
  ) as SQL;
}

/** A returned follower or an unconfirmed/pre-settlement absence is not lost. */
export function visibleFollowerUnfollowsSql(rosterAccountId: string, trackingStarted: Date): SQL {
  return and(
    eq(followerUnfollowEvents.trackedAccountId, rosterAccountId),
    gte(followerUnfollowEvents.detectedAt, trackingStarted),
    sql`EXISTS (SELECT 1 FROM roster_sync_state s WHERE s.tracked_account_id=${rosterAccountId}
      AND s.dimension='follower' AND s.settled_at IS NOT NULL
      AND ${followerUnfollowEvents.detectedAt}>s.settled_at)`,
    sql`EXISTS (SELECT 1 FROM roster_members r WHERE r.tracked_account_id=${rosterAccountId}
      AND r.dimension='follower' AND r.username_lower=lower(${followerUnfollowEvents.unfollowerUsername})
      AND r.is_current=false)`,
  ) as SQL;
}

function departureWindowSql(params: RosterDeparturesParams): SQL {
  return and(
    eq(rosterMembers.trackedAccountId, params.rosterAccountId),
    eq(rosterMembers.dimension, "following"),
    eq(rosterMembers.isCurrent, false),
    gte(rosterMembers.leftAt, params.start),
    params.inclusiveEnd
      ? lte(rosterMembers.leftAt, params.end)
      : lt(rosterMembers.leftAt, params.end),
  ) as SQL;
}

/** Departures in the window, newest first; empty until the roster is trusted. */
export async function listRosterDepartures(
  params: RosterDeparturesParams,
): Promise<RosterDeparture[]> {
  if (!params.unfollowsTrusted) return [];
  const rows = await db
    .select({
      username: rosterMembers.username,
      displayName: rosterMembers.displayName,
      leftAt: rosterMembers.leftAt,
    })
    .from(rosterMembers)
    .where(departureWindowSql(params))
    .orderBy(desc(rosterMembers.leftAt));
  return rows.flatMap((r) =>
    r.leftAt instanceof Date
      ? [{ username: r.username, displayName: r.displayName, leftAt: r.leftAt }]
      : [],
  );
}

/** Count of departures in the window; 0 until the roster is trusted. */
export async function countRosterDepartures(
  params: RosterDeparturesParams,
): Promise<number> {
  if (!params.unfollowsTrusted) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rosterMembers)
    .where(departureWindowSql(params));
  return row?.n ?? 0;
}
