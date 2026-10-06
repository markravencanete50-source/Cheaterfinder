import { trackedAccountHasAccess } from "./subscription-access.js";
// ─── Tier-1 public-read client ──────────────────────────────────────────────
//
// The product needs basic PUBLIC profile data (pic, bio, follower/following/
// post counts, and the ~12 most-recent posts) to appear INSTANTLY — no bot
// lease, no Playwright browser, no "syncing" wait. Instagram's public
// `web_profile_info` endpoint serves exactly that in ONE unauthenticated JSON
// request. The only requirement is a non-datacenter egress IP (datacenter IPs
// get 429'd), so we route through a residential proxy endpoint — but WITHOUT
// leasing or authenticating a bot.
//
// INVARIANTS (do not break):
//   - This client NEVER sends session cookies and NEVER leases a bot. It can
//     not get any bot account banned, because no account is involved.
//   - It is cheap: one tiny JSON per call, a process-wide shared proxy
//     endpoint (reused, not re-probed per call), and a short result cache so
//     "add account" + "open dashboard" for the same handle hit IG once.
//   - Anything that genuinely needs auth (stories, highlights, follower/
//     following lists, likers, private-account posts) stays on the bot
//     pipeline (ig-public-scraper.ts) — this client only does Tier-1.
//   - Instagram is still contacted ONLY by the local FastAPI service: pyhttpz
//     owns this unauthenticated HTTP request and its Firefox-derived identity.
// ─────────────────────────────────────────────────────────────────────────────

import { and, desc, gt, isNotNull } from "drizzle-orm";

import { db } from "../db.js";
import { botAccounts } from "../../shared/schema.js";
import { parseProfileResponse } from "../domain/ig-schemas.js";
import type { IGProfile, IGProfilePostPreview } from "../domain/ig-client-port.js";
import {
  extractHashtags,
  mapProfile,
  type IGPostSummary,
  type IGPublicProfile,
} from "../ig-public-scraper.js";
import {
  fetchEndpoints,
  proxyAgentUriForEndpoint,
} from "./proxy-provider.js";
import {
  createAutomationClient,
  type AutomationIdentity,
  type AutomationProxy,
} from "./automation-client.js";
import { recordBytes, withScrapeContext } from "./bandwidth-meter.js";
import { applyProfileToDb } from "./public-data-collector.js";
import { persistPosts } from "./public-data-persistence.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "public-read-client" });

export type Tier1FailReason =
  | "timeout"
  | "rate_limited"
  | "not_found"
  | "no_proxy"
  | "error";

export type Tier1Result =
  | { ok: true; profile: IGPublicProfile; posts: IGPostSummary[] }
  | { ok: false; reason: Tier1FailReason; status?: number };

const DEFAULT_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.TIER1_TIMEOUT_MS ?? "3500") || 3500,
);
const MAX_CONCURRENT = Math.max(
  1,
  Number(process.env.TIER1_MAX_CONCURRENT ?? "3") || 3,
);
const RESULT_TTL_MS = Math.max(
  10_000,
  Number(process.env.TIER1_RESULT_TTL_MS ?? "90000") || 90_000,
);
// Refresh the shared endpoint well before its sticky window closes.
const ENDPOINT_GUARD_MS = 2 * 60 * 1000;
// ── Shared residential endpoint (reused across all Tier-1 calls) ─────────────

let sharedEndpoint: { endpoint: string; expiresAt: Date } | null = null;
let endpointInflight: Promise<string | null> | null = null;
let publicReadIdentity: AutomationIdentity | null = null;
let publicReadIdentityInflight: Promise<AutomationIdentity> | null = null;

function automationProxyFromEndpoint(endpoint: string): AutomationProxy {
  const parsed = new URL(proxyAgentUriForEndpoint(endpoint));
  return {
    server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  };
}

/**
 * Tier-1 has no account/session, but it still gets one Python-minted Firefox
 * identity per process.  This replaces the old hard-coded Chrome User-Agent
 * and keeps every Instagram-facing request behind the FastAPI boundary.
 */
async function getPublicReadIdentity(): Promise<AutomationIdentity> {
  if (publicReadIdentity) return publicReadIdentity;
  if (!publicReadIdentityInflight) {
    publicReadIdentityInflight = createAutomationClient({ timeoutMs: 10_000 })
      .createIdentity({
        bot_id: "tier1-public-reader",
        locale: "en-US",
        timezone: "America/New_York",
      })
      .then((identity) => {
        publicReadIdentity = identity;
        return identity;
      })
      .finally(() => {
        publicReadIdentityInflight = null;
      });
  }
  return publicReadIdentityInflight;
}

/**
 * Cheapest source first: borrow a warm bot's still-valid residential endpoint
 * read-only (zero new spend, the lane is already paid for). We do NOT lease
 * the bot, touch lastUsedAt, or use its cookies.
 */
async function borrowWarmBotEndpoint(): Promise<{ endpoint: string; expiresAt: Date } | null> {
  const cutoff = new Date(Date.now() + ENDPOINT_GUARD_MS);
  const [row] = await db
    .select({
      endpoint: botAccounts.proxyEndpoint,
      expiresAt: botAccounts.proxyExpiresAt,
    })
    .from(botAccounts)
    .where(
      and(
        isNotNull(botAccounts.proxyEndpoint),
        isNotNull(botAccounts.proxyExpiresAt),
        gt(botAccounts.proxyExpiresAt, cutoff),
      ),
    )
    .orderBy(desc(botAccounts.proxyExpiresAt))
    .limit(1);
  if (row?.endpoint && row.expiresAt) {
    return { endpoint: row.endpoint, expiresAt: row.expiresAt };
  }
  return null;
}

async function getSharedTier1Endpoint(): Promise<string> {
  if (
    sharedEndpoint &&
    sharedEndpoint.expiresAt.getTime() - Date.now() > ENDPOINT_GUARD_MS
  ) {
    return sharedEndpoint.endpoint;
  }

  const borrowed = await borrowWarmBotEndpoint();
  if (borrowed) {
    sharedEndpoint = borrowed;
    return borrowed.endpoint;
  }

  // No warm bot lane — allocate one candidate and cache it process-wide. The
  // actual public read below is the only meaningful validation for an
  // unauthenticated lane; pre-probing it just creates a guaranteed
  // login-required response and wastes bandwidth.
  // A single in-flight guard prevents a thundering herd during signup bursts.
  if (!endpointInflight) {
    endpointInflight = (async () => {
      try {
        const [ep] = await fetchEndpoints({
          country: "US",
          count: 1,
          purpose: "public-read",
        });
        if (ep) {
          sharedEndpoint = { endpoint: ep.endpoint, expiresAt: ep.expiresAt };
          return ep.endpoint;
        }
        return null;
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "[tier1] could not resolve a shared proxy endpoint",
        );
        return null;
      } finally {
        endpointInflight = null;
      }
    })();
  }
  const endpoint = await endpointInflight;
  if (endpoint === null) throw new Error("no_proxy");
  return endpoint;
}

function invalidateSharedEndpoint(): void {
  sharedEndpoint = null;
}

// ── Result cache + concurrency guard ────────────────────────────────────────

interface CacheEntry {
  at: number;
  result: Tier1Result;
}
const resultCache = new Map<string, CacheEntry>();
let activeCount = 0;

function getCached(username: string): Tier1Result | null {
  const hit = resultCache.get(username);
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) return hit.result;
  return null;
}

function setCached(username: string, result: Tier1Result): void {
  resultCache.set(username, { at: Date.now(), result });
  // Map preserves insertion order — evict oldest-first when over the cap so the
  // map stays bounded even if 1000+ distinct usernames are fetched inside one
  // TTL window (TTL-only pruning could leave it unbounded under a burst).
  while (resultCache.size > 1000) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

// ── Mapping: inline timeline preview → posts_cache row shape ─────────────────

function previewToSummary(p: IGProfilePostPreview): IGPostSummary {
  const caption = p.caption ?? "";
  return {
    shortcode: p.shortcode,
    mediaId: p.id,
    // The inline preview only flags video vs image — carousels look like
    // images here. The Tier-2 feed scrape corrects post_type later.
    postType: p.isVideo ? "video" : "photo",
    thumbnailUrl: p.thumbnailUrl ?? "",
    displayUrl: p.thumbnailUrl ?? "",
    videoUrl: null,
    caption,
    likeCount: p.likeCount,
    commentCount: p.commentCount,
    videoViewCount: null,
    takenAt: new Date((p.takenAtTimestamp || 0) * 1000),
    locationName: null,
    hashtags: extractHashtags(caption),
    // The inline web-profile preview carries neither the pinned signal nor
    // carousel children; the Tier-2 feed scrape backfills both later.
    isPinned: false,
    carouselMedia: null,
  };
}

function mapPosts(profile: IGProfile): IGPostSummary[] {
  return profile.posts
    .filter((p) => p.shortcode && p.id)
    .map(previewToSummary);
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function doFetch(
  username: string,
  timeoutMs: number,
): Promise<Tier1Result> {
  let endpoint: string;
  try {
    endpoint = await getSharedTier1Endpoint();
  } catch {
    return { ok: false, reason: "no_proxy" };
  }

  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
    username,
  )}`;

  let response: Awaited<ReturnType<ReturnType<typeof createAutomationClient>["requestInstagramHttp"]>>;
  try {
    const identity = await getPublicReadIdentity();
    response = await createAutomationClient({ timeoutMs: timeoutMs + 5_000 })
      .requestInstagramHttp({
        identity,
        storage_state: {},
        proxy: automationProxyFromEndpoint(endpoint),
        request: {
          method: "GET",
          path: `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
          referer: `/${encodeURIComponent(username)}/`,
          timeout_ms: timeoutMs,
        },
      },
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(msg)) return { ok: false, reason: "timeout" };
    // Bad endpoint / automation transport failure — rotate the shared lane
    // next time, never retry directly from Node.
    invalidateSharedEndpoint();
    return { ok: false, reason: "error" };
  }

  const status = response.status;
  const text = response.body;
  // Attribute the bytes to the active scrape context (the caller wraps this in
  // withScrapeContext) so the admin bandwidth panel sees Tier-1 traffic too.
  recordBytes({
    endpoint: "web_profile_info_tier1",
    bytesIn: Buffer.byteLength(text, "utf8"),
    bytesOut: Buffer.byteLength(url, "utf8"),
  });

  if (status === 429 || status === 401 || status === 403) {
    // IG distrusts this IP for our traffic — drop it so we rotate next call.
    invalidateSharedEndpoint();
    return { ok: false, reason: "rate_limited", status };
  }
  if (status === 404) return { ok: false, reason: "not_found", status };
  if (status < 200 || status >= 300) return { ok: false, reason: "error", status };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "error" };
  }

  let profileRaw: IGProfile;
  try {
    profileRaw = parseProfileResponse(raw);
  } catch {
    // A malformed envelope or login wall does not prove the handle is absent.
    return { ok: false, reason: "error" };
  }

  if (profileRaw.username.toLowerCase() !== username.toLowerCase()) return { ok: false, reason: "error" };

  // Private accounts still expose pic/bio/counts here; IG just omits the
  // timeline media, so `posts` comes back empty. We return ok with the header
  // so the UI shows it instantly; posts come from the bot pipeline once a
  // follow request is accepted.
  return { ok: true, profile: mapProfile(profileRaw), posts: mapPosts(profileRaw) };
}

/**
 * Fetch Tier-1 public profile data with no bot lease and no auth. Returns
 * quickly: a short timeout, a result cache, and a concurrency cap mean it never
 * blocks a request path or hammers IG during signup bursts. On any failure the
 * caller should fall back to the background bot pipeline.
 */
export async function fetchPublicProfileTier1(
  username: string,
  opts?: { timeoutMs?: number },
): Promise<Tier1Result> {
  const key = username.trim().toLowerCase().replace(/^@/, "");
  if (!key) return { ok: false, reason: "not_found" };

  const cached = getCached(key);
  if (cached) return cached;

  if (activeCount >= MAX_CONCURRENT) {
    // Saturated — don't queue/block; let the caller fall back to background.
    return { ok: false, reason: "rate_limited" };
  }

  activeCount += 1;
  try {
    const result = await doFetch(key, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // Cache ONLY successes. Transient failures (timeout/rate_limited/error) and
    // not_found (which can be a transient IG login-wall) must stay immediately
    // retryable, so a profile self-heals the moment proxies recover instead of
    // serving a pinned failure for the full TTL.
    if (result.ok) setCached(key, result);
    return result;
  } finally {
    activeCount -= 1;
  }
}

// ── Stale-while-revalidate ──────────────────────────────────────────────────

const STALE_TTL_MS = Math.max(
  60_000,
  Number(process.env.TIER1_STALE_TTL_MS ?? "180000") || 180_000,
);

// In-flight revalidation guard. A plain Set leaked: if a background fetch never
// settled (its `finally` cleanup never ran — e.g. an unhandled rejection path,
// or a hang inside applyProfileToDb), the account's id stayed in the set
// FOREVER, permanently suppressing all future revalidation for it. We store a
// start timestamp instead and treat an entry older than REVALIDATE_LOCK_TTL_MS
// as stale (the prior attempt is presumed dead), so revalidation self-heals.
const REVALIDATE_LOCK_TTL_MS = Math.max(
  30_000,
  Number(process.env.TIER1_REVALIDATE_LOCK_TTL_MS ?? "300000") || 300_000,
);
const revalidating = new Map<string, number>();

/**
 * True if `id` has a non-expired in-flight revalidation lock. Opportunistically
 * drops the entry if it has aged past the TTL so the map can't accumulate dead
 * locks from never-settling fetches.
 */
function isRevalidating(id: string): boolean {
  const startedAt = revalidating.get(id);
  if (startedAt === undefined) return false;
  if (Date.now() - startedAt >= REVALIDATE_LOCK_TTL_MS) {
    revalidating.delete(id); // stale lock — prior attempt presumed dead
    return false;
  }
  return true;
}

export interface RevalidatableAccount {
  readonly id: string;
  readonly userId: string;
  readonly igUsername: string;
  readonly isActive: boolean;
}

export type Tier1RefreshOutcome =
  | {
      readonly ok: true;
      readonly posts: number;
      readonly isPrivate: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: Tier1FailReason | "inactive" | "in_flight";
    };

/**
 * Refresh and persist the public-only slice for one tracked account.
 *
 * This path never leases a bot or sends session cookies. The shared in-flight
 * guard is also used by request-triggered revalidation, so the background
 * monitor and an open dashboard cannot duplicate the same Instagram read.
 */
export async function refreshPublicProfileTier1(
  account: RevalidatableAccount,
): Promise<Tier1RefreshOutcome> {
  if (!account.isActive) return { ok: false, reason: "inactive" };
  if (isRevalidating(account.id)) return { ok: false, reason: "in_flight" };
  revalidating.set(account.id, Date.now());

  try {
    if (!await trackedAccountHasAccess(account.id)) return { ok: false, reason: "inactive" };
    const tier1 = await withScrapeContext(
      {
        userId: account.userId,
        trackedAccountId: account.id,
        username: account.igUsername,
      },
      () => fetchPublicProfileTier1(account.igUsername),
    );
    if (!tier1.ok) return tier1;

    // Mirror applyProfileToDb's corruption guard before reporting a refresh as
    // successful. A stripped 0/0/0 response is not fresh profile data.
    if (
      tier1.profile.followerCount === 0 &&
      tier1.profile.followingCount === 0 &&
      tier1.profile.postCount === 0
    ) {
      return { ok: false, reason: "error" };
    }

    if (!await trackedAccountHasAccess(account.id)) return { ok: false, reason: "inactive" };
    await applyProfileToDb(account.id, tier1.profile);
    if (tier1.posts.length > 0 && await trackedAccountHasAccess(account.id)) {
      // Tier-1 preview: enrich-only. It carries no video_versions and cannot
      // distinguish reel/video, so it must not clobber authoritative feed data.
      await persistPosts(account.id, tier1.posts, { preview: true });
    }
    return {
      ok: true,
      posts: tier1.posts.length,
      isPrivate: tier1.profile.isPrivate,
    };
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    revalidating.delete(account.id);
  }
}

/**
 * Fire-and-forget background refresh of a tracked account's public profile via
 * Tier-1, IF its latest snapshot is older than TIER1_STALE_TTL_MS. The read
 * handlers serve cache instantly and call this without awaiting; the refreshed
 * data lands a moment later and is pushed to the client via the existing SSE
 * `profile.updated` / `posts.added` events emitted by applyProfileToDb /
 * persistPosts. Never throws into the caller.
 */
export function maybeRevalidateTier1(
  account: RevalidatableAccount,
  lastSnapshotAt: Date | string | null | undefined,
): void {
  if (!account.isActive) return;
  const snapMs = lastSnapshotAt ? new Date(lastSnapshotAt).getTime() : 0;
  if (snapMs && Date.now() - snapMs < STALE_TTL_MS) return; // still fresh
  if (isRevalidating(account.id)) return; // already in flight (and not stale)

  void refreshPublicProfileTier1(account).then((outcome) => {
    if (!outcome.ok && outcome.reason !== "in_flight") {
      logger.debug(
        {
          trackedAccountId: account.id,
          reason: outcome.reason,
        },
        "[tier1] background revalidate failed",
      );
    }
  });
}

/** Test-only reset of module caches. */
export function __resetTier1ForTests(): void {
  sharedEndpoint = null;
  endpointInflight = null;
  publicReadIdentity = null;
  publicReadIdentityInflight = null;
  resultCache.clear();
  activeCount = 0;
  revalidating.clear();
}

/** Test-only inspection of the in-flight revalidation lock. */
export function __isRevalidatingForTests(id: string): boolean {
  return isRevalidating(id);
}
