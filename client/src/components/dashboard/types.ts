export interface ViewerStory {
  trialPreview?: boolean;
  storyId: string;
  mediaType: "photo" | "video" | string;
  mediaUrl: string;
  thumbnailUrl?: string;
  takenAt: string;
  expiresAt: string;
}

export interface ViewerHighlightItem {
  trialPreview?: boolean;
  storyId: string;
  mediaType: "photo" | "video" | string;
  mediaUrl: string;
  thumbnailUrl?: string;
  takenAt: string;
}

export interface ViewerHighlight {
  trialPreview?: boolean;
  highlightId: string;
  title: string;
  coverUrl: string;
  mediaCount: number | null;
  items?: ViewerHighlightItem[];
}

export interface CarouselChild {
  trialPreview?: boolean;
  type: "photo" | "video";
  displayUrl: string;
  videoUrl: string | null;
}

export interface ViewerRecentPost {
  trialPreview?: boolean;
  shortcode: string;
  postType: "photo" | "video" | "reel" | "carousel" | string;
  thumbnailUrl: string;
  displayUrl?: string;
  videoUrl?: string | null;
  caption?: string | null;
  likeCount?: number | null;
  commentCount?: number | null;
  videoViewCount?: number | null;
  takenAt: string;
  isPinned?: boolean;
  carouselMedia?: CarouselChild[] | null;
}

export interface ViewerFollower {
  followerUsername: string;
  followerDisplayName?: string | null;
  followerPfpUrl?: string | null;
  detectedAt: string;
}

/** An account THIS profile unfollowed (following-side diff). */
export interface ViewerUnfollow {
  unfollowedUsername: string;
  /** Enriched from roster_members, which keeps the row after a member leaves. */
  unfollowedDisplayName?: string | null;
  unfollowedPfpUrl?: string | null;
  detectedAt: string;
}

/** A person who unfollowed THIS profile (followers-side diff). */
export interface ViewerFollowerUnfollow {
  unfollowerUsername: string;
  unfollowerDisplayName?: string | null;
  unfollowerPfpUrl?: string | null;
  detectedAt: string;
}

export type ViewerDataSource = "bot" | "apify" | "cached" | "none";

export interface ViewerData {
  trialPreview?: boolean;
  igUsername: string;
  displayName: string;
  profilePicUrl: string;
  followerCount: number;
  followingCount: number;
  postCount: number;
  biography?: string;
  isVerified?: boolean;
  externalUrl?: string;
  isPrivate?: boolean;
  topNiche: string | null;
  peakActivityHour: number | null;
  recentLikes: Array<{
    postId: string;
    ownerUsername: string;
    postType: string;
    thumbnailUrl: string;
    postUrl: string;
    hashtags: string[];
    likesCount?: number | null;
    commentsCount?: number | null;
    videoViewCount?: number | null;
    /** When the POST was published; null for rows captured before migration 0030. */
    postTakenAt?: string | null;
    /** When we INFERRED the like. Not the post's date — never sort by this. */
    detectedAt: string;
  }>;
  recentFollows: Array<{
    followedUsername: string;
    followedDisplayName: string;
    detectedAt: string;
  }>;
  activityByHour: Array<{ hour: number; count: number }>;
  weeklyStats: {
    totalLikes: number | null;
    totalFollows: number | null;
    totalUnfollows: number | null;
    totalPosts?: number | null;
  };

  // Wave-2-D extensions (optional — server may not populate immediately)
  stories?: ViewerStory[];
  highlights?: ViewerHighlight[];
  recentPosts?: ViewerRecentPost[];
  postsTotal?: number;
  postCounts?: Partial<Record<PostTypeFilter, number>>;
  postsCollection?: import("../../../../shared/posts-collection-state").PostsCollectionState;
  recentFollowers?: ViewerFollower[];
  recentFollowerUnfollows?: ViewerFollowerUnfollow[];
  recentUnfollows?: ViewerUnfollow[];
  rosterStatus?: {
    followers?: {
      background?: import("../../../../shared/roster-background").BackgroundRosterView | null;
      loadedTotal: number;
      expectedTotal: number;
      completionPct: number | null;
      isPartial: boolean;
      syncState?: "complete" | "capped" | "syncing" | "restricted";
      lastUpdatedAt?: string | null;
      failureKind?: string | null;
      lastAttemptAt?: string | null;
      lastSuccessfulAt?: string | null;
      lastCompleteReadAt?: string | null;
      nextRetryAt?: string | null;
      unfollowDetectionTrusted?: boolean;
    };
    following?: {
      background?: import("../../../../shared/roster-background").BackgroundRosterView | null;
      loadedTotal: number;
      expectedTotal: number;
      completionPct: number | null;
      isPartial: boolean;
      syncState?: "complete" | "capped" | "syncing" | "restricted";
      lastUpdatedAt?: string | null;
      failureKind?: string | null;
      lastAttemptAt?: string | null;
      lastSuccessfulAt?: string | null;
      lastCompleteReadAt?: string | null;
      nextRetryAt?: string | null;
      unfollowDetectionTrusted?: boolean;
    };
  };
  activityByDate?: Array<{ date: string; count: number }>;
  dataSource?: ViewerDataSource;
  cachedAt?: string;
  contentCachedAt?: { posts: string | null; stories: string | null; highlights: string | null };
}

export type PostTypeFilter = "all" | "photo" | "video" | "reel" | "carousel";

export interface ActivityEvent {
  trialPreview?: boolean;
  id: string;
  eventType: "like" | "follow" | "unfollow";
  /** When WE detected it. For "how recent is this post", use postTakenAt. */
  detectedAt: string;
  /** Publish time of the liked post; null/absent for pre-0030 rows. */
  postTakenAt?: string | null;
  // like event fields
  postId?: string;
  ownerUsername?: string;
  postType?: string;
  postUrl?: string;
  thumbnailUrl?: string;
  displayUrl?: string | null;
  caption?: string | null;
  hashtags?: string[];
  // engagement metrics
  likesCount?: number | null;
  commentsCount?: number | null;
  videoViewCount?: number | null;
  locationName?: string;
  // follow event fields
  followedUsername?: string;
  followedDisplayName?: string;
  // unfollow event fields
  unfollowedUsername?: string;
}
