// ─── IGClientPort — Domain port for Instagram access ─────────────────────────
//
// Wave 2: this file is the public contract used by bot-collectors and any
// other business-logic layer that needs to read/write to Instagram. The
// concrete HTTP/2 implementation lives in server/ig-http-client.ts. Any
// future transport (official API, proxy pool, mock in tests) only has to
// satisfy IGClientFactory.
//
// These are DOMAIN shapes — not raw IG JSON. The transport layer is
// responsible for validating + translating IG's actual JSON (see
// server/domain/ig-schemas.ts) into these types.
// ─────────────────────────────────────────────────────────────────────────────

// ── Domain types ────────────────────────────────────────────────────────────

export interface IGProfilePostPreview {
  shortcode: string;
  id: string;
  isVideo: boolean;
  likeCount: number;
  commentCount: number;
  caption: string | null;
  takenAtTimestamp: number;
  thumbnailUrl: string | null;
}

export interface IGProfile {
  pk: string;
  username: string;
  fullName: string | null;
  biography: string | null;
  isPrivate: boolean;
  isVerified: boolean;
  followerCount: number;
  followingCount: number;
  postCount: number;
  profilePicUrl: string | null;
  externalUrl: string | null;
  followedByViewer: boolean;
  requestedByViewer: boolean;
  /** True only when the provider explicitly supplied its relationship flag. */
  viewerRelationshipKnown?: boolean;
  posts: IGProfilePostPreview[];
}

export interface IGFeedItem {
  id: string;
  code: string;
  takenAt: number;
  likeCount: number;
  commentCount: number;
  caption: string | null;
  mediaType: number;
  // Wave 3b (Agent B): additive fields for the public-data scraper. All are
  // nullable so callers that only cared about the basic shape are unaffected.
  productType: string | null;
  thumbnailUrl: string | null;
  displayUrl: string | null;
  videoUrl: string | null;
  videoViewCount: number | null;
  locationName: string | null;
  // Instagram-posts features (additive): ordered carousel children for
  // sidecar posts (media_type=8) and the profile-pinned signal. Both are
  // safe defaults for single-media / non-pinned posts (null / []).
  carouselMedia: Array<{
    mediaId?: string;
    type: "photo" | "video";
    displayUrl: string;
    videoUrl: string | null;
  }> | null;
  pinnedUserIds: number[];
}

export interface IGFeedPage {
  items: IGFeedItem[];
  nextMaxId: string | null;
  moreAvailable: boolean;
  numResults: number;
}

export interface IGFriendshipUser {
  pk: string;
  username: string;
  fullName: string | null;
  isPrivate: boolean;
  isVerified: boolean;
  profilePicUrl: string | null;
}

export interface IGFriendshipPage {
  users: IGFriendshipUser[];
  nextMaxId: string | null;
  bigList: boolean;
  /**
   * Instagram returned a `special_empty_state` with zero users — its
   * anti-scraping "we limit certain things you can see, like another person's
   * follower/following lists" response. This is NOT a genuinely empty list; the
   * viewing bot is being throttled. Callers MUST NOT treat a restricted page as
   * a complete 0-member read (which would settle the roster at 0 and show the
   * account as following nobody). @tracked_user_1 (public, 1,405 following) hit this.
   */
  restricted: boolean;
  /** A visible prefix explicitly limited by IG; sightings are usable, absence is not. */
  limitedPreview?: boolean;
}

export interface IGFriendshipStatus {
  following: boolean;
  outgoingRequest: boolean;
  incomingRequest: boolean;
  followedBy: boolean;
  isPrivate: boolean;
}

// ── Wave 3b: stories + highlights domain types (Agent B) ────────────────────

export interface IGReelItem {
  readonly id: string;
  readonly mediaType: number; // 1=photo, 2=video
  readonly imageUrl: string | null;
  readonly thumbnailUrl: string | null;
  readonly videoUrl: string | null;
  readonly takenAt: number;
  readonly expiringAt: number;
}

export interface IGStoriesTray {
  readonly items: ReadonlyArray<IGReelItem>;
}

export interface IGHighlightTrayItem {
  readonly id: string; // IG returns e.g. "highlight:12345"; domain keeps as-is
  readonly title: string;
  readonly coverUrl: string | null;
  readonly mediaCount: number;
}

export interface IGHighlightsTray {
  readonly items: ReadonlyArray<IGHighlightTrayItem>;
}

export interface IGHighlightReel {
  readonly id: string; // "highlight:12345"
  readonly items: ReadonlyArray<IGReelItem>;
}

// ── Wave 5: media comments ──────────────────────────────────────────────────

export interface IGCommentDomain {
  readonly pk: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly pfpUrl: string | null;
  readonly text: string;
  readonly likeCount: number;
  /** Unix seconds since epoch. */
  readonly createdAt: number;
}

export interface IGCommentsPageDomain {
  readonly comments: ReadonlyArray<IGCommentDomain>;
  readonly nextMaxId: string | null;
  readonly totalCount: number;
  readonly hasMore: boolean;
}

// Convenience re-exports under the names used in scraper / persistence.
// IGCommentsPage in ig-schemas.ts has the identical shape (zod-derived).
export type IGComment = IGCommentDomain;
export type IGCommentsPage = IGCommentsPageDomain;

// ── Wave 5: media likers ────────────────────────────────────────────────────
//
// /api/v1/media/<media_id>/likers/ returns up to ~100 users plus a
// `user_count` field. There is no pagination cursor, so the domain shape is
// flat: a single page with the live total IG reports for the post.

export interface IGUser {
  readonly pk: string;
  readonly username: string;
  readonly fullName: string | null;
  readonly profilePicUrl: string | null;
  readonly isVerified: boolean;
  readonly isPrivate: boolean;
}

export interface IGLikersPage {
  readonly users: ReadonlyArray<IGUser>;
  readonly totalCount: number;
}

// ── Port interface ──────────────────────────────────────────────────────────

export interface IGClientPort {
  /** Internal transport handoff only. Contains secrets; never expose in APIs/logs. */
  exportSessionData?(): string;
  fetchProfile(username: string): Promise<IGProfile>;
  // OPTIONAL mobile-API profile fallback: GET /api/v1/users/<id>/info/. Hits a
  // different rate-limit bucket than web_profile_info and only needs the numeric
  // user id. Only the HTTP transport implements it; the browser/playwright
  // clients need not, so it is optional and callers must feature-detect / assert
  // before use.
  fetchProfileById?(userId: string): Promise<IGProfile>;
  fetchUserFeed(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFeedPage>;
  // Wave 4: dedicated Reels-tab + Tagged-tab readers. Both return the same
  // IGFeedPage shape — items map cleanly onto posts_cache rows with
  // post_type=reel or post_type=tagged_post.
  fetchUserClips(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFeedPage>;
  fetchUserTagged(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFeedPage>;
  fetchFollowing(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFriendshipPage>;
  fetchFollowers(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFriendshipPage>;
  sendFollow(targetPk: string): Promise<IGFriendshipStatus>;
  /** Read the current bot-to-target relationship before sending a follow. */
  fetchFriendshipStatus?(targetPk: string): Promise<IGFriendshipStatus>;
  // Wave 3b: stories + highlights
  fetchStoriesTray(pk: string): Promise<IGStoriesTray>;
  fetchHighlightsTray(pk: string): Promise<IGHighlightsTray>;
  fetchHighlightReels(
    highlightIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<IGHighlightReel>>;
  // Wave 5: media comments. mediaId is IG's numeric `pk` (not the shortcode);
  // pagination via `nextMaxId` returned in the previous page.
  fetchMediaComments(
    mediaId: string,
    maxId?: string,
  ): Promise<IGCommentsPageDomain>;
  // Wave 5: media likers. Single-page endpoint capped at ~100 users; we
  // surface the count IG reports so the caller can show "x of N" if desired.
  fetchMediaLikers(mediaId: string): Promise<IGLikersPage>;
  // Wave 9 (OPTIONAL): raw authenticated request to any IG path, returning
  // parsed JSON. Only the browser read-transport implements this today — it is
  // the browser-fallback lane for the liked-by harvester's home/reels feed
  // polling. The composite http-first read client does NOT implement it (the
  // harvester talks to the legacy HTTP IGClient.fetchRaw directly), so this is
  // optional and callers must feature-detect before use.
  fetchRaw?(
    path: string,
    init?: { method?: "GET" | "POST"; body?: string },
  ): Promise<unknown>;
  close(): Promise<void>;
}

// Factory receives already-decrypted plaintext session data. Crypto is
// handled one layer up (bot-collectors / bot-manager) so the transport has
// zero knowledge of encryption keys.
export type IGClientFactory = (sessionData: string) => Promise<IGClientPort>;

// ── Error re-exports (ports speak these) ────────────────────────────────────

export class IGSchemaError extends Error {
  readonly endpoint: string;
  constructor(endpoint: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IGSchemaError";
    this.endpoint = endpoint;
  }
}

export class IGCircuitOpenError extends Error {
  readonly openUntil: number;
  constructor(openUntil: number, message = "IG circuit breaker is OPEN") {
    super(message);
    this.name = "IGCircuitOpenError";
    this.openUntil = openUntil;
  }
}
