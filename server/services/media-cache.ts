import crypto from "node:crypto";
import dns from "node:dns";
import fsp from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  mediaAssets,
  postsCache,
  storiesCache,
  likeEvents,
  highlightsCache,
  highlightItemsCache,
  trackedAccounts,
} from "../../shared/schema.js";
import { logger } from "../observability/logger.js";
import { signMediaUrl, type MediaAccessScope } from "./media-access.js";

const allowedSuffixes = [".instagram.com", ".cdninstagram.com", ".fbcdn.net"];
const defaultCacheDir = path.resolve(process.cwd(), "storage", "media-cache");
const mediaCacheDir = path.resolve(process.env.MEDIA_CACHE_DIR ?? defaultCacheDir);
const maxMediaBytes = Number(process.env.MEDIA_CACHE_MAX_BYTES ?? 25 * 1024 * 1024);

type CachedMedia = {
  body: Buffer;
  contentType: string;
  byteSize: number;
};

export type CachedMediaAsset = {
  body: Buffer;
  contentType: string;
  byteSize: number;
  originalUrl: string;
};

/**
 * Stable identity for an Instagram CDN asset.
 *
 * IG re-signs media URLs on EVERY scrape and also load-balances the hostname, so
 * the same image arrives as an endless stream of distinct URLs:
 *   scontent-ord5-3.cdninstagram.com/v/t51.../abc_n.jpg?oh=<sig1>&oe=<exp1>
 *   scontent-ber1-1.cdninstagram.com/v/t51.../abc_n.jpg?oh=<sig2>&oe=<exp2>
 * Keying the cache on the full URL therefore treated each re-scrape as a brand
 * new asset: 200,547 rows for 59,090 real images (70.5% duplicates, ~21 GB) —
 * the engine behind the recurring disk-full AND a constant re-download of media
 * we already held, over metered residential proxy.
 *
 * Only the PATH is stable (host rotates, query carries the signature), so that
 * is the identity. Falls back to the whole URL for anything unparseable so a
 * weird input can never collide two different assets onto one key.
 */
function stableMediaPath(originalUrl: string): string {
  try {
    return new URL(originalUrl).pathname;
  } catch {
    return originalUrl;
  }
}

export function mediaCacheKey(originalUrl: string): string {
  return crypto
    .createHash("sha256")
    .update(stableMediaPath(originalUrl))
    .digest("hex");
}

export function mediaPublicUrl(cacheKey: string): string {
  return `/api/media/${cacheKey}`;
}

export function isAllowedMediaUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  return allowedSuffixes.some(
    (suffix) =>
      parsed.hostname === suffix.slice(1) || parsed.hostname.endsWith(suffix),
  );
}

export async function resolveCachedMediaUrls(
  urls: Iterable<string | null | undefined>,
  access?: MediaAccessScope,
): Promise<Map<string, string>> {
  const originals = Array.from(
    new Set(
      Array.from(urls)
        .filter((url): url is string => typeof url === "string" && url.length > 0)
        .filter(isAllowedMediaUrl),
    ),
  );
  const resolved = new Map<string, string>();
  if (originals.length === 0) return resolved;

  // Look up by the STABLE cache key, not original_url: a freshly re-signed URL
  // is a different string but the same asset, and matching on original_url made
  // every rotation a cache miss (→ re-download + duplicate row).
  const keyToUrls = new Map<string, string[]>();
  for (const url of originals) {
    const key = mediaCacheKey(url);
    const list = keyToUrls.get(key);
    if (list) list.push(url);
    else keyToUrls.set(key, [url]);
  }

  const rows = await db
    .select({
      cacheKey: mediaAssets.cacheKey,
      status: mediaAssets.status,
      localPath: mediaAssets.localPath,
      byteSize: mediaAssets.byteSize,
    })
    .from(mediaAssets)
    .where(inArray(mediaAssets.cacheKey, Array.from(keyToUrls.keys())));

  // A database row is not proof that the file still exists. Operators may
  // clear the cache directory during disk-pressure recovery while the
  // `media_assets` rows survive. Returning /api/media/<key> for those rows
  // creates a guaranteed 404 and prevents the client from falling back to the
  // still-known Instagram URL. Verify both containment and presence before we
  // advertise an app-owned URL; the enqueue running beside this lookup will
  // repopulate any missing file in the background.
  const usableRows = await Promise.all(
    rows.map(async (row) => {
      if (row.status !== "cached" || !row.localPath) return null;
      const resolvedPath = path.resolve(row.localPath);
      if (!resolvedPath.startsWith(mediaCacheDir + path.sep)) return null;
      try {
        const stat = await fsp.stat(resolvedPath);
        if (!stat.isFile() || stat.size === 0 || (row.byteSize != null && stat.size !== row.byteSize)) return null;
        return row;
      } catch {
        return null;
      }
    }),
  );

  for (const row of usableRows) {
    if (!row) continue;
    for (const url of keyToUrls.get(row.cacheKey) ?? []) {
      // Trusted internal callers may use the stable key. Customer routes must
      // provide their original account context; unsigned HTTP reads are denied.
      resolved.set(url, access ? signMediaUrl(row.cacheKey, access) : mediaPublicUrl(row.cacheKey));
    }
  }

  return resolved;
}

export async function readCachedMediaAsset(
  cacheKey: string,
  options: { repairMissing?: boolean } = {},
): Promise<CachedMediaAsset | null> {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) return null;

  const [asset] = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.cacheKey, cacheKey))
    .limit(1);
  if (!asset || asset.status !== "cached" || !asset.localPath || !asset.contentType) {
    return null;
  }

  const resolvedPath = path.resolve(asset.localPath);
  if (!resolvedPath.startsWith(mediaCacheDir + path.sep)) {
    logger.warn(
      { module: "media-cache", cacheKey },
      "blocked media asset outside cache directory",
    );
    return null;
  }

  try {
    const body = await fsp.readFile(resolvedPath);
    if (!body.length || (asset.byteSize != null && body.length !== asset.byteSize)) throw new Error("cached media file incomplete");
    return {
      body,
      contentType: asset.contentType,
      byteSize: body.length,
      originalUrl: asset.originalUrl,
    };
  } catch (err) {
    // A cache-only display lookup must not turn an image render into an
    // authenticated provider read when an old cache row has lost its file.
    if (options.repairMissing === false) return null;
    logger.warn(
      {
        module: "media-cache",
        cacheKey,
        err: err instanceof Error ? err.message : String(err),
      },
      "cached media file missing — attempting self-heal re-fetch",
    );
    // Self-heal: the cache dir was likely wiped (disk-full cleanup) leaving a
    // stale 'cached' row pointing at a deleted file. cacheMediaUrl() re-downloads
    // when the file is gone, so if the source URL is still valid we recover on
    // the spot instead of serving blank forever (and never re-downloading).
    try {
      const healed = await cacheMediaUrl(asset.originalUrl);
      if (healed.status === "cached") {
        const [fresh] = await db
          .select({
            localPath: mediaAssets.localPath,
            contentType: mediaAssets.contentType,
            byteSize: mediaAssets.byteSize,
          })
          .from(mediaAssets)
          .where(eq(mediaAssets.cacheKey, cacheKey))
          .limit(1);
        if (fresh?.localPath && fresh.contentType) {
          const freshPath = path.resolve(fresh.localPath);
          if (!freshPath.startsWith(mediaCacheDir + path.sep)) return null;
          const body = await fsp.readFile(freshPath);
          if (!body.length || (fresh.byteSize != null && body.length !== fresh.byteSize)) return null;
          return {
            body,
            contentType: fresh.contentType,
            byteSize: body.length,
            originalUrl: asset.originalUrl,
          };
        }
      }
    } catch (healErr) {
      logger.warn(
        {
          module: "media-cache",
          cacheKey,
          err: healErr instanceof Error ? healErr.message : String(healErr),
        },
        "media self-heal re-fetch failed",
      );
    }
    return null;
  }
}

// Instagram CDN URLs are SIGNED and expire; once the signature lapses the CDN
// answers 403 (or 410 when the media is gone for good). A stored thumbnail_url
// then points at a dead link forever: the self-heal in readCachedMediaAsset
// re-fetches the SAME dead URL and fails again, so the image is permanently
// broken in the UI. Only 403 is worth retrying — 410 means the media itself is
// gone and no fresh signature exists.
function isExpiredSignatureError(message: string): boolean {
  return /media upstream status 403/.test(message);
}

/**
 * Re-resolve a freshly-signed URL for media whose stored URL expired.
 *
 * Maps the dead URL back to its post (posts_cache holds the numeric media_id),
 * then asks IG for the current image via /media/{id}/info/. The fresh URL is
 * persisted to posts_cache + like_events so subsequent loads skip this path
 * entirely — otherwise every view would re-spend an IG call.
 *
 * Returns null when the URL can't be mapped to a media id, or IG has nothing
 * for it. Cost is naturally bounded: this only runs on-demand for images someone
 * actually views, and getFreshMediaThumbnail leases a bot under the "posts"
 * daily budget.
 */
// Instagram shortcodes ARE the media pk, base64-encoded with this alphabet.
// Decoding one gives the numeric id /media/{id}/info/ wants — which is the only
// way to refresh a LIKED post: liked posts belong to accounts we don't track, so
// they never land in posts_cache and have no stored media_id (only 3 of
// @example_account's 48 liked posts were resolvable via posts_cache).
const IG_B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function shortcodeToMediaId(shortcode: string): string | null {
  if (!shortcode) return null;
  let id = 0n;
  for (const ch of shortcode) {
    const v = IG_B64.indexOf(ch);
    if (v < 0) return null; // not a shortcode we can decode
    id = id * 64n + BigInt(v);
  }
  return id > 0n ? id.toString() : null;
}

// URL renewal is an authenticated Instagram read, unlike downloading a
// still-valid signed CDN URL. Keep private renewals on an approved session.
async function refreshTrackedMediaThumbnail(mediaId: string, trackedAccountId: string): Promise<string | null> {
  const [account] = await db.select({ isPrivate: trackedAccounts.isPrivate })
    .from(trackedAccounts)
    .where(eq(trackedAccounts.id, trackedAccountId))
    .limit(1);
  if (!account) return null;
  const { getFreshMediaThumbnail, getFreshMediaThumbnailWithBot } = await import("../ig-public-scraper.js");
  if (!account.isPrivate) return getFreshMediaThumbnail(mediaId);
  const { findGrantedBotId } = await import("./private-account-access.js");
  const grantedBotId = await findGrantedBotId(trackedAccountId);
  return grantedBotId ? getFreshMediaThumbnailWithBot(grantedBotId, mediaId) : null;
}

async function refreshTrackedMediaDetails(mediaId: string, trackedAccountId: string) {
  const [account] = await db.select({ isPrivate: trackedAccounts.isPrivate })
    .from(trackedAccounts).where(eq(trackedAccounts.id, trackedAccountId)).limit(1);
  if (!account) return null;
  const { getFreshMediaDetails, getFreshMediaDetailsWithBot } = await import("../ig-public-scraper.js");
  if (!account.isPrivate) return getFreshMediaDetails(mediaId);
  const { findGrantedBotId } = await import("./private-account-access.js");
  const grantedBotId = await findGrantedBotId(trackedAccountId);
  return grantedBotId ? getFreshMediaDetailsWithBot(grantedBotId, mediaId) : null;
}

async function resolveFreshUrlForExpiredMedia(
  originalUrl: string,
): Promise<string | null> {
  const [post] = await db
    .select({ id: postsCache.id, mediaId: postsCache.mediaId, shortcode: postsCache.shortcode, trackedAccountId: postsCache.trackedAccountId, videoUrl: postsCache.videoUrl, carouselMedia: postsCache.carouselMedia })
    .from(postsCache)
    .where(
      or(
        eq(postsCache.thumbnailUrl, originalUrl),
        eq(postsCache.displayUrl, originalUrl),
        eq(postsCache.videoUrl, originalUrl),
        sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(${postsCache.carouselMedia}, '[]'::jsonb)) AS child
          WHERE child->>'displayUrl' = ${originalUrl} OR child->>'videoUrl' = ${originalUrl}
        )`,
      ),
    )
    .limit(1);

  if (post?.mediaId && (post.videoUrl === originalUrl || post.carouselMedia?.some(
    (child) => child.displayUrl === originalUrl || child.videoUrl === originalUrl,
  ))) {
    const fresh = await refreshTrackedMediaDetails(post.mediaId, post.trackedAccountId);
    if (!fresh) return null;
    if (post.videoUrl === originalUrl) {
      if (!fresh.videoUrl || fresh.videoUrl === originalUrl) return null;
      await db.update(postsCache).set({ videoUrl: fresh.videoUrl }).where(eq(postsCache.id, post.id));
      return fresh.videoUrl;
    }
    // Prefer the child media ID retained by new captures. Legacy rows use
    // the stable CDN path (mediaCacheKey identity), never array position.
    let renewedUrl: string | null = null;
    const carouselMedia = post.carouselMedia!.map((child) => {
      const field = child.videoUrl === originalUrl ? "videoUrl" : child.displayUrl === originalUrl ? "displayUrl" : null;
      if (!field) return child;
      const matched = fresh.carouselMedia?.find((candidate) => {
        const url = candidate[field];
        return url && (child.mediaId
          ? candidate.mediaId === child.mediaId
          : stableMediaPath(url) === stableMediaPath(originalUrl));
      });
      const url = matched?.[field];
      if (!url || url === originalUrl) return child;
      renewedUrl = url;
      return { ...child, [field]: url };
    });
    if (!renewedUrl) return null;
    await db.update(postsCache).set({ carouselMedia }).where(eq(postsCache.id, post.id));
    return renewedUrl;
  }

  // Highlight covers live in their own table with NO media id, so the only way
  // to re-sign one is to re-read the account's highlights tray (which returns
  // fresh cover URLs for every highlight). Cheap enough because it only runs
  // when someone actually views a highlight whose cover has expired, and it
  // repairs ALL of that account's covers in a single scrape.
  if (!post?.mediaId) {
    const [hl] = await db
      .select({
        highlightId: highlightsCache.highlightId,
        trackedAccountId: highlightsCache.trackedAccountId,
      })
      .from(highlightsCache)
      .where(eq(highlightsCache.coverUrl, originalUrl))
      .limit(1);
    if (hl) {
      const [acct] = await db
        .select({ id: trackedAccounts.id, igUserId: trackedAccounts.igUserId, isPrivate: trackedAccounts.isPrivate })
        .from(trackedAccounts)
        .where(eq(trackedAccounts.id, hl.trackedAccountId))
        .limit(1);
      if (!acct?.igUserId) return null;
      const { scrapeUserHighlights, scrapeUserHighlightsWithBot } = await import("../ig-public-scraper.js");
      const { findGrantedBotId } = await import("./private-account-access.js");
      const grantedBotId = acct.isPrivate ? await findGrantedBotId(acct.id) : null;
      if (acct.isPrivate && !grantedBotId) return null;
      const trays = grantedBotId
        ? await scrapeUserHighlightsWithBot(grantedBotId, acct.igUserId)
        : await scrapeUserHighlights(acct.igUserId);
      let mine: string | null = null;
      for (const tray of trays) {
        if (!tray.coverUrl) continue;
        await db
          .update(highlightsCache)
          .set({ coverUrl: tray.coverUrl })
          .where(
            and(
              eq(highlightsCache.trackedAccountId, hl.trackedAccountId),
              eq(highlightsCache.highlightId, tray.highlightId),
            ),
          );
        if (tray.highlightId === hl.highlightId) mine = tray.coverUrl;
      }
      if (!mine || mine === originalUrl) return null;
      logger.info(
        { module: "media-cache", highlightId: hl.highlightId, via: "highlights" },
        "refreshed expired Instagram media URL",
      );
      return mine;
    }
  }

  // Highlight ITEMS (the frames that actually play). Their media_url is a story
  // URL with no media id we can re-sign individually, so re-read the parent
  // highlight's reel — one scrape refreshes every frame in that highlight.
  // Without this, highlight covers rendered but nothing played: 5,709 item URLs
  // were stale/never-cached and 351 outright failed.
  if (!post?.mediaId) {
    const [item] = await db
      .select({
        highlightCacheId: highlightItemsCache.highlightCacheId,
      })
      .from(highlightItemsCache)
      .where(
        or(
          eq(highlightItemsCache.mediaUrl, originalUrl),
          eq(highlightItemsCache.thumbnailUrl, originalUrl),
        ),
      )
      .limit(1);
    if (item) {
      const [parent] = await db
        .select({
          highlightId: highlightsCache.highlightId,
          trackedAccountId: highlightsCache.trackedAccountId,
        })
        .from(highlightsCache)
        .where(eq(highlightsCache.id, item.highlightCacheId))
        .limit(1);
      if (!parent) return null;
      const [acct] = await db
        .select({ id: trackedAccounts.id, igUserId: trackedAccounts.igUserId, isPrivate: trackedAccounts.isPrivate })
        .from(trackedAccounts)
        .where(eq(trackedAccounts.id, parent.trackedAccountId))
        .limit(1);
      if (!acct?.igUserId) return null;

      const { scrapeUserHighlights, scrapeUserHighlightsWithBot } = await import("../ig-public-scraper.js");
      const { findGrantedBotId } = await import("./private-account-access.js");
      const grantedBotId = acct.isPrivate ? await findGrantedBotId(acct.id) : null;
      if (acct.isPrivate && !grantedBotId) return null;
      const trays = grantedBotId
        ? await scrapeUserHighlightsWithBot(grantedBotId, acct.igUserId, { withItems: true })
        : await scrapeUserHighlights(acct.igUserId, { withItems: true });
      const tray = trays.find((t) => t.highlightId === parent.highlightId);
      if (!tray || tray.items.length === 0) return null;

      // Re-point every frame of this highlight at its freshly-signed URL.
      let mine: string | null = null;
      const existing = await db
        .select({
          id: highlightItemsCache.id,
          storyId: highlightItemsCache.storyId,
          mediaUrl: highlightItemsCache.mediaUrl,
          thumbnailUrl: highlightItemsCache.thumbnailUrl,
        })
        .from(highlightItemsCache)
        .where(eq(highlightItemsCache.highlightCacheId, item.highlightCacheId));
      const freshByStoryId = new Map(tray.items.map((frame) => [frame.storyId, frame]));
      for (const row of existing) {
        const fresh = freshByStoryId.get(row.storyId);
        // Instagram can reorder, remove or add frames between reads. Never
        // attach a different story's media to a retained story identity.
        if (!fresh) continue;
        const hit =
          row.mediaUrl === originalUrl || row.thumbnailUrl === originalUrl;
        await db
          .update(highlightItemsCache)
          .set({ mediaUrl: fresh.mediaUrl, thumbnailUrl: fresh.thumbnailUrl })
          .where(eq(highlightItemsCache.id, row.id));
        if (hit) {
          mine =
            row.mediaUrl === originalUrl ? fresh.mediaUrl : fresh.thumbnailUrl;
        }
      }
      if (!mine || mine === originalUrl) return null;
      logger.info(
        {
          module: "media-cache",
          highlightId: parent.highlightId,
          via: "highlight-items",
        },
        "refreshed expired Instagram media URL",
      );
      return mine;
    }
  }

  // Active stories also carry expiring signed URLs. Refresh the exact story
  // with the granted viewer, never substitute another currently active story.
  if (!post?.mediaId) {
    const [story] = await db.select({
      id: storiesCache.id, storyId: storiesCache.storyId,
      trackedAccountId: storiesCache.trackedAccountId,
      mediaUrl: storiesCache.mediaUrl, thumbnailUrl: storiesCache.thumbnailUrl,
      expiresAt: storiesCache.expiresAt,
    }).from(storiesCache)
      .where(or(eq(storiesCache.mediaUrl, originalUrl), eq(storiesCache.thumbnailUrl, originalUrl)))
      .limit(1);
    if (story?.storyId) {
      if (story.expiresAt && new Date(story.expiresAt).getTime() <= Date.now()) return null;
      const [account] = await db.select({ id: trackedAccounts.id, igUserId: trackedAccounts.igUserId, isPrivate: trackedAccounts.isPrivate })
        .from(trackedAccounts).where(eq(trackedAccounts.id, story.trackedAccountId)).limit(1);
      if (!account?.igUserId) return null;
      const { scrapeUserStories, scrapeUserStoriesWithBot } = await import("../ig-public-scraper.js");
      const { findGrantedBotId } = await import("./private-account-access.js");
      const grantedBotId = account.isPrivate ? await findGrantedBotId(account.id) : null;
      if (account.isPrivate && !grantedBotId) return null;
      const freshStories = grantedBotId
        ? await scrapeUserStoriesWithBot(grantedBotId, account.igUserId)
        : await scrapeUserStories(account.igUserId);
      const fresh = freshStories.find((candidate) => candidate.storyId === story.storyId);
      if (!fresh || fresh.expiresAt.getTime() <= Date.now()) return null;
      const url = story.mediaUrl === originalUrl ? fresh.mediaUrl : fresh.thumbnailUrl;
      if (!url || url === originalUrl) return null;
      await db.update(storiesCache).set({ mediaUrl: fresh.mediaUrl, thumbnailUrl: fresh.thumbnailUrl })
        .where(eq(storiesCache.id, story.id));
      return url;
    }
  }

  // Fall back to like_events: a liked post is owned by an account we don't
  // track, so posts_cache has no row for it. We still hold its shortcode, and
  // the shortcode decodes to the media id.
  if (!post?.mediaId) {
    const [liked] = await db
      .select({ postId: likeEvents.postId, trackedAccountId: likeEvents.trackedAccountId })
      .from(likeEvents)
      .where(eq(likeEvents.thumbnailUrl, originalUrl))
      .limit(1);
    const derivedId = liked?.postId ? shortcodeToMediaId(liked.postId) : null;
    if (!derivedId || !liked) return null;
    const freshLiked = await refreshTrackedMediaThumbnail(derivedId, liked.trackedAccountId);
    if (!freshLiked || freshLiked === originalUrl) return null;
    await db
      .update(likeEvents)
      .set({ thumbnailUrl: freshLiked })
      .where(eq(likeEvents.postId, liked.postId));
    logger.info(
      { module: "media-cache", shortcode: liked.postId, via: "like_events" },
      "refreshed expired Instagram media URL",
    );
    return freshLiked;
  }

  // Dynamic import: ig-public-scraper pulls in the bot/proxy stack, and a static
  // import here would create a cycle (scraper -> persistence -> media-cache).
  const fresh = await refreshTrackedMediaThumbnail(post.mediaId, post.trackedAccountId);
  if (!fresh || fresh === originalUrl) return null;

  await Promise.all([
    db
      .update(postsCache)
      .set({ thumbnailUrl: fresh, displayUrl: fresh })
      .where(eq(postsCache.shortcode, post.shortcode)),
    db
      .update(likeEvents)
      .set({ thumbnailUrl: fresh })
      .where(eq(likeEvents.postId, post.shortcode)),
  ]);

  logger.info(
    { module: "media-cache", shortcode: post.shortcode },
    "refreshed expired Instagram media URL",
  );
  return fresh;
}

export async function cacheMediaUrl(originalUrl: string): Promise<{
  cacheKey: string;
  status: "cached" | "failed" | "skipped";
  publicUrl?: string;
}> {
  if (!isAllowedMediaUrl(originalUrl)) {
    return { cacheKey: mediaCacheKey(originalUrl), status: "skipped" };
  }

  const cacheKey = mediaCacheKey(originalUrl);
  // Match on the stable key so a re-signed URL for an asset we already hold is a
  // HIT, not a fresh download + duplicate row.
  const [existing] = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.cacheKey, cacheKey))
    .limit(1);

  if (existing?.status === "cached" && existing.localPath) {
    try {
      const existingPath = path.resolve(existing.localPath);
      if (!existingPath.startsWith(mediaCacheDir + path.sep)) throw new Error("cached media outside cache directory");
      const stat = await fsp.stat(existingPath);
      if (!stat.isFile() || stat.size === 0 || (existing.byteSize != null && stat.size !== existing.byteSize)) throw new Error("cached media file incomplete");
      return { cacheKey, status: "cached", publicUrl: mediaPublicUrl(cacheKey) };
    } catch {
      // Fall through and refresh the missing file.
    }
  }

  await upsertMediaAssetPending(originalUrl, cacheKey);

  try {
    let fetched: CachedMedia;
    let fetchedUrl = originalUrl;
    try {
      fetched = await fetchMedia(originalUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isExpiredSignatureError(message)) throw err;
      // Expired signature: swap in a freshly-signed URL for the same media and
      // retry ONCE. Deliberately no recursion — if the fresh URL also fails we
      // let the error fall through to the failed-row path below.
      const freshUrl = await resolveFreshUrlForExpiredMedia(originalUrl).catch(
        () => null,
      );
      if (!freshUrl) throw err;
      fetched = await fetchMedia(freshUrl);
      fetchedUrl = freshUrl;
    }
    const extension = extensionForContentType(fetched.contentType);
    const localPath = path.join(mediaCacheDir, `${cacheKey}${extension}`);
    await fsp.mkdir(mediaCacheDir, { recursive: true });
    const temporaryPath = `${localPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporaryPath, fetched.body, { flag: "wx" });
      await fsp.rename(temporaryPath, localPath);
    } finally {
      await fsp.rm(temporaryPath, { force: true });
    }

    await db
      .update(mediaAssets)
      .set({
        localPath,
        // A renewed rendition may have another path and its own cache row.
        // Keep that URL's unique ownership; this row repairs the original key.
        ...(mediaCacheKey(fetchedUrl) === cacheKey ? { originalUrl: fetchedUrl } : {}),
        contentType: fetched.contentType,
        byteSize: fetched.byteSize,
        status: "cached",
        errorMessage: null,
        lastFetchedAt: new Date(),
        failedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.cacheKey, cacheKey));

    return { cacheKey, status: "cached", publicUrl: mediaPublicUrl(cacheKey) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(mediaAssets)
      .set({
        status: "failed",
        errorMessage: message.slice(0, 1000),
        failedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.cacheKey, cacheKey));
    return { cacheKey, status: "failed" };
  }
}

async function upsertMediaAssetPending(
  originalUrl: string,
  cacheKey: string,
): Promise<void> {
  // Conflict on the STABLE cache_key, not original_url: the same asset arrives
  // under a fresh signed URL on every scrape, so conflicting on the URL minted a
  // new row each time. original_url is refreshed to the URL we're about to fetch
  // (it must be a live, signed one for fetchMedia to succeed).
  await db
    .insert(mediaAssets)
    .values({
      originalUrl,
      cacheKey,
      status: "pending",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: mediaAssets.cacheKey,
      set: {
        originalUrl,
        status: "pending",
        errorMessage: null,
        updatedAt: new Date(),
      },
    });
}

async function fetchMedia(originalUrl: string): Promise<CachedMedia> {
  if (!isAllowedMediaUrl(originalUrl)) throw new Error("media URL not allowed");
  const parsed = new URL(originalUrl);
  const controller = new AbortController();
  let rejectDeadline!: (reason: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    const error = new Error("media fetch timeout");
    controller.abort(error);
    rejectDeadline(error);
  }, 15_000);
  timer.unref();
  try {
    // Pin the complete validated answer, not just its first family. Some CDN
    // hosts return an unreachable IPv6 address before their working IPv4 one.
    const addresses = await Promise.race([dns.promises.lookup(parsed.hostname, {
      all: true, verbatim: true,
    }), deadline]);
    if (!addresses.length || addresses.some(({ address }) => !address || isPrivateOrReservedIp(address))) {
      throw new Error("media host resolved to private network");
    }
    const first = addresses.find(({ family }) => family === 4) ?? addresses[0];
    // HTTPS forwards these socket options, although this @types/node version
    // lists them only on net.TcpSocketConnectOpts.
    const familyOptions: Pick<net.TcpSocketConnectOpts, "autoSelectFamily" | "autoSelectFamilyAttemptTimeout"> = {
      autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250,
    };

    return await Promise.race([new Promise<CachedMedia>((resolve, reject) => {
      const req = https.get(
        parsed.toString(),
        {
          signal: controller.signal,
          ...familyOptions,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.instagram.com/",
          },
          lookup: (_hostname, opts, cb) => {
            if ((opts as { all?: boolean }).all) {
              cb(null, addresses);
              return;
            }
            cb(null, first.address, first.family);
          },
        },
        (res) => {
          res.on("error", reject);
          res.on("aborted", () => reject(new Error("media response interrupted")));
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            res.resume();
            reject(new Error(`media upstream status ${statusCode}`));
            return;
          }

          const contentType = String(res.headers["content-type"] ?? "").split(";")[0];
          if (!isAllowedContentType(contentType)) {
            res.resume();
            reject(new Error(`unsupported media content-type ${contentType}`));
            return;
          }

          const contentLength = Number(res.headers["content-length"] ?? "0");
          if (contentLength > maxMediaBytes) {
            res.resume();
            reject(new Error(`media too large: ${contentLength}`));
            return;
          }

          let bytes = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxMediaBytes) {
              req.destroy(new Error(`media too large: ${bytes}`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (bytes === 0 || (contentLength > 0 && bytes !== contentLength)) {
              reject(new Error("media response incomplete"));
              return;
            }
            resolve({
              body: Buffer.concat(chunks),
              contentType,
              byteSize: bytes,
            });
          });
        },
      );

      req.on("error", reject);
    }), deadline]);
  } catch (error) {
    // Stop rejected/oversized responses too; draining a stalled body must not
    // outlive the bounded attempt after its caller has already received failure.
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isAllowedContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.startsWith("image/") || lower.startsWith("video/");
}

function extensionForContentType(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    default:
      return ".jpg";
  }
}

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => Number(p));
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 0) ||
      a >= 224
    );
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith("ff") ||
      lower.startsWith("::ffff:") ||
      lower === "::"
    );
  }

  return true;
}

// Testing seam for the expired-signature recovery path (see
// server/services/__tests__/media-cache-refresh.test.ts). Not part of the
// module's public API — production callers go through cacheMediaUrl().
export const __testing = {
  isExpiredSignatureError,
  resolveFreshUrlForExpiredMedia,
  stableMediaPath,
};
