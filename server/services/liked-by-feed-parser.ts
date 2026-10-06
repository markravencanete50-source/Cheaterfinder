// ─── Liked-by feed parser (pure, no I/O) ─────────────────────────────────────
//
// Wave 9: parse the raw JSON returned by a watcher bot's HOME feed
// (POST /api/v1/feed/timeline/) and REELS feed (POST /api/v1/clips/discover/)
// into the handful of fields the liked-by harvester needs.
//
// The interesting payload is the "suggested"/"netego" posts IG injects into a
// logged-in feed. Each carries a facepile of "people you follow who liked
// this". Envelope shapes seen in the field (defensive union — IG changes these
// without notice):
//
//   feed_items: [ { explore_story: { media_or_ad: <media> } }, ... ]
//   feed_items: [ { media_or_ad: <media> }, ... ]
//   items:      [ { media: <media> }, ... ]        // clips/discover
//   items:      [ <media>, ... ]
//
// The liker usernames live on the media under `facepile_top_likers`,
// `top_likers`, and `social_context`. These are EMPTY when the bot follows
// nobody and populate once it follows accounts — hence the watcher must follow
// tracked users first. This is SAMPLED INFERENCE: we only ever see what IG
// happens to inject, so coverage is partial by design.
//
// This module is intentionally pure (no DB, no network) so it can be unit
// tested against captured payloads and never trusts the external shape — every
// field is read through a guard.
// ─────────────────────────────────────────────────────────────────────────────

export type LikedByPostType = "photo" | "video" | "reel" | "carousel";

export interface HarvestedMedia {
  /** IG numeric media pk (stable per post). */
  readonly postId: string;
  /** Shortcode (the /p/<code>/ segment); may be "" if IG omitted it. */
  readonly shortcode: string;
  /** Owner of the liked post (a different account than the liker). */
  readonly ownerUsername: string;
  readonly postType: LikedByPostType;
  readonly caption: string | null;
  readonly thumbnailUrl: string | null;
  readonly likeCount: number | null;
  readonly commentCount: number | null;
  readonly videoViewCount: number | null;
  /** When the post itself was published (IG `taken_at`), null if absent. */
  readonly takenAt: Date | null;
  /** Lower-cased usernames of "people you follow who liked this". */
  readonly likerUsernames: ReadonlyArray<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// IG media_type: 1 = photo, 2 = video, 8 = carousel. product_type "clips"
// marks a reel (media_type is still 2).
function mapMediaType(
  mediaType: unknown,
  productType: unknown,
): LikedByPostType {
  if (mediaType === 8) return "carousel";
  if (mediaType === 2) {
    return productType === "clips" ? "reel" : "video";
  }
  return "photo";
}

// Pick the best (first, highest-res) candidate URL from an image_versions2
// block. Falls back through common alternate shapes IG uses for reels.
function bestThumbnail(media: Record<string, unknown>): string | null {
  const iv2 = media.image_versions2;
  if (isRecord(iv2) && Array.isArray(iv2.candidates)) {
    for (const candidate of iv2.candidates) {
      if (isRecord(candidate)) {
        const url = asString(candidate.url);
        if (url) return url;
      }
    }
  }
  // Reels sometimes nest the cover under `cover_media` / `thumbnail_url`.
  const cover = media.cover_media;
  if (isRecord(cover)) {
    const nested = bestThumbnail(cover);
    if (nested) return nested;
  }
  return asString(media.thumbnail_url);
}

// Recursively collect username strings from a liker-bearing field WITHOUT
// walking into unrelated media fields. `top_likers` is often an array of bare
// username strings; `facepile_top_likers` is an array of user objects;
// `social_context` is an array of objects that may carry `username`, a nested
// `user`, or a `users` array. We deliberately DO NOT parse free-text like
// "Liked by X and 3 others" — only structured usernames — to avoid false
// matches.
function collectUsernames(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.add(trimmed.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectUsernames(entry, out);
    return;
  }
  if (isRecord(value)) {
    const username = asString(value.username);
    if (username) out.add(username.trim().toLowerCase());
    if (isRecord(value.user)) {
      const nested = asString(value.user.username);
      if (nested) out.add(nested.trim().toLowerCase());
    }
    if (Array.isArray(value.users)) {
      for (const entry of value.users) collectUsernames(entry, out);
    }
  }
}

function extractLikerUsernames(media: Record<string, unknown>): string[] {
  const usernames = new Set<string>();
  collectUsernames(media.facepile_top_likers, usernames);
  collectUsernames(media.top_likers, usernames);
  collectUsernames(media.social_context, usernames);
  return Array.from(usernames);
}

// Peel the media object out of one feed_items / items entry, handling every
// envelope shape above. Returns null for demarcators, ads without a media, and
// entries we can't identify as a post.
function unwrapMedia(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry)) return null;

  const exploreStory = entry.explore_story;
  if (isRecord(exploreStory) && isRecord(exploreStory.media_or_ad)) {
    return exploreStory.media_or_ad;
  }
  if (isRecord(entry.media_or_ad)) return entry.media_or_ad;
  if (isRecord(entry.media)) return entry.media;

  // The entry may itself be the media object.
  const looksLikeMedia =
    entry.pk !== undefined || entry.id !== undefined || entry.code !== undefined;
  return looksLikeMedia ? entry : null;
}

function collectContainers(raw: unknown): unknown[] {
  if (!isRecord(raw)) return [];
  const out: unknown[] = [];
  for (const key of ["feed_items", "items", "media", "reels_media"]) {
    const container = raw[key];
    if (Array.isArray(container)) out.push(...container);
  }
  return out;
}

/** IG sends `taken_at` as unix SECONDS. Guard against 0/absent/absurd values. */
function toTakenAt(raw: unknown): Date | null {
  const secs = asFiniteNumber(raw);
  if (secs === null || secs <= 0) return null;
  const ms = secs * 1000;
  // Sanity window: Instagram launched in 2010, and a future date means the
  // field was misread (e.g. already-ms input) rather than a real post date.
  if (ms < Date.UTC(2010, 0, 1) || ms > Date.now() + 24 * 60 * 60 * 1000) {
    return null;
  }
  return new Date(ms);
}

function toHarvestedMedia(media: Record<string, unknown>): HarvestedMedia | null {
  const likerUsernames = extractLikerUsernames(media);
  // No liker facepile → nothing to infer from this post. Skip early.
  if (likerUsernames.length === 0) return null;

  // Prefer the pure numeric pk; fall back to the composite id.
  const pk = media.pk;
  const id = media.id;
  const postId =
    asString(typeof pk === "number" ? String(pk) : pk) ??
    asString(typeof id === "number" ? String(id) : id);
  if (!postId) return null;

  const user = isRecord(media.user) ? media.user : {};
  const ownerUsername = asString(user.username);
  if (!ownerUsername) return null;

  const caption = isRecord(media.caption) ? asString(media.caption.text) : null;

  return {
    postId,
    shortcode: asString(media.code) ?? "",
    ownerUsername,
    postType: mapMediaType(media.media_type, media.product_type),
    caption,
    thumbnailUrl: bestThumbnail(media),
    likeCount: asFiniteNumber(media.like_count),
    commentCount: asFiniteNumber(media.comment_count),
    videoViewCount:
      asFiniteNumber(media.view_count) ?? asFiniteNumber(media.play_count),
    takenAt: toTakenAt(media.taken_at),
    likerUsernames,
  };
}

/**
 * Parse a raw home/reels feed payload into the suggested posts that carry a
 * liker facepile. Posts without any structured liker username are dropped.
 * Deduplicated by postId (a post can appear more than once across containers).
 */
export function parseLikedByFeed(raw: unknown): HarvestedMedia[] {
  const byPostId = new Map<string, HarvestedMedia>();
  for (const entry of collectContainers(raw)) {
    const media = unwrapMedia(entry);
    if (!media) continue;
    const harvested = toHarvestedMedia(media);
    if (harvested && !byPostId.has(harvested.postId)) {
      byPostId.set(harvested.postId, harvested);
    }
  }
  return Array.from(byPostId.values());
}

// Local, dependency-free hashtag extractor (mirrors bot-collectors) so the
// harvester doesn't pull the heavy ig-public-scraper module in just for this.
export function extractHashtags(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const matches = caption.match(/#[a-zA-Z]\w{2,}/g);
  if (!matches) return [];
  return Array.from(new Set(matches));
}
