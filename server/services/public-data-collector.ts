import { trackedAccountHasAccess } from "./subscription-access.js";
import { findGrantedBotId, findGrantedBotIds, privateBotHasAccess } from "./private-account-access.js";
// ─── Public-data collector orchestration ─────────────────────────────────────
//
// Called by the profile BullMQ worker. Given a tracked account this helper:
//   1. Fetches the public profile (must succeed — anchor for igUserId).
//   2. Updates tracked_accounts + inserts a profile_snapshots row.
//   3. Triggers parallel collection of posts, stories, highlights, followers,
//      and following. Each piece is independent (allSettled-style).
//
// Bot ownership: the public-data path is bot-only. `ig-public-scraper.ts`
// owns its own bot-assignment context — each public scrape function calls
// `withBot()` internally (leases an LRU bot via `FOR UPDATE SKIP LOCKED`,
// runs the IG call, releases in `finally`). We chose option (b) of the
// refactor brief: scraper handles assignment, collector just orchestrates.
// Option (a) (thread one bot through every call) would require extending
// ig-public-scraper's public surface with a shared-lease export plus a
// matching change in public-data-service. That's a separate ticket
// ("shared bot per collection cycle"). Until then a cycle leases up to 6
// bots back-to-back; LRU rotation spreads load so the effect is "different
// bots in series", not "one bot hammered six times".
//
// Daily caps live in `behavior/caps.ts` and gate FOLLOW / PROFILE-VIEW /
// PRIVATE-REQUEST actions. Public READ scrapes are NOT gated by caps —
// the scraper only touches `lastUsedAt` for LRU. 150 follows/day and
// 500 profile-views/day are enforced in the bot-follow worker path.
//
// Empty-pool handling: when every bot is on cooldown the scraper raises
// IGPublicScraperError → service maps to `{ ok: false, source: "bot", error }`.
// We surface that as a clean `failedProfileOutcome` with `error: "no bot
// available"`. No throws escape this collector.
// ─────────────────────────────────────────────────────────────────────────────

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "../db.js";
import { loadRosterViewer } from "./roster-store.js";
import { backgroundRosterTarget, backgroundRosterWorkerReady } from "./roster-background-policy.js";
import { readBackgroundRosterProgress, reconcileBackgroundRosters } from "./roster-background-sync.js";
import { getCachedRefreshIntervalSec } from "./refresh-config.js";
import {
  postEngagementChecks,
  profileSnapshots,
  trackedAccounts,
} from "../../shared/schema.js";
import type {
  PostEngagementCheckKind,
  TrackedAccount,
} from "../../shared/schema.js";
import {
  getAllUserFollowers,
  getAllUserFollowersAsBot,
  getAllUserFollowing,
  getAllUserFollowingAsBot,
  getPostComments,
  getPostCommentsAsBot,
  getPostLikers,
  getPostLikersAsBot,
  getPublicProfile,
  getPublicProfileAsBot,
  getUserHighlights,
  getUserHighlightsAsBot,
  getUserPosts,
  getUserPostsAsBot,
  getUserStories,
  getUserStoriesAsBot,
  parseEnvInt,
  type FollowListStopReason,
  type IGFollowUser,
  type IGHighlight,
  type IGPublicProfile,
  type IGStoryItem,
  type ProfileFetchResult,
  type PublicDataResult,
} from "./public-data-service.js";
import {
  loadSavedHighlightMediaCounts,
  persistComments,
  persistFollowerDiff,
  persistFollowingDiff,
  persistHighlights,
  persistLikers,
  persistPosts,
  persistStories,
} from "./public-data-persistence.js";
import type { IGPostSummary } from "../ig-public-scraper.js";
import { logger as baseLogger } from "../observability/logger.js";
import { enqueueMediaCacheUrls } from "./media-cache-jobs.js";
import { emitRealtime } from "./realtime-events.js";
import { withScrapeContext } from "./bandwidth-meter.js";
import {
  fetchExpectedCount,
  fetchLastSnapshotCounts,
  fetchReportedCountAt,
  resolveRewalkMinDelta,
  rosterFitsSingleWalk,
  shouldComputeUnfollowDiff,
  shouldEnumerateRoster,
  shouldRewalkCompleteRoster,
  forceFullTtlFor,
  ROSTER_COMPLETE_REWALK_HOURS,
  ROSTER_COMPLETE_REWALK_MS,
  ROSTER_HEAD_PAGES,
  type RosterEnumDecision,
  type SnapshotCounts,
} from "./diff-completeness.js";
import { computeRosterSyncState, ROSTER_ENUMERABLE_CAP } from "./roster.js";
import {
  canonicalTwinId,
  DEFAULT_ROSTER_INHERITANCE_POLICY,
  pickRosterInheritanceDonor,
  siblingTrackedAccountIds,
  type RosterDonorCandidate,
  type RosterInheritancePolicy,
} from "./tracked-account-twins.js";
import {
  getRosterSyncHealth,
  recordExternalRosterSuccessCooldown,
  recordRosterFetchFailure,
  markRosterTooLarge,
  loadRosterCursor,
  copyRosterFromSibling,
  type RosterDimension,
  type RosterReadLeg,
} from "./roster-store.js";
import { fetchPublicProfileTier1 } from "./public-read-client.js";
import { resolveApifyGraphLimit } from "./apify-graph-fallback.js";
import { isShuttingDown } from "./shutdown-state.js";

const logger = baseLogger.child({ module: "public-data-collector" });

// ── Outcome shape ───────────────────────────────────────────────────────────
//
// Preserved verbatim from the previous design — workers.ts logs this shape
// and reads each per-piece outcome individually. Don't reshape without
// coordinating with the worker.

export interface EngagementCollectOutcome {
  readonly likers: { readonly checked: number; readonly failed: number; readonly skipped: number };
  readonly comments: { readonly checked: number; readonly failed: number; readonly skipped: number };
  readonly error?: string;
}

export interface CollectOutcome {
  readonly profile: {
    readonly ok: boolean;
    readonly source: string;
    readonly error?: string;
  };
  readonly posts: {
    readonly count: number;
    readonly source: string;
    readonly error?: string;
  };
  readonly stories: {
    readonly count: number;
    readonly source: string;
    readonly error?: string;
  };
  readonly highlights: {
    readonly count: number;
    readonly source: string;
    readonly error?: string;
  };
  readonly following: {
    readonly source: string;
    readonly newFollows: number;
    readonly newUnfollows: number;
    readonly error?: string;
  };
  readonly followers: {
    readonly source: string;
    readonly newFollowers: number;
    readonly newFollowerUnfollows: number;
    readonly error?: string;
  };
  readonly isPrivate: boolean;
  readonly engagement?: EngagementCollectOutcome;
}

// ── Internal constants & helpers ────────────────────────────────────────────

const SKIP_NO_PROFILE = "skipped: no profile" as const;
/** Posts / stories / highlights are collected on the canonical twin only (C6). */
const SKIP_NON_CANONICAL_TWIN = "skipped: non-canonical twin" as const;
const SKIP_PRIVATE = "private account" as const;
const NO_BOT_AVAILABLE = "no bot available" as const;
const POSTS_PER_CYCLE = 12;
// Scrape engagement for every post captured in this cycle. PM2 previously
// held ENGAGEMENT_POSTS_PER_CYCLE=1, which made the UI look empty for most
// posts even when post-level counts existed.
const requestedEngagementPosts = Number(process.env.ENGAGEMENT_POSTS_PER_CYCLE ?? POSTS_PER_CYCLE);
const ENGAGEMENT_POSTS_PER_CYCLE = Math.max(
  0,
  Math.min(
    Number.isFinite(requestedEngagementPosts)
      ? Math.max(requestedEngagementPosts, POSTS_PER_CYCLE)
      : POSTS_PER_CYCLE,
    POSTS_PER_CYCLE,
  ),
);
const ENGAGEMENT_COMMENTS_MAX_ITEMS = Math.max(
  500,
  Math.min(Number(process.env.ENGAGEMENT_COMMENTS_MAX_ITEMS ?? "2000"), 5000),
);
// ── Engagement re-scrape memory (migration 0042) ────────────────────────────
//
// The engagement scrape re-read the SAME top-N posts on every profile refresh
// (8x/day at the current 3h cadence) because nothing recorded what it had
// already read: 540 calls / 24,789 items scraped / 231 rows inserted over 24h,
// with 477 calls (88%) inserting nothing at all.
//
// The fix is AGE-TIERED rather than a blanket dedupe, because on a RECENT post
// the liker list and comment thread genuinely keep growing — re-reading those
// is the scrape doing its job, and both caches feed live UI plus
// collectKnownLikerEvidence (which mines likers_cache to detect one tracked
// account liking another's post).
//
// Posts younger than this window are scraped EVERY cycle, exactly as before —
// the 0042 memory is not even consulted for them. 48h at a 3h cadence still
// gives a new post ~16 full re-reads while its engagement is actually moving.
// Set to 0 to apply the recheck window to every post regardless of age.
const ENGAGEMENT_FRESH_POST_HOURS = parseEnvInt(
  "ENGAGEMENT_FRESH_POST_HOURS",
  48,
  0,
  24 * 30,
);
// How long a SUCCESSFUL scrape suppresses a re-scrape of the same post+kind,
// once that post is past the fresh window. 24h matches the
// LIKE_EVIDENCE_RECHECK_HOURS precedent: one full re-read per post per day,
// freeing the other ~7 cycles to do work that can actually return new rows.
// Set to 0 to disable the memory entirely (restores re-read-everything).
const ENGAGEMENT_RECHECK_HOURS = parseEnvInt(
  "ENGAGEMENT_RECHECK_HOURS",
  24,
  0,
  24 * 30,
);
const HOUR_MS = 60 * 60 * 1000;
const FOLLOW_GRAPH_ENABLED =
  String(process.env.FOLLOW_GRAPH_ENABLED ?? "true").toLowerCase() === "true";
// Audit 2026-09-02 C7: a freshly promoted canonical twin inherits a sibling's
// roster only when that sibling's last successful read is at most this old —
// a deactivated row that was canonical until recently walked within the last
// day; 72 h leaves room for a throttled weekend. Clamped to 1 h … 30 d.
const ROSTER_INHERIT_MAX_DONOR_AGE_MS = (() => {
  const hours = Number(process.env.ROSTER_INHERIT_MAX_DONOR_AGE_HOURS ?? "72");
  const safeHours = Number.isFinite(hours) ? hours : 72;
  return Math.max(HOUR_MS, Math.min(safeHours * HOUR_MS, 30 * 24 * HOUR_MS));
})();
// Phase 2: skip follower/following enumeration when counts are unchanged and
// the held roster is complete + fresh. Default on. Set to "false" to fall back
// to enumerating every cycle (kill-switch if a count-stable composition swap
// must be caught faster than the force-full TTL).
const DIFF_AWARE_ROSTER_ENABLED =
  String(process.env.DIFF_AWARE_ROSTER_ENABLED ?? "true").toLowerCase() ===
  "true";
// Items the follow-list walker receives per page (the scraper's web page size
// is 24; production walks average 24.2 items/page). Only used to judge whether
// a roster can be read in ONE walk — see the re-walk policy below.
const FOLLOW_GRAPH_ITEMS_PER_PAGE = parseEnvInt(
  "FOLLOW_GRAPH_ITEMS_PER_PAGE",
  24,
  1,
  200,
);
// Page cap per walk. The 240 floor is deliberate, not a typo: a roster is only
// eligible for unfollow detection when ONE walk reads >= 90% of what we hold
// (roster-store `isCompleteRead`, persistence `resolveUnfollowGate`). At 24
// items/page, 240 pages = 5,760 members per walk; five of the nine active
// accounts hold 1k-2k followers and depend on that headroom. Honouring an
// operator value of 40 would cut every walk above ~960 members short and
// silently switch those accounts to additive-only. We therefore keep the floor
// but say so, instead of pretending the env value took effect.
const FOLLOW_GRAPH_MAX_PAGES_FLOOR = 240;
const FOLLOW_GRAPH_MAX_PAGES_REQUESTED = Number(
  process.env.FOLLOW_GRAPH_MAX_PAGES ?? String(FOLLOW_GRAPH_MAX_PAGES_FLOOR),
);
const FOLLOW_GRAPH_MAX_PAGES = Math.max(
  FOLLOW_GRAPH_MAX_PAGES_FLOOR,
  Math.min(
    Number.isFinite(FOLLOW_GRAPH_MAX_PAGES_REQUESTED)
      ? FOLLOW_GRAPH_MAX_PAGES_REQUESTED
      : FOLLOW_GRAPH_MAX_PAGES_FLOOR,
    600,
  ),
);
if (FOLLOW_GRAPH_MAX_PAGES_REQUESTED !== FOLLOW_GRAPH_MAX_PAGES) {
  logger.warn(
    {
      requested: process.env.FOLLOW_GRAPH_MAX_PAGES ?? null,
      effective: FOLLOW_GRAPH_MAX_PAGES,
      floor: FOLLOW_GRAPH_MAX_PAGES_FLOOR,
      singleWalkCapacity: FOLLOW_GRAPH_MAX_PAGES * FOLLOW_GRAPH_ITEMS_PER_PAGE,
    },
    "FOLLOW_GRAPH_MAX_PAGES is outside [240, 600]; using the clamped value so mid-size rosters still complete in one walk",
  );
}
// One cap for enumeration and for the sync-state verdict (see roster.ts).
const FOLLOW_GRAPH_MAX_ITEMS = ROSTER_ENUMERABLE_CAP;
// Per-page delay for the follower/following walk. IG rate-limits *deep*
// pagination of a target's follow graph by request-rate — firing ~14 pages at
// the default 1.5-3.5s pace trips the wall ~page 11 and truncates the roster.
// Pacing the walk slower (default 9-16s/page) keeps it under the limit so a
// large account (600-1500 followers) enumerates fully in one pass. Env-tunable.
const FOLLOW_GRAPH_PAGE_DELAY_MIN_MS = Math.max(
  1500,
  Math.min(Number(process.env.FOLLOW_GRAPH_PAGE_DELAY_MIN_MS ?? "9000"), 60000),
);
const FOLLOW_GRAPH_PAGE_DELAY_MAX_MS = Math.max(
  FOLLOW_GRAPH_PAGE_DELAY_MIN_MS + 1000,
  Math.min(Number(process.env.FOLLOW_GRAPH_PAGE_DELAY_MAX_MS ?? "16000"), 90000),
);
const POSTS_ENABLED =
  String(process.env.SCRAPE_POSTS_ENABLED ?? "true").toLowerCase() === "true";
const STORIES_ENABLED =
  String(process.env.SCRAPE_STORIES_ENABLED ?? "true").toLowerCase() === "true";
const HIGHLIGHTS_ENABLED =
  String(process.env.SCRAPE_HIGHLIGHTS_ENABLED ?? "true").toLowerCase() === "true";
// Content-incremental highlights: compare the cheap tray (highlight_id +
// media_count) against the cached baseline and skip the expensive reels fetch
// when nothing changed. Toggle off to restore the always-full behavior.
const HIGHLIGHTS_INCREMENTAL_ENABLED =
  String(process.env.HIGHLIGHTS_INCREMENTAL_ENABLED ?? "true").toLowerCase() ===
  "true";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "persist failed";
}

/**
 * Heuristic: did a service call fail because every bot is on cooldown / the
 * pool is empty? The scraper raises IGPublicScraperError with this exact
 * substring; the service layer surfaces it as a `bot` source error.
 */
function isPoolEmpty(result: PublicDataResult<unknown>): boolean {
  if (result.ok) return false;
  return result.source === "bot" && /no available bot/i.test(result.error);
}

/**
 * Failures that mean the profile itself is gone or hard-blocked. Serving the
 * cached anchor for these would keep collecting against a dead target, so
 * they always hard-fail regardless of any rate-limit shape in the message.
 */
const PERMANENT_PROFILE_FAILURE_RE =
  /user not found|user_not_found|not[ _-]?found|404|checkpoint|challenge/i;

/**
 * Can this cycle continue from the cached profile anchor? Two signals, in
 * priority order (A3):
 *   1. permanent profile failure → never (hard fail);
 *   2. structured `rateLimited` flag from getPublicProfile → yes. This fires
 *      even when the browser fallback then failed for an unrelated reason
 *      ("no available bot in the pool", "failed to build IG client", ...);
 *   3. legacy message sniffing (rate-limit / transient-transport shapes) as a
 *      fallback for results that lack the structured flag.
 */
function canContinueFromCachedProfile(
  result: PublicDataResult<unknown> & { readonly rateLimited?: boolean },
): boolean {
  if (result.ok) return false;
  if (PERMANENT_PROFILE_FAILURE_RE.test(result.error)) return false;
  if (result.rateLimited === true) return true;
  return /rate limit|rate_limited|429|throttle|timeout|temporar/i.test(
    result.error,
  );
}

// ── Consecutive cached-continuation cutoff (A6) ─────────────────────────────
//
// The cached-profile continuation matches broad transient shapes
// ("timeout", "temporar...") — so persistent transport breakage would
// otherwise degrade into an endless run of silently-"successful" cached
// cycles: the worker sees profile.ok=true, BullMQ retries/metrics stay
// suppressed, and nobody notices the account has stopped getting fresh data.
// Track consecutive cached cycles per tracked account (in-memory; resets on
// process restart, which is fine — the cap only needs to bound a streak
// within one process lifetime) and after PROFILE_CACHED_CYCLES_MAX
// consecutive cached cycles stop serving cache so the failure surfaces to
// BullMQ retry. A successful live profile fetch resets the streak.

const MAX_CONSECUTIVE_CACHED_CYCLES = parseEnvInt(
  "PROFILE_CACHED_CYCLES_MAX",
  3,
  0,
  1000,
);

const cachedContinuationStreaks = new Map<string, number>();

/** Test hook: clear in-memory cached-continuation streaks between cases. */
export function resetCachedContinuationStreaksForTests(): void {
  cachedContinuationStreaks.clear();
}

/**
 * A cached profile anchor plus a reliability flag for its follower/following
 * counts (A9). `IGPublicProfile` is owned by ig-public-scraper and cannot carry
 * a per-source reliability bit, so the collector tracks it as a sibling here.
 *
 * When the cached path fires WITHOUT a prior snapshot, the following/post
 * counts are fabricated (0) and the follower count is read from a possibly
 * stale tracked_accounts column. Feeding those into the diff-aware roster gate
 * makes `currentCount !== prevCount` fire `count-changed` off garbage and
 * triggers a FULL roster enumeration over residential bandwidth. `countsReliable`
 * lets the gate skip that false trigger (see decideRosterFetch) and fall back to
 * the normal cadence decision instead — NOT a forced full enumeration.
 */
interface CachedProfileAnchor {
  readonly profile: IGPublicProfile;
  readonly countsReliable: boolean;
}

function cachedProfileFromAccount(
  account: TrackedAccount,
  prevCounts: SnapshotCounts | null,
): CachedProfileAnchor | null {
  if (!account.igUserId) return null;
  const profilePicUrl = account.profilePicUrl ?? "";
  // Counts are only trustworthy as a stable diff baseline when a prior snapshot
  // supplied them. Without one, following/post fall back to fabricated 0 and
  // follower would otherwise come from a (possibly stale) tracked_accounts
  // column. When a snapshot exists, prefer ITS follower count (the same value
  // the gate's prevCount uses) over the stale column so the gate sees no false
  // change; only fall back to the column when there is genuinely no snapshot.
  const countsReliable = prevCounts !== null;
  return {
    countsReliable,
    profile: {
      igUserId: account.igUserId,
      username: account.igUsername,
      fullName: account.displayName ?? "",
      biography: account.biography ?? "",
      profilePicUrl,
      profilePicUrlHd: profilePicUrl,
      isPrivate: account.isPrivate,
      isVerified: account.isVerified ?? false,
      isBusinessAccount: account.isBusinessAccount ?? false,
      externalUrl: account.externalUrl ?? null,
      followerCount:
        prevCounts?.followerCount ?? account.followerCount ?? 0,
      followingCount: prevCounts?.followingCount ?? 0,
      postCount: prevCounts?.postCount ?? 0,
    },
  };
}

// ── Profile-sync (used by POST /api/tracking/accounts for fast initial paint) ─

export async function syncProfile(
  trackedAccountId: string,
  username: string,
  timeoutMs: number,
  // Numeric IG user id, when already known, enables the cheap mobile-API
  // profile fallback inside getPublicProfile (a different rate-limit bucket than
  // web_profile_info). Optional: on first-track it is typically unknown, in
  // which case the fallback is simply skipped.
  igUserId?: string | null,
): Promise<PublicDataResult<IGPublicProfile>> {
  const fetchPromise = getPublicProfile(username, igUserId);
  const timeoutPromise = new Promise<PublicDataResult<IGPublicProfile>>(
    (resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: false,
            error: `profile sync timed out after ${timeoutMs}ms`,
            source: "none",
          }),
        timeoutMs,
      ),
  );
  const result = await Promise.race([fetchPromise, timeoutPromise]);

  if (result.ok) {
    await applyProfileToDb(trackedAccountId, result.data);
  }
  return result;
}

// ── Apply a fetched profile to the DB (update tracked_accounts + snapshot) ──

export async function applyProfileToDb(
  trackedAccountId: string,
  profile: IGPublicProfile,
): Promise<void> {
  const now = new Date();

  // Guard against clobbering good data with an all-zero read. IG occasionally
  // returns a valid-SHAPED user object with follower/following/post counts all
  // zeroed under a soft-block / rate-limit / stripped response (seen on the
  // mobile-info and browser legs). For a tracked account — which by definition
  // existed with real counts when it was added — a 0/0/0 profile is
  // effectively never true and is a corrupt read, not a legitimate update.
  // Persisting it wiped e.g. example_account 671 → 0. Skip the write entirely
  // (both the tracked_accounts count and the snapshot row); the next healthy
  // cycle re-fetches real numbers. is_private is intentionally NOT part of the
  // gate: private accounts still report real follower/following counts.
  if (
    profile.followerCount === 0 &&
    profile.followingCount === 0 &&
    profile.postCount === 0
  ) {
    logger.warn(
      { trackedAccountId, igUsername: profile.username },
      "[collector] skipping all-zero profile persist (suspected stripped/rate-limited read; not clobbering existing counts)",
    );
    return;
  }

  await db
    .update(trackedAccounts)
    .set({
      igUserId: profile.igUserId || null,
      displayName: profile.fullName || null,
      profilePicUrl: profile.profilePicUrl || null,
      biography: profile.biography || null,
      // Normalise "" → null to match the sibling fields above. The parse layer
      // (parseProfileResponse) already resolves empty external_url to null, but
      // any other IGPublicProfile producer must not persist a bare "".
      externalUrl: profile.externalUrl || null,
      isVerified: profile.isVerified,
      isBusinessAccount: profile.isBusinessAccount,
      isPrivate: profile.isPrivate,
      followerCount: profile.followerCount,
      lastProfileRefreshAt: now,
      updatedAt: now,
    })
    .where(eq(trackedAccounts.id, trackedAccountId));

  await db.insert(profileSnapshots).values({
    trackedAccountId,
    igUsername: profile.username,
    followerCount: profile.followerCount,
    followingCount: profile.followingCount,
    postCount: profile.postCount,
    fullName: profile.fullName || null,
    biography: profile.biography || null,
    profilePicUrl: profile.profilePicUrl || null,
    profilePicUrlHd: profile.profilePicUrlHd || null,
    externalUrl: profile.externalUrl || null,
    isVerified: profile.isVerified,
    isBusinessAccount: profile.isBusinessAccount,
    isPrivate: profile.isPrivate,
  });

  // Wave 4: live-update the dashboard the moment a fresh snapshot lands.
  emitRealtime({
    kind: "profile.updated",
    trackedAccountId,
    igUsername: profile.username,
    count: 1,
    payload: {
      followerCount: profile.followerCount,
      followingCount: profile.followingCount,
      postCount: profile.postCount,
    },
  });
}

// ── Outcome builders (small helpers per piece keep collectPublicData flat) ──

function skippedOutcome(
  source: string,
  error: string,
): Omit<CollectOutcome, "profile" | "isPrivate"> {
  return {
    posts: { count: 0, source, error },
    stories: { count: 0, source, error },
    highlights: { count: 0, source, error },
    following: { source, newFollows: 0, newUnfollows: 0, error },
    followers: {
      source,
      newFollowers: 0,
      newFollowerUnfollows: 0,
      error,
    },
  };
}

function failedProfileOutcome(
  account: TrackedAccount,
  source: string,
  error: string,
): CollectOutcome {
  return {
    profile: { ok: false, source, error },
    ...skippedOutcome("none", SKIP_NO_PROFILE),
    isPrivate: account.isPrivate,
  };
}

function privateProfileOutcome(profileSource: string): CollectOutcome {
  return {
    profile: { ok: true, source: profileSource },
    ...skippedOutcome("skipped", SKIP_PRIVATE),
    isPrivate: true,
  };
}

// Highlights are passed as a minimal read shape (ok + data) rather than the
// full PublicDataResult: the content-incremental path synthesizes this from
// the highlights it actually fetched, and this helper only ever reads .ok/.data.
type HighlightsForMedia =
  | { readonly ok: true; readonly data: ReadonlyArray<IGHighlight> }
  | { readonly ok: false };

function enqueueCollectedMedia(
  trackedAccountId: string,
  username: string,
  profile: IGPublicProfile,
  postsRes: PublicDataResult<ReadonlyArray<IGPostSummary>>,
  storiesRes: PublicDataResult<ReadonlyArray<IGStoryItem>>,
  highlightsRes: HighlightsForMedia,
): void {
  const urls = new Set<string>();
  const add = (url: string | null | undefined): void => {
    if (url) urls.add(url);
  };

  add(profile.profilePicUrl);

  if (postsRes.ok) {
    for (const post of postsRes.data) {
      add(post.thumbnailUrl);
      add(post.displayUrl);
      add(post.videoUrl);
      // Fix #7: durably cache carousel children too, just like primary post
      // media — otherwise sidecar child images keep pointing at expiring IG
      // CDN URLs and the modal breaks once they rotate.
      for (const child of post.carouselMedia ?? []) {
        add(child.displayUrl);
        add(child.videoUrl);
      }
    }
  }

  if (storiesRes.ok) {
    for (const story of storiesRes.data) {
      add(story.mediaUrl);
      add(story.thumbnailUrl);
    }
  }

  if (highlightsRes.ok) {
    for (const highlight of highlightsRes.data) {
      add(highlight.coverUrl);
      for (const item of highlight.items ?? []) {
        add(item.mediaUrl);
        add(item.thumbnailUrl);
      }
    }
  }

  enqueueMediaCacheUrls(urls, "scrape")
    .then((count) => {
      if (count > 0) {
        logger.info(
          { trackedAccountId, username, count },
          "queued collected media for durable cache",
        );
      }
    })
    .catch((err) =>
      logger.warn(
        { trackedAccountId, username, error: errorMessage(err) },
        "failed to queue collected media cache jobs",
      ),
    );
}

/**
 * Shared shape for posts/stories/highlights — each persists a list and
 * returns a count. Generic over the data type so the discriminated union
 * stays narrow inside the call site.
 */
async function buildCountOutcome<T>(
  res: PublicDataResult<T>,
  persist: (data: T) => Promise<number>,
): Promise<{ readonly count: number; readonly source: string; readonly error?: string }> {
  if (!res.ok) {
    return { count: 0, source: res.source, error: res.error };
  }
  try {
    const count = await persist(res.data);
    return { count, source: res.source };
  } catch (err) {
    return { count: 0, source: res.source, error: errorMessage(err) };
  }
}

/** The `{count, source, error?}` shape every content branch reports up. */
type CountOutcome = {
  readonly count: number;
  readonly source: string;
  readonly error?: string;
};

/**
 * Highlights outcome — the count/source/error contract plus the fetched
 * highlights (only present when a full reels fetch actually ran this cycle).
 * The collector forwards `highlights` to enqueueCollectedMedia so covers and
 * reel items still land in the durable media cache. On the UNCHANGED path
 * there is nothing new to enqueue (it was queued the cycle it last changed),
 * so `highlights` is omitted.
 */
type HighlightsOutcome = CountOutcome & {
  readonly highlights?: ReadonlyArray<IGHighlight>;
};

/**
 * A content-comparable fingerprint of a highlights tray: the sorted set of
 * `${highlightId}:${mediaCount}` keys. Two trays with the same fingerprint
 * have the same highlights with the same item counts. This permits skipping
 * a recent full read, but cannot detect title/cover edits or item replacement.
 *
 * Sorting makes the comparison order-independent (IG can reorder the tray);
 * joining with a delimiter the keys cannot contain keeps it collision-free.
 */
function highlightTrayFingerprint(
  pairs: ReadonlyArray<readonly [string, number]>,
): string {
  return pairs
    .map(([id, count]) => `${id}:${count}`)
    .sort()
    .join("|");
}

/** Use the oldest persisted parent/item timestamp: a parent upsert alone
 * (or URL renewal) is not proof that the inner reels were refreshed. */
async function highlightFullReadIsFresh(trackedAccountId: string, highlightIds: string[]): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT CASE WHEN bool_and(COALESCE(items.n,0)>=COALESCE(h.media_count,0))
      THEN min(least(h.cached_at,COALESCE(items.cached_at,h.cached_at))) END AS "lastFullReadAt"
    FROM highlights_cache h
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT story_id)::int AS n,min(cached_at) AS cached_at
      FROM highlight_items_cache WHERE highlight_cache_id=h.id
    ) items ON true
    WHERE h.tracked_account_id=${trackedAccountId} AND h.highlight_id=ANY(${highlightIds}::text[])
  `);
  const rows = Array.isArray(result) ? result : result.rows;
  const last = (rows[0] as { lastFullReadAt?: Date | string | null } | undefined)?.lastFullReadAt;
  const lastMs = last == null ? NaN : new Date(last).getTime();
  return Number.isFinite(lastMs) && Date.now() - lastMs < getCachedRefreshIntervalSec() * 1_000;
}

/**
 * Content-incremental highlights collection.
 *
 * Highlights are ~68% of all scrape bandwidth: the cheap tray is one browser
 * request, but `withItems=true` ALSO walks every reel (~25 requests / 2.5MB
 * for a big account). Re-walking unchanged reels every cycle is pure waste.
 *
 * Strategy:
 *   1. Fetch the cheap tray (`withItems=false`). On failure, propagate the
 *      error WITHOUT touching persistence — a transient tray failure must
 *      never be allowed to wipe the cached highlights (persistHighlights does
 *      a delete-then-reinsert of items, so persisting an empty/partial set
 *      would destroy saved data).
 *   2. Compare the tray's `${highlightId}:${mediaCount}` fingerprint against
 *      the cached baseline. If the tray is non-empty and the fingerprints are
 *      identical and a full read is still within the configured refresh
 *      interval → skip the reels fetch and persistence entirely.
 *   3. Otherwise fetch full reels, verify item coverage, then persist.
 *
 * Returns the same `{count, source, error?}` shape buildCountOutcome produces,
 * so it slots directly into the parallel content fetch in either call site.
 *
 * The bot-aware private path passes `botAccountId`; the public path omits it.
 *
 * Exported for unit testing the unchanged/changed/first-time branches in
 * isolation.
 */
async function requirePrivateCollectionAccess(trackedAccountId: string, botAccountId: string): Promise<void> {
  if (!await privateBotHasAccess(trackedAccountId, botAccountId)) {
    throw new Error("Private collection access ended");
  }
}

export async function collectHighlightsIncremental(
  trackedAccountId: string,
  username: string,
  igUserId: string,
  botAccountId?: string,
): Promise<HighlightsOutcome> {
  const assertAccess = async () => {
    if (botAccountId) await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
  };
  const fetchTray = async (): Promise<PublicDataResult<ReadonlyArray<IGHighlight>>> => {
    await assertAccess();
    return botAccountId
      ? getUserHighlightsAsBot(username, igUserId, botAccountId, false)
      : getUserHighlights(username, igUserId, false);
  };
  const fetchFull = async (): Promise<PublicDataResult<ReadonlyArray<IGHighlight>>> => {
    await assertAccess();
    return botAccountId
      ? getUserHighlightsAsBot(username, igUserId, botAccountId, true)
      : getUserHighlights(username, igUserId, true);
  };

  const persistFull = async (expectedTray?: ReadonlyArray<IGHighlight>): Promise<HighlightsOutcome> => {
    const fullRes = await fetchFull();
    await assertAccess();
    if (fullRes.ok && (fullRes.data.some(h => new Set(h.items.map(item => item.storyId)).size < h.mediaCount) ||
        expectedTray?.some(h => !fullRes.data.some(full => full.highlightId === h.highlightId)))) {
      return { count: 0, source: fullRes.source, error: "incomplete highlight reels; retained saved highlights" };
    }
    const outcome = await buildCountOutcome(fullRes, (data) =>
      persistHighlights(trackedAccountId, data),
    );
    // Surface the fetched highlights (covers + reel items) so the caller can
    // enqueue them for the durable media cache. Only present on a successful
    // full fetch.
    return fullRes.ok && !outcome.error ? { ...outcome, highlights: fullRes.data } : outcome;
  };

  // Incremental disabled → restore the legacy always-full behavior.
  if (!HIGHLIGHTS_INCREMENTAL_ENABLED) {
    return persistFull();
  }

  // (a) Cheap tray. Never wipe saved highlights on a transient tray failure.
  const trayRes = await fetchTray();
  if (!trayRes.ok) {
    return { count: 0, source: trayRes.source, error: trayRes.error };
  }
  const tray = trayRes.data;

  // (b) Cached baseline (highlightId → mediaCount).
  let saved: Map<string, number>;
  try {
    saved = await loadSavedHighlightMediaCounts(trackedAccountId);
  } catch (err) {
    // Baseline read failed — fall back to the full path rather than risk a
    // false "unchanged" against an incomplete baseline. Persist still happens
    // on a successful full fetch, so saved data stays correct.
    logger.warn(
      { trackedAccountId, username, error: errorMessage(err) },
      "highlights: baseline load failed — falling back to full fetch",
    );
    return persistFull(tray);
  }

  // (e) Tray empty AND baseline empty → nothing to do, nothing to wipe.
  if (tray.length === 0 && saved.size === 0) {
    return { count: 0, source: trayRes.source };
  }

  // (c) Compare fingerprints. Only treat as UNCHANGED when the tray is
  //     non-empty and matches the baseline exactly. (Tray empty but baseline
  //     non-empty falls through to the full path so persist reflects the
  //     account having removed all its highlights — case (e), second half.)
  const trayFingerprint = highlightTrayFingerprint(
    tray.map((h) => [h.highlightId, h.mediaCount] as const),
  );
  const savedFingerprint = highlightTrayFingerprint(Array.from(saved.entries()));

  if (tray.length > 0 && tray.every(h => h.mediaCountKnown !== false) && trayFingerprint === savedFingerprint) {
    const fresh = await highlightFullReadIsFresh(trackedAccountId, tray.map(h => h.highlightId)).catch(() => false);
    if (!fresh) return persistFull(tray);
    logger.info(
      { trackedAccountId, username, highlights: tray.length },
      `highlights unchanged — skipped reels fetch, saved ${tray.length}x items of bandwidth`,
    );
    // No reels fetch, no persistHighlights (which would otherwise delete +
    // reinsert items). The cache already holds the current state.
    return { count: tray.length, source: "cache" };
  }

  // (d) Changed / new / first-time / removed-all → full fetch + persist.
  return persistFull(tray);
}

/**
 * Follow-list result as the collector sees it: the LRU paginators
 * (getAllUserFollowers/-ing) always attach the completeness signal; the
 * bot-pinned variants and the disabled/skipped literals do not — for those
 * `complete` is undefined ("unknown") and the truncated gate stays out of
 * the way (legacy behavior).
 */
type FollowListRes = PublicDataResult<ReadonlyArray<IGFollowUser>> & {
  readonly complete?: boolean;
  readonly stopReason?: FollowListStopReason;
  /** Resume point of a truncated walk (null/undefined = none). */
  readonly nextCursor?: string | null;
  /**
   * Pages the walk read. public-data-service logs this only on truncation and
   * does not yet expose it on the result; the outcome line prints it when
   * present (null until the service carries it).
   */
  readonly pagesFetched?: number;
  readonly rawItemsFetched?: number;
  readonly viewerBotId?: string;
  readonly startedFromTop?: boolean;
};

interface WalkOutcomeLogFields {
  readonly trackedAccountId: string;
  readonly username: string;
  readonly kind: RosterKind;
  readonly res: FollowListRes;
  /** Undefined for walks without a resume cursor (private-account path). */
  readonly walk: WalkContext | undefined;
  readonly durationMs: number;
}

/**
 * One line per ATTEMPTED roster walk, whatever the outcome (audit 2026-09-02,
 * C10a). Before this, pages/duration were logged only on truncation and a
 * healthy walk left no trace but its persisted diff — so a roster whose
 * `last_complete_read_at` had stopped moving (sample 6 d, example 39 d) could
 * not be explained from the logs. Walks the gate skipped are not outcomes;
 * the "[diff-aware] roster gate decision" line covers those.
 */
function logRosterWalkOutcome(fields: WalkOutcomeLogFields): void {
  const { res, walk } = fields;
  const leg = describeWalkLeg(res, walk);
  logger.info(
    {
      trackedAccountId: fields.trackedAccountId,
      username: fields.username,
      kind: fields.kind,
      ok: res.ok,
      source: res.source,
      durationMs: fields.durationMs,
      itemsFetched: res.ok ? res.data.length : 0,
      pagesFetched: res.ok ? (res.pagesFetched ?? null) : null,
      rawItemsFetched: res.ok ? (res.rawItemsFetched ?? null) : null,
      distinctItemsFetched: res.ok ? new Set(res.data.map(u => u.igUserId || u.username.toLowerCase())).size : 0,
      viewerBotId: res.ok ? (res.viewerBotId ?? null) : null,
      complete: res.ok ? (res.complete ?? null) : null,
      stopReason: res.ok ? (res.stopReason ?? null) : null,
      resumed: walk ? walk.startCursor !== null : null,
      hasResumeCursor: res.ok && typeof res.nextCursor === "string" && res.nextCursor.length > 0,
      epochLeg: leg ? { startsEpoch: leg.startsEpoch, endsEpoch: leg.endsEpoch } : null,
      error: res.ok ? null : res.error,
    },
    "[collector] roster walk outcome",
  );
}

/** True only for an ok capture explicitly marked complete (cursor exhausted). */
function isCompleteCapture(res: FollowListRes): boolean {
  return res.ok && res.complete === true;
}

/** How the collector started this walk; places the capture in its read epoch. */
interface WalkContext {
  /** Cursor the walk resumed from; null = it started at the top of the list. */
  readonly startCursor: string | null;
}

/**
 * Epoch position of a capture (roster-store "Read epochs"): a walk that began
 * at the top starts an epoch, one that exhausted the list ends it. Only results
 * carrying the completeness signal can be placed; legacy / bot-pinned results
 * (no `complete`) stay one complete logical read, exactly as before.
 */
function describeWalkLeg(
  res: FollowListRes,
  walk: WalkContext | undefined,
): RosterReadLeg | undefined {
  if (!walk || !res.ok || typeof res.complete !== "boolean") return undefined;
  return { startsEpoch: res.source === "apify" || res.startedFromTop === true || walk.startCursor === null, endsEpoch: res.complete };
}

/**
 * A truncated capture that left a resume cursor is a mid-epoch leg: persistence
 * records its sightings and judges absence only when the epoch ends. The B2
 * skip below exists to keep a truncated capture away from the unfollow diff —
 * unnecessary for such a leg, and harmful: skipping it drops its arrivals and
 * punches a hole in the epoch's seen-set that would surface as false
 * departures when the epoch closes.
 */
function isResumableLeg(res: FollowListRes, walk: WalkContext | undefined): boolean {
  return (
    walk !== undefined &&
    res.ok &&
    typeof res.nextCursor === "string" &&
    res.nextCursor.length > 0
  );
}

/** Head-walk capture: arrivals only, never absence evidence (roster-store). */
const FOLLOWERS_HEAD_LEG: RosterReadLeg = {
  startsEpoch: false,
  endsEpoch: false,
  headOnly: true,
};

/**
 * B2 call-site gate: a TRUNCATED capture must never feed unfollow detection.
 * persistFollow{er,ing}Diff internally allows the unfollow side whenever the
 * capture covers >= 90% of the expected count (shouldComputeUnfollowDiff) —
 * which a truncated capture can easily satisfy (e.g. item cap at 15000 of an
 * expected 15500 → ratio 0.97) and then mass-emit false unfollow events for
 * everyone behind the truncation point.
 *
 * We predict the downstream decision with the SAME inputs persistence will
 * use (fetchExpectedCount + shouldComputeUnfollowDiff from
 * diff-completeness): if it would compute unfollows, the persist call is
 * skipped entirely. If it would already suppress unfollows (ratio < 0.9 —
 * the common case for capped large accounts), the persist call proceeds so
 * the additive side (new follows/followers) still lands.
 *
 * Returns true when the diff persist must be SKIPPED.
 */
async function shouldSuppressTruncatedDiff(
  trackedAccountId: string,
  kind: "follower" | "following",
  capturedCount: number,
  stopReason: FollowListStopReason | undefined,
): Promise<boolean> {
  let expected: number | null = null;
  let wouldComputeUnfollows = true; // fail safe: unreadable baseline → skip
  try {
    expected = await fetchExpectedCount(trackedAccountId, kind);
    wouldComputeUnfollows = shouldComputeUnfollowDiff(
      capturedCount,
      expected,
    ).allowUnfollowDiff;
  } catch (err) {
    logger.warn(
      { trackedAccountId, kind, error: errorMessage(err) },
      "[truncated-capture] failed to read expected baseline — suppressing diff (fail safe)",
    );
  }
  logger.warn(
    {
      trackedAccountId,
      kind,
      captured: capturedCount,
      expected,
      stopReason: stopReason ?? "unknown",
      suppressed: wouldComputeUnfollows,
    },
    wouldComputeUnfollows
      ? "[truncated-capture] roster capture truncated and downstream gate would compute unfollows — skipping diff persist to prevent false mass-unfollows"
      : "[truncated-capture] roster capture truncated — persisting additive side only (downstream completeness gate suppresses unfollows)",
  );
  return wouldComputeUnfollows;
}

function truncatedDiffError(stopReason: FollowListStopReason | undefined): string {
  return `truncated capture (${stopReason ?? "unknown"}): diff skipped to prevent false unfollows`;
}

async function emptyRosterError(trackedAccountId: string, kind: RosterKind, res: FollowListRes, walk?: WalkContext): Promise<string | undefined> {
  // A resumed final page may legitimately be empty. An empty full read of a
  // nonempty profile is unavailable data, even when upstream omits its cursor.
  if (!res.ok || res.data.length > 0 || res.complete !== true || walk?.startCursor || res.startedFromTop === false) return;
  const expected = await fetchExpectedCount(trackedAccountId, kind);
  if (expected == null || expected <= 0) return;
  const error = "empty roster despite a nonzero profile count; retained saved members";
  await recordRosterFetchFailure(trackedAccountId, kind, error);
  return error;
}

async function buildFollowingOutcome(
  trackedAccountId: string,
  res: FollowListRes,
  walk?: WalkContext,
): Promise<CollectOutcome["following"]> {
  if (!res.ok) {
    return {
      source: res.source,
      newFollows: 0,
      newUnfollows: 0,
      error: res.error,
    };
  }
  const emptyError = await emptyRosterError(trackedAccountId, "following", res, walk);
  if (emptyError) return { source: res.source, newFollows: 0, newUnfollows: 0, error: emptyError };
  if (
    res.complete === false &&
    !isResumableLeg(res, walk) &&
    (await shouldSuppressTruncatedDiff(
      trackedAccountId,
      "following",
      res.data.length,
      res.stopReason,
    ))
  ) {
    return {
      source: res.source,
      newFollows: 0,
      newUnfollows: 0,
      error: truncatedDiffError(res.stopReason),
    };
  }
  try {
    const diff = await persistFollowingDiff(trackedAccountId, res.data, {
      // The independent actor advertises a complete, no-login export and the
      // wrapper only marks it complete when it exhausted below our item cap.
      // Treat that one authoritative import as the initial baseline so the
      // customer sees the recovered roster immediately instead of paying for
      // three identical actor runs merely to satisfy native-pagination settle.
      trustedBaseline: res.source === "apify" && res.complete === true,
      leg: describeWalkLeg(res, walk),
      ...(walk ? { cursor: { nextCursor: res.nextCursor ?? null, viewerBotId: res.viewerBotId } } : {}),
    });
    const coverageError = res.complete === true && !diff.completeRead
      ? "roster exhausted below verified member coverage; retained saved members"
      : undefined;
    if (res.source === "apify" && diff.completeRead) {
      await recordExternalRosterSuccessCooldown(trackedAccountId, "following");
    }
    return {
      source: res.source,
      newFollows: diff.newFollows,
      newUnfollows: diff.newUnfollows,
      ...(coverageError ? { error: coverageError } : {}),
    };
  } catch (err) {
    return {
      source: res.source,
      newFollows: 0,
      newUnfollows: 0,
      error: errorMessage(err),
    };
  }
}

async function buildFollowersOutcome(
  trackedAccountId: string,
  res: FollowListRes,
  walk?: WalkContext,
): Promise<CollectOutcome["followers"]> {
  if (!res.ok) {
    return {
      source: res.source,
      newFollowers: 0,
      newFollowerUnfollows: 0,
      error: res.error,
    };
  }
  const emptyError = await emptyRosterError(trackedAccountId, "follower", res, walk);
  if (emptyError) return { source: res.source, newFollowers: 0, newFollowerUnfollows: 0, error: emptyError };
  if (
    res.complete === false &&
    !isResumableLeg(res, walk) &&
    (await shouldSuppressTruncatedDiff(
      trackedAccountId,
      "follower",
      res.data.length,
      res.stopReason,
    ))
  ) {
    return {
      source: res.source,
      newFollowers: 0,
      newFollowerUnfollows: 0,
      error: truncatedDiffError(res.stopReason),
    };
  }
  try {
    const diff = await persistFollowerDiff(trackedAccountId, res.data, {
      trustedBaseline: res.source === "apify" && res.complete === true,
      leg: describeWalkLeg(res, walk),
      ...(walk ? { cursor: { nextCursor: res.nextCursor ?? null, viewerBotId: res.viewerBotId } } : {}),
    });
    const coverageError = res.complete === true && !diff.completeRead
      ? "roster exhausted below verified member coverage; retained saved members"
      : undefined;
    if (res.source === "apify" && diff.completeRead) {
      await recordExternalRosterSuccessCooldown(trackedAccountId, "follower");
    }
    return {
      source: res.source,
      newFollowers: diff.newFollowers,
      newFollowerUnfollows: diff.newFollowerUnfollows,
      ...(coverageError ? { error: coverageError } : {}),
    };
  } catch (err) {
    return {
      source: res.source,
      newFollowers: 0,
      newFollowerUnfollows: 0,
      error: errorMessage(err),
    };
  }
}

/**
 * C9 head-walk. The full walk of a large, complete followers roster is deferred
 * for up to ROSTER_COMPLETE_REWALK_HOURS. Recent arrivals have been observed
 * on its head pages, but upstream ordering is NOT a complete change feed. Read the first
 * ROSTER_HEAD_PAGES pages and persist ARRIVALS only — no departures, no cursor
 * change, no complete-read stamp, no refresh anchors. A failure here is logged
 * and otherwise ignored: the deferred full walk is still the source of truth.
 */
// A head-walk right after a full walk finds nothing new. Skip it while the last
// graph refresh is younger than ROSTER_HEAD_WALK_MIN_GAP_MIN (default 120 min,
// 10..1440) — one head-walk per 3 h tick when the full walk is skipped.
const ROSTER_HEAD_WALK_MIN_GAP_MS = (() => {
  const raw = Number(process.env.ROSTER_HEAD_WALK_MIN_GAP_MIN ?? "120");
  const minutes = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 10), 1440) : 120;
  return minutes * 60 * 1000;
})();
export function headWalkDue(lastRefreshAt: Date | string | null | undefined, nowMs: number): boolean {
  if (!lastRefreshAt) return true;
  const t = new Date(lastRefreshAt).getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= ROSTER_HEAD_WALK_MIN_GAP_MS;
}

async function runFollowersHeadWalk(
  trackedAccountId: string,
  username: string,
  igUserId: string,
  baselineOnly = false,
): Promise<void> {
  if (ROSTER_HEAD_PAGES <= 0) return;
  const startedMs = Date.now();
  const res: FollowListRes = await getAllUserFollowers(username, igUserId, {
    startCursor: null,
    maxPages: ROSTER_HEAD_PAGES,
    maxItems: FOLLOW_GRAPH_MAX_ITEMS,
    pageDelayMinMs: FOLLOW_GRAPH_PAGE_DELAY_MIN_MS,
    pageDelayMaxMs: FOLLOW_GRAPH_PAGE_DELAY_MAX_MS,
    // A peek is never worth a paid provider run.
    allowProviderOutageFallback: false,
  }).catch(
    (err): FollowListRes => ({ ok: false, error: errorMessage(err), source: "bot" }),
  );
  if (!res.ok) {
    logger.warn(
      {
        trackedAccountId,
        username,
        pages: ROSTER_HEAD_PAGES,
        durationMs: Date.now() - startedMs,
        error: res.error,
      },
      "[collector] roster head-walk failed; full walk stays deferred",
    );
    return;
  }
  try {
    const diff = await persistFollowerDiff(trackedAccountId, res.data, {
      leg: FOLLOWERS_HEAD_LEG,
      baselineOnly,
    });
    logger.info(
      {
        trackedAccountId,
        username,
        pages: ROSTER_HEAD_PAGES,
        captured: res.data.length,
        pagesFetched: res.pagesFetched ?? null,
        durationMs: Date.now() - startedMs,
        stopReason: res.stopReason ?? null,
        newFollowers: diff.newFollowers,
      },
      "[collector] roster head-walk",
    );
  } catch (err) {
    logger.warn(
      { trackedAccountId, username, pages: ROSTER_HEAD_PAGES, error: errorMessage(err) },
      "[collector] roster head-walk persist failed",
    );
  }
}

// ── Engagement re-scrape memory helpers (migration 0042) ────────────────────

/** Composite key for the in-memory view of `post_engagement_checks`. */
function engagementCheckKey(
  mediaId: string,
  kind: PostEngagementCheckKind,
): string {
  return `${mediaId}\0${kind}`;
}

/**
 * Is this post still inside the "engagement is actively moving" window?
 *
 * A post we cannot date is treated as FRESH. This filter can only ever cause
 * MORE scraping, never less: failing the other way would let one unparseable
 * timestamp silently drop a post out of collection (CLAUDE.md lesson 2 — the
 * fail-closed direction here is the direction that keeps scraping).
 */
export function isFreshEngagementPost(
  takenAt: Date | string | null | undefined,
  nowMs: number,
): boolean {
  if (ENGAGEMENT_FRESH_POST_HOURS <= 0) return false;
  const parsed =
    takenAt instanceof Date ? takenAt : takenAt ? new Date(takenAt) : null;
  const ms = parsed ? parsed.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) return true;
  return nowMs - ms < ENGAGEMENT_FRESH_POST_HOURS * HOUR_MS;
}

/**
 * The whole age-tiering decision for one post + one endpoint.
 *
 * Ordered so that every path that is not "an OLD post we successfully scraped
 * inside the recheck window" returns true — i.e. every ambiguity resolves to
 * scraping, never to skipping.
 */
export function shouldScrapeEngagement(
  takenAt: Date | string | null | undefined,
  checkedRecently: boolean,
  nowMs: number,
): boolean {
  // Memory disabled → behave exactly as before this change.
  if (ENGAGEMENT_RECHECK_HOURS <= 0) return true;
  // Nothing recorded inside the recheck window (or the memory was unreadable,
  // which loads as an empty set) → scrape.
  if (!checkedRecently) return true;
  // Recorded, but the post is young enough that its engagement is still
  // growing → scrape anyway. This is the clause that preserves the behaviour
  // the product depends on.
  return isFreshEngagementPost(takenAt, nowMs);
}

/**
 * media/kind pairs scraped successfully inside the recheck window. Loaded ONCE
 * per cycle for the <=ENGAGEMENT_POSTS_PER_CYCLE posts about to be iterated.
 *
 * Fails OPEN: an unreadable memory returns an empty set, so the cycle re-scrapes
 * (merely the old wasteful behaviour). Failing closed would skip every post and
 * silently stop engagement collection altogether.
 */
async function loadRecentEngagementChecks(
  mediaIds: ReadonlyArray<string>,
): Promise<Set<string>> {
  if (ENGAGEMENT_RECHECK_HOURS <= 0 || mediaIds.length === 0) {
    return new Set<string>();
  }
  try {
    const cutoff = new Date(Date.now() - ENGAGEMENT_RECHECK_HOURS * HOUR_MS);
    const rows = await db
      .select({
        mediaId: postEngagementChecks.mediaId,
        kind: postEngagementChecks.kind,
      })
      .from(postEngagementChecks)
      .where(
        and(
          inArray(postEngagementChecks.mediaId, [...mediaIds]),
          gte(postEngagementChecks.checkedAt, cutoff),
        ),
      );
    return new Set(rows.map((r) => engagementCheckKey(r.mediaId, r.kind)));
  } catch (err) {
    logger.warn(
      { mediaIds: mediaIds.length, error: errorMessage(err) },
      "engagement scrape: could not load checked-post memory; re-scraping",
    );
    return new Set<string>();
  }
}

/**
 * Remember a SUCCESSFUL scrape so later cycles can skip this post+kind while it
 * is outside the fresh window. Only successes are recorded — a failed read
 * learned nothing about the post, and suppressing it would blind the scrape to
 * that post for the whole recheck window.
 */
async function recordEngagementCheck(
  trackedAccountId: string,
  post: IGPostSummary,
  kind: PostEngagementCheckKind,
): Promise<void> {
  if (ENGAGEMENT_RECHECK_HOURS <= 0) return;
  try {
    const takenAt =
      post.takenAt instanceof Date && Number.isFinite(post.takenAt.getTime())
        ? post.takenAt
        : null;
    const now = new Date();
    await db
      .insert(postEngagementChecks)
      .values({
        mediaId: post.mediaId,
        kind,
        postShortcode: post.shortcode,
        trackedAccountId,
        postTakenAt: takenAt,
        checkedAt: now,
      })
      .onConflictDoUpdate({
        target: [postEngagementChecks.mediaId, postEngagementChecks.kind],
        set: { checkedAt: now, trackedAccountId, postTakenAt: takenAt },
      });
  } catch (err) {
    // Non-fatal: losing one bookkeeping row costs one duplicate scrape.
    logger.warn(
      {
        trackedAccountId,
        mediaId: post.mediaId,
        kind,
        error: errorMessage(err),
      },
      "engagement scrape: could not record checked post",
    );
  }
}

// ── Per-post engagement (likers + comments) ─────────────────────────────────
//
// After posts persist, iterate the N most recent posts and inline-scrape
// likers + comments for each. Each call leases its own bot via the same
// `runBot()` path the rest of the collector uses (see public-data-service);
// no new BullMQ queues, no new workers. Per-post errors are swallowed so
// one bad post cannot abort the whole cycle.
//
// Age-tiered re-scrape (0042): a post inside ENGAGEMENT_FRESH_POST_HOURS is
// scraped every cycle; an older one at most once per ENGAGEMENT_RECHECK_HOURS.
async function collectPostEngagement(
  trackedAccountId: string,
  username: string,
  posts: ReadonlyArray<IGPostSummary>,
): Promise<EngagementCollectOutcome> {

  const eligible = posts.filter((p) => p.shortcode && p.mediaId);
  const targets = eligible.slice(0, ENGAGEMENT_POSTS_PER_CYCLE);
  const skipped = eligible.length - targets.length;

  if (skipped > 0) {
    logger.info(
      {
        trackedAccountId,
        username,
        eligible: eligible.length,
        scraping: targets.length,
        skippedOlder: skipped,
      },
      "engagement scrape: capped to recent posts (skipped older posts)",
    );
  }

  let likersOk = 0;
  let commentsOk = 0;
  let errors = 0;
  let likersFailed = 0;
  let commentsFailed = 0;
  let likersSkipped = 0;
  let commentsSkipped = 0;
  let freshPosts = 0;

  const nowMs = Date.now();
  const checked = await loadRecentEngagementChecks(
    targets.map((p) => p.mediaId),
  );

  for (const post of targets) {
    const { shortcode, mediaId } = post;
    if (isFreshEngagementPost(post.takenAt, nowMs)) freshPosts += 1;

    const scrapeLikers = shouldScrapeEngagement(
      post.takenAt,
      checked.has(engagementCheckKey(mediaId, "likers")),
      nowMs,
    );
    const scrapeComments = shouldScrapeEngagement(
      post.takenAt,
      checked.has(engagementCheckKey(mediaId, "comments")),
      nowMs,
    );
    if (!scrapeLikers) likersSkipped += 1;
    if (!scrapeComments) commentsSkipped += 1;
    if (!scrapeLikers && !scrapeComments) continue;

    const commentCount =
      typeof post.commentCount === "number" && post.commentCount > 0
        ? post.commentCount
        : 0;
    const commentsMaxItems = Math.min(
      Math.max(commentCount, 200),
      ENGAGEMENT_COMMENTS_MAX_ITEMS,
    );
    const commentsMaxPages = Math.max(10, Math.ceil(commentsMaxItems / 50));

    if (scrapeLikers) {
      try {
        const likersRes = await getPostLikers(shortcode, mediaId);
        if (likersRes.ok) {
          const { inserted } = await persistLikers(shortcode, likersRes.data);
          likersOk += 1;
          // Only a SUCCESSFUL read is remembered. A failed read learned
          // nothing, so recording it would blind the scrape to this post for
          // the whole recheck window. The in-memory set is updated too, so a
          // media id repeated inside one response is not read twice.
          checked.add(engagementCheckKey(mediaId, "likers"));
          await recordEngagementCheck(trackedAccountId, post, "likers");
          logger.info(
            {
              trackedAccountId,
              username,
              shortcode,
              scraped: likersRes.data.length,
              inserted,
              source: likersRes.source,
            },
            "engagement scrape: likers persisted",
          );
        } else {
          errors += 1;
          likersFailed += 1;
          logger.warn(
            {
              trackedAccountId,
              username,
              shortcode,
              error: likersRes.error,
              source: likersRes.source,
            },
            "engagement scrape: likers fetch failed",
          );
        }
      } catch (err) {
        errors += 1;
        likersFailed += 1;
        logger.warn(
          {
            trackedAccountId,
            username,
            shortcode,
            error: errorMessage(err),
          },
          "engagement scrape: likers threw",
        );
      }
    }

    if (scrapeComments) {
      try {
        const commentsRes = await getPostComments(shortcode, mediaId, {
          maxItems: commentsMaxItems,
          maxPages: commentsMaxPages,
        });
        if (commentsRes.ok) {
          const { inserted } = await persistComments(
            shortcode,
            commentsRes.data,
          );
          commentsOk += 1;
          checked.add(engagementCheckKey(mediaId, "comments"));
          await recordEngagementCheck(trackedAccountId, post, "comments");
          logger.info(
            {
              trackedAccountId,
              username,
              shortcode,
              scraped: commentsRes.data.length,
              inserted,
              source: commentsRes.source,
            },
            "engagement scrape: comments persisted",
          );
        } else {
          errors += 1;
          commentsFailed += 1;
          logger.warn(
            {
              trackedAccountId,
              username,
              shortcode,
              error: commentsRes.error,
              source: commentsRes.source,
            },
            "engagement scrape: comments fetch failed",
          );
        }
      } catch (err) {
        errors += 1;
        commentsFailed += 1;
        logger.warn(
          {
            trackedAccountId,
            username,
            shortcode,
            error: errorMessage(err),
          },
          "engagement scrape: comments threw",
        );
      }
    }
  }

  logger.info(
    {
      trackedAccountId,
      username,
      postsIterated: targets.length,
      likersOk,
      commentsOk,
      errors,
      // 0042 saving, in IG calls this cycle did NOT have to make. Both are 0
      // when ENGAGEMENT_RECHECK_HOURS=0. `freshPosts` is the number of posts
      // still inside ENGAGEMENT_FRESH_POST_HOURS — those are never skipped, so
      // freshPosts stays a floor on how much re-scraping still happens.
      likersSkipped,
      commentsSkipped,
      freshPosts,
      recheckHours: ENGAGEMENT_RECHECK_HOURS,
      freshPostHours: ENGAGEMENT_FRESH_POST_HOURS,
    },
    "engagement scrape: cycle complete",
  );
  return {
    likers: { checked: likersOk, failed: likersFailed, skipped: likersSkipped },
    comments: { checked: commentsOk, failed: commentsFailed, skipped: commentsSkipped },
  };
}

// ── Private-account collection (bot-pinned) ─────────────────────────────────
//
// When a tracked account is private but the user has accepted a bot's follow
// request, only THAT bot can see posts/stories/highlights/engagement. The
// LRU pool would lease an unrelated bot which would 4xx. These helpers force
// the granted bot id all the way down to the IG client.

/**
 * Bot-pinned engagement scrape mirror of collectPostEngagement, but every IG
 * call goes through the granted bot. Public followers/following enumeration
 * is intentionally NOT performed here — IG returns 4xx on those endpoints
 * for private profiles even with an accepted follower.
 *
 * Carries the same 0042 age-tiered re-scrape memory as the public path, and
 * shares its rows: likers_cache / comments_cache are keyed by shortcode, so a
 * post already scraped for one tracked account has nothing new to give another.
 * The granted bot's budget is scarcer than the LRU pool's, so the saving matters
 * more here, not less.
 */
async function collectPrivatePostEngagement(
  trackedAccountId: string,
  username: string,
  botAccountId: string,
  posts: ReadonlyArray<IGPostSummary>,
): Promise<EngagementCollectOutcome> {

  const eligible = posts.filter((p) => p.shortcode && p.mediaId);
  const targets = eligible.slice(0, ENGAGEMENT_POSTS_PER_CYCLE);

  let likersOk = 0;
  let commentsOk = 0;
  let errors = 0;
  let likersFailed = 0;
  let commentsFailed = 0;
  let likersSkipped = 0;
  let commentsSkipped = 0;
  let freshPosts = 0;

  const nowMs = Date.now();
  const checked = await loadRecentEngagementChecks(
    targets.map((p) => p.mediaId),
  );

  for (const post of targets) {
    const { shortcode, mediaId } = post;
    if (isFreshEngagementPost(post.takenAt, nowMs)) freshPosts += 1;

    const scrapeLikers = shouldScrapeEngagement(
      post.takenAt,
      checked.has(engagementCheckKey(mediaId, "likers")),
      nowMs,
    );
    const scrapeComments = shouldScrapeEngagement(
      post.takenAt,
      checked.has(engagementCheckKey(mediaId, "comments")),
      nowMs,
    );
    if (!scrapeLikers) likersSkipped += 1;
    if (!scrapeComments) commentsSkipped += 1;
    if (!scrapeLikers && !scrapeComments) continue;

    const commentCount =
      typeof post.commentCount === "number" && post.commentCount > 0
        ? post.commentCount
        : 0;
    const commentsMaxItems = Math.min(
      Math.max(commentCount, 200),
      ENGAGEMENT_COMMENTS_MAX_ITEMS,
    );
    const commentsMaxPages = Math.max(10, Math.ceil(commentsMaxItems / 50));

    if (scrapeLikers) {
      await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
      try {
        const likersRes = await getPostLikersAsBot(
          shortcode,
          mediaId,
          botAccountId,
        );
        if (likersRes.ok) {
          await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
          const { inserted } = await persistLikers(shortcode, likersRes.data);
          likersOk += 1;
          checked.add(engagementCheckKey(mediaId, "likers"));
          await recordEngagementCheck(trackedAccountId, post, "likers");
          logger.info(
            {
              trackedAccountId,
              username,
              shortcode,
              scraped: likersRes.data.length,
              inserted,
              botAccountId,
            },
            "private engagement: likers persisted",
          );
        } else {
          errors += 1;
          likersFailed += 1;
          logger.warn(
            {
              trackedAccountId,
              username,
              shortcode,
              error: likersRes.error,
              botAccountId,
            },
            "private engagement: likers fetch failed",
          );
        }
      } catch (err) {
        errors += 1;
        likersFailed += 1;
        logger.warn(
          {
            trackedAccountId,
            username,
            shortcode,
            error: errorMessage(err),
            botAccountId,
          },
          "private engagement: likers threw",
        );
      }
    }

    if (scrapeComments) {
      await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
      try {
        const commentsRes = await getPostCommentsAsBot(
          shortcode,
          mediaId,
          botAccountId,
          {
            maxItems: commentsMaxItems,
            maxPages: commentsMaxPages,
            beforePage: () => requirePrivateCollectionAccess(trackedAccountId, botAccountId),
          },
        );
        if (commentsRes.ok) {
          await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
          const { inserted } = await persistComments(
            shortcode,
            commentsRes.data,
          );
          commentsOk += 1;
          checked.add(engagementCheckKey(mediaId, "comments"));
          await recordEngagementCheck(trackedAccountId, post, "comments");
          logger.info(
            {
              trackedAccountId,
              username,
              shortcode,
              scraped: commentsRes.data.length,
              inserted,
              botAccountId,
            },
            "private engagement: comments persisted",
          );
        } else {
          errors += 1;
          commentsFailed += 1;
          logger.warn(
            {
              trackedAccountId,
              username,
              shortcode,
              error: commentsRes.error,
              botAccountId,
            },
            "private engagement: comments fetch failed",
          );
        }
      } catch (err) {
        errors += 1;
        commentsFailed += 1;
        logger.warn(
          {
            trackedAccountId,
            username,
            shortcode,
            error: errorMessage(err),
            botAccountId,
          },
          "private engagement: comments threw",
        );
      }
    }
  }

  logger.info(
    {
      trackedAccountId,
      username,
      botAccountId,
      postsIterated: targets.length,
      likersOk,
      commentsOk,
      errors,
      likersSkipped,
      commentsSkipped,
      freshPosts,
      recheckHours: ENGAGEMENT_RECHECK_HOURS,
      freshPostHours: ENGAGEMENT_FRESH_POST_HOURS,
    },
    "private engagement: cycle complete",
  );
  return {
    likers: { checked: likersOk, failed: likersFailed, skipped: likersSkipped },
    comments: { checked: commentsOk, failed: commentsFailed, skipped: commentsSkipped },
  };
}

/**
 * Run the posts/stories/highlights branch using the bot that was granted
 * access, including followers/following. Returns a fully-formed
 * CollectOutcome — `isPrivate=true` is preserved so the worker still knows
 * this was a private account (UI counts on this flag).
 */
async function collectPrivateData(
  account: TrackedAccount,
  profile: IGPublicProfile,
  profileSource: string,
  botAccountId: string,
): Promise<CollectOutcome> {
  const trackedAccountId = account.id;
  const username = account.igUsername;
  const igUserId = profile.igUserId;

  // Wave 8.1: parallel fetch now includes followers + following pulled by the
  // SAME granted bot that has authenticated visibility. Pagination caps are
  // conservative (10 pages / 1000 items) to keep the granted bot's daily
  // budget intact — private accounts are typically smaller, so this still
  // captures the full graph in the common case while preventing a single
  // cycle from burning the lease on huge follow lists.
  const FOLLOW_LIST_PAGINATION = {
    maxPages: FOLLOW_GRAPH_MAX_PAGES,
    maxItems: FOLLOW_GRAPH_MAX_ITEMS,
    pageDelayMinMs: FOLLOW_GRAPH_PAGE_DELAY_MIN_MS,
    pageDelayMaxMs: FOLLOW_GRAPH_PAGE_DELAY_MAX_MS,
    beforePage: () => requirePrivateCollectionAccess(trackedAccountId, botAccountId),
  } as const;

  await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
  const storiesRes: PublicDataResult<ReadonlyArray<IGStoryItem>> = STORIES_ENABLED
    ? await getUserStoriesAsBot(username, igUserId, botAccountId)
    : { ok: false, error: "stories disabled", source: "none" };
  await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
  let postsRes: PublicDataResult<ReadonlyArray<IGPostSummary>> = POSTS_ENABLED
    ? await getUserPostsAsBot(username, igUserId, botAccountId, POSTS_PER_CYCLE)
    : { ok: false, error: "posts disabled", source: "none" };
  if (postsRes.ok && postsRes.data.length === 0 && profile.postCount > 0) {
    postsRes = { ok: false, source: postsRes.source,
      error: "empty private feed despite a nonzero profile post count; retained saved posts" };
  }
  const followersWalkStartedMs = Date.now();
  const privateFollowersCursor = FOLLOW_GRAPH_ENABLED ? await loadRosterCursor(trackedAccountId, "follower", { viewerBotId: botAccountId }) : null;
  const privateFollowingCursor = FOLLOW_GRAPH_ENABLED ? await loadRosterCursor(trackedAccountId, "following", { viewerBotId: botAccountId }) : null;
  await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
  const followersRes = FOLLOW_GRAPH_ENABLED
    ? await getAllUserFollowersAsBot(
        igUserId,
        botAccountId,
        { ...FOLLOW_LIST_PAGINATION, startCursor: privateFollowersCursor, shouldStop: isShuttingDown },
      ).catch((err): PublicDataResult<ReadonlyArray<IGFollowUser>> => {
        logger.warn(
          {
            trackedAccountId,
            username,
            botAccountId,
            error: errorMessage(err),
          },
          "private followers: fetch threw (cycle continues)",
        );
        return { ok: false, error: errorMessage(err), source: "bot" };
      })
    : { ok: false as const, error: "follow graph disabled", source: "none" as const };
  const followersWalkMs = Date.now() - followersWalkStartedMs;
  const followingWalkStartedMs = Date.now();
  await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
  const followingRes = FOLLOW_GRAPH_ENABLED
    ? await getAllUserFollowingAsBot(
        igUserId,
        botAccountId,
        { ...FOLLOW_LIST_PAGINATION, startCursor: privateFollowingCursor, shouldStop: isShuttingDown },
      ).catch((err): PublicDataResult<ReadonlyArray<IGFollowUser>> => {
        logger.warn(
          {
            trackedAccountId,
            username,
            botAccountId,
            error: errorMessage(err),
          },
          "private following: fetch threw (cycle continues)",
        );
        return { ok: false, error: errorMessage(err), source: "bot" };
      })
    : { ok: false as const, error: "follow graph disabled", source: "none" as const };
  const followingWalkMs = Date.now() - followingWalkStartedMs;
  await requirePrivateCollectionAccess(trackedAccountId, botAccountId);

  // Log the approved viewer's actual resume point for each walk.
  if (FOLLOW_GRAPH_ENABLED) {
    logRosterWalkOutcome({
      trackedAccountId,
      username,
      kind: "follower",
      res: followersRes,
      walk: { startCursor: privateFollowersCursor },
      durationMs: followersWalkMs,
    });
    logRosterWalkOutcome({
      trackedAccountId,
      username,
      kind: "following",
      res: followingRes,
      walk: { startCursor: privateFollowingCursor },
      durationMs: followingWalkMs,
    });
  }

  const [
    postsOutcome,
    storiesOutcome,
    highlightsOutcome,
    followersOutcome,
    followingOutcome,
  ] = await Promise.all([
    buildCountOutcome(postsRes, (data) =>
      // Page-1 full-feed fetch: carries every pin, so it may also unpin.
      persistPosts(trackedAccountId, data, { pinnedAuthoritative: true }),
    ),
    buildCountOutcome(storiesRes, (data) =>
      persistStories(trackedAccountId, data),
    ),
    // Content-incremental via the granted bot (botAccountId threaded through).
    HIGHLIGHTS_ENABLED
      ? collectHighlightsIncremental(
          trackedAccountId,
          username,
          igUserId,
          botAccountId,
        )
      : Promise.resolve<HighlightsOutcome>({
          count: 0,
          source: "none",
          error: "highlights disabled",
        }),
    buildFollowersOutcome(trackedAccountId, followersRes, { startCursor: privateFollowersCursor }),
    buildFollowingOutcome(trackedAccountId, followingRes, { startCursor: privateFollowingCursor }),
  ]);

  if (followersRes.ok) {
    logger.info(
      {
        trackedAccountId,
        username,
        botAccountId,
        scraped: followersRes.data.length,
        newFollowers: followersOutcome.newFollowers,
        newFollowerUnfollows: followersOutcome.newFollowerUnfollows,
      },
      "private followers: persisted",
    );
  } else {
    logger.warn(
      {
        trackedAccountId,
        username,
        botAccountId,
        error: followersRes.error,
      },
      "private followers: fetch failed",
    );
  }

  if (followingRes.ok) {
    logger.info(
      {
        trackedAccountId,
        username,
        botAccountId,
        scraped: followingRes.data.length,
        newFollows: followingOutcome.newFollows,
        newUnfollows: followingOutcome.newUnfollows,
      },
      "private following: persisted",
    );
  } else {
    logger.warn(
      {
        trackedAccountId,
        username,
        botAccountId,
        error: followingRes.error,
      },
      "private following: fetch failed",
    );
  }

  await requirePrivateCollectionAccess(trackedAccountId, botAccountId);
  enqueueCollectedMedia(
    trackedAccountId,
    username,
    profile,
    postsRes,
    storiesRes,
    { ok: true, data: highlightsOutcome.highlights ?? [] },
  );

  let engagement: EngagementCollectOutcome | undefined;
  if (postsRes.ok && postsOutcome.count > 0) {
    try {
      engagement = await collectPrivatePostEngagement(
        trackedAccountId,
        username,
        botAccountId,
        postsRes.data,
      );
    } catch (err) {
      engagement = { likers: { checked: 0, failed: 0, skipped: 0 }, comments: { checked: 0, failed: 0, skipped: 0 }, error: errorMessage(err) };
      logger.warn(
        {
          trackedAccountId,
          username,
          botAccountId,
          error: errorMessage(err),
        },
        "private engagement: top-level failure (cycle continues)",
      );
    }
  }

  return {
    profile: { ok: true, source: profileSource },
    posts: postsOutcome,
    stories: storiesOutcome,
    highlights: highlightsOutcome,
    following: followingOutcome,
    followers: followersOutcome,
    engagement,
    isPrivate: true,
  };
}

// ── Diff-aware roster gate (Phase 2) ────────────────────────────────────────

type RosterKind = "follower" | "following";

/** Live roster size for one dimension, straight from the materialized roster.
 *
 *  DB-only — no proxy bandwidth.
 *
 *  This used to reconstruct the count from the event log (a username counted as
 *  current when its latest follow event was newer than its latest unfollow
 *  event). That derivation is the bug migration 0029 removed: it drifts away
 *  from reality (@example_account: 170 derived vs 215 actually followed), and it
 *  is read here to decide whether enumeration can be SKIPPED — so a drifted
 *  count could suppress the very reads that would repair the roster.
 *
 *  Falls back to the roster's own view only; an unseeded account simply reports
 *  0, which makes shouldEnumerateRoster enumerate — exactly what a never-seeded
 *  account needs. */
async function getRosterLiveTotal(
  trackedAccountId: string,
  kind: RosterKind,
): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS total
    FROM roster_members
    WHERE tracked_account_id = ${trackedAccountId}
      AND dimension = ${kind}
      AND is_current
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  return Number(rows[0]?.total ?? 0);
}

/**
 * Copy the canonical twin's roster trust anchors onto a non-canonical twin row.
 * Exact mirror for the per-roster refresh anchors and the shared graph anchor
 * (the roster they certify IS the canonical one); `following_first_complete_at`
 * keeps the existing never-move-once-set rule (COALESCE), so a twin that had
 * its own boundary keeps it and a new twin inherits the canonical one.
 * Best-effort: a failure here must not fail the collection cycle.
 */
async function mirrorRosterAnchorsFromCanonical(
  twinTrackedAccountId: string,
  canonicalTrackedAccountId: string,
): Promise<void> {
  if (twinTrackedAccountId === canonicalTrackedAccountId) return;
  try {
    await db.execute(sql`
      UPDATE tracked_accounts AS twin
         SET last_followers_refresh_at = canon.last_followers_refresh_at,
             last_following_refresh_at = canon.last_following_refresh_at,
             last_graph_refresh_at = canon.last_graph_refresh_at,
             following_first_complete_at = COALESCE(
               twin.following_first_complete_at,
               canon.following_first_complete_at
             )
        FROM tracked_accounts AS canon
       WHERE twin.id = ${twinTrackedAccountId}
         AND canon.id = ${canonicalTrackedAccountId}
         AND canon.id <> twin.id
    `);
  } catch (err) {
    logger.warn(
      {
        trackedAccountId: twinTrackedAccountId,
        canonicalTwinId: canonicalTrackedAccountId,
        error: errorMessage(err),
      },
      "[collector] failed to mirror roster anchors from canonical twin",
    );
  }
}

/**
 * Live roster_sync_state of the given sibling rows for one dimension, shaped
 * for `pickRosterInheritanceDonor`. `current_members` counts `is_current IS
 * TRUE` rows (lesson 23: boolean predicates spelled out, never bare).
 */
async function loadRosterDonorCandidates(
  siblingIds: readonly string[],
  dimension: RosterDimension,
): Promise<RosterDonorCandidate[]> {
  if (siblingIds.length === 0) return [];
  const idList = sql.join(
    siblingIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    SELECT rss.tracked_account_id AS tracked_account_id,
           rss.last_success_at    AS last_success_at,
           (SELECT count(*)::int
              FROM roster_members rm
             WHERE rm.tracked_account_id = rss.tracked_account_id
               AND rm.dimension = rss.dimension
               AND rm.is_current IS TRUE) AS current_members
      FROM roster_sync_state rss
     WHERE rss.tracked_account_id IN (${idList})
       AND rss.dimension = ${dimension}
       AND rss.last_success_at IS NOT NULL
  `);
  const rows: Array<Record<string, unknown>> = Array.isArray(result)
    ? result
    : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  return rows.map((row) => ({
    trackedAccountId: String(row.tracked_account_id),
    lastSuccessAt: row.last_success_at
      ? new Date(row.last_success_at as string | Date)
      : null,
    currentMembers: Number(row.current_members ?? 0),
  }));
}

/**
 * Audit 2026-09-02 C7 — a canonical hand-over must not inherit a frozen roster.
 * A non-canonical twin never walks, so its roster_members / roster_sync_state
 * freeze when it loses the election (ash: 128 held vs 139 on the canonical
 * row). When the canonical row is deactivated, `canonicalTwinId` promotes the
 * frozen row; walked as-is, every member who arrived since the freeze becomes a
 * fake arrival and every departure lags the absence hysteresis. So a row that
 * IS canonical but whose own `last_success_at` trails a still-existing
 * sibling's (the deactivated former canonical) copies that sibling's roster —
 * members, sync state, read epoch and cursor — before this cycle's gates read
 * it. `pickRosterInheritanceDonor` refuses stale or empty donors and requires a
 * real lead, so a row that has been canonical all along is a no-op here, and
 * the copy is self-limiting: afterwards the two `last_success_at` are equal.
 * Best-effort: any failure is logged and the cycle continues on the roster the
 * row already holds.
 */
async function inheritRosterFromFormerCanonicalTwin(
  trackedAccountId: string,
  username: string,
): Promise<void> {
  try {
    const siblingIds = await siblingTrackedAccountIds(trackedAccountId);
    if (siblingIds.length === 0) return;
    const policy: RosterInheritancePolicy = {
      ...DEFAULT_ROSTER_INHERITANCE_POLICY,
      maxDonorAgeMs: ROSTER_INHERIT_MAX_DONOR_AGE_MS,
    };
    const now = new Date();
    for (const dimension of ["follower", "following"] as const) {
      const [own, candidates] = await Promise.all([
        getRosterSyncHealth(trackedAccountId, dimension),
        loadRosterDonorCandidates(siblingIds, dimension),
      ]);
      const donor = pickRosterInheritanceDonor(
        candidates,
        own.lastSuccessAt,
        now,
        policy,
      );
      if (!donor) continue;
      const copied = await copyRosterFromSibling(
        donor.trackedAccountId,
        trackedAccountId,
        dimension,
      );
      logger.info(
        {
          trackedAccountId,
          username,
          dimension,
          donorTrackedAccountId: donor.trackedAccountId,
          donorLastSuccessAt: donor.lastSuccessAt,
          ownLastSuccessAt: own.lastSuccessAt,
          ...copied,
        },
        "[collector] roster inherited from former canonical twin",
      );
    }
  } catch (err) {
    logger.warn(
      { trackedAccountId, username, error: errorMessage(err) },
      "[collector] roster inheritance from former canonical twin failed (cycle continues)",
    );
  }
}

/**
 * Decide whether to run the expensive enumeration for one roster dimension.
 * The cheap path (no baseline / count changed) avoids touching the roster
 * tables at all; the live-total query only runs when the count is stable and we
 * are checking whether the held roster is complete + fresh enough to reuse.
 *
 * The force-full valve uses this dimension's verified complete read in
 * roster_sync_state. A successful head read, exhausted but low-coverage walk,
 * or update of the other dimension must not postpone its full refresh.
 * Event timestamps are not freshness evidence either: a complete no-change
 * read is valid even when it produces no events.
 */
async function decideRosterFetch(
  trackedAccountId: string,
  kind: RosterKind,
  currentCount: number,
  prevCount: number | null,
  nowMs: number,
  countsReliable: boolean,
): Promise<RosterEnumDecision> {
  const health = await getRosterSyncHealth(trackedAccountId, kind);
  // Only a verified complete read makes THIS dimension fresh. The legacy
  // graph/walk anchors can move on cursor exhaustion below coverage, or on a
  // successful read of the other dimension. Using them here repeatedly hid
  // stale rosters behind "unchanged" while head reads kept succeeding.
  const lastVerifiedReadMs = health.lastCompleteReadAt?.getTime() ?? null;
  // A target-specific backoff normally prevents repeated native graph calls.
  // During a provider-wide outage, however, small public rosters have an
  // explicitly enabled independent fallback. Do not let an earlier native
  // failure suppress that recovery path: continue through the normal decision
  // gate, which still fetches only for a missing/incomplete/stale/changed
  // roster. Large rosters remain protected by the external safety cap.
  const providerOutageFallbackEligible =
    process.env.APIFY_GRAPH_PROVIDER_OUTAGE_FALLBACK_ENABLED === "true" &&
    health.failureKind === "unavailable" &&
    countsReliable &&
    currentCount > 0 &&
    currentCount < resolveApifyGraphLimit(FOLLOW_GRAPH_MAX_ITEMS);
  if (
    health.nextRetryAt &&
    health.nextRetryAt.getTime() > nowMs &&
    !providerOutageFallbackEligible
  ) {
    logger.info(
      {
        trackedAccountId,
        kind,
        failureKind: health.failureKind,
        nextRetryAt: health.nextRetryAt,
      },
      "[diff-aware] target graph backoff active; skipping Instagram request",
    );
    return { fetch: false, reason: "restricted-backoff" };
  }
  // A target whose reported roster is already beyond our hard capture ceiling
  // cannot yield a complete baseline in one cycle. Do not spend up to hundreds
  // of residential-proxy requests collecting an arbitrary prefix merely
  // because this is its first refresh; profile/posts remain available and a
  // future explicit high-volume graph workflow can opt in separately.
  if (currentCount > FOLLOW_GRAPH_MAX_ITEMS) {
    // Record WHY, so the roster does not masquerade as an unfinished seed
    // forever (this state persisted 45 days with last_attempt=NEVER and read as
    // a broken panel). Fire-and-forget: the gate decision must not depend on it.
    void markRosterTooLarge(trackedAccountId, kind, currentCount).catch(() => undefined);
    return { fetch: false, reason: "over-enumeration-cap" };
  }
  // A saved resume cursor means the previous cycle stopped mid-list. Finish
  // that walk before judging counts: a resumed sequence is ONE logical read
  // (roster-store "Read epochs") and only yields absence evidence when it
  // reaches the end. Left to the count/TTL gates a half-done walk could idle
  // past ROSTER_CURSOR_TTL_HOURS, lose its cursor and restart from page 1.
  const resumeCursor = await loadRosterCursor(trackedAccountId, kind).catch(() => null);
  if (resumeCursor) return { fetch: true, reason: "walk-in-progress" };
  if (prevCount === null) return { fetch: true, reason: "no-baseline" };
  // A9: a cached-continuation cycle with no prior snapshot fabricates counts
  // (following/post = 0, follower from a possibly stale column). Comparing those
  // against a real prevCount would fire a false `count-changed` and force a full
  // roster enumeration off garbage. When the counts are not reliable, treat the
  // count as unchanged (effectiveCount = prevCount) and defer entirely to the
  // normal cadence decision (roster completeness + force-full TTL). This skips
  // the diff-aware shortcut's false positive WITHOUT forcing a full fetch.
  const effectiveCount = countsReliable ? currentCount : prevCount;
  // Rosters that fit ONE walk keep the original cheap path: a count change
  // walks immediately (no roster-table read), because for them every walk is a
  // complete read that feeds unfollow detection.
  const fitsSingleWalk = rosterFitsSingleWalk(
    effectiveCount,
    FOLLOW_GRAPH_MAX_PAGES,
    FOLLOW_GRAPH_ITEMS_PER_PAGE,
  );
  if (fitsSingleWalk && effectiveCount !== prevCount) {
    return { fetch: true, reason: "count-changed" };
  }
  const liveRosterTotal = await getRosterLiveTotal(trackedAccountId, kind);
  const base: RosterEnumDecision =
    effectiveCount !== prevCount
      ? { fetch: true, reason: "count-changed" }
      : shouldEnumerateRoster({
          currentCount: effectiveCount,
          prevCount,
          liveRosterTotal,
          lastCaptureAtMs: lastVerifiedReadMs,
          nowMs,
          // Settled rosters re-walk on the (24 h default) settled valve; a
          // roster still seeding keeps the 6 h cadence it needs to settle.
          forceFullTtlMs: forceFullTtlFor(health.settled),
          // IG's reported count can exceed what we can actually enumerate; once we
          // hold our pagination cap, stop treating the roster as "incomplete".
          maxEnumerableItems: FOLLOW_GRAPH_MAX_ITEMS,
        });
  if (fitsSingleWalk || !base.fetch) return base;
  if (base.reason !== "count-changed" && base.reason !== "force-full-valve") {
    return base;
  }
  return applyCompleteRosterRewalkPolicy({
    trackedAccountId,
    kind,
    base,
    reportedCount: effectiveCount,
    liveRosterTotal,
    lastWalkAtMs: lastVerifiedReadMs,
    health,
    nowMs,
  });
}

/**
 * Re-walk cadence for a LARGE roster (cannot be read in one walk) that is
 * already "complete" per computeRosterSyncState — the same verdict the UI
 * shows. Such a roster gains nothing from a fresh walk on every small count
 * drift: no single walk can satisfy the 90%-of-held complete-read gate, so the
 * unfollow diff never runs and the walk only re-confirms members we hold.
 * Defer to once per ROSTER_COMPLETE_REWALK_HOURS unless IG's count moved by
 * at least the per-roster delta since the last complete walk. Every other
 * reason (no baseline, never captured, roster incomplete) is untouched.
 */
async function applyCompleteRosterRewalkPolicy(params: {
  readonly trackedAccountId: string;
  readonly kind: RosterKind;
  readonly base: RosterEnumDecision;
  readonly reportedCount: number;
  readonly liveRosterTotal: number;
  readonly lastWalkAtMs: number | null;
  readonly health: Awaited<ReturnType<typeof getRosterSyncHealth>>;
  readonly nowMs: number;
}): Promise<RosterEnumDecision> {
  const { trackedAccountId, kind, base, reportedCount, liveRosterTotal, lastWalkAtMs, health, nowMs } =
    params;
  // A roster still seeding needs its stable reads on today's cadence to settle
  // (lesson 6); only a settled roster is deferred.
  if (!health.settled) return base;
  const syncState = computeRosterSyncState({
    loadedTotal: liveRosterTotal,
    reportedTotal: reportedCount,
    lastGraphRefreshAt: lastWalkAtMs === null ? null : new Date(lastWalkAtMs),
    baselineSettled: health.settled,
    failureKind: health.failureKind,
    nextRetryAt: health.nextRetryAt,
  });
  if (!["complete", "capped"].includes(syncState)) return base;

  // Count at the last complete walk = the profile snapshot of that cycle.
  // Unreadable → null → the pure policy fails OPEN (walks, as before).
  const reportedAtLastWalk =
    lastWalkAtMs === null
      ? null
      : await fetchReportedCountAt(trackedAccountId, kind, lastWalkAtMs).catch(
          (err) => {
            logger.warn(
              { trackedAccountId, kind, error: errorMessage(err) },
              "[diff-aware] could not read count at last walk — re-walk policy fails open",
            );
            return null;
          },
        );
  const minDelta = resolveRewalkMinDelta(liveRosterTotal);
  const rewalk = shouldRewalkCompleteRoster({
    lastWalkAt: lastWalkAtMs,
    reportedCount,
    heldCount: liveRosterTotal,
    reportedAtLastWalk,
    nowMs,
    rewalkMs: ROSTER_COMPLETE_REWALK_MS,
    minDelta,
  });
  if (rewalk) return base;
  logger.info(
    {
      trackedAccountId,
      kind,
      wouldHaveWalkedFor: base.reason,
      reportedCount,
      heldCount: liveRosterTotal,
      reportedAtLastWalk,
      minDelta,
      lastWalkAt: lastWalkAtMs === null ? null : new Date(lastWalkAtMs).toISOString(),
      nextRewalkAt:
        lastWalkAtMs === null
          ? null
          : new Date(lastWalkAtMs + ROSTER_COMPLETE_REWALK_MS).toISOString(),
      rewalkHours: ROSTER_COMPLETE_REWALK_HOURS,
    },
    "[diff-aware] complete large roster: re-walk deferred (no complete read possible in one walk)",
  );
  return { fetch: false, reason: "complete-rewalk-deferred" };
}

// ── Full collection: profile + posts + stories + highlights + follows ───────

export async function collectPublicData(
  account: TrackedAccount,
): Promise<CollectOutcome> {
  if (!await trackedAccountHasAccess(account.id)) throw new Error("An active paid subscription or Stripe trial is required for collection");
  // Bind the scrape context so every IG request fired inside (profile, posts,
  // clips, stories, highlights, followers, following) is attributed to this
  // user + profile in the admin bandwidth panel.
  return withScrapeContext(
    {
      userId: account.userId,
      trackedAccountId: account.id,
      username: account.igUsername,
    },
    () => collectPublicDataInner(account),
  );
}

async function collectPublicDataInner(
  account: TrackedAccount,
): Promise<CollectOutcome> {
  const trackedAccountId = account.id;
  const username = account.igUsername;

  // Read the prior snapshot counts BEFORE writing this cycle's snapshot — the
  // diff-aware roster gate compares current vs previous follower/following
  // counts. This also lets us continue from cached profile metadata when IG
  // rate-limits only the profile anchor endpoint.
  const prevCounts: SnapshotCounts | null =
    await fetchLastSnapshotCounts(trackedAccountId);

  // Resolve private visibility before any profile traffic. A grant belongs
  // to this tracked account, never to a random pool bot or public twin.
  const privateAnchor = account.isPrivate && account.accessStatus === "has_access";
  const grantedBotIds = privateAnchor ? await findGrantedBotIds(trackedAccountId) : [];
  let grantedBotId = grantedBotIds[0] ?? null;
  if (privateAnchor && !grantedBotId) {
    return failedProfileOutcome(account, "none", "No healthy accepted bot available for private collection");
  }
  let profileResult: ProfileFetchResult = grantedBotId
    ? await getPublicProfileAsBot(username, account.igUserId, grantedBotId)
    : await getPublicProfile(username, account.igUserId);
  // An expired session or explicitly removed relationship must not hide an
  // independently approved backup. Missing relationship fields are unknown,
  // so only explicit evidence from this pinned viewer revokes its approval.
  if (privateAnchor) {
    let revokedViewer = false;
    for (let index = 0; index < grantedBotIds.length; index += 1) {
      if (index > 0) {
        grantedBotId = grantedBotIds[index];
        profileResult = await getPublicProfileAsBot(username, account.igUserId, grantedBotId);
      }
      if (profileResult.ok && profileResult.data.isPrivate &&
          profileResult.data.viewerRelationshipKnown === true && profileResult.data.followedByViewer === false) {
        const { revokeAcceptedBotAccess } = await import("../bot-manager.js");
        await revokeAcceptedBotAccess(trackedAccountId, grantedBotId!);
        revokedViewer = true;
        profileResult = { ok: false, source: "bot", rateLimited: false,
          error: "Approved follow relationship revoked" };
      } else if (profileResult.ok) {
        break;
      }
    }
    if (revokedViewer && !profileResult.ok && profileResult.error === "Approved follow relationship revoked") {
      return failedProfileOutcome(account, "bot", profileResult.error);
    }
  }

  let profile: IGPublicProfile;
  let profileSource: string;
  // A9: whether profile.followerCount / followingCount can drive the diff-aware
  // roster gate. A live fetch is always reliable; a cached anchor is only
  // reliable when a prior snapshot supplied the counts (else they are
  // fabricated). Defaults to true; the cached branch overrides when needed.
  let profileCountsReliable = true;
  if (!profileResult.ok) {
    const providerUnavailable =
      /proxy-provider|no healthy endpoint|provider health cooldown|failed to ready bot/i.test(
        profileResult.error,
      );
    // Emergency public-data degradation: the Tier-1 endpoint is
    // unauthenticated, so it is safe to try directly when paid proxy auth is
    // unavailable. It refreshes profile counts + recent post previews without
    // sending a bot cookie from a new IP. Auth-only pieces continue below and
    // either use their guarded external fallback or report a partial cycle.
    const tier1 = !privateAnchor && providerUnavailable
      ? await fetchPublicProfileTier1(username).catch(() => null)
      : null;
    if (tier1?.ok) {
      cachedContinuationStreaks.delete(trackedAccountId);
      profile = tier1.profile;
      profileSource = "tier1-direct";
      await applyProfileToDb(trackedAccountId, profile);
      if (tier1.posts.length > 0) {
        await persistPosts(trackedAccountId, tier1.posts, { preview: true });
      }
      logger.warn(
        {
          trackedAccountId,
          username,
          previewPosts: tier1.posts.length,
          originalError: profileResult.error,
        },
        "bot/proxy profile fetch unavailable — refreshed public profile through safe Tier-1 fallback",
      );
    } else {
    // A3: evaluate the cached-profile continuation BEFORE the pool-empty
    // abort. When the HTTP leg was rate-limited, the browser fallback often
    // fails with "no available bot in the pool" / "failed to build IG
    // client" — checking isPoolEmpty first would abort and the continuation
    // (whose target scenario is exactly this) would never fire.
    const cachedProfile = canContinueFromCachedProfile(profileResult)
      ? cachedProfileFromAccount(account, prevCounts)
      : null;
    if (cachedProfile) {
      // A6: bound the streak of consecutive cached cycles so persistent
      // breakage surfaces to BullMQ instead of looping "ok" forever.
      const streak = (cachedContinuationStreaks.get(trackedAccountId) ?? 0) + 1;
      if (streak > MAX_CONSECUTIVE_CACHED_CYCLES) {
        logger.warn(
          {
            trackedAccountId,
            username,
            error: profileResult.error,
            consecutiveCachedCycles: streak - 1,
            maxConsecutiveCachedCycles: MAX_CONSECUTIVE_CACHED_CYCLES,
          },
          "cached-continuation cutoff reached — failing cycle so the worker retries instead of serving cache again",
        );
        return failedProfileOutcome(
          account,
          profileResult.source,
          `profile fetch failed and cached-continuation cutoff reached (${
            streak - 1
          } consecutive cached cycles): ${profileResult.error}`,
        );
      }
      cachedContinuationStreaks.set(trackedAccountId, streak);
      logger.warn(
        {
          trackedAccountId,
          username,
          error: profileResult.error,
          source: profileResult.source,
          rateLimited: profileResult.rateLimited,
          consecutiveCachedCycles: streak,
          maxConsecutiveCachedCycles: MAX_CONSECUTIVE_CACHED_CYCLES,
          countsReliable: cachedProfile.countsReliable,
        },
        "profile fetch failed — continuing collection from cached profile anchor",
      );
      profile = cachedProfile.profile;
      profileSource = "cache";
      profileCountsReliable = cachedProfile.countsReliable;
    } else if (isPoolEmpty(profileResult)) {
      logger.warn(
        { trackedAccountId, username },
        "no bot available — aborting collection cycle",
      );
      return failedProfileOutcome(account, "none", NO_BOT_AVAILABLE);
    } else {
      logger.warn(
        { trackedAccountId, username, error: profileResult.error },
        "profile fetch failed — aborting public-data collection",
      );
      return failedProfileOutcome(
        account,
        profileResult.source,
        profileResult.error,
      );
    }
    }
  } else {
    // Live profile fetch succeeded — any cached-continuation streak is over.
    cachedContinuationStreaks.delete(trackedAccountId);
    profile = profileResult.data;
    profileSource = profileResult.source;
    await applyProfileToDb(trackedAccountId, profile);
  }

  // Cached fallback cycles intentionally do not write a new profile snapshot;
  // the profile endpoint did not return fresh counts.

  // 2. Private account branch.
  //    - access_status === 'has_access': a bot's follow request was accepted.
  //      Look up that bot via `bot_follow_requests` and run posts/stories/
  //      highlights + engagement through it (LRU lease cannot satisfy a
  //      private profile — only the granted bot has visibility). Public
  //      followers/following enumeration stays disabled: those endpoints
  //      reject even for accepted followers on private accounts.
  //    - otherwise (pending_access, access_denied, public-but-just-flipped):
  //      keep the legacy skip — there is nothing we can fetch.
  if (profile.isPrivate) {
    if (account.accessStatus === "has_access") {
      const privateBotId = grantedBotId ?? await findGrantedBotId(trackedAccountId);
      if (privateBotId) {
        logger.info(
          { trackedAccountId, username, botAccountId: privateBotId },
          "account is private but bot has access — collecting via granted bot",
        );
        return collectPrivateData(
          account,
          profile,
          profileSource,
          privateBotId,
        );
      }
      logger.warn(
        { trackedAccountId, username },
        "access_status=has_access but no accepted bot_follow_request found — skipping",
      );
      return failedProfileOutcome(account, profileSource, "No healthy accepted bot available for private collection");
    }
    logger.info(
      { trackedAccountId, username, accessStatus: account.accessStatus },
      "account is private — skipping posts/stories/followers public scrape",
    );
    return privateProfileOutcome(profileSource);
  }

  // 3. Parallel fetch of the rest. allSettled-equivalent: each call returns
  //    its own discriminated PublicDataResult, so a failure in one piece
  //    cannot cascade into another. (Note: each `getUser*` call leases its
  //    own bot inside the scraper — see file header for rationale.)
  const igUserId = profile.igUserId;

  // Twin leader election (lesson 13, second pass; audit 2026-09-02 C6). Rows
  // tracking the same IG user share one public profile, so posts, stories and
  // highlights — the browser lane, the most expensive fetches — are collected
  // on the canonical (oldest active) twin only, exactly like the roster walks
  // below; the read sites (routes.ts) resolve the same canonical id. Profile
  // snapshots stay per row (per-row policy). Resolved ONCE per cycle so the
  // content and roster gates cannot disagree across a cache expiry.
  // Fails open: canonicalTwinId() returns the row itself on any DB error.
  const canonicalId = await canonicalTwinId(trackedAccountId);
  const contentOwnedHere = canonicalId === trackedAccountId;
  if (!contentOwnedHere) {
    logger.info(
      { trackedAccountId, username, canonicalTwinId: canonicalId },
      `[collector] content collection skipped (posts/stories/highlights): non-canonical twin of ${canonicalId}`,
    );
  }
  const skippedContent = {
    ok: false as const,
    source: "none" as const,
    error: SKIP_NON_CANONICAL_TWIN,
  };

  const storiesRes = !contentOwnedHere
    ? skippedContent
    : STORIES_ENABLED
      ? await getUserStories(username, igUserId)
      : { ok: false as const, source: "none" as const, error: "stories disabled" };
  let postsRes: PublicDataResult<ReadonlyArray<IGPostSummary>> = !contentOwnedHere
    ? skippedContent
    : POSTS_ENABLED
      ? await getUserPosts(username, igUserId, POSTS_PER_CYCLE)
      : { ok: false as const, source: "none" as const, error: "posts disabled" };
  // A successful transport can still return a withheld empty feed. Do not
  // certify it or advance the posts refresh clock against positive evidence.
  if (postsRes.ok && postsRes.data.length === 0 && profile.postCount > 0) {
    postsRes = { ok: false, source: postsRes.source,
      error: "empty public feed despite a nonzero profile post count; retained saved posts" };
  }

  // Diff-aware gate: the follower/following enumeration is the most expensive
  // scrape (paginated over residential proxy). Skip it when the count is
  // unchanged since the last snapshot AND we already hold a complete,
  // fresh-enough roster — the single biggest recurring bandwidth saving. The
  // cheap "count changed / no baseline" path avoids touching the roster tables.
  const nowMs = Date.now();
  // Audit 2026-09-02 C7: a row that just became canonical (its former
  // canonical twin was deactivated) still holds the roster it froze when it
  // lost the election. Inherit the fresher sibling roster BEFORE the gates
  // below read roster_sync_state, so this cycle's walk continues that epoch
  // instead of inventing arrivals. No-op for a row canonical all along.
  if (FOLLOW_GRAPH_ENABLED && contentOwnedHere) {
    await inheritRosterFromFormerCanonicalTwin(trackedAccountId, username);
  }

  // Twin leader election for the roster walks (lesson 13, second pass). Rows
  // tracking the same IG user share one public roster; every read already
  // resolves to the canonical (oldest active) twin, so a walk on any other row
  // is pure duplicate spend (~270 follower/following pages a day for the two
  // live twin pairs). Profile stays per row; posts / stories / highlights
  // collapse the same way (content gate above, same `canonicalId`).
  // Fails open: canonicalTwinId() returns the row itself on any DB error.
  const rosterCanonicalId = FOLLOW_GRAPH_ENABLED ? canonicalId : trackedAccountId;
  const rosterOwnedHere = rosterCanonicalId === trackedAccountId;
  if (!rosterOwnedHere) {
    logger.info(
      { trackedAccountId, username, canonicalTwinId: rosterCanonicalId },
      `[collector] roster walk skipped: non-canonical twin of ${rosterCanonicalId}`,
    );
  }
  const nonCanonicalGate: RosterEnumDecision = {
    fetch: false,
    reason: "non-canonical-twin",
  };
  if (FOLLOW_GRAPH_ENABLED && rosterOwnedHere && backgroundRosterWorkerReady()) {
    await reconcileBackgroundRosters().catch(error => logger.warn(
      { trackedAccountId, error: errorMessage(error) }, "background roster enrollment unavailable; retaining normal collection gate"));
  }
  const [followingBackground, followersBackground] = FOLLOW_GRAPH_ENABLED && rosterOwnedHere && backgroundRosterWorkerReady()
    ? await Promise.all((["following", "follower"] as const).map(async dimension => {
        const config = backgroundRosterTarget(username, dimension);
        try {
          const progress = await readBackgroundRosterProgress(trackedAccountId, dimension);
          return progress && (progress.source === "auto" || progress.source === config?.source) ? progress : null;
        } catch (error) {
          logger.warn({ trackedAccountId, dimension, error: errorMessage(error) }, "background roster progress unavailable; retaining normal collection gate");
          return null;
        }
      })) : [null, null];
  let [followingGate, followersGate]: [RosterEnumDecision, RosterEnumDecision] =
    !rosterOwnedHere
      ? [nonCanonicalGate, nonCanonicalGate]
      : FOLLOW_GRAPH_ENABLED && DIFF_AWARE_ROSTER_ENABLED
      ? await Promise.all([
          followingBackground ? { fetch: false, reason: "background-sync" as const } : decideRosterFetch(
            trackedAccountId,
            "following",
            profile.followingCount,
            prevCounts?.followingCount ?? null,
            nowMs,
            profileCountsReliable,
          ),
          followersBackground ? { fetch: false, reason: "background-sync" as const } : decideRosterFetch(
            trackedAccountId,
            "follower",
            profile.followerCount,
            prevCounts?.followerCount ?? null,
            nowMs,
            profileCountsReliable,
          ),
        ])
      : [
          // Diff-aware off (or follow graph disabled): keep the legacy
          // always-enumerate behavior. When the graph is disabled the res is
          // built in the "disabled" branch below, so this value is unused there.
          { fetch: true, reason: "count-changed" },
          { fetch: true, reason: "count-changed" },
        ];

  // Delegation applies even if the legacy diff-aware optimization is disabled.
  // Only the canonical, managed dimension with an installed worker and a
  // durable row is delegated; all profile/content work above is unchanged.
  if (followingBackground) followingGate = { fetch: false, reason: "background-sync" };
  if (followersBackground) followersGate = { fetch: false, reason: "background-sync" };

  // Instrument every cycle (fetch AND skip, with reason) so the real skip rate
  // is measurable in production — needed to confirm the savings actually land
  // (M2): if large accounts always show reason "roster-incomplete", the gate is
  // chasing an un-enumerable IG count and the maxEnumerableItems cap should be
  // tuned.
  if (FOLLOW_GRAPH_ENABLED && DIFF_AWARE_ROSTER_ENABLED) {
    logger.info(
      {
        trackedAccountId,
        username,
        following: {
          count: profile.followingCount,
          fetch: followingGate.fetch,
          reason: followingGate.reason,
        },
        followers: {
          count: profile.followerCount,
          fetch: followersGate.fetch,
          reason: followersGate.reason,
        },
      },
      "[diff-aware] roster gate decision",
    );
  }

  // Resume points from the previous cycle. IG blocks deep pagination on large
  // rosters, so a walk that was cut short continues from where it stopped
  // instead of re-reading the same first pages forever (migration 0039).
  const [followingWalk, followersWalk] = await Promise.all(([
    ["following", followingGate.fetch], ["follower", followersGate.fetch],
  ] as const).map(async ([dimension, fetch]) => {
    const cursor = fetch ? await loadRosterCursor(trackedAccountId, dimension).catch(() => null) : null;
    const viewerBotId = cursor ? await loadRosterViewer(trackedAccountId, dimension).catch(() => null) : null;
    return { startCursor: viewerBotId ? cursor : null, viewerBotId };
  }));
  const followingStartCursor = followingWalk.startCursor, followersStartCursor = followersWalk.startCursor;

  const followingWalkStartedMs = Date.now();
  const followingRes = !FOLLOW_GRAPH_ENABLED
    ? { ok: false as const, source: "none" as const, error: "follow graph disabled" }
    : followingGate.fetch
      ? await getAllUserFollowing(igUserId, {
          startCursor: followingStartCursor,
          viewerBotId: followingWalk.viewerBotId,
          pinViewer: true,
          savedSessionOnly: true,
          maxPages: FOLLOW_GRAPH_MAX_PAGES,
          maxItems: FOLLOW_GRAPH_MAX_ITEMS,
          pageDelayMinMs: FOLLOW_GRAPH_PAGE_DELAY_MIN_MS,
          pageDelayMaxMs: FOLLOW_GRAPH_PAGE_DELAY_MAX_MS,
          // C4: yield between pages on shutdown; the truncated leg keeps its
          // resume cursor and is persisted below like any other leg.
          shouldStop: isShuttingDown,
          fallbackUsername: username,
          allowProviderOutageFallback:
            followingGate.fetch &&
            profile.followingCount < resolveApifyGraphLimit(FOLLOW_GRAPH_MAX_ITEMS),
        })
      : {
          ok: false as const,
          source: "none" as const,
          error: `skipped: ${followingGate.reason} (diff-aware)`,
        };
  const followingWalkMs = Date.now() - followingWalkStartedMs;
  const followersWalkStartedMs = Date.now();
  const followersRes = !FOLLOW_GRAPH_ENABLED
    ? { ok: false as const, source: "none" as const, error: "follow graph disabled" }
    : followersGate.fetch
      ? await getAllUserFollowers(username, igUserId, {
          startCursor: followersStartCursor,
          viewerBotId: followersWalk.viewerBotId,
          pinViewer: true,
          savedSessionOnly: true,
          shouldStop: isShuttingDown, // C4, see the following walk above
          maxPages: FOLLOW_GRAPH_MAX_PAGES,
          maxItems: FOLLOW_GRAPH_MAX_ITEMS,
          pageDelayMinMs: FOLLOW_GRAPH_PAGE_DELAY_MIN_MS,
          pageDelayMaxMs: FOLLOW_GRAPH_PAGE_DELAY_MAX_MS,
          allowProviderOutageFallback:
            followersGate.fetch &&
            profile.followerCount < resolveApifyGraphLimit(FOLLOW_GRAPH_MAX_ITEMS),
        })
      : {
          ok: false as const,
          source: "none" as const,
          error: `skipped: ${followersGate.reason} (diff-aware)`,
        };
  const followersWalkMs = Date.now() - followersWalkStartedMs;

  // C10a: one outcome line per attempted walk (gate skips have their own line).
  if (FOLLOW_GRAPH_ENABLED && followingGate.fetch) {
    logRosterWalkOutcome({
      trackedAccountId,
      username,
      kind: "following",
      res: followingRes,
      walk: { startCursor: followingStartCursor },
      durationMs: followingWalkMs,
    });
  }
  if (FOLLOW_GRAPH_ENABLED && followersGate.fetch) {
    logRosterWalkOutcome({
      trackedAccountId,
      username,
      kind: "follower",
      res: followersRes,
      walk: { startCursor: followersStartCursor },
      durationMs: followersWalkMs,
    });
  }

  // C9: a deferred large followers roster still gets its head pages read so
  // the newest arrivals land now instead of at the next full walk.
  // C9 (widened 2026-09-04): run the head-walk whenever the full followers walk
  // is SKIPPED this cycle — count unchanged inside the 24 h force-full valve or a
  // deferred large roster — not only on the deferral reason. Wired to the
  // deferral alone, every settled roster went up to 24 h without any walk after
  // the valve moved 6 h → 24 h (new-follower events 91 → 18 in a day). The
  // head-walk persists arrivals only and costs ROSTER_HEAD_PAGES calls.
  if (
    FOLLOW_GRAPH_ENABLED &&
    !followersGate.fetch &&
    !followersBackground && // The managed worker owns its independent recent checks.
    followersGate.reason !== "non-canonical-twin" &&
    followersGate.reason !== "restricted-backoff" &&
    headWalkDue(account.lastFollowersRefreshAt ?? account.lastGraphRefreshAt, Date.now())
  ) {
    await runFollowersHeadWalk(trackedAccountId, username, igUserId);
  }

  // Resume points are committed inside persist*Diff with sightings/events.
  // Saving them before persistence could skip an unread leg after a DB failure.

  // A failed first page never reaches persistence, so explicitly retain its
  // health state. This is both the scheduler backoff and the source of truth
  // for the roster UI's "restricted" message. A usable capture clears these
  // fields transactionally inside reconcileRoster.
  await Promise.all([
    followingGate.fetch && !followingRes.ok
      ? recordRosterFetchFailure(
          trackedAccountId,
          "following",
          followingRes.error,
        ).catch((error) =>
          logger.warn(
            { trackedAccountId, kind: "following", error: errorMessage(error) },
            "failed to persist following fetch health",
          ),
        )
      : Promise.resolve(),
    followersGate.fetch && !followersRes.ok
      ? recordRosterFetchFailure(
          trackedAccountId,
          "follower",
          followersRes.error,
        ).catch((error) =>
          logger.warn(
            { trackedAccountId, kind: "follower", error: errorMessage(error) },
            "failed to persist follower fetch health",
          ),
        )
      : Promise.resolve(),
  ]);

  // 4. Persist each result independently so a single DB failure does not
  //    cascade. The build* helpers narrow the discriminated union safely.
  const [
    postsOutcome,
    storiesOutcome,
    highlightsOutcome,
    followingOutcome,
    followersOutcome,
  ] = await Promise.all([
    buildCountOutcome(postsRes, (data) =>
      // Page-1 full-feed fetch: carries every pin, so it may also unpin.
      persistPosts(trackedAccountId, data, { pinnedAuthoritative: true }),
    ),
    buildCountOutcome(storiesRes, (data) =>
      persistStories(trackedAccountId, data),
    ),
    // Content-incremental: only walks the reels when the cheap tray shows a
    // change. Returns the final {count, source, error?} directly. Keep the
    // disabled literal when highlights are off so the slot stays consistent.
    !contentOwnedHere
      ? Promise.resolve<HighlightsOutcome>({
          count: 0,
          source: "none",
          error: SKIP_NON_CANONICAL_TWIN,
        })
      : HIGHLIGHTS_ENABLED
        ? collectHighlightsIncremental(trackedAccountId, username, igUserId)
        : Promise.resolve<HighlightsOutcome>({
            count: 0,
            source: "none",
            error: "highlights disabled",
          }),
    buildFollowingOutcome(trackedAccountId, followingRes, {
      startCursor: followingStartCursor,
    }),
    buildFollowersOutcome(trackedAccountId, followersRes, {
      startCursor: followersStartCursor,
    }),
  ]);

  // Advance the force-full valve anchor only when the graph was actually
  // (re-)enumerated this cycle AND every enumerated capture was COMPLETE
  // (B9). A truncated capture must not advance the anchor: doing so would
  // suppress re-enumeration for up to ROSTER_FORCE_FULL_TTL_MS while we hold
  // an incomplete roster. Even a no-op COMPLETE enumeration (zero new events)
  // advances it — anchoring on this (not MAX(event.detectedAt)) lets a stable
  // account settle: it re-enumerates once per TTL instead of every cycle.
  const followingAnchorSafe =
    !followingGate.fetch || (isCompleteCapture(followingRes) && !followingOutcome.error);
  const followersAnchorSafe =
    !followersGate.fetch || (isCompleteCapture(followersRes) && !followersOutcome.error);
  const anyEnumerated =
    (followingGate.fetch && followingRes.ok) ||
    (followersGate.fetch && followersRes.ok);
  // Per-roster anchors (migration 0025). The two rosters are INDEPENDENT, so
  // each advances on its OWN complete enumeration. The combined
  // lastGraphRefreshAt below remains a legacy exhausted-walk summary. The
  // freshness valve uses roster_sync_state.last_complete_read_at instead;
  // cursor exhaustion alone does not establish distinct-member coverage.
  // Roster TRUST must never be cross-gated: @sample_account
  // enumerated following perfectly (209, exhausted) while its 9.5k followers
  // walk failed, which left the shared anchor NULL — so computeRosterSyncState
  // reported "syncing" and isUnfollowRosterTrusted hid all 1,130 of that
  // account's genuine unfollow events from the client.
  const rosterAnchors: Partial<{
    lastFollowingRefreshAt: Date;
    lastFollowersRefreshAt: Date;
    followingFirstCompleteAt: Date;
  }> = {};
  if (followingGate.fetch && followingRes.ok && isCompleteCapture(followingRes) && !followingOutcome.error) {
    rosterAnchors.lastFollowingRefreshAt = new Date();
    // Stamp the FIRST complete enumeration once (COALESCE below keeps it) — it
    // is the boundary between discovery and genuinely-new follows.
    rosterAnchors.followingFirstCompleteAt = new Date();
  }
  if (followersGate.fetch && followersRes.ok && isCompleteCapture(followersRes) && !followersOutcome.error) {
    rosterAnchors.lastFollowersRefreshAt = new Date();
  }
  if (Object.keys(rosterAnchors).length > 0) {
    try {
      const { followingFirstCompleteAt, ...alwaysSet } = rosterAnchors;
      await db
        .update(trackedAccounts)
        .set({
          ...alwaysSet,
          // Never move the first-complete boundary once set.
          ...(followingFirstCompleteAt
            ? {
                followingFirstCompleteAt: sql`COALESCE(${trackedAccounts.followingFirstCompleteAt}, ${followingFirstCompleteAt})`,
              }
            : {}),
        })
        .where(eq(trackedAccounts.id, trackedAccountId));
    } catch (err) {
      logger.warn(
        { trackedAccountId, error: errorMessage(err) },
        "failed to advance per-roster refresh anchors",
      );
    }
  }

  // A non-canonical twin never walks, so its own anchors would freeze (or stay
  // NULL on a new row). The viewer reads the roster + health from the canonical
  // twin but the trust anchors (last_*_refresh_at, following_first_complete_at)
  // from the REQUESTING row (routes.ts computeRosterSyncState /
  // isUnfollowRosterTrusted, roster.ts followActivityFilters), so a NULL anchor
  // here would show a false "syncing" banner and hide real unfollows. Mirror the
  // canonical row's anchors so both rows describe the one roster identically.
  if (!rosterOwnedHere) {
    await mirrorRosterAnchorsFromCanonical(trackedAccountId, rosterCanonicalId);
  }

  if (anyEnumerated && followingAnchorSafe && followersAnchorSafe) {
    try {
      await db
        .update(trackedAccounts)
        .set({ lastGraphRefreshAt: new Date() })
        .where(eq(trackedAccounts.id, trackedAccountId));
    } catch (err) {
      logger.warn(
        { trackedAccountId, error: errorMessage(err) },
        "failed to advance last_graph_refresh_at (legacy walk summary)",
      );
    }
  } else if (anyEnumerated) {
    logger.warn(
      {
        trackedAccountId,
        username,
        following: {
          fetched: followingGate.fetch,
          ok: followingRes.ok,
          complete: followingRes.ok ? (followingRes.complete ?? null) : null,
          stopReason: followingRes.ok ? (followingRes.stopReason ?? null) : null,
          items: followingRes.ok ? followingRes.data.length : 0,
        },
        followers: {
          fetched: followersGate.fetch,
          ok: followersRes.ok,
          complete: followersRes.ok ? (followersRes.complete ?? null) : null,
          stopReason: followersRes.ok ? (followersRes.stopReason ?? null) : null,
          items: followersRes.ok ? followersRes.data.length : 0,
        },
      },
      "[diff-aware] enumeration incomplete — NOT advancing last_graph_refresh_at",
    );
  } else if (followingGate.fetch || followersGate.fetch) {
    // A roster enumeration was gated to run this cycle but produced NO usable
    // capture on either side (both ok:false — e.g. every leased bot hit
    // checkpoint_required / rate-limit mid-walk). Without this branch the
    // failure is completely silent: the advance block is skipped
    // (anyEnumerated=false) AND the "incomplete" warning above never fires,
    // so an account can hold a stale roster and never advance
    // last_graph_refresh_at with zero diagnostics. Surface it so the real
    // roster-refresh failure rate is observable (it is NOT a false-unfollow
    // path — nothing is diffed when the capture failed).
    logger.warn(
      {
        trackedAccountId,
        username,
        following: {
          fetched: followingGate.fetch,
          ok: followingRes.ok,
          error: followingRes.ok ? null : followingRes.error,
        },
        followers: {
          fetched: followersGate.fetch,
          ok: followersRes.ok,
          error: followersRes.ok ? null : followersRes.error,
        },
      },
      "[diff-aware] roster enumeration attempted but no usable capture — last_graph_refresh_at not advanced",
    );
  }

  // Highlights media is only enqueued on cycles where a full reels fetch
  // actually ran (changed / new / first-time). On the UNCHANGED path there is
  // nothing new — the covers and reel items were queued the cycle they last
  // changed, so we pass an empty "ok" result (no URLs to add).
  const highlightsForMedia: HighlightsForMedia = highlightsOutcome.highlights
    ? { ok: true, data: highlightsOutcome.highlights }
    : { ok: true, data: [] };
  enqueueCollectedMedia(
    trackedAccountId,
    username,
    profile,
    postsRes,
    storiesRes,
    highlightsForMedia,
  );

  // 5. Per-post engagement (likers + comments). Only runs when posts were
  //    persisted successfully — there is nothing to attach engagement to
  //    otherwise. Surface partial failures without an immediate whole-cycle retry.
  let engagement: EngagementCollectOutcome | undefined;
  if (postsRes.ok && postsOutcome.count > 0) {
    try {
      engagement = await collectPostEngagement(trackedAccountId, username, postsRes.data);
    } catch (err) {
      engagement = { likers: { checked: 0, failed: 0, skipped: 0 }, comments: { checked: 0, failed: 0, skipped: 0 }, error: errorMessage(err) };
      logger.warn(
        { trackedAccountId, username, error: errorMessage(err) },
        "engagement scrape: top-level failure (cycle continues)",
      );
    }
  }

  return {
    profile: { ok: true, source: profileSource },
    posts: postsOutcome,
    stories: storiesOutcome,
    highlights: highlightsOutcome,
    following: followingOutcome,
    followers: followersOutcome,
    engagement,
    isPrivate: false,
  };
}
