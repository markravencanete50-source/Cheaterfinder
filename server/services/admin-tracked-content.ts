import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  commentsCache, highlightItemsCache, highlightsCache, likersCache, postsCache,
  profileSnapshots, rosterMembers, storiesCache, trackedAccounts,
} from "../../shared/schema.js";
import { customerHasAccess } from "./subscription-access.js";
import { canonicalTwinId, twinTrackedAccountIds } from "./tracked-account-twins.js";
import { computeRosterSyncState } from "./roster.js";
import { getRosterSyncHealth, type RosterDimension } from "./roster-store.js";
import { readAdminActivity } from "./admin-activity.js";
import { readPostsCollectionState } from "./posts-collection-state.js";

type Account = typeof trackedAccounts.$inferSelect;
export type AdminContentAccess = {
  allowed: boolean;
  reason: null | "private_access_required" | "tracking_inactive" | "subscription_required";
};
export interface AdminContentScope {
  account: Account;
  contentAccountId: string;
  access: AdminContentAccess;
}
export function firstNonemptyString(...values: Array<string | null | undefined>): string | null {
  return values.find(value => typeof value === "string" && value.trim().length > 0) ?? null;
}

/** Administrative public history survives a pause. Private evidence remains
 * bound to the original row, its current grant and its owner's entitlement. */
export async function adminContentScope(id: string): Promise<AdminContentScope | null> {
  const [account] = await db.select().from(trackedAccounts).where(eq(trackedAccounts.id, id)).limit(1);
  if (!account) return null;
  let reason: AdminContentAccess["reason"] = null;
  if (account.isPrivate) {
    if (!account.isActive) reason = "tracking_inactive";
    else if (account.accessStatus !== "has_access") reason = "private_access_required";
    else if (!await customerHasAccess(account.userId)) reason = "subscription_required";
  }
  return {
    account,
    contentAccountId: reason ? account.id : await canonicalTwinId(account.id),
    access: { allowed: reason === null, reason },
  };
}

const postOrder = [desc(postsCache.isPinned), sql`${postsCache.takenAt} DESC NULLS LAST`, asc(postsCache.shortcode)];
export type AdminPostType = "all" | "photo" | "video" | "reel" | "carousel";
const postItem = (post: typeof postsCache.$inferSelect) => ({
  shortcode: post.shortcode, postType: post.postType, thumbnailUrl: post.thumbnailUrl,
  displayUrl: post.displayUrl, videoUrl: post.videoUrl, caption: post.caption,
  likeCount: post.likeCount ?? 0, commentCount: post.commentCount ?? 0,
  videoViewCount: post.videoViewCount, takenAt: post.takenAt, hashtags: post.hashtags,
  isPinned: post.isPinned, carouselMedia: post.carouselMedia,
});
const latestWrite = (rows: ReadonlyArray<{ cachedAt: Date }>) => rows.length
  ? new Date(Math.max(...rows.map(row => row.cachedAt.getTime()))).toISOString() : null;

export async function readAdminPosts(scope: AdminContentScope, offset: number, limit: number, type: AdminPostType = "all") {
  const rows = await db.select().from(postsCache).where(and(
    eq(postsCache.trackedAccountId, scope.contentAccountId),
    type === "all" ? undefined : eq(postsCache.postType, type),
  )).orderBy(...postOrder).limit(limit + 1).offset(offset);
  const postsCollection = await readPostsCollectionState(scope.account.id, { contentAccountId: scope.contentAccountId });
  return { items: rows.slice(0, limit).map(postItem), offset, limit, hasMore: rows.length > limit, postsCollection };
}

/** No scraper, worker enqueue, or provider fallback on any admin content read. */
export async function readAdminContent(scope: AdminContentScope) {
  const postCounts: Record<AdminPostType, number> = { all: 0, photo: 0, video: 0, reel: 0, carousel: 0 };
  if (!scope.access.allowed) return { access: scope.access, viewer: null, postsTotal: 0, postCounts };
  const id = scope.contentAccountId;
  const [snapshots, posts, counts, stories, highlights] = await Promise.all([
    db.select().from(profileSnapshots).where(eq(profileSnapshots.trackedAccountId, id))
      .orderBy(desc(profileSnapshots.snapshotAt), asc(profileSnapshots.id)).limit(1),
    db.select().from(postsCache).where(eq(postsCache.trackedAccountId, id)).orderBy(...postOrder).limit(24),
    db.select({ type: postsCache.postType, total: count(), cachedAt: sql<Date | string>`max(${postsCache.cachedAt})` })
      .from(postsCache).where(eq(postsCache.trackedAccountId, id)).groupBy(postsCache.postType),
    db.select().from(storiesCache).where(and(eq(storiesCache.trackedAccountId, id), gt(storiesCache.expiresAt, new Date())))
      .orderBy(asc(storiesCache.takenAt), asc(storiesCache.storyId)),
    db.select().from(highlightsCache).where(eq(highlightsCache.trackedAccountId, id))
      .orderBy(desc(highlightsCache.cachedAt), asc(highlightsCache.highlightId)),
  ]);
  const items = highlights.length ? await db.select().from(highlightItemsCache)
    .where(inArray(highlightItemsCache.highlightCacheId, highlights.map(row => row.id)))
    .orderBy(asc(highlightItemsCache.takenAt), asc(highlightItemsCache.id)) : [];
  const itemsByHighlight = new Map<string, typeof items>();
  for (const item of items) {
    const group = itemsByHighlight.get(item.highlightCacheId) ?? [];
    group.push(item);
    itemsByHighlight.set(item.highlightCacheId, group);
  }
  for (const row of counts) {
    if (row.type === "photo" || row.type === "video" || row.type === "reel" || row.type === "carousel") postCounts[row.type] = row.total;
    postCounts.all += row.total;
  }
  const snapshot = snapshots[0];
  const account = scope.account;
  const postTimes = counts.map(row => new Date(row.cachedAt).getTime()).filter(Number.isFinite);
  const contentCachedAt = {
    posts: postTimes.length ? new Date(Math.max(...postTimes)).toISOString() : null,
    stories: latestWrite(stories), highlights: latestWrite([...highlights, ...items]),
  };
  const timestamps = [...Object.values(contentCachedAt), snapshot?.snapshotAt.toISOString()].filter((v): v is string => !!v);
  const postsCollection = await readPostsCollectionState(account.id, { contentAccountId: id,
    savedTotal: postCounts.all, latestSavedAt: contentCachedAt.posts, profileSnapshot: snapshot ?? null });
  return {
    access: scope.access, postsTotal: postCounts.all, postCounts,
    viewer: {
      igUsername: account.igUsername, displayName: firstNonemptyString(account.displayName, snapshot?.fullName, account.igUsername),
      profilePicUrl: firstNonemptyString(account.profilePicUrl, snapshot?.profilePicUrl, snapshot?.profilePicUrlHd),
      biography: firstNonemptyString(account.biography, snapshot?.biography),
      isVerified: account.isVerified ?? snapshot?.isVerified ?? false,
      isBusinessAccount: account.isBusinessAccount ?? snapshot?.isBusinessAccount ?? false,
      isPrivate: account.isPrivate, externalUrl: firstNonemptyString(account.externalUrl, snapshot?.externalUrl),
      followerCount: snapshot?.followerCount ?? account.followerCount ?? 0,
      followingCount: snapshot?.followingCount ?? 0, postCount: snapshot?.postCount ?? postCounts.all,
      profileSnapshot: snapshot ? {
        fullName: snapshot.fullName, biography: snapshot.biography,
        profilePicUrl: snapshot.profilePicUrl, profilePicUrlHd: snapshot.profilePicUrlHd,
        externalUrl: snapshot.externalUrl, isVerified: snapshot.isVerified,
        isBusinessAccount: snapshot.isBusinessAccount, isPrivate: snapshot.isPrivate,
        followerCount: snapshot.followerCount, followingCount: snapshot.followingCount,
        postCount: snapshot.postCount, snapshotAt: snapshot.snapshotAt,
      } : null,
      recentPosts: posts.map(postItem),
      postsCollection,
      stories: stories.map(row => ({ storyId: row.storyId, mediaType: row.mediaType, mediaUrl: row.mediaUrl,
        thumbnailUrl: row.thumbnailUrl, takenAt: row.takenAt, expiresAt: row.expiresAt })),
      highlights: highlights.map(row => ({ highlightId: row.highlightId, title: row.title, coverUrl: row.coverUrl,
        mediaCount: row.mediaCount ?? 0, items: (itemsByHighlight.get(row.id) ?? []).map(item => ({
          storyId: item.storyId, mediaType: item.mediaType, mediaUrl: item.mediaUrl,
          thumbnailUrl: item.thumbnailUrl, takenAt: item.takenAt,
        })) })),
      contentCachedAt,
      cachedAt: timestamps.length ? new Date(Math.max(...timestamps.map(value => new Date(value).getTime()))).toISOString() : null,
      dataSource: timestamps.length ? "cached" : "none",
    },
  };
}

export async function readAdminPostEngagement(scope: AdminContentScope, shortcode: string, dimension: "comments" | "likers") {
  const [post] = await db.select().from(postsCache).where(and(
    eq(postsCache.trackedAccountId, scope.contentAccountId), eq(postsCache.shortcode, shortcode),
  )).limit(1);
  if (!post) return null;
  if (dimension === "comments") {
    const [rows, [totals]] = await Promise.all([
      db.select().from(commentsCache).where(eq(commentsCache.postShortcode, shortcode))
        .orderBy(desc(commentsCache.createdAtIg), desc(commentsCache.id)).limit(200),
      db.select({ total: count() }).from(commentsCache).where(eq(commentsCache.postShortcode, shortcode)),
    ]);
    const expectedTotal = Math.max(totals.total, post.commentCount ?? 0);
    return { items: rows.map(row => ({ author: row.authorUsername, displayName: row.authorDisplayName,
      pfpUrl: row.authorPfpUrl, text: row.text, likeCount: row.likeCount, createdAt: row.createdAtIg })),
      total: rows.length, expectedTotal, isPartial: rows.length < expectedTotal };
  }
  const [rows, [totals]] = await Promise.all([
    db.select().from(likersCache).where(eq(likersCache.postShortcode, shortcode))
      .orderBy(desc(likersCache.cachedAt), asc(likersCache.id)).limit(200),
    db.select({ total: count() }).from(likersCache).where(eq(likersCache.postShortcode, shortcode)),
  ]);
  const expectedTotal = Math.max(totals.total, post.likeCount ?? 0);
  return { items: rows.map(row => ({ username: row.likerUsername, displayName: row.likerDisplayName,
    pfpUrl: row.likerPfpUrl, igUserId: row.likerIgUserId, isVerified: row.isVerified, cachedAt: row.cachedAt })),
    total: rows.length, expectedTotal, isPartial: rows.length < expectedTotal };
}

export async function readAdminRoster(scope: AdminContentScope, dimension: RosterDimension, offset: number, limit: number) {
  const id = scope.contentAccountId;
  const filter = and(eq(rosterMembers.trackedAccountId, id), eq(rosterMembers.dimension, dimension), eq(rosterMembers.isCurrent, true));
  const [items, [totals], [snapshot], health] = await Promise.all([
    db.select({ username: rosterMembers.username, displayName: rosterMembers.displayName,
      pfpUrl: rosterMembers.pfpUrl, igUserId: rosterMembers.igUserId }).from(rosterMembers)
      .where(filter).orderBy(desc(rosterMembers.firstSeenAt), asc(rosterMembers.usernameLower)).limit(limit).offset(offset),
    db.select({ total: count() }).from(rosterMembers).where(filter),
    db.select().from(profileSnapshots).where(eq(profileSnapshots.trackedAccountId, id))
      .orderBy(desc(profileSnapshots.snapshotAt), asc(profileSnapshots.id)).limit(1),
    getRosterSyncHealth(id, dimension),
  ]);
  const total = totals.total;
  const expectedTotal = snapshot ? (dimension === "follower" ? snapshot.followerCount : snapshot.followingCount) : null;
  const syncState = expectedTotal === null ? "unknown" : computeRosterSyncState({ loadedTotal: total, reportedTotal: expectedTotal,
    baselineSettled: health.settled, lastGraphRefreshAt: health.lastCompleteReadAt,
    failureKind: health.failureKind, nextRetryAt: health.nextRetryAt });
  return { items, total, expectedTotal, offset, limit, hasMore: offset + items.length < total,
    baselineSettled: health.settled, lastUpdatedAt: health.lastSuccessAt, syncState,
    isPartial: expectedTotal === null || total < expectedTotal || syncState !== "complete", failureKind: health.failureKind, nextRetryAt: health.nextRetryAt };
}

export async function readAdminTrackedActivity(scope: AdminContentScope, offset: number, limit: number) {
  const trackedAccountIds = await twinTrackedAccountIds(scope.account.id);
  const page = await readAdminActivity({ type: "all", search: "", offset, limit, trackedAccountIds,
    canonicalAccountId: scope.contentAccountId });
  // The drilldown already identifies the owner; omit unrelated account data.
  const items = page.items.map(item => {
    const { userId: _userId, userEmail: _userEmail, ...event } = item as Record<string, unknown>;
    return event;
  });
  return { items, total: page.total, offset, limit, hasMore: offset + items.length < page.total };
}
