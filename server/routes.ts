import { currentInvoiceAttention } from "./services/billing-email-state.js";
import { activateTrialNow, BillingActivationError } from "./services/billing-activation.js";
import { claimRescueOffer, verifyRescueOfferToken, RescueOfferError } from "./services/billing-rescue-offer.js";
import { createTrialPreviewMiddleware } from "./services/trial-preview-http.js";
import { isTrialPreviewUser, isPermittedPreviewAvatar, sendPreviewPlaceholder } from "./services/trial-preview-access.js";
import { sanitizeTrialPreview } from "./services/trial-preview.js";
import { recordInvoiceEmail, recordTrialEndingEmail } from "./services/transactional-emails.js";
import { acceptRetentionOffer, cancelCustomerSubscription, quoteRetentionOffer, RetentionError } from "./services/billing-retention.js";
import { customerAccessSql, customerHasAccess } from "./services/subscription-access.js";
import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import https from "https";
import dns from "node:dns";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq, asc, desc, and, or, count, sql, inArray, gt, gte, type SQL } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "./db.js";
import { readBackgroundRosterView } from "./services/roster-background-sync.js";
import { readPostsCollectionState } from "./services/posts-collection-state.js";
import { backgroundRosterSyncState } from "../shared/roster-background.js";
import {
  users,
  trackedAccounts,
  subscriptions,
  likeEvents,
  followEvents,
  unfollowEvents,
  reports,
  rosterMembers,
  notifications,
  collectionJobs,
  profileSnapshots,
  botFollowRequests,
  postsCache,
  storiesCache,
  highlightsCache,
  highlightItemsCache,
  followerEvents,
  followerUnfollowEvents,
  commentsCache,
  likersCache,
  deviceTokens,
} from "../shared/schema.js";
import { isAuthenticated, issueCsrfCookie } from "./auth.js";
import { changeCustomerPassword } from "./services/customer-credentials.js";
import {
  validateBody,
  deviceTokenSchema,
  addTrackedAccountSchema,
  updateProfileSchema,
  updatePasswordSchema,
  checkoutSchema,
} from "../shared/validation.js";
import type {
  AddTrackedAccountInput,
  UpdateProfileInput,
  UpdatePasswordInput,
  CheckoutInput,
  DeviceTokenInput,
} from "../shared/validation.js";
import {
  BILLING_PLANS,
  hasSubscriptionAccess,
  accountLimitForSubscription,
} from "../shared/billing-plans.js";
import {
  assignBotToTrackedAccount,
  rotateBotForTrackedAccount,
} from "./bot-manager.js";
import {
  stripe,
  createCheckoutSession,
  getCheckoutEligibility,
  createPortalSession,
  confirmCheckoutSession,
  syncSubscription,
  StripeConfigurationError,
  ExistingSubscriptionError,
  CheckoutSessionOwnershipError,
} from "./stripe.js";
import { CheckoutOfferChangedError, TrialPaymentConfigurationError } from "./services/trial-payment-offer.js";
import { readTrialPaymentSummary, pendingTrialPaymentSummary } from "./services/trial-payment-state.js";
import { reconcileTrialPaymentFinancialEvent } from "./services/trial-payment-events.js";
import {
  collectionProfileQueue,
  reportGenerateQueue,
  botFollowRequestQueue,
} from "./workers.js";
import { enqueueMediaCacheUrls } from "./services/media-cache-jobs.js";
import { likedPostAfterTrackingStart } from "./services/like-event-policy.js";
import {
  canonicalTwinId,
  countVisibleLikedPostsByAccount,
  dedupeLikedPostsByPostId,
  twinTrackedAccountIds,
} from "./services/tracked-account-twins.js";
// C4: auth + rate-limit guards and LRU disk-cache sweep for /api/img-proxy.
import {
  galleryProxyLimiter,
  videoProxyLimiter,
} from "./services/img-proxy-guards.js";
import { maybeSweepImgCache } from "./services/img-cache-sweep.js";
import { registerAdminRoutes } from "./admin-routes.js";
import {
  registerAccountRefresh,
  unregisterAccountRefresh,
} from "./workers/account-refresh-registrar.js";
import {
  getPostComments,
  getPostCommentsAsBot,
  getPostLikers,
  getPostLikersAsBot,
} from "./services/public-data-service.js";
import {
  persistComments,
  persistLikers,
  persistPosts,
} from "./services/public-data-persistence.js";
import { scrapeUserPostsPage, scrapeUserPostsPageWithBot } from "./ig-public-scraper.js";
import { findGrantedBotId } from "./services/private-account-access.js";
import {
  fetchPublicProfileTier1,
  maybeRevalidateTier1,
} from "./services/public-read-client.js";
import { applyProfileToDb } from "./services/public-data-collector.js";
import { withScrapeContext } from "./services/bandwidth-meter.js";
import {
  buildFollowersRoster,
  buildFollowingRoster,
  getFollowersRosterStats,
  getFollowingRosterStats,
  computeRosterSyncState,
  followActivityBoundary,
  followActivityFilters,
  isUnfollowRosterTrusted,
  visibleFollowEventsSql,
  visibleRosterDeparturesSql,
  visibleFollowerUnfollowsSql,
  ROSTER_ENUMERABLE_CAP,
} from "./services/roster.js";
import {
  getRosterSyncHealth,
  reuseSettledRosterFromSibling,
} from "./services/roster-store.js";
import {
  mediaCacheKey,
  readCachedMediaAsset,
  resolveCachedMediaUrls,
} from "./services/media-cache.js";
import { signMediaUrl, verifyMediaSignature } from "./services/media-access.js";
import {
  fetchEndpoints,
  proxyAgentUriForEndpoint,
} from "./services/proxy-provider.js";
import { logger } from "./observability/logger.js";
import type Stripe from "stripe";
import { isShuttingDown, onShutdown } from "./services/shutdown-state.js";
import { CustomerAccountMissingError, CustomerBillingBusyError, CustomerDeletionBillingError, deleteCustomerAccount, withCustomerBillingLock } from "./services/customer-billing-lifecycle.js";

const imageCacheDir = process.env.IMAGE_CACHE_DIR ?? "/tmp/cheaterfinder-img-cache";
const imageCacheMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
const interactiveScrapeEnabled =
  String(process.env.ALLOW_INTERACTIVE_SCRAPE ?? "false").toLowerCase() === "true";
import {
  assertStripeConfigured,
  IntegrationMissingError,
} from "./integrations.js";
import { createNotification } from "./services/notifications.js";
import { refreshEngagementOnce } from "./services/interactive-refresh.js";
import { chooseCurrentSubscription, processStripeEventOnce } from "./services/stripe-webhook-safety.js";
import { operationSignal } from "./services/operation-lease.js";
import { registerDeviceToken, unregisterDeviceToken } from "./services/push-notifications.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePagination(query: Record<string, unknown>): {
  limit: number;
  offset: number;
} {
  const limit = Math.min(parseInt(String(query.limit ?? "20"), 10) || 20, 100);
  const offset = Math.max(0, parseInt(String(query.offset ?? "0"), 10) || 0);
  return { limit, offset };
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

// Instagram-posts feature: float pinned posts to the top of the grid while
// preserving takenAt-desc ordering within the pinned and non-pinned groups.
// Callers pass rows already ordered by takenAt desc (the posts_cache query
// does this), so a STABLE partition is all we need — Array.prototype.sort is
// stable in V8/Node, and partitioning by a numeric key keeps it stable here.
function pinnedFirstPosts<
  T extends { isPinned: boolean | null; takenAt: Date | null },
>(posts: ReadonlyArray<T>): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const post of posts) {
    if (post.isPinned) pinned.push(post);
    else rest.push(post);
  }
  return [...pinned, ...rest];
}

// Copy posts cached under OTHER tracked accounts that follow the SAME IG
// profile into this account's cache (skipping shortcodes we already hold).
// Lets a second user who tracks an already-tracked profile inherit the posts
// already scraped by the first — no redundant IG scrape. Picks the freshest
// row per shortcode; the (tracked_account_id, shortcode) unique index makes
// rows we already have a no-op.
async function backfillPostsFromSiblings(
  accountId: string,
  igUserId: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO posts_cache (
      tracked_account_id, shortcode, media_id, post_type, thumbnail_url,
      display_url, video_url, caption, like_count, comment_count,
      video_view_count, taken_at, location_name, hashtags, is_pinned,
      carousel_media, cached_at
    )
    SELECT DISTINCT ON (p.shortcode)
      ${accountId}, p.shortcode, p.media_id, p.post_type, p.thumbnail_url,
      p.display_url, p.video_url, p.caption, p.like_count, p.comment_count,
      p.video_view_count, p.taken_at, p.location_name, p.hashtags, p.is_pinned,
      p.carousel_media, p.cached_at
    FROM posts_cache p
    JOIN tracked_accounts t ON t.id = p.tracked_account_id
    WHERE t.ig_user_id = ${igUserId}
      AND t.is_private IS FALSE
      AND EXISTS (SELECT 1 FROM tracked_accounts destination
        WHERE destination.id = ${accountId} AND destination.is_private IS FALSE)
      AND p.tracked_account_id <> ${accountId}
    ORDER BY p.shortcode, p.cached_at DESC
    ON CONFLICT (tracked_account_id, shortcode) DO UPDATE SET
      -- ENRICH-ONLY merge: a sibling may have captured stable per-IG-post
      -- attributes a thin (e.g. Tier-1 preview) onboarding row missed, but we
      -- must never clobber our own good data with a sibling's stale value. The
      -- authoritative full content scrape (persistPosts) is what flips these
      -- back/forth. So: pinned is OR'd (add pinned a sibling saw, never unset),
      -- carousel only fills a gap (keep ours if present). Counts/URLs untouched.
      is_pinned = posts_cache.is_pinned OR EXCLUDED.is_pinned,
      carousel_media = COALESCE(posts_cache.carousel_media, EXCLUDED.carousel_media)
  `);
}

/**
 * Ownership predicate for a posts_cache row joined to its tracked_accounts row
 * (no alias): the user tracks that row directly, OR one of the user's ACTIVE
 * tracked rows observes the same IG user. Posts are collected on the canonical
 * twin only (audit 2026-09-02 C6), so a twin's dashboard shows posts whose
 * cache row belongs to a sibling owned by another customer; without this the
 * comments / likers drill-downs on those posts would 404 for that customer.
 * Nullable `ig_user_id` is guarded explicitly (lesson 23).
 */
function postOwnedByUserOrTwinSql(userId: string): SQL {
  return sql`${trackedAccounts.isActive} IS TRUE AND (
    (${trackedAccounts.userId} = ${userId}
      AND (${trackedAccounts.isPrivate} IS FALSE OR ${trackedAccounts.accessStatus} = 'has_access'))
    OR (
      ${trackedAccounts.isPrivate} IS FALSE
      AND ${trackedAccounts.igUserId} IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM tracked_accounts mine
         WHERE mine.user_id = ${userId}
           AND mine.is_active IS TRUE
           AND mine.is_private IS FALSE
           AND mine.ig_user_id = ${trackedAccounts.igUserId}
      )
    )
  )`;
}

function privateContentUnavailable(account: {
  isPrivate?: boolean | null;
  accessStatus?: string | null;
  isActive?: boolean | null;
}): boolean {
  return account.isPrivate === true && (account.accessStatus !== "has_access" || account.isActive === false);
}

// Public report history keeps its existing behavior. Private content requires
// the original row's current grant even when a cache/report already exists.
function currentPrivateContentAccessSql(): SQL {
  return or(eq(trackedAccounts.isPrivate, false), and(
    eq(trackedAccounts.isActive, true), eq(trackedAccounts.accessStatus, "has_access"),
  ))!;
}

function emptyPrivateRoster() {
  return {
    items: [], nextCursor: null, total: 0, lastUpdatedAt: null,
    loadedTotal: 0, expectedTotal: 0, reachableTotal: 0,
    enumerableCap: ROSTER_ENUMERABLE_CAP, background: null,
    lastCompleteReadAt: null, completionPct: null, syncState: "restricted",
    isPartial: true, failureKind: null, lastAttemptAt: null,
    lastSuccessfulAt: null, nextRetryAt: null, snapshotAt: null,
  };
}

type RealtimeRecipient = { id: string; userId: string };
// EventEmitter gives every subscriber the same event object. Share only that
// emission's validation; a later event always re-reads privacy and grants.
const realtimeRecipientsByEvent = new WeakMap<object, Promise<RealtimeRecipient[]>>();

async function loadRealtimeRecipients(trackedAccountId: string): Promise<RealtimeRecipient[]> {
  const [source] = await db.select({
    id: trackedAccounts.id, userId: trackedAccounts.userId,
    igUserId: trackedAccounts.igUserId, igUsername: trackedAccounts.igUsername,
    isPrivate: trackedAccounts.isPrivate,
  }).from(trackedAccounts).where(and(
    eq(trackedAccounts.id, trackedAccountId), eq(trackedAccounts.isActive, true),
    currentPrivateContentAccessSql(), customerAccessSql(trackedAccounts.userId),
  )).limit(1);
  if (!source) return [];
  if (source.isPrivate) return [{ id: source.id, userId: source.userId }];

  // Match the public twin identity rule: an unresolved recipient uses its
  // username; an established IG ID must match the source's established ID.
  const sameIdentity = or(
    source.igUserId?.trim() ? eq(trackedAccounts.igUserId, source.igUserId) : undefined,
    and(sql`(${trackedAccounts.igUserId} IS NULL OR length(trim(${trackedAccounts.igUserId})) = 0)`,
      eq(trackedAccounts.igUsername, source.igUsername)),
  );
  return db.select({ id: trackedAccounts.id, userId: trackedAccounts.userId })
    .from(trackedAccounts).where(and(
      eq(trackedAccounts.isActive, true), eq(trackedAccounts.isPrivate, false),
      customerAccessSql(trackedAccounts.userId),
      or(eq(trackedAccounts.id, source.id), sameIdentity),
    ));
}

function currentRealtimeRecipients(event: { trackedAccountId: string }): Promise<RealtimeRecipient[]> {
  const existing = realtimeRecipientsByEvent.get(event);
  if (existing) return existing;
  const pending = loadRealtimeRecipients(event.trackedAccountId).catch((err) => {
    logger.warn({ err, trackedAccountId: event.trackedAccountId }, "realtime audience validation failed; suppressing event");
    return [];
  });
  realtimeRecipientsByEvent.set(event, pending);
  return pending;
}

// Private engagement uses only the requesting customer's original account.
// Public canonical reuse is handled by the ownership predicate above.
async function findGrantedPostBot(userId: string, postAccountId: string, _igUserId: string | null): Promise<string | null> {
  const [requestedAccount] = await db.select({ id: trackedAccounts.id })
    .from(trackedAccounts)
    .where(and(
      eq(trackedAccounts.userId, userId),
      eq(trackedAccounts.isActive, true),
      eq(trackedAccounts.id, postAccountId),
    ))
    .limit(1);
  return requestedAccount ? findGrantedBotId(requestedAccount.id) : null;
}

/** Engagement may use a public twin's cache, but its media link must remain
 * bound to the current customer's own active row. No refresh or provider read. */
async function resolvePostEngagementMedia(
  urls: Iterable<string | null | undefined>,
  userId: string,
  post: { trackedAccountId: string; igUserId: string | null; isPrivate: boolean | null },
): Promise<Map<string, string>> {
  const originals = Array.from(urls).filter((url): url is string => typeof url === "string" && url.length > 0);
  if (!originals.length) return new Map();
  const [account] = await db.select({ id: trackedAccounts.id }).from(trackedAccounts)
    .where(and(eq(trackedAccounts.userId, userId), eq(trackedAccounts.isActive, true),
      or(and(eq(trackedAccounts.id, post.trackedAccountId), currentPrivateContentAccessSql()),
        !post.isPrivate && post.igUserId
          ? and(eq(trackedAccounts.isPrivate, false), eq(trackedAccounts.igUserId, post.igUserId))
          : undefined)))
    .orderBy(sql`CASE WHEN ${trackedAccounts.id} = ${post.trackedAccountId} THEN 0 ELSE 1 END`)
    .limit(1);
  return account ? resolveCachedMediaUrls(originals, { userId, trackedAccountId: account.id }) : new Map();
}

// Fix #14: reject private/reserved IP ranges so the img proxy can't be used
// as an SSRF gadget to hit metadata services or internal subnets.
function isPrivateOrReservedIp(address: string): boolean {
  if (!net.isIP(address)) return true;
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  // IPv6
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice(7);
    return isPrivateOrReservedIp(mapped);
  }
  return false;
}

function imageCacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function imageCachePaths(url: string): { body: string; meta: string } {
  const key = imageCacheKey(url);
  return {
    body: path.join(imageCacheDir, `${key}.body`),
    meta: path.join(imageCacheDir, `${key}.json`),
  };
}

async function readCachedImage(url: string): Promise<{
  body: Buffer;
  contentType: string;
} | null> {
  try {
    const paths = imageCachePaths(url);
    const [metaRaw, stat] = await Promise.all([
      fsp.readFile(paths.meta, "utf8"),
      fsp.stat(paths.body),
    ]);
    if (Date.now() - stat.mtimeMs > imageCacheMaxAgeMs) return null;
    const meta = JSON.parse(metaRaw) as { contentType?: string; byteSize?: number };
    const body = await fsp.readFile(paths.body);
    const contentType = meta.contentType ?? "image/jpeg";
    if (!stat.isFile() || body.length === 0 || body.length !== stat.size ||
        (meta.byteSize !== undefined && meta.byteSize !== body.length) ||
        !/^(image|video)\//i.test(contentType)) return null;
    return { body, contentType };
  } catch {
    return null;
  }
}

async function writeCachedImage(
  url: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  if (!body.length || !/^(image|video)\//i.test(contentType)) return;
  const paths = imageCachePaths(url);
  const suffix = `.${randomUUID()}.tmp`;
  try {
    await fsp.mkdir(imageCacheDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(paths.body + suffix, body, { flag: "wx" }),
      fsp.writeFile(
        paths.meta + suffix,
        JSON.stringify({ contentType, byteSize: body.length, cachedAt: new Date().toISOString() }),
        { flag: "wx" },
      ),
    ]);
    await fsp.rename(paths.body + suffix, paths.body);
    await fsp.rename(paths.meta + suffix, paths.meta);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "image cache write failed",
    );
  } finally {
    await Promise.all([fsp.rm(paths.body + suffix, { force: true }), fsp.rm(paths.meta + suffix, { force: true })]).catch(() => {});
  }
}

function sendMediaProxyFallback(res: Response, status = 204): void {
  if (res.headersSent || res.destroyed) return;
  res.set("Cache-Control", "private, no-store");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.status(status).end();
}

async function fetchMediaThroughGateway(
  url: string,
  maxBytes: number,
): Promise<{ body: Buffer; contentType: string } | null> {
  if (!process.env.PROXY_GATEWAY_HOST) return null;

  try {
    const [{ endpoint }] = await fetchEndpoints({
      count: 1,
      country: "US",
      purpose: "public-read",
    });
    if (!endpoint) return null;

    const { ProxyAgent, fetch: undiciFetch } = await import("undici");
    const dispatcher = new ProxyAgent(proxyAgentUriForEndpoint(endpoint));
    const response = await undiciFetch(url, {
      dispatcher,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.instagram.com/",
      },
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "[img-proxy] gateway upstream non-2xx",
      );
      return null;
    }

    const contentType = String(
      response.headers.get("content-type") ?? "application/octet-stream",
    ).split(";")[0];
    const lowerContentType = contentType.toLowerCase();
    if (
      !lowerContentType.startsWith("image/") &&
      !lowerContentType.startsWith("video/")
    ) {
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > maxBytes) return null;

    const body = Buffer.from(await response.arrayBuffer());
    // Undici decodes Content-Encoding before arrayBuffer(); compressed wire
    // length cannot be compared with the resulting image/video bytes.
    const contentEncoding = response.headers.get("content-encoding");
    const decoded = contentEncoding && contentEncoding.toLowerCase() !== "identity";
    if (!body.length || body.length > maxBytes || (!decoded && contentLength > 0 && body.length !== contentLength)) return null;
    return { body, contentType };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[img-proxy] gateway fetch failed",
    );
    return null;
  }
}

function seededRandom(seed: string): () => number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return () => {
    hash = ((hash * 1664525) + 1013904223) & 0xffffffff;
    return Math.abs(hash) / 0x7fffffff;
  };
}

// ─── Viewer query helpers ─────────────────────────────────────────────────────

const POST_TYPE_VALUES = ["all", "photo", "video", "reel", "carousel"] as const;
type PostTypeFilter = (typeof POST_TYPE_VALUES)[number];

function parsePostTypeFilter(v: string | undefined): PostTypeFilter {
  if (!v) return "all";
  const lower = v.toLowerCase();
  return (POST_TYPE_VALUES as ReadonlyArray<string>).includes(lower)
    ? (lower as PostTypeFilter)
    : "all";
}

/**
 * Validate an IANA timezone string. Returns the canonical name if Intl
 * accepts it, otherwise falls back to "UTC". This guards against invalid
 * or hostile input (e.g. "'; DROP TABLE; --") reaching Intl.DateTimeFormat.
 */
function validateTimezone(v: string | undefined): string {
  if (!v || v.length === 0) return "UTC";
  if (v.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return v;
  } catch {
    return "UTC";
  }
}

// ─── Mock viewer data ─────────────────────────────────────────────────────────

function generateViewerData(username: string) {
  const rand = seededRandom(username);
  const followers = Math.floor(rand() * 500000) + 1000;
  const following = Math.floor(rand() * 2000) + 100;
  const posts = Math.floor(rand() * 800) + 10;

  const NICHES = [
    "fitness", "travel", "food", "fashion", "tech", "gaming",
    "music", "art", "beauty", "lifestyle",
  ];
  const HASHTAGS = [
    "#instagood", "#photooftheday", "#love", "#fashion", "#fitness",
    "#travel", "#food", "#nature", "#style", "#photography",
  ];

  const topNiche = NICHES[Math.floor(rand() * NICHES.length)];
  const recentLikes = Array.from({ length: 8 }, (_, i) => {
    const owner = `${topNiche}_account_${Math.floor(rand() * 100)}`;
    const type = ["photo", "video", "reel"][Math.floor(rand() * 3)];
    return {
      postId: `mock_${username}_${i}`,
      ownerUsername: owner,
      postType: type,
      thumbnailUrl: `https://picsum.photos/seed/${username}${i}/300/300`,
      postUrl: `https://www.instagram.com/p/mock${username}${i}/`,
      hashtags: Array.from({ length: 3 }, () =>
        HASHTAGS[Math.floor(rand() * HASHTAGS.length)],
      ),
      detectedAt: new Date(
        Date.now() - Math.floor(rand() * 72) * 60 * 60 * 1000,
      ).toISOString(),
    };
  });

  const recentFollows = Array.from({ length: 5 }, (_, i) => ({
    followedUsername: `new_follow_${Math.floor(rand() * 1000)}`,
    followedDisplayName: `New Account ${i + 1}`,
    detectedAt: new Date(
      Date.now() - Math.floor(rand() * 48) * 60 * 60 * 1000,
    ).toISOString(),
  }));

  const activityByHour = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    count: Math.floor(rand() * 20),
  }));

  const peakHour = activityByHour.reduce((a, b) =>
    a.count > b.count ? a : b,
  ).hour;

  return {
    igUsername: username,
    displayName: username
      .replace(/[._]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    profilePicUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&size=200`,
    followerCount: followers,
    followingCount: following,
    postCount: posts,
    topNiche,
    peakActivityHour: peakHour,
    recentLikes,
    recentFollows,
    activityByHour,
    weeklyStats: {
      totalLikes: Math.floor(rand() * 150) + 10,
      totalFollows: Math.floor(rand() * 40) + 2,
      totalUnfollows: Math.floor(rand() * 15) + 1,
    },
  };
}

// ─── Route registration ───────────────────────────────────────────────────────

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  app.use(["/api/tracking", "/api/reports", "/api/viewer", "/api/media", "/api/img-proxy", "/api/realtime", "/api/notifications"],
    isAuthenticated, async (req, res, next) => {
      if (req.method === "DELETE") return next();
      // Admin galleries use the same authenticated image proxy but do not
      // require the support operator to own a customer subscription.
      if (req.user!.role === "admin" && (req.method === "GET" || req.method === "HEAD") &&
          (req.baseUrl === "/api/img-proxy" || req.baseUrl === "/api/media")) return next();
      try {
        if (!await customerHasAccess(req.user!.id)) {
          res.status(402).json({ code: "subscription_required", message: "An active paid subscription or Stripe trial is required." });
          return;
        }
        res.setHeader("Cache-Control", "private, no-store");
        next();
      } catch (err) { next(err); }
    });

  app.get("/api/health", (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      kind: "liveness",
      uptimeSec: Math.floor(process.uptime()),
      workersDisabled: process.env.WORKERS_DISABLED === "1",
      // Bot/proxy/queue readiness is intentionally separate from process
      // liveness. A collector outage must not trigger a PM2 restart loop, and
      // this endpoint must not be interpreted as proof that Instagram data is
      // flowing. Authenticated admins get full readiness at /api/admin/health.
      readinessPath: "/api/admin/health",
    });
  });

  app.use(createTrialPreviewMiddleware({
    isPreview: isTrialPreviewUser, isAvatar: isPermittedPreviewAvatar, sendPlaceholder: sendPreviewPlaceholder,
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // REAL-TIME EVENT STREAM (Server-Sent Events)
  // ══════════════════════════════════════════════════════════════════════════
  //
  // GET /api/realtime/events
  //   Streams change events for tracked accounts owned by the requesting user.
  //   Each event is one of:
  //     profile.updated    | profile snapshot just persisted
  //     posts.added        | N new posts in posts_cache
  //     stories.changed    | stories upserted/expired
  //     highlights.changed | highlights upserted
  //     followers.changed  | follower diff committed (added/removed)
  //     following.changed  | following diff committed
  //
  //   The dashboard subscribes once on mount and live-updates instead of
  //   polling on a fixed interval.
  app.get(
    "/api/realtime/events",
    isAuthenticated,
    async (req: Request, res: Response) => {
      const userId = req.user!.id;

      const { subscribeRealtime, ownedRealtimeEvents } = await import("./services/realtime-events.js");
      // Pre-load this user's tracked-account ids so we can filter the broadcast.
      const owned = await db
        .select({ id: trackedAccounts.id })
        .from(trackedAccounts)
        .where(and(eq(trackedAccounts.userId, userId), eq(trackedAccounts.isActive, true)));
      const { twinTrackedAccountIdMap } = await import("./services/tracked-account-twins.js");
      const ownedTwins = await twinTrackedAccountIdMap(owned.map(r => r.id));

      if (isShuttingDown()) { res.status(503).json({ message: "Server restarting; reconnect shortly" }); return; }
      if (res.destroyed) return;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      // Initial hello — lets the client confirm the connection is live.
      res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

      const unsubscribe = subscribeRealtime(async (event) => {
        if (closed) return;
        // The connection snapshot is only a cheap candidate filter. It must
        // never authorize a write after a privacy, ownership or grant change.
        const candidates = ownedRealtimeEvents(event, ownedTwins);
        if (candidates.length === 0) return;
        if (!await customerHasAccess(userId).catch(() => false)) { cleanup(); return; }
        const recipients = await currentRealtimeRecipients(event);
        if (closed) return;
        const currentIds = new Set(recipients.filter(row => row.userId === userId).map(row => row.id));
        // SSE connections outlive trial activation; use current billing for
        // each delivery rather than the connection's initial preview state.
        try {
          const preview = await isTrialPreviewUser(userId);
          for (const visible of candidates.filter(row => currentIds.has(row.trackedAccountId))) {
            const payload = JSON.stringify(preview ? sanitizeTrialPreview("realtime", visible, userId) : visible);
            res.write(`event: ${visible.kind}\ndata: ${payload}\n\n`);
          }
        } catch {
          // Async EventEmitter listeners must not reject or deliver raw data
          // when the billing lookup/projection fails. The client reconnects.
          cleanup();
        }
      });

      // Heartbeat every 25s to keep proxies (Nginx, Cloudflare) from
      // dropping the idle connection.
      const heartbeat = setInterval(async () => {
        if (!await customerHasAccess(userId).catch(() => false)) { cleanup(); return; }
        if (closed) return;
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }, 25_000);

      let closed = false;
      let removeShutdownListener = () => {};
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        removeShutdownListener();
        try {
          res.end();
        } catch {
          /* connection already closed */
        }
      };
      req.on("close", cleanup);
      req.on("aborted", cleanup);
      res.on("close", cleanup);
      removeShutdownListener = onShutdown(cleanup);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/config/refresh
  //   Surfaces the configured refresh cadence so the UI can show a
  //   "Updates every N min" indicator without hardcoding the schedule on
  //   the client. Reads from the same env vars the worker sweep uses
  //   (see workers.ts -> REFRESH_SWEEP_SEC).
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    "/api/config/refresh",
    isAuthenticated,
    async (_req: Request, res: Response) => {
      const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
      };

      const refreshSweepSec = parsePositiveInt(process.env.REFRESH_SWEEP_SEC, 900);
      const onboardingInitialDelayMs = Math.max(
        60_000,
        parsePositiveInt(process.env.ONBOARDING_SYNC_DELAY_MS, 60_000),
      );
      const tiers = {
        profileMin: parsePositiveInt(process.env.REFRESH_TIER_PROFILE_MIN, 5),
        contentMin: parsePositiveInt(process.env.REFRESH_TIER_CONTENT_MIN, 60),
        graphHours: parsePositiveInt(process.env.REFRESH_TIER_GRAPH_HOURS, 24),
      };

      res.json({ refreshSweepSec, onboardingInitialDelayMs, tiers });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // TRACKING ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/tracking/accounts
  app.get(
    "/api/tracking/accounts",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;

        const accounts = await db
          .select()
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.userId, userId), eq(trackedAccounts.isActive, true)))
          .orderBy(desc(trackedAccounts.trackingStarted));

        const accountIds = accounts.filter(a => !privateContentUnavailable(a)).map(a => a.id);

        if (accounts.length === 0) {
          res.json([]);
          return;
        }

        // likeCount must equal the viewer header: the twin union (every ACTIVE
        // row tracking the same IG user) deduped by post id, gated by THIS
        // row's tracking start. A per-row count here read 23 where the
        // dashboard read 37 for the same account.
        const [likeMap, followCounts] = await Promise.all([
          countVisibleLikedPostsByAccount(accountIds),
          // followCount stays the raw per-row log: the web client does not
          // render it; the viewer's gated totalFollows is the customer-facing
          // number.
          db.select({ trackedAccountId: followEvents.trackedAccountId, count: count() })
            .from(followEvents)
            .where(inArray(followEvents.trackedAccountId, accountIds))
            .groupBy(followEvents.trackedAccountId),
        ]);

        const followMap = new Map(followCounts.map(r => [r.trackedAccountId, r.count]));

        const accountsWithCounts = await Promise.all(accounts.map(async account => {
          // Use the same customer-bound cached avatar as the viewer. The
          // original CDN link may expire even while its saved image is intact.
          // Pending private profiles retain their public metadata URL because
          // their content-scoped media links are deliberately unavailable.
          const cachedAvatar = account.profilePicUrl && !privateContentUnavailable(account)
            ? await resolveCachedMediaUrls([account.profilePicUrl], {
                userId, trackedAccountId: account.id,
              })
            : new Map<string, string>();
          if (account.profilePicUrl && !privateContentUnavailable(account) &&
              !cachedAvatar.has(account.profilePicUrl)) {
            await enqueueMediaCacheUrls([account.profilePicUrl], "account-list").catch(err =>
              logger.warn({ module: "routes", route: "account-list", err: err instanceof Error ? err.message : String(err) },
                "failed to enqueue account avatar cache job"));
          }
          return {
            ...account,
            profilePicUrl: cachedAvatar.get(account.profilePicUrl ?? "") ?? account.profilePicUrl,
            likeCount: likeMap.get(account.id) ?? 0,
            followCount: followMap.get(account.id) ?? 0,
          };
        }));

        res.json(accountsWithCounts);
      } catch (err) {
        logger.error({ err }, "[GET /api/tracking/accounts] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // POST /api/tracking/accounts
  app.post(
    "/api/tracking/accounts",
    isAuthenticated,
    validateBody(addTrackedAccountSchema),
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const { igUsername } = req.body as AddTrackedAccountInput;

        const cleanUsername = igUsername.toLowerCase().replace(/^@/, "");

        // Serialize additions per user inside Postgres so two simultaneous
        // requests cannot both pass the count check and exceed the purchased
        // entitlement.
        const creation = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${"tracking:" + userId}))`,
          );

          const [sub] = await tx
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.userId, userId))
            .limit(1);

          const [duplicate] = await tx
            .select({ id: trackedAccounts.id })
            .from(trackedAccounts)
            .where(
              and(
                eq(trackedAccounts.userId, userId),
                eq(trackedAccounts.igUsername, cleanUsername),
                eq(trackedAccounts.isActive, true),
              ),
            )
            .limit(1);
          if (duplicate) {
            return { kind: "duplicate" as const };
          }

          const [existingCount] = await tx
            .select({ count: count() })
            .from(trackedAccounts)
            .where(
              and(
                eq(trackedAccounts.userId, userId),
                eq(trackedAccounts.isActive, true),
              ),
            );

          const accountLimit = accountLimitForSubscription(sub ?? {});
          const currentCount = existingCount?.count ?? 0;
          if (currentCount >= accountLimit) {
            const planName = sub?.plan
              ? BILLING_PLANS[sub.plan].name
              : "Subscription";
            return {
              kind: "limit" as const,
              accountLimit,
              currentCount,
              plan: sub?.plan ?? null,
              message:
                `${planName} access includes ${accountLimit} tracked ` +
                `account${accountLimit === 1 ? "" : "s"}.`,
            };
          }

          const [account] = await tx
            .insert(trackedAccounts)
            .values({
              userId,
              igUsername: cleanUsername,
              displayName: cleanUsername,
            })
            .returning();
          return { kind: "created" as const, account };
        });

        if (creation.kind === "duplicate") {
          res.status(409).json({ message: "You are already tracking this account" });
          return;
        }
        if (creation.kind === "limit") {
          res.status(402).json({
            code: "account_limit_reached",
            message: creation.message,
            plan: creation.plan,
            limit: creation.accountLimit,
            current: creation.currentCount,
          });
          return;
        }

        const newAccount = creation.account;
        if (!await customerHasAccess(userId)) { res.status(402).json({ code: "subscription_required", message: "Your subscription access has ended." }); return; }

        let syncStatus: "ready" | "pending" = "pending";
        let syncReason = "queued for background sync";

        // The same public IG profile may be tracked by more than one customer.
        // If a settled sibling graph already exists, reuse it immediately
        // instead of making the new tracking row display 0/N while an identical
        // multi-page scrape runs again.
        try {
          const reused = await reuseSettledRosterFromSibling(newAccount.id);
          if (reused.follower > 0 || reused.following > 0) {
            syncStatus = "ready";
            syncReason = "loaded from an existing verified roster";
          }
        } catch (err) {
          logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              trackedAccountId: newAccount.id,
            },
            "[onboarding] settled sibling roster reuse failed; continuing with background sync",
          );
        }

        // Instant onboarding: fetch PUBLIC profile data (pic/bio/counts +
        // recent posts) inline via the Tier-1 client — no bot lease, no
        // browser, one tiny unauthenticated JSON over a residential IP. This
        // makes the basics appear immediately instead of after a ≥60s
        // background sync. The Tier-1 client has its own tight timeout +
        // concurrency guard, so it can't hang the request or hammer IG during
        // signup bursts. On ANY failure we silently fall back to the existing
        // delayed background job below.
        try {
          const tier1 = await withScrapeContext(
            {
              userId,
              trackedAccountId: newAccount.id,
              username: cleanUsername,
            },
            () => fetchPublicProfileTier1(cleanUsername),
          );
          if (tier1.ok) {
            await applyProfileToDb(newAccount.id, tier1.profile);
            if (tier1.posts.length > 0) {
              await persistPosts(newAccount.id, tier1.posts, { preview: true });
            }
            syncStatus = "ready";
            syncReason = "loaded instantly";
          } else {
            syncReason = `instant fetch ${tier1.reason}; background sync queued`;
          }
        } catch (err) {
          logger.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              trackedAccountId: newAccount.id,
            },
            "[onboarding] tier-1 instant fetch failed; falling back to background",
          );
        }

        // Always enqueue the deep background job too: stories, highlights,
        // followers/following, private-account access, and a correction pass
        // for posts all still need the authenticated bot pipeline.
        await db.insert(collectionJobs).values({
          trackedAccountId: newAccount.id,
          jobType: "profile",
          status: "pending",
        });

        const initialDelayMs = Math.max(
          60_000,
          Number(process.env.ONBOARDING_SYNC_DELAY_MS ?? "60000"),
        );
        await collectionProfileQueue.add(
          "onboarding-profile",
          { trackedAccountId: newAccount.id, source: "onboarding" },
          {
            delay: initialDelayMs,
            jobId: `onboarding-profile_${newAccount.id}`,
            removeOnComplete: 100,
            removeOnFail: 50,
          },
        );

        // Install the per-account refresh scheduler. Idempotent — calling
        // twice for the same account is a no-op thanks to the stable
        // schedulerId.
        await registerAccountRefresh(collectionProfileQueue, newAccount.id);

        // Re-read the account row so the response reflects profile-sync
        // updates (pic, bio, follower count, igUserId, etc.) when available.
        const [hydrated] = await db
          .select()
          .from(trackedAccounts)
          .where(eq(trackedAccounts.id, newAccount.id))
          .limit(1);

        res.status(201).json({
          ...(hydrated ?? newAccount),
          _profileSync: {
            status: syncStatus,
            reason: syncReason,
            initialDelayMs,
          },
        });
      } catch (err) {
        logger.error({ err }, "[POST /api/tracking/accounts] error");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // DELETE /api/tracking/accounts/:id
  app.delete(
    "/api/tracking/accounts/:id",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [account] = await db
          .select()
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.id, id), eq(trackedAccounts.userId, userId)))
          .limit(1);

        if (!account) {
          res.status(404).json({ message: "Tracked account not found" });
          return;
        }

        await db
          .update(trackedAccounts)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(trackedAccounts.id, id));

        // Tear down the per-account refresh scheduler so deleted/deactivated
        // accounts don't keep ticking. This is best-effort: the account is
        // already inactive, and a scheduler cleanup miss should not surface as
        // a user-facing delete/add failure.
        try {
          await unregisterAccountRefresh(collectionProfileQueue, id);
        } catch (schedulerErr) {
          console.warn("[DELETE /api/tracking/accounts/:id] scheduler cleanup failed:", schedulerErr);
        }

        res.json({ message: "Account removed from tracking" });
      } catch (err) {
        logger.error({ err }, "[DELETE /api/tracking/accounts/:id] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/tracking/accounts/:id/report
  app.get(
    "/api/tracking/accounts/:id/report",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [account] = await db
          .select()
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.id, id), eq(trackedAccounts.userId, userId)))
          .limit(1);

        if (!account) {
          res.status(404).json({ message: "Tracked account not found" });
          return;
        }

        // Fetch latest 5 profile snapshots for this account
        const snapshots = await db
          .select()
          .from(profileSnapshots)
          .where(eq(profileSnapshots.trackedAccountId, id))
          .orderBy(desc(profileSnapshots.snapshotAt))
          .limit(5);

        // Serve cache instantly; if the profile is stale, kick a cheap Tier-1
        // refresh in the background (no bot, no browser). The client gets the
        // fresh data via the SSE profile.updated/posts.added events.
        maybeRevalidateTier1(account, snapshots[0]?.snapshotAt ?? null);

        if (privateContentUnavailable(account)) {
          res.json({ ...account, profileSnapshots: snapshots });
          return;
        }

        // Trigger report generation in background if none exists (fire-and-forget)
        const [latestReport] = await db
          .select()
          .from(reports)
          .where(eq(reports.trackedAccountId, id))
          .orderBy(desc(reports.createdAt))
          .limit(1);

        if (!latestReport && !res.locals?.trialPreview) {
          const now = new Date();
          const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

          db.insert(reports)
            .values({
              trackedAccountId: id,
              type: "weekly",
              periodStart,
              periodEnd: now,
              status: "generating",
            })
            .returning()
            .then(([newReport]) =>
              reportGenerateQueue.add("generate-report", { reportId: newReport.id }),
            )
            .catch((err) =>
              logger.error({ err }, "[GET /api/tracking/accounts/:id/report] background report error:"),
            );
        }

        // The dashboard header reads this report's avatar independently of
        // the viewer payload. Bind its cached image to the original account.
        const cachedAvatar = account.profilePicUrl
          ? await resolveCachedMediaUrls([account.profilePicUrl], { userId, trackedAccountId: account.id })
          : new Map<string, string>();
        if (account.profilePicUrl && !cachedAvatar.has(account.profilePicUrl)) {
          await enqueueMediaCacheUrls([account.profilePicUrl], "account-report").catch(err =>
            logger.warn({ module: "routes", route: "account-report", err: err instanceof Error ? err.message : String(err) },
              "failed to enqueue account avatar cache job"));
        }
        res.json({
          ...account,
          profilePicUrl: cachedAvatar.get(account.profilePicUrl ?? "") ?? account.profilePicUrl,
          profileSnapshots: snapshots,
        });
      } catch (err) {
        logger.error({ err }, "[GET /api/tracking/accounts/:id/report] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // POST /api/tracking/accounts/:id/report/generate
  // Manual/admin trigger: generate AND deliver a fresh weekly report on demand
  // (notification + email), so the weekly flow can be tested without waiting for
  // the scheduled sweep. Distinct from GET /report, which never delivers.
  app.post(
    "/api/tracking/accounts/:id/report/generate",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [account] = await db
          .select({ id: trackedAccounts.id, isPrivate: trackedAccounts.isPrivate,
            accessStatus: trackedAccounts.accessStatus, isActive: trackedAccounts.isActive })
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.id, id), eq(trackedAccounts.userId, userId)))
          .limit(1);

        if (!account || privateContentUnavailable(account)) {
          res.status(404).json({ message: "Tracked account not found" });
          return;
        }

        // Weekly (7d) or monthly (30d). The report builder already takes an
        // arbitrary window and compares against the previous equal-length
        // period, so a monthly report needs nothing more than a wider window +
        // the matching `type`. Anything unrecognised falls back to weekly.
        const period =
          firstParam(req.body?.period ?? req.query?.period) === "monthly"
            ? "monthly"
            : "weekly";
        const windowDays = period === "monthly" ? 30 : 7;

        const now = new Date();
        const periodStart = new Date(
          now.getTime() - windowDays * 24 * 60 * 60 * 1000,
        );

        const [newReport] = await db
          .insert(reports)
          .values({
            trackedAccountId: id,
            type: period,
            periodStart,
            periodEnd: now,
            status: "generating",
          })
          .returning({ id: reports.id });

        await reportGenerateQueue.add("generate-report", {
          reportId: newReport.id,
          deliver: true,
        });

        res.status(202).json({ reportId: newReport.id, period });
      } catch (err) {
        logger.error({ err }, "[POST /api/tracking/accounts/:id/report/generate] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/reports — all reports for the authenticated user's tracked accounts,
  // newest first, joined with the account username for display.
  app.get(
    "/api/reports",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const { limit, offset } = parsePagination(req.query);

        const items = await db
          .select({
            id: reports.id,
            trackedAccountId: reports.trackedAccountId,
            igUsername: trackedAccounts.igUsername,
            type: reports.type,
            status: reports.status,
            periodStart: reports.periodStart,
            periodEnd: reports.periodEnd,
            totalLikes: reports.totalLikes,
            // Legacy roster-DISCOVERY counters. Kept for older rows that predate
            // `metrics`; the UI must prefer metrics.summary when present, since
            // these can claim "+3,251 new followers" for a 674-follower account.
            totalFollows: reports.totalFollows,
            totalUnfollows: reports.totalUnfollows,
            topNiche: reports.topNiche,
            peakActivityHour: reports.peakActivityHour,
            metrics: reports.metrics,
            createdAt: reports.createdAt,
          })
          .from(reports)
          .innerJoin(
            trackedAccounts,
            eq(reports.trackedAccountId, trackedAccounts.id),
          )
          .where(and(eq(trackedAccounts.userId, userId), currentPrivateContentAccessSql()))
          .orderBy(desc(reports.createdAt))
          .limit(limit)
          .offset(offset);

        // Report metrics are persisted for historical accuracy, but their
        // Instagram thumbnail signatures are not historical: CDN URLs expire.
        // Prefer a durable app-owned asset when it exists and re-enqueue every
        // raw URL so old reports self-heal instead of silently losing their
        // leaderboard imagery.
        type LeaderboardRow = {
          username: string;
          count: number;
          thumbnails: string[];
        };
        type MetricsWithLeaderboard = {
          likesLeaderboard?: LeaderboardRow[];
          [key: string]: unknown;
        };
        const reportMediaUrls = new Set<string>();
        for (const item of items) {
          const metrics = item.metrics as MetricsWithLeaderboard | null;
          for (const row of metrics?.likesLeaderboard ?? []) {
            for (const url of row.thumbnails ?? []) {
              if (typeof url === "string" && url) reportMediaUrls.add(url);
            }
          }
        }
        const [cachedReportMedia] = await Promise.all([
          resolveCachedMediaUrls(reportMediaUrls),
          enqueueMediaCacheUrls(reportMediaUrls, "reports-view").catch((err) =>
            logger.warn(
              {
                module: "routes",
                route: "reports",
                err: err instanceof Error ? err.message : String(err),
              },
              "failed to enqueue report media",
            ),
          ),
        ]);
        const publicItems = items.map(({ trackedAccountId, ...item }) => {
          const metrics = item.metrics as MetricsWithLeaderboard | null;
          if (!metrics?.likesLeaderboard) return item;
          return {
            ...item,
            metrics: {
              ...metrics,
              likesLeaderboard: metrics.likesLeaderboard.map((row) => ({
                ...row,
                thumbnails: (row.thumbnails ?? []).map(
                  (url) => {
                    const cached = cachedReportMedia.get(url);
                    return cached ? signMediaUrl(cached.slice('/api/media/'.length), { userId, trackedAccountId }) : url;
                  },
                ),
              })),
            },
          };
        });

        res.json({ items: publicItems, limit, offset });
      } catch (err) {
        logger.error({ err }, "[GET /api/reports] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/reports/:id/pdf — download a report as a branded PDF.
  //
  // Rendered on demand from live data rather than stored: the report row only
  // holds summary counters, and re-rendering keeps a re-download consistent with
  // the data we hold now. The ownership join is what authorises the download —
  // a report id alone must never be enough to read another user's account.
  app.get(
    "/api/reports/:id/pdf",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [row] = await db
          .select({
            trackedAccountId: reports.trackedAccountId,
            type: reports.type,
            periodStart: reports.periodStart,
            periodEnd: reports.periodEnd,
          })
          .from(reports)
          .innerJoin(
            trackedAccounts,
            eq(reports.trackedAccountId, trackedAccounts.id),
          )
          .where(and(eq(reports.id, id), eq(trackedAccounts.userId, userId), currentPrivateContentAccessSql()))
          .limit(1);

        if (!row) {
          res.status(404).json({ message: "Report not found" });
          return;
        }

        const [{ buildReportData }, pdfMod] = await Promise.all([
          import("./services/report-data.js"),
          import("./services/report-pdf.js"),
        ]);
        const data = await buildReportData(
          row.trackedAccountId,
          row.periodStart,
          row.periodEnd,
          row.type,
        );
        const pdf = await pdfMod.renderReportPdf(data);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${pdfMod.reportPdfFilename(data)}"`,
        );
        // Client data — never let a shared cache hold on to it.
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Content-Length", String(pdf.length));
        res.end(pdf);
      } catch (err) {
        logger.error(
          { module: "routes", err: err instanceof Error ? err.message : String(err) },
          "[GET /api/reports/:id/pdf] failed",
        );
        if (!res.headersSent) {
          res.status(500).json({ message: "Failed to render report" });
        }
      }
    },
  );

  // GET /api/reports/:id/csv — download the account's activity log as CSV.
  //
  // Matches SnoopReport's "Download CSV" with a cleaner, documented schema.
  // Same ownership join as the PDF route authorises the download — a report id
  // alone must never expose another user's account.
  app.get(
    "/api/reports/:id/csv",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [row] = await db
          .select({
            trackedAccountId: reports.trackedAccountId,
            igUsername: trackedAccounts.igUsername,
            periodStart: reports.periodStart,
            periodEnd: reports.periodEnd,
          })
          .from(reports)
          .innerJoin(
            trackedAccounts,
            eq(reports.trackedAccountId, trackedAccounts.id),
          )
          .where(and(eq(reports.id, id), eq(trackedAccounts.userId, userId), currentPrivateContentAccessSql()))
          .limit(1);

        if (!row) {
          res.status(404).json({ message: "Report not found" });
          return;
        }

        const { buildReportCsv, reportCsvFilename } = await import(
          "./services/report-csv.js"
        );
        const csv = await buildReportCsv(
          row.trackedAccountId,
          row.periodStart,
          row.periodEnd,
        );

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${reportCsvFilename(row.igUsername, row.periodStart)}"`,
        );
        res.setHeader("Cache-Control", "private, no-store");
        res.end(csv);
      } catch (err) {
        logger.error(
          { module: "routes", err: err instanceof Error ? err.message : String(err) },
          "[GET /api/reports/:id/csv] failed",
        );
        if (!res.headersSent) {
          res.status(500).json({ message: "Failed to export CSV" });
        }
      }
    },
  );

  // GET /api/tracking/accounts/:id/feed
  app.get(
    "/api/tracking/accounts/:id/feed",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);
        const { limit, offset } = parsePagination(req.query);

        const [account] = await db
          .select()
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.id, id), eq(trackedAccounts.userId, userId)))
          .limit(1);

        if (!account) {
          res.status(404).json({ message: "Tracked account not found" });
          return;
        }

        // Boundary + unfollow trust built by the shared helper (identical to
        // the viewer), with roster state read from the canonical twin.
        if (privateContentUnavailable(account)) {
          res.json({ items: [], limit, offset });
          return;
        }
        const [
          { boundary: followingActivityBoundary, unfollowsTrusted },
          rosterAccountId,
        ] = await Promise.all([followActivityFilters(id), canonicalTwinId(id)]);

        // Liked-post evidence belongs to the IG USER, not to the row that
        // happens to track them: two customers tracking the same account each
        // scan independently and find different subsets. Read the union of the
        // twins so both dashboards show the same likes.
        const twinIds = await twinTrackedAccountIds(id);

        // Fetch enough from each source to compute the global page after
        // merge+sort. `limit * 3` breaks once one event type dominates.
        const pool = offset + limit;
        const [likeRows, follows, unfollows] = await Promise.all([
          db
            .select()
            .from(likeEvents)
            .where(
              and(
                inArray(likeEvents.trackedAccountId, twinIds),
                // Stays keyed on the REQUESTING account's tracking start: a
                // customer must never see likes observed before they started
                // tracking, however many twins contributed the row.
                likedPostAfterTrackingStart(account.trackingStarted),
              ),
            )
            // This is a detected-activity feed, not the post-date gallery.
            // Sort before limiting or a newly detected older post disappears.
            .orderBy(desc(likeEvents.detectedAt))
            // One post can arrive once per twin, so the page pool has to grow
            // with the twin count or the dedupe below would starve pagination.
            .limit(pool * twinIds.length),
          db
            .select()
            .from(followEvents)
            // Boundary + flip-flop + roster-contradiction gates (roster.ts).
            .where(
              visibleFollowEventsSql({
                trackedAccountId: id,
                rosterAccountId,
                boundary: followingActivityBoundary,
              }),
            )
            .orderBy(desc(followEvents.detectedAt))
            .limit(pool),
          unfollowsTrusted
            ? db
                .select({ id: rosterMembers.id, trackedAccountId: sql<string>`${id}`,
                  unfollowedUsername: rosterMembers.username,
                  detectedAt: sql<Date>`${rosterMembers.leftAt}`.mapWith(rosterMembers.leftAt) })
                .from(rosterMembers)
                .where(visibleRosterDeparturesSql(rosterAccountId, followingActivityBoundary))
                .orderBy(desc(rosterMembers.leftAt))
                .limit(pool)
            : Promise.resolve([]),
        ]);

        // Collapse the twin union to one row per post before merging.
        const likes = dedupeLikedPostsByPostId(likeRows);

        // Merge, sort, then apply offset+limit after merging
        const feed = [
          ...likes.map((e) => ({ ...e, eventType: "like" as const })),
          ...follows.map((e) => ({ ...e, eventType: "follow" as const })),
          ...unfollows.map((e) => ({ ...e, eventType: "unfollow" as const })),
        ]
          .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
          .slice(offset, offset + limit);

        // Activity cards need the same durable, customer-bound media as the
        // viewer. Resolve only this page and sign for the requesting row,
        // even when public evidence came from another customer's twin.
        const mediaUrls = feed.flatMap(event => event.eventType === "like" && event.thumbnailUrl ? [event.thumbnailUrl] : []);
        const [cachedMediaUrls] = account.isActive ? await Promise.all([
          resolveCachedMediaUrls(mediaUrls, { userId, trackedAccountId: id }),
          enqueueMediaCacheUrls(mediaUrls, "activity-feed").catch(err =>
            logger.warn({ err }, "failed to enqueue activity media cache jobs")),
        ]) : [new Map<string, string>()];
        const items = feed.map(event => event.eventType === "like"
          ? { ...event, thumbnailUrl: cachedMediaUrls.get(event.thumbnailUrl ?? "") ?? event.thumbnailUrl }
          : event);
        res.json({ items, limit, offset });
      } catch (err) {
        logger.error({ err }, "[GET /api/tracking/accounts/:id/feed] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/tracking/accounts/:id/access-status
  app.get(
    "/api/tracking/accounts/:id/access-status",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [account] = await db
          .select()
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.id, id), eq(trackedAccounts.userId, userId)))
          .limit(1);

        if (!account) {
          res.status(404).json({ message: "Tracked account not found" });
          return;
        }

        // Get follow requests for this account (without exposing bot details)
        const requests = await db
          .select({
            status: botFollowRequests.status,
            sentAt: botFollowRequests.sentAt,
            expiresAt: botFollowRequests.expiresAt,
            queuedAt: botFollowRequests.queuedAt,
            resolvedAt: botFollowRequests.resolvedAt,
          })
          .from(botFollowRequests)
          .where(eq(botFollowRequests.trackedAccountId, id))
          .orderBy(desc(botFollowRequests.queuedAt));

        res.json({
          isPrivate: account.isPrivate,
          accessStatus: account.accessStatus,
          followRequests: requests,
        });
      } catch (err) {
        logger.error({ err }, "[GET /api/tracking/accounts/:id/access-status] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/tracking/accounts/:id/followers/roster
  app.get(
    "/api/tracking/accounts/:id/followers/roster",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [account] = await db
          .select({
            id: trackedAccounts.id,
            lastFollowersRefreshAt: trackedAccounts.lastFollowersRefreshAt,
            igUsername: trackedAccounts.igUsername,
            isPrivate: trackedAccounts.isPrivate,
            accessStatus: trackedAccounts.accessStatus,
            isActive: trackedAccounts.isActive,
          })
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.id, id), eq(trackedAccounts.userId, userId)))
          .limit(1);

        if (!account) {
          res.status(404).json({ message: "Tracked account not found" });
          return;
        }

        if (privateContentUnavailable(account)) {
          res.json(emptyPrivateRoster());
          return;
        }

        const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, 5000)
          : 500;
        const cursor = res.locals?.trialPreview
          ? res.locals.trialPreviewCursor as string | undefined
          : typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;

        const [latestSnapshot] = await db
          .select({
            followerCount: profileSnapshots.followerCount,
            snapshotAt: profileSnapshots.snapshotAt,
          })
          .from(profileSnapshots)
          .where(eq(profileSnapshots.trackedAccountId, id))
          .orderBy(desc(profileSnapshots.snapshotAt))
          .limit(1);

        // Rosters live on the canonical twin (oldest active row for this IG user).
        const rosterAccountId = await canonicalTwinId(id);
        const [page, health] = await Promise.all([
          buildFollowersRoster(rosterAccountId, { limit, cursor }),
          getRosterSyncHealth(rosterAccountId, "follower"),
        ]);
        const rosterMediaUrls = page.items
          .map((item) => item.pfpUrl)
          .filter((url): url is string => Boolean(url));
        const [cachedRosterMedia] = await Promise.all([
          resolveCachedMediaUrls(rosterMediaUrls, { userId, trackedAccountId: id }),
          enqueueMediaCacheUrls(rosterMediaUrls, "followers-roster").catch(
            (err) =>
              logger.warn(
                {
                  module: "routes",
                  route: "followers-roster",
                  err: err instanceof Error ? err.message : String(err),
                },
                "failed to enqueue roster media",
              ),
          ),
        ]);
        const mediaPage = {
          ...page,
          items: page.items.map((item) => ({
            ...item,
            pfpUrl: item.pfpUrl
              ? (cachedRosterMedia.get(item.pfpUrl) ?? item.pfpUrl)
              : null,
          })),
        };
        // Profile counts and roster reads are not atomic. A fresh roster can
        // legitimately contain one or two more accounts than the latest
        // profile snapshot; never render impossible progress such as
        // "675 of 674" while waiting for the next profile refresh.
        const expectedTotal = Math.max(
          latestSnapshot?.followerCount ?? 0,
          page.total,
        );
        const background = await readBackgroundRosterView(rosterAccountId, account.igUsername, "follower");
        const syncState = backgroundRosterSyncState(background, computeRosterSyncState({
          loadedTotal: page.total,
          reportedTotal: expectedTotal,
          lastGraphRefreshAt: account.lastFollowersRefreshAt,
          baselineSettled: health.settled,
          failureKind: health.failureKind,
          nextRetryAt: health.nextRetryAt,
        }));
        // Progress is measured against what we can actually enumerate, not IG's
        // raw count — so huge accounts no longer read 0% forever.
        const reachableTotal = background?.enabled ? expectedTotal : Math.max(page.total, Math.min(expectedTotal, ROSTER_ENUMERABLE_CAP));
        const completionPct =
          reachableTotal > 0
            ? Math.min(100, Math.round((page.total / reachableTotal) * 100))
            : null;
        res.json({
          ...mediaPage,
          loadedTotal: page.total,
          expectedTotal,
          reachableTotal,
          enumerableCap: background?.enabled ? null : ROSTER_ENUMERABLE_CAP,
          background,
          lastCompleteReadAt: health.lastCompleteReadAt,
          completionPct,
          syncState,
          isPartial: syncState === "syncing" || syncState === "restricted",
          failureKind: health.failureKind,
          lastAttemptAt: health.lastAttemptAt,
          lastSuccessfulAt: health.lastSuccessAt,
          nextRetryAt: health.nextRetryAt,
          snapshotAt: latestSnapshot?.snapshotAt ?? null,
        });
      } catch (err) {
        logger.error({ err }, "[GET /api/tracking/accounts/:id/followers/roster] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/tracking/accounts/:id/following/roster
  app.get(
    "/api/tracking/accounts/:id/following/roster",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [account] = await db
          .select({
            id: trackedAccounts.id,
            lastFollowingRefreshAt: trackedAccounts.lastFollowingRefreshAt,
            igUsername: trackedAccounts.igUsername,
            isPrivate: trackedAccounts.isPrivate,
            accessStatus: trackedAccounts.accessStatus,
            isActive: trackedAccounts.isActive,
          })
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.id, id), eq(trackedAccounts.userId, userId)))
          .limit(1);

        if (!account) {
          res.status(404).json({ message: "Tracked account not found" });
          return;
        }

        if (privateContentUnavailable(account)) {
          res.json(emptyPrivateRoster());
          return;
        }

        const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, 5000)
          : 500;
        const cursor = res.locals?.trialPreview
          ? res.locals.trialPreviewCursor as string | undefined
          : typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;

        const [latestSnapshot] = await db
          .select({
            followingCount: profileSnapshots.followingCount,
            snapshotAt: profileSnapshots.snapshotAt,
          })
          .from(profileSnapshots)
          .where(eq(profileSnapshots.trackedAccountId, id))
          .orderBy(desc(profileSnapshots.snapshotAt))
          .limit(1);

        // Rosters live on the canonical twin (oldest active row for this IG user).
        const rosterAccountId = await canonicalTwinId(id);
        const [page, health] = await Promise.all([
          buildFollowingRoster(rosterAccountId, { limit, cursor }),
          getRosterSyncHealth(rosterAccountId, "following"),
        ]);
        const rosterMediaUrls = page.items
          .map((item) => item.pfpUrl)
          .filter((url): url is string => Boolean(url));
        const [cachedRosterMedia] = await Promise.all([
          resolveCachedMediaUrls(rosterMediaUrls, { userId, trackedAccountId: id }),
          enqueueMediaCacheUrls(rosterMediaUrls, "following-roster").catch(
            (err) =>
              logger.warn(
                {
                  module: "routes",
                  route: "following-roster",
                  err: err instanceof Error ? err.message : String(err),
                },
                "failed to enqueue roster media",
              ),
          ),
        ]);
        const mediaPage = {
          ...page,
          items: page.items.map((item) => ({
            ...item,
            pfpUrl: item.pfpUrl
              ? (cachedRosterMedia.get(item.pfpUrl) ?? item.pfpUrl)
              : null,
          })),
        };
        const expectedTotal = Math.max(
          latestSnapshot?.followingCount ?? 0,
          page.total,
        );
        const background = await readBackgroundRosterView(rosterAccountId, account.igUsername, "following");
        const syncState = backgroundRosterSyncState(background, computeRosterSyncState({
          loadedTotal: page.total,
          reportedTotal: expectedTotal,
          lastGraphRefreshAt: account.lastFollowingRefreshAt,
          baselineSettled: health.settled,
          failureKind: health.failureKind,
          nextRetryAt: health.nextRetryAt,
        }));
        const reachableTotal = background?.enabled ? expectedTotal : Math.max(page.total, Math.min(expectedTotal, ROSTER_ENUMERABLE_CAP));
        const completionPct =
          reachableTotal > 0
            ? Math.min(100, Math.round((page.total / reachableTotal) * 100))
            : null;
        res.json({
          ...mediaPage,
          loadedTotal: page.total,
          expectedTotal,
          reachableTotal,
          enumerableCap: background?.enabled ? null : ROSTER_ENUMERABLE_CAP,
          background,
          lastCompleteReadAt: health.lastCompleteReadAt,
          completionPct,
          syncState,
          isPartial: syncState === "syncing" || syncState === "restricted",
          failureKind: health.failureKind,
          lastAttemptAt: health.lastAttemptAt,
          lastSuccessfulAt: health.lastSuccessAt,
          nextRetryAt: health.nextRetryAt,
          snapshotAt: latestSnapshot?.snapshotAt ?? null,
        });
      } catch (err) {
        logger.error({ err }, "[GET /api/tracking/accounts/:id/following/roster] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/tracking/accounts/:id/posts?offset=<n>&limit=<n>
  //
  // Instagram-posts feature: cursor-free "load more older posts" for the grid.
  // Reads the account's cached posts ordered pinned-first then takenAt desc
  // (identical to the viewer), paginated by offset/limit. When the requested
  // window runs past what we have cached, we SYNCHRONOUSLY scrape deeper from
  // the top (next_max_id walk) and persist through the shared persistPosts
  // writer — so isPinned / carouselMedia are populated consistently — then
  // re-query the cache. The deep scrape is capped at 96 posts to bound bot
  // cost, and any scrape failure degrades gracefully to the cached view.
  app.get(
    "/api/tracking/accounts/:id/posts",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [account] = await db
          .select({
            id: trackedAccounts.id,
            igUserId: trackedAccounts.igUserId,
            isPrivate: trackedAccounts.isPrivate,
            accessStatus: trackedAccounts.accessStatus,
            postsNextCursor: trackedAccounts.postsNextCursor,
            postsPaginationDone: trackedAccounts.postsPaginationDone,
          })
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.id, id), eq(trackedAccounts.userId, userId), eq(trackedAccounts.isActive, true)))
          .limit(1);

        if (!account) {
          res.status(404).json({ message: "Tracked account not found" });
          return;
        }

        // Posts are collected on the canonical twin only (audit 2026-09-02
        // C6), so the cached view, the sibling backfill and the on-demand deep
        // scrape all key on that row: every twin's "load more" walks ONE shared
        // cache with ONE cursor. Ownership was checked on the requesting row
        // above; a canonical row that cannot be loaded falls back to it.
        const contentAccountId = await canonicalTwinId(account.id);
        const [canonicalRow] =
          contentAccountId === account.id
            ? [account]
            : await db
                .select({
                  id: trackedAccounts.id,
                  igUserId: trackedAccounts.igUserId,
                  isPrivate: trackedAccounts.isPrivate,
                  postsNextCursor: trackedAccounts.postsNextCursor,
                  postsPaginationDone: trackedAccounts.postsPaginationDone,
                })
                .from(trackedAccounts)
                .where(eq(trackedAccounts.id, contentAccountId))
                .limit(1);
        const contentAccount = canonicalRow ?? account;

        // Clamp the page window: limit defaults to 12, hard-capped at 24
        // (matches the feed/user page size); offset floors at 0.
        const rawLimit = parseInt(String(req.query.limit ?? "12"), 10);
        const limit = Math.min(
          24,
          Math.max(1, Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 12),
        );
        const rawOffset = parseInt(String(req.query.offset ?? "0"), 10);
        const offset = Math.max(
          0,
          Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0,
        );
        const postTypeFilter = parsePostTypeFilter(
          typeof req.query.postType === "string" ? req.query.postType : undefined,
        );

        if (privateContentUnavailable(account)) {
          res.json({ items: [], offset, limit, hasMore: false });
          return;
        }

        // Total posts we expect to serve before deciding whether to scrape
        // deeper. Capped at 96 so a single load-more click can never trigger
        // an unbounded backfill.
        const POSTS_DEEP_CAP = 96;
        const neededDepth = Math.min(offset + limit, POSTS_DEEP_CAP);

        const loadCachedPosts = async (): Promise<typeof postsCache.$inferSelect[]> => {
          const rows = await db
            .select()
            .from(postsCache)
            .where(eq(postsCache.trackedAccountId, contentAccount.id))
            .orderBy(sql`${postsCache.takenAt} DESC NULLS LAST`, asc(postsCache.shortcode));
          // Dedupe by shortcode (defensive, mirrors the viewer) then float
          // pinned posts to the top preserving takenAt-desc within groups.
          const deduped = Array.from(
            new Map(rows.map((p) => [p.shortcode, p])).values(),
          );
          return pinnedFirstPosts(deduped);
        };

        let ordered = await loadCachedPosts();
        let paginationDone = contentAccount.postsPaginationDone;

        // 1) Cross-user reuse: if other tracked accounts follow the SAME IG
        //    profile and already hold posts we don't, copy them in — a second
        //    tracker inherits the first's scraped posts with no IG hit.
        if (postTypeFilter === "all" && ordered.length < neededDepth && contentAccount.igUserId && !account.isPrivate && !contentAccount.isPrivate) {
          try {
            await backfillPostsFromSiblings(contentAccount.id, contentAccount.igUserId);
            ordered = await loadCachedPosts();
          } catch (copyErr) {
            logger.warn(
              {
                module: "routes",
                route: "tracking-posts",
                trackedAccountId: contentAccount.id,
                err: copyErr instanceof Error ? copyErr.message : String(copyErr),
              },
              "[GET /api/tracking/accounts/:id/posts] sibling backfill failed; continuing",
            );
          }
        }

        // 2) Still short? Scrape OLDER pages on demand, cursor-based: advance
        //    from the stored next_max_id instead of re-paging from the top, so
        //    each click fetches only new pages. Every scraped page is persisted
        //    via the shared writer, so future clicks — and other users tracking
        //    this same profile — reuse it. Bounded by POSTS_DEEP_CAP + a page cap.
        if (postTypeFilter === "all" && ordered.length < neededDepth && contentAccount.igUserId && !paginationDone) {
          const MAX_PAGES_PER_REQUEST = 4;
          let cursor = contentAccount.postsNextCursor ?? undefined;
          const seenCursors = new Set(cursor ? [cursor] : []);
          let pages = 0;
          try {
            const isPrivate = account.isPrivate || contentAccount.isPrivate;
            const grantedBotId = isPrivate ? await findGrantedBotId(account.id) : null;
            // A pending/private account must never fall through to a random
            // public reader: its empty feed could falsely exhaust this cursor.
            if (isPrivate && !grantedBotId) {
              throw new Error("Approved private-account session is temporarily unavailable");
            }
            while (
              ordered.length < neededDepth &&
              !paginationDone &&
              pages < MAX_PAGES_PER_REQUEST
            ) {
              const pageOptions = { maxId: cursor, count: 24 };
              const page = grantedBotId
                ? await scrapeUserPostsPageWithBot(grantedBotId, contentAccount.igUserId, pageOptions)
                : await scrapeUserPostsPage(contentAccount.igUserId, pageOptions);
              pages += 1;
              // A continuation without progress is not evidence of exhaustion.
              // Leave the durable cursor retryable when the provider returns
              // a missing/repeated cursor or an empty continuing page.
              if (page.moreAvailable && (!page.nextMaxId || seenCursors.has(page.nextMaxId) || page.posts.length === 0)) {
                throw new Error("Post history pagination did not provide a valid continuation");
              }
              if (page.posts.length > 0) {
                await persistPosts(contentAccount.id, page.posts);
              }
              paginationDone = !page.moreAvailable;
              cursor = paginationDone ? undefined : page.nextMaxId!;
              if (cursor) seenCursors.add(cursor);
              ordered = await loadCachedPosts();
              if (page.posts.length === 0) break;
            }
            // Persist the advanced cursor + exhaustion flag for the next click.
            await db
              .update(trackedAccounts)
              .set({
                postsNextCursor: cursor ?? null,
                postsPaginationDone: paginationDone,
                updatedAt: new Date(),
              })
              .where(eq(trackedAccounts.id, contentAccount.id));
          } catch (scrapeErr) {
            logger.warn(
              {
                module: "routes",
                route: "tracking-posts",
                trackedAccountId: contentAccount.id,
                err:
                  scrapeErr instanceof Error
                    ? scrapeErr.message
                    : String(scrapeErr),
              },
              "[GET /api/tracking/accounts/:id/posts] deep scrape failed; serving cached view",
            );
          }
        }

        // A type filter browses saved evidence; it must not walk upstream
        // history looking for matches. Filter the full canonical cache before
        // applying the page window, independently of the recent All preview.
        const filtered = ordered.filter(p => postTypeFilter === "all" || p.postType === postTypeFilter);
        const postCounts: Record<PostTypeFilter, number> = { all: ordered.length, photo: 0, video: 0, reel: 0, carousel: 0 };
        for (const post of ordered) {
          if (post.postType === "photo" || post.postType === "video" || post.postType === "reel" || post.postType === "carousel") postCounts[post.postType]++;
        }
        const pageRows = filtered.slice(offset, offset + limit);

        // Resolve cached/proxied media URLs exactly like the viewer endpoint.
        const originalMediaUrls = new Set<string>();
        for (const p of pageRows) {
          if (p.thumbnailUrl) originalMediaUrls.add(p.thumbnailUrl);
          if (p.displayUrl) originalMediaUrls.add(p.displayUrl);
          if (p.videoUrl) originalMediaUrls.add(p.videoUrl);
          for (const child of p.carouselMedia ?? []) {
            if (child.displayUrl) originalMediaUrls.add(child.displayUrl);
            if (child.videoUrl) originalMediaUrls.add(child.videoUrl);
          }
        }
        const [cachedMediaUrls] = await Promise.all([
          resolveCachedMediaUrls(originalMediaUrls, { userId, trackedAccountId: account.id }),
          enqueueMediaCacheUrls(originalMediaUrls, "tracking-posts").catch(
            (err) =>
              logger.warn(
                {
                  module: "routes",
                  route: "tracking-posts",
                  err: err instanceof Error ? err.message : String(err),
                },
                "failed to enqueue media cache jobs",
              ),
          ),
        ]);
        const cachedMediaUrl = <T extends string | null | undefined>(
          url: T,
        ): T => {
          if (!url) return url;
          return (cachedMediaUrls.get(url) ?? url) as T;
        };

        const items = pageRows.map((p) => ({
          shortcode: p.shortcode,
          postType: p.postType,
          thumbnailUrl: cachedMediaUrl(p.thumbnailUrl),
          displayUrl: cachedMediaUrl(p.displayUrl),
          videoUrl: cachedMediaUrl(p.videoUrl),
          caption: p.caption,
          likeCount: p.likeCount ?? 0,
          commentCount: p.commentCount ?? 0,
          videoViewCount: p.videoViewCount,
          takenAt: p.takenAt,
          isPinned: p.isPinned,
          carouselMedia: p.carouselMedia
            ? p.carouselMedia.map((child) => ({
                ...child,
                displayUrl: cachedMediaUrl(child.displayUrl),
                videoUrl: cachedMediaUrl(child.videoUrl),
              }))
            : null,
        }));

        // More to show if there are cached rows beyond this window, or IG still
        // has older posts we haven't exhausted yet.
        const moreCached = filtered.length > offset + limit;
        const hasMore = moreCached || (postTypeFilter === "all" && !paginationDone);

        res.json({ items, offset, limit, hasMore, total: filtered.length, postsTotal: ordered.length, postCounts });
      } catch (err) {
        logger.error({ err }, "[GET /api/tracking/accounts/:id/posts] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/tracking/posts/:shortcode/comments
  //
  // Wave 5: surface scraped comments for one post the authenticated user
  // owns (i.e. the post belongs to a tracked_account they track). Reads from
  // comments_cache; with ?refresh=true and a >5min staleness window, leases
  // a bot, scrapes fresh comments, persists, then returns the cached view.
  //
  // The 5-minute floor protects bots from rapid-fire refresh spam (e.g. a
  // user mashing the refresh button on the post detail panel) while still
  // letting genuine "is there new activity?" checks through after a wait.
  app.get(
    "/api/tracking/posts/:shortcode/comments",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const shortcode = String(req.params.shortcode ?? "").trim();
        if (!shortcode) {
          res.status(400).json({ message: "shortcode is required" });
          return;
        }
        const refresh =
          String(req.query.refresh ?? "false").toLowerCase() === "true";

        // Ownership check: the user must track the account that owns this
        // post. Joins tracked_accounts → posts_cache to filter by user.
        const [post] = await db
          .select({
            shortcode: postsCache.shortcode,
            mediaId: postsCache.mediaId,
            trackedAccountId: postsCache.trackedAccountId,
            igUserId: trackedAccounts.igUserId,
            isPrivate: trackedAccounts.isPrivate,
            commentCount: postsCache.commentCount,
          })
          .from(postsCache)
          .innerJoin(
            trackedAccounts,
            eq(postsCache.trackedAccountId, trackedAccounts.id),
          )
          .where(
            and(
              eq(postsCache.shortcode, shortcode),
              postOwnedByUserOrTwinSql(userId),
            ),
          )
          .limit(1);

        if (!post) {
          res.status(404).json({ message: "Post not found" });
          return;
        }

        // Optional refresh: only scrape if the user explicitly asked AND
        // we haven't refreshed in the last 5 minutes.
        if (refresh && interactiveScrapeEnabled) {
          if (!post.mediaId) {
            res.status(409).json({
              message:
                "Post is missing media_id and cannot be refreshed; wait for the next scrape cycle.",
            });
            return;
          }

          await refreshEngagementOnce(post.mediaId, "comments", async () => {
            const grantedBotId = post.isPrivate ? await findGrantedPostBot(userId, post.trackedAccountId, post.igUserId) : null;
            if (post.isPrivate && !grantedBotId) return false;
            const result = grantedBotId
              ? await getPostCommentsAsBot(shortcode, post.mediaId!, grantedBotId)
              : await getPostComments(shortcode, post.mediaId!);
            if (result.ok) {
              try {
                await persistComments(shortcode, result.data);
                return true;
              } catch (persistErr) {
                logger.warn(
                  { shortcode, err: persistErr },
                  "[GET /api/tracking/posts/:shortcode/comments] persist failed",
                );
              }
            } else {
              logger.warn(
                { shortcode, err: result.error },
                "[GET /api/tracking/posts/:shortcode/comments] scrape failed; serving cached view",
              );
            }
            return false;
          });
        }

        // Read back from cache (newest first), capped at 200.
        const rows = await db
          .select({
            author: commentsCache.authorUsername,
            displayName: commentsCache.authorDisplayName,
            pfpUrl: commentsCache.authorPfpUrl,
            text: commentsCache.text,
            likeCount: commentsCache.likeCount,
            createdAt: commentsCache.createdAtIg,
          })
          .from(commentsCache)
          .where(eq(commentsCache.postShortcode, shortcode))
          .orderBy(desc(commentsCache.createdAtIg))
          .limit(200);

        const cachedMediaUrls = await resolvePostEngagementMedia(rows.map(row => row.pfpUrl), userId, post);
        const items = rows.map((r) => ({
          author: r.author,
          displayName: r.displayName,
          pfpUrl: cachedMediaUrls.get(r.pfpUrl ?? "") ?? r.pfpUrl,
          text: r.text,
          likeCount: r.likeCount,
          createdAt: r.createdAt,
        }));

        res.set("Cache-Control", "no-store");
        const expectedTotal = Math.max(post.commentCount ?? 0, items.length);
        res.json({
          items,
          total: items.length,
          expectedTotal,
          isPartial: expectedTotal > items.length,
        });
      } catch (err) {
        logger.error(
          { err },
          "[GET /api/tracking/posts/:shortcode/comments] error",
        );
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/tracking/posts/:shortcode/likers
  //
  // Wave 5: surface the users who liked one post the authenticated user
  // owns. Mirrors the comments endpoint above but uses IG's
  // /api/v1/media/<media_id>/likers/ which returns up to ~100 users in a
  // single page (no pagination cursor). With ?refresh=true and a >5min
  // staleness window we lease a bot, scrape fresh likers, persist (idempotent
  // ON CONFLICT DO NOTHING), then return the cached view.
  app.get(
    "/api/tracking/posts/:shortcode/likers",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const shortcode = String(req.params.shortcode ?? "").trim();
        if (!shortcode) {
          res.status(400).json({ message: "shortcode is required" });
          return;
        }
        const refresh =
          String(req.query.refresh ?? "false").toLowerCase() === "true";

        // Ownership check: the user must track the account that owns this
        // post. Same join as the comments handler — if no row matches the
        // post is either unknown or owned by a different user.
        const [post] = await db
          .select({
            shortcode: postsCache.shortcode,
            mediaId: postsCache.mediaId,
            trackedAccountId: postsCache.trackedAccountId,
            igUserId: trackedAccounts.igUserId,
            isPrivate: trackedAccounts.isPrivate,
            likeCount: postsCache.likeCount,
          })
          .from(postsCache)
          .innerJoin(
            trackedAccounts,
            eq(postsCache.trackedAccountId, trackedAccounts.id),
          )
          .where(
            and(
              eq(postsCache.shortcode, shortcode),
              postOwnedByUserOrTwinSql(userId),
            ),
          )
          .limit(1);

        if (!post) {
          res.status(404).json({ message: "Post not found" });
          return;
        }

        // Optional refresh: only scrape if the user explicitly asked AND
        // we haven't refreshed in the last 5 minutes. Same anti-spam floor
        // as the comments handler.
        if (refresh && interactiveScrapeEnabled) {
          if (!post.mediaId) {
            res.status(409).json({
              message:
                "Post is missing media_id and cannot be refreshed; wait for the next scrape cycle.",
            });
            return;
          }

          await refreshEngagementOnce(post.mediaId, "likers", async () => {
            const grantedBotId = post.isPrivate ? await findGrantedPostBot(userId, post.trackedAccountId, post.igUserId) : null;
            if (post.isPrivate && !grantedBotId) return false;
            const result = grantedBotId
              ? await getPostLikersAsBot(shortcode, post.mediaId!, grantedBotId)
              : await getPostLikers(shortcode, post.mediaId!);
            if (result.ok) {
              try {
                await persistLikers(shortcode, result.data);
                return true;
              } catch (persistErr) {
                logger.warn(
                  { shortcode, err: persistErr },
                  "[GET /api/tracking/posts/:shortcode/likers] persist failed",
                );
              }
            } else {
              logger.warn(
                { shortcode, err: result.error },
                "[GET /api/tracking/posts/:shortcode/likers] scrape failed; serving cached view",
              );
            }
            return false;
          });
        }

        // Read back from cache (most recently captured first), capped at 200
        // to mirror the comments response shape.
        const rows = await db
          .select({
            username: likersCache.likerUsername,
            displayName: likersCache.likerDisplayName,
            pfpUrl: likersCache.likerPfpUrl,
            igUserId: likersCache.likerIgUserId,
            isVerified: likersCache.isVerified,
            cachedAt: likersCache.cachedAt,
          })
          .from(likersCache)
          .where(eq(likersCache.postShortcode, shortcode))
          .orderBy(desc(likersCache.cachedAt))
          .limit(200);

        const cachedMediaUrls = await resolvePostEngagementMedia(rows.map(row => row.pfpUrl), userId, post);
        const items = rows.map((r) => ({
          username: r.username,
          displayName: r.displayName,
          pfpUrl: cachedMediaUrls.get(r.pfpUrl ?? "") ?? r.pfpUrl,
          igUserId: r.igUserId,
          isVerified: r.isVerified ?? false,
          cachedAt: r.cachedAt,
        }));

        res.set("Cache-Control", "no-store");
        const expectedTotal = Math.max(post.likeCount ?? 0, items.length);
        res.json({
          items,
          total: items.length,
          expectedTotal,
          isPartial: expectedTotal > items.length,
        });
      } catch (err) {
        logger.error(
          { err },
          "[GET /api/tracking/posts/:shortcode/likers] error",
        );
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // POST /api/tracking/accounts/:id/retry-access
  app.post(
    "/api/tracking/accounts/:id/retry-access",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [account] = await db
          .select()
          .from(trackedAccounts)
          .where(and(eq(trackedAccounts.id, id), eq(trackedAccounts.userId, userId)))
          .limit(1);

        if (!account) {
          res.status(404).json({ message: "Tracked account not found" });
          return;
        }

        if (!account.isPrivate) {
          res.status(400).json({ message: "This account is not private" });
          return;
        }

        if (!account.isActive) {
          res.status(409).json({ message: "Resume tracking before requesting private access" });
          return;
        }

        // A customer retry must not drop working access or create another
        // visible follow request while an existing attempt is still pending.
        if (account.accessStatus === "has_access") {
          res.json({ message: "Private access is already granted", status: "has_access" });
          return;
        }
        const [activeRequest] = await db.select({ status: botFollowRequests.status })
          .from(botFollowRequests)
          .where(and(eq(botFollowRequests.trackedAccountId, id), inArray(botFollowRequests.status, ["queued", "pending", "accepted"])))
          .orderBy(desc(botFollowRequests.resolvedAt))
          .limit(1);
        if (activeRequest) {
          res.json({
            message: activeRequest.status === "accepted" ? "Private access is already granted" : "An access request is already in progress",
            status: activeRequest.status === "accepted" ? "has_access" : "pending_access",
          });
          return;
        }
        // Assignment updates access status atomically with the reserved bot.

        // Try to assign a new bot
        const requestId = await rotateBotForTrackedAccount(id);

        if (requestId) {
          const delay = Math.floor(Math.random() * 90000) + 30000;
          await botFollowRequestQueue.add("send-follow", { botFollowRequestId: requestId }, { delay });
          res.json({ message: "New access attempt initiated", status: "pending_access" });
        } else {
          // Try fresh assignment if rotation found no bots
          const freshId = await assignBotToTrackedAccount(id);
          if (freshId) {
            const delay = Math.floor(Math.random() * 90000) + 30000;
            await botFollowRequestQueue.add("send-follow", { botFollowRequestId: freshId }, { delay });
            res.json({ message: "New access attempt initiated", status: "pending_access" });
          } else {
            res.status(503).json({ message: "No bot accounts available. Please try again later." });
          }
        }
      } catch (err) {
        logger.error({ err }, "[POST /api/tracking/accounts/:id/retry-access] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // ACCOUNT ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // PUT /api/account/profile
  app.put(
    "/api/account/profile",
    isAuthenticated,
    validateBody(updateProfileSchema),
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const { name, email, emailAlerts, pushNotifications } =
          req.body as UpdateProfileInput;

        const updateFields: Record<string, unknown> = { updatedAt: new Date() };

        if (email !== undefined) {
          const [conflict] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

          if (conflict && conflict.id !== userId) {
            res.status(409).json({ message: "Email is already in use by another account" });
            return;
          }
          updateFields.email = email;
        }

        if (name !== undefined) {
          updateFields.name = name;
        }

        // Notification preferences now persist server-side (migration 0032) so
        // the report-email opt-out is actually honoured and follows the user
        // across devices, instead of living only in the browser's localStorage.
        if (emailAlerts !== undefined) {
          updateFields.emailAlerts = emailAlerts;
        }
        if (pushNotifications !== undefined) {
          updateFields.pushNotifications = pushNotifications;
        }

        const [updated] = await db
          .update(users)
          .set(updateFields)
          .where(eq(users.id, userId))
          .returning();

        const { hashedPassword: _omit, ...safeUser } = updated;
        res.json(safeUser);
      } catch (err) {
        logger.error({ err }, "[PUT /api/account/profile] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // PUT /api/account/password
  app.put(
    "/api/account/password",
    isAuthenticated,
    validateBody(updatePasswordSchema),
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const { currentPassword, newPassword } = req.body as UpdatePasswordInput;

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        if (!user?.hashedPassword) {
          res.status(400).json({ message: "Account does not have a password set" });
          return;
        }

        const valid = await bcrypt.compare(currentPassword, user.hashedPassword);
        if (!valid) {
          res.status(400).json({ message: "Current password is incorrect" });
          return;
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);

        const sessionVersion = await changeCustomerPassword(userId, user.hashedPassword, hashedPassword);
        if (sessionVersion === null) {
          res.status(409).json({ message: "Credentials changed during this request. Sign in again and retry." });
          return;
        }
        if (!req.mobileAuth) {
          // Current-password verification allows THIS browser to receive a new
          // version-bound session. Every other device/session was revoked.
          await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
          await new Promise<void>((resolve, reject) => req.login({ ...user, hashedPassword, sessionVersion }, error => error ? reject(error) : resolve()));
          issueCsrfCookie(res);
        }
        res.json({ message: "Password updated successfully", reauthenticationRequired: !!req.mobileAuth });
      } catch (err) {
        logger.error({ err }, "[PUT /api/account/password] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // DELETE /api/account
  app.delete(
    "/api/account",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;

        // Billing closure and local deletion must succeed before logging out.
        // On a billing outage the customer keeps their account/session to retry.
        if (req.user!.role === "admin") {
          res.status(403).json({ message: "Admin accounts cannot be deleted through account settings. An operator must remove the admin role first." });
          return;
        }
        await deleteCustomerAccount(userId, stripe);
        // The account and every durable credential are gone. Do not turn a
        // redundant session-store cleanup failure into a false deletion error.
        req.user = undefined;
        await new Promise<void>((resolve) => {
          req.session.destroy(() => resolve());
        });

        res.clearCookie("cheaterfinder.sid");
        res.clearCookie("csrf_token", { path: "/" });

        res.json({ message: "Account deleted successfully" });
      } catch (err) {
        if (err instanceof CustomerBillingBusyError || err instanceof CustomerDeletionBillingError || err instanceof CustomerAccountMissingError) {
          res.status(err instanceof CustomerBillingBusyError ? 409 : err instanceof CustomerAccountMissingError ? 401 : 503).json({ message: err.message });
          return;
        }
        logger.error({ err }, "[DELETE /api/account] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BILLING ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  app.post("/api/billing/activate-now", isAuthenticated, async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!stripe) { res.status(503).json({ message: "Billing is unavailable. Please retry shortly." }); return; }
    try {
      // Only Stripe is mutated here. The existing webhook/sync path verifies
      // the resulting invoice before granting active membership locally.
      if (req.body?.offerId !== undefined) {
        const offer = verifyRescueOfferToken(req.body.offerId, req.user!.id);
        res.json(await activateTrialNow(stripe, req.user!.id, offer.couponId, offer));
      } else {
        res.json(await activateTrialNow(stripe, req.user!.id));
      }
    } catch (error) {
      if (error instanceof BillingActivationError || error instanceof RescueOfferError) {
        res.status(error.status).json({ code: error.code, message: error.message }); return;
      }
      if (error instanceof CustomerBillingBusyError || error instanceof CustomerAccountMissingError) {
        res.status(error instanceof CustomerAccountMissingError ? 401 : 409).json({ message: error.message }); return;
      }
      logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "[billing activation] request failed");
      res.status(503).json({ message: "Activation could not be confirmed. Please retry; your billing status will update after confirmation." });
    }
  });

  app.post("/api/billing/rescue-offer/claim", isAuthenticated, async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!stripe) { res.status(503).json({ message: "Billing is unavailable. Please retry shortly." }); return; }
    try {
      res.json(await claimRescueOffer(stripe, req.user!.id));
    } catch (error) {
      if (error instanceof RescueOfferError) {
        res.status(error.status).json({ code: error.code, message: error.message }); return;
      }
      if (error instanceof CustomerBillingBusyError || error instanceof CustomerAccountMissingError) {
        res.status(error instanceof CustomerAccountMissingError ? 401 : 409).json({ message: error.message }); return;
      }
      logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "[billing rescue] claim failed");
      res.status(503).json({ message: "This offer is currently unavailable." });
    }
  });

  app.get("/api/billing/eligibility", isAuthenticated, async (req, res, next) => {
    try {
      const plan = req.query.plan === "starter" || req.query.plan === "pro" ? req.query.plan : "standard";
      res.json(await getCheckoutEligibility(req.user!.id, plan));
    } catch (err) { next(err); }
  });

  app.get("/api/billing/invoice-preview", isAuthenticated, async (req, res) => {
    try {
      const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, req.user!.id)).limit(1);
      if (!stripe || !sub?.stripeSubscriptionId || !sub.stripeCustomerId) { res.status(404).json({ message: "No billing preview available" }); return; }
      const preview = await stripe.invoices.createPreview({ customer: sub.stripeCustomerId, subscription: sub.stripeSubscriptionId, preview_mode: "next" });
      if (!Number.isSafeInteger(preview.amount_due) || preview.amount_due < 0 || !Number.isSafeInteger(preview.total) || !Number.isSafeInteger(preview.starting_balance)) throw new Error("Invalid invoice preview");
      const trialPayment = sub.trialPaymentPolicy ? await readTrialPaymentSummary(req.user!.id, sub.stripeSubscriptionId) : undefined;
      res.json({ amount: preview.amount_due, currency: preview.currency, invoiceTotal: preview.total,
        creditApplied: Math.max(0, Math.min(preview.total, -preview.starting_balance)), ...(trialPayment ? { trialPayment } : {}) });
    } catch { res.status(503).json({ message: "Preview unavailable. Open billing to see your invoice." }); }
  });

  // GET /api/billing/subscription
  app.get(
    "/api/billing/subscription",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;

        const [sub] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.userId, userId))
          .limit(1);

        const trialPayment = sub?.trialPaymentPolicy && sub.stripeSubscriptionId ?
          (await readTrialPaymentSummary(userId, sub.stripeSubscriptionId) ?? pendingTrialPaymentSummary(sub.trialPaymentPolicy, sub.trialCancellationPolicy)) : undefined;
        res.json(sub ? { ...sub, hasAccess: hasSubscriptionAccess(sub), ...(trialPayment ? { trialPayment } : {}) } : null);
      } catch (err) {
        logger.error({ err }, "[GET /api/billing/subscription] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // POST /api/billing/checkout
  app.post(
    "/api/billing/checkout",
    isAuthenticated,
    validateBody(checkoutSchema),
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const { plan, client, igUsername, acceptedOfferVersion } = req.body as CheckoutInput;

        assertStripeConfigured();

        const session = await createCheckoutSession(
          userId,
          req.user!.email,
          plan,
          client,
          igUsername,
          acceptedOfferVersion,
        );
        res.json({ url: session.url });
      } catch (err) {
        if (err instanceof CheckoutOfferChangedError) {
          res.status(409).json({ code: "checkout_offer_changed", message: err.message });
          return;
        }
        if (err instanceof TrialPaymentConfigurationError) {
          res.status(503).json({ code: "billing_not_configured", message: err.message });
          return;
        }
        if (err instanceof CustomerBillingBusyError || err instanceof CustomerAccountMissingError) {
          res.status(err instanceof CustomerBillingBusyError ? 409 : 401).json({ message: err.message });
          return;
        }
        if (
          err instanceof IntegrationMissingError ||
          err instanceof StripeConfigurationError
        ) {
          res.status(503).json({
            code: "billing_not_configured",
            message:
              err instanceof StripeConfigurationError
                ? err.publicMessage
                : "Billing is not configured yet. Please contact support.",
          });
          return;
        }
        if (err instanceof ExistingSubscriptionError) {
          res.status(409).json({
            code: "subscription_exists",
            message:
              "You already have a subscription. Manage it from Settings → Billing.",
          });
          return;
        }
        logger.error({ err }, "[POST /api/billing/checkout] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // GET /billing/return
  //   Post-checkout hop for the mobile app. Stripe will only redirect to an
  //   http(s) URL, so a native client cannot be sent its custom scheme
  //   directly; it lands here and we 302 on to the app.
  //
  //   Unauthenticated by design: this runs in an external browser that carries
  //   no session, and it grants nothing — it only forwards two opaque values
  //   the app must still verify via GET /api/billing/checkout-session/:id.
  //
  //   The redirect target is built entirely server-side. The only caller input
  //   that survives is a Stripe session id matched against Stripe's own format,
  //   so this can never be turned into an open redirect.
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Custom URL scheme the mobile app registers (app.json `expo.scheme`).
   * Stripped to the RFC-3986 scheme charset so a mis-set env var can never
   * inject anything into a Location header.
   */
  const mobileScheme = (): string =>
    (process.env.MOBILE_APP_SCHEME ?? "cheaterfinder").replace(/[^a-z0-9+.-]/gi, "");

  // ──────────────────────────────────────────────────────────────────────────
  // GET /app/reset-password
  //   Opens the password-reset screen in the mobile app.
  //
  //   The reset email links to the web page, which a phone opens in a browser —
  //   the app's own reset screen was unreachable from the real flow. Universal
  //   Links would be the richer fix but need an Apple Team ID and an Android
  //   signing fingerprint; this hop needs neither and works today.
  //
  //   The token is passed straight through to the app, which still has to
  //   redeem it against POST /api/auth/reset-password. Nothing is granted here.
  // ──────────────────────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────────────────────
  // Universal Links / Android App Links association files.
  //
  // These make `https://cheaterfinder.com/...` open the app directly instead of the
  // browser. Both require credentials that only the account owner has:
  //   APPLE_APP_ID   — "<TeamID>.<bundleId>", e.g. ABCDE12345.com.cheaterfinder.app
  //   ANDROID_SHA256 — the signing certificate fingerprint from the EAS
  //                    keystore (`eas credentials`), colon-separated hex
  //
  // Until both are set these return 404, which is the correct answer: serving a
  // malformed association file is worse than serving none, because iOS caches
  // it and Android silently stops verifying the link.
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/.well-known/apple-app-site-association", (_req: Request, res: Response) => {
    const appId = process.env.APPLE_APP_ID?.trim();
    if (!appId) {
      res.status(404).type("txt").send("Not configured");
      return;
    }
    // Must be served as application/json with no extension — Apple rejects
    // anything else, and the SPA fallback would otherwise return HTML here.
    res.type("application/json").json({
      applinks: {
        apps: [],
        details: [
          {
            appID: appId,
            paths: ["/reset-password*", "/settings*", "/dashboard*", "/billing/return*"],
          },
        ],
      },
    });
  });

  app.get("/.well-known/assetlinks.json", (_req: Request, res: Response) => {
    const fingerprint = process.env.ANDROID_SHA256?.trim();
    const packageName = process.env.ANDROID_PACKAGE?.trim() ?? "com.cheaterfinder.app";
    if (!fingerprint) {
      res.status(404).type("txt").send("Not configured");
      return;
    }
    res.type("application/json").json([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: packageName,
          sha256_cert_fingerprints: [fingerprint],
        },
      },
    ]);
  });

  app.get("/app/reset-password", (req: Request, res: Response) => {
    const token = firstParam(req.query.token as string | undefined);
    // Tokens are 32 random bytes hex-encoded (server/auth.ts). Anything else is
    // not a token we issued, so it must not be reflected into a redirect.
    const safeToken = /^[a-f0-9]{64}$/i.test(token ?? "") ? token : null;

    const params = new URLSearchParams();
    if (safeToken) params.set("token", safeToken);

    res.set("Cache-Control", "no-store");
    res.redirect(302, `${mobileScheme()}://reset-password?${params.toString()}`);
  });

  app.get("/billing/return", (req: Request, res: Response) => {
    const scheme = mobileScheme();

    const rawSession = firstParam(req.query.session_id as string | undefined);
    const sessionId = /^cs_[A-Za-z0-9_]+$/.test(rawSession ?? "")
      ? rawSession
      : null;
    const cancelled = req.query.checkout === "cancelled";

    const params = new URLSearchParams();
    params.set("checkout", cancelled ? "cancelled" : "success");
    if (!cancelled && sessionId) params.set("session_id", sessionId);

    res.set("Cache-Control", "no-store");
    res.redirect(302, `${scheme}://billing?${params.toString()}`);
  });

  // GET /api/billing/checkout-session/:id
  // Confirms the Stripe-hosted return against the authenticated user and syncs
  // the subscription immediately. The webhook remains authoritative, but this
  // removes the confusing delay between Checkout and Settings.
  app.get(
    "/api/billing/checkout-session/:id",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        assertStripeConfigured();
        const result = await confirmCheckoutSession(
          req.user!.id,
          firstParam(req.params.id),
        );
        res.json(result);
      } catch (err) {
        if (
          err instanceof IntegrationMissingError ||
          err instanceof StripeConfigurationError
        ) {
          res.status(503).json({
            code: "billing_not_configured",
            message: "Billing is not configured yet. Please contact support.",
          });
          return;
        }
        if (err instanceof CheckoutSessionOwnershipError) {
          res.status(404).json({ message: "Checkout session not found" });
          return;
        }
        logger.error({ err }, "[GET /api/billing/checkout-session/:id] error:");
        res.status(500).json({ message: "Could not confirm checkout" });
      }
    },
  );

  // POST /api/billing/portal
  app.post(
    "/api/billing/portal",
    isAuthenticated,
    validateBody(checkoutSchema.pick({ plan: true }).partial().default({})),
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;

        const [sub] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.userId, userId))
          .limit(1);

        if (!sub?.stripeCustomerId) {
          res.status(404).json({ message: "No billing account found" });
          return;
        }

        assertStripeConfigured();

        if (req.body.plan && (!sub.stripeSubscriptionId || !hasSubscriptionAccess(sub))) {
          res.status(409).json({ message: "Start a subscription before changing plans." }); return;
        }
        const session = await createPortalSession(sub.stripeCustomerId, req.body.plan ? { subscriptionId: sub.stripeSubscriptionId!, plan: req.body.plan } : undefined, sub.stripeSubscriptionId ?? undefined);
        res.json({ url: session.url });
      } catch (err) {
        if (
          err instanceof IntegrationMissingError ||
          err instanceof StripeConfigurationError
        ) {
          res.status(503).json({
            code: "billing_not_configured",
            message: "Billing is not configured yet. Please contact support.",
          });
          return;
        }
        logger.error({ err }, "[POST /api/billing/portal] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  for (const action of ["retention-offer", "retention-accept"] as const) {
    app.post(`/api/billing/${action}`, isAuthenticated, async (req, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      try {
        if (!stripe) { res.status(503).json({ message: "Billing is unavailable. You can still open billing to cancel." }); return; }
        if (action === "retention-offer") {
          res.json(await quoteRetentionOffer(stripe, req.user!.id));
        } else {
          const offerId = req.body?.offerId;
          if (typeof offerId !== "string" || !/^[a-f0-9-]{36}$/i.test(offerId)) {
            res.status(400).json({ message: "A valid offer is required." }); return;
          }
          await acceptRetentionOffer(stripe, req.user!.id, offerId);
          res.json({ message: "Your one-time 50% discount is confirmed for your next monthly subscription payment. Your billing date is unchanged." });
        }
      } catch (error) {
        if (error instanceof RetentionError || error instanceof CustomerBillingBusyError || error instanceof CustomerAccountMissingError) {
          res.status(error instanceof CustomerAccountMissingError ? 401 : 409).json({ message: error.message }); return;
        }
        logger.error({ err: error }, "[billing retention] request failed");
        res.status(503).json({ message: "The offer could not be confirmed. Please retry; cancellation is still available." });
      }
    });
  }

  // POST /api/billing/cancel
  app.post(
    "/api/billing/cancel",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        assertStripeConfigured();
        if (!stripe) { res.status(503).json({ message: "Payment system not configured" }); return; }
        await cancelCustomerSubscription(stripe, req.user!.id);

        res.json({ message: "Cancellation is confirmed. Your access end date and any advance refund status are shown in billing." });
      } catch (err) {
        if (err instanceof RetentionError || err instanceof CustomerBillingBusyError || err instanceof CustomerAccountMissingError) {
          res.status(err instanceof CustomerAccountMissingError ? 401 : 409).json({ message: err.message }); return;
        }
        if (
          err instanceof IntegrationMissingError ||
          err instanceof StripeConfigurationError
        ) {
          res.status(503).json({
            code: "billing_not_configured",
            message: "Billing is not configured yet. Please contact support.",
          });
          return;
        }
        logger.error({ err }, "[POST /api/billing/cancel] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // NOTIFICATIONS ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/notifications
  app.get(
    "/api/notifications",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const { limit, offset } = parsePagination(req.query);

        const items = await db
          .select()
          .from(notifications)
          .where(eq(notifications.userId, userId))
          .orderBy(desc(notifications.createdAt))
          .limit(limit)
          .offset(offset);

        res.json({ items, limit, offset });
      } catch (err) {
        logger.error({ err }, "[GET /api/notifications] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // PATCH /api/notifications/:id/read
  app.patch(
    "/api/notifications/:id/read",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;
        const id = firstParam(req.params.id);

        const [notification] = await db
          .select()
          .from(notifications)
          .where(
            and(eq(notifications.id, id), eq(notifications.userId, userId)),
          )
          .limit(1);

        if (!notification) {
          res.status(404).json({ message: "Notification not found" });
          return;
        }

        await db
          .update(notifications)
          .set({ isRead: true })
          .where(eq(notifications.id, id));

        res.json({ message: "Marked as read" });
      } catch (err) {
        logger.error({ err }, "[PATCH /api/notifications/:id/read] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // PATCH /api/notifications/read-all
  app.patch(
    "/api/notifications/read-all",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;

        await db
          .update(notifications)
          .set({ isRead: true })
          .where(
            and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
          );

        res.json({ message: "All notifications marked as read" });
      } catch (err) {
        logger.error({ err }, "[PATCH /api/notifications/read-all] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/notifications/devices
  //   Register (or refresh) this install's Expo push token.
  //
  //   Upserts on the token itself, not on (user, token): Expo issues one token
  //   per install, so if a second user signs in on the same device the row must
  //   move to them — otherwise the previous user keeps receiving the new user's
  //   notifications.
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/notifications/devices",
    isAuthenticated,
    validateBody(deviceTokenSchema),
    async (req: Request, res: Response) => {
      try {
        const { token, platform } = req.body as DeviceTokenInput;
        await registerDeviceToken(req.user!.id, token, platform);
        res.status(204).end();
      } catch (err) {
        logger.error({ err }, "[POST /api/notifications/devices] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // DELETE /api/notifications/devices
  //   Drop this install's token — called on sign-out so a shared device stops
  //   receiving the previous user's notifications.
  app.delete(
    "/api/notifications/devices",
    isAuthenticated,
    validateBody(deviceTokenSchema.pick({ token: true })),
    async (req: Request, res: Response) => {
      try {
        const { token } = req.body as { token: string };
        await unregisterDeviceToken(token, req.user!.id);
        res.status(204).end();
      } catch (err) {
        logger.error({ err }, "[DELETE /api/notifications/devices] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // GET /api/notifications/unread-count
  app.get(
    "/api/notifications/unread-count",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const userId = req.user!.id;

        const [result] = await db
          .select({ count: count() })
          .from(notifications)
          .where(
            and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
          );

        res.json({ count: result?.count ?? 0 });
      } catch (err) {
        logger.error({ err }, "[GET /api/notifications/unread-count] error:");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN ROUTES (registered from admin-routes.ts)
  // ══════════════════════════════════════════════════════════════════════════

  registerAdminRoutes(app);

  // ══════════════════════════════════════════════════════════════════════════
  // VIEWER ROUTES (PUBLIC)
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/media/:cacheKey — stable app-owned media cache.
  app.get("/api/media/:cacheKey", async (req: Request, res: Response) => {
    const cacheKey = firstParam(req.params.cacheKey);
    const trackedAccountId = typeof req.query.trackedAccountId === "string" ? req.query.trackedAccountId : "";
    const signature = typeof req.query.sig === "string" ? req.query.sig : "";
    if (!verifyMediaSignature(cacheKey, req.user!.id, trackedAccountId, signature)) {
      res.status(404).send("Media not available");
      return;
    }
    const [account] = await db.select({ id: trackedAccounts.id }).from(trackedAccounts)
      .where(and(eq(trackedAccounts.id, trackedAccountId), eq(trackedAccounts.userId, req.user!.id),
        eq(trackedAccounts.isActive, true),
        or(eq(trackedAccounts.isPrivate, false), eq(trackedAccounts.accessStatus, "has_access"))))
      .limit(1);
    if (!account) {
      res.status(404).send("Media not available");
      return;
    }
    const cached = await readCachedMediaAsset(cacheKey);
    if (!cached) {
      res.status(404).send("Media not cached");
      return;
    }

    res.set("Content-Type", cached.contentType);
    res.set("Content-Length", String(cached.byteSize));
    res.set("Cache-Control", "private, no-store");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(cached.body);
  });

  // GET /api/img-proxy — proxy Instagram CDN media to avoid CORP/CSP blocking.
  // Fix #14: SSRF-hardened. Strict host suffix whitelist + DNS resolve to
  // reject private/internal IP ranges.
  // C4: now requires an authenticated session (the SPA serves these URLs from
  // <img>/<video> tags, so the session cookie rides along same-origin) and is
  // rate-limited per user — a generous gallery bucket plus a stricter bucket
  // for the .mp4 path that may lease a paid residential proxy. Order matters:
  // auth → video limiter (skips non-mp4) → gallery limiter (counts all).
  app.get(
    "/api/img-proxy",
    isAuthenticated,
    videoProxyLimiter,
    galleryProxyLimiter,
    async (req: Request, res: Response) => {
    const url = req.query.url as string;
    if (!url) { res.status(400).send("Missing url"); return; }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      res.status(400).send("Invalid URL");
      return;
    }

    // Only HTTPS upstream is allowed.
    if (parsed.protocol !== "https:") {
      res.status(400).json({ error: "only https is allowed" });
      return;
    }

    const allowedSuffixes = [".instagram.com", ".cdninstagram.com", ".fbcdn.net"];
    const hostMatches = allowedSuffixes.some(
      (suffix) =>
        parsed.hostname === suffix.slice(1) || parsed.hostname.endsWith(suffix),
    );
    if (!hostMatches) {
      res.status(400).json({ error: "disallowed host" });
      return;
    }

    // Admin API history retains original URLs. Reuse already-held bytes even
    // after their CDN signature expires; this lookup never performs a refresh.
    // Customers receive scoped signed cache URLs from their authorized API.
    const persistent = req.user!.role === "admin"
      ? await readCachedMediaAsset(mediaCacheKey(parsed.toString()), { repairMissing: false })
        .catch(() => null)
      : null;
    if (persistent) {
      res.set("Content-Type", persistent.contentType);
      res.set("Content-Length", String(persistent.byteSize));
      res.set("Cache-Control", "private, no-store");
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      res.send(persistent.body);
      return;
    }

    const cached = await readCachedImage(parsed.toString());
    if (cached) {
      res.set("Content-Type", cached.contentType);
      res.set("Cache-Control", "private, no-store");
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      res.send(cached.body);
      return;
    }

    // DNS resolve and reject private / loopback / link-local ranges.
    // Force IPv4 — this host (Hetzner) has no IPv6 egress to fbcdn/cdninstagram,
    // and Node's pinned-lookup path crashes on IPv6 with "Invalid IP address: undefined".
    let resolvedAddress: string;
    const resolvedFamily = 4;
    try {
      const { address } = await dns.promises.lookup(parsed.hostname, {
        family: 4,
      });
      if (!address || isPrivateOrReservedIp(address)) {
        res.status(400).json({ error: "host resolves to private network" });
        return;
      }
      resolvedAddress = address;
    } catch {
      // Old Instagram CDN hostnames are routinely decommissioned while their
      // signed URL remains in a cached roster row. Treat that as unavailable
      // media (the client renders its neutral avatar), not a bad-request error
      // that pollutes the console. Private/reserved resolutions remain a hard
      // 400 above for SSRF protection.
      sendMediaProxyFallback(res);
      return;
    }

    const maxBytes = 25 * 1024 * 1024;
    const isLikelyVideo = parsed.pathname.toLowerCase().endsWith(".mp4");
    if (isLikelyVideo) {
      const gatewayMedia = await fetchMediaThroughGateway(
        parsed.toString(),
        maxBytes,
      );
      if (gatewayMedia) {
        void writeCachedImage(
          parsed.toString(),
          gatewayMedia.body,
          gatewayMedia.contentType,
        );
        // C4: keep the flat-file disk cache within its size budget (LRU).
        maybeSweepImgCache(imageCacheDir);
        res.set("Content-Type", gatewayMedia.contentType);
        res.set("Cache-Control", "private, no-store");
        res.set("Cross-Origin-Resource-Policy", "cross-origin");
        res.send(gatewayMedia.body);
        return;
      }
    }
    const proxyReq = https.get(
      parsed.toString(),
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.instagram.com/",
        },
        lookup: (_hostname, opts, cb) => {
          // Node 22 invokes lookup with `all: true`, expecting an array form.
          // Older `(err, address, family)` shape returns "Invalid IP address: undefined".
          if (opts && (opts as { all?: boolean }).all) {
            (cb as unknown as (
              err: NodeJS.ErrnoException | null,
              addresses: Array<{ address: string; family: number }>,
            ) => void)(null, [{ address: resolvedAddress, family: resolvedFamily }]);
          } else {
            cb(null, resolvedAddress, resolvedFamily);
          }
        },
      },
      (proxyRes) => {
        let interrupted = false;
        const failResponse = () => {
          interrupted = true;
          sendMediaProxyFallback(res);
        };
        proxyRes.on("error", failResponse);
        proxyRes.on("aborted", failResponse);
        const statusCode = proxyRes.statusCode ?? 502;
        if (statusCode < 200 || statusCode >= 300) {
          logger.warn(
            { host: parsed.hostname, status: statusCode, path: parsed.pathname },
            "[img-proxy] upstream non-2xx",
          );
          sendMediaProxyFallback(res);
          proxyRes.resume();
          return;
        }

        const contentLength = Number(proxyRes.headers["content-length"] ?? "0");
        if (contentLength > maxBytes) {
          sendMediaProxyFallback(res, 413);
          proxyReq.destroy();
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            interrupted = true;
            sendMediaProxyFallback(res, 413);
            proxyReq.destroy();
            return;
          }
          chunks.push(chunk);
        });
        proxyRes.on("end", () => {
          if (interrupted || res.destroyed || res.headersSent) return;
          const body = Buffer.concat(chunks);
          if (!body.length || (contentLength > 0 && body.length !== contentLength)) {
            sendMediaProxyFallback(res);
            return;
          }
          const contentType = String(proxyRes.headers["content-type"] ?? "image/jpeg");
          const lowerContentType = contentType.toLowerCase();
          if (
            !lowerContentType.startsWith("image/") &&
            !lowerContentType.startsWith("video/")
          ) {
            sendMediaProxyFallback(res, 415);
            return;
          }
          void writeCachedImage(parsed.toString(), body, contentType);
          // C4: keep the flat-file disk cache within its size budget (LRU).
          maybeSweepImgCache(imageCacheDir);
          res.set("Content-Type", contentType);
          res.set("Cache-Control", "private, no-store");
          res.set("Cross-Origin-Resource-Policy", "cross-origin");
          res.send(body);
        });
      },
    );
    proxyReq.on("error", (err) => {
      logger.warn(
        { host: parsed.hostname, err: err instanceof Error ? err.message : String(err) },
        "[img-proxy] upstream error",
      );
      sendMediaProxyFallback(res);
    });
    proxyReq.setTimeout(10000, () => {
      proxyReq.destroy();
      sendMediaProxyFallback(res);
    });
  });

  // GET /api/viewer/:username
  // Query:
  //   tz=<IANA tz>       → bucket activity by a specific timezone (default UTC)
  //   postType=<all|photo|video|reel|carousel>
  app.get("/api/viewer/:username", isAuthenticated, async (req: Request, res: Response) => {
    const usernameParam = firstParam(req.params.username);
    if (usernameParam.trim().length === 0) {
      res.status(400).json({ message: "Username is required" });
      return;
    }

    const userId = req.user!.id;
    const cleanUsername = usernameParam.toLowerCase().replace(/^@/, "");
    const tz = validateTimezone(
      typeof req.query.tz === "string" ? req.query.tz : undefined,
    );
    const postTypeFilter = parsePostTypeFilter(
      typeof req.query.postType === "string" ? req.query.postType : undefined,
    );

    // Build viewer data only from accounts owned by the authenticated user.
    // This endpoint exposes cached posts/stories/follower diffs, so username
    // alone is not an authorization boundary.
    const [account] = await db
      .select()
      .from(trackedAccounts)
      .where(
        and(
          eq(trackedAccounts.igUsername, cleanUsername),
          eq(trackedAccounts.userId, userId),
          eq(trackedAccounts.isActive, true),
        ),
      )
      .limit(1);

    if (!account) {
      res.status(404).json({ message: "Tracked account not found" });
      return;
    }

    if (privateContentUnavailable(account)) {
      // Public profile metadata remains useful while approval is pending, but
      // previously captured private content must not survive grant revocation.
      const [snapshot] = await db.select().from(profileSnapshots)
        .where(eq(profileSnapshots.trackedAccountId, account.id))
        .orderBy(desc(profileSnapshots.snapshotAt)).limit(1);
      maybeRevalidateTier1(account, snapshot?.snapshotAt ?? null);
      const profilePicUrl = [account.profilePicUrl, snapshot?.profilePicUrl, snapshot?.profilePicUrlHd]
        .find(url => typeof url === "string" && url.trim().length > 0)
        ?? `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanUsername)}&background=random&size=200`;
      const restrictedRoster = {
        background: null, loadedTotal: 0, completionPct: null,
        syncState: "restricted", isPartial: true, lastUpdatedAt: null,
        failureKind: null, lastAttemptAt: null, lastSuccessfulAt: null,
        lastCompleteReadAt: null, nextRetryAt: null, unfollowDetectionTrusted: false,
      };
      res.json({
        igUsername: cleanUsername,
        displayName: account.displayName ?? snapshot?.fullName ?? cleanUsername,
        profilePicUrl, biography: account.biography ?? snapshot?.biography ?? null,
        isVerified: account.isVerified ?? snapshot?.isVerified ?? false,
        isBusinessAccount: account.isBusinessAccount ?? snapshot?.isBusinessAccount ?? false,
        isPrivate: true, externalUrl: account.externalUrl ?? snapshot?.externalUrl ?? null,
        followerCount: snapshot?.followerCount ?? account.followerCount ?? 0,
        followingCount: snapshot?.followingCount ?? 0, postCount: snapshot?.postCount ?? 0,
        topNiche: null, peakActivityHour: null,
        profileSnapshot: snapshot ? {
          fullName: snapshot.fullName, biography: snapshot.biography,
          profilePicUrl: snapshot.profilePicUrl, profilePicUrlHd: snapshot.profilePicUrlHd,
          externalUrl: snapshot.externalUrl, isVerified: snapshot.isVerified ?? false,
          isBusinessAccount: snapshot.isBusinessAccount ?? false,
          isPrivate: snapshot.isPrivate ?? true, followerCount: snapshot.followerCount,
          followingCount: snapshot.followingCount, postCount: snapshot.postCount,
          snapshotAt: snapshot.snapshotAt,
        } : null,
        recentPosts: [], stories: [], highlights: [], recentLikes: [], recentFollows: [],
        recentFollowers: [], recentUnfollows: [], recentFollowerUnfollows: [],
        rosterStatus: {
          followers: { ...restrictedRoster, expectedTotal: snapshot?.followerCount ?? account.followerCount ?? 0 },
          following: { ...restrictedRoster, expectedTotal: snapshot?.followingCount ?? 0 },
        },
        activityByHour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
        activityByDate: [], weeklyStats: { totalLikes: 0, totalFollows: 0, totalUnfollows: 0, totalPosts: 0 },
        dataSource: "none", cachedAt: null,
        contentCachedAt: { posts: null, stories: null, highlights: null }, tz, postTypeFilter,
        postsCollection: {
          state: "waiting_for_access", savedTotal: null,
          recordedProfileCount: snapshot?.postCount ?? null, recordedProfileAt: snapshot?.snapshotAt?.toISOString() ?? null,
          lastPostsReadAt: null, lastAttemptAt: null, nextRetryAt: null,
          trackingActive: account.isActive, source: "account",
        },
      });
      return;
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Weekly window for the "Weekly Follows/Unfollows" analytics cards. These
    // counts must reflect the last 7 days (matching `totalPosts` below), not
    // the account's lifetime totals.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const now = new Date();

    // Rosters live on the canonical twin (oldest active row for this IG user);
    // every roster_members / roster_sync_state read below is keyed by it.
    const rosterAccountId = await canonicalTwinId(account.id);
    const [followersRosterHealth, followingRosterHealth] = await Promise.all([
      getRosterSyncHealth(rosterAccountId, "follower"),
      getRosterSyncHealth(rosterAccountId, "following"),
    ]);
    // Posts / stories / highlights are collected on the canonical twin only
    // (audit 2026-09-02 C6); the content caches are read from it as well so a
    // non-canonical row's dashboard shows the one shared, freshest copy.
    const contentAccountId = rosterAccountId;
    // Same construction as followActivityFilters() (feed/report/CSV).
    const settledFollowingBoundary = followActivityBoundary(
      account.followingFirstCompleteAt,
      followingRosterHealth.settledAt,
    );
    const followingActivityBoundary = settledFollowingBoundary
      ? followActivityBoundary(settledFollowingBoundary, account.trackingStarted) : null;

    // Liked-post evidence is a property of the IG user, so union the twins
    // (every ACTIVE row tracking the same IG account) and dedupe by post id.
    const twinIds = await twinTrackedAccountIds(account.id);

    const [
      recentLikeRows,
      recentFollowsRaw,
      snapshot,
      totalLikesCount,
      totalFollowsCount,
      totalUnfollowsCount,
      recentPostsRaw,
      postTotalsRaw,
      activeStoriesRaw,
      highlightsRaw,
      recentFollowersRaw,
      recentFollowerUnfollowsRaw,
      recentUnfollowsRaw,
      followersRosterStatus,
      followingRosterStatus,
    ] = await Promise.all([
      db.select().from(likeEvents)
        .where(
          and(
            inArray(likeEvents.trackedAccountId, twinIds),
            // Still keyed on THIS account's tracking start — a twin's older
            // sighting must not backfill history the customer never paid for.
            likedPostAfterTrackingStart(account.trackingStarted),
          ),
        )
        // Newest POST first — not newest DETECTION. detected_at is when we
        // inferred the like, so ordering by it floated week-old posts above
        // ones published this morning. Legacy rows (pre-0030) have no post date
        // and fall back to detection so they keep a stable position.
        .orderBy(
          sql`${likeEvents.postTakenAt} DESC NULLS LAST`,
          desc(likeEvents.detectedAt),
        ),
      db.select().from(followEvents)
        // Boundary + flip-flop + roster-contradiction gates (roster.ts).
        .where(
          visibleFollowEventsSql({
            trackedAccountId: account.id,
            rosterAccountId,
            boundary: followingActivityBoundary,
          }),
        )
        .orderBy(desc(followEvents.detectedAt))
        .limit(500),
      db.select().from(profileSnapshots)
        .where(eq(profileSnapshots.trackedAccountId, account.id))
        .orderBy(desc(profileSnapshots.snapshotAt))
        .limit(1),
      // Counts the SAME deduped twin union the gallery renders — a headline
      // that disagreed with the grid would just look like a new bug.
      db.select({ value: sql<number>`count(distinct ${likeEvents.postId})` })
        .from(likeEvents)
        .where(
          and(
            inArray(likeEvents.trackedAccountId, twinIds),
            likedPostAfterTrackingStart(account.trackingStarted),
          ),
        ),
      // "Weekly Follows/Unfollows" must count REAL activity. follow_events /
      // unfollow_events also record roster DISCOVERY, so a 7-day window alone
      // reported 860 follows / 859 unfollows for an account whose following
      // barely moved. Only events after the roster was first fully enumerated
      // (migration 0027) can be genuine — before that we cannot tell.
      db.select({ value: count() }).from(followEvents)
        .where(
          and(
            visibleFollowEventsSql({
              trackedAccountId: account.id,
              rosterAccountId,
              boundary: followingActivityBoundary,
            }),
            gte(followEvents.detectedAt, sevenDaysAgo),
          ),
        ),
      db.select({ value: count() }).from(rosterMembers)
        .where(
          and(
            visibleRosterDeparturesSql(rosterAccountId, followingActivityBoundary),
            gte(rosterMembers.leftAt, sevenDaysAgo),
          ),
        ),
      db.select().from(postsCache)
        .where(and(eq(postsCache.trackedAccountId, contentAccountId),
          postTypeFilter === "all" ? undefined : eq(postsCache.postType, postTypeFilter)))
        // Pinned-first so a pinned (possibly older) post is always within the
        // fetched window and surfaces at the top of the grid; then newest-first.
        .orderBy(desc(postsCache.isPinned), sql`${postsCache.takenAt} DESC NULLS LAST`, asc(postsCache.shortcode))
        .limit(24),
      db.select({ type: postsCache.postType, total: count(), cachedAt: sql<Date | string>`max(${postsCache.cachedAt})`,
        publishedThisWeek: sql<number>`count(*) filter (where ${postsCache.takenAt} >= ${sevenDaysAgo})` })
        .from(postsCache).where(eq(postsCache.trackedAccountId, contentAccountId)).groupBy(postsCache.postType),
      db.select().from(storiesCache)
        .where(
          and(
            eq(storiesCache.trackedAccountId, contentAccountId),
            gt(storiesCache.expiresAt, now),
          ),
        )
        .orderBy(desc(storiesCache.takenAt)),
      db.select().from(highlightsCache)
        .where(eq(highlightsCache.trackedAccountId, contentAccountId))
        .orderBy(desc(highlightsCache.cachedAt)),
      db.select().from(followerEvents)
        .where(
          and(
            eq(followerEvents.trackedAccountId, rosterAccountId),
            gte(followerEvents.detectedAt, thirtyDaysAgo),
            gte(followerEvents.detectedAt, account.trackingStarted),
          ),
        )
        .orderBy(desc(followerEvents.detectedAt))
        .limit(500),
      // Suppress rows the live roster contradicts. The following-side panel
      // already reads roster_members for exactly this reason; the follower side
      // was still serving the raw event log, so anyone who unfollowed and later
      // came back kept showing as "unfollowed you" while roster_members has them
      // is_current=true. Small but user-visible (3 such rows on @tracked_user_1), and
      // it is the same class of false positive the client reported previously.
      // roster_members is keyed by the canonical twin (the row holding rosters).
      db.select().from(followerUnfollowEvents)
        .where(
          and(
            visibleFollowerUnfollowsSql(rosterAccountId, account.trackingStarted),
            gte(followerUnfollowEvents.detectedAt, thirtyDaysAgo),
          ),
        )
        .orderBy(desc(followerUnfollowEvents.detectedAt))
        .limit(500),
      // Accounts THIS profile unfollowed (the following-side diff). Distinct from
      // followerUnfollowEvents above, which is people who unfollowed THEM — the
      // two directions are easy to confuse, so they stay explicitly separate.
      // "Unfollowed Accounts" = accounts CONFIRMED departed from the following
      // roster, served from roster_members (the source of truth per migration
      // 0029) — NOT the raw unfollow_events log. The event log holds stale false
      // positives: an account marked unfollowed that later reappeared stays in
      // the log while the roster correctly shows is_current=true, so the section
      // listed ~50 accounts the client still follows. A row here has
      // is_current=false, so it cannot be a still-followed false positive.
      db
        .select({
          unfollowedUsername: rosterMembers.username,
          unfollowedDisplayName: rosterMembers.displayName,
          unfollowedPfpUrl: rosterMembers.pfpUrl,
          detectedAt: rosterMembers.leftAt,
        })
        .from(rosterMembers)
        .where(
          and(
            visibleRosterDeparturesSql(rosterAccountId, followingActivityBoundary),
            gte(rosterMembers.leftAt, thirtyDaysAgo),
          ),
        )
        .orderBy(desc(rosterMembers.leftAt))
        .limit(500),
      // D4: stats-only queries — the old buildXRoster({ limit: 1 }) calls
      // loaded and aggregated every event row just to read `.total`.
      // Canonical twin holds the rosters.
      getFollowersRosterStats(rosterAccountId),
      getFollowingRosterStats(rosterAccountId),
    ]);

    const latestSnapshot = snapshot[0];

    // Serve cached viewer data instantly; refresh public basics in the
    // background via Tier-1 if stale (no bot/browser cost).
    maybeRevalidateTier1(account, latestSnapshot?.snapshotAt ?? null);

    const followerExpectedTotal = Math.max(
      latestSnapshot?.followerCount ?? 0,
      followersRosterStatus.total,
    );
    const followingExpectedTotal = Math.max(
      latestSnapshot?.followingCount ?? 0,
      followingRosterStatus.total,
    );
    const [followerBackground, followingBackground] = await Promise.all([
      readBackgroundRosterView(rosterAccountId, cleanUsername, "follower"),
      readBackgroundRosterView(rosterAccountId, cleanUsername, "following"),
    ]);
    const followerRosterSyncState = backgroundRosterSyncState(followerBackground, computeRosterSyncState({
      loadedTotal: followersRosterStatus.total,
      reportedTotal: followerExpectedTotal,
      lastGraphRefreshAt: account.lastFollowersRefreshAt,
      baselineSettled: followersRosterHealth.settled,
      failureKind: followersRosterHealth.failureKind,
      nextRetryAt: followersRosterHealth.nextRetryAt,
    }));
    const followingRosterSyncState = backgroundRosterSyncState(followingBackground, computeRosterSyncState({
      loadedTotal: followingRosterStatus.total,
      reportedTotal: followingExpectedTotal,
      lastGraphRefreshAt: account.lastFollowingRefreshAt,
      baselineSettled: followingRosterHealth.settled,
      failureKind: followingRosterHealth.failureKind,
      nextRetryAt: followingRosterHealth.nextRetryAt,
    }));
    // Each roster's trust keys off ITS OWN enumeration anchor (migration 0025).
    // Using the shared lastGraphRefreshAt cross-gated them: it only advances when
    // BOTH walks complete, so an un-enumerable followers list (e.g. 9.5k) made a
    // perfectly-enumerated following roster look "syncing" and silently hid real
    // unfollow events from the UI.
    const followerUnfollowsTrusted = isUnfollowRosterTrusted(
      followersRosterStatus.total,
      latestSnapshot?.followerCount,
      account.lastFollowersRefreshAt,
      followersRosterHealth.settled,
    );
    const followingUnfollowsTrusted = isUnfollowRosterTrusted(
      followingRosterStatus.total,
      latestSnapshot?.followingCount,
      account.lastFollowingRefreshAt,
      followingRosterHealth.settled,
    );
    const trustedFollowerUnfollowsRaw = followerUnfollowsTrusted
      ? recentFollowerUnfollowsRaw
      : [];
    // Display data for the follow/unfollow lists.
    //
    // follow_events / unfollow_events carry only a username, so these rows used
    // to render with no avatar and no display name at all. roster_members keeps
    // the member row after they leave (is_current=false) together with the name
    // and picture captured while they were present, so both lists can now be
    // enriched from it — including accounts the profile has since unfollowed.
    const followingRosterDisplay = new Map(
      (
        await db
          .select({
            usernameLower: rosterMembers.usernameLower,
            displayName: rosterMembers.displayName,
            pfpUrl: rosterMembers.pfpUrl,
          })
          .from(rosterMembers)
          .where(
            and(
              // Canonical twin holds the roster.
              eq(rosterMembers.trackedAccountId, rosterAccountId),
              eq(rosterMembers.dimension, "following"),
            ),
          )
      ).map((r) => [r.usernameLower, r]),
    );
    const displayFor = (username: string) =>
      followingRosterDisplay.get(username.toLowerCase());

    // Already bounded to post-first-complete events above; the trust flag stays
    // as a second guard for rosters we still cannot vouch for.
    const trustedTotalUnfollows = followingUnfollowsTrusted
      ? Number(totalUnfollowsCount[0]?.value ?? 0)
      : 0;
    const recentPosts = Array.from(
      new Map(recentPostsRaw.map((p) => [p.shortcode, p])).values(),
    );
    const activeStories = Array.from(
      new Map(activeStoriesRaw.map((s) => [s.storyId, s])).values(),
    );
    const highlights = Array.from(
      new Map(highlightsRaw.map((h) => [h.highlightId, h])).values(),
    );

    // Fetch highlight items in a single batched query keyed by highlight cache
    // IDs, then group in-memory and cap per-highlight to 30 items (matches
    // IG's typical highlight ceiling). Skipped when there are no highlights.
    const MAX_HIGHLIGHT_ITEMS = 30;
    const highlightCacheIds = highlights.map((h) => h.id);
    const highlightItemsByCacheId = new Map<
      string,
      Array<{
        storyId: string;
        mediaType: "photo" | "video" | string;
        mediaUrl: string;
        thumbnailUrl?: string;
        takenAt: string;
      }>
    >();
    if (highlightCacheIds.length > 0) {
      const itemsRaw = await db
        .select()
        .from(highlightItemsCache)
        .where(inArray(highlightItemsCache.highlightCacheId, highlightCacheIds))
        .orderBy(desc(highlightItemsCache.takenAt));
      for (const item of itemsRaw) {
        const bucket = highlightItemsByCacheId.get(item.highlightCacheId) ?? [];
        if (bucket.length >= MAX_HIGHLIGHT_ITEMS) continue;
        bucket.push({
          storyId: item.storyId,
          mediaType: item.mediaType,
          mediaUrl: item.mediaUrl ?? "",
          thumbnailUrl: item.thumbnailUrl ?? undefined,
          takenAt:
            item.takenAt instanceof Date
              ? item.takenAt.toISOString()
              : (item.takenAt as unknown as string) ?? "",
        });
        highlightItemsByCacheId.set(item.highlightCacheId, bucket);
      }
    }

    // The database applies the type filter before the 24-item preview limit.
    // Totals and write dates describe the full canonical cache, not that page.
    const filteredPosts = recentPosts;
    const postCounts: Record<PostTypeFilter, number> = { all: 0, photo: 0, video: 0, reel: 0, carousel: 0 };
    let publishedPostsThisWeek = 0;
    for (const row of postTotalsRaw) {
      postCounts.all += Number(row.total);
      if (row.type === "photo" || row.type === "video" || row.type === "reel" || row.type === "carousel") postCounts[row.type] = Number(row.total);
      if (postTypeFilter === "all" || row.type === postTypeFilter) publishedPostsThisWeek += Number(row.publishedThisWeek);
    }
    const postWriteTimes = postTotalsRaw.map(row => new Date(row.cachedAt).getTime()).filter(Number.isFinite);
    const postsCachedAt = postWriteTimes.length ? new Date(Math.max(...postWriteTimes)).toISOString() : null;
    const postsCollection = await readPostsCollectionState(account.id, {
      contentAccountId, savedTotal: postCounts.all, latestSavedAt: postsCachedAt,
      // A twin's profile snapshot can be older than the canonical posts read.
      // Only reuse a snapshot from the same row as the collection evidence.
      ...(contentAccountId === account.id ? { profileSnapshot: latestSnapshot ?? null } : {}),
    });
    const recentLikesRaw = dedupeLikedPostsByPostId(recentLikeRows);
    const filteredLikes = recentLikesRaw.filter(
      (l) => postTypeFilter === "all" || l.postType === postTypeFilter,
    );

    // Timezone-aware activity buckets. Use Intl.DateTimeFormat so we don't
    // leak the server's local tz into the response.
    const hourFmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    });
    const dateFmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: tz,
    });

    const hourCounts = new Array<number>(24).fill(0);
    const dateCountsMap = new Map<string, number>();

    const pushActivity = (dt: Date | null | undefined): void => {
      if (!dt) return;
      const d = new Date(dt);
      const hourStr = hourFmt.format(d);
      // "24" can appear in en-US hour=numeric on midnight; normalise.
      let hour = parseInt(hourStr, 10);
      if (!Number.isFinite(hour)) hour = 0;
      if (hour === 24) hour = 0;
      if (hour >= 0 && hour < 24) hourCounts[hour]++;

      const dateStr = dateFmt.format(d);
      dateCountsMap.set(dateStr, (dateCountsMap.get(dateStr) ?? 0) + 1);
    };

    for (const like of filteredLikes) pushActivity(like.detectedAt);
    for (const follow of recentFollowsRaw) pushActivity(follow.detectedAt);
    for (const p of filteredPosts) pushActivity(p.takenAt);

    const activityByHour = hourCounts.map((c, hour) => ({ hour, count: c }));
    const peakBucket = activityByHour.reduce(
      (a, b) => (a.count > b.count ? a : b),
    );
    const peakHour = peakBucket.count > 0 ? peakBucket.hour : null;
    const activityByDate = Array.from(dateCountsMap.entries())
      .map(([date, c]) => ({ date, count: c }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Top niche from hashtags in filtered likes + posts
    const nicheCounts: Record<string, number> = {};
    const countTags = (tags: string[] | null | undefined): void => {
      if (!tags) return;
      for (const tag of tags) {
        const clean = tag.replace(/^#/, "").toLowerCase();
        if (!clean) continue;
        nicheCounts[clean] = (nicheCounts[clean] ?? 0) + 1;
      }
    };
    for (const like of filteredLikes) countTags(like.hashtags as string[]);
    for (const p of filteredPosts) countTags(p.hashtags as string[]);
    const topNiche =
      Object.entries(nicheCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      null;

    // Choose the source indicator: cached if we have any persisted data,
    // otherwise honour whatever the tracked_accounts flag suggests.
    const hasCached =
      postCounts.all > 0 ||
      activeStories.length > 0 ||
      highlights.length > 0 ||
      recentFollowersRaw.length > 0;
    const dataSource: "cached" | "none" = hasCached ? "cached" : "none";
    const cacheDates = [
      ...(postsCachedAt ? [new Date(postsCachedAt)] : []),
      ...activeStories.map((s) => s.cachedAt),
      ...highlights.map((h) => h.cachedAt),
      ...recentFollowersRaw.map((f) => f.detectedAt),
      ...trustedFollowerUnfollowsRaw.map((f) => f.detectedAt),
      latestSnapshot?.snapshotAt,
    ].filter((d): d is Date => d instanceof Date);
    const cachedAt = cacheDates.length > 0
      ? new Date(Math.max(...cacheDates.map((d) => d.getTime()))).toISOString()
      : undefined;
    // A new follower/profile snapshot must not claim posts/stories/highlights
    // were just checked. These are cache-write times, not fresh-read guarantees.
    const latestCacheWrite = (rows: ReadonlyArray<{cachedAt: Date | null}>) => {
      const times = rows.flatMap(row => row.cachedAt instanceof Date ? [row.cachedAt.getTime()] : []);
      return times.length ? new Date(Math.max(...times)).toISOString() : null;
    };
    const contentCachedAt = { posts: postsCachedAt, stories: latestCacheWrite(activeStories), highlights: latestCacheWrite(highlights) };
    const originalMediaUrls = new Set<string>();
    const addMediaUrl = (url: string | null | undefined): void => {
      if (url) originalMediaUrls.add(url);
    };
    addMediaUrl(account.profilePicUrl);
    addMediaUrl(latestSnapshot?.profilePicUrl);
    addMediaUrl(latestSnapshot?.profilePicUrlHd);
    for (const post of filteredPosts) {
      addMediaUrl(post.thumbnailUrl);
      addMediaUrl(post.displayUrl);
      addMediaUrl(post.videoUrl);
      // Fix #7: carousel child URLs must be resolved/cached too, otherwise the
      // modal renders raw IG CDN links for sidecar children that expire.
      for (const child of post.carouselMedia ?? []) {
        addMediaUrl(child.displayUrl);
        addMediaUrl(child.videoUrl);
      }
    }
    for (const story of activeStories) {
      addMediaUrl(story.mediaUrl);
      addMediaUrl(story.thumbnailUrl);
    }
    for (const highlight of highlights) {
      addMediaUrl(highlight.coverUrl);
      for (const item of highlightItemsByCacheId.get(highlight.id) ?? []) {
        addMediaUrl(item.mediaUrl);
        addMediaUrl(item.thumbnailUrl);
      }
    }
    for (const like of filteredLikes) addMediaUrl(like.thumbnailUrl);
    for (const follower of recentFollowersRaw) addMediaUrl(follower.followerPfpUrl);
    for (const unfollower of trustedFollowerUnfollowsRaw) {
      addMediaUrl(unfollower.unfollowerPfpUrl);
    }

    const [cachedMediaUrls] = await Promise.all([
      resolveCachedMediaUrls(originalMediaUrls, { userId, trackedAccountId: account.id }),
      enqueueMediaCacheUrls(originalMediaUrls, "viewer")
        .catch((err) =>
          logger.warn(
            {
              module: "routes",
              route: "viewer",
              err: err instanceof Error ? err.message : String(err),
            },
            "failed to enqueue media cache jobs",
          ),
        ),
    ]);
    const cachedMediaUrl = <T extends string | null | undefined>(url: T): T => {
      if (!url) return url;
      return (cachedMediaUrls.get(url) ?? url) as T;
    };
    // Profile avatars are public metadata even while private content awaits
    // approval. Keep their original CDN URL until content links are eligible.
    const profileMediaUrl = account.isPrivate && account.accessStatus !== "has_access"
      ? <T extends string | null | undefined>(url: T): T => url
      : cachedMediaUrl;
    const profilePicUrl = profileMediaUrl(
      [account.profilePicUrl, latestSnapshot?.profilePicUrl, latestSnapshot?.profilePicUrlHd]
        .find(url => typeof url === "string" && url.trim().length > 0)) ??
      `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanUsername)}&background=random&size=200`;

    res.json({
      igUsername: cleanUsername,
      displayName:
        account.displayName ?? latestSnapshot?.fullName ?? cleanUsername,
      profilePicUrl,
      biography: account.biography ?? latestSnapshot?.biography ?? null,
      isVerified: account.isVerified ?? latestSnapshot?.isVerified ?? false,
      isBusinessAccount:
        account.isBusinessAccount ?? latestSnapshot?.isBusinessAccount ?? false,
      isPrivate: account.isPrivate ?? latestSnapshot?.isPrivate ?? false,
      externalUrl: account.externalUrl ?? latestSnapshot?.externalUrl ?? null,
      followerCount:
        latestSnapshot?.followerCount ?? account.followerCount ?? 0,
      followingCount: latestSnapshot?.followingCount ?? 0,
      postCount: latestSnapshot?.postCount ?? 0,
      postsTotal: postCounts.all,
      postCounts,
      postsCollection,
      topNiche,
      peakActivityHour: peakHour,
      profileSnapshot: latestSnapshot
        ? {
            fullName: latestSnapshot.fullName,
            biography: latestSnapshot.biography,
            profilePicUrl: profileMediaUrl(latestSnapshot.profilePicUrl),
            profilePicUrlHd: profileMediaUrl(latestSnapshot.profilePicUrlHd),
            externalUrl: latestSnapshot.externalUrl,
            isVerified: latestSnapshot.isVerified ?? false,
            isBusinessAccount: latestSnapshot.isBusinessAccount ?? false,
            isPrivate: latestSnapshot.isPrivate ?? false,
            followerCount: latestSnapshot.followerCount,
            followingCount: latestSnapshot.followingCount,
            postCount: latestSnapshot.postCount,
            snapshotAt: latestSnapshot.snapshotAt,
          }
        : null,
      recentPosts: pinnedFirstPosts(filteredPosts).slice(0, 24).map((p) => ({
        shortcode: p.shortcode,
        postType: p.postType,
        thumbnailUrl: cachedMediaUrl(p.thumbnailUrl),
        displayUrl: cachedMediaUrl(p.displayUrl),
        videoUrl: cachedMediaUrl(p.videoUrl),
        caption: p.caption,
        likeCount: p.likeCount ?? 0,
        commentCount: p.commentCount ?? 0,
        videoViewCount: p.videoViewCount,
        takenAt: p.takenAt,
        hashtags: p.hashtags ?? [],
        isPinned: p.isPinned,
        // Fix #7: map each carousel child URL through the same cache resolver
        // the post thumbnail uses, mirroring the tracking/load-more endpoint.
        carouselMedia: p.carouselMedia
          ? p.carouselMedia.map((child) => ({
              ...child,
              displayUrl: cachedMediaUrl(child.displayUrl),
              videoUrl: cachedMediaUrl(child.videoUrl),
            }))
          : null,
      })),
      stories: activeStories.map((s) => ({
        storyId: s.storyId,
        mediaType: s.mediaType,
        mediaUrl: cachedMediaUrl(s.mediaUrl),
        thumbnailUrl: cachedMediaUrl(s.thumbnailUrl),
        takenAt: s.takenAt,
        expiresAt: s.expiresAt,
      })),
      highlights: highlights.map((h) => ({
        highlightId: h.highlightId,
        title: h.title,
        coverUrl: cachedMediaUrl(h.coverUrl),
        mediaCount: h.mediaCount ?? 0,
        items: (highlightItemsByCacheId.get(h.id) ?? []).map((item) => ({
          ...item,
          mediaUrl: cachedMediaUrl(item.mediaUrl),
          thumbnailUrl: cachedMediaUrl(item.thumbnailUrl),
        })),
      })),
      // Return every retained liked-post evidence row. The gallery reveals
      // these incrementally, so an API slice only created an invisible hard
      // ceiling (formerly 60) without saving DOM work.
      recentLikes: filteredLikes.map((l) => ({
        postId: l.postId,
        ownerUsername: l.ownerUsername,
        postType: l.postType,
        thumbnailUrl: cachedMediaUrl(l.thumbnailUrl),
        postUrl: l.postUrl,
        hashtags: l.hashtags ?? [],
        likesCount: l.likesCount ?? 0,
        commentsCount: l.commentsCount ?? 0,
        videoViewCount: l.videoViewCount ?? null,
        /** When the post was published; null for rows captured before 0030. */
        postTakenAt: l.postTakenAt ?? null,
        detectedAt: l.detectedAt,
      })),
      // "Recently followed" must be genuinely-new follows, not roster DISCOVERY.
      // follow_events records "we first saw they follow X", so the first full
      // enumeration emits one row per already-followed account — which rendered
      // as a data dump (16,071 rows for an account that follows 1,090). Only
      // events AFTER the roster was first completely enumerated are real follows;
      // before that boundary (or with no boundary yet) we show nothing rather
      // than pass discovery noise off as activity.
      recentFollows: (followingActivityBoundary
        ? recentFollowsRaw.filter(
            (f) => f.detectedAt > followingActivityBoundary,
          )
        : []
      )
        .slice(0, 50)
        .map((f) => ({
        followedUsername: f.followedUsername,
        followedDisplayName:
          f.followedDisplayName ??
          displayFor(f.followedUsername)?.displayName ??
          f.followedUsername,
        followedPfpUrl: cachedMediaUrl(displayFor(f.followedUsername)?.pfpUrl ?? null),
        detectedAt: f.detectedAt,
      })),
      recentFollowers: recentFollowersRaw.slice(0, 50).map((f) => ({
        followerUsername: f.followerUsername,
        followerDisplayName: f.followerDisplayName,
        followerPfpUrl: cachedMediaUrl(f.followerPfpUrl),
        detectedAt: f.detectedAt,
      })),
      // Accounts this profile unfollowed — now the roster's confirmed-departed
      // members (is_current=false), which already carry display name + pfp.
      // Still gated on the following-side trust flag so we stay silent until the
      // roster is settled enough to vouch for departures.
      recentUnfollows: (followingUnfollowsTrusted ? recentUnfollowsRaw : [])
        .slice(0, 50)
        .map((u) => ({
          unfollowedUsername: u.unfollowedUsername,
          unfollowedDisplayName: u.unfollowedDisplayName ?? null,
          unfollowedPfpUrl: cachedMediaUrl(u.unfollowedPfpUrl ?? null),
          detectedAt: u.detectedAt,
        })),
      recentFollowerUnfollows: trustedFollowerUnfollowsRaw.slice(0, 50).map((f) => ({
        unfollowerUsername: f.unfollowerUsername,
        unfollowerDisplayName: f.unfollowerDisplayName,
        unfollowerPfpUrl: cachedMediaUrl(f.unfollowerPfpUrl),
        detectedAt: f.detectedAt,
      })),
      rosterStatus: {
        followers: {
          background: followerBackground,
          loadedTotal: followersRosterStatus.total,
          expectedTotal: followerExpectedTotal,
          completionPct:
            followerExpectedTotal > 0
              ? Math.min(
                  100,
                  Math.round(
                    (followersRosterStatus.total / followerExpectedTotal) * 100,
                  ),
                )
              : null,
          // Tri-state, not naive reported>loaded: IG's reported count is
          // almost always unreachable (ghost/deactivated/private followers), so
          // reported>loaded stayed true forever → "still syncing" banner that
          // never cleared. computeRosterSyncState returns "syncing" only while
          // the importer is genuinely still walking; once the walk completed
          // (lastGraphRefreshAt set) a below-reported roster is "capped", not
          // partial. Mirrors the paged roster endpoints (see /followers route).
          syncState: followerRosterSyncState,
          isPartial:
            followerRosterSyncState === "syncing" ||
            followerRosterSyncState === "restricted",
          lastUpdatedAt: followersRosterStatus.lastUpdatedAt,
          failureKind: followersRosterHealth.failureKind,
          lastAttemptAt: followersRosterHealth.lastAttemptAt,
          lastSuccessfulAt: followersRosterHealth.lastSuccessAt,
          lastCompleteReadAt: followersRosterHealth.lastCompleteReadAt ?? null,
          nextRetryAt: followersRosterHealth.nextRetryAt,
          unfollowDetectionTrusted: followerUnfollowsTrusted,
        },
        following: {
          background: followingBackground,
          loadedTotal: followingRosterStatus.total,
          expectedTotal: followingExpectedTotal,
          completionPct:
            followingExpectedTotal > 0
              ? Math.min(
                  100,
                  Math.round(
                    (followingRosterStatus.total / followingExpectedTotal) * 100,
                  ),
                )
              : null,
          syncState: followingRosterSyncState,
          isPartial:
            followingRosterSyncState === "syncing" ||
            followingRosterSyncState === "restricted",
          lastUpdatedAt: followingRosterStatus.lastUpdatedAt,
          failureKind: followingRosterHealth.failureKind,
          lastAttemptAt: followingRosterHealth.lastAttemptAt,
          lastSuccessfulAt: followingRosterHealth.lastSuccessAt,
          lastCompleteReadAt: followingRosterHealth.lastCompleteReadAt ?? null,
          nextRetryAt: followingRosterHealth.nextRetryAt,
          unfollowDetectionTrusted: followingUnfollowsTrusted,
        },
      },
      activityByHour,
      activityByDate,
      weeklyStats: {
        totalLikes: Number(totalLikesCount[0]?.value ?? 0),
        totalFollows: Number(totalFollowsCount[0]?.value ?? 0),
        totalUnfollows: trustedTotalUnfollows,
        totalPosts: publishedPostsThisWeek,
      },
      dataSource,
      cachedAt,
      contentCachedAt,
      tz,
      postTypeFilter,
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // STRIPE WEBHOOK (no session auth — authenticity comes from the Stripe
  // signature, which is ALWAYS required. Fail-closed when unconfigured.)
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/webhooks/stripe",
    async (req: Request, res: Response) => {
      const sig = req.headers["stripe-signature"];
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      // A real signing secret comes from the Stripe dashboard and always
      // starts with "whsec_". Treat missing, placeholder, or malformed
      // values as "not configured" and refuse to process events.
      if (
        !webhookSecret ||
        !webhookSecret.startsWith("whsec_") ||
        webhookSecret.includes("placeholder") ||
        webhookSecret.includes("your_webhook_secret")
      ) {
        // Explicit, opt-in local-dev bypass ONLY. Requires BOTH the env flag
        // and a non-production NODE_ENV. Default behavior is fail-closed.
        const allowUnverified =
          process.env.STRIPE_WEBHOOK_ALLOW_UNVERIFIED === "true" &&
          process.env.NODE_ENV !== "production";

        if (allowUnverified) {
          console.warn(
            "[stripe webhook] SECURITY WARNING: processing UNVERIFIED webhook payload " +
              "because STRIPE_WEBHOOK_ALLOW_UNVERIFIED=true and NODE_ENV is not " +
              "'production'. Never enable this on a reachable server.",
          );
          await handleStripeEvent(req.body as Stripe.Event);
          res.json({ received: true });
          return;
        }

        console.error(
          "[stripe webhook] rejected event: STRIPE_WEBHOOK_SECRET is missing or a " +
            "placeholder. Paste the real whsec_ signing secret from the Stripe " +
            "dashboard (Developers → Webhooks → endpoint → Signing secret).",
        );
        res.status(503).json({ message: "Stripe webhook not configured" });
        return;
      }

      if (!sig) {
        res.status(400).json({ message: "Missing stripe-signature header" });
        return;
      }

      if (!stripe) {
        res.status(503).json({ message: "Payment system not configured" });
        return;
      }

      // express.json({ verify }) in server/index.ts captures the exact raw
      // request bytes — constructEvent must see those, not re-serialized JSON.
      const rawBody = req.rawBody;
      if (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string") {
        console.error("[stripe webhook] raw body unavailable — cannot verify signature");
        res.status(400).json({ message: "Invalid webhook payload" });
        return;
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Webhook signature verification failed";
        console.error("[stripe webhook] signature error:", message);
        res.status(400).json({ message });
        return;
      }

      await handleStripeEvent(event);
      res.json({ received: true });
    },
  );

  return httpServer;
}

// ─── Stripe event handler ─────────────────────────────────────────────────────

async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  const financialEvents = new Set(["charge.refunded", "charge.dispute.created", "refund.created", "refund.updated", "refund.failed"]);
  const supported = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "customer.subscription.created",
    "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.trial_will_end", "invoice.paid",
    "invoice.payment_succeeded", "invoice.payment_failed", "invoice.payment_action_required", ...financialEvents]);
  if (!supported.has(event.type)) return;
  const object = event.data.object as unknown as { id: string; customer?: string | { id: string }; subscription?: unknown;
    payment_intent?: string | { id: string }; charge?: string | { id: string } };
  let customerId = typeof object.customer === "string" ? object.customer : object.customer?.id;
  let paymentIntentId = typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id;
  if (financialEvents.has(event.type) && stripe) {
    if (!paymentIntentId && object.charge) {
      const chargeId = typeof object.charge === "string" ? object.charge : object.charge.id;
      const charge = await stripe.charges.retrieve(chargeId, {}, { timeout: 15_000, maxNetworkRetries: 0 });
      paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    }
    if (paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {}, { timeout: 15_000, maxNetworkRetries: 0 });
      const owner = typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
      if (customerId && customerId !== owner) throw new Error("Payment event customer mismatch");
      customerId = owner;
    }
  }
  if (!customerId || (event.type.startsWith("checkout.session.") && !object.subscription)) return;
  await processStripeEventOnce(event, customerId, async () => {
    if (!stripe) throw new Error("Stripe is not configured");
    if (financialEvents.has(event.type)) {
      if (!paymentIntentId) return;
      await reconcileTrialPaymentFinancialEvent(stripe, customerId, paymentIntentId);
    }
    // Serialize by CUSTOMER, not event/subscription: an old cancellation must
    // not overwrite a newer active subscription belonging to the same user.
    const candidates = await stripe.subscriptions.list(
      { customer: customerId, status: "all", limit: 100 }, { timeout: 15_000, maxNetworkRetries: 0 },
    );
    // Incomplete history cannot prove that no older active subscription exists.
    // Fail closed (Stripe retries) rather than downgrade from a partial list.
    if (candidates.has_more) throw new Error("Stripe subscription history exceeds reconciliation page limit");
    const current = chooseCurrentSubscription(candidates.data);
    operationSignal()?.throwIfAborted();
    if (!current) return;
    await syncSubscription(current,{invoiceAttentionEvent:event.type === "invoice.payment_failed" || event.type === "invoice.payment_action_required"});
    if (event.type === "customer.subscription.trial_will_end") {
      // The current subscription wins over delayed events for an older trial.
      if (current.id===object.id && current.status==="trialing" && !current.cancel_at_period_end && !current.cancel_at && current.trial_end && current.trial_end*1000>Date.now() && current.trial_end*1000<=Date.now()+3*86_400_000) {
        const [sub] = await db.select({userId:subscriptions.userId}).from(subscriptions).where(eq(subscriptions.stripeSubscriptionId,current.id)).limit(1);
        if (sub) await recordTrialEndingEmail(db,sub.userId,current.id,new Date(current.trial_end*1000).toISOString());
      }
      return;
    }
    if (event.type !== "invoice.payment_failed" && event.type !== "invoice.payment_action_required") return;
    const invoice = await stripe.invoices.retrieve(object.id, {expand:["payments.data.payment.payment_intent"]}, { timeout: 15_000, maxNetworkRetries: 0 });
    const latestInvoiceId = typeof current.latest_invoice === "string" ? current.latest_invoice : current.latest_invoice?.id;
    // A delayed failure for an invoice already paid/replaced is not a current
    // failure. Never force status=past_due from an old invoice event snapshot.
    if (invoice.status !== "open" || latestInvoiceId !== invoice.id || !["past_due", "unpaid", "incomplete"].includes(current.status)) return;
    const attention=currentInvoiceAttention(invoice);
    if (!attention) return;
    const actionRequired=attention==="action_required";
    operationSignal()?.throwIfAborted();
    const [sub] = await db.select({ userId: subscriptions.userId }).from(subscriptions)
      .where(eq(subscriptions.stripeCustomerId, customerId)).limit(1);
    if (sub) await recordInvoiceEmail(db,sub.userId,{subscriptionId:current.id,customerId,invoiceId:invoice.id,
      attempt:invoice.attempt_count,actionRequired});
    if (sub) await createNotification({
      userId: sub.userId, type: "payment_failed",
      title: actionRequired ? "Payment authorization required" : "Payment Failed",
      body: actionRequired
        ? "Your bank requires payment authorization. Open billing to review your invoice and complete the required steps."
        : "Your payment failed. Please update your billing information to continue your subscription.",
      dedupeKey: `stripe:invoice:${invoice.id}:${attention}:${invoice.attempt_count}`,
    });
  });
}
