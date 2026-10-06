import { collectionCompletion, partialCollectionNeedsRetry } from "./services/collection-completion.js";
import { trackedAccountHasAccess, customerHasAccess, customerAccessSql } from "./services/subscription-access.js";
import { reconcilePrivateAccessCollections } from "./services/private-access-collection.js";
import { reconcilePrivateFollowCoverage } from "./services/private-follow-coverage.js";
import { privateFollowRequestCanProbe } from "./services/private-account-access.js";
import { enqueuePrivateCooldownRetry } from "./services/private-cooldown-retry.js";
import { enqueuePublicPostsCapacityRetry, publicPostsPoolUnavailable } from "./services/public-posts-capacity-retry.js";
import { OperationBusyError, withOperationLease } from "./services/operation-lease.js";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { db } from "./db.js";
import { flushTransactionalEmails, recordDueTrialEndingEmails, recordReportEmail } from "./services/transactional-emails.js";
import { persistReadyReport, scheduledWeeklyWindow, scheduledReportId, type ReadyReportStats } from "./services/report-delivery.js";
import {
  trackedAccounts,
  collectionJobs,
  reports,
  botAccounts,
  botFollowRequests,
  profileSnapshots,
  postsCache,
  likersCache,
  likeEvents,
  followerEvents,
  likeEvidencePostChecks,
  followerUnfollowEvents,
  notifications,
  users,
} from "../shared/schema.js";
import { eq, and, inArray, desc, isNotNull, lt, sql, gte, lte, count } from "drizzle-orm";
import { collectPublicData } from "./services/public-data-collector.js";
import {
  getPostLikers,
  getPublicProfile,
  getUserPosts,
} from "./services/public-data-service.js";
import {
  assignBotToTrackedAccount,
  markFollowRequestAccepted,
  markFollowRequestFailed,
  markFollowRequestExpired,
  getPendingFollowRequests,
  cancelIneligibleFollowRequests,
  getExpiredFollowRequests,
  rotateBotForTrackedAccount,
} from "./bot-manager.js";
import { createBotCollectors } from "./bot-collectors.js";
import {
  createHttpBotClient,
  IGRateLimitedError,
} from "./ig-http-client.js";
import { IGCircuitOpenError } from "./domain/ig-client-port.js";
import { transitionFollowRequest } from "./domain/follow-request-state.js";
import { scrapeProfile, scrapeProfileWithBot, scrapeFriendshipStatusWithBot, probePinnedBotCooldown, selectCooldownProbeCandidate } from "./ig-public-scraper.js";
import { ensureBotReady } from "./services/bot-runtime.js";
import { COOLDOWN_REASON_PREFIX } from "./services/bot-cooldown.js";
import { KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX } from "./services/proxy-durability.js";

// ─── Bot collectors (Wave 2 DI-wired singleton) ─────────────────────────────
// Workers do not import transport internals; they receive the port-based
// collectors via this module-level singleton, so transport is swappable.
const botCollectors = createBotCollectors({
  createClient: createHttpBotClient,
});
const {
  sendFollowForRequest,
} = botCollectors;
import { logger, withCorrelation } from "./observability/logger.js";
import { pruneOldEvents } from "./workers/retention-worker.js";
import {
  getBotWarmerQueue,
  startBotWarmerWorker,
} from "./workers/bot-warmer-worker.js";
import { startLikedBySquadWorker } from "./workers/liked-by-squad-worker.js";
import { getBackgroundRosterQueue, startBackgroundRosterWorker } from "./workers/roster-background-worker.js";
import {
  ACCOUNT_REFRESH_JOB_NAME,
  reconcileAccountRefreshes,
} from "./workers/account-refresh-registrar.js";
import { mediaCacheQueue, processMediaCacheUrl } from "./services/media-cache-jobs.js";
import { startBandwidthMeter, withScrapeContext } from "./services/bandwidth-meter.js";
import { initRefreshConfig } from "./services/refresh-config.js";
import {
  sweepLikes,
  readLikesSweepMs,
  computeSweepBootDelayMs,
} from "./workers/likes-sweeper.js";
import { runReloginSweep, readReloginSweepMs } from "./workers/relogin-sweeper.js";
import { canonicalTwinId, twinTrackedAccountIds } from "./services/tracked-account-twins.js";
import { isShuttingDown } from "./services/shutdown-state.js";
import { reconcileStaleCollectionJobs, reconcileStaleGeneratingReports } from "./services/collection-job-reconciler.js";
import { runRecoverySweep, recoveryStatus } from "./services/recovery-watchdog.js";
import {
  resolveOwnerProfileFromCache,
  recordOwnerProfileVerdict,
  OWNER_PROFILE_TTL_HOURS,
} from "./services/owner-profile-cache.js";
import {
  buildFollowersRoster,
  buildFollowingRoster,
} from "./services/roster.js";
import {
  isLikedPostAfterTrackingStart,
  likedPostAfterTrackingStart,
} from "./services/like-event-policy.js";
import { createNotification } from "./services/notifications.js";
import { isCapacityUnavailable, shouldReadLikeCandidate } from "./services/scan-efficiency.js";
import { targetCanaryEnabled } from "./services/viewer-affinity.js";

// ─── Redis connection ─────────────────────────────────────────────────────────

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

function createRedisConnection(): IORedis {
  const conn = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  conn.on("error", (err) => logger.error({ module: "redis", err: err.message }, "redis error"));
  return conn;
}

const connection = createRedisConnection();

const LIKE_EVIDENCE_FOLLOWING_SCAN_LIMIT = Math.max(
  0,
  Math.min(Number(process.env.LIKE_EVIDENCE_FOLLOWING_SCAN_LIMIT ?? "6"), 20),
);
const LIKE_EVIDENCE_POSTS_PER_OWNER = Math.max(
  1,
  Math.min(Number(process.env.LIKE_EVIDENCE_POSTS_PER_OWNER ?? "2"), 6),
);
const LIKE_EVIDENCE_OWNER_DELAY_MS = Math.max(
  0,
  Math.min(Number(process.env.LIKE_EVIDENCE_OWNER_DELAY_MS ?? "1500"), 10_000),
);
// Liker-list VISIBILITY ceiling. IG returns only the most-recent slice of a
// post's likers (~100-300), so on a post with thousands of likes the tracked
// user is almost never inside the visible slice — the read burns one of the
// bot's scarce daily likers calls for near-zero detection odds. Measured on
// this pool: 92% of scanned posts had >1000 likes, which is why like_events
// flatlined at ~1-3/day even with the endpoint working. We therefore prefer
// the LEAST-liked recent posts of each owner (fully visible lists, and the
// small/friend accounts a user actually engages with) and skip anything above
// this ceiling. 0 disables the filter. Clamped to [0, 100000].
// Only scan RECENT posts. A user's NEW likes land on posts published in the
// last couple of days; scanning month-old posts spends the scarce (and
// ban-expensive) likers budget on activity that is not new. 0 disables.
const LIKE_EVIDENCE_MAX_POST_AGE_HOURS = Math.max(
  0,
  Math.min(Number(process.env.LIKE_EVIDENCE_MAX_POST_AGE_HOURS ?? "96"), 720),
);
const LIKE_EVIDENCE_MAX_POST_LIKES = Math.max(
  0,
  Math.min(Number(process.env.LIKE_EVIDENCE_MAX_POST_LIKES ?? "1500"), 100_000),
);
// How many recent posts to pull per owner as CANDIDATES before picking the
// least-liked LIKE_EVIDENCE_POSTS_PER_OWNER of them. One posts call returns the
// whole page, so a wider candidate set costs nothing extra on the posts budget.
// Liked-post detection scans a rotating window of the accounts a tracked user
// FOLLOWS. A FIXED window size silently punishes large rosters: at 10 owners a
// cycle, a 225-following account completes a full pass in 23 cycles (58 likes
// detected) while a 1,463-following account needs 147 (zero likes detected).
// The scan was not broken for those users — it simply never came back around to
// the owners they actually engage with.
//
// So size the window to the roster instead: aim for a full pass every
// LIKE_EVIDENCE_TARGET_PASS_CYCLES regardless of how many accounts they follow.
// Bounded at both ends — the floor keeps small rosters cheap, and the ceiling
// protects the shared (ban-prone) likers budget from one huge roster.
// This applies automatically to every account, including ones added later.
// Hard wall-clock budget for one like-evidence scan.
//
// The cursor is only persisted AFTER the owner loop finishes, so a job that
// never finishes freezes that account's rotation forever: it re-scans the same
// window on every cycle and never reaches the rest of the roster.
// @sample_account sat on cursor 78/216 for days for exactly this reason — it
// has ~2x the owners of comparable accounts and each failing owner burns retries
// with backoff sleeps inside the fetch, so the job simply never returned.
//
// With a budget the scan stops cleanly, persists the owners it actually
// completed, and the next cycle continues from there. Forward progress is
// guaranteed even when a roster is full of dead or rate-limited owners.
const LIKE_EVIDENCE_MAX_SCAN_MS = Math.max(
  30_000,
  Math.min(Number(process.env.LIKE_EVIDENCE_MAX_SCAN_MS ?? "240000"), 1_800_000),
);

const LIKE_EVIDENCE_TARGET_PASS_CYCLES = Math.max(
  1,
  Math.min(Number(process.env.LIKE_EVIDENCE_TARGET_PASS_CYCLES ?? "48"), 500),
);
const LIKE_EVIDENCE_MAX_SCAN_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.LIKE_EVIDENCE_MAX_SCAN_LIMIT ?? "25"), 100),
);

/**
 * Owners to scan this cycle for a roster of `rosterSize`, so a full pass takes
 * roughly LIKE_EVIDENCE_TARGET_PASS_CYCLES cycles whatever the roster size.
 * Never below the configured base (small rosters stay cheap and predictable).
 */
export function resolveLikeEvidenceScanLimit(rosterSize: number): number {
  if (LIKE_EVIDENCE_FOLLOWING_SCAN_LIMIT <= 0) return 0;
  const proportional = Math.ceil(
    Math.max(0, rosterSize) / LIKE_EVIDENCE_TARGET_PASS_CYCLES,
  );
  return Math.min(
    Math.max(LIKE_EVIDENCE_FOLLOWING_SCAN_LIMIT, proportional),
    LIKE_EVIDENCE_MAX_SCAN_LIMIT,
  );
}

const LIKE_EVIDENCE_POST_CANDIDATES = Math.max(
  6,
  Math.min(Number(process.env.LIKE_EVIDENCE_POST_CANDIDATES ?? "12"), 24),
);

// How long a completed liker read suppresses a re-read of the SAME post.
//
// The scan takes the newest LIKE_EVIDENCE_POSTS_PER_OWNER candidates per owner.
// With no memory of what it had already read, it re-read the same two posts
// every cycle until the owner published something new — spending the scarce,
// ban-expensive liker read to re-confirm a negative, while owners deeper in the
// following list were never reached. Live scans showed postsChecked=3..18 with
// inserted=0, cycle after cycle.
//
// The suppression must EXPIRE, because a liker list keeps growing after
// publication: a post read minutes after it went up can still collect the
// tracked user's like an hour later. 24h is a full re-check per post per day
// while freeing the other ~23 hourly cycles to reach new ground. Set to 0 to
// disable skipping entirely (restores the old re-read-everything behaviour).
const LIKE_EVIDENCE_RECHECK_HOURS = Math.max(
  0,
  Math.min(Number(process.env.LIKE_EVIDENCE_RECHECK_HOURS ?? "24"), 24 * 30),
);

// How long a visit to a followed OWNER keeps that owner out of the like-scan
// window when activity ordering is on (the per-POST memory above is
// LIKE_EVIDENCE_RECHECK_HOURS; this is the per-owner one).
//
// The old rotation applied an absolute cursor to a list that was RE-SORTED
// every cycle by (band, posts_checked_at ASC), so the offset landed on
// different owners each pass: one account made 616 owner visits in a day and
// stamped only 269 distinct owners, while ~3,280 followed owners across the
// fleet had never been visited. With this filter the ordering IS the rotation:
// owners visited inside the window are simply not listed, and the scan takes
// the head of what remains. Default 12h; 0 disables the filter (ordering alone,
// every owner listed every cycle). Clamped to [0, 720]; unparseable → default.
export const LIKE_EVIDENCE_REVISIT_HOURS_DEFAULT = 12;
export function resolveLikeEvidenceRevisitHours(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.LIKE_EVIDENCE_REVISIT_HOURS;
  if (raw === undefined || raw.trim() === "") return LIKE_EVIDENCE_REVISIT_HOURS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return LIKE_EVIDENCE_REVISIT_HOURS_DEFAULT;
  return Math.max(0, Math.min(parsed, 24 * 30));
}
const LIKE_EVIDENCE_REVISIT_HOURS = resolveLikeEvidenceRevisitHours();

// LIKE_EVIDENCE_ACTIVITY_ORDERING=off restores the plain roster order AND the
// absolute-cursor rotation (see selectLikeEvidenceWindow). Read per call so
// tests can flip it; the env is static in production.
export function isLikeEvidenceActivityOrderingOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.LIKE_EVIDENCE_ACTIVITY_ORDERING ?? "on") !== "off";
}

const LIKE_EVIDENCE_ROSTER_PAGE_SIZE = 5_000;
const LIKE_EVIDENCE_ROSTER_MAX_ITEMS = 15_000;

/**
 * Select a wrapping window from a roster and return the persisted next cursor.
 * The prior worker always requested `limit: N` from a newest-first roster, so
 * every run re-scanned the same N owners forever. A stored cursor gives every
 * followed account a turn without increasing per-run Instagram traffic.
 */
export function takeRotatingWindow<T>(
  items: readonly T[],
  cursor: number,
  limit: number,
): { items: T[]; nextCursor: number; start: number } {
  if (items.length === 0 || limit <= 0)
    return { items: [], nextCursor: 0, start: 0 };
  const start = ((Math.trunc(cursor) % items.length) + items.length) % items.length;
  const take = Math.min(Math.trunc(limit), items.length);
  const selected: T[] = [];
  for (let index = 0; index < take; index += 1) {
    selected.push(items[(start + index) % items.length]);
  }
  // `start` is returned so a scan that stops early can persist the owners it
  // ACTUALLY finished rather than claiming the whole window.
  return { items: selected, nextCursor: (start + take) % items.length, start };
}

/**
 * Which mechanism rotates the like-scan through a following roster.
 *
 * - "activity": the roster came from roster_members ordered by (band,
 *   posts_checked_at ASC NULLS FIRST) with owners visited inside
 *   LIKE_EVIDENCE_REVISIT_HOURS already filtered out. The ordering IS the
 *   rotation, so the window is simply the head of the list.
 * - "cursor": plain roster order (LIKE_EVIDENCE_ACTIVITY_ORDERING=off, or no
 *   materialised rows so the roster builder was used). The persisted
 *   like_evidence_cursor is an absolute offset and takeRotatingWindow applies.
 */
export type LikeEvidenceRotation = "activity" | "cursor";

export type LikeEvidenceWindow<T> = {
  items: T[];
  // Both are positions in the roster and only meaningful for "cursor"; the
  // "activity" window always starts at 0 and reports nextCursor 0.
  start: number;
  nextCursor: number;
  rotation: LikeEvidenceRotation;
};

/**
 * Pick this cycle's owners. In "activity" mode the list is already ordered
 * least-recently-visited first and pre-filtered by the revisit window, so a
 * cursor would only re-introduce the bug it replaces (an absolute offset into a
 * list that is re-sorted every cycle lands on different owners each pass).
 */
export function selectLikeEvidenceWindow<T>(
  items: readonly T[],
  cursor: number,
  limit: number,
  rotation: LikeEvidenceRotation,
): LikeEvidenceWindow<T> {
  if (rotation === "cursor") {
    return { ...takeRotatingWindow(items, cursor, limit), rotation };
  }
  const take = Math.max(0, Math.trunc(limit));
  return { items: items.slice(0, take), start: 0, nextCursor: 0, rotation };
}

// like_evidence_cursor is int4. In "activity" mode it is an odometer of owners
// visited, not a position; wrap it long before the column overflows so a
// years-old row can never fail its UPDATE.
export const LIKE_EVIDENCE_ODOMETER_WRAP = 1_000_000_000;

/**
 * The like_evidence_cursor value to persist after an owner loop.
 *
 * "activity": the cursor no longer selects anything (posts_checked_at does), so
 * it becomes an odometer — previous value + owners visited this cycle. That
 * keeps likeEvidenceProgressUpdate's hold-on-outage meaningful ("no progress
 * recorded") and gives the on-call SQL a cheap "is this account's scan moving"
 * signal. If LIKE_EVIDENCE_ACTIVITY_ORDERING is later switched off, the
 * odometer value is harmless: takeRotatingWindow normalises any integer into
 * a roster position.
 *
 * "cursor": unchanged behaviour — the window's nextCursor, or, after an early
 * stop, only past the owners genuinely finished.
 */
export function resolveLikeEvidenceAdvancedCursor(input: {
  rotation: LikeEvidenceRotation;
  currentCursor: number;
  windowStart: number;
  windowNextCursor: number;
  ownersCompleted: number;
  ownersScanned: number;
  stoppedEarly: boolean;
  rosterSize: number;
}): number {
  const current = Number.isFinite(input.currentCursor)
    ? Math.max(0, Math.trunc(input.currentCursor))
    : 0;
  if (input.rotation === "activity") {
    const visited = Math.max(0, Math.trunc(input.ownersScanned));
    const next = current + visited;
    return next >= LIKE_EVIDENCE_ODOMETER_WRAP ? visited : next;
  }
  if (!input.stoppedEarly) return input.windowNextCursor;
  return input.rosterSize > 0
    ? (input.windowStart + input.ownersCompleted) % input.rosterSize
    : current;
}

/**
 * Remember when a followed account last published (migration 0040).
 *
 * The scan already fetched this owner's posts, so recording the newest post
 * date is free. It turns an expensive discovery ("has this dormant account
 * posted yet?") into a cheap ordering decision on the next cycle.
 */
async function recordOwnerPostActivity(
  trackedAccountId: string,
  ownerUsername: string,
  newestPostAt: Date | null,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE roster_members
         SET last_post_at = ${newestPostAt},
             posts_checked_at = NOW()
       WHERE tracked_account_id = ${trackedAccountId}
         AND dimension = 'following'
         AND username_lower = ${ownerUsername.toLowerCase()}
    `);
  } catch {
    // Telemetry only — never fail a scan because the hint could not be stored.
  }
}

/**
 * Stamp owners whose visit failed BEFORE a posts fetch could succeed (profile
 * fetch failed / returned no id, posts fetch failed, or the owner threw) as
 * visited now. Exported for the live SQL check (lesson 22) and tests.
 *
 * Why: "activity" rotation has no cursor to step past a dead owner. An owner
 * whose profile 404s (deleted / renamed account) never gets posts_checked_at,
 * so it sits at the head of the NULLS FIRST band and eats one window slot on
 * EVERY cycle, forever. Stamping only posts_checked_at (last_post_at is left
 * alone) defers the owner by LIKE_EVIDENCE_REVISIT_HOURS like any other visit
 * and drops it into the dormant band until it proves otherwise.
 */
export function buildDeferFailedOwnersSql(
  trackedAccountId: string,
  usernamesLower: readonly string[],
) {
  return sql`
    UPDATE roster_members
       SET posts_checked_at = NOW()
     WHERE tracked_account_id = ${trackedAccountId}
       AND dimension = 'following'
       AND username_lower IN (${sql.join(
         usernamesLower.map((u) => sql`${u}`),
         sql`, `,
       )})
  `;
}

async function deferFailedOwners(
  trackedAccountId: string,
  ownerUsernames: readonly string[],
): Promise<void> {
  const usernamesLower = Array.from(
    new Set(
      ownerUsernames
        .map((u) => u.trim().toLowerCase())
        .filter((u) => u.length > 0),
    ),
  );
  if (usernamesLower.length === 0) return;
  try {
    await db.execute(buildDeferFailedOwnersSql(trackedAccountId, usernamesLower));
  } catch (err) {
    // Telemetry only — a scan must not fail because bookkeeping did — but a
    // broken stamp would let dead owners pin the window, so make it visible.
    logger.warn(
      {
        trackedAccountId,
        owners: usernamesLower.length,
        err: err instanceof Error ? err.message : String(err),
      },
      "[like-evidence] could not defer failed owners; they will lead the next window",
    );
  }
}

/**
 * Owners ordered so the scan meets ACTIVE POSTERS first.
 *
 * A tracked user's new likes can only be on posts that exist, so an owner who
 * has not published in months cannot produce a detection no matter how often we
 * visit them — yet each visit still costs a profile fetch and a posts fetch.
 * Only ~16% of cached posts fall inside the freshness window, so a blind
 * rotation spends most of its budget re-confirming dormancy.
 *
 * Order: recent posters first, then owners we have never checked (unknown could
 * be active), then dormant ones last. LIKE_EVIDENCE_ACTIVITY_ORDERING=off
 * restores the plain roster order.
 *
 * Exported as a pure builder so the live SQL check (lesson 22) and the tests
 * render EXACTLY the statement the scan executes.
 */
export function buildFollowingEvidenceRosterSql(
  trackedAccountId: string,
  opts: {
    revisitHours?: number;
    ownerProfileTtlHours?: number;
    maxPostAgeHours?: number;
    maxItems?: number;
  } = {},
) {
  const revisitHours = opts.revisitHours ?? LIKE_EVIDENCE_REVISIT_HOURS;
  const ownerProfileTtlHours = opts.ownerProfileTtlHours ?? OWNER_PROFILE_TTL_HOURS;
  const maxPostAgeHours = opts.maxPostAgeHours ?? LIKE_EVIDENCE_MAX_POST_AGE_HOURS;
  const maxItems = opts.maxItems ?? LIKE_EVIDENCE_ROSTER_MAX_ITEMS;
  // Owners visited inside the revisit window are not due yet; the ordering
  // below then IS the rotation. 0 disables the filter.
  const revisitClause =
    revisitHours > 0
      ? sql`AND (
           posts_checked_at IS NULL
           OR posts_checked_at < NOW() - (${revisitHours} || ' hours')::interval
         )`
      : sql.empty();
  return sql`
      SELECT username, ig_user_id, display_name, pfp_url, first_seen_at,
             owner_is_private, owner_profile_checked_at
        FROM roster_members
       WHERE tracked_account_id = ${trackedAccountId}
         AND dimension = 'following'
         AND is_current = true
         -- A private owner cannot yield a liker read (their posts are not
         -- readable), yet the rotation still walked them: one account had 38 of
         -- 91 followed owners private, and a 50-owner window could be all private
         -- (50 cache hits, 0 posts, 0 IG calls — one wasted cycle). Leave them out
         -- while the cached verdict is inside its TTL; once it expires they come
         -- back for a single re-check.
         --
         -- IS TRUE, not "= true": for a never-profiled owner both columns are
         -- NULL, and NOT (NULL = true AND NULL > x) is NULL, which WHERE treats
         -- as false — so every never-visited owner (3,284 rows fleet-wide, 888 of
         -- @tracked_user_1's 1,414) was silently dropped from the roster, not merely
         -- under-rotated. IS TRUE is false for NULL and the row survives.
         AND NOT (
           owner_is_private IS TRUE
           AND owner_profile_checked_at IS NOT NULL
           AND owner_profile_checked_at > NOW() - (${ownerProfileTtlHours} || ' hours')::interval
         )
         ${revisitClause}
       ORDER BY
         -- 0 = posted inside the scan window, 1 = never checked, 2 = dormant,
         -- 3 = private owner. A private owner never gets posts_checked_at, so
         --     without this band it sits in band 1 forever and eats window slots.
         CASE
           WHEN owner_is_private IS TRUE THEN 3
           WHEN last_post_at IS NOT NULL
            AND last_post_at > NOW() - (${maxPostAgeHours} || ' hours')::interval
             THEN 0
           WHEN posts_checked_at IS NULL THEN 1
           ELSE 2
         END,
         -- inside a band, the least recently examined owner goes first so the
         -- rotation still sweeps rather than re-reading the same few accounts
         posts_checked_at ASC NULLS FIRST,
         username_lower ASC
       LIMIT ${maxItems}
  `;
}

/** Does this account hold ANY materialised following row (due or not)? */
export function buildFollowingRosterExistsSql(trackedAccountId: string) {
  return sql`
    SELECT 1 AS present
      FROM roster_members
     WHERE tracked_account_id = ${trackedAccountId}
       AND dimension = 'following'
       AND is_current = true
     LIMIT 1
  `;
}

type FollowingEvidenceOwner = {
  username: string;
  displayName: string | null;
  igUserId: string | null;
  pfpUrl: string | null;
  firstSeenAt: string;
  ownerIsPrivate: boolean | null;
  ownerProfileCheckedAt: Date | string | null;
};

type FollowingEvidenceRoster = {
  items: FollowingEvidenceOwner[];
  rotation: LikeEvidenceRotation;
};

async function loadFollowingEvidenceRoster(
  trackedAccountId: string,
): Promise<FollowingEvidenceRoster> {
  if (isLikeEvidenceActivityOrderingOn()) {
    const { rows } = (await db.execute(
      buildFollowingEvidenceRosterSql(trackedAccountId),
    )) as unknown as {
      rows: Array<{
        username: string;
        ig_user_id: string | null;
        display_name: string | null;
        pfp_url: string | null;
        first_seen_at: Date | string | null;
        owner_is_private: boolean | null;
        owner_profile_checked_at: Date | string | null;
      }>;
    };
    if (rows.length > 0) {
      return {
        rotation: "activity",
        items: rows.map((r) => ({
          username: r.username,
          displayName: r.display_name,
          igUserId: r.ig_user_id,
          pfpUrl: r.pfp_url,
          firstSeenAt:
            r.first_seen_at instanceof Date
              ? r.first_seen_at.toISOString()
              : (r.first_seen_at ?? new Date(0).toISOString()),
          ownerIsPrivate: r.owner_is_private,
          ownerProfileCheckedAt: r.owner_profile_checked_at,
        })),
      };
    }
    // Zero rows means one of two things. Either nothing is materialised for
    // this account (fall through to the roster builder), or every owner is
    // deferred — visited inside the revisit window, or private inside its TTL.
    // The second case must return an EMPTY window: falling through would hand
    // the builder's unordered full roster to slice(0, N) and re-scan the same
    // first N owners every hour, exactly the loop the revisit filter removes.
    const probe = (await db.execute(
      buildFollowingRosterExistsSql(trackedAccountId),
    )) as unknown as { rows: unknown[] };
    if (probe.rows.length > 0) return { rotation: "activity", items: [] };
  }

  const items: Awaited<ReturnType<typeof buildFollowingRoster>>["items"] = [];
  let cursor: string | undefined;
  do {
    const page = await buildFollowingRoster(trackedAccountId, {
      limit: LIKE_EVIDENCE_ROSTER_PAGE_SIZE,
      cursor,
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && items.length < LIKE_EVIDENCE_ROSTER_MAX_ITEMS);
  // The builder path has no persisted verdicts: every owner is a cache miss.
  // Normalise to the materialised row shape so both branches type identically.
  return {
    // No posts_checked_at ordering on this path, so the persisted cursor is
    // what rotates the window.
    rotation: "cursor",
    items: items.slice(0, LIKE_EVIDENCE_ROSTER_MAX_ITEMS).map((i) => ({
      username: i.username,
      displayName: i.displayName ?? null,
      igUserId: i.igUserId ?? null,
      pfpUrl: i.pfpUrl ?? null,
      firstSeenAt: i.firstSeenAt,
      ownerIsPrivate: null as boolean | null,
      ownerProfileCheckedAt: null as Date | string | null,
    })),
  };
}

type LatestSnapshotForFreshness = {
  at: Date;
  followerCount: number;
  followingCount: number;
};

async function getPartialRosterRefreshReason(
  trackedAccountId: string,
  latestSnapshot: LatestSnapshotForFreshness | undefined,
): Promise<string | null> {
  if (!latestSnapshot) return null;

  const [followers, following] = await Promise.all([
    buildFollowersRoster(trackedAccountId, { limit: 1 }),
    buildFollowingRoster(trackedAccountId, { limit: 1 }),
  ]);

  const followerMissing = Math.max(
    0,
    latestSnapshot.followerCount - followers.total,
  );
  const followingMissing = Math.max(
    0,
    latestSnapshot.followingCount - following.total,
  );

  if (followerMissing === 0 && followingMissing === 0) return null;

  const latestRosterAt = [
    followers.lastUpdatedAt,
    following.lastUpdatedAt,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];

  const minGapSec = Number(process.env.PARTIAL_ROSTER_RETRY_SEC ?? "3600");
  const retryAfterMs = Math.max(
    Number.isFinite(minGapSec) ? minGapSec : 3600,
    1800,
  ) * 1000;
  const staleEnough =
    latestRosterAt === undefined || Date.now() - latestRosterAt >= retryAfterMs;

  if (!staleEnough) return null;

  return `partial roster: followers ${followers.total}/${latestSnapshot.followerCount}, following ${following.total}/${latestSnapshot.followingCount}`;
}

// ─── Queue definitions ────────────────────────────────────────────────────────
// Fix #8: bound Redis growth by capping retained completed/failed job history.

const sharedCleanup = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
} as const;

// ─── Rate-limit knobs (Wave 2 task D) ─────────────────────────────────────
// Global BullMQ limiters applied at Worker level (BullMQ v5 removed
// Queue-level limiter). These apply across ALL bots, so with 60 bots the
// cap is hit quickly — see docs/rate-limits.md for rationale and tuning.
function readBoundedIntEnv(
  name: string,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

export const BOT_FOLLOW_LIMITER = {
  max: readBoundedIntEnv("BOT_FOLLOW_LIMITER_MAX", 5, 1, 20),
  duration: readBoundedIntEnv("BOT_FOLLOW_LIMITER_DURATION_MS", 60_000, 10_000, 3_600_000),
} as const;
export const COLLECTION_IG_LIMITER = {
  max: readBoundedIntEnv("COLLECTION_IG_LIMITER_MAX", 30, 1, 120),
  duration: readBoundedIntEnv("COLLECTION_IG_LIMITER_DURATION_MS", 60_000, 10_000, 3_600_000),
} as const;
// Dedicated limiter for the liked-posts (likers) lane. Likers is the scarcest
// and most ban-sensitive signal, and it runs on the WEB pool only, while the
// general collection lane is now mostly served by the much larger mobile pool.
// Giving likers its own budget lets us hold general collection at a safe rate
// while still pushing the liked-posts scan a little harder — tuning one no
// longer forces the other to move. Falls back to the general limiter value when
// LIKERS_IG_LIMITER_MAX is unset.
export const COLLECTION_LIKES_LIMITER = {
  max: readBoundedIntEnv(
    "LIKERS_IG_LIMITER_MAX",
    readBoundedIntEnv("COLLECTION_IG_LIMITER_MAX", 30, 1, 120),
    1,
    120,
  ),
  duration: readBoundedIntEnv("COLLECTION_IG_LIMITER_DURATION_MS", 60_000, 10_000, 3_600_000),
} as const;
// Profile and likes jobs run 5-80 minutes (roster walks, like scans). BullMQ's
// defaults (lockDuration 30s, stalledInterval 30s, maxStalledCount 1) were
// sized for short jobs: two deploy restarts inside one job marked it stalled
// twice and failed it for good. Hold the lock longer, check less often, and
// tolerate three stalls before giving up.
const LONG_JOB_STALL_OPTIONS = {
  maxStalledCount: 3,
  lockDuration: 120_000,
  stalledInterval: 60_000,
} as const;
// Never longer than half the 3h refresh cadence: a deferred retry that lands
// AFTER the next scheduled tick is a pure duplicate walk (prod had 4h here, so
// every deferred onboarding job doubled a tick).
const PROFILE_TEMP_BACKOFF_MAX_MS = 90 * 60 * 1000;
const PROFILE_TEMP_BACKOFF_MS = readBoundedIntEnv(
  "PROFILE_TEMP_BACKOFF_MS",
  15 * 60 * 1000,
  60_000,
  PROFILE_TEMP_BACKOFF_MAX_MS,
);

/**
 * C11c: the pm2 env still carries PROFILE_TEMP_BACKOFF_MS=14400000 (4 h), which
 * the clamp above silently turns into 90 min — the operator believed deferred
 * retries waited 4 h. Pure so it is testable: null when the env is unset,
 * unparsable or within the clamp; otherwise the requested/effective pair.
 */
export function describeProfileTempBackoffClamp(
  raw: string | undefined,
  maxMs: number = PROFILE_TEMP_BACKOFF_MAX_MS,
): { requestedMs: number; effectiveMs: number } | null {
  const parsed = Number(raw);
  if (raw === undefined || !Number.isFinite(parsed)) return null;
  const requestedMs = Math.floor(parsed);
  return requestedMs > maxMs ? { requestedMs, effectiveMs: maxMs } : null;
}

const profileTempBackoffClamp = describeProfileTempBackoffClamp(
  process.env.PROFILE_TEMP_BACKOFF_MS,
);
if (profileTempBackoffClamp) {
  logger.warn(
    {
      module: "workers",
      env: "PROFILE_TEMP_BACKOFF_MS",
      ...profileTempBackoffClamp,
      maxMs: PROFILE_TEMP_BACKOFF_MAX_MS,
    },
    "PROFILE_TEMP_BACKOFF_MS exceeds the 90 min clamp (half the refresh cadence); using the clamped value",
  );
}

// ─── B11: likes-after-profile dedupe window ─────────────────────────────────
// The relationship-like evidence scan (collectRelationshipLikeEvidence) does
// live owner/post/liker scans, so it is intentionally throttled to run less
// often than the profile refresh cadence ("Wave 2 task D: rate-limited to
// avoid storming IG"). The window is configurable so an admin-tuned refresh
// cadence can be matched with a likes cadence instead of being stuck at the
// previously hardcoded 30 minutes.
//
// The old scheme bucketed the jobId by epoch-aligned Math.floor(now/30min),
// which (a) hard-capped likes at ~once/30min regardless of the configured
// refresh cadence and (b) double-enqueued around every bucket boundary (two
// profile completions at 10:29:59 and 10:30:01 land in different buckets).
// The replacement is a true sliding window: one stable jobId per account,
// and a re-enqueue is allowed only when the previous run *finished* more
// than LIKES_DEDUPE_WINDOW_MIN ago — no epoch alignment, no boundary
// collisions. See enqueueLikesAfterProfile below.
const LIKES_DEDUPE_WINDOW_MIN = readBoundedIntEnv(
  "LIKES_DEDUPE_WINDOW_MIN",
  30,
  1,
  24 * 60,
);

export function buildLikesAfterProfileJobId(trackedAccountId: string): string {
  // NOTE: BullMQ (validateOptions) rejects a custom jobId containing ':'
  // ("Custom Id cannot contain :"), so the separator is '_' not ':'.
  // trackedAccountId is a UUID (no ':'/'_'), so this stays collision-free.
  return `likes-after-profile_${trackedAccountId}`;
}

export function profileBackoffAuditUpdate(
  schedulerTick: boolean,
  message: string,
  now: Date = new Date(),
): {
  status: "pending" | "failed";
  completedAt: Date | null;
  error: string;
} {
  const detail = message.slice(0, 940);
  return schedulerTick
    ? {
        // A recurring scheduler creates a fresh audit row on its next tick.
        // Leaving this row pending creates an orphan on every temporary
        // provider failure and made thousands of jobs look queued forever.
        status: "failed",
        completedAt: now,
        error: `deferred to next account-refresh tick: ${detail}`,
      }
    : {
        // Manual/onboarding jobs really do enqueue a delayed retry which will
        // claim this same pending audit row later.
        status: "pending",
        completedAt: null,
        error: `deferred: ${detail}`,
      };
}

/**
 * A like-scan window where nothing could even be LISTED: no liker read was
 * attempted (postsChecked === 0) and every owner visited errored before one
 * (errors >= ownersScanned). On 2026-09-02 six scans walked 216 owners during
 * the lease outage, read 0 posts and logged 216 errors — and each one advanced
 * its cursor past those 216 owners and logged "no readable candidate posts".
 * That is an outage wearing the empty-window disguise. Pure; shared by the
 * progress rule (hold the cursor) and the likes worker (fail the job so the
 * outage shows up as failed jobs).
 */
export function isLikeEvidenceListingOutage(
  postsChecked: number,
  errors: number,
  ownersScanned: number,
): boolean {
  return postsChecked === 0 && errors > 0 && errors >= ownersScanned;
}

// Cursor semantics differ by rotation (see LikeEvidenceRotation): in "cursor"
// mode the values are roster positions; in "activity" mode the caller passes
// the odometer (current + owners visited) as nextCursor, so "hold" below means
// "record no progress" while the selection itself is driven by
// roster_members.posts_checked_at. lastLikeEvidenceScanAt is stamped the same
// way in both modes.
export function likeEvidenceProgressUpdate(
  currentCursor: number,
  nextCursor: number,
  successfulLikerReads: number,
  now: Date = new Date(),
  // Liker reads ATTEMPTED this cycle. Defaults to 1 so callers that predate
  // this argument keep the original hold-on-zero behaviour.
  postsChecked: number = 1,
  // Owner-level errors and owners visited this cycle. Default to 0 so callers
  // that predate these arguments keep the advance-on-empty-window behaviour.
  errors: number = 0,
  ownersScanned: number = 0,
): {
  likeEvidenceCursor: number;
  lastLikeEvidenceScanAt?: Date;
} {
  if (successfulLikerReads <= 0) {
    // Two very different cycles both land here, and they need opposite handling.
    //
    // postsChecked > 0 — liker reads were attempted and every one failed. That
    // is an outage. Leaving both markers unchanged makes it visible and lets a
    // later healthy cycle retry the same owners instead of skipping them.
    //
    // postsChecked === 0 — no liker read was even attempted, because no owner
    // in this window had a readable candidate post. Holding the cursor here is
    // a livelock: the next cycle re-scans the identical window, finds the
    // identical nothing, and the account never advances. Observed live on
    // @tracked_user_3 (cursor frozen at 50 for 24.5h while its twin, same 91-member
    // roster, advanced to 75). Step past the window; do NOT stamp
    // lastLikeEvidenceScanAt, because nothing was actually inspected.
    //
    // postsChecked === 0 splits once more: an empty window (owners listed,
    // nothing readable) advances as above, but a window where EVERY owner
    // errored before a liker read (`isLikeEvidenceListingOutage`) is an
    // outage, and holds like the attempted-and-failed case — advancing would
    // skip a whole window of owners on the strength of a lease failure.
    if (postsChecked > 0) {
      return { likeEvidenceCursor: currentCursor };
    }
    if (isLikeEvidenceListingOutage(postsChecked, errors, ownersScanned)) {
      return { likeEvidenceCursor: currentCursor };
    }
    return { likeEvidenceCursor: nextCursor };
  }
  return {
    likeEvidenceCursor: nextCursor,
    lastLikeEvidenceScanAt: now,
  };
}

// ─── B11 + B14: jobId bookkeeping against retained BullMQ job husks ─────────
// With removeOnComplete: 100 / removeOnFail: 50 BullMQ retains completed and
// failed job husks, and Queue.add() against a jobId that still exists (even
// as a husk) is a silent no-op. Both dedupe schemes below therefore inspect
// the occupant of their stable jobId before re-adding.

// States in which a job with our stable id represents genuinely scheduled
// future work. "active" is deliberately NOT in this set: an active occupant
// may be the very job that is calling the enqueue helper right now (a
// deferred retry that failed again), and treating ourselves as "already
// pending" would strand the account — the exact B14 failure mode.
const SCHEDULED_JOB_STATES: ReadonlySet<string> = new Set([
  "delayed",
  "waiting",
  "waiting-children",
  "prioritized",
]);

export interface RetainedJobLike {
  getState(): Promise<string>;
  remove(): Promise<unknown>;
  finishedOn?: number;
  processedOn?: number;
  timestamp?: number;
}

/** Payload of a self-healing/deferred queue add; `force`/`source` are carried
 *  by deferred profile retries (C11d), likes jobs send the id alone. */
export interface DedupeJobData {
  readonly trackedAccountId: string;
  readonly force?: boolean;
  readonly source?: string;
  readonly cooldownObservedAt?: string;
  readonly capacityObservedAt?: string;
}

export interface DedupeQueueLike {
  getJob(jobId: string): Promise<RetainedJobLike | undefined | null>;
  add(
    name: string,
    data: DedupeJobData,
    opts: {
      delay?: number;
      jobId: string;
      removeOnComplete: number;
      removeOnFail: number;
    },
  ): Promise<unknown>;
}

// B11: sliding-window throttle for the likes-after-profile enqueue. Returns
// "throttled" when a likes job for this account is already scheduled/running,
// or when the last one finished less than windowMs ago. Unlike the old
// epoch-bucketed jobId there is no boundary at which two completions a few
// seconds apart both pass the gate.
export async function enqueueLikesAfterProfile(
  queue: DedupeQueueLike,
  requestedTrackedAccountId: string,
  nowMs: number = Date.now(),
  windowMs: number = LIKES_DEDUPE_WINDOW_MIN * 60_000,
  resolveCanonical: (id: string) => Promise<string> = canonicalTwinId,
): Promise<"scheduled" | "throttled"> {
  // Twin leader election (lesson 13): rows tracking the same IG user share one
  // scan. Whichever twin's refresh (or the sweep) gets here, the job is keyed
  // and run for the canonical (oldest active) row, so its cursor advances and
  // the 30-minute dedupe below holds across both rows. Read paths already
  // union like_events across twins, so the other row loses nothing.
  const trackedAccountId = await resolveCanonical(requestedTrackedAccountId);
  if (trackedAccountId !== requestedTrackedAccountId) {
    logger.info(
      { module: "likes", requested: requestedTrackedAccountId, canonical: trackedAccountId },
      "[likes] twin collapsed: scan runs for canonical row",
    );
  }
  const jobId = buildLikesAfterProfileJobId(trackedAccountId);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (SCHEDULED_JOB_STATES.has(state) || state === "active") {
      // Already queued or currently running — nothing to do.
      return "throttled";
    }
    // Completed/failed husk: only re-run once the throttle window since the
    // last run has elapsed. finishedOn is when the run ended; fall back to
    // processedOn (start) then timestamp (enqueue) for husks missing it.
    const lastRunMs =
      existing.finishedOn ?? existing.processedOn ?? existing.timestamp ?? 0;
    if (nowMs - lastRunMs < windowMs) {
      return "throttled";
    }
    // Window elapsed: the husk would silently swallow the re-add — drop it.
    await existing.remove();
  }
  await queue.add(
    "collect-likes",
    { trackedAccountId },
    { jobId, removeOnComplete: 100, removeOnFail: 50 },
  );
  return "scheduled";
}

// ─── B14: temp-backoff re-enqueue that can never be silently dropped ────────
// The deferred-retry jobId used to be `profile-deferred:<id>:<timebucket>`,
// which could collide with a retained husk from a prior bucket and silently
// drop the retry — the account simply stopped being retried.
//
// Semantics now: at most ONE scheduled (delayed/waiting) deferred retry per
// tracked account, under the stable id `profile-deferred:<id>`.
//   - Stable id occupied by a delayed/waiting job → genuine pending retry,
//     dedupe.
//   - Occupied by a completed/failed husk → remove the husk, re-add.
//   - Occupied by an ACTIVE job (possibly the caller itself failing again;
//     active jobs cannot be removed) → add under a collision-proof unique id
//     (`_<nowMs>` suffix) so the retry is never lost.
//   - Any bookkeeping error → same unique-id fallback. A duplicate retry is
//     cheap (the worker's freshness/budget gates make it a near no-op) while
//     a dropped retry strands the account until the next scheduler tick.
// NOTE: '_' (not ':') separators — BullMQ rejects ':' in custom job ids.
export function buildDeferredProfileJobId(trackedAccountId: string): string {
  return `profile-deferred_${trackedAccountId}`;
}

/**
 * Job fields a deferred retry must keep (C11d). Before this the retried job was
 * `{ trackedAccountId }` only: a manual/onboarding job (`force: true`) deferred
 * on "hit daily cap" lost its force flag, so the retry hit the freshness gate
 * and skipped; `source` (which decides the scheduler-tick classification on a
 * second backoff) was gone too. Undefined fields are omitted, not sent as null.
 */
export interface DeferredProfileCarry {
  readonly force?: boolean;
  readonly source?: string;
  readonly cooldownObservedAt?: string;
  readonly capacityObservedAt?: string;
}

export function buildDeferredProfileJobData(
  trackedAccountId: string,
  carry: DeferredProfileCarry = {},
): DedupeJobData {
  return {
    trackedAccountId,
    ...(carry.force !== undefined ? { force: carry.force } : {}),
    ...(carry.source !== undefined ? { source: carry.source } : {}),
    ...(carry.cooldownObservedAt !== undefined ? { cooldownObservedAt: carry.cooldownObservedAt } : {}),
    ...(carry.capacityObservedAt !== undefined ? { capacityObservedAt: carry.capacityObservedAt } : {}),
  };
}

export async function enqueueDeferredProfileRetry(
  queue: DedupeQueueLike,
  trackedAccountId: string,
  delayMs: number = PROFILE_TEMP_BACKOFF_MS,
  nowMs: number = Date.now(),
  carry: DeferredProfileCarry = {},
): Promise<"scheduled" | "deduped"> {
  const jobId = buildDeferredProfileJobId(trackedAccountId);
  const data = buildDeferredProfileJobData(trackedAccountId, carry);
  const addOpts = {
    delay: delayMs,
    removeOnComplete: 100,
    removeOnFail: 50,
  };
  try {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (SCHEDULED_JOB_STATES.has(state)) {
        // A genuine retry is already queued for this account — dedupe.
        return "deduped";
      }
      if (state === "active") {
        // The occupant is running right now (it may even be the caller).
        // It cannot be removed, and it being active is not a guarantee a
        // future retry exists — schedule one under a unique id.
        await queue.add(
          "profile",
          data,
          { ...addOpts, jobId: `${jobId}_${nowMs}` },
        );
        return "scheduled";
      }
      // Completed/failed/unknown husk: it would silently swallow the re-add.
      await existing.remove();
    }
    await queue.add("profile", data, { ...addOpts, jobId });
    return "scheduled";
  } catch (err) {
    logger.warn(
      {
        module: "workers",
        trackedAccountId,
        err: err instanceof Error ? err.message : String(err),
      },
      "deferred profile retry dedupe bookkeeping failed; using unique jobId",
    );
    await queue.add(
      "profile",
      data,
      { ...addOpts, jobId: `${jobId}_${nowMs}` },
    );
    return "scheduled";
  }
}

export const collectionProfileQueue = new Queue("collection-profile", {
  connection,
  defaultJobOptions: {
    // attempts:1 — the scrape itself already retries internally (scrape-retry
    // layer does up to 3 bot rotations with backoff). A BullMQ retry on top
    // multiplied that by 3, and when the failure is "no healthy proxy" every
    // attempt re-runs the full 20-endpoint probe batch for zero benefit. One
    // BullMQ attempt + internal rotation is enough; the next scheduler tick
    // retries naturally.
    attempts: 1,
    backoff: { type: "exponential", delay: 5000 },
    ...sharedCleanup,
  },
});

export const collectionLikesQueue = new Queue("collection-likes", {
  connection,
  defaultJobOptions: {
    // Each owner/profile/post read already performs transport retries and bot
    // rotation internally. Retrying the whole relationship window three times
    // turns an upstream outage into an immediate request storm. Record one
    // honest failure and let the next profile cycle retry after the dedupe
    // window instead.
    attempts: 1,
    backoff: { type: "exponential", delay: 5000 },
    ...sharedCleanup,
  },
});

export const collectionFollowsQueue = new Queue("collection-follows", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    ...sharedCleanup,
  },
});

export const reportGenerateQueue = new Queue("report-generate", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10000 },
    ...sharedCleanup,
  },
});

export const emailSendQueue = new Queue("email-send", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
    ...sharedCleanup,
  },
});

// Weekly reports: a single repeatable "sweep" job fans out one report per
// active tracked_account, each enqueued onto reportGenerateQueue with
// deliver:true. See the scheduler block in startWorkers() for cadence and the
// WEEKLY_REPORTS_ENABLED gate.
export const weeklyReportQueue = new Queue("weekly-report", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10000 },
    ...sharedCleanup,
  },
});

export const botFollowRequestQueue = new Queue("bot-follow-request", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 30000 },
    ...sharedCleanup,
  },
});

export const botFollowCheckQueue = new Queue("bot-follow-check", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10000 },
    ...sharedCleanup,
  },
});

// Wave 2: retention queue. A single repeatable "prune-events" job runs daily
// and deletes rows older than RETENTION_DAYS_EVENTS from each event table.
export const retentionQueue = new Queue("retention", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    ...sharedCleanup,
  },
});

// Wave 4: auto-refresh sweep. Re-enqueues a profile job for every active
// tracked_account whose last profile refresh is older than the threshold.
// Default cadence: sweep every 30 min, refresh threshold 6 hours per account.
// Overridable via env: REFRESH_SWEEP_MIN, REFRESH_THRESHOLD_HOURS.
export const refreshSweepQueue = new Queue("refresh-sweep", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    ...sharedCleanup,
  },
});

// Self-healing: bot-cooldown probe. Periodic single-bot probe to clear
// cooldown_until when the underlying IG block has actually expired. See the
// scheduler block in startWorkers() for cadence (BOT_COOLDOWN_PROBE_SEC).
export const botCooldownProbeQueue = new Queue("bot-cooldown-probe", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    ...sharedCleanup,
  },
});

// Wave 5: bot-pool-rescue. Last-line-of-defense watchdog that kicks in when
// the entire pool has gone invalid simultaneously (every bot CSRF-rejected
// or checkpoint-blocked at the same time). Counts healthy bots and, when the
// count drops below BOT_POOL_RESCUE_MIN_HEALTHY (default 2), force-relogs
// the single bot whose last_login_at is oldest. Sequential by design — a
// 10-min interval gives each rescued bot time to settle before the next
// rescue runs.
export const botPoolRescueQueue = new Queue("bot-pool-rescue", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    ...sharedCleanup,
  },
});

// ─── B8: never let an unhandled 'error' event kill the PM2 process ─────────
// BullMQ Queues and Workers are EventEmitters. An 'error' emit with zero
// listeners is re-thrown by Node and crashes the process. Every Queue/Worker
// created in this file gets a throw-proof logging listener. (There are
// currently no QueueEvents instances anywhere in the codebase; if one is
// ever added it must be registered the same way.)

// In-memory per-emitter error counts, keyed "<kind>:<name>". There is no
// metrics backend in this codebase (observability/ is logging only), so this
// IS the B8 counter; it is exported for admin/diagnostics endpoints and a
// sustained climb on one key means a queue/worker is erroring repeatedly
// (Redis flapping, BullMQ internal failure) even though the process survives.
const emitterErrorCounts = new Map<string, number>();

export function getEmitterErrorCounts(): Readonly<Record<string, number>> {
  return Object.fromEntries(emitterErrorCounts);
}

function safeLogEmitterError(kind: "queue" | "worker", name: string, err: unknown): void {
  const key = `${kind}:${name}`;
  emitterErrorCounts.set(key, (emitterErrorCounts.get(key) ?? 0) + 1);
  try {
    logger.error(
      {
        module: "workers",
        kind,
        queue: name,
        err: err instanceof Error ? err.message : String(err),
      },
      `${kind} emitted error`,
    );
  } catch {
    // Never throw from an error handler — a crashing handler would defeat
    // the entire point of having one.
  }
}

for (const queue of [
  collectionProfileQueue,
  collectionLikesQueue,
  collectionFollowsQueue,
  reportGenerateQueue,
  emailSendQueue,
  weeklyReportQueue,
  botFollowRequestQueue,
  botFollowCheckQueue,
  retentionQueue,
  refreshSweepQueue,
  botCooldownProbeQueue,
  botPoolRescueQueue,
  // Constructed in services/media-cache-jobs.ts but instantiated by this
  // module's import — it needs the same throw-proof listener.
  mediaCacheQueue,
  // Lazy singleton from workers/bot-warmer-worker.ts, which registers no
  // 'error' listener of its own — instantiate it here so it gets one too.
  getBotWarmerQueue(connection),
  getBackgroundRosterQueue(connection),
]) {
  queue.on("error", (err) => safeLogEmitterError("queue", queue.name, err));
}

// Every `new Worker(...)` in this file must pass through this registrar so an
// 'error' emit (Redis blip, internal BullMQ failure) is logged instead of
// crashing the PM2 process. Structurally typed so it also accepts workers
// constructed elsewhere but registered here (e.g. the bot warmer).
// Exported for tests.
export function registerWorkerErrorHandler<
  T extends { name: string; on(event: "error", cb: (err: Error) => void): unknown },
>(worker: T): T {
  worker.on("error", (err) => safeLogEmitterError("worker", worker.name, err));
  return worker;
}

export function getQueues() {
  return {
    collectionProfileQueue,
    collectionLikesQueue,
    collectionFollowsQueue,
    reportGenerateQueue,
    emailSendQueue,
    weeklyReportQueue,
    botFollowRequestQueue,
    botFollowCheckQueue,
    retentionQueue,
    refreshSweepQueue,
    botCooldownProbeQueue,
    botPoolRescueQueue,
    mediaCacheQueue,
    botWarmerQueue: getBotWarmerQueue(connection),
    backgroundRosterQueue: getBackgroundRosterQueue(connection),
  };
}

// ─── Report aggregation helpers ─────────────────────────────────────────────
// Reports are built from REAL tracked activity. No data is fabricated — every
// count comes from the event tables for the report's [periodStart, periodEnd].

type ReportStats = ReadyReportStats;

/** One authoritative half-open aggregation drives UI, PDF and email. Failure
 * must retry the report, never turn partial legacy counts into a ready report. */
export async function computeReportStats(
  trackedAccountId:string, _trackingStarted:Date, periodStart:Date, periodEnd:Date, periodType:string,
):Promise<ReportStats> {
  const {buildReportData,toReportMetrics} = await import("./services/report-data.js");
  const data = await buildReportData(trackedAccountId,periodStart,periodEnd,periodType);
  return {totalLikes:data.summary.totalLikes,totalFollows:data.summary.followersDetected,
    totalUnfollows:data.summary.followersLost,peakActivityHour:data.peakActivityHour,
    topNiche:data.topInterests[0]?.label ?? null,metrics:toReportMetrics(data)};
}

// ─── Worker: collection-profile ───────────────────────────────────────────────

function createProfileWorker(): Worker {
  return new Worker(
    "collection-profile",
    async (job: Job) => {
      const { trackedAccountId } = job.data as { trackedAccountId: string };
      return withCorrelation(
        { module: "worker:profile", trackedAccountId, jobId: String(job.id ?? "") },
        async () => {
      logger.info("processing profile job");

      let collectionJobId: string | null = null;
      let privateCollection = false;
      try {
        if (job.name === ACCOUNT_REFRESH_JOB_NAME) {
          // No collection_jobs row exists for scheduler-fired ticks. Insert one
          // so the existing "Mark job as running" UPDATE below has a target
          // and so the audit trail matches manual jobs.
          const [insertedJob] = await db.insert(collectionJobs).values({
            trackedAccountId,
            jobType: "profile",
            status: "running",
            startedAt: new Date(),
          }).returning({ id: collectionJobs.id });
          collectionJobId = insertedJob?.id ?? null;
        }

        // Mark one pending audit row as running. Older code updated every
        // pending row for the account, which made one scraper failure corrupt
        // the historical collection_jobs audit trail.
        if (!collectionJobId) {
          // D13: atomic claim. The inner SELECT takes a row lock with
          // FOR UPDATE SKIP LOCKED so a concurrent worker/process can never
          // pick the SAME pending row (it skips locked rows instead of
          // blocking), and the UPDATE re-asserts `status = 'pending'` so even
          // if two pickers somehow targeted one row only the first transition
          // wins. Without this the plain SELECT-then-UPDATE was safe only at
          // concurrency 1 in a single process.
          const acquired = await db.execute<{ id: string }>(sql`
            WITH picked AS (
              SELECT id
              FROM collection_jobs
              WHERE tracked_account_id = ${trackedAccountId}
                AND job_type = 'profile'
                AND status = 'pending'
              ORDER BY id
              LIMIT 1
              FOR UPDATE SKIP LOCKED
            )
            UPDATE collection_jobs
            SET status = 'running', started_at = NOW()
            WHERE id = (SELECT id FROM picked)
              AND status = 'pending'
            RETURNING id
          `);
          const rows = (acquired as unknown as { rows?: Array<{ id: string }> }).rows ?? [];
          collectionJobId = rows[0]?.id ?? null;
        }

        // Scheduler jobs and manual repair jobs can exist without a matching
        // pending row. Create a scoped row so completion/failure writes still
        // target exactly one record.
        if (!collectionJobId) {
          const [insertedJob] = await db.insert(collectionJobs).values({
            trackedAccountId,
            jobType: "profile",
            status: "running",
            startedAt: new Date(),
          }).returning({ id: collectionJobs.id });
          collectionJobId = insertedJob?.id ?? null;
        }

        const [account] = await db
          .select()
          .from(trackedAccounts)
          .where(eq(trackedAccounts.id, trackedAccountId))
          .limit(1);

        if (!account) throw new Error(`Tracked account ${trackedAccountId} not found`);
        if (!account.isActive || !await customerHasAccess(account.userId)) {
          logger.info(
            { igUsername: account.igUsername },
            "profile job skipped: tracked account inactive",
          );
          if (collectionJobId) {
            await db
              .update(collectionJobs)
              .set({
                status: "completed",
                completedAt: new Date(),
                error: "skipped: tracked account inactive",
              })
              .where(eq(collectionJobs.id, collectionJobId));
          }
          return { skipped: "inactive" };
        }

        privateCollection = account.isPrivate && account.accessStatus === "has_access";
        const runCollection = async () => {
        if (job.data.source === "private-cooldown" && !privateCollection) {
          await db.update(collectionJobs).set({ status: "completed", completedAt: new Date(),
            error: "skipped: private cooldown recovery no longer authorized" })
            .where(eq(collectionJobs.id, collectionJobId!));
          return { skipped: "private-access-changed" };
        }
        if (job.data.source === "public-posts-capacity" && (account.isPrivate || account.accessStatus !== "public")) {
          await db.update(collectionJobs).set({ status: "completed", completedAt: new Date(),
            error: "skipped: public posts recovery no longer authorized" })
            .where(eq(collectionJobs.id, collectionJobId!));
          return { skipped: "public-access-changed" };
        }

        if (job.data.source === "private-cooldown" || job.data.source === "public-posts-capacity") {
          const observedAt = Date.parse(job.data.cooldownObservedAt ?? job.data.capacityObservedAt ?? "");
          if (Number.isFinite(observedAt)) {
            const [latestCollection] = await db.select({ status: collectionJobs.status,
              error: collectionJobs.error, completedAt: collectionJobs.completedAt })
              .from(collectionJobs).where(and(eq(collectionJobs.trackedAccountId, trackedAccountId),
                eq(collectionJobs.jobType, "profile"), inArray(collectionJobs.status, ["completed", "failed"]),
                sql`(${collectionJobs.error} IS NULL OR ${collectionJobs.error} NOT LIKE 'skipped:%')`))
              .orderBy(desc(collectionJobs.startedAt)).limit(1);
            // Another scheduled/manual/expiry job may have completed the work
            // while this one-off waited. A newer failed/partial result still
            // needs recovery, even if its profile snapshot is already fresh.
            if (latestCollection?.status === "completed" && !latestCollection.error &&
              latestCollection.completedAt && latestCollection.completedAt.getTime() >= observedAt) {
              await db.update(collectionJobs).set({ status: "completed", completedAt: new Date(),
                error: "skipped: collection recovered after reader unavailability was observed" })
                .where(eq(collectionJobs.id, collectionJobId!));
              return { skipped: job.data.source === "private-cooldown" ? "private-already-recovered" : "public-already-recovered" };
            }
          }
        }

        if (job.data.source === "public-posts-capacity") {
          const retryAt = await enqueuePublicPostsCapacityRetry(collectionProfileQueue, trackedAccountId);
          if (retryAt) {
            await db.update(collectionJobs).set({ status: "failed", completedAt: new Date(),
              error: `deferred until public posts reader capacity returns: ${retryAt.toISOString()}` })
              .where(eq(collectionJobs.id, collectionJobId!));
            return { deferred: true, retryAt: retryAt.toISOString() };
          }
        }
        if (privateCollection) {
          const retryAt = await enqueuePrivateCooldownRetry(collectionProfileQueue, trackedAccountId);
          if (retryAt) {
            await db.update(collectionJobs).set({ status: "failed", completedAt: new Date(),
              error: `deferred until approved viewer cooldown expires: ${retryAt.toISOString()}` })
              .where(eq(collectionJobs.id, collectionJobId!));
            return { deferred: true, retryAt: retryAt.toISOString() };
          }
        }

        // Per-account budget gate. Applies to scheduler, onboarding, and
        // manual queue jobs unless explicitly forced by an internal repair
        // script. This keeps duplicate jobs from turning into repeated IG
        // hits while cached data is still fresh.
        const jobData = job.data as { force?: boolean; source?: string };
        if (jobData.force !== true) {
          const rawThresholdSec = Number(process.env.REFRESH_THRESHOLD_SEC ?? "1500");
          const thresholdSec = Number.isFinite(rawThresholdSec)
            ? Math.min(Math.max(rawThresholdSec, 900), 1800)
            : 1500;
          const cutoff = new Date(Date.now() - thresholdSec * 1000);
          const lastSnap = await db
            .select({
              at: profileSnapshots.snapshotAt,
              followerCount: profileSnapshots.followerCount,
              followingCount: profileSnapshots.followingCount,
            })
            .from(profileSnapshots)
            .where(eq(profileSnapshots.trackedAccountId, trackedAccountId))
            .orderBy(desc(profileSnapshots.snapshotAt))
            .limit(1);
          const latestSnapshot = lastSnap[0];
          const lastAt = latestSnapshot?.at;
          if (lastAt && lastAt > cutoff) {
            const partialRosterReason = await getPartialRosterRefreshReason(
              trackedAccountId,
              latestSnapshot,
            );
            const [previousCollection] = await db.select({
              status: collectionJobs.status,
              error: collectionJobs.error,
              completedAt: collectionJobs.completedAt,
            }).from(collectionJobs).where(and(
              eq(collectionJobs.trackedAccountId, trackedAccountId),
              eq(collectionJobs.jobType, "profile"),
              inArray(collectionJobs.status, ["completed", "failed"]),
              sql`(${collectionJobs.error} IS NULL OR ${collectionJobs.error} NOT LIKE 'skipped:%')`,
            )).orderBy(desc(collectionJobs.startedAt)).limit(1);
            const partialMediaRetry = partialCollectionNeedsRetry(previousCollection);
            if (partialRosterReason || partialMediaRetry) {
              logger.info(
                {
                  thresholdSec,
                  lastAt: lastAt.toISOString(),
                  jobName: job.name,
                  source: jobData.source ?? null,
                  partialRosterReason,
                  partialMediaRetry,
                },
                "profile job freshness bypassed: collection still partial",
              );
            } else {
              logger.info(
                {
                  thresholdSec,
                  lastAt: lastAt.toISOString(),
                  jobName: job.name,
                  source: jobData.source ?? null,
                },
                "profile job skipped: snapshot still fresh",
              );
              if (collectionJobId) {
                await db
                  .update(collectionJobs)
                  .set({
                    status: "completed",
                    completedAt: new Date(),
                    error: "skipped: snapshot still fresh",
                  })
                  .where(eq(collectionJobs.id, collectionJobId));
              }
              return { skipped: "fresh" };
            }
          }
        }

        // Real public-data collection. No mock fallbacks. The collector:
        //   - fetches the profile (required)
        //   - updates tracked_accounts + inserts a profile_snapshots row
        //   - kicks off posts / stories / highlights / follows / followers
        //     in parallel, isolating failures
        const outcome = await collectPublicData(account);

        if (!outcome.profile.ok) {
          throw new Error(
            `profile fetch failed: ${outcome.profile.error ?? "unknown error"}`,
          );
        }

        const isPrivate = outcome.isPrivate;

        const completion = collectionCompletion(outcome);

        logger.info(
          {
            igUsername: account.igUsername,
            profileSource: outcome.profile.source,
            postsCount: outcome.posts.count,
            postsSource: outcome.posts.source,
            storiesCount: outcome.stories.count,
            storiesSource: outcome.stories.source,
            highlightsCount: outcome.highlights.count,
            highlightsSource: outcome.highlights.source,
            newFollows: outcome.following.newFollows,
            newUnfollows: outcome.following.newUnfollows,
            newFollowers: outcome.followers.newFollowers,
            newFollowerUnfollows: outcome.followers.newFollowerUnfollows,
            isPrivate,
            status: completion.status,
            diagnostic: completion.error,
          },
          "public-data collection finished",
        );

        // Handle private account bot follow assignment
        if (isPrivate && account.accessStatus === "public" && job.data.source !== "public-posts-capacity") {
          logger.info({ igUsername: account.igUsername }, "private account detected");
          const requestId = await assignBotToTrackedAccount(trackedAccountId);
          if (requestId) {
            const delay = Math.floor(Math.random() * 90000) + 30000;
            await botFollowRequestQueue.add("send-follow", { botFollowRequestId: requestId }, { delay });
            logger.info(
              { delayMs: delay, botFollowRequestId: requestId },
              "bot follow queued",
            );
          } else {
            logger.warn("private account detected but no bots available");
          }
        } else if (!isPrivate && account.isPrivate) {
          await db.update(trackedAccounts)
            .set({ isPrivate: false, accessStatus: "public", updatedAt: new Date() })
            .where(eq(trackedAccounts.id, trackedAccountId));

          // Fix #12: cleanup active follow requests when account goes public
          const activeFollowRequests = await db
            .select({
              id: botFollowRequests.id,
            })
            .from(botFollowRequests)
            .where(
              and(
                eq(botFollowRequests.trackedAccountId, trackedAccountId),
                inArray(botFollowRequests.status, ["queued", "pending"]),
              ),
            );

          for (const fr of activeFollowRequests) {
            await markFollowRequestFailed(fr.id, "Account is now public");
          }

          if (activeFollowRequests.length > 0) {
            logger.info(
              { igUsername: account.igUsername, cleaned: activeFollowRequests.length },
              "cleaned up active follow requests for now-public account",
            );
          }

          logger.info({ igUsername: account.igUsername }, "account is now public");
        }

        // Keep usable data, but never mark a partial media/engagement read complete.
        if (collectionJobId) {
          await db
            .update(collectionJobs)
            .set({
              status: completion.status,
              completedAt: new Date(),
              error: completion.error,
            })
            .where(eq(collectionJobs.id, collectionJobId));
        }

        if (privateCollection && completion.status === "failed") {
          // A successful profile can be followed by a rate-limited content leg.
          // Preserve the partial audit result and wake at the new cooldown end.
          await enqueuePrivateCooldownRetry(collectionProfileQueue, trackedAccountId)
            .catch(error => logger.warn({ error }, "private cooldown recovery scheduling failed"));
        }

        if (!account.isPrivate && !outcome.isPrivate && completion.status === "failed" &&
          publicPostsPoolUnavailable(outcome.posts.error)) {
          await enqueuePublicPostsCapacityRetry(collectionProfileQueue, trackedAccountId)
            .catch(error => logger.warn({ error }, "public posts capacity recovery scheduling failed"));
        }

        // B11: sliding-window throttle (LIKES_DEDUPE_WINDOW_MIN). On
        // bookkeeping failure we log and drop rather than blind-add: a missed
        // likes pass self-heals on the next profile cycle, while a duplicate
        // pass storms IG with live owner/post/liker scans.
        await enqueueLikesAfterProfile(collectionLikesQueue, trackedAccountId)
          .then((outcome) =>
            logger.debug(
              { trackedAccountId, outcome },
              "likes-after-profile enqueue",
            ),
          )
          .catch((e) => logger.error({ err: e }, "enqueue likes failed"));

        logger.info({ igUsername: account.igUsername }, "profile job completed");
        };
        // Normal refreshes and old/new recovery wake-ups share one account
        // lease, so separately eligible readers cannot duplicate a full cycle.
        return await withOperationLease(`profile-collection:${trackedAccountId}`, runCollection);
      } catch (err) {
        if (err instanceof OperationBusyError) {
          if (collectionJobId) await db.update(collectionJobs).set({ status: "completed", completedAt: new Date(),
            error: "skipped: collection already in progress" })
            .where(eq(collectionJobs.id, collectionJobId)).catch(() => {});
          return { skipped: privateCollection ? "private-in-progress" : "profile-in-progress" };
        }
        const message = err instanceof Error ? err.message : String(err);
        if (privateCollection) {
          const retryAt = await enqueuePrivateCooldownRetry(collectionProfileQueue, trackedAccountId)
            .catch(error => {
              logger.warn({ error }, "private cooldown recovery scheduling failed");
              return null;
            });
          if (retryAt) {
            if (collectionJobId) await db.update(collectionJobs).set({ status: "failed", completedAt: new Date(),
              error: `deferred until approved viewer cooldown expires: ${retryAt.toISOString()}; ${message}`.slice(0, 1000) })
              .where(eq(collectionJobs.id, collectionJobId)).catch(() => {});
            return { deferred: true, retryAt: retryAt.toISOString() };
          }
        }
        const lowerMessage = message.toLowerCase();
        const temporaryScrapeBackoff =
          lowerMessage.includes("rate limited") ||
          lowerMessage.includes("no available bot in the pool") ||
          lowerMessage.includes("no healthy endpoint") ||
          lowerMessage.includes("provider health cooldown") ||
          lowerMessage.includes("failed to ready bot") ||
          // A capped pool is a temporary condition (resets 00:00Z), not a
          // reason to hard-fail an onboarding/manual sync with attempts:1.
          lowerMessage.includes("hit daily cap");
        if (temporaryScrapeBackoff) {
          logger.warn({ err }, "profile job temporary scraper backoff");
        } else {
          logger.error({ err }, "profile job error");
        }
        if (collectionJobId) {
          if (temporaryScrapeBackoff) {
            const currentJobData = job.data as DeferredProfileCarry;
            const schedulerTick =
              job.name === ACCOUNT_REFRESH_JOB_NAME ||
              currentJobData.source === "account-refresh";
            await db.update(collectionJobs)
              .set(profileBackoffAuditUpdate(schedulerTick, message))
              .where(eq(collectionJobs.id, collectionJobId))
              .catch(() => {});
            if (schedulerTick) {
              logger.warn(
                {
                  reason: message.slice(0, 240),
                  nextSchedulerTick: true,
                },
                "profile job deferred to next account-refresh tick",
              );
              return { deferred: true, nextSchedulerTick: true };
            }
            // B14: husk-proof deferred retry — see enqueueDeferredProfileRetry.
            const deferOutcome = await enqueueDeferredProfileRetry(
              collectionProfileQueue,
              trackedAccountId,
              PROFILE_TEMP_BACKOFF_MS,
              Date.now(),
              // C11d: keep force/source so a deferred manual/onboarding job still
              // bypasses the freshness gate and keeps its audit source.
              { force: currentJobData.force, source: currentJobData.source, cooldownObservedAt: currentJobData.cooldownObservedAt, capacityObservedAt: currentJobData.capacityObservedAt },
            );
            logger.warn(
              {
                delayMs: PROFILE_TEMP_BACKOFF_MS,
                reason: message.slice(0, 240),
                deferOutcome,
              },
              "profile job deferred after temporary scraper backoff",
            );
            return { deferred: true };
          }
          await db.update(collectionJobs)
            .set({
              status: "failed",
              completedAt: new Date(),
              error: message.slice(0, 1000),
            })
            .where(eq(collectionJobs.id, collectionJobId))
            .catch(() => {});
        }
        throw err;
      }
        },
      );
    },
    {
      connection: createRedisConnection(),
      // Was hardcoded 1: one large account (sample/natgeo/complex) monopolised
      // the single worker with a long roster walk, starving the small accounts
      // (their scheduled ticks queued behind it and never ran). The row claim
      // above is atomic (FOR UPDATE SKIP LOCKED), so >1 is safe. Env-tunable so
      // we can dial back if the extra parallel IG load raises rate-limits.
      concurrency: Number(process.env.COLLECTION_PROFILE_CONCURRENCY ?? "3"),
      ...LONG_JOB_STALL_OPTIONS,
    },
  );
}

// ─── Worker: collection-likes ─────────────────────────────────────────────────
// Wave 2 task D: rate-limited to avoid storming IG on queue-backlog recovery.

/**
 * Media ids whose likers were already read for this tracked account inside the
 * recheck window. Loaded once per scan; the scan mutates the returned Set as it
 * records reads, so a post is never read twice within a single pass either.
 */
async function loadRecentlyCheckedMediaIds(
  trackedAccountId: string,
): Promise<Set<string>> {
  if (LIKE_EVIDENCE_RECHECK_HOURS <= 0) return new Set<string>();
  try {
    const cutoff = new Date(
      Date.now() - LIKE_EVIDENCE_RECHECK_HOURS * 60 * 60 * 1000,
    );
    const rows = await db
      .select({ mediaId: likeEvidencePostChecks.mediaId })
      .from(likeEvidencePostChecks)
      .where(
        and(
          eq(likeEvidencePostChecks.trackedAccountId, trackedAccountId),
          gte(likeEvidencePostChecks.checkedAt, cutoff),
        ),
      );
    return new Set(rows.map((r) => r.mediaId));
  } catch (err) {
    // Fail OPEN. If the memory is unreadable we re-read posts, which is merely
    // the old wasteful behaviour. Failing closed would skip every candidate and
    // silently stop liked-post detection altogether.
    logger.warn(
      {
        trackedAccountId,
        err: err instanceof Error ? err.message : String(err),
      },
      "[like-evidence] could not load checked-post memory; re-reading posts",
    );
    return new Set<string>();
  }
}

/** Remember a successful liker read so later cycles move past this post. */
async function recordLikeEvidencePostCheck(
  trackedAccountId: string,
  mediaId: string,
  ownerUsername: string | null,
  postTakenAt: Date | string | null,
): Promise<void> {
  if (LIKE_EVIDENCE_RECHECK_HOURS <= 0) return;
  try {
    const parsed =
      postTakenAt instanceof Date
        ? postTakenAt
        : postTakenAt
          ? new Date(postTakenAt)
          : null;
    const takenAt =
      parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
    const now = new Date();
    await db
      .insert(likeEvidencePostChecks)
      .values({
        trackedAccountId,
        mediaId,
        ownerUsername,
        postTakenAt: takenAt,
        checkedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          likeEvidencePostChecks.trackedAccountId,
          likeEvidencePostChecks.mediaId,
        ],
        set: { checkedAt: now },
      });
  } catch (err) {
    // Non-fatal: losing one bookkeeping row costs a duplicate read next cycle.
    logger.warn(
      {
        trackedAccountId,
        mediaId,
        err: err instanceof Error ? err.message : String(err),
      },
      "[like-evidence] could not record checked post",
    );
  }
}


async function collectKnownLikerEvidence(account: {
  id: string;
  igUsername: string;
  trackingStarted: Date;
}): Promise<number> {
  const result = await db.execute<{ inserted: number }>(sql`
    WITH inserted AS (
      INSERT INTO ${likeEvents} (
        tracked_account_id,
        post_id,
        owner_username,
        post_type,
        caption,
        thumbnail_url,
        post_url,
        hashtags,
        likes_count,
        comments_count,
        video_view_count,
        location_name,
        post_taken_at,
        detected_at
      )
      SELECT
        ${account.id},
        pc.shortcode,
        owner.ig_username,
        pc.post_type,
        pc.caption,
        COALESCE(pc.display_url, pc.thumbnail_url),
        'https://www.instagram.com/p/' || pc.shortcode || '/',
        pc.hashtags,
        pc.like_count,
        pc.comment_count,
        pc.video_view_count,
        pc.location_name,
        pc.taken_at,
        lc.cached_at
      FROM ${likersCache} lc
      INNER JOIN ${postsCache} pc
        ON pc.shortcode = lc.post_shortcode
      INNER JOIN ${trackedAccounts} owner
        ON owner.id = pc.tracked_account_id
      WHERE LOWER(lc.liker_username) = LOWER(${account.igUsername})
        -- Gate on WHEN WE OBSERVED THE LIKE, not when the post was published.
        -- The old rule (pc.taken_at > trackingStarted) silently discarded every
        -- like on a post older than the tracking start date — but liking a
        -- two-year-old post today is real, current activity the customer wants
        -- to see, and it is exactly the kind of like these users actually make.
        -- Observation date still keeps pre-tracking history out: a liker row
        -- cached before tracking began is backfill, not new activity.
        AND lc.cached_at > ${account.trackingStarted}
        AND NOT EXISTS (
          SELECT 1
          FROM ${likeEvents} existing
          WHERE existing.tracked_account_id = ${account.id}
            AND existing.post_id = pc.shortcode
        )
      ON CONFLICT (tracked_account_id, post_id) DO NOTHING
      RETURNING id
    )
    SELECT COUNT(*)::int AS inserted FROM inserted
  `);

  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: Array<{ inserted: number }> }).rows ?? []);
  return Number(rows[0]?.inserted ?? 0);
}

async function persistLikeEvidenceFromPost(
  account: { id: string; igUsername: string; trackingStarted: Date },
  ownerUsername: string,
  post: {
    shortcode: string;
    postType: string;
    caption: string;
    thumbnailUrl: string;
    displayUrl: string;
    likeCount: number;
    commentCount: number;
    videoViewCount: number | null;
    locationName: string | null;
    hashtags: ReadonlyArray<string>;
    takenAt: Date;
  },
  evidenceSource?: Record<string, unknown>,
): Promise<boolean> {
  if (!post.shortcode) return false;
  if (!isLikedPostAfterTrackingStart(post.takenAt, account.trackingStarted)) {
    return false;
  }

  // D15: race-safe insert. The old check-then-insert (SELECT, then INSERT) let
  // two concurrent workers both pass the existence check and insert duplicate
  // rows. With the UNIQUE(tracked_account_id, post_id) constraint in place we
  // INSERT ... ON CONFLICT DO NOTHING and let the DB arbitrate; `.returning()`
  // yields a row only on a real insert, so its presence tells us whether THIS
  // call was the one that actually inserted (the previous boolean contract).
  const inserted = await db
    .insert(likeEvents)
    .values({
      trackedAccountId: account.id,
      postId: post.shortcode,
      ownerUsername,
      postType: post.postType as typeof likeEvents.$inferInsert.postType,
      caption: post.caption,
      thumbnailUrl: post.displayUrl || post.thumbnailUrl,
      postUrl: `https://www.instagram.com/p/${post.shortcode}/`,
      hashtags: [...post.hashtags],
      likesCount: post.likeCount,
      commentsCount: post.commentCount,
      videoViewCount: post.videoViewCount,
      locationName: post.locationName,
      postTakenAt: post.takenAt,
      detectedAt: new Date(),
      evidenceSource,
    })
    .onConflictDoNothing({
      target: [likeEvents.trackedAccountId, likeEvents.postId],
    })
    .returning({ id: likeEvents.id });
  return inserted.length > 0;
}

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The following-roster row's own ig_user_id, when present and non-blank. First
// choice for the owner-profile hint: the following walk stores it for every
// member, so it covers 100% of owners (resolveKnownIgUserId below covered 23%).
export function rosterIgUserIdHint(
  igUserId: string | null | undefined,
): string | null {
  const id = igUserId?.trim();
  return id && id.length > 0 ? id : null;
}

// Resolve a NON-tracked owner's numeric IG id from data we have ALREADY
// scraped (likers of tracked posts, follower rosters), without spending an IG
// call. When found, the like-scan can fetch the owner's profile through the
// mobile-API /users/<id>/info/ endpoint (a far less throttled bucket) instead
// of web_profile_info, which IG 429s on nearly every request. Returns null when
// the owner has never appeared in our caches — the caller then falls back to a
// username-only fetch. Coverage grows organically as likers_cache fills.
async function resolveKnownIgUserId(username: string): Promise<string | null> {
  const uname = username.trim().toLowerCase();
  if (!uname) return null;
  const result = await db.execute<{ ig_user_id: string }>(sql`
    SELECT ig_user_id FROM (
      SELECT liker_ig_user_id AS ig_user_id, cached_at AS at
      FROM ${likersCache}
      WHERE LOWER(liker_username) = ${uname}
        AND NULLIF(liker_ig_user_id, '') IS NOT NULL
      UNION ALL
      SELECT follower_ig_user_id AS ig_user_id, detected_at AS at
      FROM ${followerEvents}
      WHERE LOWER(follower_username) = ${uname}
        AND NULLIF(follower_ig_user_id, '') IS NOT NULL
    ) ids
    ORDER BY at DESC
    LIMIT 1
  `);
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: Array<{ ig_user_id: string }> }).rows ?? []);
  const id = rows[0]?.ig_user_id;
  return id && id.length > 0 ? id : null;
}

type LikeEvidenceSkipReason = "likers_pool_exhausted";

interface LikeEvidenceScanResult {
  inserted: number;
  ownersScanned: number;
  postsChecked: number;
  errors: number;
  successfulLikerReads: number;
  skippedReason?: LikeEvidenceSkipReason;
}

// Mirrors likersDailyCapOverride() and dailyCapMultiplier() in
// behavior/daily-budget.ts, which are not exported. Unset, blank or invalid
// falls back to 60 (prod's LIKERS_DAILY_CAP). The day-14 tier default is 30, so
// an unset env makes this gate LOOSER, never tighter: a value below the real cap
// would skip scans while bots still had budget (lesson 1's failure mode).
export function likersDailyCapForPreflight(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.LIKERS_DAILY_CAP;
  const parsed = Number(raw === undefined || raw.trim() === "" ? "60" : raw);
  const cap =
    !Number.isFinite(parsed) || parsed < 1
      ? 60
      : Math.min(Math.max(Math.trunc(parsed), 1), 100);
  const multiplier = Number(env.DAILY_CAP_MULTIPLIER ?? "1");
  const scale =
    !Number.isFinite(multiplier) || multiplier < 1 ? 1 : Math.min(multiplier, 10);
  return Math.round(cap * scale);
}

// Web bots that could still serve a likers read today. Once this reaches 0 no
// liker read can succeed anywhere in the pool, yet the hourly scan would still
// visit every owner: spend mobile posts budget, fail on "[daily-budget] ... hit
// daily cap for likers", stamp posts_checked_at (deprioritising the owner) and
// advance the cursor. Measured 2026-09-01 22-23Z: 557 owner visits, 259 liker
// attempts, 0 successes. Fails OPEN: if the count is unreadable we scan as before.
export async function likersCapacityRemaining(): Promise<number> {
  const cap = likersDailyCapForPreflight();
  try {
    const result = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
        FROM bot_accounts b
        LEFT JOIN bot_daily_calls c
          ON c.bot_id = b.id
         AND c.day = (now() AT TIME ZONE 'UTC')::date
         AND c.endpoint = 'likers'
       WHERE b.status = 'available'
         AND b.transport = 'web'
         AND b.session_data IS NOT NULL
         AND (b.cooldown_until IS NULL OR b.cooldown_until < now())
         AND COALESCE(c.count, 0) < ${cap}
    `);
    const rows = Array.isArray(result)
      ? result
      : ((result as { rows?: Array<{ n: number }> }).rows ?? []);
    const remaining = Number(rows[0]?.n);
    if (!Number.isFinite(remaining)) {
      logger.warn(
        { cap },
        "[like-evidence] likers capacity query returned no count; failing open",
      );
      return Number.POSITIVE_INFINITY;
    }
    return remaining;
  } catch (err) {
    logger.warn(
      { cap, err: err instanceof Error ? err.message : String(err) },
      "[like-evidence] likers capacity query failed; failing open",
    );
    return Number.POSITIVE_INFINITY;
  }
}

// Result for a scan that was skipped before touching any owner: no cursor,
// posts_checked_at or owner_profile_checked_at write happened, so every counter
// is 0 and the likes worker's "no readable candidate posts" branch treats it as
// a clean no-op. Exported for tests.
export function buildSkippedScanResult(
  reason: LikeEvidenceSkipReason,
): LikeEvidenceScanResult {
  return {
    inserted: 0,
    ownersScanned: 0,
    postsChecked: 0,
    errors: 0,
    successfulLikerReads: 0,
    skippedReason: reason,
  };
}

/** Why the owner loop stopped early: wall-clock budget or process shutdown (C4). */
type LikeEvidenceStopReason = "budget" | "shutdown" | "capacity";

function logScanCoverage(
  account: { id: string; igUsername: string },
  fields: LikeEvidenceScanResult & {
    skippedAlreadyChecked?: number;
    ownerProfileCacheHits?: number;
    durationMs?: number;
    stoppedEarly?: boolean;
    stopReason?: LikeEvidenceStopReason | null;
    ownersPrivate?: number;
    ownersNoCandidates?: number;
    // Which rotation drove this window, how many owners were DUE (activity:
    // after the revisit filter), how many the window held, how many failed
    // owners were stamped as visited, and how many first-visit profile hints
    // came from the roster row rather than the caches.
    rotation?: LikeEvidenceRotation;
    rosterDue?: number;
    windowSize?: number;
    ownersDeferred?: number;
    ownerIdFromRoster?: number;
  },
): void {
  logger.info(
    { trackedAccountId: account.id, igUsername: account.igUsername, ...fields },
    "[like-evidence] scan coverage",
  );
}

// Pre-flight for the following-scan. Returns the result to hand back when the
// likers pool is exhausted for the day, else null (proceed with the scan).
async function skippedResultIfLikersExhausted(
  account: { id: string; igUsername: string },
  inserted: number,
): Promise<LikeEvidenceScanResult | null> {
  if ((await likersCapacityRemaining()) > 0) return null;
  logger.info(
    { trackedAccountId: account.id, igUsername: account.igUsername },
    "[like-evidence] skipping scan: likers pool exhausted for today",
  );
  // The known-liker pass is DB-only (no IG call) and has already run, so its
  // inserts are reported honestly; every scan counter stays 0.
  const skipped = { ...buildSkippedScanResult("likers_pool_exhausted"), inserted };
  logScanCoverage(account, skipped);
  return skipped;
}

async function collectRelationshipLikeEvidence(account: {
  id: string;
  igUsername: string;
  likeEvidenceCursor: number;
  trackingStarted: Date;
}): Promise<LikeEvidenceScanResult> {
  let inserted = await collectKnownLikerEvidence(account);
  let ownersScanned = 0;
  let ownersPrivate = 0;
  let ownersNoCandidates = 0;
  let postsChecked = 0;
  let errors = 0;
  let successfulLikerReads = 0;
  let ownerProfileCacheHits = 0;
  let ownerIdFromRoster = 0;
  // Owners whose visit failed before a posts fetch succeeded; stamped after the
  // loop (deferFailedOwners) unless the window was an outage.
  const deferredOwners: string[] = [];

  if (LIKE_EVIDENCE_FOLLOWING_SCAN_LIMIT <= 0) {
    return {
      inserted,
      ownersScanned,
      postsChecked,
      errors,
      successfulLikerReads,
    };
  }

  // Skip the whole owner walk when no web bot can read likers today. Nothing
  // below runs, so like_evidence_cursor, posts_checked_at and
  // owner_profile_checked_at are all left untouched for the next cycle.
  const skipped = await skippedResultIfLikersExhausted(account, inserted);
  if (skipped) return skipped;

  // Posts whose likers we already read recently for THIS tracked account.
  // Loaded once per scan (one query) rather than per owner, then used to push
  // each owner's selection further down its candidate list.
  const recentlyChecked = await loadRecentlyCheckedMediaIds(account.id);
  const knownPositivePosts = new Set((await db.select({ postId: likeEvents.postId })
    .from(likeEvents).where(eq(likeEvents.trackedAccountId, account.id))).map((r) => r.postId));
  let skippedAlreadyChecked = 0;

  const roster = await loadFollowingEvidenceRoster(account.id);
  const following = roster.items;
  // Window scales with the roster so large-following accounts are not starved
  // of coverage (the reason they reported zero liked posts). In "activity"
  // rotation `following` is already the DUE list — least recently visited
  // first, owners inside LIKE_EVIDENCE_REVISIT_HOURS left out — so the window
  // is its head and the scan limit is sized from the due count; the cursor
  // only rotates the plain-order fallback.
  const scanLimit = resolveLikeEvidenceScanLimit(following.length);
  const window = selectLikeEvidenceWindow(
    following,
    account.likeEvidenceCursor,
    scanLimit,
    roster.rotation,
  );
  const targetLower = account.igUsername.toLowerCase();

  const scanStartedAt = Date.now();
  let ownersCompleted = 0;
  let stoppedEarly = false;
  let stopReason: LikeEvidenceStopReason | null = null;

  scanOwners: for (const owner of window.items) {
    // Deploy safety (C4): a scan may run up to LIKE_EVIDENCE_MAX_SCAN_MS
    // (600 s in prod) while the shutdown drain budget is 170 s. Yield between
    // owners; the bookkeeping below is exactly the budget-stop path — in
    // "activity" rotation the cursor is only an odometer, in "cursor" rotation
    // it advances past the owners genuinely finished.
    if (isShuttingDown()) {
      stoppedEarly = true;
      stopReason = "shutdown";
      logger.warn(
        {
          trackedAccountId: account.id,
          igUsername: account.igUsername,
          ownersCompleted,
          ownersPlanned: window.items.length,
          elapsedMs: Date.now() - scanStartedAt,
        },
        "[like-evidence] scan stopped for process shutdown; persisting partial progress so the rotation still advances",
      );
      break;
    }
    if (Date.now() - scanStartedAt > LIKE_EVIDENCE_MAX_SCAN_MS) {
      stoppedEarly = true;
      stopReason = "budget";
      logger.warn(
        {
          trackedAccountId: account.id,
          igUsername: account.igUsername,
          ownersCompleted,
          ownersPlanned: window.items.length,
          budgetMs: LIKE_EVIDENCE_MAX_SCAN_MS,
        },
        "[like-evidence] scan budget exhausted; persisting partial progress so the rotation still advances",
      );
      break;
    }
    const ownerUsername = owner.username;
    if (!ownerUsername || ownerUsername.toLowerCase() === targetLower) {
      ownersCompleted += 1;
      continue;
    }
    ownersScanned += 1;

    try {
      // Route the owner profile fetch through the mobile-API /info/ endpoint
      // when we can resolve the numeric id from caches we already own — it is a
      // far less throttled bucket than web_profile_info, so the like-scan stops
      // dying on owner-profile 429s (the previous bottleneck that kept
      // like_events sparse). Falls back to a username-only fetch when unknown.
      // The profile call exists only to learn isPrivate + igUserId, and both
      // are stable for days. Re-fetching them every cycle was ~4,400 mobile
      // profile calls a day — the single biggest consumer of the profile
      // budget, capping most of the mobile pool by early afternoon while the
      // actual tracked-account refreshes then failed on "daily cap". Same
      // loophole family as re-reading liker lists we had already read.
      const cached = resolveOwnerProfileFromCache(owner, Date.now());
      let ownerIsPrivate: boolean;
      let ownerIgUserId: string;
      if (cached) {
        ownerProfileCacheHits += 1;
        ownerIsPrivate = cached.isPrivate;
        ownerIgUserId = cached.igUserId;
      } else {
        // The roster row carries ig_user_id for 100% of following members (the
        // following walk stores it), so it is the first choice for the hint.
        // resolveKnownIgUserId (likers_cache / follower_events) resolved only
        // 23% of first visits; the other 77% went username-only to the
        // 429-prone web_profile_info path.
        const rosterOwnerId = rosterIgUserIdHint(owner.igUserId);
        if (rosterOwnerId) ownerIdFromRoster += 1;
        const cachedOwnerId =
          rosterOwnerId ?? (await resolveKnownIgUserId(ownerUsername));
        const profile = await getPublicProfile(ownerUsername, cachedOwnerId);
        if (!profile.ok) {
          errors += 1;
          if (isCapacityUnavailable(profile.error)) {
            stoppedEarly = true;
            stopReason = "capacity";
            break;
          }
          deferredOwners.push(ownerUsername);
          continue;
        }
        void recordOwnerProfileVerdict(
          account.id,
          ownerUsername,
          profile.data.isPrivate,
          profile.data.igUserId ?? null,
        );
        if (!profile.data.igUserId) {
          deferredOwners.push(ownerUsername);
          continue;
        }
        ownerIsPrivate = profile.data.isPrivate;
        ownerIgUserId = profile.data.igUserId;
      }
      if (ownerIsPrivate) {
        ownersPrivate++;
        continue;
      }

      const posts = await getUserPosts(
        ownerUsername,
        ownerIgUserId,
        LIKE_EVIDENCE_POST_CANDIDATES,
      );
      if (!posts.ok) {
        errors += 1;
        if (isCapacityUnavailable(posts.error)) {
          stoppedEarly = true;
          stopReason = "capacity";
          break;
        }
        deferredOwners.push(ownerUsername);
        continue;
      }

      // Feed the rotation: note whether this owner posts at all, and how
      // recently, so the next cycle can favour active accounts.
      const newestPostAt = posts.data.reduce<Date | null>((newest, p) => {
        if (!p.takenAt) return newest;
        const t = new Date(p.takenAt);
        if (!Number.isFinite(t.getTime())) return newest;
        return newest === null || t > newest ? t : newest;
      }, null);

      // Spend the scarce likers budget only where a match is actually
      // detectable: drop posts whose like count exceeds the visible-liker
      // ceiling, then take the least-liked remaining posts.
      const freshCutoffMs =
        LIKE_EVIDENCE_MAX_POST_AGE_HOURS > 0
          ? Date.now() - LIKE_EVIDENCE_MAX_POST_AGE_HOURS * 3_600_000
          : 0;
      // FAIL CLOSED on unknown metadata.
      //
      // Both filters used to treat a missing field as "pass" (`likeCount ?? 0`
      // and `!p.takenAt ||`). Posts whose metadata did not parse therefore
      // skipped BOTH guards and, with takenAt absent, sorted as timestamp 0.
      // The scan quietly filled up with exactly the posts we least want:
      // measured after the change, scanned posts averaged 362 days old with
      // 20,675 likes (vs 20 days / 4,424 before), returning ~6 visible likers —
      // odds of spotting a tracked user round to zero.
      //
      // A post we cannot date or size is a post we cannot judge, so skip it and
      // spend the scarce, ban-expensive liker read on one we can.
      const candidates = posts.data
        .filter((p) => {
          const likes = p.likeCount;
          if (typeof likes !== "number") return false;
          return LIKE_EVIDENCE_MAX_POST_LIKES <= 0 || likes <= LIKE_EVIDENCE_MAX_POST_LIKES;
        })
        .filter((p) => {
          if (!p.takenAt) return false;
          const t = new Date(p.takenAt).getTime();
          if (!Number.isFinite(t) || t <= 0) return false;
          return freshCutoffMs <= 0 || t >= freshCutoffMs;
        })
        .slice()
        // Order by RECENCY, not by fewest likes.
        //
        // The previous ascending like-count sort was meant to maximise
        // liker-list visibility, but it selected the oldest / least popular
        // posts in the window — precisely the posts nobody has just liked. A
        // tracked user's new likes land on recently published content, which
        // naturally carries MORE likes. The result was 104 successful liker
        // reads in one hour producing zero detections.
        //
        // Visibility is already protected by LIKE_EVIDENCE_MAX_POST_LIKES
        // (posts above the returned-liker ceiling are dropped above), so within
        // the surviving candidates the newest post is the best bet.
        .sort((a, b) => {
          const at = a.takenAt ? new Date(a.takenAt).getTime() : 0;
          const bt = b.takenAt ? new Date(b.takenAt).getTime() : 0;
          return bt - at;
        });

      if (candidates.length === 0) ownersNoCandidates++;
      // Drop posts already read for this account inside the recheck window, so
      // the per-owner budget lands on posts this scan has NOT seen. This is the
      // difference between re-confirming the same negative every cycle and
      // actually advancing through the owner's catalogue.
      const unchecked = candidates.filter((p) => {
        if (shouldReadLikeCandidate(p, knownPositivePosts, recentlyChecked)) return true;
        skippedAlreadyChecked += 1;
        return false;
      });

      let batchViewerBotId: string | undefined;
      for (const post of unchecked.slice(0, LIKE_EVIDENCE_POSTS_PER_OWNER)) {
        if (!post.shortcode || !post.mediaId) continue;
        postsChecked += 1;

        const likers = await getPostLikers(post.shortcode, post.mediaId, {
          targetUsername: account.igUsername,
          viewerBotId: targetCanaryEnabled("LIKER_BATCH_VIEWER_TARGETS", account.igUsername) ? batchViewerBotId : undefined,
        });
        if (!likers.ok) {
          errors += 1;
          if (isCapacityUnavailable(likers.error)) {
            stoppedEarly = true;
            stopReason = "capacity";
            break scanOwners;
          }
          continue;
        }
        successfulLikerReads += 1;
        batchViewerBotId = likers.observation?.botId;

        // The paid-for visible list can contain OTHER tracked targets too.
        // Reuse only positive sightings, never a cross-viewer negative cache.
        const visibleNames = [...new Set(likers.data.map(u => u.username?.toLowerCase()).filter(Boolean))];
        if (visibleNames.length) {
          const matchingAccounts = await db.select({ id: trackedAccounts.id, igUsername: trackedAccounts.igUsername,
            trackingStarted: trackedAccounts.trackingStarted, userId: trackedAccounts.userId })
            .from(trackedAccounts).where(and(eq(trackedAccounts.isActive, true), customerAccessSql(trackedAccounts.userId),
              inArray(sql`lower(${trackedAccounts.igUsername})`, visibleNames)));
          for (const matchedAccount of matchingAccounts) {
            const didInsert = await persistLikeEvidenceFromPost(matchedAccount, ownerUsername, post,
              { ...likers.observation, source: "browser_liker_sighting", coverage: "visible_sample" });
            if (matchedAccount.id === account.id) {
              if (didInsert) inserted += 1;
              knownPositivePosts.add(post.shortcode);
            } else if (didInsert) {
              // Preserve notification behavior for evidence discovered by another target's scan.
              await createNotification({ userId: matchedAccount.userId, type: "new_like",
                title: "New liked post", body: `New liked-post evidence for @${matchedAccount.igUsername}`,
                dedupeKey: `like:${matchedAccount.id}:${post.shortcode}` });
            }
          }
        }
        // Record only SUCCESSFUL reads. A failed read learned nothing about
        // this post, so suppressing it would silently blind the scan to it for
        // the whole recheck window.
        recentlyChecked.add(post.mediaId);
        await recordLikeEvidencePostCheck(
          account.id,
          post.mediaId,
          ownerUsername,
          post.takenAt ?? null,
        );
      }
      // Only advance owner freshness after all due candidate reads were attempted.
      // A capacity stop above leaves this owner due at the next unchanged tick.
      await recordOwnerPostActivity(account.id, ownerUsername, newestPostAt);
    } catch (err) {
      errors += 1;
      logger.warn(
        {
          igUsername: account.igUsername,
          ownerUsername,
          err: err instanceof Error ? err.message : String(err),
        },
        "relationship-like evidence scan owner failed",
      );
      deferredOwners.push(ownerUsername);
    }

    ownersCompleted += 1;
    await sleepMs(LIKE_EVIDENCE_OWNER_DELAY_MS);
  }

  // "cursor" rotation: advance only past the owners we genuinely finished —
  // claiming the whole window after an early stop would skip owners that were
  // never looked at. "activity" rotation: odometer (see the helper).
  const advancedCursor = resolveLikeEvidenceAdvancedCursor({
    rotation: window.rotation,
    currentCursor: account.likeEvidenceCursor,
    windowStart: window.start,
    windowNextCursor: window.nextCursor,
    ownersCompleted,
    ownersScanned,
    stoppedEarly,
    rosterSize: following.length,
  });

  // Dead owners must not pin the "activity" window (see deferFailedOwners).
  // Skipped on an outage: a window where every owner failed before a single
  // liker read was never really looked at and must lead the next cycle — the
  // same reason likeEvidenceProgressUpdate holds the cursor for it.
  const listingOutage = isLikeEvidenceListingOutage(postsChecked, errors, ownersScanned);
  const ownersDeferred =
    window.rotation === "activity" && !listingOutage ? deferredOwners.length : 0;
  if (ownersDeferred > 0) await deferFailedOwners(account.id, deferredOwners);

  await db
    .update(trackedAccounts)
    .set(
      likeEvidenceProgressUpdate(
        account.likeEvidenceCursor,
        advancedCursor,
        successfulLikerReads,
        new Date(),
        postsChecked,
        errors,
        ownersScanned,
      ),
    )
    .where(eq(trackedAccounts.id, account.id));

  logScanCoverage(account, {
    durationMs: Date.now() - scanStartedAt,
    ownersPrivate,
    ownersNoCandidates,
    stoppedEarly,
    stopReason,
    inserted,
    ownersScanned,
    postsChecked,
    errors,
    successfulLikerReads,
    skippedAlreadyChecked,
    ownerProfileCacheHits,
    rotation: window.rotation,
    rosterDue: following.length,
    windowSize: window.items.length,
    ownersDeferred,
    ownerIdFromRoster,
  });

  return {
    inserted,
    ownersScanned,
    postsChecked,
    errors,
    successfulLikerReads,
  };
}

function createLikesWorker(): Worker {
  return new Worker(
    "collection-likes",
    async (job: Job) => {
      const { trackedAccountId } = job.data as { trackedAccountId: string };
      return withCorrelation(
        { module: "worker:likes", trackedAccountId, jobId: String(job.id ?? "") },
        async () => {
      logger.info("processing likes job");

      try {
        const [account] = await db
          .select()
          .from(trackedAccounts)
          .where(eq(trackedAccounts.id, trackedAccountId))
          .limit(1);

        if (!account) throw new Error(`Tracked account ${trackedAccountId} not found`);
        if (!account.isActive || !await customerHasAccess(account.userId)) {
          logger.info(
            { igUsername: account.igUsername },
            "likes job skipped: tracked account inactive",
          );
          return;
        }

        // Relationship-based liked-post evidence: if any known post's cached
        // liker list contains this tracked username, that is a real observed
        // "target liked post" signal. Do not use target-owned feed as a proxy;
        // that fabricates liked history.
        //
        // Wrapped in the scrape context so the bandwidth meter attributes this
        // scan's IG reads to the profile that ordered them. It is by far the
        // heaviest consumer in the pipeline (every owner visit is a posts call,
        // every candidate post a liker read), and running it outside any context
        // is why ~90% of metered traffic landed in the "— system —" bucket and
        // the per-profile table looked almost empty.
        const result = await withScrapeContext(
          {
            userId: account.userId,
            trackedAccountId,
            username: account.igUsername,
          },
          () => collectRelationshipLikeEvidence(account),
        );
        // An error while merely LISTING an owner (profile/posts fetch) must not
        // fail a cycle that never got as far as a liker read: one flaky owner
        // out of ~30 was enough to fail the whole job and freeze the cursor.
        // Only a cycle that attempted liker reads and got nothing back is an
        // outage.
        if (result.successfulLikerReads <= 0 && result.postsChecked > 0) {
          throw new Error(
            `relationship liker evidence unavailable: 0 successful liker reads (${result.errors} upstream errors)`,
          );
        }
        // A window where every owner errored before a liker read is a listing
        // outage (lease failure, DB, proxy), not an empty window. Fail the job
        // so it is visible as failed jobs; the progress rule has already held
        // the cursor for the same condition.
        if (
          result.successfulLikerReads <= 0 &&
          isLikeEvidenceListingOutage(
            result.postsChecked,
            result.errors,
            result.ownersScanned,
          )
        ) {
          throw new Error(
            `relationship liker evidence unavailable: every owner errored before a liker read (${result.errors} errors across ${result.ownersScanned} owners, 0 posts checked)`,
          );
        }
        if (result.successfulLikerReads <= 0) {
          logger.info(
            { igUsername: account.igUsername, ...result },
            "relationship liker evidence scan had no readable candidate posts",
          );
          return result;
        }
        logger.info(
          { igUsername: account.igUsername, ...result },
          "relationship liker evidence scan complete",
        );
        return result;
      } catch (err) {
        logger.error({ err }, "likes job error");
        throw err;
      }
        },
      );
    },
    {
      connection: createRedisConnection(),
      // Was a hard-coded 1: nine hourly scans of up to LIKE_EVIDENCE_MAX_SCAN_MS
      // each ran back to back (avg 212 s, max 434 s on 2026-09-02), so the round
      // took ~32 min and the next sweep found the tail still inside its 30-min
      // dedupe window — 104 of 216 sweep enqueues were "throttled" that day
      // (~4.6 scans/hour instead of 9) while 66 web bots sat idle.
      // COLLECTION_LIKES_CONCURRENCY (default 1, max 6).
      concurrency: Math.min(
        Math.max(Number(process.env.COLLECTION_LIKES_CONCURRENCY ?? "1") || 1, 1),
        6,
      ),
      limiter: COLLECTION_LIKES_LIMITER,
      ...LONG_JOB_STALL_OPTIONS,
    },
  );
}

// ─── Worker: collection-follows ───────────────────────────────────────────────
// Wave 2 task D: rate-limited (IG follow-list pages are the heaviest calls).

function createFollowsWorker(): Worker {
  return new Worker(
    "collection-follows",
    async (job: Job) => {
      const { trackedAccountId } = job.data as { trackedAccountId: string };
      return withCorrelation(
        { module: "worker:follows", trackedAccountId, jobId: String(job.id ?? "") },
        async () => {
      logger.info("processing follows job");

      try {
        const [account] = await db
          .select()
          .from(trackedAccounts)
          .where(eq(trackedAccounts.id, trackedAccountId))
          .limit(1);

        if (!account) throw new Error(`Tracked account ${trackedAccountId} not found`);
        if (!account.isActive || !await customerHasAccess(account.userId)) {
          logger.info(
            { igUsername: account.igUsername },
            "follows job skipped: tracked account inactive",
          );
          return;
        }

        // Skip collection for private accounts without access
        if (account.isPrivate && account.accessStatus !== "has_access") {
          logger.info(
            { igUsername: account.igUsername },
            "skipping private account (no access yet)",
          );
          return;
        }

        // Keep private roster persistence on the same cursor/completeness
        // pipeline as profile collection. The legacy bot diff only wrote
        // events and left the roster used by the UI and like scans stale.
        if (account.isPrivate && account.accessStatus === "has_access") {
          await collectionProfileQueue.add("collect-profile", {
            trackedAccountId,
            force: true,
            source: "private-roster-refresh",
          });
          return;
        }

        // Public account: outbound following list is scraped via the public
        // scraper as part of the profile worker's public-data collection
        // (see collectPublicData → persistFollowingDiff). We do NOT re-run
        // it here — this branch intentionally no-ops for public accounts to
        // avoid double scraping. Private-with-access schedules that same
        // approved-bot collection pipeline above.
        logger.info(
          { igUsername: account.igUsername },
          "public account: follows captured by profile worker; skipping",
        );
      } catch (err) {
        logger.error({ err }, "follows job error");
        throw err;
      }
        },
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
      limiter: COLLECTION_IG_LIMITER,
    },
  );
}

// ─── Worker: report-generate ──────────────────────────────────────────────────

function createReportWorker(): Worker {
  return new Worker(
    "report-generate",
    async (job: Job) => {
      const { reportId, deliver } = job.data as {
        reportId: string;
        deliver?: boolean;
      };
      return withCorrelation(
        { module: "worker:report", reportId, jobId: String(job.id ?? "") },
        async () => {
      logger.info("generating report");

      let stats: ReportStats | null = null;
      try {
        const [report] = await db
          .select()
          .from(reports)
          .where(eq(reports.id, reportId))
          .limit(1);

        if (!report) throw new Error(`Report ${reportId} not found`);

        const [account] = await db
          .select()
          .from(trackedAccounts)
          .where(eq(trackedAccounts.id, report.trackedAccountId))
          .limit(1);

        if (!account) throw new Error(`Account not found for report ${reportId}`);
        if (!account.isActive || (account.isPrivate && account.accessStatus !== "has_access") || !await customerHasAccess(account.userId)) {
          await db.update(reports).set({ status: "failed" }).where(eq(reports.id, reportId));
          return;
        }

        stats = await computeReportStats(
          report.trackedAccountId,
          account.trackingStarted,
          report.periodStart,
          report.periodEnd,
          report.type,
        );

        const delivery = await persistReadyReport(reportId,stats,deliver===true);
        // Push is an optional nudge; the durable notification already exists.
        if (delivery.notification) void createNotification({...delivery.notification,skipInsert:true}).catch(() => {});
        if (delivery.emailId) {
          // A failed wake-up does not lose the PostgreSQL intent: the recurring
          // outbox worker will claim it on the next tick.
          await emailSendQueue.add("transactional-outbox",{emailId:delivery.emailId},
            {jobId:`report-email-${reportId}`}).catch(error => logger.warn({reportId,errorType:error instanceof Error?error.name:"unknown"},"report email wake-up unavailable; outbox retained"));
        }

        logger.info("report completed");
      } catch (err) {
        logger.error({ err }, "report error");
        await db.update(reports)
          .set({ status: "failed" })
          .where(eq(reports.id, reportId)).catch(() => {});
        throw err;
      }


        },
      );
    },
    { connection: createRedisConnection(), concurrency: 3 },
  );
}

// ─── Worker: email-send ───────────────────────────────────────────────────────

function createEmailWorker(): Worker {
  return new Worker("email-send",async (job:Job) => {
    if (job.name==="transactional-outbox") {
      if (!job.data.emailId) await recordDueTrialEndingEmails();
      return flushTransactionalEmails(5,job.data.emailId);
    }
    // Drain jobs created by the previous release through the same durable
    // report path. Preserve their provider body/key and retry age.
    const {userId,reportId,to,subject,html,text} = job.data;
    if (!userId || !reportId || typeof to!=="string" || typeof subject!=="string" || typeof html!=="string") {
      throw new Error("Unsupported email job");
    }
    const firstAttemptAt = job.attemptsMade>0 ? new Date(job.timestamp) : undefined;
    const emailId = await recordReportEmail(db,userId,reportId,{firstAttemptAt,
      delivery:{to,subject,html,...(text===undefined?{}:{text}),from:process.env.EMAIL_FROM??"notifications@cheaterfinder.com"}});
    return flushTransactionalEmails(1,emailId);
  },{connection:createRedisConnection(),concurrency:2});
}

function scheduleTransactionalEmailDelivery(): void {
  emailSendQueue.add("transactional-outbox", {}, {
    repeat: { every: 30_000, jobId: "transactional-outbox-recurring" },
  }).catch(error => logger.error({ errorType: error instanceof Error ? error.name : "unknown" }, "email outbox scheduler unavailable"));
}

// ─── Worker: weekly-report sweep ──────────────────────────────────────────────

function createWeeklyReportWorker(): Worker {
  return new Worker(
    "weekly-report",
    async (job: Job) =>
      withCorrelation(
        { module: "worker:weekly-report", jobId: String(job.id ?? "") },
        async () => {
          const {periodStart,periodEnd} = scheduledWeeklyWindow(job.timestamp,job.opts.prevMillis,job.opts.repeat?.offset ?? 0);

          // Every active tracked account gets a fresh weekly report this sweep.
          const accounts = await db
            .select({ id: trackedAccounts.id })
            .from(trackedAccounts)
            .where(and(eq(trackedAccounts.isActive, true), sql`(${trackedAccounts.isPrivate}=false OR ${trackedAccounts.accessStatus}='has_access')`, customerAccessSql(trackedAccounts.userId)));

          logger.info({ accountCount: accounts.length }, "weekly report sweep started");

          let enqueued = 0, failed = 0;
          for (const account of accounts) {
            try {
              const [newReport] = await db
                .insert(reports)
                .values({
                  id: scheduledReportId(account.id,periodEnd),
                  trackedAccountId: account.id,
                  type: "weekly",
                  periodStart,
                  periodEnd,
                  status: "generating",
                })
                .onConflictDoNothing()
                .returning({ id: reports.id });
              const reportId = newReport?.id ?? scheduledReportId(account.id,periodEnd);
              const [existing] = await db.select({status:reports.status}).from(reports).where(eq(reports.id,reportId)).limit(1);
              if (existing?.status === "ready") continue;
              await reportGenerateQueue.add("generate-report", {
                reportId,
                deliver: true,
              },{jobId:`scheduled-report-${reportId}`});
              enqueued += 1;
            } catch (err) {
              // Finish the batch, then retry only missing work with stable IDs.
              failed++;
              logger.error(
                { trackedAccountId: account.id, err },
                "weekly report enqueue failed for account",
              );
            }
          }

          if (failed) throw new Error(`Weekly report enqueue incomplete for ${failed} accounts`);
          logger.info({ enqueued, total: accounts.length }, "weekly report sweep complete");
          return { enqueued, total: accounts.length };
        },
      ),
    { connection: createRedisConnection(), concurrency: 1 },
  );
}

// ─── Worker: bot-follow-request ───────────────────────────────────────────────

function createBotFollowRequestWorker(): Worker {
  return new Worker(
    "bot-follow-request",
    async (job: Job) => {
      const { botFollowRequestId } = job.data as { botFollowRequestId: string };
      return withCorrelation(
        { module: "worker:bot-follow", botFollowRequestId, jobId: String(job.id ?? "") },
        async () => {
      logger.info("processing follow request");
      const requeueDeferred = (delay: number) => botFollowRequestQueue.add(
        "send-follow",
        { botFollowRequestId },
        {
          delay,
          // A cooldown must not reset a partially consumed failure budget.
          attempts: Math.max(1, (job.opts?.attempts ?? 2) - (job.attemptsMade ?? 0)),
          ...(job.opts?.backoff ? { backoff: job.opts.backoff } : {}),
        },
      );

      try {
        const [request] = await db
          .select()
          .from(botFollowRequests)
          .where(eq(botFollowRequests.id, botFollowRequestId))
          .limit(1);

        if (!request) throw new Error(`Follow request ${botFollowRequestId} not found`);

        // A retry after acceptance may only recover collection scheduling.
        // Never repeat an already-confirmed external follow.
        if (request.status === "accepted" && await trackedAccountHasAccess(request.trackedAccountId)) {
          await collectionProfileQueue.add("collect-profile", {
            trackedAccountId: request.trackedAccountId, force: true, source: "private-access-granted",
          }, { jobId: `private-access-${botFollowRequestId}` });
          return;
        }
        // Fix #11: if the follow request is not "queued", return early (BullMQ retry guard)
        if (request.status !== "queued") {
          logger.info(
            { status: request.status },
            "follow request not queued, skipping",
          );
          return;
        }

        const [bot] = await db
          .select()
          .from(botAccounts)
          .where(eq(botAccounts.id, request.botAccountId))
          .limit(1);

        if (!bot) throw new Error(`Bot account ${request.botAccountId} not found`);

        const [trackedAccount] = await db
          .select()
          .from(trackedAccounts)
          .where(eq(trackedAccounts.id, request.trackedAccountId))
          .limit(1);

        if (!trackedAccount) throw new Error(`Tracked account ${request.trackedAccountId} not found`);
        if (!(await trackedAccountHasAccess(trackedAccount.id))) {
          await markFollowRequestFailed(botFollowRequestId, "Tracking access ended");
          return;
        }

        if (bot.cooldownUntil && new Date(bot.cooldownUntil).getTime() > Date.now()) {
          await requeueDeferred(new Date(bot.cooldownUntil).getTime() - Date.now());
          return;
        }

        // The runtime resolves an assigned fixed proxy without persisting it in
        // proxy_endpoint. Carry its session, proxy and browser identity together.
        const runtime = await ensureBotReady(request.botAccountId);
        const [readyBot] = await db
          .select()
          .from(botAccounts)
          .where(eq(botAccounts.id, request.botAccountId))
          .limit(1);
        const followBot = readyBot ?? bot;
        if (!(await trackedAccountHasAccess(trackedAccount.id))) {
          await markFollowRequestFailed(botFollowRequestId, "Tracking access ended");
          return;
        }

        // Real IG HTTP call using the bot's stored Playwright session cookies.
        const outcome = await withCorrelation(
          {
            botAccountId: followBot.id,
            trackedAccountId: trackedAccount.id,
          },
          () => sendFollowForRequest(botFollowRequestId, followBot, trackedAccount, runtime),
        );
        if (outcome.kind === "accepted" && await trackedAccountHasAccess(trackedAccount.id)) {
          // Approval unlocks the entire accepted-bot collector, including
          // posts, stories, highlights and both rosters. A recent public-only
          // snapshot must not suppress this first private content pass.
          await collectionProfileQueue.add("collect-profile", {
            trackedAccountId: trackedAccount.id,
            force: true,
            source: "private-access-granted",
          }, { jobId: `private-access-${botFollowRequestId}` });
        }
        // Wave 3: "deferred" means the bot is currently ineligible (asleep,
        // warming up, or fleet throttled). Re-queue with the suggested delay
        // so we don't burn retries and don't mark the request failed.
        if (outcome.kind === "deferred" && await trackedAccountHasAccess(trackedAccount.id)) {
          logger.info(
            { reason: outcome.reason, retryAfterMs: outcome.retryAfterMs },
            "bot-follow deferred, requeuing",
          );
          await requeueDeferred(outcome.retryAfterMs);
          return;
        }
        logger.info({ outcome: outcome.kind }, "bot-follow outcome");
      } catch (err) {
        // Upstream throttling/circuit failures may retry, but a terminal queue
        // failure must also stop the DB request and expose the Retry action.
        if (err instanceof IGRateLimitedError || err instanceof IGCircuitOpenError) {
          const attempts = Math.max(1, job.opts?.attempts ?? 1);
          const exhausted = (job.attemptsMade ?? 0) + 1 >= attempts;
          if (exhausted) {
            await markFollowRequestFailed(botFollowRequestId,
              err instanceof IGRateLimitedError
                ? "Instagram rate limit; follow retries exhausted"
                : "Instagram temporarily unavailable; follow retries exhausted");
          }
          logger.warn({ exhausted }, "follow temporarily unavailable");
          throw err;
        }
        logger.error({ err }, "bot-follow error");
        await markFollowRequestFailed(
          botFollowRequestId,
          err instanceof Error ? err.message : "Unknown error",
        );
        throw err;
      }
        },
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 2,
      limiter: BOT_FOLLOW_LIMITER,
    },
  );
}

// ─── Worker: bot-follow-check ────────────────────────────────────────────────

// Discriminated result for the follow-acceptance probe. We don't use a raw
// boolean because we want to log scrape failures distinctly from "scrape
// succeeded but the profile is still private/inaccessible to this bot".
type FollowAcceptanceProbe =
  | { readonly kind: "accepted" }
  | { readonly kind: "not_yet" }
  | { readonly kind: "error"; readonly error: string };

/**
 * Check owner approval through the requesting bot's saved session using the
 * tracked account's stable Instagram ID. Resolve a profile only for legacy
 * rows without an ID. Errors leave the request pending for the next check.
 */
async function probeFollowAcceptance(
  req: { id: string; trackedUsername: string; botAccountId: string; trackedAccountId: string },
): Promise<FollowAcceptanceProbe> {
  let accessEnded = false;
  const beforeRead = async () => {
    if (!(await privateFollowRequestCanProbe(req.id, req.trackedAccountId, req.botAccountId))) {
      accessEnded = true;
      throw new Error("Tracking access or pending follow request ended");
    }
  };
  try {
    await beforeRead();
    const [tracked] = await db.select({ igUserId: trackedAccounts.igUserId })
      .from(trackedAccounts).where(eq(trackedAccounts.id, req.trackedAccountId)).limit(1);
    let targetPk = tracked?.igUserId;
    if (!targetPk || !/^\d+$/.test(targetPk)) {
      // Even legacy identity lookup stays on the requesting viewer. A now
      // public profile alone never proves that this bot's follow was accepted.
      const profile = await scrapeProfileWithBot(req.botAccountId, req.trackedUsername);
      targetPk = profile.igUserId;
    }
    if (!targetPk || !/^\d+$/.test(targetPk)) {
      return { kind: "error", error: "[probe] tracked profile missing numeric igUserId" };
    }
    await beforeRead();
    const status = await scrapeFriendshipStatusWithBot(req.botAccountId, targetPk, beforeRead);
    await beforeRead();
    if (status.following && !status.outgoingRequest) return { kind: "accepted" };
    return { kind: "not_yet" };
  } catch (err: unknown) {
    if (accessEnded) return { kind: "not_yet" };
    const message = err instanceof Error ? err.message : "unknown scrape error";
    return { kind: "error", error: message };
  }
}

function createBotFollowCheckWorker(): Worker {
  return new Worker(
    "bot-follow-check",
    async (job: Job) => {
      return withCorrelation(
        { module: "worker:bot-check", jobId: String(job.id ?? "") },
        async () => {
      logger.info("checking pending follow requests");

      try {
        await cancelIneligibleFollowRequests();
        await reconcilePrivateAccessCollections(collectionProfileQueue);
        await reconcilePrivateFollowCoverage(botFollowRequestQueue);
        // Check for expired requests first
        const expired = await getExpiredFollowRequests();
        for (const req of expired) {
          if (!(await trackedAccountHasAccess(req.trackedAccountId))) {
            await markFollowRequestFailed(req.id, "Tracking access ended");
            continue;
          }
          logger.info(
            { botFollowRequestId: req.id, trackedAccountId: req.trackedAccountId },
            "follow request expired, rotating bot",
          );
          // Only the worker that atomically expires and releases this request
          // can rotate it. Concurrent checks/cancellation must not duplicate work.
          if (!(await markFollowRequestExpired(req.id))) continue;
          const newRequestId = await rotateBotForTrackedAccount(req.trackedAccountId);
          if (newRequestId) {
            const delay = Math.floor(Math.random() * 90000) + 30000;
            await botFollowRequestQueue.add("send-follow", { botFollowRequestId: newRequestId }, { delay });
            logger.info(
              { botFollowRequestId: newRequestId, delayMs: delay },
              "rotated to new bot",
            );
          }
        }

        // Check pending requests for acceptance — Fix #9: single joined query
        const pending = await getPendingFollowRequests();

        for (const req of pending) {
          if (!(await trackedAccountHasAccess(req.trackedAccountId))) {
            await markFollowRequestFailed(req.id, "Tracking access ended");
            continue;
          }
          // Only the requesting bot's authenticated relationship can confirm
          // its private access. Transient probe errors leave the request pending.
          const probe = await probeFollowAcceptance({
            id: req.id,
            trackedAccountId: req.trackedAccountId,
            trackedUsername: req.trackedUsername,
            botAccountId: req.botAccountId,
          });
          const isAccepted = probe.kind === "accepted";

          if (probe.kind === "error") {
            logger.warn(
              {
                botFollowRequestId: req.id,
                trackedUsername: req.trackedUsername,
                err: probe.error,
              },
              "follow-acceptance probe failed; leaving pending",
            );
          }

          if (isAccepted && await trackedAccountHasAccess(req.trackedAccountId)) {
            await markFollowRequestAccepted(req.id, req.trackedUserId);
            logger.info(
              {
                botFollowRequestId: req.id,
                botUsername: req.botUsername,
                trackedUsername: req.trackedUsername,
              },
              "follow accepted",
            );

            await collectionProfileQueue.add("collect-profile", {
              trackedAccountId: req.trackedAccountId,
              force: true,
              source: "private-access-granted",
            }, { jobId: `private-access-${req.id}` });
          }
        }

        logger.info(
          { expired: expired.length, pending: pending.length },
          "bot-check complete",
        );
      } catch (err) {
        logger.error({ err }, "bot-check error");
        throw err;
      }
        },
      );
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );
}

// ─── Worker: retention ────────────────────────────────────────────────────────
// Wave 2: prune old event rows daily. Actual DELETE logic lives in
// server/workers/retention-worker.ts for separation of concerns.

function createRetentionWorker(): Worker {
  return new Worker(
    "retention",
    async (job: Job) => {
      return withCorrelation(
        { module: "worker:retention", jobId: String(job.id ?? "") },
        async () => {
          logger.info("running retention prune");
          try {
            const summary = await pruneOldEvents();
            logger.info({ summary }, "retention prune complete");
          } catch (err) {
            logger.error({ err }, "retention prune error");
            throw err;
          }
        },
      );
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );
}

function createMediaCacheWorker(): Worker {
  return new Worker(
    "media-cache",
    async (job: Job<{ url?: string; reason?: string }>) => {
      const url = job.data.url;
      if (!url) return { ok: false, skipped: true, reason: "missing-url" };

      const result = await processMediaCacheUrl(url);
      return {
        ok: result.status === "cached",
        status: result.status,
        cacheKey: result.cacheKey,
        reason: job.data.reason ?? "unknown",
      };
    },
    {
      connection: createRedisConnection(),
      concurrency: Number(process.env.MEDIA_CACHE_CONCURRENCY ?? "4"),
      limiter: {
        max: Number(process.env.MEDIA_CACHE_LIMIT_PER_MIN ?? "120"),
        duration: 60_000,
      },
    },
  );
}

// ─── Self-healing: bot cooldown probe ────────────────────────────────────────
//
// When IG checkpoints or rate-limits a bot we set bot_accounts.cooldown_until
// in the future so the lease layer skips it. The actual upstream block often
// clears earlier, but we have no signal. The probe runs ONE cheap
// authenticated scrape per cycle, pinned to a single cooled bot.
//
// B4 — the probe NEVER clears/NULLs the cooldown to run:
//   The old implementation NULLed cooldown_until so the LRU leaseBot() could
//   pick the bot, probed the anonymously-accessible `instagram` profile, and
//   restored the old value on failure. Between the clear and the restore ANY
//   concurrent worker could lease the still-blocked bot; the restore could be
//   skipped (probe success, process crash); and a success against an
//   anonymous endpoint cleared checkpoint cooldowns prematurely.
//
//   Now the probe scrapes via the *WithBot path (leaseSpecificBot), which
//   deliberately does not filter on cooldown_until: the cooled bot is leased
//   for exactly this one call while every other worker — which leases through
//   leaseBot()'s cooldown filter — still sees it as cooled for the entire
//   probe. cooldown_until is never written before or during the probe, so
//   there is no window in which the pool can lease a blocked bot, and no
//   restore step that can be skipped or clobber a concurrent write.
//
// Outcome semantics:
//   - Probe FAILURE → we write nothing. The scraper layer's own cooldown
//     policy (services/bot-cooldown.ts) may have extended or re-shaped the
//     cooldown based on the fresh error; that write must stand untouched.
//   - Probe SUCCESS → conservative clearing, decided by
//     planProbeSuccessCooldownUpdate():
//       * rate-limit-shaped cooldown (last_login_error stamped by
//         cooldownBotForRateLimit) → fully clear; one successful
//         authenticated call proves the Retry-After window is over.
//       * checkpoint-shaped (or unidentifiable) → NEVER fully cleared by one
//         good call; the remaining cooldown is shortened to at most
//         COOLDOWN_PROBE_CHECKPOINT_SHORTEN_MS so the lease layer retries
//         soon, while a genuine checkpoint keeps the bot mostly parked. If
//         the remaining cooldown is already shorter, it is kept as-is.
//     The write is a compare-and-swap on the cooldown value observed BEFORE
//     the probe (… WHERE cooldown_until = <observed>): if any concurrent path
//     (rate-limit handler, checkpoint handler, admin tooling) wrote a new
//     cooldown while the probe ran, the CAS matches zero rows and the newer
//     value is preserved.

// @instagram's immutable numeric user id. The probe targets the authenticated
// feed endpoint — the profile endpoint is anonymously accessible and a success
// there proved nothing about whether a checkpointed session actually works.
const COOLDOWN_PROBE_TARGET_IG_USER_ID =
  process.env.COOLDOWN_PROBE_TARGET_IG_USER_ID ?? "25025320";
const COOLDOWN_PROBE_MIN_AGE_MS = 30 * 60 * 1000; // 30 min into cooldown
const COOLDOWN_PROBE_CHECKPOINT_SHORTEN_MS = readBoundedIntEnv(
  "COOLDOWN_PROBE_CHECKPOINT_SHORTEN_MS",
  30 * 60 * 1000,
  60_000,
  24 * 60 * 60 * 1000,
);

export type CooldownShape = "rate-limit" | "checkpoint";

// Mirrors the two writers in services/bot-cooldown.ts:
//   - cooldownBotForRateLimit stamps a prefixed "rate limited; retry-after=…"
//   - cooldownBotForCheckpoint prefixes the checkpoint/forbidden reason.
// Older rows can still carry the unprefixed stamp.
// Anything not positively identifiable as rate-limit-shaped is treated as
// checkpoint-shaped — the conservative direction (shorten, never clear).
export function classifyCooldownShape(
  lastLoginError: string | null | undefined,
): CooldownShape {
  const reason = lastLoginError?.startsWith(COOLDOWN_REASON_PREFIX)
    ? lastLoginError.slice(COOLDOWN_REASON_PREFIX.length)
    : lastLoginError;
  return reason && /^rate limited/i.test(reason)
    ? "rate-limit"
    : "checkpoint";
}

export type ProbeSuccessCooldownPlan =
  | { action: "clear"; shape: CooldownShape }
  | { action: "shorten"; shape: CooldownShape; until: Date }
  | { action: "keep"; shape: CooldownShape };

// Pure decision step for what a SUCCESSFUL probe may do to the observed
// cooldown. Exported for tests; see the block comment above for semantics.
export function planProbeSuccessCooldownUpdate(
  lastLoginError: string | null | undefined,
  observedCooldownUntil: Date,
  nowMs: number,
  shortenMs: number = COOLDOWN_PROBE_CHECKPOINT_SHORTEN_MS,
): ProbeSuccessCooldownPlan {
  const shape = classifyCooldownShape(lastLoginError);
  if (shape === "rate-limit") {
    return { action: "clear", shape };
  }
  const shortenedUntilMs = nowMs + shortenMs;
  if (observedCooldownUntil.getTime() <= shortenedUntilMs) {
    return { action: "keep", shape };
  }
  return { action: "shorten", shape, until: new Date(shortenedUntilMs) };
}

async function probeBotCooldown(): Promise<void> {
  const now = new Date();
  const minCooldownStart = new Date(now.getTime() - COOLDOWN_PROBE_MIN_AGE_MS);

  // Pick a bot:
  //   - cooldown_until is set
  //   - cooldown_until is still in the future (otherwise lease layer already
  //     re-uses it and no probe is needed)
  //   - updated_at is at least 30 min ago, used as a proxy for "we set this
  //     cooldown a while back"; avoids probing a brand-new cooldown.
  //   - has logged in before; the pinned health guard below also requires a
  //     saved session, an eligible status/tier/identity, and a usable proxy.
  // cooldown_until and last_login_error are read here so probe success can
  // (a) classify the cooldown shape and (b) CAS against the observed value.
  const candidates = await db
    .select({
      id: botAccounts.id,
      igUsername: botAccounts.igUsername,
      cooldownUntil: botAccounts.cooldownUntil,
      lastLoginError: botAccounts.lastLoginError,
      status: botAccounts.status,
      tier: botAccounts.tier,
      updatedAt: botAccounts.updatedAt,
      lastLoginAt: botAccounts.lastLoginAt,
      sessionData: botAccounts.sessionData,
      transport: botAccounts.transport,
      automationIdentity: botAccounts.automationIdentity,
      proxyUrl: botAccounts.proxyUrl,
      proxyEndpoint: botAccounts.proxyEndpoint,
      proxyExpiresAt: botAccounts.proxyExpiresAt,
    })
    .from(botAccounts)
    .where(
      and(
        isNotNull(botAccounts.cooldownUntil),
        sql`${botAccounts.cooldownUntil} > NOW()`,
        lt(botAccounts.updatedAt, minCooldownStart),
        isNotNull(botAccounts.lastLoginAt),
      ),
    )
    .orderBy(sql`${botAccounts.updatedAt} ASC`);

  // A rejected pinned lease does not touch updated_at. Limiting the query to
  // one row let an old expired/disabled session monopolize every probe tick.
  // Inspect the aged candidates locally; only the first admissible one can
  // reach the network, with its hold still in force for ordinary readers.
  const bot = selectCooldownProbeCandidate(candidates, now);
  if (!bot?.cooldownUntil) {
    logger.debug({ module: "worker:cooldown-probe" }, "no eligible cooled bot to probe");
    return;
  }
  const observedCooldownUntil = bot.cooldownUntil;

  try {
    // The dedicated probe checks this exact aged cooldown under the shared
    // lease/read budget. Ordinary pinned reads still reject cooled identities.
    await probePinnedBotCooldown(bot.id, COOLDOWN_PROBE_TARGET_IG_USER_ID, observedCooldownUntil);
  } catch (err) {
    // Failure: write nothing. The scraper layer's cooldown policy may have
    // extended the cooldown off the fresh error class — that write stands.
    logger.info(
      {
        module: "worker:cooldown-probe",
        botId: bot.id,
        bot: bot.igUsername,
        err: err instanceof Error ? err.message : String(err),
      },
      "[probe] bot still cooled, deferring",
    );
    return;
  }

  const plan = planProbeSuccessCooldownUpdate(
    bot.lastLoginError,
    observedCooldownUntil,
    Date.now(),
  );
  if (plan.action === "keep") {
    logger.info(
      {
        module: "worker:cooldown-probe",
        botId: bot.id,
        bot: bot.igUsername,
        shape: plan.shape,
        cooldownUntil: observedCooldownUntil.toISOString(),
      },
      "[probe] success; remaining checkpoint cooldown already short — kept",
    );
    return;
  }

  const nextCooldown = plan.action === "clear" ? null : plan.until;
  // CAS: only swap if nobody re-cooled the bot while the probe was running.
  const updated = await db
    .update(botAccounts)
    .set({ cooldownUntil: nextCooldown, updatedAt: new Date() })
    .where(
      and(
        eq(botAccounts.id, bot.id),
        eq(botAccounts.cooldownUntil, observedCooldownUntil),
      ),
    )
    .returning({ id: botAccounts.id });

  if (updated.length === 0) {
    logger.info(
      {
        module: "worker:cooldown-probe",
        botId: bot.id,
        bot: bot.igUsername,
        shape: plan.shape,
      },
      "[probe] cooldown was rewritten concurrently; preserving the newer value",
    );
    return;
  }

  logger.info(
    {
      module: "worker:cooldown-probe",
      botId: bot.id,
      bot: bot.igUsername,
      shape: plan.shape,
      action: plan.action,
      cooldownUntil: nextCooldown ? nextCooldown.toISOString() : null,
    },
    plan.action === "clear"
      ? "[probe] bot recovered from cooldown"
      : "[probe] bot responding; checkpoint cooldown shortened",
  );
}

// ─── bot-pool-rescue ──────────────────────────────────────────────────────
//
// Wave 5: when every bot in the pool has gone invalid (CSRF/checkpoint
// storm), the per-call invalidateBotSession path can still take minutes
// to fire because nothing is actually scraping. This watchdog runs on a
// 10-min cadence, counts healthy bots, and force-relogs the oldest bot
// when the pool drops below the safety threshold. Sequential by design —
// only one bot is force-relogged per cycle so we don't carpet-bomb IG
// with concurrent Chromium logins.
//
// "Healthy" = session_data IS NOT NULL AND (cooldown_until IS NULL OR
// cooldown_until < now()). This deliberately mirrors what the lease layer
// considers leasable.

const BOT_POOL_RESCUE_MIN_HEALTHY = Number(
  process.env.BOT_POOL_RESCUE_MIN_HEALTHY ?? "5",
);
const BOT_POOL_RESCUE_INTERVAL_MS = Number(
  process.env.BOT_POOL_RESCUE_INTERVAL_MS ?? String(5 * 60 * 1000),
);
// How many dead-session bots to force-relogin in a single rescue sweep. The old
// "1 per run, once an hour" cadence could never keep up with a pool collapse
// (76 bots down, 1 fixed/hour). Rescue a small batch each (now 5-min) run so a
// degraded pool climbs back within the same session. Bounded 1..10.
const BOT_POOL_RESCUE_BATCH = Math.min(
  Math.max(Number(process.env.BOT_POOL_RESCUE_BATCH ?? "3"), 1),
  10,
);

interface RescueBotRow {
  id: string;
  ig_username: string;
}

// Force a full Playwright relogin for one bot: wipe its stale session/proxy and
// drive ensureBotReady. Returns true on success. Extracted so rescueBotPool can
// rescue a batch sequentially (Chromium logins are heavy — never parallelised).
async function forceReloginBot(bot: RescueBotRow): Promise<boolean> {
  try {
    // Rescue candidates are session-less by construction. Never wipe a
    // stored cookie jar merely because the pool count is low: the previous
    // implementation destructively re-logged the oldest healthy accounts and
    // amplified proxy churn into checkpoints.
    await db.execute(sql`
      UPDATE bot_accounts SET
        cooldown_until = NULL,
        updated_at = NOW()
      WHERE id = ${bot.id}
        AND session_data IS NULL
    `);
    const { ensureBotReady } = await import("./services/bot-runtime.js");
    await ensureBotReady(bot.id);
    logger.info(
      { module: "worker:bot-pool-rescue", botId: bot.id, username: bot.ig_username },
      "[bot-pool-rescue] force-relogin succeeded",
    );
    return true;
  } catch (err) {
    logger.error(
      {
        module: "worker:bot-pool-rescue",
        botId: bot.id,
        username: bot.ig_username,
        err: err instanceof Error ? err.message : String(err),
      },
      "[bot-pool-rescue] force-relogin failed",
    );
    return false;
  }
}

async function rescueBotPool(): Promise<void> {
  // Mirror leaseBot()'s eligibility filter exactly. Without the lastLoginError
  // regex, bots whose session cookie is still stored but known-dead (401 auth
  // rejected, dead proxy lane) counted as "healthy" — so the watchdog stayed
  // silent while leaseBot kept handing those bots out, probing proxies, and
  // failing. Count only bots that could actually serve a scrape.
  const healthyResult = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM bot_accounts
    WHERE status = 'available'
      AND tier IN ('canary', 'worker')
      AND session_data IS NOT NULL
      AND automation_identity IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until < NOW())
      AND COALESCE(last_login_error, '') !~* 'auth rejected|csrf token|sessionid cookie|csrftoken cookie|checkpoint|required|suspended|rejected username/password|login information .* incorrect'
      AND (
        (
          proxy_url IS NOT NULL
          AND proxy_url !~* ${KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX}
        )
        OR (
          proxy_url IS NULL
          AND proxy_endpoint IS NOT NULL
          AND proxy_expires_at > NOW() + INTERVAL '2 minutes'
        )
      )
  `)) as unknown as { rows: Array<{ count: number }> };
  const healthy = healthyResult.rows[0]?.count ?? 0;

  if (healthy >= BOT_POOL_RESCUE_MIN_HEALTHY) {
    logger.debug(
      { module: "worker:bot-pool-rescue", healthy },
      "[bot-pool-rescue] pool healthy, no rescue needed",
    );
    return;
  }

  // Pick the bots whose last_login_at is OLDEST — they have had the longest
  // time to drift / get blocked, so re-establishing them is the most useful.
  // Guards:
  //   - Never rescue a permanently-dead bot (banned/retired/session_expired,
  //     or a checkpoint/suspended marker) — a full Playwright login (Chromium +
  //     instagram.com + 3 retries through residential proxy) just comes back dead.
  //   - Skip bots on an ACTIVE cooldown: those are self-healing (a transient
  //     rate-limit / transport bench that clears on its own). Force-relogging
  //     them would throw away a session that would have recovered for free.
  const candidates = (await db.execute(sql`
    SELECT id, ig_username
    FROM bot_accounts
    WHERE tier IN ('canary', 'worker')
      AND automation_identity IS NOT NULL
      AND session_data IS NULL
      AND status NOT IN ('banned', 'retired', 'session_expired')
      AND COALESCE(last_login_error, '') !~* 'checkpoint|suspended'
      AND (cooldown_until IS NULL OR cooldown_until < NOW())
      AND (
        proxy_url IS NULL
        OR proxy_url !~* ${KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX}
      )
    ORDER BY last_login_at ASC NULLS FIRST
    LIMIT ${BOT_POOL_RESCUE_BATCH}
  `)) as unknown as { rows: RescueBotRow[] };
  const bots = candidates.rows ?? [];
  if (bots.length === 0) {
    logger.warn(
      { module: "worker:bot-pool-rescue", healthy },
      "[bot-pool-rescue] no rescuable bot in pool",
    );
    return;
  }

  logger.warn(
    {
      module: "worker:bot-pool-rescue",
      healthy,
      threshold: BOT_POOL_RESCUE_MIN_HEALTHY,
      batch: bots.length,
    },
    `[bot-pool-rescue] only ${healthy} healthy bots, force-relogging ${bots.length}`,
  );

  let recovered = 0;
  for (const bot of bots) {
    if (await forceReloginBot(bot)) recovered += 1;
  }
  logger.info(
    {
      module: "worker:bot-pool-rescue",
      healthy,
      attempted: bots.length,
      recovered,
    },
    "[bot-pool-rescue] rescue sweep complete",
  );
}

// ─── Start all workers ────────────────────────────────────────────────────────

let workers: Worker[] = [];

function registerWorkerSet(candidates: Worker[]): Worker[] {
  const registered = candidates.map((worker) => registerWorkerErrorHandler(worker));

  // B8: lifecycle listeners are wrapped so a logger throw (or a malformed
  // event payload — BullMQ can emit 'failed' with an undefined job) can never
  // escape into BullMQ's emit() and take the PM2 process down as an uncaught
  // exception / unhandled rejection.
  for (const worker of registered) {
    worker.on("completed", (job) => {
      try {
        logger.debug(
          { module: "workers", queue: worker.name, jobId: job?.id },
          "job completed",
        );
      } catch {
        // Never throw from an event listener.
      }
    });
    worker.on("failed", (job, err) => {
      try {
        logger.error(
          {
            module: "workers",
            queue: worker.name,
            jobId: job?.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "job failed",
        );
      } catch {
        // Never throw from an event listener.
      }
    });
    worker.on("stalled", (jobId) => {
      try {
        logger.warn(
          { module: "workers", queue: worker.name, jobId },
          "job stalled; BullMQ will re-queue or fail it",
        );
      } catch {
        // Never throw from an event listener.
      }
    });
  }

  return registered;
}

/**
 * Five-minute self-heal body (legacy exported name retained for tests).
 * Independent sweeps, each with its own catch so one failing can
 * never skip the other:
 *  - per-account refresh schedulers (registerAccountRefresh can fail silently
 *    on a Redis blip and strand an account — danielcoffeen4);
 *  - C11a: `collection_jobs` rows left `running` by a worker that died before
 *    its completion write (reconcileStaleCollectionJobs used to run at boot only).
 */
export interface HourlyReconcileDeps {
  readonly reconcileAccountRefreshes: (
    queue: Parameters<typeof reconcileAccountRefreshes>[0],
  ) => Promise<unknown>;
  readonly reconcileStaleCollectionJobs: () => Promise<number>;
  readonly reconcileStaleGeneratingReports?: () => Promise<number>;
}

const DEFAULT_HOURLY_RECONCILE_DEPS: HourlyReconcileDeps = {
  reconcileAccountRefreshes,
  reconcileStaleCollectionJobs,
  reconcileStaleGeneratingReports,
};

export async function runHourlyReconcile(
  queue: Parameters<typeof reconcileAccountRefreshes>[0],
  deps: HourlyReconcileDeps = DEFAULT_HOURLY_RECONCILE_DEPS,
): Promise<void> {
  await runRecoverySweep({
    schedulers: () => deps.reconcileAccountRefreshes(queue),
    collections: () => deps.reconcileStaleCollectionJobs(),
    ...(deps.reconcileStaleGeneratingReports ? { reports: () => deps.reconcileStaleGeneratingReports!() } : {}),
  });
  const status = recoveryStatus();
  if (status.failedSteps.length) logger.error({ failedSteps: status.failedSteps }, "recovery sweep incomplete; retry on next tick");
}

/**
 * Keep background services that never use an Instagram identity available
 * while authenticated collection is in recovery mode. In particular, media
 * caching, email, DB-only report generation, and retention must not inherit an
 * account-safety outage merely because WORKERS_DISABLED=1.
 */
export function startSafeBackgroundWorkers(): void {
  if (workers.length > 0) {
    logger.warn(
      { module: "workers", workerCount: workers.length },
      "startSafeBackgroundWorkers called while workers are already running",
    );
    return;
  }

  startBandwidthMeter();
  workers = registerWorkerSet([
    createReportWorker(),
    createEmailWorker(),
    createRetentionWorker(),
    createMediaCacheWorker(),
  ]);
  scheduleTransactionalEmailDelivery();

  // Retention is DB-only and remains safe during authenticated collection
  // recovery. Weekly reports intentionally remain paused so stale collection
  // data is not automatically delivered as if it were current.
  retentionQueue
    .add(
      "prune-events",
      {},
      { repeat: { every: 24 * 60 * 60 * 1000, jobId: "retention-daily" } },
    )
    .catch((err) =>
      logger.error({ module: "workers", err }, "failed to schedule retention prune"),
    );

  logger.info(
    { module: "workers", workerCount: workers.length },
    "safe non-Instagram BullMQ workers started",
  );
}

export function startWorkers(): void {
  if (workers.length > 0) {
    logger.warn(
      { module: "workers", workerCount: workers.length },
      "startWorkers called while workers are already running",
    );
    return;
  }

  // Persist scrape bandwidth attribution on a background timer.
  startBandwidthMeter();

  // B8: every Worker instance passes through registerWorkerErrorHandler so a
  // bare 'error' emit (Redis blip, internal BullMQ failure) can never crash
  // the PM2 process.
  workers = registerWorkerSet([
    createProfileWorker(),
    createLikesWorker(),
    createFollowsWorker(),
    createReportWorker(),
    createEmailWorker(),
    createWeeklyReportWorker(),
    createBotFollowRequestWorker(),
    createBotFollowCheckWorker(),
    createRetentionWorker(),
    createMediaCacheWorker(),
  ]);
  scheduleTransactionalEmailDelivery();

  // Schedule recurring bot follow check every 30 minutes.
  // Fix #8: stable jobId prevents duplicate repeatables accumulating on restart.
  botFollowCheckQueue
    .add(
      "check-follows",
      {},
      { repeat: { every: 30 * 60 * 1000, jobId: "bot-follow-check-recurring" } },
    )
    .catch((err) =>
      logger.error({ module: "workers", err }, "failed to schedule bot follow check"),
    );

  // Per-account refresh: every active tracked_account owns its own
  // BullMQ scheduler with stable id `account-refresh:<tracked_account_id>`
  // on the `collection-profile` queue. Replaces the old global refresh-sweep
  // worker that fanned out simultaneously to every account.
  //
  // Cadence: REFRESH_SWEEP_SEC (default 300 = 5 min). Each scheduler ticks
  // independently so load is naturally spread across the interval. The
  // freshness gate (REFRESH_THRESHOLD_SEC, default 180 = 3 min) is applied
  // inside the profile worker for jobs whose name === "account-refresh".
  // Load the admin-controlled refresh interval into the registrar's cache
  // BEFORE reconciling, so per-account schedulers are built with the current
  // cadence rather than the env/default fallback.
  initRefreshConfig()
    .then(() => reconcileAccountRefreshes(collectionProfileQueue))
    .catch((err) =>
    logger.error(
      { module: "workers", err: err instanceof Error ? err.message : String(err) },
      "failed to reconcile per-account refresh schedulers",
    ),
  );

  // Repair missing schedules and stale collection/report jobs at boot and
  // every five minutes. The sweep is single-flight and reports each failed
  // step independently; it never resets provider cooldowns or account health.
  void runHourlyReconcile(collectionProfileQueue);
  const reconcileTimer = setInterval(() => {
    void runHourlyReconcile(collectionProfileQueue);
  }, 5 * 60 * 1000);
  if (typeof reconcileTimer.unref === "function") reconcileTimer.unref();

  // Liked-post detection runs on its OWN cadence (LIKES_SWEEP_SEC, default 1h)
  // instead of only as a tail of the profile refresh. Coupling the two meant
  // like freshness inherited the admin cadence sized for bandwidth cost: at a
  // 6h profile interval with clustered schedulers, liker reads went idle for
  // 4.7h at a stretch while every bot sat under its daily cap. The sweep reuses
  // enqueueLikesAfterProfile, so the 30-min per-account dedupe still gates each
  // run and the two paths cannot double-spend liker budget.
  const runLikesSweep = () =>
    sweepLikes(collectionLikesQueue, enqueueLikesAfterProfile as never).catch(
      (err) =>
        logger.error(
          {
            module: "workers",
            err: err instanceof Error ? err.message : String(err),
          },
          "likes sweep failed",
        ),
    );
  // Boot-time sweep only when one is actually due (see computeSweepBootDelayMs):
  // the last run is persisted in Redis so restarts neither re-scan everyone nor
  // shift the hourly phase.
  const LIKES_SWEEP_LAST_RUN_KEY = "likes-sweep:last-run";
  const runLikesSweepAndStamp = () =>
    runLikesSweep().then(() =>
      connection.set(LIKES_SWEEP_LAST_RUN_KEY, String(Date.now())).catch(() => undefined),
    );
  void (async () => {
    const sweepMs = readLikesSweepMs();
    const lastRaw = await connection.get(LIKES_SWEEP_LAST_RUN_KEY).catch(() => null);
    const lastRunMs = lastRaw ? Number(lastRaw) : null;
    const firstDelayMs = computeSweepBootDelayMs(lastRunMs, Date.now(), sweepMs);
    if (firstDelayMs > 0) {
      logger.info(
        { module: "workers", firstDelayMs, lastRunMs },
        "likes sweep: boot run skipped (not due); first tick keeps the prior cadence",
      );
    }
    const first = setTimeout(() => {
      void runLikesSweepAndStamp();
      const likesSweepTimer = setInterval(runLikesSweepAndStamp, sweepMs);
      if (typeof likesSweepTimer.unref === "function") likesSweepTimer.unref();
    }, firstDelayMs);
    if (typeof first.unref === "function") first.unref();
  })();

  // Relogin sweep for parked web sessions. `autoLogin*` only ever ran inside
  // `ensureBotReady`, which only runs on lease, and `leaseBot` selects only
  // status='available' — so a session_expired bot could never come back (60 web
  // bots, 54 with TOTP, sat parked for weeks). The sweep re-logs a small batch
  // per run (RELOGIN_SWEEP_BATCH, default 2) and stops on the first suspension /
  // checkpoint, because a login is the most ban-prone action a bot performs.
  // Set RELOGIN_SWEEP_ENABLED=false to turn it off.
  if (process.env.RELOGIN_SWEEP_ENABLED !== "false") {
    const runRelogin = () =>
      runReloginSweep()
        .then((r) => logger.info({ module: "workers", ...r }, "relogin sweep complete"))
        .catch((err) =>
          logger.error(
            { module: "workers", err: err instanceof Error ? err.message : String(err) },
            "relogin sweep failed",
          ),
        );
    // First run 5 minutes after boot so a deploy never stacks logins on top of
    // the boot-time collection burst; then on its own cadence.
    const reloginFirst = setTimeout(() => {
      void runRelogin();
      const reloginTimer = setInterval(runRelogin, readReloginSweepMs());
      if (typeof reloginTimer.unref === "function") reloginTimer.unref();
    }, 5 * 60 * 1000);
    if (typeof reloginFirst.unref === "function") reloginFirst.unref();
  } else {
    logger.info({ module: "workers" }, "relogin sweep disabled (RELOGIN_SWEEP_ENABLED=false)");
  }

  // Self-healing: bot-cooldown probe. Disabled by default because it uses the
  // same posts endpoint budget as customer scrapes (pinned to one cooled bot
  // per cycle); under IG throttling repeated failed probes can add strikes /
  // reopen the endpoint circuit breaker without delivering customer data.
  if (process.env.BOT_COOLDOWN_PROBE_ENABLED === "true") {
    const cooldownProbeWorker = registerWorkerErrorHandler(
      new Worker(
        "bot-cooldown-probe",
        async () => {
          await probeBotCooldown();
          return { ok: true };
        },
        { connection, concurrency: 1 },
      ),
    );
    workers.push(cooldownProbeWorker);

    const probeSec = Number(process.env.BOT_COOLDOWN_PROBE_SEC ?? "300");
    botCooldownProbeQueue
      .add(
        "probe",
        {},
        { repeat: { every: probeSec * 1000, jobId: "bot-cooldown-probe-recurring" } },
      )
      .catch((err) =>
        logger.error({ module: "workers", err }, "failed to schedule cooldown probe"),
      );
  } else {
    logger.info(
      { module: "workers" },
      "bot cooldown probe disabled; set BOT_COOLDOWN_PROBE_ENABLED=true to enable",
    );
  }

  // Wave 5: bot-pool-rescue. Disabled in live safe-mode because it can
  // intentionally reset and relog bots; use only during controlled recovery.
  if (process.env.BOT_POOL_RESCUE_ENABLED === "true") {
    const poolRescueWorker = registerWorkerErrorHandler(
      new Worker(
        "bot-pool-rescue",
        async () => {
          await rescueBotPool();
          return { ok: true };
        },
        { connection, concurrency: 1 },
      ),
    );
    workers.push(poolRescueWorker);

    botPoolRescueQueue
      .add(
        "rescue",
        {},
        {
          repeat: {
            every: BOT_POOL_RESCUE_INTERVAL_MS,
            jobId: "bot-pool-rescue-recurring",
          },
        },
      )
      .catch((err) =>
        logger.error({ module: "workers", err }, "failed to schedule bot-pool-rescue"),
      );
  } else {
    logger.info(
      { module: "workers" },
      "bot pool rescue disabled; set BOT_POOL_RESCUE_ENABLED=true to enable",
    );
  }

  // The legacy `refresh-sweep` queue is intentionally no longer scheduled —
  // see reconcileAccountRefreshes above. The queue export is retained only
  // so older clients/tests don't break; nothing enqueues into it.

  // Wave 2: daily retention prune. Stable jobId prevents duplicate repeatables.
  retentionQueue
    .add(
      "prune-events",
      {},
      { repeat: { every: 24 * 60 * 60 * 1000, jobId: "retention-daily" } },
    )
    .catch((err) =>
      logger.error({ module: "workers", err }, "failed to schedule retention prune"),
    );

  // Weekly report sweep. Default ON; opt out with WEEKLY_REPORTS_ENABLED=false.
  // Cadence: every 7 days. Stable jobId prevents duplicate repeatables on
  // restart. The sweep fans out one report per active account, each enqueued
  // onto reportGenerateQueue with deliver:true (notification + email).
  if (process.env.WEEKLY_REPORTS_ENABLED !== "false") {
    weeklyReportQueue
      .add(
        "sweep",
        {},
        { repeat: { every: 7 * 24 * 60 * 60 * 1000, jobId: "weekly-report-sweep" } },
      )
      .catch((err) =>
        logger.error({ module: "workers", err }, "failed to schedule weekly report sweep"),
      );
    logger.info({ module: "workers" }, "weekly reports enabled (every 7d)");
  } else {
    logger.info(
      { module: "workers" },
      "weekly reports disabled; unset WEEKLY_REPORTS_ENABLED or set it to anything other than 'false' to enable",
    );
  }

  // Newly discovered public cursors also need continuation; no operator list
  // is required. The batch still enforces entitlement and collection gates.
  workers.push(registerWorkerErrorHandler(startBackgroundRosterWorker(connection)));

  // Wave 6: bot-account warmer. Disabled by default for live customer
  // scraping because it consumes the same profile/stories/highlights endpoint
  // budget as real refreshes. Enable only during a controlled warming window.
  if (process.env.BOT_WARMER_ENABLED === "true") {
    // B8: the warmer Worker is constructed in bot-warmer-worker.ts without an
    // 'error' listener of its own — register it here like every other worker.
    const botWarmerWorker = registerWorkerErrorHandler(
      startBotWarmerWorker(createRedisConnection()),
    );
    workers.push(botWarmerWorker);
  } else {
    logger.info(
      { module: "workers" },
      "bot warmer disabled; set BOT_WARMER_ENABLED=true to enable",
    );
  }

  // Wave 9: liked-by inference squad. Disabled by default — shipping the code
  // is inert until an operator sets LIKED_BY_SQUAD_ENABLED=true AND has seeded
  // watcher bots (server/scripts/assign-liked-by-roles.ts). The worker follows
  // tracked users with the watcher bots and polls their home/reels feeds for
  // the "people you follow who liked this" facepile, writing matches into
  // like_events.
  if (process.env.LIKED_BY_SQUAD_ENABLED === "true") {
    const likedBySquadWorker = registerWorkerErrorHandler(
      startLikedBySquadWorker(createRedisConnection()),
    );
    workers.push(likedBySquadWorker);
  } else {
    logger.info(
      { module: "workers" },
      "liked-by squad disabled; set LIKED_BY_SQUAD_ENABLED=true to enable",
    );
  }

  logger.info({ module: "workers", workerCount: workers.length }, "all BullMQ workers started");
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map(async (w) => {
    const started=Date.now();
    logger.info({module:"workers",queue:w.name},"worker drain started");
    await w.close();
    logger.info({module:"workers",queue:w.name,elapsedMs:Date.now()-started},"worker drain complete");
  }));
  workers = [];
  logger.info({module:"workers"},"worker Redis connection drain started");
  await connection.quit();
  logger.info({ module: "workers" }, "all workers stopped");
}
