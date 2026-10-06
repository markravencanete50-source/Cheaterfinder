// ─── Zod validation for IG endpoint responses ───────────────────────────────
//
// Wave 2: replaces the hand-rolled asRecord / asString / asNumber defender
// chain in ig-http-client.ts. Each endpoint has one schema + one parse()
// helper. parse() returns a DOMAIN type from ig-client-port.ts, and throws
// IGSchemaError on any mismatch so the circuit breaker can count it as a
// failure.
//
// Design notes:
// - Schemas are permissive on fields IG occasionally omits (use .optional()
//   or nullable). This keeps us resilient to minor shape drift.
// - But structural roots (user object, items array) are strict so a major
//   breaking change is detected immediately.
// - Unknown extra fields are ignored (zod default) — they will never corrupt
//   our domain rows.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import {
  IGSchemaError,
  type IGFeedPage,
  type IGFriendshipPage,
  type IGFriendshipStatus,
  type IGLikersPage,
  type IGProfile,
  type IGProfilePostPreview,
  type IGUser,
} from "./ig-client-port.js";

// ── Primitive coercers ──────────────────────────────────────────────────────

const looseNum = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? v : Number(v)))
  .pipe(z.number().finite())
  .catch(0);

const optionalString = z.string().nullable().optional();
const optionalBool = z.boolean().optional();

// Id-like fields (pk, id, pk_id). The WEB API returns these as strings; the
// MOBILE API (i.instagram.com, ig-mobile-read-client) returns them as int64
// NUMBERS. Accept either and normalize to a string so downstream code (which
// treats ids as strings) is transport-agnostic. String inputs pass through
// unchanged, so this is backward-compatible with the web path.
const optionalId = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined ? v : String(v)));

// ── Parse-failure counter (simple in-memory) ───────────────────────────────

let parseFailureCounter = 0;
export function getParseFailureCount(): number {
  return parseFailureCounter;
}
export function resetParseFailureCount(): void {
  parseFailureCounter = 0;
}

function fail(endpoint: string, issues: z.ZodIssue[]): never {
  parseFailureCounter += 1;
  const detail = issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  throw new IGSchemaError(
    endpoint,
    `[ig-schema] ${endpoint} response failed validation: ${detail}`,
  );
}

const SuccessfulEnvelopeSchema = z.object({
  status: z.literal("ok").nullable().optional(),
  success: z.literal(true).optional(),
  errors: z.array(z.unknown()).max(0).nullable().optional(),
});

function assertSuccessfulEnvelope(raw: unknown, endpoint: string): void {
  const result = SuccessfulEnvelopeSchema.safeParse(raw);
  if (!result.success) fail(endpoint, result.error.issues);
}

// ── Profile (web_profile_info) ──────────────────────────────────────────────

const CaptionNodeSchema = z.object({
  node: z.object({ text: optionalString }).partial(),
});

const TimelineEdgeSchema = z.object({
  node: z
    .object({
      shortcode: optionalString,
      id: optionalId,
      is_video: optionalBool,
      edge_liked_by: z.object({ count: looseNum }).partial().optional(),
      edge_media_to_comment: z.object({ count: looseNum }).partial().optional(),
      edge_media_to_caption: z
        .object({ edges: z.array(CaptionNodeSchema).optional() })
        .partial()
        .optional(),
      taken_at_timestamp: looseNum.optional(),
      thumbnail_src: optionalString,
      display_url: optionalString,
    })
    .partial(),
});

const UserObjectSchema = z
  .object({
    id: optionalId,
    username: optionalString,
    full_name: optionalString,
    biography: optionalString,
    external_url: optionalString,
    external_url_linkshimmed: optionalString,
    bio_links: z
      .array(
        z
          .object({
            url: optionalString,
            lynx_url: optionalString,
            title: optionalString,
          })
          .partial()
          .passthrough(),
      )
      .optional(),
    is_private: optionalBool,
    is_verified: optionalBool,
    edge_followed_by: z.object({ count: looseNum }).partial().optional(),
    edge_follow: z.object({ count: looseNum }).partial().optional(),
    edge_owner_to_timeline_media: z
      .object({
        count: looseNum.optional(),
        edges: z.array(TimelineEdgeSchema).optional(),
      })
      .partial()
      .optional(),
    profile_pic_url: optionalString,
    profile_pic_url_hd: optionalString,
    followed_by_viewer: optionalBool,
    requested_by_viewer: optionalBool,
  })
  .passthrough();

const ProfileResponseSchema = z.object({
  data: z.object({ user: UserObjectSchema.nullable() }).passthrough(),
});

export function parseProfileResponse(raw: unknown): IGProfile {
  assertSuccessfulEnvelope(raw, "web_profile_info");
  const result = ProfileResponseSchema.safeParse(raw);
  if (!result.success) fail("web_profile_info", result.error.issues);

  const user = result.data.data.user;
  if (!user || (!user.id && !user.username)) {
    fail("web_profile_info", [
      { path: ["data", "user"], message: "missing user", code: "custom" } as z.ZodIssue,
    ]);
  }

  const edges = user!.edge_owner_to_timeline_media?.edges ?? [];
  // IG commonly returns external_url: "" (and occasionally whitespace) when a
  // profile has no link button but does carry entries in bio_links. The schema
  // preserves "" verbatim, so a raw `??` chain would short-circuit on the empty
  // string and never reach the bio_links fallback. Normalise empty/whitespace
  // candidates to undefined so the chain falls through, and resolve to null
  // (never "") so persistence stores a clean absence.
  const cleanUrl = (value: string | null | undefined): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const firstBioLink = user!.bio_links?.find(
    (link) => cleanUrl(link?.url) || cleanUrl(link?.lynx_url),
  );
  const externalUrl =
    cleanUrl(user!.external_url) ??
    cleanUrl(firstBioLink?.url) ??
    cleanUrl(user!.external_url_linkshimmed) ??
    cleanUrl(firstBioLink?.lynx_url) ??
    null;
  const posts: IGProfilePostPreview[] = edges.map((e) => {
    const n = e.node ?? {};
    const captionEdges = n.edge_media_to_caption?.edges ?? [];
    const firstCaption = captionEdges[0]?.node?.text ?? null;
    return {
      shortcode: n.shortcode ?? "",
      id: n.id ?? "",
      isVideo: n.is_video ?? false,
      likeCount: n.edge_liked_by?.count ?? 0,
      commentCount: n.edge_media_to_comment?.count ?? 0,
      caption: firstCaption,
      takenAtTimestamp: n.taken_at_timestamp ?? 0,
      thumbnailUrl: n.thumbnail_src ?? n.display_url ?? null,
    };
  });

  return {
    pk: user!.id ?? "",
    username: user!.username ?? "",
    fullName: user!.full_name ?? null,
    biography: user!.biography ?? null,
    isPrivate: user!.is_private ?? false,
    isVerified: user!.is_verified ?? false,
    followerCount: user!.edge_followed_by?.count ?? 0,
    followingCount: user!.edge_follow?.count ?? 0,
    postCount: user!.edge_owner_to_timeline_media?.count ?? 0,
    profilePicUrl: user!.profile_pic_url_hd ?? user!.profile_pic_url ?? null,
    externalUrl,
    followedByViewer: user!.followed_by_viewer ?? false,
    requestedByViewer: user!.requested_by_viewer ?? false,
    viewerRelationshipKnown: typeof user!.followed_by_viewer === "boolean",
    posts,
  };
}

// ── Profile (mobile /api/v1/users/<id>/info/) ────────────────────────────────
//
// The mobile-app profile endpoint returns a FLAT user object — follower_count,
// following_count, media_count as plain numbers — rather than the web
// web_profile_info edge_* graph. It lives in a different rate-limit bucket than
// web_profile_info, so it backs the cheap HTTP profile fallback in
// public-data-service when the numeric user id is already cached. There is no
// timeline media on this endpoint, so posts is always []. Schema is as
// permissive as the web profile schema; the structural requirement is only that
// pk/pk_id or username is present.

const ProfileInfoUserSchema = z
  .object({
    pk: z.union([z.string(), z.number()]).nullable().optional(),
    pk_id: z.union([z.string(), z.number()]).nullable().optional(),
    username: optionalString,
    full_name: optionalString,
    biography: optionalString,
    external_url: optionalString,
    bio_links: z
      .array(
        z
          .object({ url: optionalString, lynx_url: optionalString })
          .partial()
          .passthrough(),
      )
      .optional(),
    is_private: optionalBool,
    is_verified: optionalBool,
    follower_count: looseNum.optional(),
    following_count: looseNum.optional(),
    media_count: looseNum.optional(),
    profile_pic_url: optionalString,
    profile_pic_url_hd: optionalString,
    hd_profile_pic_url_info: z
      .object({ url: optionalString })
      .partial()
      .passthrough()
      .nullable()
      .optional(),
    friendship_status: z
      .object({
        following: optionalBool,
        outgoing_request: optionalBool,
      })
      .partial()
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const ProfileInfoResponseSchema = z
  .object({
    status: optionalString,
    user: ProfileInfoUserSchema.nullable().optional(),
  })
  .passthrough();

export function parseProfileInfoResponse(raw: unknown): IGProfile {
  assertSuccessfulEnvelope(raw, "users/info");
  const result = ProfileInfoResponseSchema.safeParse(raw);
  if (!result.success) fail("users/info", result.error.issues);

  const user = result.data.user;
  const pkRaw = user?.pk ?? user?.pk_id ?? null;
  const pk = pkRaw == null ? "" : String(pkRaw);
  if (!user || (!pk && !user.username)) {
    fail("users/info", [
      { path: ["user"], message: "missing user", code: "custom" } as z.ZodIssue,
    ]);
  }

  // Reuse the same empty/whitespace → undefined normalisation as
  // parseProfileResponse so the bio_links fallback still fires when IG returns
  // external_url: "". Resolve to null (never "") for a clean persisted absence.
  const cleanUrl = (value: string | null | undefined): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const firstBioLink = user!.bio_links?.find(
    (link) => cleanUrl(link?.url) || cleanUrl(link?.lynx_url),
  );
  const externalUrl =
    cleanUrl(user!.external_url) ??
    cleanUrl(firstBioLink?.url) ??
    cleanUrl(firstBioLink?.lynx_url) ??
    null;

  const profilePicUrl =
    user!.profile_pic_url_hd ??
    user!.hd_profile_pic_url_info?.url ??
    user!.profile_pic_url ??
    null;

  return {
    pk,
    username: user!.username ?? "",
    fullName: user!.full_name ?? null,
    biography: user!.biography ?? null,
    isPrivate: user!.is_private ?? false,
    isVerified: user!.is_verified ?? false,
    followerCount: user!.follower_count ?? 0,
    followingCount: user!.following_count ?? 0,
    postCount: user!.media_count ?? 0,
    profilePicUrl,
    externalUrl,
    followedByViewer: user!.friendship_status?.following ?? false,
    requestedByViewer: user!.friendship_status?.outgoing_request ?? false,
    viewerRelationshipKnown: typeof user!.friendship_status?.following === "boolean",
    posts: [],
  };
}

// ── User feed ──────────────────────────────────────────────────────────────

const FeedImageCandidateSchema = z
  .object({
    url: optionalString,
    width: looseNum.optional(),
    height: looseNum.optional(),
  })
  .passthrough();

const FeedImageVersionsSchema = z
  .object({ candidates: z.array(FeedImageCandidateSchema).optional() })
  .partial()
  .passthrough();

const FeedVideoVersionSchema = z
  .object({ url: optionalString, type: looseNum.optional() })
  .passthrough();

const FeedLocationSchema = z
  .object({ name: optionalString })
  .partial()
  .passthrough();

// Carousel (sidecar) child media. Each child carries its own media_type plus
// the same image_versions2 / video_versions shape as a top-level feed item, so
// we reuse those schemas for candidate / video selection.
const FeedCarouselChildSchema = z
  .object({
    id: optionalId,
    pk: optionalId,
    media_type: looseNum.optional(),
    image_versions2: FeedImageVersionsSchema.nullable().optional(),
    video_versions: z.array(FeedVideoVersionSchema).nullable().optional(),
  })
  .passthrough();

const FeedItemSchema = z
  .object({
    id: optionalId,
    pk: optionalId,
    code: optionalString,
    taken_at: looseNum.optional(),
    like_count: looseNum.optional(),
    comment_count: looseNum.optional(),
    caption: z.object({ text: optionalString }).partial().nullable().optional(),
    media_type: looseNum.optional(),
    product_type: optionalString,
    image_versions2: FeedImageVersionsSchema.nullable().optional(),
    video_versions: z.array(FeedVideoVersionSchema).nullable().optional(),
    view_count: looseNum.optional(),
    play_count: looseNum.optional(),
    location: FeedLocationSchema.nullable().optional(),
    // Carousel children (media_type=8 posts only) and the profile-pinned
    // signal. Both optional so non-carousel / non-pinned items still parse.
    carousel_media: z.array(FeedCarouselChildSchema).nullable().optional(),
    timeline_pinned_user_ids: z.array(looseNum).nullable().optional(),
  })
  .passthrough();

const FeedPageSchema = z
  .object({
    items: z.array(FeedItemSchema),
    next_max_id: optionalString,
    more_available: optionalBool,
    num_results: looseNum.optional(),
  })
  .passthrough();

// Pick the first non-empty candidate URL from an image_versions2 block (the
// "best" image — IG sorts candidates highest-resolution first).
function bestImageUrl(
  imageVersions:
    | z.infer<typeof FeedImageVersionsSchema>
    | null
    | undefined,
): string | null {
  const candidates = imageVersions?.candidates ?? [];
  const best = candidates.find((c) => typeof c.url === "string" && c.url);
  return best?.url ?? null;
}

// Pick the first non-empty video URL from a video_versions array.
function bestVideoUrl(
  videoVersions:
    | Array<z.infer<typeof FeedVideoVersionSchema>>
    | null
    | undefined,
): string | null {
  const versions = videoVersions ?? [];
  const best = versions.find((v) => typeof v.url === "string" && v.url);
  return best?.url ?? null;
}

export function parseFeedResponse(raw: unknown): IGFeedPage {
  assertSuccessfulEnvelope(raw, "feed/user");
  const result = FeedPageSchema.safeParse(raw);
  if (!result.success) fail("feed/user", result.error.issues);
  const { items = [], next_max_id, more_available, num_results } = result.data;
  const parsed = items.map((it) => {
    const candidates = it.image_versions2?.candidates ?? [];
    const bestImage = candidates.find(
      (c) => typeof c.url === "string" && c.url,
    );
    const thumbCandidate =
      candidates.length > 0 ? candidates[candidates.length - 1] : null;
    const videoVersions = it.video_versions ?? [];
    const bestVideo = videoVersions.find(
      (v) => typeof v.url === "string" && v.url,
    );
    // Carousel children → ordered domain children, reusing the same
    // best-candidate / best-video selection. Drop children that resolved to
    // neither an image nor a video URL; null out an empty/absent carousel.
    const carouselChildren = (it.carousel_media ?? [])
      .map((child) => ({
        ...(child.id || child.pk ? { mediaId: (child.id || child.pk)! } : {}),
        type: (child.media_type === 2 ? "video" : "photo") as
          | "photo"
          | "video",
        displayUrl: bestImageUrl(child.image_versions2) ?? "",
        videoUrl: bestVideoUrl(child.video_versions),
      }))
      .filter((child) => child.displayUrl !== "" || child.videoUrl !== null);
    const carouselMedia = carouselChildren.length > 0 ? carouselChildren : null;
    const pinnedUserIds = (it.timeline_pinned_user_ids ?? []).map((v) =>
      Number(v),
    );
    const viewCount =
      typeof it.view_count === "number"
        ? it.view_count
        : typeof it.play_count === "number"
          ? it.play_count
          : null;
    return {
      id: it.id ?? it.pk ?? "",
      code: it.code ?? "",
      takenAt: it.taken_at ?? 0,
      likeCount: it.like_count ?? 0,
      commentCount: it.comment_count ?? 0,
      caption: it.caption?.text ?? null,
      mediaType: it.media_type ?? 0,
      productType: it.product_type ?? null,
      thumbnailUrl: thumbCandidate?.url ?? bestImage?.url ?? null,
      displayUrl: bestImage?.url ?? null,
      videoUrl: bestVideo?.url ?? null,
      videoViewCount: viewCount,
      locationName: it.location?.name ?? null,
      carouselMedia,
      pinnedUserIds,
    };
  });
  return {
    items: parsed,
    nextMaxId: next_max_id ?? null,
    moreAvailable: more_available ?? false,
    numResults: num_results ?? parsed.length,
  };
}

// ── Clips (Reels-tab) feed ─────────────────────────────────────────────────
//
// IG returns the clips-tab payload as { items: [{ media: {...} }], paging_info,
// next_max_id }. The inner `media` shape matches the regular feed-item shape,
// so we lift it out and fall back to parseFeedResponse.

const ClipsPageSchema = z
  .object({
    items: z
      .array(
        z
          .object({ media: FeedItemSchema })
          .passthrough(),
      ),
    paging_info: z
      .object({
        max_id: optionalString,
        more_available: optionalBool,
      })
      .optional(),
    next_max_id: optionalString,
    num_results: looseNum.optional(),
  })
  .passthrough();

export function parseClipsResponse(raw: unknown): IGFeedPage {
  assertSuccessfulEnvelope(raw, "clips/user");
  const result = ClipsPageSchema.safeParse(raw);
  if (!result.success) fail("clips/user", result.error.issues);
  const items = (result.data.items ?? [])
    .map((wrapper) => wrapper.media)
    .filter((m): m is z.infer<typeof FeedItemSchema> => m !== undefined);
  return parseFeedResponse({
    items,
    next_max_id:
      result.data.paging_info?.max_id ?? result.data.next_max_id ?? null,
    more_available: result.data.paging_info?.more_available ?? false,
    num_results: result.data.num_results ?? items.length,
  });
}

// ── Friendships list (followers/following) ─────────────────────────────────

const FriendshipUserSchema = z
  .object({
    pk: optionalId,
    pk_id: optionalId,
    id: optionalId,
    username: optionalString,
    full_name: optionalString,
    is_private: optionalBool,
    is_verified: optionalBool,
    profile_pic_url: optionalString,
  })
  .passthrough();

const FriendshipPageSchema = z
  .object({
    users: z.array(FriendshipUserSchema),
    next_max_id: optionalString,
    big_list: optionalBool,
    // IG can return a small, populated preview while explicitly hiding the
    // full list. Non-empty users do not make that a complete enumeration.
    should_limit_list_of_followers: optionalBool,
    // Present (an object with title/body) when IG withholds the list from the
    // viewing bot — see IGFriendshipPage.restricted.
    special_empty_state: z.unknown().optional(),
  })
  .passthrough();

export function parseFriendshipPageResponse(raw: unknown): IGFriendshipPage {
  assertSuccessfulEnvelope(raw, "friendships/list");
  const result = FriendshipPageSchema.safeParse(raw);
  if (!result.success) fail("friendships/list", result.error.issues);
  const { users = [], next_max_id, big_list, special_empty_state, should_limit_list_of_followers } = result.data;
  return {
    users: users.map((u) => ({
      pk: u.pk ?? u.pk_id ?? u.id ?? "",
      username: u.username ?? "",
      fullName: u.full_name ?? null,
      isPrivate: u.is_private ?? false,
      isVerified: u.is_verified ?? false,
      profilePicUrl: u.profile_pic_url ?? null,
    })),
    nextMaxId: next_max_id ?? null,
    bigList: big_list ?? false,
    // IG withheld the list (special_empty_state) — not a real empty page.
    restricted: should_limit_list_of_followers === true || (users.length === 0 && special_empty_state != null),
    ...(should_limit_list_of_followers === true ? { limitedPreview: true } : {}),
  };
}

// Instagram's REST friendship endpoint can deliberately return
// `special_empty_state` for an otherwise public profile. The authenticated
// web GraphQL connections use a separate read surface and, for those same
// profiles, still return the real paginated roster. Keep this parser separate
// from the REST shape so a GraphQL contract change fails closed instead of
// being mistaken for an empty/complete list.
const GraphqlFriendshipNodeSchema = z
  .object({
    id: optionalId,
    username: optionalString,
    full_name: optionalString,
    is_private: optionalBool,
    is_verified: optionalBool,
    profile_pic_url: optionalString,
  })
  .passthrough();

const GraphqlFriendshipConnectionSchema = z
  .object({
    edges: z
      .array(
        z
          .object({ node: GraphqlFriendshipNodeSchema })
          .passthrough(),
      ),
    page_info: z
      .object({
        has_next_page: optionalBool,
        end_cursor: optionalString,
      })
      .passthrough(),
  })
  .passthrough();

const GraphqlFriendshipResponseSchema = z
  .object({
    data: z
      .object({
        user: z
          .object({
            edge_followed_by: GraphqlFriendshipConnectionSchema.optional(),
            edge_follow: GraphqlFriendshipConnectionSchema.optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export function parseGraphqlFriendshipPageResponse(
  raw: unknown,
  dimension: "followers" | "following",
): IGFriendshipPage {
  assertSuccessfulEnvelope(raw, `graphql/${dimension}`);
  const result = GraphqlFriendshipResponseSchema.safeParse(raw);
  if (!result.success) fail(`graphql/${dimension}`, result.error.issues);

  const connection =
    dimension === "followers"
      ? result.data.data.user.edge_followed_by
      : result.data.data.user.edge_follow;
  const parsedConnection = GraphqlFriendshipConnectionSchema.safeParse(connection);
  if (!parsedConnection.success) {
    fail(`graphql/${dimension}`, parsedConnection.error.issues);
  }

  const { edges = [], page_info: pageInfo } = parsedConnection.data;
  return {
    users: edges.map(({ node }) => ({
      pk: node.id ?? "",
      username: node.username ?? "",
      fullName: node.full_name ?? null,
      isPrivate: node.is_private ?? false,
      isVerified: node.is_verified ?? false,
      profilePicUrl: node.profile_pic_url ?? null,
    })),
    nextMaxId:
      pageInfo.has_next_page && pageInfo.end_cursor
        ? pageInfo.end_cursor
        : null,
    bigList: pageInfo.has_next_page ?? false,
    restricted: false,
  };
}

// ── Media comments ─────────────────────────────────────────────────────────
//
// Wave 5: /api/v1/media/<media_id>/comments/ — used by the comments scraper
// to surface actual comment text/author/likes for a post. Pagination via
// `next_max_id`; `has_more_comments` is the explicit "keep walking" flag.
//
// IG has shipped two slightly different shapes for the user object on a
// comment over the years; we accept both `pk` and `pk_id`, and keep
// `full_name` / `profile_pic_url` optional to avoid hard-failing if IG drops
// fields on a major release.

export interface IGComment {
  readonly pk: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly pfpUrl: string | null;
  readonly text: string;
  readonly likeCount: number;
  readonly createdAt: number; // unix seconds
}

export interface IGCommentsPage {
  readonly comments: ReadonlyArray<IGComment>;
  readonly nextMaxId: string | null;
  readonly totalCount: number;
  readonly hasMore: boolean;
}

const CommentUserSchema = z
  .object({
    pk: z.union([z.string(), z.number()]).nullable().optional(),
    pk_id: z.union([z.string(), z.number()]).nullable().optional(),
    id: z.union([z.string(), z.number()]).nullable().optional(),
    username: optionalString,
    full_name: optionalString,
    profile_pic_url: optionalString,
  })
  .passthrough();

const CommentItemSchema = z
  .object({
    pk: z.union([z.string(), z.number()]).optional(),
    text: optionalString,
    user: CommentUserSchema.optional(),
    comment_like_count: looseNum.optional(),
    created_at: looseNum.optional(),
    created_at_utc: looseNum.optional(),
  })
  .passthrough();

const CommentsResponseSchema = z
  .object({
    comments: z.array(CommentItemSchema),
    next_max_id: z.union([z.string(), z.number()]).nullable().optional(),
    comment_count: looseNum.optional(),
    has_more_comments: optionalBool,
  })
  .passthrough();

export function parseCommentsResponse(raw: unknown): IGCommentsPage {
  assertSuccessfulEnvelope(raw, "media/comments");
  const result = CommentsResponseSchema.safeParse(raw);
  if (!result.success) fail("media/comments", result.error.issues);

  const items = result.data.comments ?? [];
  const comments: IGComment[] = items.map((c) => {
    const user = c.user ?? {};
    const pk =
      typeof c.pk === "number" ? String(c.pk) : c.pk ?? "";
    const rawUserPk = user.pk ?? user.pk_id ?? user.id ?? "";
    const userPk = typeof rawUserPk === "number" ? String(rawUserPk) : rawUserPk;
    return {
      pk: pk || userPk,
      username: user.username ?? "",
      displayName: user.full_name ?? null,
      pfpUrl: user.profile_pic_url ?? null,
      text: c.text ?? "",
      likeCount: c.comment_like_count ?? 0,
      createdAt: c.created_at ?? c.created_at_utc ?? 0,
    };
  });

  const nextMaxIdRaw = result.data.next_max_id;
  const nextMaxId =
    nextMaxIdRaw == null
      ? null
      : typeof nextMaxIdRaw === "number"
        ? String(nextMaxIdRaw)
        : nextMaxIdRaw;

  return {
    comments,
    nextMaxId: nextMaxId ?? null,
    totalCount: result.data.comment_count ?? comments.length,
    hasMore: result.data.has_more_comments ?? false,
  };
}

// ── Wave 5: media likers ───────────────────────────────────────────────────
//
// /api/v1/media/<media_id>/likers/ returns:
//   { users: [{ pk, username, full_name, profile_pic_url, is_verified,
//               is_private }, ...], user_count: <number> }
// IG caps the array at ~100 entries and provides no pagination cursor, so we
// surface the array as-is plus the total IG reports. Schema is permissive on
// per-user fields IG occasionally drops; the structural root (users array)
// is required.

const LikersUserSchema = z
  .object({
    pk: z.union([z.string(), z.number()]).optional(),
    pk_id: optionalId,
    id: optionalId,
    username: optionalString,
    full_name: optionalString,
    profile_pic_url: optionalString,
    is_verified: optionalBool,
    is_private: optionalBool,
  })
  .passthrough();

const LikersResponseSchema = z
  .object({
    users: z.array(LikersUserSchema),
    user_count: looseNum.optional(),
  })
  .passthrough();

export function parseLikersResponse(raw: unknown): IGLikersPage {
  assertSuccessfulEnvelope(raw, "media/likers");
  const result = LikersResponseSchema.safeParse(raw);
  if (!result.success) fail("media/likers", result.error.issues);

  const items = result.data.users ?? [];
  const users: IGUser[] = items
    .map((u) => {
      const pkValue =
        typeof u.pk === "number"
          ? String(u.pk)
          : u.pk ?? u.pk_id ?? u.id ?? "";
      return {
        pk: pkValue,
        username: u.username ?? "",
        fullName: u.full_name ?? null,
        profilePicUrl: u.profile_pic_url ?? null,
        isVerified: u.is_verified ?? false,
        isPrivate: u.is_private ?? false,
      };
    })
    // Drop entries IG returned without a username — they would corrupt the
    // unique index in likers_cache and offer no value to the UI.
    .filter((u) => u.username.length > 0);

  return {
    users,
    totalCount: result.data.user_count ?? users.length,
  };
}

// ── Friendship status (create follow response) ─────────────────────────────

const FriendshipStatusSchema = z
  .object({
    friendship_status: z
      .object({
        following: optionalBool,
        outgoing_request: optionalBool,
        incoming_request: optionalBool,
        followed_by: optionalBool,
        is_private: optionalBool,
      })
      .passthrough()
      .refine(value => typeof value.following === "boolean" || typeof value.outgoing_request === "boolean", "missing relationship evidence"),
  })
  .passthrough();

export function parseFriendshipStatusResponse(
  raw: unknown,
): IGFriendshipStatus {
  assertSuccessfulEnvelope(raw, "friendships/create");
  const result = FriendshipStatusSchema.safeParse(raw);
  if (!result.success) fail("friendships/create", result.error.issues);
  const s = result.data.friendship_status ?? {};
  return {
    following: s.following ?? false,
    outgoingRequest: s.outgoing_request ?? false,
    incomingRequest: s.incoming_request ?? false,
    followedBy: s.followed_by ?? false,
    isPrivate: s.is_private ?? false,
  };
}
