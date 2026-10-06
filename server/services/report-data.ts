// Rich weekly/monthly report data.
//
// The original report captured four numbers (likes, follows, unfollows, peak
// hour) and hardcoded topNiche to null, which is far too thin to hand a client.
// This gathers everything the PDF renders, in ONE place, so the worker, the API
// and the renderer can never drift.
//
// Every query is scoped to (trackedAccountId, [periodStart, periodEnd)) and is
// read-only — building a report must never mutate collection state.

import { and, gte, lt, eq, desc, sql, isNotNull, inArray, count } from "drizzle-orm";
import { db } from "../db.js";
import {
  likeEvents,
  followEvents,
  followerEvents,
  followerUnfollowEvents,
  unfollowEvents,
  profileSnapshots,
  trackedAccounts,
  postsCache,
  storiesCache,
  highlightsCache,
} from "../../shared/schema.js";
import { likedPostAfterTrackingStart } from "./like-event-policy.js";
import {
  canonicalTwinId,
  twinTrackedAccountIds,
} from "./tracked-account-twins.js";
import {
  countRosterDepartures,
  countVisibleFollowEvents,
  followActivityFilters,
  listRosterDepartures,
  visibleFollowEventsSql,
  visibleFollowerUnfollowsSql,
  type RosterDeparturesParams,
  type VisibleFollowEventsParams,
} from "./roster.js";

export interface ReportCounter {
  readonly label: string;
  readonly count: number;
}

export interface ReportLikedPost {
  readonly postId: string;
  readonly ownerUsername: string;
  readonly postType: string;
  readonly thumbnailUrl: string | null;
  readonly postUrl: string | null;
  readonly likesCount: number;
  readonly detectedAt: Date;
}

export interface ReportLeaderboardEntry {
  /** The account whose posts were liked. */
  readonly username: string;
  /** How many of their posts the tracked account liked this period. */
  readonly count: number;
  /** Up to a few thumbnails of the liked posts (raw URLs; proxy on the client). */
  readonly thumbnails: ReadonlyArray<string>;
}

export interface ReportActivityAccount {
  readonly username: string;
  readonly displayName: string | null;
  readonly detectedAt: Date;
}

export type ReportInterestBasis =
  | "hashtags"
  | "caption_keywords"
  | "post_formats";

export interface ReportDailyPoint {
  readonly date: string;
  readonly followers: number;
  readonly following: number;
}

export interface ReportOwnPost {
  readonly shortcode: string;
  readonly postType: string;
  readonly thumbnailUrl: string | null;
  readonly caption: string | null;
  readonly likeCount: number;
  readonly commentCount: number;
  readonly takenAt: Date | null;
}

/** Same metrics for the immediately preceding window, for period-over-period. */
export interface ReportComparison {
  readonly totalLikes: number;
  readonly netFollowerChange: number | null;
  readonly accountsUnfollowed: number;
  readonly accountsFollowed: number;
  readonly followingEventsTrustworthy: boolean;
}

export interface ReportData {
  readonly account: {
    readonly igUsername: string;
    readonly displayName: string | null;
    readonly profilePicUrl: string | null;
    readonly isPrivate: boolean;
  };
  readonly period: { readonly start: Date; readonly end: Date; readonly type: string };
  readonly summary: {
    readonly totalLikes: number;
    /**
     * Followers DETECTED for the first time in the window. This counts roster
     * discovery, not growth: the first full enumeration of an existing roster
     * emits one event per existing follower, so on a backfill week this reads in
     * the thousands while the account actually grew by ~20. NEVER show this as
     * "new followers" — use `netFollowerChange` (IG's own count) for growth and
     * treat this as "newly seen".
     */
    readonly followersDetected: number;
    /** Followers seen leaving. Always 0 while the followers roster is untrusted. */
    readonly followersLost: number;
    /**
     * Authoritative growth: last minus first profile snapshot in the window
     * (IG's own follower number). Null without two distinct observation times.
     */
    readonly netFollowerChange: number | null;
    /** True when the roster is complete enough for detected/lost to mean growth. */
    readonly followerEventsTrustworthy: boolean;
    /** Accounts the tracked user STARTED following (see trust flag below). */
    readonly accountsFollowed: number;
    /** Accounts the tracked user STOPPED following (see trust flag below). */
    readonly accountsUnfollowed: number;
    /**
     * Authoritative following change: snapshot delta (IG's own following count).
     */
    readonly netFollowingChange: number | null;
    /**
     * False when follow/unfollow counts are dominated by roster RE-ENUMERATION
     * rather than real activity. Same trap as followersDetected:
     * @sample_account showed 1,264 followed + 1,242 unfollowed in a week while
     * following only moved 208 → 209 — you cannot follow 1,264 accounts and end
     * up following 209. When false, show netFollowingChange and hide the gross
     * counts rather than print an obviously-wrong number for a client.
     */
    readonly followingEventsTrustworthy: boolean;
  };
  readonly profile: {
    readonly followerCountStart: number | null;
    readonly followerCountEnd: number | null;
    readonly followingCountStart: number | null;
    readonly followingCountEnd: number | null;
    readonly postCountEnd: number | null;
  };
  readonly activityByDay: ReadonlyArray<{ readonly day: string; readonly count: number }>;
  readonly activityByHour: ReadonlyArray<{ readonly hour: number; readonly count: number }>;
  readonly peakActivityHour: number | null;
  readonly topHashtags: ReadonlyArray<ReportCounter>;
  readonly topInterests: ReadonlyArray<ReportCounter>;
  readonly interestBasis: ReportInterestBasis;
  readonly topLikedAccounts: ReadonlyArray<ReportCounter>;
  /** Top liked accounts with post thumbnails — the "who they engage with" leaderboard. */
  readonly likesLeaderboard: ReadonlyArray<ReportLeaderboardEntry>;
  readonly postTypeBreakdown: ReadonlyArray<ReportCounter>;
  readonly likedPosts: ReadonlyArray<ReportLikedPost>;
  readonly newFollowerSample: ReadonlyArray<string>;
  readonly lostFollowerSample: ReadonlyArray<string>;
  readonly unfollowedSample: ReadonlyArray<string>;
  readonly followedAccounts: ReadonlyArray<ReportActivityAccount>;
  readonly unfollowedAccounts: ReadonlyArray<ReportActivityAccount>;
  /** Daily follower/following series for the growth chart (from snapshots). */
  readonly dailySeries: ReadonlyArray<ReportDailyPoint>;
  /** What the tracked account itself published, and how it performed. */
  readonly ownPosts: {
    /** Observed cached posts published in the period; not proof of exhaustive collection. */
    readonly publishedInPeriod: number;
    readonly totalOnProfile: number | null;
    readonly avgLikes: number | null;
    readonly avgComments: number | null;
    /** Engagement rate = avg interactions per post / followers, as a %. */
    readonly engagementRatePct: number | null;
    readonly topPosts: ReadonlyArray<ReportOwnPost>;
  };
  readonly content: {
    readonly activeStories: number;
    readonly highlights: number;
  };
  /** The previous equal-length window, for "vs last period" deltas. */
  readonly previous: ReportComparison;
  readonly generatedAt: Date;
}

const TOP_LIMIT = 8;

const CAPTION_TOPICS: ReadonlyArray<{
  label: string;
  roots: ReadonlyArray<string>;
}> = [
  {
    label: "Family & relationships",
    roots: [
      "baby", "birth", "birthday", "born", "dad", "famil", "father", "friend",
      "husband", "love", "marri", "mom", "mother", "wedding", "wife",
    ],
  },
  {
    label: "Travel & adventure",
    roots: [
      "adventure", "beach", "city", "europe", "festival", "flight", "london",
      "museum", "trip", "travel", "vacation",
    ],
  },
  {
    label: "Sports & fitness",
    roots: [
      "coach", "fitness", "game", "gym", "judo", "rugby", "sport", "tennis",
      "train", "workout",
    ],
  },
  {
    label: "Film & creativity",
    roots: [
      "acting", "actor", "creative", "edit", "film", "music", "photograph",
      "theatre", "video",
    ],
  },
  {
    label: "Faith & spirituality",
    roots: [
      "apostle", "church", "devotional", "faith", "god", "jesus", "prayer",
      "spiritual",
    ],
  },
  {
    label: "Health & wellness",
    roots: [
      "appendix", "health", "hospital", "recovery", "surgery", "wellness",
    ],
  },
  {
    label: "Beauty & style",
    roots: ["barber", "beauty", "fashion", "hair", "stylist"],
  },
  {
    label: "Business & motivation",
    roots: ["business", "career", "entrepreneur", "motivation", "success"],
  },
];

function captionInterests(
  rows: ReadonlyArray<{ caption: string | null }>,
): ReportCounter[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const withoutHandles = (row.caption ?? "").replace(/@\S+/gu, " ");
    const words = new Set(
      withoutHandles
        .toLocaleLowerCase("en-US")
        .match(/[\p{L}][\p{L}\p{N}'-]{2,}/gu) ?? [],
    );
    // Count a topic once per liked post. A small explicit taxonomy produces
    // client-readable interests ("Sports & fitness"), not noisy filler words
    // such as "years" or "actually".
    for (const topic of CAPTION_TOPICS) {
      const matches = topic.roots.some((root) =>
        [...words].some((word) => word.startsWith(root)),
      );
      if (matches) {
        counts.set(topic.label, (counts.get(topic.label) ?? 0) + 1);
      }
    }
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, TOP_LIMIT);
}

function formatInterestFallback(label: string): string {
  const names: Record<string, string> = {
    carousel: "Carousel posts",
    reel: "Reels",
    photo: "Photos",
    video: "Videos",
    story: "Stories",
    tagged_post: "Tagged posts",
  };
  return names[label] ?? label;
}

async function countIn(
  table:
    | typeof likeEvents
    | typeof followEvents
    | typeof followerEvents
    | typeof followerUnfollowEvents
    | typeof unfollowEvents,
  trackedAccountId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(
      and(
        eq(table.trackedAccountId, trackedAccountId),
        gte(table.detectedAt, start),
        lt(table.detectedAt, end),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Visible liked posts in [start, end): the twin union (liked-post evidence
 * belongs to the IG user) deduped by post id, gated by the REQUESTING row's
 * tracking start. Same count the dashboard header shows.
 */
async function countVisibleLikesIn(
  twinIds: readonly string[],
  trackingStarted: Date,
  start: Date,
  end: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(DISTINCT ${likeEvents.postId})::int` })
    .from(likeEvents)
    .where(
      and(
        inArray(likeEvents.trackedAccountId, twinIds),
        gte(likeEvents.detectedAt, start),
        lt(likeEvents.detectedAt, end),
        likedPostAfterTrackingStart(trackingStarted),
      ),
    );
  return row?.n ?? 0;
}

/** Earliest / latest profile snapshot inside the window (null when never captured). */
async function snapshotBounds(
  trackedAccountId: string,
  start: Date,
  end: Date,
): Promise<{ first: typeof profileSnapshots.$inferSelect | null; last: typeof profileSnapshots.$inferSelect | null }> {
  const rows = await db
    .select()
    .from(profileSnapshots)
    .where(
      and(
        eq(profileSnapshots.trackedAccountId, trackedAccountId),
        gte(profileSnapshots.snapshotAt, start),
        lt(profileSnapshots.snapshotAt, end),
      ),
    )
    .orderBy(profileSnapshots.snapshotAt);
  return { first: rows[0] ?? null, last: rows[rows.length - 1] ?? null };
}

function snapshotChange(
  bounds: Awaited<ReturnType<typeof snapshotBounds>>,
  field: "followerCount" | "followingCount",
): number | null {
  if (!bounds.first || !bounds.last ||
      bounds.last.snapshotAt.getTime() <= bounds.first.snapshotAt.getTime()) return null;
  return bounds.last[field] - bounds.first[field];
}

/**
 * The subset of {@link ReportData} persisted to `reports.metrics` (migration
 * 0028) and rendered by the Reports list.
 *
 * Why a projection rather than the whole blob: ReportData also carries per-post
 * samples and full liked-post arrays, which are large, contain signed CDN URLs
 * that expire, and are re-derived on demand by the PDF renderer anyway. Only
 * the durable aggregates belong in a stored row.
 *
 * This is the contract the client reads, so it lives beside the builder rather
 * than being re-declared in the worker.
 */
export interface ReportMetrics {
  readonly summary: ReportData["summary"];
  readonly profile: ReportData["profile"];
  readonly ownPosts: Pick<
    ReportData["ownPosts"],
    | "publishedInPeriod"
    | "totalOnProfile"
    | "avgLikes"
    | "avgComments"
    | "engagementRatePct"
  >;
  readonly content: ReportData["content"];
  readonly previous: ReportData["previous"];
  readonly peakActivityHour: ReportData["peakActivityHour"];
  readonly topHashtags: ReportData["topHashtags"];
  readonly topInterests: ReportData["topInterests"];
  readonly interestBasis: ReportData["interestBasis"];
  readonly topLikedAccounts: ReportData["topLikedAccounts"];
  readonly likesLeaderboard: ReportData["likesLeaderboard"];
  readonly followedAccounts: ReportData["followedAccounts"];
  readonly unfollowedAccounts: ReportData["unfollowedAccounts"];
  readonly dailySeries: ReportData["dailySeries"];
}

/** Project a full ReportData into the stored, client-facing metrics payload. */
export function toReportMetrics(data: ReportData): ReportMetrics {
  return {
    summary: data.summary,
    profile: data.profile,
    ownPosts: {
      publishedInPeriod: data.ownPosts.publishedInPeriod,
      totalOnProfile: data.ownPosts.totalOnProfile,
      avgLikes: data.ownPosts.avgLikes,
      avgComments: data.ownPosts.avgComments,
      engagementRatePct: data.ownPosts.engagementRatePct,
    },
    content: data.content,
    previous: data.previous,
    peakActivityHour: data.peakActivityHour,
    topHashtags: data.topHashtags.slice(0, 5),
    topInterests: data.topInterests,
    interestBasis: data.interestBasis,
    // This is explicitly the all-liked-accounts section. Do not silently
    // truncate it to a top-five/top-six subset.
    topLikedAccounts: data.topLikedAccounts,
    likesLeaderboard: data.likesLeaderboard,
    followedAccounts: data.followedAccounts,
    unfollowedAccounts: data.unfollowedAccounts,
    dailySeries: data.dailySeries,
  };
}

export async function buildReportData(
  trackedAccountId: string,
  periodStart: Date,
  periodEnd: Date,
  periodType: string,
): Promise<ReportData> {
  const [account] = await db
    .select()
    .from(trackedAccounts)
    .where(eq(trackedAccounts.id, trackedAccountId))
    .limit(1);
  if (!account) throw new Error(`tracked account ${trackedAccountId} not found`);

  // Liked-post evidence belongs to the IG user → read the twin union. Rosters
  // live on the canonical twin. Follow/unfollow gates are per-row and built by
  // the same helper the viewer and feed use, so the report cannot disagree.
  const [twinIds, rosterAccountId, followFilters] = await Promise.all([
    twinTrackedAccountIds(trackedAccountId),
    canonicalTwinId(trackedAccountId),
    followActivityFilters(trackedAccountId),
  ]);
  const followParams: VisibleFollowEventsParams = {
    trackedAccountId,
    rosterAccountId,
    boundary: followFilters.boundary,
  };
  const departuresIn = (start: Date, end: Date): RosterDeparturesParams => ({
    rosterAccountId,
    unfollowsTrusted: followFilters.unfollowsTrusted,
    start: new Date(Math.max(start.getTime(), account.trackingStarted.getTime(), followFilters.boundary?.getTime() ?? 0)),
    end,
  });

  const [
    totalLikes,
    newFollowers,
    lostFollowers,
    accountsFollowed,
    accountsUnfollowed,
    bounds,
  ] = await Promise.all([
    countVisibleLikesIn(
      twinIds,
      account.trackingStarted,
      periodStart,
      periodEnd,
    ),
    countIn(followerEvents, rosterAccountId, new Date(Math.max(periodStart.getTime(), account.trackingStarted.getTime())), periodEnd),
    db.select({ n: count() }).from(followerUnfollowEvents).where(and(
      visibleFollowerUnfollowsSql(rosterAccountId, account.trackingStarted),
      gte(followerUnfollowEvents.detectedAt, periodStart), lt(followerUnfollowEvents.detectedAt, periodEnd),
    )).then(rows => rows[0]?.n ?? 0),
    countVisibleFollowEvents(followParams, periodStart, periodEnd),
    countRosterDepartures(departuresIn(periodStart, periodEnd)),
    snapshotBounds(trackedAccountId, periodStart, periodEnd),
  ]);

  const inWindow = and(
    inArray(likeEvents.trackedAccountId, twinIds),
    gte(likeEvents.detectedAt, periodStart),
    lt(likeEvents.detectedAt, periodEnd),
    likedPostAfterTrackingStart(account.trackingStarted),
  );
  // One row per post across the twin union — the best-ranked copy (newest
  // post, then newest detection, as dedupeLikedPostsByPostId ranks) — so every
  // aggregate below counts a liked post exactly once.
  const visibleLikes = db
    .selectDistinctOn([likeEvents.postId], {
      postId: likeEvents.postId,
      ownerUsername: likeEvents.ownerUsername,
      postType: likeEvents.postType,
      thumbnailUrl: likeEvents.thumbnailUrl,
      postUrl: likeEvents.postUrl,
      likesCount: likeEvents.likesCount,
      detectedAt: likeEvents.detectedAt,
      postTakenAt: likeEvents.postTakenAt,
      caption: likeEvents.caption,
      hashtags: likeEvents.hashtags,
    })
    .from(likeEvents)
    .where(inWindow)
    .orderBy(
      likeEvents.postId,
      sql`${likeEvents.postTakenAt} DESC NULLS LAST`,
      desc(likeEvents.detectedAt),
    )
    .as("visible_likes");

  const [
    byHourRows,
    byDayRows,
    topOwners,
    typeRows,
    likedPostRows,
    followerSample,
    lostSample,
    followedAccountRows,
    unfollowedAccountRows,
    hashtagRows,
    interestInputRows,
  ] = await Promise.all([
    db
      .select({
        hour: sql<number>`EXTRACT(HOUR FROM ${visibleLikes.detectedAt})::int`,
        n: sql<number>`count(*)::int`,
      })
      .from(visibleLikes)
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({
        day: sql<string>`TO_CHAR(${visibleLikes.detectedAt}, 'Dy')`,
        n: sql<number>`count(*)::int`,
      })
      .from(visibleLikes)
      .groupBy(sql`1`),
    db
      .select({
        label: visibleLikes.ownerUsername,
        n: sql<number>`count(*)::int`,
      })
      .from(visibleLikes)
      .groupBy(visibleLikes.ownerUsername)
      .orderBy(sql`2 DESC`, visibleLikes.ownerUsername),
    db
      .select({ label: visibleLikes.postType, n: sql<number>`count(*)::int` })
      .from(visibleLikes)
      .groupBy(visibleLikes.postType)
      .orderBy(sql`2 DESC`),
    db
      .select({
        postId: visibleLikes.postId,
        ownerUsername: visibleLikes.ownerUsername,
        postType: visibleLikes.postType,
        thumbnailUrl: visibleLikes.thumbnailUrl,
        postUrl: visibleLikes.postUrl,
        likesCount: visibleLikes.likesCount,
        detectedAt: visibleLikes.detectedAt,
      })
      .from(visibleLikes)
      // Newest POST first: detected_at is when we inferred the like, which has
      // no bearing on how recent the post itself is.
      .orderBy(
        sql`${visibleLikes.postTakenAt} DESC NULLS LAST`,
        desc(visibleLikes.detectedAt),
      )
      .limit(12),
    db
      .select({ u: followerEvents.followerUsername })
      .from(followerEvents)
      .where(
        and(
          eq(followerEvents.trackedAccountId, rosterAccountId),
          gte(followerEvents.detectedAt, periodStart),
          gte(followerEvents.detectedAt, account.trackingStarted),
          lt(followerEvents.detectedAt, periodEnd),
        ),
      )
      .orderBy(desc(followerEvents.detectedAt))
      .limit(25),
    db
      // NB: this table names the column `unfollower_username` (NOT
      // follower_username like followerEvents) — referencing the wrong field
      // yields `undefined` and drizzle dies in orderSelectedFields.
      .select({ u: followerUnfollowEvents.unfollowerUsername })
      .from(followerUnfollowEvents)
      .where(
        and(
          visibleFollowerUnfollowsSql(rosterAccountId, account.trackingStarted),
          gte(followerUnfollowEvents.detectedAt, periodStart),
          lt(followerUnfollowEvents.detectedAt, periodEnd),
        ),
      )
      .orderBy(desc(followerUnfollowEvents.detectedAt))
      .limit(25),
    // Same gates as the viewer: settled-roster boundary, flip-flop suppression
    // (an unfollow of the same username in the prior window), and no roster
    // row contradicting the follow.
    db
      .select({
        username: followEvents.followedUsername,
        displayName: followEvents.followedDisplayName,
        detectedAt: followEvents.detectedAt,
      })
      .from(followEvents)
      .where(
        and(
          visibleFollowEventsSql(followParams),
          gte(followEvents.detectedAt, periodStart),
          lt(followEvents.detectedAt, periodEnd),
        ),
      )
      .orderBy(desc(followEvents.detectedAt)),
    // Confirmed departures from the roster (is_current=false), gated by the
    // unfollow-trust flag — never the raw unfollow_events log.
    listRosterDepartures(departuresIn(periodStart, periodEnd)).then((rows) =>
      rows.map((r) => ({
        username: r.username,
        displayName: r.displayName,
        detectedAt: r.leftAt,
      })),
    ),
    // hashtags is a text[]; UNNEST so we can rank the niche the account engages
    // with. This is what topNiche was always meant to be (it shipped as null).
    // Raw execute: drizzle's select() can't order fields over a lateral UNNEST
    // in the FROM clause.
    db.execute<{ label: string; n: number }>(sql`
      SELECT LOWER(tag) AS label, COUNT(*)::int AS n
      FROM ${visibleLikes}, UNNEST(${visibleLikes.hashtags}) AS tag
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT ${TOP_LIMIT}
    `),
    db
      .select({
        caption: visibleLikes.caption,
        postType: visibleLikes.postType,
      })
      .from(visibleLikes),
  ]);

  // db.execute returns either an array (drizzle) or { rows }. Normalise.
  const hashtagList: Array<{ label: string; n: number }> = Array.isArray(
    hashtagRows,
  )
    ? (hashtagRows as Array<{ label: string; n: number }>)
    : ((hashtagRows as { rows?: Array<{ label: string; n: number }> }).rows ??
      []);
  const topHashtags = hashtagList.map((r) => ({
    label: r.label.replace(/^#+/u, ""),
    count: r.n,
  }));

  const captionKeywordList = captionInterests(interestInputRows);
  const postFormatList = typeRows.map((r) => ({
    label: formatInterestFallback(r.label),
    count: r.n,
  }));
  const interestBasis: ReportInterestBasis =
    topHashtags.length > 0
      ? "hashtags"
      : captionKeywordList.length > 0
        ? "caption_keywords"
        : "post_formats";
  const topInterests =
    interestBasis === "hashtags"
      ? topHashtags
      : interestBasis === "caption_keywords"
        ? captionKeywordList
        : postFormatList;

  // ── Extra depth: growth series, own-post performance, content, prior period ──
  const periodMs = periodEnd.getTime() - periodStart.getTime();
  const prevStart = new Date(periodStart.getTime() - periodMs);
  const ownPostWindow = and(
    eq(postsCache.trackedAccountId, rosterAccountId),
    gte(postsCache.takenAt, periodStart),
    lt(postsCache.takenAt, periodEnd),
  );

  const [
    dailyRows,
    ownPostRows,
    storiesRow,
    highlightsRow,
    prevLikes,
    prevFollowed,
    prevUnfollowed,
    prevBounds,
  ] = await Promise.all([
    // One point per day: the LAST snapshot of each day is that day's close.
    db.execute<{ d: string; followers: number; following: number }>(sql`
      SELECT DISTINCT ON (${profileSnapshots.snapshotAt}::date)
        ${profileSnapshots.snapshotAt}::date::text AS d,
        ${profileSnapshots.followerCount} AS followers,
        ${profileSnapshots.followingCount} AS following
      FROM ${profileSnapshots}
      WHERE ${profileSnapshots.trackedAccountId} = ${trackedAccountId}
        AND ${profileSnapshots.snapshotAt} >= ${periodStart}
        AND ${profileSnapshots.snapshotAt} < ${periodEnd}
      ORDER BY ${profileSnapshots.snapshotAt}::date, ${profileSnapshots.snapshotAt} DESC
    `),
    db
      .select({
        shortcode: postsCache.shortcode,
        postType: postsCache.postType,
        thumbnailUrl: postsCache.thumbnailUrl,
        caption: postsCache.caption,
        likeCount: postsCache.likeCount,
        commentCount: postsCache.commentCount,
        takenAt: postsCache.takenAt,
      })
      .from(postsCache)
      .where(ownPostWindow)
      .orderBy(desc(postsCache.likeCount), desc(postsCache.takenAt), postsCache.shortcode)
      .limit(6),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(storiesCache)
      .where(eq(storiesCache.trackedAccountId, rosterAccountId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(highlightsCache)
      .where(eq(highlightsCache.trackedAccountId, rosterAccountId)),
    countVisibleLikesIn(
      twinIds,
      account.trackingStarted,
      prevStart,
      periodStart,
    ),
    countVisibleFollowEvents(followParams, prevStart, periodStart),
    countRosterDepartures(departuresIn(prevStart, periodStart)),
    snapshotBounds(trackedAccountId, prevStart, periodStart),
  ]);

  const dailyList = Array.isArray(dailyRows)
    ? (dailyRows as Array<{ d: string; followers: number; following: number }>)
    : ((dailyRows as { rows?: Array<{ d: string; followers: number; following: number }> })
        .rows ?? []);

  // Count and averages cover all cached posts in the period. The ranked sample
  // above only chooses the displayed posts; it cannot define the period total.
  const [agg] = await db
    .select({
      publishedInPeriod: sql<number>`count(*)::int`,
      avgLikes: sql<number | null>`round(avg(${postsCache.likeCount}))::int`,
      avgComments: sql<number | null>`round(avg(${postsCache.commentCount}))::int`,
    })
    .from(postsCache)
    .where(ownPostWindow);
  const publishedInPeriod = agg?.publishedInPeriod ?? 0;
  const avgLikes = agg?.avgLikes ?? null;
  const avgComments = agg?.avgComments ?? null;

  const followersEnd = bounds.last?.followerCount ?? null;
  // Interactions per post as a share of the follower count. NOTE this routinely
  // exceeds 100% on reel-heavy accounts because reels reach far beyond the
  // follower base (@sample_account: ~5.3k avg likes on 9.5k followers, one
  // reel at 54k). It is therefore labelled "avg interactions vs followers" in
  // the PDF — never "engagement rate", which implies a follower-only denominator.
  // Null (not 0) when an input is missing: a fabricated 0% reads as "dead".
  const engagementRatePct =
    avgLikes !== null && followersEnd && followersEnd > 0
      ? Math.round(((avgLikes + (avgComments ?? 0)) / followersEnd) * 1000) / 10
      : null;

  const byHour = byHourRows.map((r) => ({ hour: r.hour, count: r.n }));
  const peak =
    byHour.length > 0
      ? byHour.reduce((a, b) => (b.count > a.count ? b : a)).hour
      : null;

  // Likes leaderboard: the top liked accounts (accurate counts from topOwners)
  // each with a few post thumbnails. System-generated — a straight aggregate of
  // what was liked, no inference. Thumbnails are looked up per owner so every
  // ranked account shows imagery, not just the newest handful overall.
  const leaderOwners = topOwners.map((r) => r.label);
  const leaderThumbs = new Map<string, string[]>();
  if (leaderOwners.length > 0) {
    const thumbRows = await db
      .select({
        owner: visibleLikes.ownerUsername,
        thumb: visibleLikes.thumbnailUrl,
        takenAt: visibleLikes.postTakenAt,
        detectedAt: visibleLikes.detectedAt,
      })
      .from(visibleLikes)
      .where(isNotNull(visibleLikes.thumbnailUrl))
      .orderBy(
        sql`${visibleLikes.postTakenAt} DESC NULLS LAST`,
        desc(visibleLikes.detectedAt),
      );
    for (const r of thumbRows) {
      if (!r.thumb) continue;
      const list = leaderThumbs.get(r.owner) ?? [];
      if (list.length < 3) {
        list.push(r.thumb);
        leaderThumbs.set(r.owner, list);
      }
    }
  }
  const likesLeaderboard: ReportLeaderboardEntry[] = topOwners.map((r) => ({
      username: r.label,
      count: r.n,
      thumbnails: leaderThumbs.get(r.label) ?? [],
  }));

  const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const dayMap = new Map(byDayRows.map((r) => [r.day.trim(), r.n]));
  const activityByDay = DAY_ORDER.map((day) => ({
    day,
    count: dayMap.get(day) ?? 0,
  }));

  return {
    account: {
      igUsername: account.igUsername,
      displayName: account.displayName,
      profilePicUrl: account.profilePicUrl,
      isPrivate: account.isPrivate,
    },
    period: { start: periodStart, end: periodEnd, type: periodType },
    summary: {
      totalLikes,
      followersDetected: newFollowers,
      followersLost: lostFollowers,
      // Snapshot delta, NOT (detected - lost): the event tables count roster
      // DISCOVERY, so a backfill week would claim thousands of new followers on
      // an account that grew by 21. IG's own count is the honest number.
      netFollowerChange: snapshotChange(bounds, "followerCount"),
      // Detected/lost only track growth once we hold the whole roster. Mirrors
      // the dashboard's unfollow-trust rule: a roster short of IG's reported
      // count is still importing, so its events are discovery noise.
      followerEventsTrustworthy:
        bounds.last != null &&
        bounds.last.followerCount > 0 &&
        lostFollowers + newFollowers <= bounds.last.followerCount &&
        newFollowers <=
          Math.max(
            10,
            Math.abs(
              (bounds.last.followerCount ?? 0) -
                (bounds.first?.followerCount ?? bounds.last.followerCount),
            ) * 3,
          ),
      accountsFollowed,
      accountsUnfollowed,
      netFollowingChange: snapshotChange(bounds, "followingCount"),
      // Sanity: you cannot have followed/unfollowed far more accounts in one
      // window than you follow in total — that only happens when an earlier
      // roster capture was partial and the next full walk diffed the whole
      // difference as "activity". Require the gross churn to be believable
      // against the actual following count before showing it to a client.
      followingEventsTrustworthy: (() => {
        const followingEnd = bounds.last?.followingCount ?? null;
        const baseline = account.followingFirstCompleteAt;
        if (
          followingEnd === null ||
          followingEnd <= 0 ||
          baseline === null ||
          baseline > periodStart
        ) {
          return false;
        }
        return (
          accountsFollowed <= followingEnd && accountsUnfollowed <= followingEnd
        );
      })(),
    },
    profile: {
      followerCountStart: bounds.first?.followerCount ?? null,
      followerCountEnd: bounds.last?.followerCount ?? null,
      followingCountStart: bounds.first?.followingCount ?? null,
      followingCountEnd: bounds.last?.followingCount ?? null,
      postCountEnd: bounds.last?.postCount ?? null,
    },
    activityByDay,
    activityByHour: byHour,
    peakActivityHour: peak,
    topHashtags,
    topInterests,
    interestBasis,
    topLikedAccounts: topOwners.map((r) => ({ label: r.label, count: r.n })),
    likesLeaderboard,
    postTypeBreakdown: typeRows.map((r) => ({ label: r.label, count: r.n })),
    likedPosts: likedPostRows.map((r) => ({
      postId: r.postId,
      ownerUsername: r.ownerUsername,
      postType: r.postType,
      thumbnailUrl: r.thumbnailUrl,
      postUrl: r.postUrl,
      likesCount: r.likesCount ?? 0,
      detectedAt: r.detectedAt,
    })),
    newFollowerSample: followerSample.map((r) => r.u),
    lostFollowerSample: lostSample.map((r) => r.u),
    unfollowedSample: unfollowedAccountRows
      .map((r) => r.username)
      .slice(0, 25),
    followedAccounts: followedAccountRows,
    unfollowedAccounts: unfollowedAccountRows,
    dailySeries: dailyList.map((r) => ({
      date: r.d,
      followers: r.followers,
      following: r.following,
    })),
    ownPosts: {
      publishedInPeriod,
      totalOnProfile: bounds.last?.postCount ?? null,
      avgLikes,
      avgComments,
      engagementRatePct,
      topPosts: ownPostRows.slice(0, 6).map((p) => ({
        shortcode: p.shortcode,
        postType: p.postType,
        thumbnailUrl: p.thumbnailUrl,
        caption: p.caption,
        likeCount: p.likeCount ?? 0,
        commentCount: p.commentCount ?? 0,
        takenAt: p.takenAt,
      })),
    },
    content: {
      activeStories: storiesRow[0]?.n ?? 0,
      highlights: highlightsRow[0]?.n ?? 0,
    },
    previous: {
      totalLikes: prevLikes,
      accountsFollowed: prevFollowed,
      accountsUnfollowed: prevUnfollowed,
      followingEventsTrustworthy: (() => {
        const followingEnd = prevBounds.last?.followingCount ?? null;
        const baseline = account.followingFirstCompleteAt;
        return (
          followingEnd !== null &&
          followingEnd > 0 &&
          baseline !== null &&
          baseline <= prevStart &&
          prevFollowed <= followingEnd &&
          prevUnfollowed <= followingEnd
        );
      })(),
      netFollowerChange: snapshotChange(prevBounds, "followerCount"),
    },
    generatedAt: new Date(),
  };
}

export const __testing = {
  captionInterests,
  formatInterestFallback,
};
