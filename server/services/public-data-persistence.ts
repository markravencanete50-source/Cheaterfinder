// ─── Public-data persistence helpers ────────────────────────────────────────
//
// Pure database upsert / diff helpers used by the profile collection worker
// to persist public data fetched through public-data-service. Splitting
// these out of workers.ts keeps the worker file focused on job orchestration.
//
// Each helper is idempotent: running it multiple times for the same fetch
// result is safe (conflict-on-unique-index semantics).
// ─────────────────────────────────────────────────────────────────────────────

import { and, asc, eq, gt, inArray, lt, notInArray, sql, type AnyColumn } from "drizzle-orm";

import { db } from "../db.js";
import {
  commentsCache,
  followEvents,
  followerEvents,
  followerUnfollowEvents,
  highlightItemsCache,
  highlightsCache,
  likersCache,
  postsCache,
  storiesCache,
  trackedAccounts,
  unfollowEvents,
} from "../../shared/schema.js";
import type {
  IGComment,
  IGFollowUser,
  IGHighlight,
  IGPostSummary,
  IGStoryItem,
  IGUser,
} from "./public-data-service.js";
import {
  fetchExpectedCount,
  shouldComputeUnfollowDiff,
} from "./diff-completeness.js";
import { logger as baseLogger } from "../observability/logger.js";
import { emitRealtime } from "./realtime-events.js";
import { enqueueMediaCacheUrls } from "./media-cache-jobs.js";
import { reconcileRoster, saveRosterCursor, type RosterReadLeg } from "./roster-store.js";
import { cancelChurn } from "./roster-churn.js";

const logger = baseLogger.child({ module: "public-data-persistence" });

// Look up igUsername by trackedAccountId for realtime payloads. Cached to
// avoid an extra round-trip on hot paths; the value is immutable for the
// lifetime of the row.
//
// B6a: this cache is module-level and lives for the whole process. Without a
// bound it grows one entry per username ever seen — and in a multi-tenant
// deployment that set is effectively unbounded. We cap it with a small LRU:
// once full, the least-recently-used entry is evicted, and every cache hit
// refreshes recency so the hottest accounts stay resident. The cap is
// env-tunable (USERNAME_CACHE_MAX) and defaults to 10k entries (~ a few MB of
// short strings) which comfortably covers active tenants on one node.
const USERNAME_CACHE_DEFAULT_MAX = 10_000;

function parseCacheMax(raw: string | undefined): number {
  if (raw === undefined) return USERNAME_CACHE_DEFAULT_MAX;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      { raw },
      "invalid USERNAME_CACHE_MAX; falling back to default",
    );
    return USERNAME_CACHE_DEFAULT_MAX;
  }
  return parsed;
}

/**
 * Minimal LRU keyed by string, backed by a Map's insertion-order guarantee.
 * `get` moves a hit to the most-recent position (delete + re-set); `set`
 * evicts the least-recently-used key (the Map's first key) when at capacity.
 * No external deps, no TTL — entries are immutable so staleness isn't a risk.
 *
 * Exported for unit testing the eviction/recency invariants (B6a).
 */
export class LruCache<V> {
  private readonly store = new Map<string, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    // Refresh recency: re-inserting moves the key to the end (most-recent).
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    // Re-set existing keys so they move to most-recent before any eviction.
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.maxEntries) {
      const lru = this.store.keys().next().value;
      if (lru !== undefined) this.store.delete(lru);
    }
    this.store.set(key, value);
  }

  get size(): number {
    return this.store.size;
  }
}

const usernameCache = new LruCache<string>(
  parseCacheMax(process.env.USERNAME_CACHE_MAX),
);

async function lookupUsername(
  trackedAccountId: string,
): Promise<string> {
  const cached = usernameCache.get(trackedAccountId);
  if (cached !== undefined) return cached;
  const [row] = await db
    .select({ igUsername: trackedAccounts.igUsername })
    .from(trackedAccounts)
    .where(eq(trackedAccounts.id, trackedAccountId))
    .limit(1);
  const value = row?.igUsername ?? trackedAccountId;
  usernameCache.set(trackedAccountId, value);
  return value;
}

// ── Diff concurrency + known-set helpers (D2 / D5) ──────────────────────────
//
// Multiple writers (profile worker, collection-follows worker at concurrency
// 5, manual refresh) can diff the same account at the same time. Each diff is
// read-known-set -> compute -> insert, so two interleaved runs double-insert
// the same events. Fix: every diff runs inside db.transaction() and FIRST
// takes pg_advisory_xact_lock(<dimension ns>, hashtext(<account id>)) —
// concurrent diffs for the same account+dimension serialize, the second
// transaction then reads the first one's committed rows, and the lock is
// released automatically at commit/rollback. See migration
// 0019_event_dedupe_unique.sql for why this is a lock and not a unique index.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** App-level advisory-lock namespaces ("LK" + dimension, int4 range). */
import { FOLLOWING_DIFF_LOCK_NS, FOLLOWER_DIFF_LOCK_NS, lockAccountForDiff } from "./roster-diff-lock.js";

/** node-postgres returns { rows }; some drivers return the array directly. */
function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result as Array<Record<string, unknown>>;
  }
  return (
    (result as { rows?: Array<Record<string, unknown>> }).rows ?? []
  );
}

// The "known set" (current membership) is reconstructed in SQL instead of
// re-reading the entire lifetime event history into JS each cycle (D5).
// Semantics mirror server/services/roster.ts exactly: a username is a member
// iff it has at least one follow row strictly newer (detected_at) than its
// latest unfollow row — so a follow -> unfollow -> re-follow sequence yields
// membership, and a follow at the exact timestamp of an unfollow is shadowed
// by it. Served by the (tracked_account_id, lower(username), detected_at)
// expression indexes from migration 0019. Returns lowercased usernames.

// REMOVED (2026-07-15): fetchKnownFollowingSet / fetchKnownFollowerSet.
//
// These rebuilt "who is currently in the roster" from follow_events minus any
// newer unfollow_event — using the append-only log this module writes to as if
// it were mutable state. The diff therefore consumed its own output: a single
// short or differently-paginated read corrupted the baseline permanently, and
// every later read "repaired" it by re-emitting the gap as fresh activity, so
// it never converged. @example_account reported 860 follows / 859 unfollows in a
// week while actually following a steady 215.
//
// Roster state is roster_members now (see roster-store.ts). Do not reintroduce
// a reconstruction from the event tables: they are a derived audit trail of
// confirmed transitions, not a source of truth.

/**
 * Live captures can contain the same username twice (pagination overlap).
 * Keep the first occurrence per lowercased username so one capture can never
 * insert the same event twice.
 */
function dedupeByUsername(
  users: ReadonlyArray<IGFollowUser>,
): IGFollowUser[] {
  const seen = new Set<string>();
  const unique: IGFollowUser[] = [];
  for (const user of users) {
    const key = user.username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(user);
  }
  return unique;
}

// ── Posts ───────────────────────────────────────────────────────────────────

export interface PersistPostsOptions {
  /**
   * Set ONLY when `posts` came from a page-1 / full-feed fetch. Instagram always
   * returns pinned posts at the TOP of the feed, so such a batch necessarily
   * contains every pin — which makes it authoritative enough to also UNPIN what
   * is no longer pinned.
   *
   * Why this is opt-in: the upsert below only touches shortcodes present in the
   * batch, so a post that was pinned and later unpinned kept is_pinned=true
   * forever once it aged out of the fetch window. Those stale flags accumulate
   * (@complex showed 6 pinned; Instagram's real maximum is 3).
   *
   * MUST stay false for:
   *   - the "Load more" older-posts pagination (routes.ts) — those pages never
   *     contain pins, so clearing would wipe every pin;
   *   - the Tier-1 preview path (public-read-client.ts), which hardcodes
   *     isPinned:false and would therefore unpin everything.
   */
  readonly pinnedAuthoritative?: boolean;
  /**
   * Set when `posts` came from the cheap Tier-1 web-profile PREVIEW rather than
   * a real feed scrape. The preview is strictly poorer than the feed:
   *   - `videoUrl` is always null (it carries no video_versions)
   *   - every video is typed "video" — it cannot tell a reel from a feed video
   *   - carousels look like plain images
   * Without this flag the upsert blindly wrote EXCLUDED.*, so a preview
   * revalidation CLOBBERED good feed data: @sample_account' posts were all
   * stored as post_type='video' with video_url=NULL (nothing to play) even
   * though the live feed returns them as reels WITH video urls. Same class of
   * bug the carousel COALESCE below already guards against.
   */
  readonly preview?: boolean;
}

export async function persistPosts(
  trackedAccountId: string,
  posts: ReadonlyArray<IGPostSummary>,
  options?: PersistPostsOptions,
): Promise<number> {
  const advancesContentAnchor =
    options?.pinnedAuthoritative === true ||
    (options?.preview === true && posts.length > 0);
  if (posts.length === 0) {
    if (advancesContentAnchor) {
      await db
        .update(trackedAccounts)
        .set({ lastContentRefreshAt: new Date(), updatedAt: new Date() })
        .where(eq(trackedAccounts.id, trackedAccountId));
    }
    return 0;
  }

  const rows = posts.map((p) => ({
    trackedAccountId,
    shortcode: p.shortcode,
    mediaId: p.mediaId,
    postType: p.postType,
    thumbnailUrl: p.thumbnailUrl || null,
    displayUrl: p.displayUrl || null,
    videoUrl: p.videoUrl || null,
    caption: p.caption || null,
    likeCount: p.likeCount,
    commentCount: p.commentCount,
    videoViewCount: p.videoViewCount,
    takenAt: p.takenAt,
    locationName: p.locationName,
    hashtags: [...p.hashtags],
    isPinned: p.isPinned,
    // jsonb column expects a mutable array; copy the readonly children.
    carouselMedia: p.carouselMedia ? p.carouselMedia.map((c) => ({ ...c })) : null,
  }));

  const result = await db
    .insert(postsCache)
    .values(rows)
    .onConflictDoUpdate({
      target: [postsCache.trackedAccountId, postsCache.shortcode],
      set: {
        // A Tier-1 preview cannot tell a reel from a feed video (it types every
        // video as "video"), so it must never downgrade a type the feed already
        // resolved. A real feed scrape stays authoritative.
        postType: options?.preview
          ? sql`CASE WHEN ${postsCache.postType} IS NULL THEN EXCLUDED.post_type ELSE ${postsCache.postType} END`
          : sql`EXCLUDED.post_type`,
        thumbnailUrl: sql`EXCLUDED.thumbnail_url`,
        displayUrl: sql`EXCLUDED.display_url`,
        // NEVER let a null incoming video_url wipe one we already hold — the
        // preview always sends null, which silently made every video unplayable.
        // A feed scrape with a real URL still updates it (freshly-signed).
        videoUrl: sql`COALESCE(EXCLUDED.video_url, ${postsCache.videoUrl})`,
        caption: sql`EXCLUDED.caption`,
        likeCount: sql`EXCLUDED.like_count`,
        commentCount: sql`EXCLUDED.comment_count`,
        videoViewCount: sql`EXCLUDED.video_view_count`,
        takenAt: sql`EXCLUDED.taken_at`,
        locationName: sql`EXCLUDED.location_name`,
        hashtags: sql`EXCLUDED.hashtags`,
        // The preview carries NO pinned signal — it hardcodes isPinned:false — so
        // letting it write EXCLUDED.is_pinned silently un-pinned real pins on
        // every Tier-1 revalidation. Keep what we hold; only a real feed scrape
        // (which genuinely sees timeline_pinned_user_ids) may change a pin.
        isPinned: options?.preview
          ? sql`${postsCache.isPinned}`
          : sql`EXCLUDED.is_pinned`,
        // Fix #7: the preview/profile persist path writes carousel_media = NULL.
        // Re-persisting a previously-good carousel via that path would clobber
        // the children with NULL. COALESCE keeps existing children when the
        // incoming value is null (matches the sibling-backfill writer in
        // routes.ts: COALESCE(posts_cache.carousel_media, EXCLUDED.carousel_media)).
        carouselMedia: sql`COALESCE(EXCLUDED.carousel_media, ${postsCache.carouselMedia})`,
        cachedAt: sql`NOW()`,
      },
    })
    // ON CONFLICT DO UPDATE returns one row per input whether it inserted or
    // updated (D6). xmax = 0 discriminates: only freshly inserted rows have
    // no updating transaction id, so only genuine inserts fire "posts.added".
    .returning({
      id: postsCache.id,
      inserted: sql<boolean>`(xmax = 0)`,
    });

  // Reconcile pins against this authoritative batch. The upsert above only
  // touches shortcodes we just fetched, so an unpinned-but-aged-out post would
  // keep is_pinned=true forever. Clear every pin this batch did NOT report,
  // which is safe precisely because a page-1 feed always carries all pins.
  if (options?.pinnedAuthoritative) {
    const pinnedShortcodes = posts
      .filter((p) => p.isPinned)
      .map((p) => p.shortcode);
    const stalePinFilter =
      pinnedShortcodes.length > 0
        ? and(
            eq(postsCache.trackedAccountId, trackedAccountId),
            eq(postsCache.isPinned, true),
            notInArray(postsCache.shortcode, pinnedShortcodes),
          )
        : // Nothing is pinned any more — drop them all.
          and(
            eq(postsCache.trackedAccountId, trackedAccountId),
            eq(postsCache.isPinned, true),
          );
    const cleared = await db
      .update(postsCache)
      .set({ isPinned: false })
      .where(stalePinFilter)
      .returning({ shortcode: postsCache.shortcode });
    if (cleared.length > 0) {
      logger.info(
        {
          trackedAccountId,
          cleared: cleared.length,
          stillPinned: pinnedShortcodes.length,
        },
        "cleared stale pinned posts",
      );
    }
  }

  const insertedCount = result.filter((r) => r.inserted).length;
  logger.debug(
    { trackedAccountId, upserted: result.length, inserted: insertedCount },
    "posts upserted",
  );
  if (insertedCount > 0) {
    emitRealtime({
      kind: "posts.added",
      trackedAccountId,
      igUsername: await lookupUsername(trackedAccountId),
      count: insertedCount,
    });
  }
  if (advancesContentAnchor) {
    await db
      .update(trackedAccounts)
      .set({ lastContentRefreshAt: new Date(), updatedAt: new Date() })
      .where(eq(trackedAccounts.id, trackedAccountId));
  }
  return result.length;
}

// ── Stories ─────────────────────────────────────────────────────────────────

export async function persistStories(
  trackedAccountId: string,
  stories: ReadonlyArray<IGStoryItem>,
): Promise<number> {
  // Clean expired stories first (idempotent, cheap, keeps cache tight).
  await db
    .delete(storiesCache)
    .where(
      and(
        eq(storiesCache.trackedAccountId, trackedAccountId),
        lt(storiesCache.expiresAt, new Date()),
      ),
    );

  if (stories.length === 0) return 0;

  const rows = stories.map((s) => ({
    trackedAccountId,
    storyId: s.storyId,
    mediaType: s.mediaType,
    mediaUrl: s.mediaUrl,
    thumbnailUrl: s.thumbnailUrl || null,
    takenAt: s.takenAt,
    expiresAt: s.expiresAt,
  }));

  const result = await db
    .insert(storiesCache)
    .values(rows)
    .onConflictDoUpdate({
      target: [storiesCache.trackedAccountId, storiesCache.storyId],
      set: {
        mediaType: sql`EXCLUDED.media_type`,
        mediaUrl: sql`EXCLUDED.media_url`,
        thumbnailUrl: sql`EXCLUDED.thumbnail_url`,
        takenAt: sql`EXCLUDED.taken_at`,
        expiresAt: sql`EXCLUDED.expires_at`,
        cachedAt: sql`NOW()`,
      },
    })
    // D6: xmax = 0 marks freshly inserted rows; refreshed (updated) stories
    // must not re-fire "stories.changed" every collection cycle.
    .returning({
      id: storiesCache.id,
      inserted: sql<boolean>`(xmax = 0)`,
    });

  const insertedCount = result.filter((r) => r.inserted).length;
  logger.debug(
    { trackedAccountId, upserted: result.length, inserted: insertedCount },
    "stories upserted",
  );
  if (insertedCount > 0) {
    emitRealtime({
      kind: "stories.changed",
      trackedAccountId,
      igUsername: await lookupUsername(trackedAccountId),
      count: insertedCount,
    });
  }
  return result.length;
}

// ── Highlights ──────────────────────────────────────────────────────────────

export async function persistHighlights(
  trackedAccountId: string,
  highlights: ReadonlyArray<IGHighlight>,
): Promise<number> {
  if (highlights.length === 0) return 0;

  const rows = highlights.map((h) => ({
    trackedAccountId,
    highlightId: h.highlightId,
    title: h.title || "Untitled",
    coverUrl: h.coverUrl || null,
    mediaCount: h.mediaCount,
  }));

  const upserted = await db
    .insert(highlightsCache)
    .values(rows)
    .onConflictDoUpdate({
      target: [highlightsCache.trackedAccountId, highlightsCache.highlightId],
      set: {
        title: sql`EXCLUDED.title`,
        coverUrl: sql`EXCLUDED.cover_url`,
        mediaCount: sql`EXCLUDED.media_count`,
        cachedAt: sql`NOW()`,
      },
    })
    // D6: xmax = 0 marks freshly inserted highlights; mere refreshes must
    // not re-fire "highlights.changed" every collection cycle.
    .returning({
      id: highlightsCache.id,
      highlightId: highlightsCache.highlightId,
      inserted: sql<boolean>`(xmax = 0)`,
    });

  // If any highlights came with items, refresh the inner items cache.
  // D9: one transaction with a single batched delete + a single batched
  // insert (instead of a non-atomic delete/insert pair per highlight) — a
  // reader can never observe a highlight with its items deleted but not yet
  // re-inserted, and a crash mid-refresh can't leave items half-applied.
  const byHighlightId = new Map(upserted.map((r) => [r.highlightId, r.id]));
  const withItems = highlights.filter(
    (h) => h.items.length > 0 && byHighlightId.has(h.highlightId),
  );
  if (withItems.length > 0) {
    const parentIds = withItems.map(
      (h) => byHighlightId.get(h.highlightId) as string,
    );
    const itemRows = withItems.flatMap((h) => {
      const parentId = byHighlightId.get(h.highlightId) as string;
      return h.items.map((item) => ({
        highlightCacheId: parentId,
        storyId: item.storyId,
        mediaType: item.mediaType,
        mediaUrl: item.mediaUrl || null,
        thumbnailUrl: item.thumbnailUrl || null,
        takenAt: item.takenAt,
      }));
    });

    await db.transaction(async (tx) => {
      await tx
        .delete(highlightItemsCache)
        .where(inArray(highlightItemsCache.highlightCacheId, parentIds));
      await tx.insert(highlightItemsCache).values(itemRows);
    });
  }

  const insertedCount = upserted.filter((r) => r.inserted).length;
  logger.debug(
    { trackedAccountId, upserted: upserted.length, inserted: insertedCount },
    "highlights upserted",
  );
  if (insertedCount > 0) {
    emitRealtime({
      kind: "highlights.changed",
      trackedAccountId,
      igUsername: await lookupUsername(trackedAccountId),
      count: insertedCount,
    });
  }
  return upserted.length;
}

/**
 * Content-incremental support: read the per-highlight media_count baseline we
 * already have cached for this account. The collector compares this against
 * the cheap highlights tray (highlight_id + media_count) so it can skip the
 * expensive reels fetch when nothing changed.
 *
 * Returns a Map keyed by highlightId → mediaCount. An account with no cached
 * highlights yields an empty Map (treated as "first-time" by the caller).
 */
export async function loadSavedHighlightMediaCounts(
  trackedAccountId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      highlightId: highlightsCache.highlightId,
      mediaCount: highlightsCache.mediaCount,
    })
    .from(highlightsCache)
    .where(eq(highlightsCache.trackedAccountId, trackedAccountId));

  const out = new Map<string, number>();
  for (const row of rows) {
    out.set(row.highlightId, row.mediaCount ?? 0);
  }
  return out;
}

// ── Following diff (outbound follows / unfollows by tracked user) ───────────

export interface FollowDiffOutcome {
  readonly completeRead: boolean;
  readonly newFollows: number;
  readonly newUnfollows: number;
}

// Completeness gate: if the live capture is too short relative to the last
// known count baseline, unfollow detection is unsafe (false positives) and
// is skipped. New follows remain additive-safe. The gate reads
// profile_snapshots — NOT the event tables — so it runs before the diff
// transaction: that keeps the advisory-lock hold time short and never
// borrows a second pool connection while the transaction pins one.
/**
 * Does the roster we HOLD account for everyone Instagram says exists?
 *
 * resolveUnfollowGate judges a SINGLE capture, which is the right question for
 * "is this read safe to diff for departures". It is the wrong question for "is
 * the baseline finished": a small account is enumerated across several partial
 * reads, so no individual read ever reaches the threshold even once the union
 * is effectively complete. @tracked_user_3 held 120 of 121 followers and still
 * reported an empty followers panel because every read looked partial.
 */
async function heldRosterCoversExpected(
  trackedAccountId: string,
  dimension: "following" | "follower",
  heldCount: number,
  tx: Tx,
): Promise<boolean> {
  // Already inside the roster transaction: reuse its connection. An extra
  // global-pool checkout can starve every concurrent diff, with the error
  // silently degraded into "union incomplete" by reconcileRoster's fallback.
  const expectedCount = await fetchExpectedCount(trackedAccountId, dimension, tx);
  if (!expectedCount || expectedCount <= 0) return false;
  return shouldComputeUnfollowDiff(heldCount, expectedCount).allowUnfollowDiff;
}

async function resolveUnfollowGate(
  trackedAccountId: string,
  dimension: "following" | "follower",
  liveCount: number,
): Promise<boolean> {
  const expectedCount = await fetchExpectedCount(trackedAccountId, dimension);
  const decision = shouldComputeUnfollowDiff(liveCount, expectedCount);
  if (!decision.allowUnfollowDiff) {
    logger.warn(
      {
        trackedAccountId,
        captured: decision.liveCount,
        expected: decision.expectedCount,
        completeness: decision.completeness,
      },
      `[persist] ${dimension} scrape incomplete, skipping unfollow diff`,
    );
  }
  return decision.allowUnfollowDiff;
}

export interface FollowDiffPersistOptions {
  readonly trustedBaseline?: boolean;
  readonly minimumCompleteReadMembers?: number;
  readonly baselineOnly?: boolean;
  /** Short DB-only callbacks; ownership and progress share the data commit. */
  readonly transactionGuard?: (tx: Tx) => Promise<void>;
  readonly transactionCheckpoint?: (tx: Tx) => Promise<void>;
  /**
   * Position of this capture in a resumed walk (roster-store "Read epochs").
   * Omitted = one capture is one complete logical read (legacy callers).
   */
  readonly leg?: RosterReadLeg;
  /** Commit the resume point atomically with this leg's sightings/events. */
  readonly cursor?: { readonly nextCursor: string | null; readonly viewerBotId?: string | null };
}

export async function persistFollowingDiff(
  trackedAccountId: string,
  liveFollowing: ReadonlyArray<IGFollowUser>,
  options: FollowDiffPersistOptions = {},
): Promise<FollowDiffOutcome> {
  // Dedupe BEFORE gating. Paginated enumeration overlaps, so the raw capture
  // contains repeats: @example_account returned 215 rows that collapsed to 175
  // distinct accounts. Gating on the raw length scored that 215/215 = complete
  // when the roster was really only 81% captured — the gate's whole purpose is
  // to measure coverage, and only distinct members are coverage.
  const live = dedupeByUsername(liveFollowing);

  // The gate decides whether this capture is trustworthy enough to reason about
  // ABSENCE. It is no longer the only defence: reconcileRoster additionally
  // requires a member to be missing from several consecutive complete reads
  // before believing they are gone (see roster-store.ts).
  // A head-walk is arrivals-only by contract; asking the gate would only log a
  // misleading "incomplete" warning for a capture that was never meant to be.
  const isCompleteRead = options.leg?.headOnly
    ? false
    : await resolveUnfollowGate(trackedAccountId, "following", live.length);

  // D2: read -> compute -> insert is atomic and serialized per account by the
  // advisory lock, so overlapping collection cycles can no longer double-insert
  // events or interleave half-applied diffs.
  const outcome = await db.transaction(async (tx) => {
    await options.transactionGuard?.(tx);
    await lockAccountForDiff(tx, FOLLOWING_DIFF_LOCK_NS, trackedAccountId);

    // Roster state lives in roster_members now. It used to be reconstructed
    // from follow_events/unfollow_events, which made this diff consume its own
    // output: one short read corrupted the baseline permanently, and every
    // later read "repaired" it by re-emitting the gap as fresh activity
    // (@example_account: 860 follows / 859 unfollows in a week on a following
    // count that never moved off 215).
    const result = await reconcileRoster(
      tx,
      trackedAccountId,
      "following",
      live,
      isCompleteRead,
      {
        // A paid/independent source is only authoritative when it also clears
        // the profile-count completeness gate. This prevents a provider that
        // silently returns a short list from instantly settling a bad roster.
        trustedBaseline:
          options.trustedBaseline === true && isCompleteRead,
        leg: options.leg,
        minimumCompleteReadMembers: options.minimumCompleteReadMembers,
        baselineOnly: options.baselineOnly,
      },
    );
    if (options.cursor) {
      await saveRosterCursor(trackedAccountId, "following", options.cursor.nextCursor, options.cursor.viewerBotId, tx);
    }

    // Cancel churn: a follow that reverses a recent unfollow (or vice-versa) on
    // the same account is pagination flapping, not activity — drop both.
    const survivors = await cancelChurn(
      tx,
      trackedAccountId,
      result.arrivals.map((a) => a.username.toLowerCase()),
      [...result.departures],
      {
        followTable: followEvents,
        followUsername: followEvents.followedUsername,
        followDetectedAt: followEvents.detectedAt,
        unfollowTable: unfollowEvents,
        unfollowUsername: unfollowEvents.unfollowedUsername,
        unfollowDetectedAt: unfollowEvents.detectedAt,
      },
    );
    const survivingArrivalNames = new Set(survivors.arrivals);
    const genuineArrivals = result.arrivals.filter((a) =>
      survivingArrivalNames.has(a.username.toLowerCase()),
    );

    // Events are now a derived audit trail of CONFIRMED transitions only.
    if (genuineArrivals.length > 0) {
      await tx.insert(followEvents).values(
        genuineArrivals.map((u) => ({
          trackedAccountId,
          followedUsername: u.username,
          followedDisplayName: u.displayName,
        })),
      );
    }

    if (survivors.departures.length > 0) {
      await tx.insert(unfollowEvents).values(
        survivors.departures.map((username) => ({
          trackedAccountId,
          unfollowedUsername: username,
        })),
      );
    }

    // The roster is only believable once its baseline has settled; that instant
    // is also the boundary before which no follow_event can be proven genuine,
    // so "Recently followed" (migration 0027) keys off the same moment.
    //
    // SET-ONCE (Issue 2, 2026-07-16): only stamp when the boundary is still
    // null. A re-settle (e.g. after roster_sync_state was reset) must NOT move
    // the boundary forward — doing so retroactively hid genuinely-detected
    // follow events that predate the re-settle (the client's "Sam" follow
    // vanished from Recently Followed while still showing in the activity feed).
    if (result.justSettled) {
      await tx
        .update(trackedAccounts)
        .set({ followingFirstCompleteAt: sql`now()` })
        .where(
          and(
            eq(trackedAccounts.id, trackedAccountId),
            sql`${trackedAccounts.followingFirstCompleteAt} IS NULL`,
          ),
        );
    }

    // Report the churn-cancelled survivor counts, not the raw reconcile output —
    // a cancelled pair is not activity and must not fire realtime or inflate the
    // outcome.
    await options.transactionCheckpoint?.(tx);
    return {
      completeRead: result.completeRead,
      newFollows: genuineArrivals.length,
      newUnfollows: survivors.departures.length,
    };
  });

  // Realtime fires only after COMMIT — a rolled-back diff must not notify.
  if (outcome.newFollows > 0 || outcome.newUnfollows > 0) {
    emitRealtime({
      kind: "following.changed",
      trackedAccountId,
      igUsername: await lookupUsername(trackedAccountId),
      count: outcome.newFollows + outcome.newUnfollows,
      payload: {
        added: outcome.newFollows,
        removed: outcome.newUnfollows,
      },
    });
  }

  return outcome;
}

// ── Follower diff (inbound follows / unfollows OF tracked user) ─────────────

export interface FollowerDiffOutcome {
  readonly completeRead: boolean;
  readonly newFollowers: number;
  readonly newFollowerUnfollows: number;
}

// D12: the unfollow candidates hold LOWERCASED usernames (from the SQL known
// set) while follower_events stores the original casing — so the display
// lookup compares on lower(follower_username) (served by the 0019 expression
// index) and the unfollow row is written with the original-cased username
// from the latest matching follower_events row (best-effort: if none is
// found, insert the lowercased name with null display data).
async function insertFollowerUnfollowRows(
  tx: Tx,
  trackedAccountId: string,
  lowercasedUsernames: ReadonlyArray<string>,
): Promise<void> {
  const followerDetails = await tx
    .select()
    .from(followerEvents)
    .where(
      and(
        eq(followerEvents.trackedAccountId, trackedAccountId),
        inArray(
          sql`lower(${followerEvents.followerUsername})`,
          [...lowercasedUsernames],
        ),
      ),
    )
    .orderBy(asc(followerEvents.detectedAt), asc(followerEvents.id));

  // Ascending order + map overwrite => the LATEST row's display data wins.
  const detailMap = new Map<string, (typeof followerDetails)[number]>();
  for (const d of followerDetails) {
    detailMap.set(d.followerUsername.toLowerCase(), d);
  }

  await tx.insert(followerUnfollowEvents).values(
    lowercasedUsernames.map((username) => {
      const detail = detailMap.get(username);
      return {
        trackedAccountId,
        unfollowerUsername: detail?.followerUsername ?? username,
        unfollowerDisplayName: detail?.followerDisplayName ?? null,
        unfollowerIgUserId: detail?.followerIgUserId ?? null,
        unfollowerPfpUrl: detail?.followerPfpUrl ?? null,
      };
    }),
  );
}

export async function persistFollowerDiff(
  trackedAccountId: string,
  liveFollowers: ReadonlyArray<IGFollowUser>,
  options: FollowDiffPersistOptions = {},
): Promise<FollowerDiffOutcome> {
  // Dedupe BEFORE gating — see persistFollowingDiff: only DISTINCT members are
  // coverage, and paginated captures repeat rows.
  const live = dedupeByUsername(liveFollowers);

  // Completeness gate: decides whether this capture may be used as evidence of
  // ABSENCE at all (the wire.fluid case captured 12 of an expected 495).
  // reconcileRoster then requires repeated absence across complete reads before
  // confirming anyone actually left.
  const isCompleteRead = options.leg?.headOnly
    ? false
    : await resolveUnfollowGate(trackedAccountId, "follower", live.length);
  // roster_members stores only identity + display name; follower_events also
  // carries ig_user_id / pfp, so arrivals are mapped back to the live capture
  // rather than widening the roster contract with serving-layer fields.
  const liveByUsername = new Map(
    live.map((u) => [u.username.toLowerCase(), u]),
  );

  // D2: atomic + serialized per account via the advisory lock (see
  // persistFollowingDiff / migration 0019 for the full rationale).
  const outcome = await db.transaction(async (tx) => {
    await options.transactionGuard?.(tx);
    await lockAccountForDiff(tx, FOLLOWER_DIFF_LOCK_NS, trackedAccountId);

    // Same rewrite as the following side: roster state is a table now, not a
    // reconstruction from the event log this function writes to.
    const result = await reconcileRoster(
      tx,
      trackedAccountId,
      "follower",
      live,
      isCompleteRead,
      {
        trustedBaseline:
          options.trustedBaseline === true && isCompleteRead,
        heldCoversExpected: (held) =>
          heldRosterCoversExpected(trackedAccountId, "follower", held, tx),
        leg: options.leg,
        minimumCompleteReadMembers: options.minimumCompleteReadMembers,
        baselineOnly: options.baselineOnly,
      },
    );
    if (options.cursor) {
      await saveRosterCursor(trackedAccountId, "follower", options.cursor.nextCursor, options.cursor.viewerBotId, tx);
    }

    // Cancel churn on the follower side too — same pagination-flapping problem,
    // same fix (a gained-follower reversing a recent lost-follower, or vice
    // versa, on the same account is noise, not activity).
    const survivors = await cancelChurn(
      tx,
      trackedAccountId,
      result.arrivals.map((a) => a.username.toLowerCase()),
      [...result.departures],
      {
        followTable: followerEvents,
        followUsername: followerEvents.followerUsername,
        followDetectedAt: followerEvents.detectedAt,
        unfollowTable: followerUnfollowEvents,
        unfollowUsername: followerUnfollowEvents.unfollowerUsername,
        unfollowDetectedAt: followerUnfollowEvents.detectedAt,
      },
    );
    const survivingArrivalNames = new Set(survivors.arrivals);
    const newFollowers = result.arrivals
      .filter((a) => survivingArrivalNames.has(a.username.toLowerCase()))
      .map((a) => liveByUsername.get(a.username.toLowerCase()))
      .filter((u): u is IGFollowUser => u !== undefined);
    const newFollowerUnfollows = survivors.departures;

    if (newFollowers.length > 0) {
      await tx.insert(followerEvents).values(
        newFollowers.map((u) => ({
          trackedAccountId,
          followerUsername: u.username,
          followerDisplayName: u.fullName || null,
          followerIgUserId: u.igUserId || null,
          followerPfpUrl: u.profilePicUrl || null,
        })),
      );
    }

    if (newFollowerUnfollows.length > 0) {
      await insertFollowerUnfollowRows(
        tx,
        trackedAccountId,
        newFollowerUnfollows,
      );
    }

    await options.transactionCheckpoint?.(tx);
    return {
      completeRead: result.completeRead,
      newFollowers: newFollowers.length,
      newFollowerUnfollows: newFollowerUnfollows.length,
    };
  });

  // Realtime fires only after COMMIT — a rolled-back diff must not notify.
  if (outcome.newFollowers > 0 || outcome.newFollowerUnfollows > 0) {
    emitRealtime({
      kind: "followers.changed",
      trackedAccountId,
      igUsername: await lookupUsername(trackedAccountId),
      count: outcome.newFollowers + outcome.newFollowerUnfollows,
      payload: {
        added: outcome.newFollowers,
        removed: outcome.newFollowerUnfollows,
      },
    });
  }

  return outcome;
}

// ── Comments (Wave 5) ───────────────────────────────────────────────────────
//
// persistComments inserts scraped comments into comments_cache, keyed by
// (post_shortcode, ig_comment_pk). Conflicts are silently skipped — we
// preserve the original cached_at for comments we've already seen rather
// than overwriting historical data on every refresh.
//
// Returns the count of *newly inserted* rows so the caller can decide
// whether to surface a "fresh activity" indicator to the user.

export interface PersistCommentsOutcome {
  readonly inserted: number;
}

export async function persistComments(
  shortcode: string,
  comments: ReadonlyArray<IGComment>,
): Promise<PersistCommentsOutcome> {
  if (!shortcode) {
    throw new Error("[persist-comments] shortcode is required");
  }
  if (comments.length === 0) {
    return { inserted: 0 };
  }

  // Defend against bad shapes from the scraper. A comment without an
  // ig_comment_pk would hit the unique index as NULL and break idempotency.
  const rows = comments
    .filter((c) => c.pk && c.username)
    .map((c) => ({
      postShortcode: shortcode,
      igCommentPk: c.pk,
      authorUsername: c.username,
      authorDisplayName: c.displayName,
      authorPfpUrl: c.pfpUrl,
      text: c.text ?? "",
      likeCount: c.likeCount ?? 0,
      createdAtIg:
        typeof c.createdAt === "number" && c.createdAt > 0
          ? new Date(c.createdAt * 1000)
          : null,
    }));

  if (rows.length === 0) {
    return { inserted: 0 };
  }

  const result = await db
    .insert(commentsCache)
    .values(rows)
    .onConflictDoNothing({
      target: [commentsCache.postShortcode, commentsCache.igCommentPk],
    })
    .returning({ id: commentsCache.id });

  logger.debug(
    { shortcode, scraped: comments.length, inserted: result.length },
    "comments upserted",
  );

  // Persist commenter avatars to the media cache (same reason as likers).
  void enqueueMediaCacheUrls(
    rows.map((r) => r.authorPfpUrl).filter((u): u is string => !!u),
    "comment-avatars",
  );

  return { inserted: result.length };
}

// ── Likers (Wave 5) ─────────────────────────────────────────────────────────
//
// persistLikers inserts scraped likers into likers_cache, keyed by
// (post_shortcode, liker_username). Conflicts are silently skipped — we
// preserve the original cached_at so a refresh doesn't repeatedly bump
// historical timestamps for users who liked the post on day 1.
//
// IG's likers endpoint caps at ~100 users with no pagination cursor, so
// each call replaces the cache page conceptually but additively (we never
// delete rows). Returns the count of *newly inserted* rows.

export interface PersistLikersOutcome {
  readonly inserted: number;
}

export async function persistLikers(
  shortcode: string,
  likers: ReadonlyArray<IGUser>,
): Promise<PersistLikersOutcome> {
  if (!shortcode) {
    throw new Error("[persist-likers] shortcode is required");
  }
  if (likers.length === 0) {
    return { inserted: 0 };
  }

  // Defensive filter: a row with empty username would conflict on the unique
  // index in unpredictable ways and is useless to the UI anyway.
  const rows = likers
    .filter((u) => u.username)
    .map((u) => ({
      postShortcode: shortcode,
      likerUsername: u.username,
      likerDisplayName: u.fullName,
      likerPfpUrl: u.profilePicUrl,
      likerIgUserId: u.pk || null,
      isVerified: u.isVerified,
    }));

  if (rows.length === 0) {
    return { inserted: 0 };
  }

  const result = await db
    .insert(likersCache)
    .values(rows)
    .onConflictDoNothing({
      target: [likersCache.postShortcode, likersCache.likerUsername],
    })
    .returning({ id: likersCache.id });

  logger.debug(
    { shortcode, scraped: likers.length, inserted: result.length },
    "likers upserted",
  );

  // Persist liker avatars to the media cache so "liked images" survive IG CDN
  // URL expiry (the ephemeral URL rotates within hours; without caching the
  // avatar renders blank once it does).
  void enqueueMediaCacheUrls(
    rows.map((r) => r.likerPfpUrl).filter((u): u is string => !!u),
    "liker-avatars",
  );

  return { inserted: result.length };
}
