// ─── Liked-by inference harvester (Wave 9) ───────────────────────────────────
//
// Instagram removed the public "posts a user liked" API. But a logged-in
// account's HOME feed (POST /api/v1/feed/timeline/) and REELS feed
// (POST /api/v1/clips/discover/) inject "suggested" posts carrying a facepile
// of "people you follow who liked this". This module drives a WATCHER bot to
// poll those feeds and match the facepile usernames against active tracked
// accounts, then writes each match into the EXISTING `like_events` table
// (owner_username = the liked post's owner; tracked_account_id = the tracked
// user who liked it). The dashboard's existing LikedPostsGallery surfaces these
// rows unchanged.
//
// HONEST EXPECTATIONS: this is SAMPLED INFERENCE, not a ledger. We only ever
// see the posts IG happens to inject into a watcher's feed, and only likes by
// accounts the watcher already follows. Coverage is partial and non-
// deterministic. Absence of a row does NOT mean the user didn't like a post.
//
// Resilience (mirrors the scraper's transport policy):
//   - HTTP first, through the bot's sticky residential proxy (Audit B1: never
//     direct). On a NON-rate-limit transport/parse anomaly, fall back to the
//     browser transport (same session/proxy, in-page fetch).
//   - Rate-limit (429) / circuit-open / auth-expired are NOT browser-escalated
//     (per-IP throttle shares the browser lane; a dead session fails the same
//     way there). They surface to the worker, which cools the bot and ROTATES
//     to another watcher.
// ─────────────────────────────────────────────────────────────────────────────

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { customerAccessSql } from "./subscription-access.js";
import { findGrantedBotIds } from "./private-account-access.js";
import { withOperationLease } from "./operation-lease.js";
import { feedTransportKey, markHttpFeedWalled, shouldSkipWalledHttp } from "./feed-transport-policy.js";
import {
  botAccounts,
  likeEvents,
  trackedAccounts,
  watcherFollowState,
  type WatcherFollowStateValue,
} from "../../shared/schema.js";
import { ensureBotReady, invalidateObservedBotSession } from "./bot-runtime.js";
import { isShuttingDown, waitForShutdownOrTimeout } from "./shutdown-state.js";
import { isCheckpointError } from "./ig-checkpoint.js";
import {
  shouldProbeTarget,
  stateFromFriendship,
  type LandedFollowState,
  type ObservedFollowState,
  type ShouldProbeOptions,
  type WatcherFollowStateRow,
} from "./watcher-follow-policy.js";
import {
  createBotClient,
  IGAuthExpiredError,
  IGRateLimitedError,
  type IGClient,
} from "../ig-http-client.js";
import {
  IGCircuitOpenError,
  type IGFriendshipStatus,
} from "../domain/ig-client-port.js";
import { createBrowserReadClient } from "../ig-browser-read-client.js";
import { createMobileReadClient } from "../ig-mobile-read-client.js";
import { parseMobileEnvelope } from "./mobile-session.js";
import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import { playwrightSendFollowByUsername } from "../ig-playwright-client.js";
import { sendBrowserFollow } from "./bot-follow-browser.js";
import { proxyAgentUriForEndpoint } from "./proxy-provider.js";
import type { DeviceFingerprint } from "../behavior/device-fingerprint.js";
import { enqueueMediaCacheUrls } from "./media-cache-jobs.js";
import { isLikedPostAfterTrackingStart } from "./like-event-policy.js";
import {
  cooldownBotForCheckpoint,
  cooldownBotForRateLimit,
} from "./bot-cooldown.js";
import {
  extractHashtags,
  parseLikedByFeed,
  type HarvestedMedia,
} from "./liked-by-feed-parser.js";
import { logger as baseLogger } from "../observability/logger.js";
import { postCreatedAt } from "./ig-media-time.js";
import type { AutomationIdentity } from "./automation-client.js";

const logger = baseLogger.child({ module: "liked-by-harvester" });

const MEDIA_CACHE_REASON = "liked-by";

export type WatcherKind = "feed" | "reels";

interface FeedEndpoint {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly body: string;
}

function endpointFor(kind: WatcherKind): FeedEndpoint {
  if (kind === "feed") {
    return {
      path: "/api/v1/feed/timeline/",
      method: "POST",
      body: "reason=cold_start_fetch&is_pull_to_refresh=0",
    };
  }
  return { path: "/api/v1/clips/discover/", method: "POST", body: "" };
}

/** The watcher role a given feed kind is served by. */
export function roleForKind(kind: WatcherKind): "feed_watcher" | "reels_watcher" {
  return kind === "feed" ? "feed_watcher" : "reels_watcher";
}

/**
 * Errors that mean "this watcher is throttled/broken right now — rotate to the
 * next one". The worker uses this to decide whether to try another watcher.
 */
export function isRotateSignal(err: unknown): boolean {
  return (
    err instanceof IGRateLimitedError ||
    err instanceof IGCircuitOpenError ||
    err instanceof IGAuthExpiredError
  );
}

// Raw exception messages can contain credentials, upstream bodies or target
// identities. Preserve only bounded diagnostic fields across safe-error logging.
function harvestErrorDetails(err: unknown): Record<string, string | number | boolean> {
  const value = err && typeof err === "object" ? err as Record<string, unknown> : {};
  const knownKinds = new Set(["IGRateLimitedError", "IGCircuitOpenError", "IGAuthExpiredError",
    "IGHttpError", "IGSchemaError", "AutomationServiceError", "OperationBusyError", "AbortError", "TimeoutError"]);
  const details: Record<string, string | number | boolean> = {
    errorKind: typeof value.name === "string" && knownKinds.has(value.name) ? value.name : "unknown",
  };
  if (typeof value.status === "number" && Number.isInteger(value.status)
      && (value.status === 0 || (value.status >= 100 && value.status <= 599))) details.errorStatus = value.status;
  const cause = value.cause && typeof value.cause === "object" ? value.cause as Record<string, unknown> : {};
  if (typeof cause.name === "string" && knownKinds.has(cause.name)) details.errorCauseKind = cause.name;
  if (typeof cause.status === "number" && Number.isInteger(cause.status)
      && (cause.status === 0 || (cause.status >= 100 && cause.status <= 599))) details.errorCauseStatus = cause.status;
  const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
    "EPIPE", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]);
  const networkCode = typeof cause.code === "string" ? cause.code : value.code;
  if (typeof networkCode === "string" && networkCodes.has(networkCode)) details.errorNetworkCode = networkCode;
  const codes = new Set(["checkpoint_required", "challenge_required", "feedback_required", "login_required"]);
  if (typeof value.igErrorCode === "string" && codes.has(value.igErrorCode)) details.igErrorCode = value.igErrorCode;
  const message = typeof value.message === "string" ? value.message : "";
  const reasons = ["login_required", "challenge_required", "target_navigation_mismatch", "friendship_unavailable",
    "rate_limited", "follow_control_unavailable", "insufficient_confirmation_time", "follow_not_confirmed",
    "saved_session_unavailable", "deadline_exceeded", "browser_operation_failed"];
  const reason = reasons.find(reason => message.includes(`(${reason})`));
  if (reason) details.errorReason = reason;
  else if (/response not JSON|non-JSON response|HTTP feed currently returns non-JSON/i.test(message)) details.errorReason = "non_json_response";
  else if (/operation already in progress/i.test(message)) details.errorReason = "operation_busy";
  const response = value.responseDiagnostics && typeof value.responseDiagnostics === "object"
    ? value.responseDiagnostics as Record<string, unknown> : {};
  for (const [key, allowed] of Object.entries({
    responseUrlClass: ["login", "challenge", "suspended", "instagram_api", "instagram_home", "instagram_other", "external", "unknown"],
    contentType: ["html", "json", "other", "unknown"],
    titleClass: ["instagram", "login", "challenge", "other", "absent"],
  })) {
    if (typeof response[key] === "string" && allowed.includes(response[key] as string)) details[key] = response[key] as string;
  }
  if (typeof response.responseRedirected === "boolean") details.responseRedirected = response.responseRedirected;
  if (Number.isSafeInteger(response.responseBytes) && (response.responseBytes as number) >= 0) details.responseBytes = response.responseBytes as number;
  return details;
}

export interface HarvestMatch {
  readonly trackedAccountId: string;
  readonly postShortcode: string;
  readonly postOwnerUsername: string;
  readonly thumbnailUrl: string | null;
  readonly source: WatcherKind;
}

export interface HarvestResult {
  readonly botId: string;
  readonly kind: WatcherKind;
  /** Suggested posts that carried a liker facepile. */
  readonly fetchedPosts: number;
  /** Facepile likers that matched an active tracked account. */
  readonly matched: number;
  /** New like_events rows actually inserted (idempotent; excludes conflicts). */
  readonly inserted: number;
  readonly matches: ReadonlyArray<HarvestMatch>;
}

interface WatcherContext {
  readonly botId: string;
  readonly igUsername: string;
  readonly sessionData: string;
  readonly proxyEndpoint: string;
  readonly fingerprint: DeviceFingerprint;
  // Null for mobile-transport watchers (Bearer session, no Firefox identity).
  readonly automationIdentity: AutomationIdentity | null;
  readonly transport: "web" | "mobile";
}

function sleep(ms: number): Promise<void> {
  return waitForShutdownOrTimeout(ms).then(()=>undefined);
}

// The legacy IGClient.close() is typed `(): void` (it actually returns a
// promise); the browser port's is `Promise<void>`. Normalise both so teardown
// never throws and we can always await it.
async function closeQuietly(client: {
  close: () => void | Promise<void>;
}): Promise<void> {
  try {
    await client.close();
  } catch {
    /* best-effort teardown */
  }
}

// ── Bot preparation ─────────────────────────────────────────────────────────

// ensureBotReady + resolve the bot's persistent device fingerprint so every
// watcher call wears the same identity its session was created with. The
// runtime resolves the fixed proxy even when the stored endpoint is NULL.
async function prepareWatcher(botId: string): Promise<WatcherContext> {
  const ready = await ensureBotReady(botId, { allowLogin: false });
  if (ready.botId !== botId) throw new Error("[liked-by] watcher runtime does not match assigned bot");
  if (!ready.proxyEndpoint) {
    throw new Error(
      `[liked-by] watcher ${botId} has no canonical proxy — refusing direct IG egress`,
    );
  }
  // Mobile watchers carry a pre-authenticated Bearer session and drive the
  // mobile-API client (no Firefox identity, no csrftoken) — exempt them from
  // the automation-identity guard that gates the legacy web transport.
  if (!ready.automationIdentity && ready.transport !== "mobile") {
    throw new Error(
      `[liked-by] watcher ${botId} has no automation identity; refusing legacy transport`,
    );
  }

  const [row] = await db
    .select({
      deviceId: botAccounts.deviceId,
      deviceUserAgent: botAccounts.deviceUserAgent,
      igAppId: botAccounts.igAppId,
      timezone: botAccounts.timezone,
      locale: botAccounts.locale,
      awakeHourStart: botAccounts.awakeHourStart,
      awakeHourEnd: botAccounts.awakeHourEnd,
    })
    .from(botAccounts)
    .where(eq(botAccounts.id, botId))
    .limit(1);

  const fingerprint = resolveFingerprint({
    igUsername: ready.igUsername,
    deviceId: row?.deviceId,
    deviceUserAgent: row?.deviceUserAgent,
    igAppId: row?.igAppId,
    timezone: row?.timezone,
    locale: row?.locale,
    awakeHourStart: row?.awakeHourStart,
    awakeHourEnd: row?.awakeHourEnd,
  });

  return {
    botId,
    igUsername: ready.igUsername,
    sessionData: ready.sessionData,
    proxyEndpoint: ready.proxyEndpoint,
    fingerprint,
    automationIdentity: ready.automationIdentity,
    transport: ready.transport,
  };
}

function buildHttpClient(ctx: WatcherContext): IGClient {
  return createBotClient(ctx.sessionData, {
    fingerprint: ctx.fingerprint,
    botUsername: ctx.igUsername,
    botId: ctx.botId,
    proxyEndpoint: ctx.proxyEndpoint,
    automationIdentity: ctx.automationIdentity,
  });
}

// ── Feed fetch (HTTP first, browser fallback) ────────────────────────────────

async function fetchFeedViaBrowser(
  ctx: WatcherContext,
  endpoint: FeedEndpoint,
  originalErr: unknown,
): Promise<unknown> {
  let browser;
  try {
    browser = await createBrowserReadClient({
      sessionData: ctx.sessionData,
      fingerprint: ctx.fingerprint,
      botUsername: ctx.igUsername,
      proxyEndpoint: ctx.proxyEndpoint,
      botId: ctx.botId,
      fallbackToHttp: false,
      automationIdentity: ctx.automationIdentity,
    });
  } catch (buildErr) {
    // Playwright unavailable / launch failed → no browser lane. Surface the
    // original HTTP error so the worker's rotation logic sees the real cause.
    logger.warn(
      {
        botId: ctx.botId,
        stage: "browser-init",
        ...harvestErrorDetails(buildErr),
      },
      "[liked-by] browser fallback unavailable; surfacing HTTP error",
    );
    throw originalErr;
  }
  try {
    if (typeof browser.fetchRaw !== "function") throw originalErr;
    return await browser.fetchRaw(endpoint.path, {
      method: endpoint.method,
      body: endpoint.body,
    });
  } catch (err) {
    logger.warn({ botId: ctx.botId, stage: "browser-read", ...harvestErrorDetails(err) },
      "[liked-by] browser feed fetch failed");
    throw err;
  } finally {
    await closeQuietly(browser);
  }
}

async function fetchFeedRaw(
  ctx: WatcherContext,
  endpoint: FeedEndpoint,
): Promise<unknown> {
  // Mobile watchers drive the Bearer session via the mobile-API client (home
  // feed /api/v1/feed/timeline/ is verified working on mobile). No csrftoken,
  // no Firefox identity, and NO browser fallback (mobile has none) — a failure
  // just rotates to the next watcher, same as a web throttle.
  if (ctx.transport === "mobile") {
    const session = parseMobileEnvelope(ctx.sessionData);
    if (!session) {
      throw new Error(`[liked-by] watcher ${ctx.igUsername} is mobile but session is not a valid mobile envelope`);
    }
    const mobile = createMobileReadClient({
      session,
      proxyEndpoint: ctx.proxyEndpoint,
      botId: ctx.botId,
      botUsername: ctx.igUsername,
    });
    try {
      return await mobile.fetchRaw!(endpoint.path, {
        method: endpoint.method,
        body: endpoint.body,
      });
    } finally {
      await closeQuietly(mobile);
    }
  }

  const http = buildHttpClient(ctx);
  const policyKey = feedTransportKey(ctx.botId, ctx.sessionData, endpoint.path);
  if (shouldSkipWalledHttp(policyKey)) {
    // Keep every scheduled update; skip only the proven dead HTTP preamble.
    await closeQuietly(http);
    return fetchFeedViaBrowser(ctx, endpoint, new Error("HTTP feed currently returns non-JSON; browser read required"));
  }
  try {
    return await http.fetchRaw(endpoint.path, {
      method: endpoint.method,
      body: endpoint.body,
    });
  } catch (err) {
    // Do NOT browser-escalate throttles / dead sessions — same IP lane, same
    // failure. Let the worker cool + rotate.
    if (isRotateSignal(err) || isCheckpointError(err)) throw err;
    if (err instanceof Error && /response not JSON/i.test(err.message)) markHttpFeedWalled(policyKey);
    logger.warn(
      {
        botId: ctx.botId,
        path: endpoint.path,
        stage: "http-read",
        ...harvestErrorDetails(err),
      },
      "[liked-by] HTTP feed fetch failed; trying browser fallback",
    );
    return fetchFeedViaBrowser(ctx, endpoint, err);
  } finally {
    await closeQuietly(http);
  }
}

// ── Matching + persistence ───────────────────────────────────────────────────

// Map lower-cased ig_username → every active tracked_account id that uses it.
// The SAME handle can be tracked by multiple users, so one facepile match may
// fan out to several tracked accounts (see schema note on like_events).
type ActiveTrackedAccount = {
  readonly id: string;
  readonly trackingStarted: Date;
};

async function loadActiveTrackedByUsername(botId: string): Promise<
  Map<string, ActiveTrackedAccount[]>
> {
  const rows = await db
    .select({
      id: trackedAccounts.id,
      igUsername: trackedAccounts.igUsername,
      trackingStarted: trackedAccounts.trackingStarted,
      isPrivate: trackedAccounts.isPrivate,
    })
    .from(trackedAccounts)
    .where(and(eq(trackedAccounts.isActive, true), customerAccessSql(trackedAccounts.userId)));

  const map = new Map<string, ActiveTrackedAccount[]>();
  for (const row of rows) {
    // Authorization belongs to this customer's original private row. A public
    // twin or a different watcher must never lend it another viewer's access.
    if (row.isPrivate && !(await findGrantedBotIds(row.id)).includes(botId)) continue;
    const key = row.igUsername.trim().toLowerCase();
    const existing = map.get(key);
    const account = {
      id: row.id,
      trackingStarted: row.trackingStarted,
    };
    if (existing) existing.push(account);
    else map.set(key, [account]);
  }
  return map;
}

type LikeEventInsert = typeof likeEvents.$inferInsert;

function buildLikeEventRow(
  trackedAccountId: string,
  media: HarvestedMedia,
  detectedAt: Date,
): LikeEventInsert {
  return {
    trackedAccountId,
    postId: media.postId,
    ownerUsername: media.ownerUsername,
    postType: media.postType,
    caption: media.caption,
    thumbnailUrl: media.thumbnailUrl,
    postUrl: media.shortcode
      ? `https://www.instagram.com/p/${media.shortcode}/`
      : null,
    hashtags: extractHashtags(media.caption),
    likesCount: media.likeCount,
    commentsCount: media.commentCount,
    videoViewCount: media.videoViewCount,
    locationName: null,
    // The post's own publish time; detectedAt is only when we inferred the
    // like. The liked-by facepile media rarely carries `taken_at`, so fall back
    // to deriving it from the media id/shortcode (Instagram ids encode the
    // creation time) — otherwise the liked-posts section can't sort by post
    // date and silently orders by detection time instead.
    postTakenAt: media.takenAt ?? postCreatedAt(media.shortcode || media.postId),
    detectedAt,
  };
}

async function persistLikeEvents(rows: LikeEventInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(likeEvents)
    .values(rows)
    // Idempotent: the natural key is (tracked_account_id, post_id) — the same
    // pair the normal likes collector arbitrates on (migration 0021).
    .onConflictDoNothing({
      target: [likeEvents.trackedAccountId, likeEvents.postId],
    })
    .returning({ id: likeEvents.id });

  // Persist thumbnails so images survive IG's short-lived CDN URLs. Idempotent
  // (jobId keyed by URL); enqueue every row, not just newly-inserted ones.
  await enqueueMediaCacheUrls(
    rows.map((row) => row.thumbnailUrl),
    MEDIA_CACHE_REASON,
  ).catch((err) =>
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[liked-by] media-cache enqueue failed",
    ),
  );

  return inserted.length;
}

// ── Public: harvest ──────────────────────────────────────────────────────────

/**
 * Poll one watcher bot's feed/reels feed and persist every facepile like that
 * matches an active tracked account into `like_events`.
 *
 * Throttle / circuit-open / auth-expired errors are re-thrown (after cooling a
 * rate-limited bot) so the worker can rotate to another watcher.
 */
export async function harvestLikedBy(
  botId: string,
  kind: WatcherKind,
): Promise<HarvestResult> {
  if ((await loadActiveTrackedByUsername(botId)).size === 0) {
    return { botId, kind, fetchedPosts: 0, matched: 0, inserted: 0, matches: [] };
  }
  const endpoint = endpointFor(kind);
  let watcherUsername: string | undefined;
  let raw: unknown;
  try {
    raw = await withOperationLease(`bot:${botId}`, async () => {
      const ctx = await prepareWatcher(botId);
      watcherUsername = ctx.igUsername;
      try {
        return await fetchFeedRaw(ctx, endpoint);
      } catch (err) {
        if (err instanceof IGAuthExpiredError) {
          // The comparison prevents an old response from clearing a session
          // that another operation has already renewed.
          await invalidateObservedBotSession(botId, ctx.sessionData).catch(() => {
            logger.warn({ botId }, "[liked-by] rejected session invalidation failed");
          });
        }
        throw err;
      }
    });
  } catch (err) {
    logger.warn({ botId, kind, ...harvestErrorDetails(err) }, "[liked-by] harvest failed");
    if (err instanceof IGRateLimitedError) {
      await cooldownBotForRateLimit(botId, err.retryAfterMs).catch(
        (coolErr) =>
          logger.warn(
            { botId, err: coolErr },
            "[liked-by] rate-limit cooldown write failed",
          ),
      );
    } else if (isCheckpointError(err)) {
      await cooldownBotForCheckpoint(botId, "Instagram checkpoint_required", 24).catch(() => undefined);
    }
    throw err;
  }

  const medias = parseLikedByFeed(raw);
  const trackedByUsername = await loadActiveTrackedByUsername(botId);
  const detectedAt = new Date();

  const matches: HarvestMatch[] = [];
  const rows: LikeEventInsert[] = [];
  const seen = new Set<string>(); // batch dedup on (trackedAccountId, postId)

  for (const media of medias) {
    for (const liker of media.likerUsernames) {
      const trackedMatches = trackedByUsername.get(liker);
      if (!trackedMatches) continue;
      for (const trackedAccount of trackedMatches) {
        const postTakenAt =
          media.takenAt ?? postCreatedAt(media.shortcode || media.postId);
        if (
          !isLikedPostAfterTrackingStart(
            postTakenAt,
            trackedAccount.trackingStarted,
          )
        ) {
          continue;
        }
        const trackedAccountId = trackedAccount.id;
        const dedupeKey = `${trackedAccountId}|${media.postId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        matches.push({
          trackedAccountId,
          postShortcode: media.shortcode,
          postOwnerUsername: media.ownerUsername,
          thumbnailUrl: media.thumbnailUrl,
          source: kind,
        });
        rows.push(buildLikeEventRow(trackedAccountId, media, detectedAt));
      }
    }
  }

  const inserted = await persistLikeEvents(rows);

  logger.info(
    {
      botId,
      igUsername: watcherUsername,
      kind,
      fetchedPosts: medias.length,
      matched: matches.length,
      inserted,
    },
    "[liked-by] harvest complete",
  );

  return {
    botId,
    kind,
    fetchedPosts: medias.length,
    matched: matches.length,
    inserted,
    matches,
  };
}

// ── Public: watcher follow maintenance ───────────────────────────────────────

export interface EnsureFollowsOptions {
  /** Max friendship probes per cycle (bounds the watcher's read budget). */
  readonly maxProbes: number;
  /** Max NEW follows to send per cycle (bounds follow velocity). 0 disables. */
  readonly maxNewFollows: number;
}

export interface EnsureFollowsResult {
  /** REAL friendship probes sent to IG this cycle (successful or not). */
  readonly probed: number;
  readonly followed: number;
  /** Targets answered from watcher_follow_state without any IG call. */
  readonly cached: number;
}

interface FollowTarget {
  readonly igUserId: string;
  readonly igUsername: string;
}

// ── Watcher follow state (migration 0045) ────────────────────────────────────
//
// The follow probe used to be stateless: every sweep, every watcher probed
// friendships/show for every target and — measured at 100% of 1,456 probes on
// 2026-09-02 — learned nothing it had not observed 25 minutes earlier. Those
// calls are unmetered and land on the web watchers the squad most needs alive.
// `watcher_follow_state` remembers the last observed state per (watcher,
// target) so the steady state ("already following") costs one probe per
// re-verify window instead of one per sweep.
//
// It fails OPEN everywhere: an unreadable table (e.g. the migration not yet
// applied) or a failed write degrades to the old probe-everything behaviour,
// never to a skipped follow. The facepile HARVEST is not involved at all.

export const DEFAULT_WATCHER_FOLLOW_REVERIFY_HOURS = 24;
const MIN_WATCHER_FOLLOW_REVERIFY_HOURS = 1;
const MAX_WATCHER_FOLLOW_REVERIFY_HOURS = 168;
const HOUR_MS = 3_600_000;
const MAX_LAST_ERROR_CHARS = 500;

/**
 * WATCHER_FOLLOW_REVERIFY_HOURS: how long a confirmed pair state stays
 * authoritative before it is re-probed. Default 24h, clamped to 1..168h;
 * anything unparseable falls back to the default.
 */
export function readWatcherFollowReverifyMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.WATCHER_FOLLOW_REVERIFY_HOURS;
  const parsed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const hours = Number.isFinite(parsed)
    ? Math.min(
        Math.max(parsed, MIN_WATCHER_FOLLOW_REVERIFY_HOURS),
        MAX_WATCHER_FOLLOW_REVERIFY_HOURS,
      )
    : DEFAULT_WATCHER_FOLLOW_REVERIFY_HOURS;
  return hours * HOUR_MS;
}

// Probe-decision helpers live in ./watcher-follow-policy.ts (pure, unit-tested);
// re-exported here so existing imports keep working.
export { shouldProbeTarget, stateFromFriendship } from "./watcher-follow-policy.js";

async function loadWatcherFollowState(
  botId: string,
  targetIgUserIds: readonly string[],
): Promise<Map<string, WatcherFollowStateRow>> {
  if (targetIgUserIds.length === 0) return new Map();
  try {
    const rows = await db
      .select({
        targetIgUserId: watcherFollowState.targetIgUserId,
        state: watcherFollowState.state,
        verifiedAt: watcherFollowState.verifiedAt,
      })
      .from(watcherFollowState)
      .where(
        and(
          eq(watcherFollowState.botId, botId),
          inArray(watcherFollowState.targetIgUserId, [...targetIgUserIds]),
        ),
      );
    return new Map(
      rows.map((row) => [
        row.targetIgUserId,
        { state: row.state, verifiedAt: row.verifiedAt },
      ]),
    );
  } catch (err) {
    // Fail OPEN: an unreadable cache means probe everything, exactly as the
    // squad behaved before this table existed.
    logger.warn(
      { botId, err: err instanceof Error ? err.message : String(err) },
      "[liked-by] follow-state load failed; probing every target this cycle",
    );
    return new Map();
  }
}

async function recordWatcherFollowState(
  botId: string,
  target: FollowTarget,
  state: WatcherFollowStateValue,
  lastError: string | null,
): Promise<void> {
  const now = new Date();
  const trimmedError =
    lastError === null ? null : lastError.slice(0, MAX_LAST_ERROR_CHARS);
  try {
    await db
      .insert(watcherFollowState)
      .values({
        botId,
        targetIgUserId: target.igUserId,
        targetUsername: target.igUsername,
        state,
        verifiedAt: now,
        lastError: trimmedError,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [watcherFollowState.botId, watcherFollowState.targetIgUserId],
        set: {
          targetUsername: target.igUsername,
          state,
          verifiedAt: now,
          lastError: trimmedError,
          updatedAt: now,
        },
      });
  } catch (err) {
    // Telemetry-grade: a failed write must never fail the cycle. The pair is
    // simply probed again next sweep, as it would have been anyway.
    logger.warn(
      {
        botId,
        target: target.igUsername,
        state,
        err: err instanceof Error ? err.message : String(err),
      },
      "[liked-by] follow-state write failed; pair will be re-probed next sweep",
    );
  }
}

// Distinct follow targets keyed by IG numeric id — following the IG user once
// covers every tracked_account row that shares that handle. Only accounts with
// a resolved igUserId are followable (the follow/friendship endpoints need the
// numeric pk); the rest gain an id on their next public scrape.
async function loadDistinctFollowTargets(): Promise<FollowTarget[]> {
  const rows = await db
    .select({
      igUsername: trackedAccounts.igUsername,
      igUserId: trackedAccounts.igUserId,
    })
    .from(trackedAccounts)
    .where(
      and(eq(trackedAccounts.isActive, true), eq(trackedAccounts.isPrivate, false),
        customerAccessSql(trackedAccounts.userId), isNotNull(trackedAccounts.igUserId)),
    );

  const byUserId = new Map<string, string>();
  for (const row of rows) {
    if (row.igUserId && !byUserId.has(row.igUserId)) {
      byUserId.set(row.igUserId, row.igUsername);
    }
  }
  return Array.from(byUserId, ([igUserId, igUsername]) => ({
    igUserId,
    igUsername,
  })).sort((a, b) => a.igUserId.localeCompare(b.igUserId));
}

// Deterministic rotating window so a watcher covers the whole tracked list
// over several cycles without any persisted cursor. 20-minute time buckets.
function rotatingWindow<T>(items: readonly T[], size: number): T[] {
  if (items.length <= size) return [...items];
  const bucket = Math.floor(Date.now() / (20 * 60 * 1000));
  const offset = ((bucket * size) % items.length + items.length) % items.length;
  const window: T[] = [];
  for (let i = 0; i < size; i++) {
    window.push(items[(offset + i) % items.length]);
  }
  return window;
}

function humanFollowDelayMs(): number {
  return 3_000 + Math.floor(Math.random() * 5_000); // 3–8s
}

async function publicFollowTargetStillEligible(target: FollowTarget): Promise<boolean> {
  if (isShuttingDown()) return false;
  const [eligible] = await db.select({ id: trackedAccounts.id }).from(trackedAccounts)
    .where(and(eq(trackedAccounts.isActive, true), eq(trackedAccounts.isPrivate, false),
      customerAccessSql(trackedAccounts.userId), eq(trackedAccounts.igUserId, target.igUserId),
      eq(trackedAccounts.igUsername, target.igUsername)))
    .limit(1);
  return Boolean(eligible) && !isShuttingDown();
}

// Use the saved browser identity for migrated watchers. An unconfirmed write
// never retries through another transport or claims that a follow landed.
async function sendWatcherFollow(
  ctx: WatcherContext,
  target: FollowTarget,
): Promise<LandedFollowState> {
  const canFollow = () => publicFollowTargetStillEligible(target);
  if (!await canFollow()) throw new Error("Public follow target is no longer eligible");

  if (ctx.automationIdentity) {
    const status = await sendBrowserFollow(
      { ...ctx, proxyUrl: proxyAgentUriForEndpoint(ctx.proxyEndpoint) },
      target.igUsername,
      target.igUserId,
    );
    if (!status || typeof status.following !== "boolean" || typeof status.outgoingRequest !== "boolean"
        || (!status.following && !status.outgoingRequest)) {
      throw new Error("Browser follow outcome unconfirmed");
    }
    logger.info({ botId: ctx.botId, following: status.following, requested: status.outgoingRequest },
      "[liked-by] watcher follow verified through assigned browser");
    return status.following ? "following" : "requested";
  }

  const result = await playwrightSendFollowByUsername({
    sessionData: ctx.sessionData,
    fingerprint: ctx.fingerprint,
    botUsername: ctx.igUsername,
    proxyUrl: proxyAgentUriForEndpoint(ctx.proxyEndpoint),
    targetUsername: target.igUsername,
    canFollow,
  });

  if (!result || (!result.following && !result.requested)) {
    throw new Error(
      `[liked-by] chromium follow did not land for @${target.igUsername}`,
    );
  }

  logger.info(
    {
      botId: ctx.botId,
      igUsername: ctx.igUsername,
      target: target.igUsername,
      following: result.following,
      requested: result.requested,
    },
    "[liked-by] watcher followed tracked user via chromium",
  );
  return result.following ? "following" : "requested";
}

/**
 * Ensure a watcher bot follows (a bounded, rotating slice of) the active
 * tracked users, so its feed facepiles populate. IG friendship status remains
 * the source of truth for any WRITE — we only follow accounts a live probe
 * says are not already followed / requested — but the probe itself is now
 * gated by `watcher_follow_state` (migration 0045): a pair whose state was
 * confirmed inside WATCHER_FOLLOW_REVERIFY_HOURS is served from the cache and
 * counted in `cached` instead of costing an IG call. See shouldProbeTarget.
 *
 * `maxProbes` bounds REAL probes; cached pairs do not consume it, so the
 * budget walks further into the target list. `maxNewFollows` is unchanged.
 *
 * A rate-limit cools the bot and re-throws so the worker rotates.
 */
export async function ensureWatcherFollows(
  botId: string,
  opts: EnsureFollowsOptions,
): Promise<EnsureFollowsResult> {
  const idle: EnsureFollowsResult = { probed: 0, followed: 0, cached: 0 };
  if (isShuttingDown() || opts.maxNewFollows <= 0) return idle;

  // Approved private viewers also read feed/reels, but that must not enroll
  // them in unrelated follow writes. Only explicit squad roles maintain the
  // public watcher graph; private access stays with the dedicated request flow.
  const [watcher] = await db.select({ role: botAccounts.role }).from(botAccounts)
    .where(eq(botAccounts.id, botId)).limit(1);
  if (watcher?.role !== "feed_watcher" && watcher?.role !== "reels_watcher") return idle;

  const targets = await loadDistinctFollowTargets();
  if (targets.length === 0) return idle;

  return withOperationLease(`bot:${botId}`, async () => {
    const ctx = await prepareWatcher(botId);
    const canFollow = ctx.transport === "web";
    const known = await loadWatcherFollowState(
      botId,
      targets.map((target) => target.igUserId),
    );
    const nowMs = Date.now();
    const reverifyMs = readWatcherFollowReverifyMs();
    const candidates = targets.filter((target) =>
      shouldProbeTarget(known.get(target.igUserId), nowMs, reverifyMs, {
        canFollow,
      }),
    );
    const cached = targets.length - candidates.length;
    if (candidates.length === 0) return { ...idle, cached };

    const window = rotatingWindow(candidates, Math.max(1, opts.maxProbes));
    const client = buildHttpClient(ctx);

    let probed = 0;
    let followed = 0;
    try {
      for (const target of window) {
        if (isShuttingDown()) break;
        if (followed >= opts.maxNewFollows) break;
        // Which IG call a thrown error belongs to decides what is persisted: a
        // failed PROBE makes the pair 'unavailable' (re-verified after the
        // window, not every sweep); a failed FOLLOW keeps the truthful
        // 'not_following' verdict plus the error, so the next sweep retries the
        // follow exactly as it did before the cache existed.
        let phase: "probe" | "follow" = "probe";
        try {
          probed += 1;
          const friendship = await client.fetchFriendshipStatus(target.igUserId);
          const observed = stateFromFriendship(friendship);
          if (observed !== "not_following") {
            await recordWatcherFollowState(botId, target, observed, null);
            continue;
          }
          // A tracked profile can become private after the target list was
          // loaded. Do not let a stale public flag create an extra request.
          if (friendship.isPrivate) {
            await recordWatcherFollowState(botId, target, "unavailable", "private account requires assigned follow request");
            continue;
          }
          if (!canFollow) {
            logger.warn(
              { botId, igUsername: ctx.igUsername, target: target.igUsername },
              "[liked-by] mobile watcher cannot follow (browser requires a web session); skipping",
            );
            await recordWatcherFollowState(botId, target, observed, null);
            continue;
          }

          // Keep the observed status, but never begin a fresh external write
          // during shutdown. Already in-flight follows still persist their result.
          if (isShuttingDown()) {
            await recordWatcherFollowState(botId,target,observed,null);
            break;
          }
          phase = "follow";
          const landed = await sendWatcherFollow(ctx, target);
          followed += 1;
          await recordWatcherFollowState(botId, target, landed, null);
          await sleep(humanFollowDelayMs());
        } catch (err) {
          if (err instanceof IGAuthExpiredError) {
            await invalidateObservedBotSession(botId, ctx.sessionData).catch(() => {
              logger.warn({ botId }, "[liked-by] rejected session invalidation failed");
            });
            throw err;
          }
          if (err instanceof IGRateLimitedError) {
            await cooldownBotForRateLimit(botId, err.retryAfterMs).catch(
              () => undefined,
            );
            throw err;
          }
          if (isRotateSignal(err)) throw err;
          const message = err instanceof Error ? err.message : String(err);
          // A checkpoint on friendship_status is IG refusing THIS bot for the day,
          // not a flaky probe: one watcher (@abraham59655) tripped its breaker 66
          // times and burned 27 probes in an hour because the LRU picker only
          // skips cooling-down bots. Park it for 24h like the warmer does, and
          // stop spending this cycle's remaining probes through it.
          if (isCheckpointError(err)) {
            await cooldownBotForCheckpoint(botId, message, 24).catch(() => undefined);
            logger.warn(
              { botId, target: target.igUsername, err: message },
              "[liked-by] watcher checkpointed on friendship_status; cooled 24h, stopping probes",
            );
            break;
          }
          await recordWatcherFollowState(
            botId,
            target,
            phase === "probe" ? "unavailable" : "not_following",
            message,
          );
          logger.warn(
            { botId, target: target.igUsername, phase, ...harvestErrorDetails(err) },
            "[liked-by] follow probe failed; continuing",
          );
        }
      }
    } finally {
      await closeQuietly(client);
    }

    return { probed, followed, cached };
  });
}

// ── Public: watcher pool lookup ──────────────────────────────────────────────

/**
 * Role watchers in LRU order, followed by deduplicated healthy approved
 * private viewers. Both pools exclude bots that are cooling down.
 */
export async function loadWatcherBotIds(kind: WatcherKind): Promise<string[]> {
  const role = roleForKind(kind);
  const rows = await db
    .select({ id: botAccounts.id })
    .from(botAccounts)
    .where(
      and(
        eq(botAccounts.role, role),
        eq(botAccounts.status, "available"),
        sql`(${botAccounts.cooldownUntil} IS NULL OR ${botAccounts.cooldownUntil} < NOW())`,
      ),
    )
    .orderBy(sql`${botAccounts.lastUsedAt} ASC NULLS FIRST`);

  const botIds = new Set(rows.map((row) => row.id));
  const privateTargets = await db.select({ id: trackedAccounts.id })
    .from(trackedAccounts)
    .where(and(
      eq(trackedAccounts.isActive, true),
      eq(trackedAccounts.isPrivate, true),
      eq(trackedAccounts.accessStatus, "has_access"),
      customerAccessSql(trackedAccounts.userId),
    ));
  // Include the primary and independently accepted backup, including saved
  // session, durable proxy, cooldown, health and the original paid private row.
  // Resolve serially so a sweep cannot fan out database work with account count.
  for (const target of privateTargets) {
    for (const grantedBotId of await findGrantedBotIds(target.id)) botIds.add(grantedBotId);
  }
  return Array.from(botIds);
}
