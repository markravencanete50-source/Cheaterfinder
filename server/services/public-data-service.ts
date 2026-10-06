// ─── Public-data provider service ───────────────────────────────────────────
//
// Single backend: bot-session scraper (ig-public-scraper.ts). Apify removed
// as of 2026-05-04 — bot pool is the only public-data source. Returns a
// discriminated `PublicDataResult<T>` so callers don't have to catch.
// ─────────────────────────────────────────────────────────────────────────────

import {
  scrapeProfile,
  scrapeProfileById,
  scrapeProfileViaBrowser,
  scrapeNativePublicProfile,
  scrapeNativePublicPosts,
  scrapeNativePublicStories,
  scrapeNativePublicHighlights,
  scrapeProfileWithBot,
  scrapeUserPosts,
  scrapeUserClips,
  scrapeUserTagged,
  scrapeUserStories,
  scrapeUserHighlights,
  scrapeUserFollowers,
  scrapeUserFollowing,
  scrapeMediaComments,
  scrapeMediaLikers,
  scrapeUserPostsWithBot,
  scrapeUserStoriesWithBot,
  scrapeUserHighlightsWithBot,
  scrapeMediaLikersWithBot,
  scrapeMediaCommentsWithBot,
  scrapeUserFollowersWithBot,
  scrapeUserFollowingWithBot,
  scrapeUserFollowersCaptureWithBot,
  scrapeUserFollowingCaptureWithBot,
  IGListRestrictedError,
  IGPublicScraperError,
  type IGPublicProfile,
  type IGPostSummary,
  type IGStoryItem,
  type IGHighlight,
  type IGFollowUser,
  type IGComment,
  type IGUser,
} from "../ig-public-scraper.js";
import {
  IGAuthExpiredError,
  IGHttpError,
  IGRateLimitedError,
} from "../ig-http-client.js";
import { IGCircuitOpenError } from "../domain/ig-client-port.js";
import { logger as baseLogger } from "../observability/logger.js";
import {
  buildShareKey,
  withSharedFollowCapture,
} from "./follow-capture-share.js";
import { withScrapeRetry } from "./scrape-retry.js";
import { currentScrapeOperation, withScrapeOperation } from "./scrape-operation.js";
import { rosterViewerPinEnabled, targetCanaryEnabled, viewerAffinity, withViewerAffinity } from "./viewer-affinity.js";
import { withRotationRateLimitCooldownPolicy } from "./bot-cooldown.js";
import { isIgWebThrottleBody } from "./ig-throttle.js";
import { operationSignal } from "./operation-context.js";
import {
  fetchApifyGraph,
  isApifyGraphFallbackEnabled,
  resolveApifyGraphLimit,
} from "./apify-graph-fallback.js";

const logger = baseLogger.child({ module: "public-data-service" });

/**
 * Parse an integer env knob safely. Unlike `Number(x) || fallback`, an
 * explicit `0` is representable (A7) — only missing/blank/non-numeric values
 * fall back. The result is truncated and clamped to [min, max].
 */
export function parseEnvInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

// Wave 4: how many bot rotations to attempt before giving up on a label.
// The first attempt + up to 6 retries with a different bot = 7 leased bots
// max per public-data call. The LRU lease policy (ig-public-scraper.leaseBot)
// hands out a different bot on each call as long as the previous one was
// touched (we touch on every release), so we get natural rotation.
const MAX_BOT_ROTATIONS = 6;
// 0 disables rate-limit rotation entirely (the first 429 bubbles up).
const PROFILE_RATE_LIMIT_ROTATIONS = parseEnvInt(
  "PROFILE_RATE_LIMIT_ROTATIONS",
  2,
  0,
  3,
);
// A5: the browser fallback launches a full Chromium per attempt. Without a
// cap it inherits MAX_BOT_ROTATIONS=6 → up to 7 sequential Chromium launches
// for ONE profile fetch. Cap to initial attempt + at most 1 rotation.
const PROFILE_BROWSER_ROTATIONS = parseEnvInt(
  "PROFILE_BROWSER_ROTATIONS",
  1,
  0,
  1,
);

interface RunBotOptions {
  readonly rotateOnRateLimit?: boolean;
  readonly maxRateLimitRotations?: number;
  /** Cap on checkpoint/auth-style rotations (default MAX_BOT_ROTATIONS). */
  readonly maxRotations?: number;
  /** Known 401/403 soft throttles: bounded fallback, not seven auth rotations. */
  readonly maxSoftThrottleRotations?: number;
}

function isSoftThrottleCause(err: unknown): boolean {
  if (!(err instanceof IGPublicScraperError)) return false;
  const cause = err.cause;
  return (cause instanceof IGAuthExpiredError || cause instanceof IGHttpError) &&
    (cause.status === 401 || cause.status === 403) &&
    isIgWebThrottleBody(cause.body ?? "");
}

function isRateLimitCause(err: unknown): boolean {
  if (!(err instanceof IGPublicScraperError)) return false;
  return err.cause instanceof IGRateLimitedError || isSoftThrottleCause(err);
}

/**
 * A zero endpoint allowance is a property of a fresh bot's warm-up policy,
 * not a problem a different bot can solve. Rotating it through the pool turns
 * one intentionally skipped read into MAX_BOT_ROTATIONS extra leases.
 */
function isStructuralDailyCapCause(err: unknown): boolean {
  if (!(err instanceof IGPublicScraperError)) return false;
  const cause = err.cause;
  return (
    cause instanceof Error &&
    cause.name === "IGDailyCapExceededError" &&
    (cause as { cap?: unknown }).cap === 0
  );
}

/**
 * A confirmed suspended-account checkpoint has already quarantined the leased
 * bot in ig-public-scraper. It is not evidence that another observer should
 * retry the same request: rotating here turns one suspension into a rapid
 * cascade across the worker pool.
 */
function isConfirmedSuspensionCause(err: unknown): boolean {
  if (!(err instanceof IGPublicScraperError)) return false;
  const cause = err.cause;
  if (!(cause instanceof IGHttpError)) return false;
  const body = cause.body?.toLowerCase() ?? "";
  return (
    cause.status === 400 &&
    (cause.igErrorCode === "checkpoint_required" ||
      body.includes("checkpoint_required")) &&
    (body.includes("/accounts/suspended") || body.includes('"lock":true'))
  );
}

/**
 * True when the cause of an IGPublicScraperError is one of the per-bot
 * permanent signals (checkpoint, auth-expired, hard 403). The retry layer
 * above already cooled down the bot; we still need to retry the *call* with
 * a different bot.
 */
function isCheckpointOrAuthCause(err: unknown): boolean {
  // `special_empty_state` is explicitly scoped to the viewing identity. It has
  // no inner HTTP cause, so checking only `err.cause` made runBot retry the
  // same session in-place and then stop. Rotate immediately: another bot may
  // have enough graph trust to see this exact public list.
  if (err instanceof IGListRestrictedError) return true;
  if (!(err instanceof IGPublicScraperError)) return false;
  if (isConfirmedSuspensionCause(err)) return false;
  if (isRateLimitCause(err)) return false;
  const cause = err.cause;
  if (cause instanceof Error && cause.name === "IGDailyCapExceededError") return true;
  if (cause instanceof IGCircuitOpenError) return true;
  if (cause instanceof Error) {
    const msg = cause.message.toLowerCase();
    if (
      msg.includes("network error") ||
      msg.includes("fetch failed") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("socket")
    ) {
      return true;
    }
  }
  if (cause instanceof IGAuthExpiredError) return true;
  // Pool-wide rate limits should not rotate through every bot in seconds.
  // Cool down the bot that received Retry-After, bubble the temporary failure,
  // and let the worker defer the job.
  if (cause instanceof IGRateLimitedError) return false;
  if (cause instanceof IGHttpError) {
    if (cause.status === 401 || cause.status === 403) return true;
    if (cause.igErrorCode === "checkpoint_required") return true;
    if (cause.status === 400 && cause.body?.toLowerCase().includes("checkpoint_required")) return true;
    if (cause.igErrorCode === "challenge_required") return true;
    if (cause.igErrorCode === "login_required") return true;
    if (cause.body?.toLowerCase().includes("useragent mismatch")) return true;
  }
  return false;
}

export type DataSource = "bot" | "apify" | "cached" | "none";

export type PublicDataResult<T> =
  | { readonly ok: true; readonly data: T; readonly source: "bot" | "apify";
      readonly observation?: { botId?: string; transport?: string; observedAt: string; coverage: "visible_sample" } }
  | { readonly ok: false; readonly error: string; readonly source: DataSource };

type BotDataResult<T> =
  | { readonly ok: true; readonly data: T; readonly source: "bot" }
  | { readonly ok: false; readonly error: string; readonly source: "bot" };

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}

function isRateLimitMessage(message: string): boolean {
  return /rate limit|rate_limited|429|throttle/i.test(message);
}

async function runBot<T>(
  label: string,
  bot: (excludedBotIds: ReadonlySet<string>) => Promise<T>,
  options: RunBotOptions = {},
): Promise<BotDataResult<T>> {
  return withScrapeOperation(() => runBotOperation(label, bot, options));
}

async function runBotOperation<T>(
  label: string,
  bot: (excludedBotIds: ReadonlySet<string>) => Promise<T>,
  options: RunBotOptions,
): Promise<BotDataResult<T>> {
  // Wave 4: each attempt below leases a fresh bot inside ig-public-scraper.
  // withScrapeRetry handles transient retries with the SAME bot; if the
  // failure is checkpoint / auth-expired / hard 4xx the inner retry bubbles
  // immediately and we rotate to a different bot.
  const singleAttempt = viewerAffinity()?.singleAttempt === true;
  const maxRotations = singleAttempt ? 0 : options.maxRotations ?? MAX_BOT_ROTATIONS;
  // A4: when this call deliberately rotates past 429s, a rate-limited bot
  // must not be parked for the pool-wide 4h floor — that turns one throttled
  // fetch into "N bots × 4h" of lost capacity. The AsyncLocalStorage policy
  // rides the async chain down to cooldownBotForRateLimit inside the scraper
  // and switches it to the short rotation cooldown (Retry-After when present,
  // else PROFILE_ROTATION_COOLDOWN_MS). Non-rotating calls keep the long
  // pool-wide floor.
  const useRotationCooldownPolicy =
    options.rotateOnRateLimit === true &&
    (options.maxRateLimitRotations ?? 0) > 0;
  const restrictedBotIds = new Set<string>();
  const attempt = (): Promise<T> =>
    useRotationCooldownPolicy
      ? withRotationRateLimitCooldownPolicy(() =>
          withScrapeRetry(label, () => bot(new Set(restrictedBotIds)), singleAttempt ? {maxAttempts:1} : {}),
        )
      : withScrapeRetry(label, () => bot(new Set(restrictedBotIds)), singleAttempt ? {maxAttempts:1} : {});
  let lastError: unknown = null;
  for (let rotation = 0; rotation <= maxRotations; rotation += 1) {
    try {
      const data = await attempt();
      return { ok: true, data, source: "bot" };
    } catch (err) {
      lastError = err;
      if (err instanceof IGListRestrictedError && err.botId) {
        restrictedBotIds.add(err.botId);
      }
      const softThrottle = isSoftThrottleCause(err);
      const rateLimitRotateBudget = softThrottle && options.maxSoftThrottleRotations !== undefined
        ? options.maxSoftThrottleRotations
        : options.rotateOnRateLimit === true ? options.maxRateLimitRotations ?? 0 : 0;
      const rotateForRateLimit =
        rotation < rateLimitRotateBudget &&
        isRateLimitCause(err);
      const structuralDailyCap = isStructuralDailyCapCause(err);
      const rotateAgain =
        !singleAttempt && !structuralDailyCap &&
        (rotateForRateLimit ||
          (rotation < maxRotations && isCheckpointOrAuthCause(err)));
      const msg = errorMessage(err);
      const isScraperErr = err instanceof IGPublicScraperError;
      // Surface the inner cause chain so 403/IGAuthExpiredError details
      // (which the IGPublicScraperError wrapper otherwise hides) reach logs.
      const cause = (err as { cause?: unknown }).cause;
      const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : null;
      const causeBodyBytes =
        cause && typeof cause === "object" && "body" in cause
          ? Buffer.byteLength(String((cause as { body: unknown }).body), "utf8")
          : null;
      const causeIgErrorCode =
        cause && typeof cause === "object" && "igErrorCode" in cause
          ? String((cause as { igErrorCode: unknown }).igErrorCode ?? "unknown")
          : null;
      logger.warn(
        {
          label,
          err: msg,
          cause: causeMsg,
          causeBodyBytes,
          causeIgErrorCode,
          recoverable: isScraperErr,
          rotation,
          rotateForRateLimit,
          softThrottle,
          willRotate: rotateAgain,
          restrictedBotsExcluded: restrictedBotIds.size,
        },
        "bot provider failed",
      );
      if (!rotateAgain) break;
    }
  }
  return {
    ok: false,
    // Keep the refusal temporary downstream: an auth-shaped message otherwise
    // marks this owner checked for 12h although no posts were read.
    error: isRateLimitCause(lastError)
      ? `rate limited: ${errorMessage(lastError)}`
      : errorMessage(lastError),
    source: "bot",
  };
}

// ── Profile fetch result with structured rate-limit signal (A3) ─────────────
//
// The cached-profile continuation in public-data-collector needs to know
// whether the ORIGINAL HTTP failure was rate-limit-shaped, even when the
// browser fallback then failed for an unrelated reason ("no available bot in
// the pool", "failed to build IG client", ...). Sniffing only the final error
// string loses that information, so the failure variant carries an explicit
// `rateLimited` flag.

export type ProfileFetchResult =
  | { readonly ok: true; readonly data: IGPublicProfile; readonly source: "bot" }
  | {
      readonly ok: false;
      readonly error: string;
      readonly source: DataSource;
      /**
       * True when the HTTP transport failed rate-limit-shaped (and the
       * browser fallback did not prove the profile permanently gone). The
       * collector may continue from a cached profile anchor in that case.
       */
      readonly rateLimited: boolean;
    };

/**
 * Failures that mean the PROFILE itself is gone or hard-blocked — serving a
 * cached anchor for these would keep collecting against a dead target.
 */
function isPermanentProfileFailureMessage(message: string): boolean {
  return /user not found|user_not_found|not[ _-]?found|404|checkpoint|challenge/i.test(
    message,
  );
}

// A stripped / rate-limited mobile-info body can still parse into a well-shaped
// IGPublicProfile with every count zeroed. Treat 0/0/0 as a failed read so we
// never hand back a profile that would clobber real follower/following/post
// counts downstream (see the matching guard in applyProfileToDb).
function isAllZeroProfile(p: IGPublicProfile): boolean {
  return p.followerCount === 0 && p.followingCount === 0 && p.postCount === 0;
}

// ── web_profile_info global circuit breaker ────────────────────────────────
// web_profile_info is throttled by IG at the ENDPOINT level: once it starts
// 429ing, EVERY bot/proxy gets the same 429, so rotating bots just burns the
// pool (each 429 parks a bot on a 60s cooldown) for zero gain. When a
// web_profile_info call comes back rate-limited we trip a process-wide pause;
// while paused, getPublicProfile skips web_profile_info entirely and relies on
// the mobile-API id path (primary) and the browser leg. After the window the
// next caller probes it again. Bounded 30s..10m via WEB_PROFILE_COOLDOWN_MS.
const WEB_PROFILE_COOLDOWN_MS = parseEnvInt(
  "WEB_PROFILE_COOLDOWN_MS",
  90_000,
  30_000,
  600_000,
);
let webProfilePausedUntil = 0;
function isWebProfilePaused(): boolean {
  return Date.now() < webProfilePausedUntil;
}
function tripWebProfileBreaker(): void {
  webProfilePausedUntil = Date.now() + WEB_PROFILE_COOLDOWN_MS;
}

export const __testingProfileBreaker = {
  reset(): void {
    webProfilePausedUntil = 0;
  },
  isPaused: isWebProfilePaused,
};

export async function getPublicProfile(
  username: string,
  igUserId?: string | null,
): Promise<ProfileFetchResult> {
  if (process.env.IG_NATIVE_PUBLIC_READS_ENABLED === "true" || targetCanaryEnabled("IG_NATIVE_PUBLIC_TARGETS", username)) {
    const result = await withViewerAffinity({ ...viewerAffinity(), pin: viewerAffinity()?.pin ?? false, savedSessionOnly: true, singleAttempt: true }, () =>
      runBot<IGPublicProfile>(`native-profile:${username}`, () => scrapeNativePublicProfile(username, igUserId ?? undefined)));
    return result.ok ? result : { ...result, rateLimited: isRateLimitMessage(result.error) };
  }
  const hasId = typeof igUserId === "string" && igUserId.length > 0;

  // PRIMARY path when the numeric id is known: hit the mobile-API
  // GET /api/v1/users/<id>/info/ endpoint FIRST. It lives in a different,
  // far less aggressively throttled rate-limit bucket than web_profile_info,
  // which IG now 429s on nearly every logged-out request. Trying it before
  // web_profile_info avoids burning a whole rotation of bots on guaranteed-429
  // calls (each 429 parks a bot on a 60s rate-limit cooldown, which churned the
  // lease pool toward collapse). Same mapProfile shape + identity validation as
  // the web endpoint, so the data is equivalent. Falls through on rate-limit,
  // all-zero body, or a non-permanent failure.
  if (hasId) {
    const infoResult = await runBot<IGPublicProfile>(
      `profile-info:${username}`,
      () => scrapeProfileById(igUserId, username),
      {
        rotateOnRateLimit: true,
        maxRateLimitRotations: PROFILE_RATE_LIMIT_ROTATIONS,
      },
    );
    if (infoResult.ok && !isAllZeroProfile(infoResult.data)) {
      return infoResult;
    }
    logger.warn(
      {
        username,
        igUserId,
        err: infoResult.ok ? "all-zero counts" : infoResult.error,
      },
      "mobile-API info endpoint did not resolve; falling back to web_profile_info",
    );
  }

  // Secondary: web_profile_info by username. Skipped entirely while the endpoint
  // is in its global rate-limit cooldown — that saves a guaranteed-429 bot
  // rotation and we fall straight through to the browser leg.
  let webError = "web_profile_info skipped (endpoint in global rate-limit cooldown)";
  if (!isWebProfilePaused()) {
    const result = await runBot<IGPublicProfile>(
      `profile:${username}`,
      () => scrapeProfile(username),
      {
        rotateOnRateLimit: true,
        maxRateLimitRotations: PROFILE_RATE_LIMIT_ROTATIONS,
      },
    );
    if (result.ok) return result;
    if (!isRateLimitMessage(result.error)) {
      return { ...result, rateLimited: false };
    }
    // Endpoint-level throttle: trip the breaker so concurrent and subsequent
    // callers skip web_profile_info for the cooldown window instead of each
    // burning their own rotation of bots against the same 429 wall.
    tripWebProfileBreaker();
    webError = result.error;
    logger.warn(
      {
        username,
        rotations: PROFILE_RATE_LIMIT_ROTATIONS,
        cooldownMs: WEB_PROFILE_COOLDOWN_MS,
      },
      "web_profile_info rate-limited; tripping global cooldown, trying browser transport",
    );
  } else {
    logger.debug(
      { username },
      "web_profile_info in global cooldown; skipping to browser transport",
    );
  }

  // A5: explicit rotation cap — the browser leg must never inherit the
  // default 6-rotation budget (each attempt launches a Chromium instance).
  const browserResult = await runBot<IGPublicProfile>(
    `profile-browser:${username}`,
    () => scrapeProfileViaBrowser(username),
    { maxRotations: PROFILE_BROWSER_ROTATIONS },
  );
  if (browserResult.ok) return browserResult;

  // The HTTP leg was rate-limited; the browser leg failing for a different
  // reason (empty pool, client build, transport) does NOT erase that signal.
  // Only a browser-leg failure proving the profile permanently gone
  // (404 / not found / checkpoint) downgrades to a hard failure.
  const permanent = isPermanentProfileFailureMessage(browserResult.error);
  return {
    ok: false,
    source: browserResult.source,
    rateLimited: !permanent,
    error: `rate limited on HTTP transport (${webError}); browser fallback failed: ${browserResult.error}`,
  };
}

export async function getUserPosts(
  username: string,
  igUserId: string,
  limit = 24,
): Promise<PublicDataResult<ReadonlyArray<IGPostSummary>>> {
  if (process.env.IG_NATIVE_PUBLIC_READS_ENABLED === "true" || targetCanaryEnabled("IG_NATIVE_PUBLIC_TARGETS", username)) {
    return withViewerAffinity({ ...viewerAffinity(), pin: viewerAffinity()?.pin ?? false, savedSessionOnly: true, singleAttempt: true }, () =>
      runBot<ReadonlyArray<IGPostSummary>>(`native-posts:${username}`, () => scrapeNativePublicPosts(username, igUserId, limit)));
  }
  return runBot<ReadonlyArray<IGPostSummary>>(`posts:${username}`, () =>
    scrapeUserPosts(igUserId, limit),
    { maxSoftThrottleRotations: 2 },
  );
}

// Wave 4: Reels-tab feed for a user.
export async function getUserClips(
  username: string,
  igUserId: string,
  limit = 24,
): Promise<PublicDataResult<ReadonlyArray<IGPostSummary>>> {
  return runBot<ReadonlyArray<IGPostSummary>>(`clips:${username}`, () =>
    scrapeUserClips(igUserId, limit),
  );
}

// Wave 4: posts where the user has been tagged by other accounts.
export async function getUserTagged(
  username: string,
  igUserId: string,
  limit = 24,
): Promise<PublicDataResult<ReadonlyArray<IGPostSummary>>> {
  return runBot<ReadonlyArray<IGPostSummary>>(`tagged:${username}`, () =>
    scrapeUserTagged(igUserId, limit),
  );
}

export async function getUserStories(
  username: string,
  igUserId: string,
): Promise<PublicDataResult<ReadonlyArray<IGStoryItem>>> {
  if (process.env.IG_NATIVE_PUBLIC_READS_ENABLED === "true" || targetCanaryEnabled("IG_NATIVE_PUBLIC_TARGETS", username)) {
    return withViewerAffinity({ ...viewerAffinity(), pin: viewerAffinity()?.pin ?? false, savedSessionOnly: true, singleAttempt: true }, () =>
      runBot<ReadonlyArray<IGStoryItem>>(`native-stories:${username}`, () => scrapeNativePublicStories(username, igUserId)));
  }
  return runBot<ReadonlyArray<IGStoryItem>>(`stories:${username}`, () =>
    scrapeUserStories(igUserId),
  );
}

export async function getUserHighlights(
  username: string,
  igUserId: string,
  withItems = false,
): Promise<PublicDataResult<ReadonlyArray<IGHighlight>>> {
  if (process.env.IG_NATIVE_PUBLIC_READS_ENABLED === "true" || targetCanaryEnabled("IG_NATIVE_PUBLIC_TARGETS", username)) {
    return withViewerAffinity({ ...viewerAffinity(), pin: viewerAffinity()?.pin ?? false, savedSessionOnly: true, singleAttempt: true }, () =>
      runBot<ReadonlyArray<IGHighlight>>(`native-highlights:${username}`, () => scrapeNativePublicHighlights(username, igUserId, withItems)));
  }
  return runBot<ReadonlyArray<IGHighlight>>(`highlights:${username}`, () =>
    scrapeUserHighlights(igUserId, { withItems }),
  );
}

export async function getUserFollowers(
  username: string,
  igUserId: string,
  cursor?: string,
): Promise<
  BotDataResult<{
    readonly users: ReadonlyArray<IGFollowUser>;
    readonly nextCursor: string | null;
    readonly sourceLimited?: boolean;
  }>
> {
  return runBot(`followers:${igUserId}`, (excludedBotIds) =>
    scrapeUserFollowers(igUserId, cursor, excludedBotIds),
  );
}

// Wave 5: actual comment text/author/likes for one post. The shortcode is
// only used as the metrics label key — IG's comments endpoint takes a
// numeric media_id.
export async function getPostComments(
  shortcode: string,
  mediaId: string,
  opts?: { maxPages?: number; maxItems?: number },
): Promise<PublicDataResult<ReadonlyArray<IGComment>>> {
  return runBot<ReadonlyArray<IGComment>>(`comments:${shortcode}`, () =>
    scrapeMediaComments(shortcode, mediaId, opts),
  );
}

// Wave 5: who liked this post. IG caps at ~100 users with no pagination
// cursor, so this is a single-page scrape — no maxItems/maxPages knobs.
export async function getPostLikers(
  shortcode: string,
  mediaId: string,
  options?: { targetUsername?: string; viewerBotId?: string },
): Promise<PublicDataResult<ReadonlyArray<IGUser>>> {
  return withScrapeOperation(async () => {
    const read = () => runBot<ReadonlyArray<IGUser>>(`likers:${shortcode}`, () => scrapeMediaLikers(shortcode, mediaId));
    let result: BotDataResult<ReadonlyArray<IGUser>> | undefined;
    if (targetCanaryEnabled("LIKER_RELATIONSHIP_VIEWER_TARGETS", options?.targetUsername)) {
      result = await withViewerAffinity({ pin: true, roles: ["feed_watcher", "reels_watcher"], targetUsername: options!.targetUsername },
        () => runBot(`likers:${shortcode}`, () => scrapeMediaLikers(shortcode, mediaId), { maxRotations: 0 }));
    }
    if (!result?.ok && options?.viewerBotId) {
      result = await withViewerAffinity({ pin: true, botId: options.viewerBotId }, read);
    }
    if (!result?.ok) result = await read();
    if (!result.ok) return result;
    const op = currentScrapeOperation();
    return { ...result, observation: { botId: op?.viewerBotId, transport: op?.transport,
      observedAt: new Date().toISOString(), coverage: "visible_sample" } };
  });
}

export async function getUserFollowing(
  igUserId: string,
  cursor?: string,
): Promise<
  BotDataResult<{
    readonly users: ReadonlyArray<IGFollowUser>;
    readonly nextCursor: string | null;
  }>
> {
  return runBot(`following:${igUserId}`, (excludedBotIds) =>
    scrapeUserFollowing(igUserId, cursor, excludedBotIds),
  );
}

// ── Paginating wrappers ─────────────────────────────────────────────────────
//
// `getUserFollowers` / `getUserFollowing` only return a single page (~22-50
// users plus a nextCursor). For accounts with hundreds of follows we need to
// walk every page until either the cursor runs out, we hit `maxPages`, or we
// hit `maxItems`. Each page counts as its own scrape outcome via
// `runBot` (recordOutcome is invoked from `withScrapeRetry`/`scrape-metrics`
// inside that path).
//
// Failure handling is "graceful degradation": if the *first* page fails we
// surface the error as `{ ok: false }`. If a later page fails we surface the
// partial accumulator as `{ ok: true, data }` so the caller can still persist
// what we have.
//
// Completeness contract (B2): every `ok: true` result carries an explicit
// `complete` flag + `stopReason` so callers can distinguish a fully
// enumerated roster (cursor exhausted) from a TRUNCATED capture (mid-walk
// page failure, page cap, item cap). Truncated captures must never feed
// unfollow detection — "previously seen but absent in this scrape" is
// meaningless when the scrape stopped early. The collector gates on this.
//
// The page delay is randomised within `[pageDelayMinMs, pageDelayMaxMs]` to
// avoid burst signatures that look like automation. Defaults: 1.5s-3.5s.

const DEFAULT_PAGINATION_MAX_PAGES = 20;
const DEFAULT_PAGINATION_MAX_ITEMS = 2000;
const DEFAULT_PAGINATION_DELAY_MIN_MS = 1500;
const DEFAULT_PAGINATION_DELAY_MAX_MS = 3500;

export interface PaginationOptions {
  /** Private pinned walks revalidate the original grant before each request. */
  readonly beforePage?: () => Promise<void>;
  readonly viewerBotId?: string | null;
  /** Internal bounded background worker: retain one reader through the epoch. */
  readonly pinViewer?: boolean;
  readonly rosterSource?: "auto" | "graphql";
  /** No external/paid fallback for bounded native background work. */
  readonly nativeOnly?: boolean;
  readonly savedSessionOnly?: boolean;
  /** Bounded background work defers failures instead of spending extra reads. */
  readonly maxMidwalkRetries?: number;
  readonly stopReasonWhenRequested?: "shutdown" | "time_budget";
  /**
   * Resume point for a roster walk. IG refuses deep pagination on large lists
   * (HTTP 400 after ~8 pages), so restarting at page 1 every cycle re-reads the
   * same first ~200 accounts forever and a 9,908-follower roster can never be
   * enumerated. The collector persists the cursor a walk stopped on and feeds
   * it back here so the next cycle continues instead of looping.
   */
  readonly startCursor?: string | null;
  readonly maxPages?: number;
  readonly maxItems?: number;
  readonly pageDelayMinMs?: number;
  readonly pageDelayMaxMs?: number;
  /** Username required by the no-login fallback for following-list reads. */
  readonly fallbackUsername?: string;
  /**
   * Allow the configured paid fallback when the local proxy provider is down.
   * The collector sets this only when the normal roster gate independently
   * requires a read and the complete roster fits inside APIFY_GRAPH_MAX_ITEMS.
   * Successful paid reads then receive their own refresh cooldown.
   */
  readonly allowProviderOutageFallback?: boolean;
  /**
   * Deploy safety (2026-09-02 audit, C4). Polled between pages and before each
   * mid-walk retry sleep. When it returns true the walk stops and returns the
   * pages captured so far as a TRUNCATED leg (`stopReason: "shutdown"`) whose
   * `nextCursor` is the first unread page, so the collector persists the
   * sightings and the next boot resumes instead of re-walking from page 1.
   * The collector passes `isShuttingDown` (services/shutdown-state.ts).
   */
  readonly shouldStop?: () => boolean;
}

interface ResolvedPaginationOptions {
  readonly maxPages: number;
  readonly maxItems: number;
  readonly pageDelayMinMs: number;
  readonly pageDelayMaxMs: number;
}

function resolvePaginationOptions(
  opts?: PaginationOptions,
): ResolvedPaginationOptions {
  return {
    maxPages: opts?.maxPages ?? DEFAULT_PAGINATION_MAX_PAGES,
    maxItems: opts?.maxItems ?? DEFAULT_PAGINATION_MAX_ITEMS,
    pageDelayMinMs: opts?.pageDelayMinMs ?? DEFAULT_PAGINATION_DELAY_MIN_MS,
    pageDelayMaxMs: opts?.pageDelayMaxMs ?? DEFAULT_PAGINATION_DELAY_MAX_MS,
  };
}

function jitterDelay(min: number, max: number): Promise<void> {
  const span = Math.max(0, max - min);
  const ms = Math.max(0, min) + Math.random() * span;
  if (ms <= 0) return Promise.resolve();
  return paginationDelay(ms);
}

function paginationDelay(ms: number): Promise<void> {
  const signal=operationSignal();
  if(signal?.aborted) return Promise.resolve();
  return new Promise(resolve=>{
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener("abort",finish);resolve();};
    signal?.addEventListener("abort",finish,{once:true});
    timer=setTimeout(finish,ms);
  });
}

// Mid-walk retry backoff sleep, isolated behind a test seam so unit tests can
// stub it to resolve instantly (the real backoff is up to ~60s per breaker
// retry, which would otherwise hang deterministic tests).
let midwalkRetrySleep: (ms: number) => Promise<void> = (ms) =>
  paginationDelay(ms);

/** Test-only: override the mid-walk retry backoff sleep. */
export function __setMidwalkRetrySleepForTests(
  fn: (ms: number) => Promise<void>,
): void {
  midwalkRetrySleep = fn;
}

type FollowPageFetcher = (
  cursor: string | undefined,
) => Promise<
  BotDataResult<{
    readonly users: ReadonlyArray<IGFollowUser>;
    readonly nextCursor: string | null;
    readonly sourceLimited?: boolean;
  }>
>;

/** Why a follow-list pagination walk stopped. Only "exhausted" (cursor ran
 *  out naturally) means the roster capture is COMPLETE. */
export type FollowListStopReason =
  | "exhausted"
  | "page_error"
  | "page_cap"
  | "item_cap"
  | "source_limited"
  | "time_budget"
  /** Process shutdown requested between pages (C4): partial leg + resume cursor. */
  | "shutdown";

/**
 * Result of a full follow-list enumeration. The `ok: true` variant always
 * carries the completeness signal; it remains structurally assignable to
 * `PublicDataResult<ReadonlyArray<IGFollowUser>>` for legacy consumers.
 */
export type FollowListCaptureResult =
  | {
      readonly ok: true;
      readonly data: ReadonlyArray<IGFollowUser>;
      readonly source: "bot" | "apify";
      /** True ⟺ stopReason === "exhausted": the capture is the full roster. */
      readonly complete: boolean;
      /** Successful page responses, excluding failed cursor/read attempts. */
      readonly pagesSucceeded?: number;
      readonly stopReason: FollowListStopReason;
      /** Pages actually fetched in this leg (telemetry; audit C10). */
      readonly pagesFetched?: number;
      readonly rawItemsFetched?: number;
      readonly viewerBotId?: string;
      /** Actual origin after any refused-cursor restart, not just the requested cursor. */
      readonly startedFromTop?: boolean;
      /**
       * Cursor the walk stopped on, or null when the list was exhausted.
       * Persisted by the collector so the next cycle resumes here.
       */
      readonly nextCursor?: string | null;
    }
  | { readonly ok: false; readonly error: string; readonly source: DataSource };

// Self-healing fix: detect breaker-class failures by error string. The
// fetcher path swallows the IGCircuitOpenError into a string; we sniff for
// the canonical message fragment. Mid-walk failures matching this get ONE
// long-sleep retry from the same cursor before we fall back to partial data
// — ig circuit breaker auto-resets after 60s (see ig-circuit-breaker.ts).
function isCircuitBreakerError(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("circuit") &&
    (lower.includes("open") || lower.includes("breaker"))
  );
}

function isProxyProviderOutage(message: string): boolean {
  return /proxy-provider|no healthy endpoint|provider health cooldown|failed to ready bot/i.test(
    message,
  );
}

function canUseApifyFallback(
  error: string,
  opts?: PaginationOptions,
): boolean {
  if (!isApifyGraphFallbackEnabled()) return false;
  if (/list restricted|special_empty_state/i.test(error)) return true;
  return (
    process.env.APIFY_GRAPH_PROVIDER_OUTAGE_FALLBACK_ENABLED === "true" &&
    opts?.allowProviderOutageFallback === true &&
    isProxyProviderOutage(error)
  );
}

// Exported for the unit test of the shutdown yield (C4); production callers use
// getAllUserFollowers / getAllUserFollowing below.
export async function paginateFollowList(
  label: string,
  fetcher: FollowPageFetcher,
  opts?: PaginationOptions,
): Promise<FollowListCaptureResult> {
  const { maxPages, maxItems, pageDelayMinMs, pageDelayMaxMs } =
    resolvePaginationOptions(opts);

  const accumulator: IGFollowUser[] = [];
  const seenMembers = new Set<string>();
  const seenCursors = new Set<string>();
  let rawItemsFetched = 0;
  const startCursor = opts?.startCursor ?? undefined;
  let startedFromTop = startCursor === undefined;
  let cursor: string | undefined = startCursor;
  let pages = 0;
  let pagesSucceeded = 0;
  let lastSource: "bot" = "bot";
  // Shared budget of same-cursor retries across the whole walk. Lets a walk
  // ride out a transient rate-limit / breaker wave instead of truncating to a
  // partial roster on the first hiccup — the #1 cause of "partial not complete".
  // Each retry re-leases a (rotated) bot, so a larger budget gives the walk more
  // fresh sessions to get past a hot pagination cursor. Env-tunable; default 8
  // (worst-case worker hold ~8min of 60s breaker sleeps) — safe now that the
  // pool is large enough to spare a worker that long.
  let midwalkRetryBudget = opts?.maxMidwalkRetries === 0 ? 0 : Math.max(
    1,
    Math.min(20, Number(process.env.FOLLOW_MIDWALK_RETRY_BUDGET ?? "8") || 8),
  );

  // Truncated partial result (mid-walk failure / cap). Logged once here so
  // every truncation exit shares the same WARN shape.
  //
  // `resumeCursor` defaults to the cursor of the page we were WORKING ON, which
  // is what a page failure wants: that page yielded nothing, so the next cycle
  // must re-request it. A cap exit is different — the page it stopped on was
  // fully captured, so the caller passes `res.data.nextCursor` explicitly and
  // the next cycle starts at the first page we have NOT read. Defaulting there
  // too silently re-read the last page of every capped walk, and with
  // `maxPages: 1` it pinned the walk on one page forever.
  const truncated = (
    stopReason: Exclude<FollowListStopReason, "exhausted">,
    err?: string,
    resumeCursor: string | null = cursor ?? null,
  ): FollowListCaptureResult => {
    logger.warn(
      {
        label,
        stopReason,
        err: err ?? null,
        pagesFetched: pages,
        itemsFetched: accumulator.length,
        resumed: startCursor !== undefined,
      },
      "follow pagination stopped before cursor exhaustion — capture is TRUNCATED (unsafe for unfollow diff)",
    );
    return {
      ok: true,
      data: accumulator,
      source: lastSource,
      complete: false,
      startedFromTop,

      pagesFetched: pages,
      pagesSucceeded,
      rawItemsFetched,
      viewerBotId: viewerAffinity()?.botId,
      stopReason,
      // Resume point for the next cycle. Without this a truncated walk restarts
      // at page 1 forever and a large roster is never fully enumerated.
      nextCursor: resumeCursor,
    };
  };

// A mid-walk failure is only worth retrying if it is TRANSIENT. IG answers a
// pagination cursor it refuses to serve with a hard 400 (deep follower lists:
// @sample_account dies at ~200 items every single time) — that verdict does
// not change on retry. Burning the full retry budget on it costs 8 failed IG
// calls per walk across rotating bots and is what checkpointed 6 accounts on
// 2026-08-28; it also stalls the walk for ~4 minutes of pure backoff. Retry
// rate-limits, breaker waves and 5xx/network blips; take the partial and move
// on for a deterministic refusal.
function isRetryableWalkError(error: string): boolean {
  if (isCircuitBreakerError(error)) return true;
  if (/status 4[0-9][0-9]/.test(error)) {
    // 429 is the one 4xx worth waiting out.
    return /status 429/.test(error);
  }
  return true;
}

// IG answers a `max_id` it will not serve with a plain HTTP 400. That verdict
// is about the CURSOR, which makes it the one first-page failure where throwing
// the resume point away is the right move. A 401/403 (this bot's session), a
// 429 (throttle), a 5xx or a network blip say nothing about the cursor, and
// discarding a hard-won deep resume point over one of those would cost hundreds
// of pages of progress — so those keep bubbling and the stored cursor survives.
// A 400 that carries a checkpoint/challenge code is also a session verdict.
function isRefusedCursorError(error: string): boolean {
  if (!/status 400\b/.test(error)) return false;
  return !/checkpoint|challenge|login_required|feedback_required/i.test(error);
}

  // Deploy safety (C4): the process is draining. Return the pages already
  // captured as a resumable truncated leg — `cursor` is the first UNREAD page
  // at every call site below. One log line per walk that yields.
  const stopRequested = (): boolean => opts?.shouldStop?.() === true;
  const stopForShutdown = (err?: string): FollowListCaptureResult => {
    logger.info(
      {
        label,
        pagesFetched: pages,
        itemsFetched: accumulator.length,
        hasResumeCursor: cursor !== undefined,
        stopReason: opts?.stopReasonWhenRequested ?? "shutdown",
      },
      opts?.stopReasonWhenRequested === "time_budget"
        ? "follow pagination stopped for batch time budget — returning partial leg with its resume cursor"
        : "follow pagination stopped for process shutdown — returning partial leg with its resume cursor",
    );
    return truncated(opts?.stopReasonWhenRequested ?? "shutdown", err, cursor ?? null);
  };

  while (pages < maxPages) {
    // `pages > 0`: the first page is always fetched, so a walk that begins
    // during a shutdown still leaves one page of sightings, not an empty leg.
    if (pages > 0 && stopRequested()) return stopForShutdown();
    let res = await fetcher(cursor);
    pages += 1;

    if (!res.ok) {
      // A RESUMED walk whose very first page is refused is a dead end that
      // heals on its own nowhere: the collector only persists a new resume
      // point for an `ok` capture, so bubbling this leaves the same refused
      // cursor in place and EVERY following cycle re-fails on it until
      // ROSTER_CURSOR_TTL_HOURS (12h) ages it out — twelve hours in which the
      // roster collects nothing at all. Drop the cursor once and finish the
      // walk from the top instead: it spends the page budget this cycle had
      // already provisioned, and the fresh walk's own `nextCursor` overwrites
      // the dead one downstream. Bounded by construction — `pages` is only 1 on
      // the walk's first fetch, so this can happen at most once per walk (no
      // retry storm, lesson 5).
      if (
        pages === 1 &&
        startCursor !== undefined &&
        accumulator.length === 0 &&
        isRefusedCursorError(res.error)
      ) {
        logger.warn(
          { label, err: res.error, maxPages },
          "resumed roster cursor refused by IG — dropping it and restarting this walk from the first page",
        );
        cursor = undefined;
        startedFromTop = true;
        await jitterDelay(pageDelayMinMs, pageDelayMaxMs);
        continue;
      }
      // First-page failure with no items salvaged → bubble up the error.
      if (accumulator.length === 0) {
        return { ok: false, error: res.error, source: res.source };
      }
      // Mid-walk failure with items already captured. Instead of truncating on
      // the first hiccup, retry the SAME cursor with backoff up to a shared
      // budget so a transient rate-limit / breaker wave doesn't cut an
      // otherwise-healthy walk short. Breaker errors need the ~60s half-open
      // window to clear; other transient errors back off shorter.
      // Deterministic refusal (e.g. HTTP 400 on a cursor IG will not serve):
      // retrying cannot succeed and each attempt is a fresh ban-risk IG call.
      if (!isRetryableWalkError(res.error)) {
        logger.warn(
          {
            label,
            err: res.error,
            pagesFetched: pages - 1,
            itemsFetched: accumulator.length,
          },
          "follow pagination hit a non-retryable page error — keeping partial without burning the retry budget",
        );
        return truncated("page_error", res.error);
      }
      while (!res.ok && midwalkRetryBudget > 0 && isRetryableWalkError(res.error)) {
        // A 60 s breaker sleep inside the drain budget is never worth it; the
        // failing page (`cursor`, unchanged) is re-requested on the next boot.
        if (stopRequested()) return stopForShutdown(res.error);
        midwalkRetryBudget -= 1;
        const sleepMs = isCircuitBreakerError(res.error)
          ? Math.max(60_000, pageDelayMaxMs * 3)
          : Math.min(30_000, Math.max(5_000, pageDelayMaxMs * 2));
        logger.warn(
          {
            label,
            err: res.error,
            pagesFetched: pages - 1,
            itemsFetched: accumulator.length,
            retriesLeft: midwalkRetryBudget,
            sleepMs,
          },
          "follow pagination mid-walk failure — backing off and retrying same cursor",
        );
        await midwalkRetrySleep(sleepMs);
        if (stopRequested()) return stopForShutdown(res.error);
        res = await fetcher(cursor);
      }
      // Budget exhausted and still failing → keep the additive partial so the
      // caller can persist gains; marked incomplete (unsafe for unfollow diff).
      if (!res.ok) {
        return truncated("page_error", res.error);
      }
    }

    lastSource = res.source;
    pagesSucceeded += 1;
    rawItemsFetched += res.data.users.length;
    let droppedThisPage = false;
    for (const user of res.data.users) {
      const key = user.igUserId || user.username.toLowerCase();
      if (!key || seenMembers.has(key)) continue;
      if (accumulator.length >= maxItems) { droppedThisPage = true; break; }
      seenMembers.add(key);
      accumulator.push(user);
    }

    const noMorePages = res.data.nextCursor === null;
    if (res.data.sourceLimited) return truncated("source_limited", "Instagram limited the visible roster", null);
    const hitItemCap = accumulator.length >= maxItems;
    const hitPageCap = pages >= maxPages;

    // Exit-path classification. Item cap only counts as truncation when it
    // actually cost us data (items dropped, or more pages remained); a final
    // page that lands exactly on the cap with no cursor left is a complete
    // capture.
    if (hitItemCap && (droppedThisPage || !noMorePages)) {
      // Where to resume depends on whether the cap cut this page in half. If it
      // did, the tail of THIS page is still unread and the next cycle has to
      // re-request it; if the cap landed exactly on a page boundary, the page
      // is fully captured and re-reading it would just waste a call.
      return truncated(
        "item_cap",
        undefined,
        droppedThisPage ? (cursor ?? null) : (res.data.nextCursor ?? null),
      );
    }
    if (noMorePages) {
      return {
        ok: true,
        data: accumulator,
        source: lastSource,
        complete: true,
        startedFromTop,
        stopReason: "exhausted",
        pagesFetched: pages,
        pagesSucceeded,
        rawItemsFetched,
        viewerBotId: viewerAffinity()?.botId,
        // List fully walked — clear the resume point so the next cycle starts
        // a fresh pass from the top rather than resuming past the end.
        nextCursor: null,
      };
    }
    if (hitPageCap) {
      // This page was captured in full, so the next cycle picks up at the page
      // AFTER it (non-null here: a null cursor already returned "exhausted").
      return truncated("page_cap", undefined, res.data.nextCursor ?? null);
    }

    if (res.data.nextCursor && seenCursors.has(res.data.nextCursor)) return truncated("page_error", "pagination cursor repeated");
    if (res.data.nextCursor) seenCursors.add(res.data.nextCursor);
    cursor = res.data.nextCursor ?? undefined;
    // Checked before the 9-16 s inter-page sleep so a shutdown that began
    // during the fetch does not pay for it (cursor already points past this page).
    if (stopRequested()) return stopForShutdown();
    await jitterDelay(pageDelayMinMs, pageDelayMaxMs);
  }

  // Loop condition exit: only reachable when maxPages <= 0 — nothing was
  // fetched, so the capture is trivially truncated by the page cap.
  return truncated("page_cap");
}

export async function getAllUserFollowers(
  username: string,
  igUserId: string,
  opts?: PaginationOptions,
): Promise<FollowListCaptureResult> {
  // De-duplicate across customers tracking the same account (see
  // follow-capture-share.ts). Keyed on the resume cursor so two trackers at
  // different offsets never receive each other's slice.
  return withSharedFollowCapture(
    buildShareKey("follower", igUserId, opts?.startCursor) + `:${opts?.viewerBotId ?? "auto"}:${opts?.rosterSource ?? "auto"}:${opts?.pinViewer || rosterViewerPinEnabled(username, "follower") ? "pinned" : "rotating"}:${opts?.maxPages ?? "default"}:${opts?.maxItems ?? "default"}:${!!opts?.nativeOnly}:${!!opts?.savedSessionOnly}:${opts?.maxMidwalkRetries === 0 ? "single-attempt" : "retry"}`,
    `followers-all:${igUserId}`,
    () => opts?.pinViewer || rosterViewerPinEnabled(username, "follower")
      ? withViewerAffinity({ pin: true, botId: opts?.viewerBotId ?? undefined, rosterSource: opts?.rosterSource, savedSessionOnly: opts?.savedSessionOnly, singleAttempt: opts?.maxMidwalkRetries === 0 }, () => captureAllUserFollowers(username, igUserId, opts))
      : captureAllUserFollowers(username, igUserId, opts),
  );
}

async function captureAllUserFollowers(
  username: string,
  igUserId: string,
  opts?: PaginationOptions,
): Promise<FollowListCaptureResult> {
  const native = await paginateFollowList(
    `followers-all:${igUserId}`,
    (cursor) => getUserFollowers(username, igUserId, cursor),
    opts,
  );
  if (
    opts?.nativeOnly || native.ok ||
    !canUseApifyFallback(native.error, opts)
  ) {
    return native;
  }
  try {
    const requestedLimit = resolvePaginationOptions(opts).maxItems;
    const effectiveLimit = resolveApifyGraphLimit(requestedLimit);
    const data = await fetchApifyGraph(username, "followers", requestedLimit);
    // The actor may be safety-capped below the caller's pagination cap. Compare
    // against the EFFECTIVE cap: exactly-at-cap means truncated, while a
    // smaller dataset genuinely exhausted (e.g. @tracked_user_1 1.8k < 2k).
    const complete = data.length < effectiveLimit;
    return {
      ok: true,
      data,
      source: "apify",
      complete,
      stopReason: complete ? "exhausted" : "item_cap",
    };
  } catch (error) {
    return {
      ok: false,
      source: "apify",
      error: `${native.error}; Apify fallback: ${errorMessage(error)}`,
    };
  }
}

export async function getAllUserFollowing(
  igUserId: string,
  opts?: PaginationOptions,
): Promise<FollowListCaptureResult> {
  return withSharedFollowCapture(
    buildShareKey("following", igUserId, opts?.startCursor) + `:${opts?.viewerBotId ?? "auto"}:${opts?.rosterSource ?? "auto"}:${opts?.pinViewer || rosterViewerPinEnabled(opts?.fallbackUsername, "following") ? "pinned" : "rotating"}:${opts?.maxPages ?? "default"}:${opts?.maxItems ?? "default"}:${!!opts?.nativeOnly}:${!!opts?.savedSessionOnly}:${opts?.maxMidwalkRetries === 0 ? "single-attempt" : "retry"}`,
    `following-all:${igUserId}`,
    () => opts?.pinViewer || rosterViewerPinEnabled(opts?.fallbackUsername, "following")
      ? withViewerAffinity({ pin: true, botId: opts?.viewerBotId ?? undefined, rosterSource: opts?.rosterSource, savedSessionOnly: opts?.savedSessionOnly, singleAttempt: opts?.maxMidwalkRetries === 0 }, () => captureAllUserFollowing(igUserId, opts))
      : captureAllUserFollowing(igUserId, opts),
  );
}

async function captureAllUserFollowing(
  igUserId: string,
  opts?: PaginationOptions,
): Promise<FollowListCaptureResult> {
  const native = await paginateFollowList(
    `following-all:${igUserId}`,
    (cursor) => getUserFollowing(igUserId, cursor),
    opts,
  );
  const username = opts?.fallbackUsername?.trim();
  if (
    opts?.nativeOnly || native.ok ||
    !username ||
    !canUseApifyFallback(native.error, opts)
  ) {
    return native;
  }
  try {
    const requestedLimit = resolvePaginationOptions(opts).maxItems;
    const effectiveLimit = resolveApifyGraphLimit(requestedLimit);
    const data = await fetchApifyGraph(username, "following", requestedLimit);
    const complete = data.length < effectiveLimit;
    return {
      ok: true,
      data,
      source: "apify",
      complete,
      stopReason: complete ? "exhausted" : "item_cap",
    };
  } catch (error) {
    return {
      ok: false,
      source: "apify",
      error: `${native.error}; Apify fallback: ${errorMessage(error)}`,
    };
  }
}

// ── Wave 8: bot-pinned variants for private accounts ───────────────────────
//
// Private accounts can only be scraped by the specific bot that was granted
// access via the follow-request flow. These variants force the underlying
// scraper to lease THAT bot rather than the LRU pool. We deliberately do NOT
// rotate bots on failure (`MAX_BOT_ROTATIONS=0` semantics): no other bot has
// access, so retrying with a different one would just hit a 403/login_required.
async function runSingleBot<T>(
  label: string,
  bot: () => Promise<T>,
): Promise<PublicDataResult<T>> {
  try {
    const data = await withScrapeRetry(label, bot);
    return { ok: true, data, source: "bot" };
  } catch (err) {
    const msg = errorMessage(err);
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : null;
    logger.warn(
      { label, err: msg, cause: causeMsg, recoverable: err instanceof IGPublicScraperError },
      "pinned-bot provider failed",
    );
    return { ok: false, error: msg, source: "bot" };
  }
}

export async function getPublicProfileAsBot(
  username: string,
  igUserId: string | null | undefined,
  botAccountId: string,
): Promise<ProfileFetchResult> {
  const result = await runSingleBot<IGPublicProfile>(
    `profile:${username}:bot=${botAccountId}`,
    () => scrapeProfileWithBot(botAccountId, username, igUserId),
  );
  return result.ok ? { ...result, source: "bot" } : {
    ...result,
    rateLimited: /rate limit|rate_limited|429|throttle/i.test(result.error),
  };
}

export async function getUserPostsAsBot(
  username: string,
  igUserId: string,
  botAccountId: string,
  limit = 24,
): Promise<PublicDataResult<ReadonlyArray<IGPostSummary>>> {
  return runSingleBot<ReadonlyArray<IGPostSummary>>(
    `posts:${username}:bot=${botAccountId}`,
    () => scrapeUserPostsWithBot(botAccountId, igUserId, limit),
  );
}

export async function getUserStoriesAsBot(
  username: string,
  igUserId: string,
  botAccountId: string,
): Promise<PublicDataResult<ReadonlyArray<IGStoryItem>>> {
  return runSingleBot<ReadonlyArray<IGStoryItem>>(
    `stories:${username}:bot=${botAccountId}`,
    () => scrapeUserStoriesWithBot(botAccountId, igUserId),
  );
}

export async function getUserHighlightsAsBot(
  username: string,
  igUserId: string,
  botAccountId: string,
  withItems = false,
): Promise<PublicDataResult<ReadonlyArray<IGHighlight>>> {
  return runSingleBot<ReadonlyArray<IGHighlight>>(
    `highlights:${username}:bot=${botAccountId}`,
    () => scrapeUserHighlightsWithBot(botAccountId, igUserId, { withItems }),
  );
}

export async function getPostLikersAsBot(
  shortcode: string,
  mediaId: string,
  botAccountId: string,
): Promise<PublicDataResult<ReadonlyArray<IGUser>>> {
  return runSingleBot<ReadonlyArray<IGUser>>(
    `likers:${shortcode}:bot=${botAccountId}`,
    () => scrapeMediaLikersWithBot(botAccountId, shortcode, mediaId),
  );
}

export async function getPostCommentsAsBot(
  shortcode: string,
  mediaId: string,
  botAccountId: string,
  opts?: { maxPages?: number; maxItems?: number; beforePage?: () => Promise<void> },
): Promise<PublicDataResult<ReadonlyArray<IGComment>>> {
  return runSingleBot<ReadonlyArray<IGComment>>(
    `comments:${shortcode}:bot=${botAccountId}`,
    () => scrapeMediaCommentsWithBot(botAccountId, shortcode, mediaId, opts),
  );
}

// Wave 8.1: bot-pinned followers / following enumeration. Unlike the LRU
// `getAllUserFollowers` / `getAllUserFollowing` paginators which lease a
// fresh bot per page through `paginateFollowList`, these variants delegate
// the entire walk to `scrapeUser{Followers,Following}WithBot` so every page
// shares one leased bot session — required for private accounts where only
// the granted bot has visibility. Defaults are conservative (10 pages /
// 1000 items) to avoid burning the granted bot's daily budget.
export async function getAllUserFollowersAsBot(
  igUserId: string,
  botAccountId: string,
  opts?: PaginationOptions,
): Promise<FollowListCaptureResult> {
  const result = await runSingleBot(
    `followers-all:${igUserId}:bot=${botAccountId}`,
    () => scrapeUserFollowersCaptureWithBot(botAccountId, igUserId, opts),
  );
  return result.ok ? { ok:true,source:result.source,...result.data,data:result.data.users } : result;
}

export async function getAllUserFollowingAsBot(
  igUserId: string,
  botAccountId: string,
  opts?: PaginationOptions,
): Promise<FollowListCaptureResult> {
  const result = await runSingleBot(
    `following-all:${igUserId}:bot=${botAccountId}`,
    () => scrapeUserFollowingCaptureWithBot(botAccountId, igUserId, opts),
  );
  return result.ok ? { ok:true,source:result.source,...result.data,data:result.data.users } : result;
}

export type {
  IGPublicProfile,
  IGPostSummary,
  IGStoryItem,
  IGHighlight,
  IGFollowUser,
  IGComment,
  IGUser,
};
