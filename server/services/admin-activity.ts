import { sql, type SQL } from "drizzle-orm";
import { db } from "../db.js";
import { likedPostAfterJoinedAccountTrackingStart } from "./like-event-policy.js";
import { followFlipFlopWindowDays } from "./roster.js";
import { collectionHealthQuery } from "./collection-health.js";
import { healthyPrivateReaderTargetIds } from "./private-account-access.js";
import { customerAccessSql } from "./subscription-access.js";

export const ADMIN_ACTIVITY_TYPES = ["all", "like", "follow", "unfollow", "follower", "follower_unfollow"] as const;
export type AdminActivityType = typeof ADMIN_ACTIVITY_TYPES[number];
export interface AdminActivitySummary {
  totalLikes: number; totalFollows: number; totalUnfollows: number;
  likesLast24h: number; followsLast24h: number; unfollowsLast24h: number;
  totalFollowers: number; totalFollowerUnfollows: number;
  followersLast24h: number; followerUnfollowsLast24h: number;
}
export interface AdminActivityOptions {
  type: AdminActivityType; search: string; limit: number; offset: number; includeFollowers?: boolean;
  /** Scope before deduplication, so another owner's evidence cannot shadow a
   * selected private row or a selected public history page. */
  trackedAccountIds?: readonly string[];
  canonicalAccountId?: string;
}

/** One snapshot, one event set for BOTH pagination and total. No IG requests. */
export function adminActivityQuery({ type, search, limit, offset, includeFollowers = true, trackedAccountIds, canonicalAccountId }: AdminActivityOptions, healthyPrivateTargets: readonly string[] = []): SQL {
  const escaped = search.replace(/[\\%_]/g, "\\$&");
  const scope = trackedAccountIds === undefined ? sql`true`
    : trackedAccountIds.length ? sql`tracked_accounts.id IN (${sql.join(trackedAccountIds.map(id => sql`${id}`), sql`,`)})` : sql`false`;
  // Global Activity and scoped drilldowns must share the private-content
  // policy. Otherwise denied detail pages leak the same captions and media
  // through the global stream. Public administrative history stays visible.
  const readable = sql`(tracked_accounts.is_private IS FALSE OR (
    tracked_accounts.is_private IS TRUE AND tracked_accounts.is_active IS TRUE
    AND tracked_accounts.access_status='has_access'
    AND ${customerAccessSql(sql`tracked_accounts.user_id`)}))`;
  const identity = sql`CASE WHEN is_private THEN 'private:' || id
    ELSE 'public:' || COALESCE(NULLIF(ig_user_id,''), lower(ig_username)) END`;
  const likeIdentity = sql`CASE WHEN tracked_accounts.is_private THEN 'private:' || tracked_accounts.id
    ELSE 'public:' || COALESCE(NULLIF(tracked_accounts.ig_user_id,''), lower(tracked_accounts.ig_username)) END`;
  return sql`
    WITH canonical AS (
      SELECT DISTINCT ON (${identity})
        id, following_first_complete_at, tracking_started
      FROM tracked_accounts
      WHERE ${scope} AND ${readable} AND ${canonicalAccountId ? sql`id=${canonicalAccountId}` : sql`true`}
      ORDER BY ${identity},
        is_active DESC, tracking_started, id
    ), events AS (
      (SELECT DISTINCT ON (
        ${likeIdentity}, like_events.post_id)
        like_events.id, like_events.tracked_account_id, like_events.detected_at, 'like'::text event_type,
        jsonb_build_object('postId',like_events.post_id,'ownerUsername',like_events.owner_username,
          'postType',like_events.post_type,'postUrl',like_events.post_url,'thumbnailUrl',like_events.thumbnail_url,
          'caption',like_events.caption,'likesCount',like_events.likes_count,
          'commentsCount',like_events.comments_count,'postTakenAt',like_events.post_taken_at) payload
      FROM like_events JOIN tracked_accounts ON tracked_accounts.id=like_events.tracked_account_id
      WHERE ${scope} AND ${readable} AND ${likedPostAfterJoinedAccountTrackingStart()}
      ORDER BY ${likeIdentity},
        like_events.post_id, like_events.detected_at ASC, like_events.id ASC)
      UNION ALL
      SELECT e.id,e.tracked_account_id,e.detected_at,'follow',
        jsonb_build_object('followedUsername',e.followed_username)
      FROM follow_events e JOIN canonical c ON c.id=e.tracked_account_id
      LEFT JOIN roster_sync_state s ON s.tracked_account_id=c.id AND s.dimension='following'
      WHERE e.detected_at>GREATEST(c.following_first_complete_at,s.settled_at)
        AND NOT EXISTS (SELECT 1 FROM unfollow_events u WHERE u.tracked_account_id=e.tracked_account_id
          AND lower(u.unfollowed_username)=lower(e.followed_username)
          AND u.detected_at<=e.detected_at AND u.detected_at>=e.detected_at-interval '1 day'*${followFlipFlopWindowDays()})
        AND NOT EXISTS (SELECT 1 FROM roster_members r WHERE r.tracked_account_id=c.id
          AND r.dimension='following' AND r.username_lower=lower(e.followed_username) AND r.is_current=false)
      UNION ALL
      SELECT e.id,e.tracked_account_id,e.left_at,'unfollow',
        jsonb_build_object('unfollowedUsername',e.username)
      FROM roster_members e JOIN canonical c ON c.id=e.tracked_account_id
      JOIN roster_sync_state s ON s.tracked_account_id=c.id AND s.dimension='following' AND s.settled_at IS NOT NULL
      WHERE e.dimension='following' AND e.is_current=false
        AND e.left_at>GREATEST(c.following_first_complete_at,s.settled_at,c.tracking_started)
      UNION ALL
      SELECT e.id,e.tracked_account_id,e.detected_at,'follower',
        jsonb_build_object('followerUsername',e.follower_username)
      FROM follower_events e JOIN canonical c ON c.id=e.tracked_account_id
      UNION ALL
      SELECT e.id,e.tracked_account_id,e.detected_at,'follower_unfollow',
        jsonb_build_object('unfollowerUsername',e.unfollower_username)
      FROM follower_unfollow_events e JOIN canonical c ON c.id=e.tracked_account_id
      JOIN roster_sync_state s ON s.tracked_account_id=c.id AND s.dimension='follower' AND s.settled_at IS NOT NULL
      WHERE e.detected_at>s.settled_at
        AND EXISTS (SELECT 1 FROM roster_members r WHERE r.tracked_account_id=c.id
          AND r.dimension='follower' AND r.username_lower=lower(e.unfollower_username) AND r.is_current=false)
    ), filtered AS (
      SELECT e.id,e.event_type,e.detected_at,e.payload || jsonb_build_object(
        'id',e.event_type||':'||e.id,'trackedAccountId',t.id,'eventType',e.event_type,'detectedAt',e.detected_at,
        'igUsername',t.ig_username,'userId',t.user_id,'userEmail',u.email) item
      FROM events e JOIN tracked_accounts t ON t.id=e.tracked_account_id JOIN users u ON u.id=t.user_id
      WHERE (${type}='all' OR e.event_type=${type})
        AND (${includeFollowers} OR e.event_type IN ('like','follow','unfollow'))
        AND (${search}='' OR t.ig_username ILIKE ${`%${escaped}%`})
    ), page AS (
      SELECT * FROM filtered ORDER BY detected_at DESC,event_type,id LIMIT ${limit} OFFSET ${offset}
    )
    SELECT (SELECT count(*)::int FROM filtered) total,
      COALESCE((SELECT jsonb_agg(item ORDER BY detected_at DESC,event_type,id) FROM page),'[]'::jsonb) items,
      now() AS "asOf",
      (SELECT jsonb_build_object(
        'totalLikes',count(*) FILTER (WHERE event_type='like'),
        'totalFollows',count(*) FILTER (WHERE event_type='follow'),
        'totalUnfollows',count(*) FILTER (WHERE event_type='unfollow'),
        'totalFollowers',count(*) FILTER (WHERE event_type='follower'),
        'totalFollowerUnfollows',count(*) FILTER (WHERE event_type='follower_unfollow'),
        'likesLast24h',count(*) FILTER (WHERE event_type='like' AND detected_at>now()-interval '24 hours'),
        'followsLast24h',count(*) FILTER (WHERE event_type='follow' AND detected_at>now()-interval '24 hours'),
        'unfollowsLast24h',count(*) FILTER (WHERE event_type='unfollow' AND detected_at>now()-interval '24 hours'),
        'followersLast24h',count(*) FILTER (WHERE event_type='follower' AND detected_at>now()-interval '24 hours'),
        'followerUnfollowsLast24h',count(*) FILTER (WHERE event_type='follower_unfollow' AND detected_at>now()-interval '24 hours')
      ) FROM filtered) summary,
      (${trackedAccountIds === undefined ? collectionHealthQuery(healthyPrivateTargets) : sql`NULL`}) AS "collectionHealth"
  `;
}

export async function readAdminActivity(options: AdminActivityOptions) {
  const result = await db.execute(adminActivityQuery(options,
    options.trackedAccountIds === undefined ? await healthyPrivateReaderTargetIds() : []));
  const rows = (Array.isArray(result) ? result : result.rows) as Array<{ total: number; items: unknown[]; asOf: Date; collectionHealth: unknown; summary: AdminActivitySummary }>;
  return { ...rows[0], limit: options.limit, offset: options.offset };
}
