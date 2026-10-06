// ─── IG public-data scraper (Wave 1 Agent B) ────────────────────────────────
//
// Thin, typed scraper API on top of the existing IG HTTP transport. Every
// function:
//   1. Reserves an available bot from the pool (atomic row-level lock so two
//      callers can't grab the same bot).
//   2. Decrypts the bot's stored session envelope.
//   3. Builds an IGClientPort using the bot's persistent device fingerprint.
//   4. Dispatches the IG call, zod-parsing the response into a domain shape.
//   5. Releases the bot (touches lastUsedAt so LRU rotation works) and
//      closes the underlying HTTP/2 session.
//
// This module owns NO business logic — it is a read-side adapter used by
// workers / routes to pull public profile data, posts, stories, highlights
// and follow edges without touching follow-request state. For that reason
// we never increment currentFollows or flip bot status.
//
// Errors: any bot-lookup, client-open, transport, or parse failure is
// surfaced as IGPublicScraperError with the original `cause` attached so
// upstream layers can decide whether to retry, cool-down, or give up.
// ─────────────────────────────────────────────────────────────────────────────

import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "./db.js";
import { OperationBusyError, withOperationLease } from "./services/operation-lease.js";
import { operationSignal } from "./services/operation-context.js";
import { trackedAccountHasAccess } from "./services/subscription-access.js";
import { consumeScrapeAttempt, currentScrapeOperation } from "./services/scrape-operation.js";
import { rosterRequestPageSize, targetCanaryEnabled, viewerAffinity, type ViewerAffinity } from "./services/viewer-affinity.js";
import { recordLeaseUnavailable } from "./services/scrape-capacity.js";
import { isIgWebThrottleBody } from "./services/ig-throttle.js";
export { isIgWebThrottleBody } from "./services/ig-throttle.js";
import { botAccounts, botDailyCalls } from "../shared/schema.js";
import { decryptSessionData } from "./crypto/session-envelope.js";
import { resolveFingerprint } from "./behavior/device-fingerprint.js";
import {
  createHttpBotClientWithFingerprint,
  IGAuthExpiredError,
  IGHttpError,
  IGRateLimitedError,
} from "./ig-http-client.js";
import { createBrowserReadClient } from "./ig-browser-read-client.js";
import { isMediaHomepageRedirect, withMediaBrowserFallback } from "./services/media-browser-fallback.js";
import { persistRefreshedWebSession } from "./services/web-session-refresh.js";
import { createMobileReadClient } from "./ig-mobile-read-client.js";
import { parseMobileEnvelope } from "./services/mobile-session.js";
import { pinnedMobileSession } from "./services/pinned-mobile-session.js";
import type { AutomationIdentity } from "./services/automation-client.js";
import { parseAutomationIdentity } from "./services/automation-identity.js";
import {
  BAN_REASON_SQL_REGEX,
  COOLDOWN_REASON_PREFIX,
  applyHardFailureEscalation,
  cooldownBotForCheckpoint,
  cooldownBotForRateLimit,
  formatCooldownReason,
  recordHardFailure,
  resetHardFailureStreak,
} from "./services/bot-cooldown.js";
import { proxyAgentUriForEndpoint, proxyEndpointLabel } from "./services/proxy-provider.js";
import { invalidateObservedBotSession, isBotAutoLoginEnabled } from "./services/bot-runtime.js";
import { accountProxyDurabilityIssue, KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX } from "./services/proxy-durability.js";
import {
  getScraperReadTransport,
  type ScraperReadTransport,
} from "./services/scraper-transport-config.js";
import type {
  IGClientPort,
  IGComment,
  IGFeedItem,
  IGFeedPage,
  IGFriendshipStatus,
  IGHighlightReel,
  IGHighlightsTray,
  IGProfile,
  IGReelItem,
  IGStoriesTray,
  IGUser,
} from "./domain/ig-client-port.js";
import { parseFeedResponse, parseProfileInfoResponse } from "./domain/ig-schemas.js";
import { readNativePublic } from "./services/native-public-read.js";
import { createNativeBrowserReadClient } from './services/native-browser-read-client.js';
import { getScrapeContext } from './services/bandwidth-meter.js';
import { IGSchemaError } from './domain/ig-client-port.js';
import { parseHighlightsTrayResponse, parseHighlightReelsResponse } from "./domain/ig-stories-schemas.js";
import { logger as baseLogger } from "./observability/logger.js";
import {
  recordOutcome,
  type ScrapeEndpoint,
  type ScrapeOutcomeKind,
} from "./services/scrape-metrics.js";
import {
  EndpointDisabledError,
  getActiveDisabled,
  recordStrike,
  recordSuccess,
} from "./services/endpoint-strikes.js";
import {
  endpointFamilyFromUrl,
  getBreakerSnapshot,
} from "./domain/ig-circuit-breaker.js";
import { IGCircuitOpenError } from "./domain/ig-client-port.js";
import {
  checkAndIncrementBudget,
  endpointDailyCap,
  normalizeEndpoint,
  reserveOrThrow as reserveDailyBudgetOrThrow,
} from "./behavior/daily-budget.js";

const logger = baseLogger.child({ module: "ig-public-scraper" });

// Unwrap a wrapper chain (IGPublicScraperError.cause, Error.cause) down to the
// error that actually carries the IG signal. Bounded so a cyclic or very deep
// chain cannot hang classification.
function rootCauseOf(err: unknown): unknown {
  let current: unknown = err;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof IGHttpError || current instanceof IGAuthExpiredError || current instanceof IGRateLimitedError) return current;
    const cause =
      current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
    if (cause === undefined || cause === null || cause === current) return current;
    current = cause;
  }
  return current;
}

// Message fallbacks are word-bounded: the old `includes("rate")` matched any
// word containing it ("generate", "separate", "moderate").
const RATE_LIMIT_MESSAGE_RE = /\brate[ _-]?limit|\b429\b|\bthrottl/i;
const CHECKPOINT_MESSAGE_RE = /\bcheckpoint|\bchallenge|\bauth[_ ]expired\b/i;
const NETWORK_MESSAGE_RE =
  /\bnetwork error\b|\beconnreset\b|\beconnrefused\b|\betimedout\b|\beai_again\b|\bsocket hang up\b|\bfetch failed\b|\bproxy\b/i;

// Classify a thrown error into a metrics outcome kind.
//
// Class and status first, message text last (2026-09-03, audit D5). The
// substring-only version filed IGAuthExpiredError ("auth rejected (status
// 401/403)") as a generic `failure`, recorded an open breaker — where no IG
// call was made at all — as a failure, and matched "rate" inside unrelated
// words. Anything still unrecognised falls back to `failure` so the
// per-endpoint success rate stays correct.
export function classifyError(err: unknown): ScrapeOutcomeKind {
  const root = rootCauseOf(err);
  // No IG request was made: not a scrape outcome, never persisted.
  if (root instanceof IGCircuitOpenError) return "skip";
  if (root instanceof IGRateLimitedError) return "rate_limit";
  if (root instanceof IGAuthExpiredError) {
    // IG's "please wait" 401 keeps a VALID session — a throttle, not a death.
    if (root.status === 401 && isIgWebThrottleBody(root.body ?? "")) return "rate_limit";
    return "auth";
  }
  if (root instanceof IGHttpError) {
    if (root.status === 429) return "rate_limit";
    // status 0 is the client's transport-fault sentinel (never reached IG).
    if (root.status === 0) return "network";
    if (root.authDiagnostics?.reason === "request_rejected") return "failure";
    if (root.authDiagnostics?.reason === "feedback_required") return "rate_limit";
    if (
      root.igErrorCode === "checkpoint_required" ||
      root.igErrorCode === "challenge_required"
    ) {
      return "checkpoint";
    }
    if (root.status === 401 || root.status === 403) {
      return isIgWebThrottleBody(root.body ?? "") ? "rate_limit" : "auth";
    }
  }
  const message = root instanceof Error ? root.message : String(root);
  if (RATE_LIMIT_MESSAGE_RE.test(message)) return "rate_limit";
  if (CHECKPOINT_MESSAGE_RE.test(message)) return "checkpoint";
  if (NETWORK_MESSAGE_RE.test(message)) return "network";
  return "failure";
}

// IG answers a THROTTLED (but still valid) logged-in web session with HTTP 401 +
//   {"message":"<localized 'please wait a few minutes'>",
//    "require_login":true,"igweb_rollout":true,"status":"fail"}
// Match the language-independent JSON shape, NOT the localized message: bots run
// under de/es/fr/hi/ur locales, and an English-only substring match silently
// misclassified 65 throttled bots as permanent auth deaths, locking them out of
// the lease pool for good. Verified against every 401 body observed in the pool
// (65/65 carry both markers; none carry one without the other).

function isProxyTransportFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes("err_tunnel_connection_failed") ||
    message.includes("err_proxy_connection_failed") ||
    message.includes("proxy") ||
    message.includes("tunnel") ||
    message.includes("page.goto: timeout") ||
    message.includes("net::err_connection") ||
    message.includes("net::err_timed_out")
  );
}

// ── Public domain types ────────────────────────────────────────────────────

export type IGPostType =
  | "photo"
  | "video"
  | "reel"
  | "carousel"
  | "tagged_post";
export type IGStoryMediaType = "photo" | "video";

export interface IGPublicProfile {
  readonly igUserId: string;
  readonly username: string;
  readonly fullName: string;
  readonly biography: string;
  readonly profilePicUrl: string;
  readonly profilePicUrlHd: string;
  readonly isPrivate: boolean;
  readonly isVerified: boolean;
  readonly viewerRelationshipKnown?: boolean;
  readonly followedByViewer?: boolean;
  readonly requestedByViewer?: boolean;
  readonly isBusinessAccount: boolean;
  readonly externalUrl: string | null;
  readonly followerCount: number;
  readonly followingCount: number;
  readonly postCount: number;
}

export interface IGPostSummary {
  readonly shortcode: string;
  readonly mediaId: string;
  readonly postType: IGPostType;
  readonly thumbnailUrl: string;
  readonly displayUrl: string;
  readonly videoUrl: string | null;
  readonly caption: string;
  readonly likeCount: number;
  readonly commentCount: number;
  readonly videoViewCount: number | null;
  readonly takenAt: Date;
  readonly locationName: string | null;
  readonly hashtags: ReadonlyArray<string>;
  // Instagram-posts features (additive): whether this post is pinned to the
  // top of the profile grid, and the ordered carousel children for sidecar
  // posts. Single-media / non-pinned posts use safe defaults (false / null).
  readonly isPinned: boolean;
  readonly carouselMedia: ReadonlyArray<{
    mediaId?: string;
    type: "photo" | "video";
    displayUrl: string;
    videoUrl: string | null;
  }> | null;
}

export interface IGStoryItem {
  readonly storyId: string;
  readonly mediaType: IGStoryMediaType;
  readonly mediaUrl: string;
  readonly thumbnailUrl: string;
  readonly takenAt: Date;
  readonly expiresAt: Date;
}

export interface IGHighlight {
  readonly highlightId: string;
  readonly title: string;
  readonly coverUrl: string;
  readonly mediaCount: number;
  /** The native tray omits counts; absence must never prove a cached reel unchanged. */
  readonly mediaCountKnown?: boolean;
  readonly items: ReadonlyArray<IGStoryItem>;
}

export interface IGFollowUser {
  readonly igUserId: string;
  readonly username: string;
  readonly fullName: string;
  readonly profilePicUrl: string;
  readonly isPrivate: boolean;
  readonly isVerified: boolean;
}

export interface IGFollowPage {
  readonly users: ReadonlyArray<IGFollowUser>;
  readonly nextCursor: string | null;
  readonly sourceLimited?: boolean;
}

// ── Error type ─────────────────────────────────────────────────────────────

export class IGPublicScraperError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "IGPublicScraperError";
    this.cause = cause;
  }
}

/**
 * Instagram withheld the follower/following list from the viewing bot
 * (`special_empty_state`): "we limit certain things you can see, like another
 * person's follower/following lists". The list is NOT empty — the bot is being
 * throttled. Thrown so the caller never mistakes it for a complete 0-member read
 * (which would settle the roster at 0 and show the account as following nobody).
 * A higher-trust bot may succeed, so this is a per-attempt failure, not a fact
 * about the account.
 */
export class IGListRestrictedError extends IGPublicScraperError {
  readonly botId: string | null;
  constructor(
    kind: "followers" | "following",
    igUserId: string,
    botId?: string,
  ) {
    super(
      `[ig-public-scraper] ${kind} list restricted by Instagram for ${igUserId} (special_empty_state) — viewing bot throttled`,
    );
    this.name = "IGListRestrictedError";
    this.botId = botId ?? null;
  }
}

/**
 * An AUTHENTICATED endpoint (likers / followers / following / friendship
 * status) answered HTTP 2xx with a non-JSON body. That is Instagram's login
 * wall — an HTML page served to a session it no longer honours — not a parse
 * glitch. Before this it surfaced as a generic "response not JSON" failure:
 * no cooldown, so the same dead bot was re-leased and re-failed all day, and
 * scrape-retry re-tried it in place. The message deliberately carries
 * `login_required` so `isPermanentPerBot` (scrape-retry.ts, which matches on
 * the root error's message) rotates instead of sleeping. The original error
 * is kept on `original`, NOT `cause`, because scrape-retry unwraps `cause`
 * chains and would classify the root IGHttpError (status 200) as retryable.
 */
export class IGLoginWallError extends IGPublicScraperError {
  readonly botId: string | null;
  readonly original: unknown;
  constructor(label: string, url: string | undefined, original: unknown, botId?: string) {
    super(
      `[ig-public-scraper] login_required wall (non-JSON body) for ${label}${
        url ? ` at ${url}` : ""
      } — bot session rejected by Instagram`,
    );
    this.name = "IGLoginWallError";
    this.botId = botId ?? null;
    this.original = original;
  }
}

// ── Bot assignment (pool-style, read-only for public scrape) ───────────────

interface LeasedBot {
  readonly id: string;
  readonly igUsername: string;
  readonly sessionData: string;
  readonly fingerprint: ReturnType<typeof resolveFingerprint>;
  // Wave 4: sticky proxy endpoint ("host:port") this bot is currently
  // pinned to. Threaded into the IG client so every scrape exits the
  // residential pool rather than our datacenter IP.
  readonly proxyEndpoint: string | null;
  /** Set only for bots explicitly migrated to FastAPI automation. */
  readonly automationIdentity: AutomationIdentity | null;
  /** Read transport: 'web' (default) or 'mobile' (Bearer IGT:2 session). */
  readonly transport: "web" | "mobile";
}

// Endpoints a mobile (Bearer IGT:2) session can serve. These bought mobile
// sessions reliably read profile + user feed (posts), but IG hard-gates the
// heavier endpoints (followers/following/stories/highlights/comments/likers/
// clips/tagged) behind a web-rollout login the token can't satisfy — verified
// across multiple accounts, HTTP 403 login_required / igweb_rollout. So a
// mobile bot is admitted ONLY for these labels; every other job stays web-only.
/**
 * Endpoints the mobile (Bearer IGT:2) transport is allowed to serve.
 *
 * Mobile was originally limited to profile+posts because the bought sessions
 * answered 403 login_required on the gated endpoints. That is still true of
 * LIKERS — retested with a warm claim, nav-chain and a full human-like
 * sequence, all 403 — but followers/following DO work: two independent mobile
 * bots returned HTTP 200 with full user pages.
 *
 * That matters because the web pool is the scarce, ban-prone one and it was
 * carrying ~1,400 follower/following reads a day on top of every liker read.
 * Web bots were doing ~141 scrapes each per day against mobile's ~47, and web
 * bots are the ones that die. Moving roster reads to mobile frees that budget
 * for likers, which only web can do.
 *
 * MOBILE_ROSTER_ENABLED=false reverts to profile+posts if mobile starts burning.
 */
const MOBILE_CAPABLE_ENDPOINTS: ReadonlySet<ScrapeEndpoint> =
  (process.env.MOBILE_ROSTER_ENABLED ?? "true") === "false"
    ? new Set<ScrapeEndpoint>(["profile", "posts"])
    : new Set<ScrapeEndpoint>(["profile", "posts", "followers", "following"]);

/** Exhaustive by construction: adding a ScrapeEndpoint fails tsc until listed. */
const ALL_SCRAPE_ENDPOINTS: Readonly<Record<ScrapeEndpoint, true>> = {
  profile: true,
  posts: true,
  clips: true,
  tagged: true,
  stories: true,
  highlights: true,
  followers: true,
  following: true,
  comments: true,
  likers: true,
  login: true,
};

function isScrapeEndpoint(value: string): value is ScrapeEndpoint {
  return Object.prototype.hasOwnProperty.call(ALL_SCRAPE_ENDPOINTS, value);
}

/**
 * Endpoints ONLY the mobile transport may serve — the mirror of
 * MOBILE_CAPABLE_ENDPOINTS above.
 *
 * MOBILE_CAPABLE_ENDPOINTS says "a mobile bot is allowed here". It never said
 * anything about web bots, which stayed eligible for everything. As of
 * 2026-09-04 that is wrong for `posts`: IG answers the web/pyhttpz transport
 * on /api/v1/feed/user/ with HTTP 200 and an HTML login page, so a web-lane
 * posts read cannot succeed. Measured over the wall: 8 successes out of 4,718
 * web `posts` attempts on 2026-09-04 (0.17%) and 0/37 on 2026-09-05, against
 * 88-92% on the mobile lane over the same window. Those dead attempts are not
 * merely wasted: each login-wall answer is a hard failure that feeds the
 * streak escalation and benches the web bot, stealing pool capacity from
 * `likers`, which only web can serve. So `posts` is routed to mobile only.
 *
 * Safety invariant (enforced below, not merely documented): an endpoint may be
 * mobile-only ONLY if it is also mobile-capable. Otherwise the two gates would
 * intersect to the empty set and no bot of any transport could ever be leased
 * for that label — the endpoint would go permanently dead. Offenders are
 * dropped with one warn at module init. Note that MOBILE_ROSTER_ENABLED=false
 * — the CURRENT production value in ecosystem.config.cjs — shrinks
 * MOBILE_CAPABLE_ENDPOINTS to {profile, posts}, so adding `followers`/
 * `following` here would silently drop them under today's config. That is the
 * invariant doing its job, not a bug: roster reads sent back to web must not
 * also be stranded with no leasable transport. `posts` is unaffected: it is
 * mobile-capable under both settings of that knob.
 *
 * Revert: set MOBILE_ONLY_ENDPOINTS=none in ecosystem.config.cjs and restart.
 * No deploy needed. An empty value disables the gate the same way.
 */
const MOBILE_ONLY_ENDPOINTS: ReadonlySet<ScrapeEndpoint> = (() => {
  const raw = (process.env.MOBILE_ONLY_ENDPOINTS ?? "posts").trim().toLowerCase();
  if (raw === "" || raw === "none") return new Set<ScrapeEndpoint>();
  const requested = Array.from(
    new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .filter(isScrapeEndpoint),
    ),
  );
  const dropped = requested.filter((label) => !MOBILE_CAPABLE_ENDPOINTS.has(label));
  if (dropped.length > 0) {
    logger.warn(
      {
        dropped,
        mobileCapable: Array.from(MOBILE_CAPABLE_ENDPOINTS),
        mobileRosterEnabled: process.env.MOBILE_ROSTER_ENABLED ?? "true",
      },
      "[ig-public-scraper] MOBILE_ONLY_ENDPOINTS entries dropped: not mobile-capable, so making them mobile-only would leave no leasable bot of any transport",
    );
  }
  return new Set<ScrapeEndpoint>(
    requested.filter((label) => MOBILE_CAPABLE_ENDPOINTS.has(label)),
  );
})();

/**
 * True when only the mobile transport may serve `endpoint`.
 *
 * Exported for the bot warmer, which drives WEB sessions exclusively. A warm
 * action aimed at a mobile-only label cannot succeed on the lane it runs on:
 * IG answers with the login wall, `runAction` counts a failed action, the
 * session burns its budget, and the failure feeds the bot's hard-failure
 * streak. Reading the gate here keeps ONE definition of "the web lane is
 * walled for this label" instead of a second copy that would drift.
 */
export function isEndpointMobileOnly(endpoint: ScrapeEndpoint): boolean {
  return MOBILE_ONLY_ENDPOINTS.has(endpoint);
}

// Endpoints that trip login walls / checkpoints on a session's FIRST request
// (2026-09-03, audit B4). Of the 105 sessions imported on 2026-09-02, 6 were
// suspended on their very first call — 4 on likers, 1 followers, 1 comments.
// For these a bot must have prior proven use (a lease or a warm browse),
// enforced as a WHERE predicate and not only as the ORDER BY demotion, which
// still handed a fresh bot the read whenever it was the only candidate. Fresh
// bots earn their first touch on profile / posts / stories / highlights / the
// warmer and become eligible after one.
export const FIRST_TOUCH_SENSITIVE_ENDPOINTS: ReadonlySet<ScrapeEndpoint> =
  new Set<ScrapeEndpoint>(["likers", "followers", "following", "comments"]);

// ── Breaker key for a lease (audit D6) ──────────────────────────────────────
//
// The circuit breaker is keyed `${botId}:${endpointFamily}`, the family being
// derived from the URL each transport actually requests. To check the breaker
// BEFORE reserving a daily-budget unit the same key is needed from the lease
// label alone. Web/browser reads go through the real `endpointFamilyFromUrl`
// on the path the web client requests for that label, so the mapping cannot
// drift from the breaker's own table; the mobile client's private family
// function is mirrored by name. A mismatch is fail-safe: the pre-check becomes
// a no-op and the task-side `assertCanCall` still applies.
const WEB_PATH_BY_LABEL: Readonly<Record<ScrapeEndpoint, string>> = {
  profile: "/api/v1/users/web_profile_info/?username=x",
  posts: "/api/v1/feed/user/1/",
  clips: "/api/v1/clips/user/",
  tagged: "/api/v1/usertags/1/feed/",
  // The web client reads stories through /feed/reels_media/ (the highlights
  // family); /feed/user/{id}/reel_media is the mobile shape.
  stories: "/api/v1/feed/reels_media/?reel_ids=1",
  highlights: "/api/v1/highlights/1/highlights_tray/",
  followers: "/api/v1/friendships/1/followers/",
  following: "/api/v1/friendships/1/following/",
  comments: "/api/v1/media/1/comments/",
  likers: "/api/v1/media/1/likers/",
  login: "",
};

/** Mirrors `endpointFamily()` in ig-mobile-read-client.ts (private there). */
const MOBILE_FAMILY_BY_LABEL: Readonly<Record<ScrapeEndpoint, string>> = {
  profile: "profile",
  posts: "feed",
  clips: "clips",
  tagged: "tagged",
  stories: "stories",
  highlights: "highlights",
  followers: "followers",
  following: "following",
  comments: "comments",
  likers: "likers",
  login: "other",
};

export function breakerFamilyForLabel(
  label: ScrapeEndpoint,
  transport: "web" | "mobile",
): string {
  return transport === "mobile"
    ? MOBILE_FAMILY_BY_LABEL[label]
    : endpointFamilyFromUrl(WEB_PATH_BY_LABEL[label]);
}

export function breakerKeyForLease(
  botId: string,
  label: ScrapeEndpoint,
  transport: "web" | "mobile",
  readTransport?: ScraperReadTransport,
): string {
  const browser = transport === "web" && (readTransport === "browser" || readTransport === "browser-fallback" ||
    (readTransport === "http-first" && (label === "likers" || label === "comments")));
  return `${botId}${browser ? ":browser" : ""}:${breakerFamilyForLabel(label, transport)}`;
}

interface OpenBreaker {
  readonly key: string;
  readonly openUntil: number;
}

/**
 * The breaker for this (bot, label) is OPEN and its timer has not lapsed.
 * Once `openUntil` passes, `assertCanCall` moves it to HALF_OPEN and admits a
 * probe, so that case is deliberately NOT reported as open — the probe is how
 * the breaker recovers.
 */
function openBreakerForLease(
  bot: LeasedBot,
  label: ScrapeEndpoint,
  now: number,
  readTransport?: ScraperReadTransport,
): OpenBreaker | null {
  const key = breakerKeyForLease(bot.id, label, bot.transport, readTransport);
  const snapshot = getBreakerSnapshot(key);
  if (snapshot.state !== "OPEN") return null;
  if (snapshot.openUntil === null || snapshot.openUntil <= now) return null;
  return { key, openUntil: snapshot.openUntil };
}

// ── Leasable-bot predicate (ONE definition — audit D7) ──────────────────────
//
// Three "leasable" definitions had drifted apart by 2026-09-03: this lease,
// the admin health snapshot (hard-coded regex, no `cooldown:` carve-out) and
// scripts/collection-health.sh (required automation_identity, so it counted 0
// of the 53 mobile bots). This fragment is the bot-level half of the lease
// WHERE — everything that makes a bot leasable for SOME endpoint, independent
// of the label. buildLeaseCandidateQuery adds the endpoint-specific parts on
// top (mobile capability, budget gate, first-touch, exclusions), the admin
// snapshot counts with exactly this fragment, and collection-health.sh carries
// the same predicate as documented raw SQL (a shell script cannot import it).

export interface LeasablePredicateOptions {
  readonly now?: Date;
  readonly roles?: ViewerAffinity["roles"];
}

export function leasableBotSqlPredicate(opts: LeasablePredicateOptions = {}): SQL {
  const { now = new Date() } = opts;
  return and(
    structurallyEligibleBotSqlPredicate(opts),
    or(isNull(botAccounts.cooldownUntil), lt(botAccounts.cooldownUntil, now)),
  )!;
}

/** Structural eligibility alone cannot authorize a request. Background cursor
 * recovery uses it to distinguish an unusable reader from a temporary cooldown;
 * every actual read still passes the full lease, quota and operation guards. */
export function structurallyEligibleBotSqlPredicate(opts: Pick<LeasablePredicateOptions, "roles"> = {}): SQL {
  const autoLoginEnabled = isBotAutoLoginEnabled();
  const predicate = and(
    eq(botAccounts.status, "available"),
    // Collection leases are for the scraper pool only (2026-09-03). Squad
    // watchers (feed_watcher / reels_watcher) are pinned by id through
    // loadWatcherBotIds → leaseSpecificBot; leasing them here spent their
    // budget on followers/likers reads (~1,000 in 30h) and then parked
    // them in cooldown exactly when the liked-by squad needed them.
    opts.roles ? inArray(botAccounts.role, [...opts.roles]) : eq(botAccounts.role, "scraper"),
    // Reserve is a staging-only tier.  A bot must be explicitly
    // promoted after its FastAPI identity, proxy, and Firefox session
    // have all been validated; otherwise a background read could claim
    // an unreviewed account simply because it is marked available.
    inArray(botAccounts.tier, ["worker", "canary"]),
    // Defensive: even if cooldown_until is unset (clock skew, manual DB
    // edits, prior code paths that recorded the error without a cooldown),
    // we never want to re-lease a bot whose last login attempt landed on
    // an IG checkpoint — re-using it predictably triggers another
    // checkpoint and burns a strike against the endpoint.
    //
    // NOTE: 'browser proxy transport' is deliberately NOT in this regex.
    // A transport failure is TRANSIENT — it is already gated by the
    // 30-minute `cooldown_until` set alongside it (see handlePublicScrapeError).
    // Listing it here made the exclusion PERMANENT: the cooldown expired but
    // the last_login_error string lingered, so the bot could never be
    // re-leased, and only a lease→login clears the string — a deadlock that
    // poisoned the entire pool within a day ("no bot available" → all data
    // stops). The cooldown alone is the correct guard; genuine, permanent
    // bans (checkpoint/suspended/csrf/auth rejected) stay listed below.
    // A reason written by a TIMED cooldown is never a ban verdict — the
    // cooldown_until guard above already enforces its timing. Without
    // this carve-out the same column served as both, and every 24h
    // checkpoint cooldown became a permanent exclusion (see bot-cooldown.ts).
    sql`(COALESCE(${botAccounts.lastLoginError}, '') LIKE ${COOLDOWN_REASON_PREFIX + "%"}
         OR COALESCE(${botAccounts.lastLoginError}, '') !~* ${BAN_REASON_SQL_REGEX})`,
    // A stored cookie jar is usable only on the account lane that
    // created it. Exclude short-lived explicit DataImpulse URLs before
    // leasing (the runtime also rejects them as defense in depth), and
    // require provider-issued lanes to retain two minutes of headroom.
    // Session-less rows may still enter the supervised auto-login path
    // when no explicit short-lived URL is attached.
    //
    // Mobile-transport bots (migration 0038) legitimately have NO Firefox
    // automation_identity — they carry a pre-authenticated Bearer session
    // driven by ig-mobile-read-client.ts. Admit them via the OR so the
    // web-path requirement is otherwise unchanged.
    or(
      isNotNull(botAccounts.automationIdentity),
      eq(botAccounts.transport, "mobile"),
    ),
    sql`(
      (
        ${botAccounts.proxyUrl} IS NOT NULL
        AND ${botAccounts.proxyUrl} !~* ${KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX}
      )
      OR (
        ${botAccounts.proxyUrl} IS NULL
        AND ${botAccounts.proxyEndpoint} IS NOT NULL
        AND ${botAccounts.proxyExpiresAt} > NOW() + INTERVAL '2 minutes'
      )
      OR (
        ${botAccounts.sessionData} IS NULL
        AND ${botAccounts.proxyUrl} IS NULL
      )
    )`,
    ...(autoLoginEnabled ? [] : [isNotNull(botAccounts.sessionData)]),
  );
  if (predicate === undefined) {
    throw new Error("[ig-public-scraper] leasable predicate built empty");
  }
  return predicate;
}

/** Keep saved-cursor compatibility identical to the runtime pool selection. */
export function publicReadTransportSqlPredicate(label: ScrapeEndpoint | undefined, opts: {
  rosterSource?: ViewerAffinity["rosterSource"]; webOnly?: boolean;
} = {}): SQL {
  const graphqlRoster = opts.rosterSource === "graphql";
  if (graphqlRoster && label !== "followers" && label !== "following") throw new Error("GraphQL roster affinity requires a roster endpoint");
  const mobileCapable = !graphqlRoster && label !== undefined && MOBILE_CAPABLE_ENDPOINTS.has(label);
  const mobileOnly = !opts.webOnly && label !== undefined && MOBILE_ONLY_ENDPOINTS.has(label);
  return and(
    ...(opts.webOnly ? [eq(botAccounts.transport, "web")] : []),
    ...(mobileCapable ? [] : [sql`${botAccounts.transport} <> 'mobile'`]),
    ...(mobileOnly ? [sql`${botAccounts.transport} = 'mobile'`] : []),
  ) ?? sql`true`;
}

type PostsCapacityCandidate = Pick<typeof botAccounts.$inferSelect,
  "id" | "transport" | "createdAt" | "cooldownUntil" | "sessionData" | "automationIdentity" |
  "proxyUrl" | "proxyEndpoint" | "proxyExpiresAt">;

function savedPostsReaderValidAt(bot: PostsCapacityCandidate, at: number): boolean {
  try {
    const proxy = bot.proxyUrl ?? (bot.proxyEndpoint ? proxyAgentUriForEndpoint(bot.proxyEndpoint) : "");
    if (accountProxyDurabilityIssue(proxy) !== null ||
        (bot.proxyUrl === null && (!bot.proxyExpiresAt || bot.proxyExpiresAt.getTime() <= at + 120_000))) return false;
    if (!bot.sessionData) return false;
    const session = decryptSessionData(bot.sessionData);
    if (bot.transport === "mobile") {
      const mobile = parseMobileEnvelope(session);
      if (!mobile?.sessionid || !mobile.bearer || !/^[1-9]\d*$/.test(mobile.dsUserId)) return false;
      const bearer = /^Bearer[ \t]+IGT:2:([A-Za-z0-9+/_-]+={0,2})$/.exec(mobile.bearer);
      if (!bearer) return false;
      const token = JSON.parse(Buffer.from(bearer[1], "base64").toString("utf8"));
      const cookie = decodeURIComponent(mobile.sessionid);
      return cookie.startsWith(mobile.dsUserId + ":") && cookie.length > mobile.dsUserId.length + 1 &&
        !/[\r\n\0]/.test(cookie) && String(token?.ds_user_id) === mobile.dsUserId &&
        typeof token?.sessionid === "string" && decodeURIComponent(token.sessionid) === cookie;
    }
    if (bot.transport !== "web" || !parseAutomationIdentity(bot.automationIdentity, bot.id)) return false;
    const state = JSON.parse(session);
    if (!Array.isArray(state?.cookies)) return false;
    return ["sessionid", "csrftoken"].every(name => state.cookies.some((cookie: {
      name?: string; value?: string; domain?: string; expires?: number;
    } | null) => cookie?.name === name && typeof cookie.value === "string" && cookie.value.length > 0 &&
      !/[\r\n\0]/.test(cookie.value) && ["instagram.com", "www.instagram.com"].includes((cookie.domain ?? "").replace(/^\./,"")) &&
      (cookie.expires === undefined || (typeof cookie.expires === "number" &&
        (cookie.expires <= 0 || cookie.expires * 1000 > at)))));
  } catch { return false; }
}

/** Read-only forecast, never a lease or permission to bypass current guards.
 * Return a known cooldown, quota, lease or breaker wake-up only when no valid reader can serve
 * posts now. Missing/broken sessions require repair, not invented retry loops. */
export async function getPublicPostsRetryAt(now = new Date(), username?: string): Promise<Date | null> {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;
  const webOnly = process.env.IG_NATIVE_PUBLIC_READS_ENABLED === "true" || targetCanaryEnabled("IG_NATIVE_PUBLIC_TARGETS", username);
  const readTransport = webOnly ? "browser" : (await getScraperReadTransport()).value;
  const rows = await db.select({
    bot: { id: botAccounts.id, transport: botAccounts.transport, createdAt: botAccounts.createdAt,
      cooldownUntil: botAccounts.cooldownUntil, sessionData: botAccounts.sessionData,
      automationIdentity: botAccounts.automationIdentity, proxyUrl: botAccounts.proxyUrl,
      proxyEndpoint: botAccounts.proxyEndpoint, proxyExpiresAt: botAccounts.proxyExpiresAt },
    used: sql<number>`COALESCE(${botDailyCalls.count},0)::int`,
    leaseUntil: sql<Date | null>`(SELECT expires_at FROM backend_operation_leases
      WHERE key='bot:'||${botAccounts.id} AND expires_at>clock_timestamp())`,
  }).from(botAccounts).leftJoin(botDailyCalls, and(eq(botDailyCalls.botId, botAccounts.id),
    eq(botDailyCalls.day, now.toISOString().slice(0, 10)), eq(botDailyCalls.endpoint, "posts")))
    .where(and(structurallyEligibleBotSqlPredicate(), publicReadTransportSqlPredicate("posts", {webOnly}),
      isNotNull(botAccounts.sessionData)));
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  let earliest = Infinity;
  for (const {bot, used, leaseUntil} of rows) {
    if (bot.transport !== "web" && bot.transport !== "mobile") continue;
    const cap = endpointDailyCap(bot.createdAt, "posts", now, bot.transport);
    if (cap <= 0) continue;
    const breaker = getBreakerSnapshot(breakerKeyForLease(bot.id, "posts", bot.transport, readTransport));
    const breakerUntil = breaker.state === "OPEN" ? breaker.openUntil ?? 0 : 0;
    const readyAt = Math.max(nowMs, bot.cooldownUntil?.getTime() ?? 0, used >= cap ? midnight : 0,
      leaseUntil ? new Date(leaseUntil).getTime() : 0, breakerUntil);
    if (!savedPostsReaderValidAt(bot, readyAt)) continue;
    if (readyAt === nowMs) return null;
    earliest = Math.min(earliest, readyAt);
  }
  return Number.isFinite(earliest) ? new Date(earliest) : null;
}

// ── Lease candidate query (ONE builder for the runtime and smoke-lease.ts) ──
//
// Lesson 22: this SELECT is the one query every collection read depends on,
// and a one-line ORDER BY slip took the whole pool offline for 37 minutes
// because the unit tests never execute SQL. It is therefore built in exactly
// one place, exported, and `server/scripts/smoke-lease.ts` runs the SAME
// query the runtime runs (toSQL → EXPLAIN → SELECT) against the live DB
// before and after every deploy. `leaseBot` must never build it inline again.
// Constants in ORDER BY must be expressions (CASE … END), never bare literals.

/** Every label the collection pipeline leases for; drives the smoke check. */
export const PRODUCTION_LEASE_LABELS: ReadonlyArray<ScrapeEndpoint> = [
  "profile",
  "posts",
  "followers",
  "following",
  "likers",
  "stories",
  "highlights",
  "comments",
];

// A creation date far enough in the past to land in the most permissive
// budget tier. BUDGET_TABLE caps never decrease with age and the import-day
// likers ramp only applies inside BOT_IMPORT_GRACE_HOURS, so this yields the
// LARGEST daily cap any bot of the given transport can hold for the endpoint
// right now — the SQL-side bound of the pre-lease budget gate below.
const MATURED_BOT_CREATED_AT = new Date(0);

export function maxEndpointDailyCap(
  endpoint: string,
  now: Date,
  transport: "web" | "mobile",
): number {
  return endpointDailyCap(MATURED_BOT_CREATED_AT, endpoint, now, transport);
}

/** UTC day key — the same shape daily-budget.ts writes to bot_daily_calls.day. */
function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface LeaseCandidateQueryOptions {
  readonly viewer?: ViewerAffinity;
  readonly label?: ScrapeEndpoint;
  readonly excludedBotIds?: ReadonlySet<string>;
  readonly now?: Date;
  readonly webOnly?: boolean;
}

/** Anything that can start a drizzle SELECT: `db`, a transaction, `drizzle.mock()`. */
type LeaseQueryExecutor = Pick<typeof db, "select">;

/**
 * The exact candidate SELECT `leaseBot` runs: the LRU available scraper bot
 * for `label`, `FOR UPDATE SKIP LOCKED`, limit 1. Pure — no I/O until awaited.
 */
export function buildLeaseCandidateQuery(
  executor: LeaseQueryExecutor,
  opts: LeaseCandidateQueryOptions = {},
) {
  const { label, excludedBotIds = new Set<string>(), now = new Date() } = opts;
  if (opts.viewer?.roles?.some(role => role !== "scraper") &&
      (label !== "likers" || !opts.viewer.targetUsername)) {
    throw new Error("watcher reads require an explicit relationship-qualified liker request");
  }
  // When the job is not mobile-capable, exclude mobile bots so they never take
  // a followers/likers/stories job they cannot complete. When it IS mobile-
  // capable, mobile bots are eligible and preferred (below) to spare the
  // scarcer web pool for the web-only endpoints.
  const graphqlRoster = opts.viewer?.rosterSource === "graphql";
  if (graphqlRoster && label !== "followers" && label !== "following") throw new Error("GraphQL roster affinity requires a roster endpoint");
  const mobileCapable = !graphqlRoster && label !== undefined && MOBILE_CAPABLE_ENDPOINTS.has(label);
  // The mirror gate: labels the web transport can no longer complete at all
  // (posts, since IG started answering the web lane with a login wall) are
  // restricted to mobile bots. Empty by default when MOBILE_ONLY_ENDPOINTS=none.
  // Pre-lease daily-budget gate (2026-09-03). The exact per-bot cap depends on
  // account age, transport and five env knobs (endpointDailyCap), so it is NOT
  // re-derived in SQL — a second copy of that schedule would drift silently.
  // Instead the SQL bound is the largest cap ANY bot of that transport can
  // hold today: a bot at or above it is capped under every tier and is skipped
  // outright; `reserveOrThrow` in runWithLease stays the exact second gate.
  // For mobile bots (flat MOBILE_DAILY_CAP, age-independent) and for every
  // web bot at the matured tier (all pre-aged imports via BOT_AGE_FLOOR_DAYS)
  // the bound IS the exact cap. Before this, ~350 "hit daily cap" rejections a
  // day: the mobile-first ORDER BY kept handing posts leases to 40 mobile bots
  // already at 60/60 while 127 web bots (posts is unlimited for them) idled.
  const budgetEndpoint = label === undefined ? null : normalizeEndpoint(label);
  const budgetGate =
    budgetEndpoint === null
      ? null
      : sql`NOT EXISTS (
          SELECT 1 FROM ${botDailyCalls}
          WHERE ${botDailyCalls.botId} = ${botAccounts.id}
            AND ${botDailyCalls.day} = ${utcDayKey(now)}::date
            AND ${botDailyCalls.endpoint} = ${budgetEndpoint}
            AND ${botDailyCalls.count} >= (CASE
              WHEN ${botAccounts.transport} = 'mobile'
                THEN ${maxEndpointDailyCap(budgetEndpoint, now, "mobile")}::int
              ELSE ${maxEndpointDailyCap(budgetEndpoint, now, "web")}::int
            END)
        )`;

  // B4: sensitive endpoints need a session with prior proven use.
  const provenSessionRequired =
    label !== undefined && FIRST_TOUCH_SENSITIVE_ENDPOINTS.has(label);

  return executor
    .select()
    .from(botAccounts)
    .where(
      and(
        // Bot-level half (status / role / tier, cooldown timing, ban verdicts
        // with the timed-cooldown carve-out, transport-aware identity, proxy
        // lane, session when auto-login is off) — the ONE definition shared
        // with the admin health snapshot and collection-health.sh (D7).
        leasableBotSqlPredicate({ now, roles: opts.viewer?.roles }),
        ...(opts.viewer?.botId ? [eq(botAccounts.id, opts.viewer.botId)] : []),
        ...(opts.viewer?.savedSessionOnly ? [isNotNull(botAccounts.sessionData)] : []),
        publicReadTransportSqlPredicate(label, { webOnly: opts.webOnly, rosterSource: opts.viewer?.rosterSource }),
        ...(opts.viewer?.targetUsername ? [sql`EXISTS (
          SELECT 1 FROM watcher_follow_state w WHERE w.bot_id = ${botAccounts.id}
            AND lower(w.target_username) = lower(${opts.viewer.targetUsername})
            AND w.state = 'following' AND w.verified_at > now() - interval '7 days'
        )`, sql`NOT EXISTS (SELECT 1 FROM bot_daily_calls d WHERE d.bot_id = ${botAccounts.id}
          AND d.day = ${utcDayKey(now)}::date AND d.endpoint = 'likers' AND d.count >= 2)`] : []),
        sql`NOT EXISTS (SELECT 1 FROM backend_operation_leases ol
          WHERE ol.key = 'bot:' || ${botAccounts.id} AND ol.expires_at > clock_timestamp())`,
        ...(excludedBotIds.size > 0
          ? [notInArray(botAccounts.id, Array.from(excludedBotIds))]
          : []),
        // A bot already at today's cap for this endpoint is not a candidate.
        ...(budgetGate === null ? [] : [budgetGate]),
        // First touch is never a sensitive read (B4). Both columns are tested
        // with IS NOT NULL so the OR is two-valued (lesson 23): a never-used,
        // never-warmed bot is excluded; one that has done either is admitted.
        ...(provenSessionRequired
          ? [
              or(
                isNotNull(botAccounts.lastUsedAt),
                isNotNull(botAccounts.lastWarmingAt),
              ),
            ]
          : []),
      ),
    )
    // Prefer warm workers, then classic LRU.  A static proxy is a property
    // of one bot, not a pool-wide recovery override: prioritising it here
    // sent every scheduled account through one IP and caused the 429 churn.
    .orderBy(
      // For mobile-capable jobs, drain mobile bots first so the scarce web
      // pool is reserved for web-only endpoints. For web-only jobs this term
      // is constant (no mobile rows are in the candidate set anyway).
      sql`CASE WHEN ${mobileCapable} AND ${botAccounts.transport} = 'mobile' THEN 0 ELSE 1 END`,
      // Profile-specific proof outranks tier/LRU: success on posts/followers
      // does not prove that this mobile session can read profiles. Prefer a
      // recent successful profile reader; keep failed/unproven bots eligible
      // as fallbacks and preserve all existing cooldown/cap/lease guards.
      ...(label === "profile" ? [sql`CASE WHEN ${botAccounts.transport} = 'mobile' THEN
        COALESCE((SELECT CASE WHEN recent.outcome = 'success' THEN 0 ELSE 2 END
          FROM scrape_outcome_log recent
          WHERE recent.bot_id = ${botAccounts.id} AND recent.endpoint = 'profile'
            AND recent.occurred_at >= ${new Date(now.getTime() - 6 * 60 * 60_000)}
          ORDER BY recent.occurred_at DESC, recent.id DESC LIMIT 1), 1)
        ELSE 1 END`] : []),
      sql`CASE
        WHEN ${botAccounts.tier} = 'worker' THEN 0
        WHEN ${botAccounts.tier} = 'canary' THEN 1
        ELSE 2
      END`,
      sql`(${botAccounts.sessionData} IS NOT NULL) DESC`,
      // Posts only: prefer a reader whose latest posts result in the last hour
      // succeeded, then unproven/recovered readers, then recent failed readers.
      // This is ordering, NEVER an eligibility exclusion or a global breaker.
      // Existing cooldowns, daily caps, ownership and LRU within each band stay
      // intact; profile success must not erase a posts-specific failure.
      ...(label === "posts" ? [sql`CASE WHEN ${botAccounts.transport} = 'mobile' THEN
        COALESCE((SELECT CASE WHEN recent.outcome = 'success' THEN 0 ELSE 2 END
          FROM scrape_outcome_log recent
          WHERE recent.bot_id = ${botAccounts.id} AND recent.endpoint = 'posts'
            AND recent.occurred_at >= ${new Date(now.getTime() - 60 * 60_000)}
          ORDER BY recent.occurred_at DESC, recent.id DESC LIMIT 1), 1)
        ELSE 1 END`] : []),
      // First touch is never a liker read (2026-09-02): LRU with NULLS FIRST handed
      // every freshly imported session its very first request as a likers call —
      // 55 fresh bots, one read each, 4 checkpointed on that read. A session that
      // has already served something (warm browse, posts, followers) is proven;
      // for likers, unproven bots go to the back of the line instead of the front.
      // (A bare `0` here would be a positional ORDER BY reference and fail the
      // whole lease query for every non-likers endpoint — it did, for 35 min.)
      sql`CASE WHEN ${label === "likers"} AND ${botAccounts.lastUsedAt} IS NULL THEN 1 ELSE 0 END`,
      sql`${botAccounts.lastUsedAt} ASC NULLS FIRST`,
    )
    .limit(1)
    .for("update", { skipLocked: true });
}

async function leaseBot(
  excludedBotIds: ReadonlySet<string> = new Set(),
  label?: ScrapeEndpoint,
  webOnly = false,
): Promise<LeasedBot> {
  const now = new Date();
  // Pick the LRU available bot that isn't in cooldown. We do NOT increment
  // currentFollows here — public scraping doesn't consume a follow slot.
  // FOR UPDATE SKIP LOCKED + an immediate lastUsedAt touch gives us LRU
  // rotation across concurrent scrape calls without a dedicated lease table.
  const leased = await db.transaction(async (tx) => {
    const [row] = await buildLeaseCandidateQuery(tx, {
      label,
      excludedBotIds,
      now,
      viewer: viewerAffinity(),
      webOnly,
    });

    if (!row) return null;

    await tx
      .update(botAccounts)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(botAccounts.id, row.id));

    return row;
  });

  if (!leased) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] no available bot in the pool",
    );
  }

  // Wave 4: ensure the leased bot has a safe proxy + valid session before
  // returning. ensureBotReady handles three cases atomically:
  //   - proxy endpoint missing/stale with a valid session → fail closed
  //   - proxy endpoint missing/stale without a session → allocate before login
  //   - session_data null/decrypt-fail → drive a Playwright login and
  //     persist new cookies (IMAP-driven email-code if IG asks)
  //   - everything healthy → no-op (~1ms)
  // This means the LRU policy can hand out a "session_expired"-equivalent
  // bot and we'll silently bring it back online instead of throwing.
  try {
    const { ensureBotReady } = await import("./services/bot-runtime.js");
    const ready = viewerAffinity()?.savedSessionOnly
      ? await ensureBotReady(leased.id, { allowLogin: false })
      : await ensureBotReady(leased.id);
    return {
      id: leased.id,
      igUsername: leased.igUsername,
      sessionData: ready.sessionData,
      fingerprint: resolveFingerprint(leased),
      proxyEndpoint: ready.proxyEndpoint,
      automationIdentity: ready.automationIdentity,
      transport: ready.transport,
    };
  } catch (err) {
    throw new IGPublicScraperError(
      `[ig-public-scraper] failed to ready bot ${leased.igUsername}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
}

// Wave 8: lease a specific bot by id rather than picking one from the LRU
// pool. Used by the private-account collection path: only the bot whose
// follow request was accepted has authenticated visibility into a private
// account's posts / stories / highlights / engagement, so an LRU lease is
// useless there.
//
// Differences from `leaseBot()`:
//   - Row selection is by FIXED id (the caller already knows the bot id from
//     `bot_follow_requests`), not by LRU preference order.
//   - We still touch `lastUsedAt` so the LRU layer treats this bot as
//     recently active when it next leases.
//   - Watcher roles and in-use viewers remain eligible, but status, cooldown,
//     saved identity/session, and proxy health are mandatory on every read.
//   - `ensureBotReady({ allowLogin: false })` validates the saved session and
//     proxy without logging in or rotating an authenticated account's lane.
//
// B3: locked-row retry. `FOR UPDATE SKIP LOCKED` on a FIXED row id returns
// zero rows whenever that exact row is momentarily locked by a concurrent
// lease (any leaseBot()/leaseSpecificBot() holds the row lock for the few ms
// its lastUsedAt-touch transaction runs). The pool-style leaseBot() simply
// skips to a different bot, but here there is no other bot — so a transient
// lock collision used to surface as a hard "not found or already locked"
// failure and fail the whole private-account collection. We keep SKIP LOCKED
// (consistent with every other lease in this file, and it never parks a
// worker behind a long-held lock) and instead retry the claim with a short
// jittered backoff. Three attempts spread over a few hundred ms comfortably
// outlast the millisecond-scale touch transactions that hold this lock; a
// row that is STILL locked after that points at a stuck transaction, which
// we surface as an explicit "locked" error rather than "not found".
const LEASE_SPECIFIC_MAX_ATTEMPTS = 3;
const LEASE_SPECIFIC_RETRY_BASE_MS = 80;
const LEASE_SPECIFIC_RETRY_JITTER_MS = 70;

function leaseRetryDelay(attempt: number): Promise<void> {
  const ms =
    LEASE_SPECIFIC_RETRY_BASE_MS * attempt +
    Math.random() * LEASE_SPECIFIC_RETRY_JITTER_MS;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PinnedBotHealthSnapshot = Pick<typeof botAccounts.$inferSelect,
  "id" | "status" | "tier" | "cooldownUntil" | "updatedAt" | "lastLoginAt" |
  "lastLoginError" | "sessionData" | "transport" | "automationIdentity" |
  "proxyUrl" | "proxyEndpoint" | "proxyExpiresAt">;

function assertPinnedBotHealthy(row: PinnedBotHealthSnapshot, now: Date, cooldownProbeUntil?: Date): void {
  const authorizedProbe = cooldownProbeUntil !== undefined
    && row.cooldownUntil?.getTime() === cooldownProbeUntil.getTime()
    && cooldownProbeUntil.getTime() > now.getTime()
    && row.updatedAt.getTime() <= now.getTime() - 30 * 60_000
    && row.lastLoginAt !== null;
  if (cooldownProbeUntil && !authorizedProbe) {
    throw new IGPublicScraperError("[ig-public-scraper] cooldown probe observation is stale or too recent");
  }
  let issue: string | null = null;
  if (row.status !== "available" && row.status !== "in_use") issue = "viewer status is unavailable";
  else if (row.tier !== "worker" && row.tier !== "canary") issue = "viewer tier is unavailable";
  else if (!authorizedProbe && row.cooldownUntil && row.cooldownUntil.getTime() > now.getTime()) issue = "viewer is in cooldown";
  else if (!row.lastLoginError?.startsWith(COOLDOWN_REASON_PREFIX)
      && new RegExp(BAN_REASON_SQL_REGEX, "i").test(row.lastLoginError ?? "")) issue = "viewer session requires recovery";
  else if (!row.sessionData) issue = "saved viewer session is unavailable";
  else if (row.transport !== "web" && row.transport !== "mobile") issue = "viewer transport is invalid";
  else if (row.transport === "web" && !parseAutomationIdentity(row.automationIdentity, row.id)) issue = "saved viewer identity is invalid";
  else if (row.proxyUrl) issue = accountProxyDurabilityIssue(row.proxyUrl);
  else if (!row.proxyEndpoint || !row.proxyExpiresAt || row.proxyExpiresAt.getTime() <= now.getTime() + 120_000) issue = "saved viewer proxy is unavailable or expiring";
  // ensureBotReady validates credential-bearing endpoint syntax and decrypts the
  // saved session without allocating a new lane or logging in.
  if (issue) throw new IGPublicScraperError(`[ig-public-scraper] pinned read unavailable: ${issue}`);
}

/** Select locally admissible recovery work without touching any bot or hold.
 * The locked lease repeats the same guard before the one authenticated probe. */
export function selectCooldownProbeCandidate<T extends PinnedBotHealthSnapshot>(
  candidates: readonly T[],
  now = new Date(),
): T | undefined {
  return candidates.find((row) => {
    if (!row.cooldownUntil) return false;
    try {
      assertPinnedBotHealthy(row, now, row.cooldownUntil);
      return true;
    } catch {
      return false;
    }
  });
}

async function leaseSpecificBot(botAccountId: string, cooldownProbeUntil?: Date): Promise<LeasedBot> {
  if (!botAccountId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] leaseSpecificBot requires a bot id",
    );
  }

  let leased: typeof botAccounts.$inferSelect | null = null;
  for (let attempt = 1; attempt <= LEASE_SPECIFIC_MAX_ATTEMPTS; attempt += 1) {
    const now = new Date();
    leased = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(botAccounts)
        .where(eq(botAccounts.id, botAccountId))
        .limit(1)
        .for("update", { skipLocked: true });

      if (!row) return null;
      assertPinnedBotHealthy(row, now, cooldownProbeUntil);

      await tx
        .update(botAccounts)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(botAccounts.id, row.id));

      return row;
    });
    if (leased) break;

    // Zero rows is ambiguous under SKIP LOCKED: the row either doesn't exist
    // or is currently locked. A plain (lock-free) SELECT disambiguates — it
    // sees the row even while another transaction holds its row lock. A
    // genuinely missing bot fails fast with no pointless retries.
    const [exists] = await db
      .select({ id: botAccounts.id })
      .from(botAccounts)
      .where(eq(botAccounts.id, botAccountId))
      .limit(1);
    if (!exists) {
      throw new IGPublicScraperError(
        `[ig-public-scraper] bot ${botAccountId} not found`,
      );
    }

    if (attempt < LEASE_SPECIFIC_MAX_ATTEMPTS) {
      logger.warn(
        { botId: botAccountId, attempt },
        "[ig-public-scraper] specific bot row locked by concurrent lease; retrying",
      );
      await leaseRetryDelay(attempt);
    }
  }

  if (!leased) {
    throw new IGPublicScraperError(
      `[ig-public-scraper] bot ${botAccountId} is locked by a concurrent lease (gave up after ${LEASE_SPECIFIC_MAX_ATTEMPTS} attempts)`,
    );
  }

  try {
    const { ensureBotReady } = await import("./services/bot-runtime.js");
    const ready = await ensureBotReady(leased.id, { allowLogin: false });
    return {
      id: leased.id,
      igUsername: leased.igUsername,
      sessionData: ready.sessionData,
      fingerprint: resolveFingerprint(leased),
      proxyEndpoint: ready.proxyEndpoint,
      automationIdentity: ready.automationIdentity,
      transport: ready.transport,
    };
  } catch (err) {
    throw new IGPublicScraperError(
      `[ig-public-scraper] failed to ready bot ${leased.igUsername}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
}

async function releaseBot(botId: string): Promise<void> {
  try {
    const now = new Date();
    await db
      .update(botAccounts)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(botAccounts.id, botId));
  } catch (err) {
    logger.warn({ botId, err }, "release bot touch failed");
  }
}

function isSuspendedCheckpoint(err: IGHttpError): boolean {
  const body = err.body?.toLowerCase() ?? "";
  return (
    err.status === 400 &&
    (err.igErrorCode === "checkpoint_required" ||
      body.includes("checkpoint_required")) &&
    (body.includes("/accounts/suspended") || body.includes('"lock":true'))
  );
}

async function quarantineSuspendedBot(bot: LeasedBot, err: IGHttpError): Promise<void> {
  const now = new Date();
  logger.warn(
    {
      botId: bot.id,
      botUsername: bot.igUsername,
      status: err.status,
      url: err.url,
    },
    "[ig-public-scraper] quarantining suspended/checkpointed bot",
  );
  await db
    .update(botAccounts)
    .set({
      status: "banned",
      sessionData: null,
      cooldownUntil: null,
      proxyEndpoint: null,
      proxySessionId: null,
      proxyExpiresAt: null,
      lastLoginError: `account suspended/checkpointed on ${err.url ?? "<unknown>"}`,
      updatedAt: now,
    })
    .where(eq(botAccounts.id, bot.id));
}

// ── Hard-failure classification (dead-session escalation) ───────────────────
//
// A HARD failure is Instagram refusing the bot's SESSION (not the request):
// auth-class 401/403, HTTP 400 checkpoint/challenge_required, a login-wall
// HTML body on an authenticated endpoint, or a structural IGAuthExpiredError.
// Every hard failure bumps `consecutive_hard_failures` (migration 0044) and the
// streak escalates the cooldown (bot-cooldown.ts `escalationForStreak`). Rate
// limits, IG's "please wait" 401 throttle, csrf mismatches, useragent
// mismatches and every transport/network fault are NOT hard: they say nothing
// about whether the session is alive, so they never touch the streak.
export type HardFailureKind =
  | "mobile_auth"
  | "checkpoint_required"
  | "challenge_required"
  | "forbidden"
  | "auth_rejected"
  | "login_wall"
  | "structural_auth";

/** Endpoints that only ever answer a logged-in session; HTML here = login wall. */
const LOGIN_WALL_ENDPOINTS: ReadonlySet<string> = new Set([
  "likers",
  "followers",
  "following",
  "friendship_status",
]);

function hasIgErrorCode(err: IGHttpError, code: string): boolean {
  return err.igErrorCode === code || (err.body?.toLowerCase().includes(code) ?? false);
}

function isCsrfMismatch(body: string | undefined): boolean {
  return body?.toLowerCase().includes("csrf token missing") ?? false;
}

/** A 2xx whose body failed JSON parsing (web `[ig-http]` or mobile `[ig-mobile]` client). */
function isNonJsonBody(err: IGHttpError): boolean {
  if (err.status < 200 || err.status >= 300) return false;
  const message = err.message.toLowerCase();
  return message.includes("response not json") || message.includes("non-json body");
}

export function classifyHardFailure(
  err: unknown,
  label: string | null | undefined,
  transport: "web" | "mobile",
): HardFailureKind | null {
  if (err instanceof IGRateLimitedError) return null;
  if (err instanceof IGHttpError && err.status === 0) return null;
  if (isProxyTransportFailure(err)) return null;

  if (err instanceof IGHttpError) {
    // Suspension is a verdict handled by quarantineSuspendedBot, not a streak.
    if (isSuspendedCheckpoint(err)) return null;
    // A generic policy/permission refusal does not prove the mobile session
    // expired. Preserve it for diagnosis instead of incrementing its death streak.
    if (err.authDiagnostics?.reason === "request_rejected" ||
        err.authDiagnostics?.reason === "feedback_required") return null;
    if (err.body?.toLowerCase().includes("useragent mismatch")) return null;
    if (hasIgErrorCode(err, "checkpoint_required")) {
      return "checkpoint_required";
    }
    if (hasIgErrorCode(err, "challenge_required")) {
      return "challenge_required";
    }
    if (err.status === 403) return isCsrfMismatch(err.body) ? null : "forbidden";
    if (label && LOGIN_WALL_ENDPOINTS.has(label) && isNonJsonBody(err)) {
      return "login_wall";
    }
    return null;
  }

  if (err instanceof IGAuthExpiredError) {
    if (isCsrfMismatch(err.body)) return null;
    if (isIgWebThrottleBody(err.body ?? "")) return null;
    if (err.status === 401 || err.status === 403) {
      return transport === "mobile" ? "mobile_auth" : "auth_rejected";
    }
    // No HTTP status: the client refused to send (missing sessionid /
    // csrftoken, unparseable session envelope) — session-wide by definition.
    return "structural_auth";
  }
  return null;
}

function shortErrorMessage(err: unknown, max = 160): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > max ? message.slice(0, max) : message;
}

/**
 * Streak bookkeeping for one hard failure. Never throws: a missing column
 * (migration 0044 not yet applied) or a DB blip must not turn a cooldown
 * write into a scrape failure — the per-branch cooldown already happened.
 */
async function escalateHardFailure(
  bot: LeasedBot,
  kind: HardFailureKind,
  err: unknown,
): Promise<void> {
  try {
    const streak = await recordHardFailure(bot.id);
    const decision = await applyHardFailureEscalation(
      bot.id,
      bot.transport,
      streak,
      `${kind}: ${shortErrorMessage(err)}`,
    );
    logger.warn(
      {
        botId: bot.id,
        botUsername: bot.igUsername,
        transport: bot.transport,
        kind,
        streak,
        escalatedHours: decision.cooldownHours,
        markSessionExpired: decision.markSessionExpired,
      },
      "[ig-public-scraper] hard failure recorded",
    );
  } catch (streakErr) {
    logger.warn(
      { botId: bot.id, kind, err: streakErr },
      "[ig-public-scraper] hard-failure streak write failed (legacy cooldown still applied)",
    );
  }
}

/**
 * Cooldown + streak handling for one failed lease. Returns the hard-failure
 * kind so `runWithLease` can surface a typed error for the login wall.
 */
async function handleBotFailure(
  bot: LeasedBot,
  err: unknown,
  label: ScrapeEndpoint,
): Promise<HardFailureKind | null> {
  if (bot.transport === "web" && err instanceof IGAuthExpiredError &&
      err.status != null && err.status >= 200 && err.status < 300 &&
      err.responseDiagnostics?.responseUrlClass === "login") {
    // A confirmed login redirect rejects this exact session. Both callers
    // hold the bot operation lease; the CAS also protects a session renewed
    // outside that lease. Do not let an old response escalate or cool its
    // replacement after the guarded invalidation loses that race.
    await invalidateObservedBotSession(bot.id, bot.sessionData).catch((invalidateErr) => {
      logger.warn({ botId: bot.id, err: invalidateErr }, "[ig-public-scraper] rejected session could not be parked");
    });
    return "auth_rejected";
  }
  const kind = classifyHardFailure(err, label, bot.transport);
  await applyBotCooldown(bot, err, kind).catch((cooldownErr) => {
    logger.warn(
      { botId: bot.id, err: cooldownErr },
      "[ig-public-scraper] cooldown write failed",
    );
  });
  if (kind !== null) await escalateHardFailure(bot, kind, err);
  return kind;
}

// Wave 4: cooldown policy for the public scraper. Maps the IG-side error
// signal onto a bot_accounts.cooldown_until window:
//   - 400 + checkpoint_required → 24h
//   - 403 (forbidden / banned-this-IP) → 12h
//   - 429 (rate limited) → exact retryAfterMs from the upstream header
// IGAuthExpiredError on 401 is intentionally NOT cooled down here — the
// existing bot-runtime layer invalidates session_data and ensureBotReady()
// drives a fresh login on next lease, which is faster than a cooldown.
async function applyBotCooldown(
  bot: LeasedBot,
  err: unknown,
  hardKind: HardFailureKind | null = null,
): Promise<void> {
  if (err instanceof IGRateLimitedError) {
    await cooldownBotForRateLimit(bot.id, err.retryAfterMs);
    return;
  }
  // Mobile (Bearer IGT:2) sessions cannot be re-logged in. Every other 401/403
  // path below records an "auth rejected"/checkpoint reason that the leaseBot
  // exclusion regex treats as a PERMANENT ban — and with no relogin to clear
  // it, a single transient throttle would bench a mobile bot forever. A 401/403
  // on a mobile session is IG soft-throttling a still-VALID session
  // (login_required / please-wait), so apply a bounded cooldown with a reason
  // that does NOT match the exclusion regex, and never wipe the session. The
  // bot recovers on its own once the cooldown lapses.
  if (
    bot.transport === "mobile" &&
    err instanceof IGAuthExpiredError &&
    (err.status === 401 || err.status === 403)
  ) {
    // Streak 1-2 keeps this flat 30-min window; the escalation step in
    // handleBotFailure lengthens it (6h / 24h → session_expired) once the
    // same session has failed 3+ leases in a row.
    const now = new Date();
    await db
      .update(botAccounts)
      .set({
        cooldownUntil: new Date(now.getTime() + 30 * 60 * 1000),
        lastLoginError: formatCooldownReason(
          `mobile transient throttle (HTTP ${err.status ?? "?"})`,
        ),
        updatedAt: now,
      })
      .where(eq(botAccounts.id, bot.id));
    return;
  }
  if (err instanceof IGHttpError && err.status === 0) {
    // Transport sentinel: the request never reached Instagram. Park the bot
    // 10-15 min so it cannot spin through the same broken lane, and drop the
    // sticky lane ONLY when it has already expired — wiping a still-valid lane
    // left an authenticated session with no lane, which bot-runtime's rotation
    // guard then (correctly) refused to lease at all.
    const now = new Date();
    const holdMs = Math.round((10 + Math.random() * 5) * 60 * 1000);
    logger.warn(
      { botId: bot.id, proxyEndpoint: proxyEndpointLabel(bot.proxyEndpoint), holdMs },
      "[ig-public-scraper] network failure; short cooldown, expired lane dropped",
    );
    await db
      .update(botAccounts)
      .set({
        cooldownUntil: new Date(now.getTime() + holdMs),
        lastLoginError: formatCooldownReason(
          `network failure (status 0): ${shortErrorMessage(err, 120)}`,
        ),
        proxyEndpoint: sql`CASE WHEN ${botAccounts.proxyExpiresAt} < NOW() THEN NULL ELSE ${botAccounts.proxyEndpoint} END`,
        proxySessionId: sql`CASE WHEN ${botAccounts.proxyExpiresAt} < NOW() THEN NULL ELSE ${botAccounts.proxySessionId} END`,
        proxyExpiresAt: sql`CASE WHEN ${botAccounts.proxyExpiresAt} < NOW() THEN NULL ELSE ${botAccounts.proxyExpiresAt} END`,
        updatedAt: now,
      })
      .where(eq(botAccounts.id, bot.id));
    return;
  }
  if (isProxyTransportFailure(err)) {
    const now = new Date();
    logger.warn(
      {
        botId: bot.id,
        proxyEndpoint: proxyEndpointLabel(bot.proxyEndpoint),
        err: err instanceof Error ? err.message : String(err),
      },
      "[ig-public-scraper] invalidating proxy after browser transport failure",
    );
    await db
      .update(botAccounts)
      .set({
        // A dead proxy lane does not recover in 2 minutes. A short cooldown
        // made the bot re-leasable almost immediately, and each re-lease burns
        // a fresh 20-endpoint proxy-probe batch (proxy-provider.fetchHealthyEndpoints)
        // before failing again — pure wasted residential bandwidth. Hold the bot
        // out for 30 minutes so it can't cycle, then let it self-heal: on the
        // next lease ensureBotReady fetches a FRESH proxy endpoint and retries.
        // The last_login_error string below is kept for diagnostics only — it is
        // intentionally NOT matched by the leaseBot exclusion regex, because doing
        // so turned this transient 30-min bench into a permanent pool-wide deadlock.
        // Prefixed like every timed cooldown (lesson 16) so no ban-regex edit can
        // ever turn it into a verdict.
        cooldownUntil: new Date(now.getTime() + 30 * 60 * 1000),
        proxyEndpoint: null,
        proxySessionId: null,
        proxyExpiresAt: null,
        lastLoginError: formatCooldownReason(
          `browser proxy transport failure: ${
            err instanceof Error ? err.message.slice(0, 180) : String(err).slice(0, 180)
          }`,
        ),
        updatedAt: now,
      })
      .where(eq(botAccounts.id, bot.id));
    return;
  }
  if (err instanceof IGHttpError) {
    if (isSuspendedCheckpoint(err)) {
      await quarantineSuspendedBot(bot, err);
      return;
    }
    if (err.authDiagnostics?.reason === "request_rejected" ||
        err.authDiagnostics?.reason === "feedback_required") {
      await cooldownBotForCheckpoint(bot.id,
        `request held for review (HTTP ${err.status}); ${err.authDiagnostics.reason}`, 1);
      return;
    }
    if (err.body?.toLowerCase().includes("useragent mismatch")) {
      const now = new Date();
      await db
        .update(botAccounts)
        .set({
          sessionData: null,
          cooldownUntil: new Date(now.getTime() + 5 * 60 * 1000),
          lastLoginError: formatCooldownReason(
            `useragent mismatch on ${err.url ?? "<unknown>"}; session invalidated`,
          ),
          updatedAt: now,
        })
        .where(eq(botAccounts.id, bot.id));
      return;
    }
    if (
      (err.igErrorCode === "checkpoint_required" ||
        err.body?.toLowerCase().includes("checkpoint_required"))
    ) {
      await cooldownBotForCheckpoint(
        bot.id,
        `checkpoint_required (HTTP ${err.status}) on ${err.url ?? "<unknown>"}`,
        24,
      );
      return;
    }
    // challenge_required (HTTP 400) matched NO branch before: a mobile bot
    // answering it on every call (@tracked_user_6, 0 ok / 120 fail) never
    // got a cooldown. Same class of signal as checkpoint_required — keep the
    // session (the escalation step parks it if the streak proves it dead).
    if (hardKind === "challenge_required") {
      await cooldownBotForCheckpoint(
        bot.id,
        `challenge_required (HTTP ${err.status}) on ${err.url ?? "<unknown>"}`,
        24,
      );
      return;
    }
    // Login wall: 2xx + HTML on an authenticated endpoint. Previously no
    // cooldown at all, so the dead session was re-leased for the rest of the
    // day. 12h, prefixed (timed, not a verdict).
    if (hardKind === "login_wall") {
      await cooldownBotForCheckpoint(
        bot.id,
        `login wall (non-JSON body) on ${err.url ?? "<unknown>"}`,
        12,
      );
      return;
    }
    if (
      err.status === 403 &&
      err.body?.toLowerCase().includes("csrf token missing")
    ) {
      logger.warn(
        {
          botId: bot.id,
          url: err.url ?? null,
        },
        "[ig-public-scraper] csrf mismatch on HTTP transport; not applying long bot cooldown",
      );
      return;
    }
    if (err.status === 403) {
      await cooldownBotForCheckpoint(
        bot.id,
        `forbidden (HTTP 403) on ${err.url ?? "<unknown>"}`,
        12,
      );
      return;
    }
  }
  if (err instanceof IGAuthExpiredError && err.status === 403) {
    if (err.body?.toLowerCase().includes("csrf token missing")) {
      logger.warn(
        { botId: bot.id },
        "[ig-public-scraper] csrf mismatch auth error; not applying long bot cooldown",
      );
      return;
    }
    // 403 surfaces as IGAuthExpiredError in the http client — still a
    // checkpoint-class signal that warrants the 12h cool-down.
    await cooldownBotForCheckpoint(
      bot.id,
      `auth rejected (HTTP 403)${err.body ? `: ${err.body.slice(0, 100)}` : ""}`,
      12,
    );
    return;
  }
  if (err instanceof IGAuthExpiredError && err.status === 401) {
    const body = err.body ?? "";
    const now = new Date();

    // IG throttles a still-VALID logged-in web session by answering 401 with
    //   {"message":"<localized: please wait a few minutes…>",
    //    "require_login":true,"igweb_rollout":true,"status":"fail"}
    // That is a TRANSIENT throttle, not a dead account. Two bugs lived here:
    //   1. The message is localized per bot locale (de/es/fr/hi/ur/…), so the old
    //      English-only `includes("Please wait a few minutes")` check missed most
    //      of them and mis-classified them as permanent auth deaths.
    //   2. It stamped an "auth rejected" string, which the leaseBot exclusion
    //      regex treats as a PERMANENT ban — so the 10-minute cooldown expired
    //      while the bot stayed locked out of the pool FOREVER. That deadlock
    //      (same family as the 'browser proxy transport' poison) took the pool to
    //      0 leasable and stopped all collection.
    // Also: do NOT wipe the session for a throttle. The session is fine — IG is
    // just asking us to slow down. Nulling it forced a full Chromium relogin
    // through an already-throttled proxy on every throttle, which is both
    // expensive and a good way to get the account flagged/banned.
    if (isIgWebThrottleBody(body)) {
      await db
        .update(botAccounts)
        .set({
          cooldownUntil: new Date(now.getTime() + 10 * 60 * 1000),
          lastLoginError: formatCooldownReason(
            `ig web throttle (HTTP 401): ${body.slice(0, 160)}`,
          ),
          updatedAt: now,
        })
        .where(eq(botAccounts.id, bot.id));
      return;
    }

    // Genuine auth rejection: the stored session really is dead. Wipe it so the
    // next lease (auto-login) or the rescue watchdog drives a fresh login.
    await db
      .update(botAccounts)
      .set({
        sessionData: null,
        cooldownUntil: new Date(now.getTime() + 30 * 60 * 1000),
        lastLoginError: `auth rejected (HTTP 401)${body ? `: ${body.slice(0, 160)}` : ""}`,
        updatedAt: now,
      })
      .where(eq(botAccounts.id, bot.id));
  }
}

// Auth-class failures that count toward the per-endpoint 3-strike auto-disable.
// Only IG-side endpoint-ban markers (feedback_required / checkpoint_required in
// the response body) count as a strike. Plain 401/403/auth_expired without
// those markers is bot-side session expiry — not an endpoint ban — so a
// different bot will succeed and we MUST NOT disable the endpoint for 24h.
function isAuthClassFailure(err: unknown): { yes: boolean; reason: string } {
  const body =
    err instanceof IGAuthExpiredError || err instanceof IGHttpError
      ? err.body ?? ""
      : "";
  if (body.includes("feedback_required")) {
    return { yes: true, reason: "feedback_required" };
  }
  if (err instanceof IGHttpError) {
    const code = err.igErrorCode;
    // checkpoint_required is a bot/session health signal, not proof that the
    // whole endpoint family is dead. Counting it here disabled profile/stories
    // pool-wide after three bad bots. Only feedback_required remains an
    // endpoint-level strike.
    if (code === "feedback_required") {
      return { yes: true, reason: code };
    }
  }
  return { yes: false, reason: "" };
}

async function withBot<T>(
  label: ScrapeEndpoint,
  task: (client: IGClientPort, bot: LeasedBot) => Promise<T>,
  excludedBotIds: ReadonlySet<string> = new Set(),
): Promise<T> {
  try {
    return await runWithLease(label, () => leaseBot(excludedBotIds, label), task);
  } catch (err) {
    // A lane fault (proxy CONNECT/TLS garbage, automation-service 502, Firefox
    // navigation error → our status-0 sentinel) says nothing about Instagram or
    // the account; it is the lane. The failed bot is already in its short
    // status-0 cooldown, so ONE more lease lands on a different bot and lane.
    // 2026-09-04: ~150 such faults in 6 h across likers/posts/highlights, all
    // recovering on the next bot. Never retried: auth, rate limit, checkpoint.
    if (!isBrowserLaneFault(err)) throw err;
    logger.warn(
      { label, err: err instanceof Error ? err.message : String(err) },
      "[ig-public-scraper] lane fault; retrying once on another bot",
    );
    return await runWithLease(label, () => leaseBot(excludedBotIds, label), task);
  }
}

async function withBotTransport<T>(
  label: ScrapeEndpoint,
  transport: ScraperReadTransport,
  task: (client: IGClientPort, bot: LeasedBot) => Promise<T>,
): Promise<T> {
  return runWithLease(label, () => leaseBot(new Set(), label), task, transport);
}

// Wave 8: same shape as `withBot` but pinned to a specific bot id. Used by
// the private-account collection path where the LRU pool is irrelevant —
// only this one bot has authenticated visibility into the target account.
async function withSpecificBot<T>(
  label: ScrapeEndpoint,
  botAccountId: string,
  task: (client: IGClientPort, bot: LeasedBot) => Promise<T>,
  options: { preserveSavedTransport?: boolean; readTransport?: ScraperReadTransport; cooldownProbeUntil?: Date } = {},
): Promise<T> {
  return runWithLease(label, async () => {
    const bot = await leaseSpecificBot(botAccountId, options.cooldownProbeUntil);
    // The approved browser account must retain its follow relationship when
    // profile/posts require mobile endpoints. Use THAT account's credential;
    // never fall back to an unrelated mobile reader from the public pool.
    if (!options.preserveSavedTransport && process.env.PINNED_WEB_MOBILE_READS_ENABLED === 'true' && bot.transport === 'web'
        && (label === 'profile' || label === 'posts')) {
      return { ...bot, sessionData: JSON.stringify(pinnedMobileSession(bot.sessionData, bot.id)), transport: 'mobile' as const };
    }
    return bot;
  }, task, options.readTransport);
}

/** Fire-and-forget streak reset; a bookkeeping fault must never fail a scrape. */
function clearHardFailureStreak(bot: LeasedBot): void {
  try {
    void resetHardFailureStreak(bot.id).catch((err) => {
      logger.warn({ botId: bot.id, err }, "[ig-public-scraper] streak reset failed");
    });
  } catch (err) {
    logger.warn({ botId: bot.id, err }, "[ig-public-scraper] streak reset failed");
  }
}

async function closeClientQuietly(client: IGClientPort, botId: string): Promise<void> {
  try {
    await client.close();
  } catch (closeErr) {
    logger.warn({ botId, err: closeErr }, "client close failed during release");
  }
}

async function runWithLease<T>(
  label: ScrapeEndpoint,
  lease: () => Promise<LeasedBot>,
  task: (client: IGClientPort, bot: LeasedBot) => Promise<T>,
  transportOverride?: ScraperReadTransport,
): Promise<T> {
  // Wave 6: per-endpoint 3-strikes auto-disable. Fail FAST before leasing a
  // bot, before consuming the daily budget — if the pool already proved this
  // endpoint is banned, don't even try. This MUST run before the daily-budget
  // reservation: a disabled endpoint should never burn budget either.
  const disabled = await getActiveDisabled(label);
  if (disabled !== null) {
    // Endpoint is switched off (strike-based). We deliberately do not call IG,
    // so this is a skip, not a scrape failure — counting it as failure double-
    // penalised the endpoint and inflated its logged failure rate.
    recordOutcome(label, "skip", null);
    throw new EndpointDisabledError(label, disabled.until, disabled.reason);
  }

  let bot: LeasedBot;
  try {
    bot = await lease();
  } catch (err) {
    recordOutcome(label, "skip", null);
    recordLeaseUnavailable(label, err);
    logger.info({ endpoint: label, reason: err instanceof Error ? err.message : String(err) },
      "[ig-public-scraper] lease unavailable before request; no IG budget consumed");
    throw err;
  }

  try {
    return await withOperationLease(`bot:${bot.id}`, async (signal) => {
      signal.throwIfAborted();
      consumeScrapeAttempt();
      const operation = currentScrapeOperation();
      if (operation) { operation.viewerBotId = bot.id; operation.transport = bot.transport; }

  // Audit D6 (2026-09-03): an OPEN breaker for this (bot, endpoint family) was
  // only discovered inside the task — after the daily-budget unit below had
  // been reserved (80 units burned that way on 2026-09-02; daily-budget has no
  // refund). Check it before building a client or reserving anything. No IG
  // request is made, so it is a skip, and the cause is the same
  // IGCircuitOpenError the task would have thrown: public-data-service rotates
  // to another bot on it and scrape-retry treats it as deterministic.
  const readTransport = viewerAffinity()?.rosterSource === "graphql"
    ? "http" : transportOverride ?? (await getScraperReadTransport()).value;
  const openBreaker = openBreakerForLease(bot, label, Date.now(), readTransport);
  if (openBreaker !== null) {
    logger.info(
      {
        botId: bot.id,
        endpoint: label,
        breakerKey: openBreaker.key,
        openUntil: new Date(openBreaker.openUntil).toISOString(),
      },
      "[ig-public-scraper] breaker OPEN for bot/endpoint; skipping bot without reserving budget",
    );
    await releaseBot(bot.id);
    recordOutcome(label, "skip", bot.id);
    throw new IGPublicScraperError(
      `[ig-public-scraper] circuit breaker OPEN for bot ${bot.igUsername} on ${label}; rotating without reserving budget`,
      new IGCircuitOpenError(openBreaker.openUntil),
    );
  }

  // Build the client FIRST. A client build can fail before any IG call is
  // possible (bad mobile envelope, missing csrftoken, browser launch fault),
  // and reserving budget ahead of it burned a daily-cap unit for a request
  // that never happened — daily-budget has no refund primitive, so order the
  // reservation after the only pre-request step that can throw.
  let client: IGClientPort;
  try {
    client = await createReadClientForTransport(readTransport, bot);
  } catch (err) {
    await handleBotFailure(bot, err, label);
    await releaseBot(bot.id);
    recordOutcome(label, classifyError(err), bot.id);
    throw new IGPublicScraperError(
      `[ig-public-scraper] failed to build IG client for bot ${bot.igUsername}`,
      err,
    );
  }

  // Wave 6: per-bot daily call budget. Reserve a slot for this endpoint
  // before the first request. If the bot has burned its quota for today
  // (age-aware schedule, see server/behavior/daily-budget.ts), bail out —
  // close the client, release the bot, surface a daily-cap error, and let
  // public-data-service rotate to a different bot.
  try {
    await reserveDailyBudgetOrThrow(bot.id, label);
  } catch (err) {
    const isDailyCap =
      err instanceof Error && err.name === "IGDailyCapExceededError";
    if (isDailyCap) {
      // A daily cap is PER-ENDPOINT, so exhausting one must only skip THAT
      // endpoint — never bench the whole bot.
      //
      // This previously benched the bot until tomorrow whenever a positive cap
      // was exhausted. Effect: a bot that spent its likers budget (30 x
      // DAILY_CAP_MULTIPLIER = 60/day) was parked for EVERY endpoint until the
      // 00:02Z reset — including profile/posts/followers, which are UNLIMITED at
      // that account age. Because the whole pool burns likers at roughly the same
      // rate, the entire pool went dark for ~17h/day and the feed stopped updating
      // pool-wide, mid-morning, every day.
      //
      // Releasing without a cooldown is safe: bot_daily_calls still holds the
      // per-endpoint counter, so reserveDailyBudgetOrThrow keeps rejecting THIS
      // endpoint for this bot today (a cheap DB check, no IG call). The bot stays
      // leasable for endpoints that still have budget. This mirrors what the
      // structural cap===0 path already did.
      const cap = (err as { cap?: number }).cap;
      logger.info(
        { botId: bot.id, endpoint: label, cap },
        cap === 0
          ? "[ig-public-scraper] structural cap=0 for endpoint; skip without daily cooldown"
          : "[ig-public-scraper] daily cap exhausted for endpoint; skip without benching bot",
      );
    }
    await closeClientQuietly(client, bot.id);
    await releaseBot(bot.id);
    // A daily-cap exhaustion is a local throttle, not an IG failure: no request
    // was made, so record it as a skip. Any OTHER error from the reservation
    // path (e.g. a DB fault) is a genuine failure and stays counted as one.
    recordOutcome(label, isDailyCap ? "skip" : "failure", bot.id);
    if (err instanceof IGPublicScraperError) throw err;
    throw new IGPublicScraperError(
      err instanceof Error
        ? `[ig-public-scraper] ${err.message}`
        : "[ig-public-scraper] daily budget exhausted",
      err,
    );
  }

  try {
    const result = await task(client, bot);
    if (bot.transport === "web" && client.exportSessionData) {
      try {
        await persistRefreshedWebSession(bot.id, bot.sessionData, client.exportSessionData());
      } catch (refreshError) {
        // Never expose the storage state or a SQL error's bound parameters.
        logger.warn({ botId: bot.id, errorType: refreshError instanceof Error ? refreshError.name : "unknown" },
          "[ig-public-scraper] refreshed session could not be saved");
      }
    }
    const affinity = viewerAffinity();
    if (affinity?.pin && !affinity.botId) affinity.botId = bot.id;
    recordOutcome(label, "success", bot.id);
    // Wave 6: success on this endpoint clears any pending strikes — one good
    // call from any bot proves the pool isn't fully banned yet.
    void recordSuccess(label).catch((strikeErr) => {
      logger.warn(
        { endpoint: label, err: strikeErr },
        "[ig-public-scraper] recordSuccess failed",
      );
    });
    // A successful call proves the session is alive: clear the hard-failure
    // streak (no-op row-wise when it is already 0).
    clearHardFailureStreak(bot);
    return result;
  } catch (err) {
    recordOutcome(label, classifyError(err), bot.id);
    // Wave 6: only auth-class failures (401/403/checkpoint/auth_rejected/CSRF)
    // count toward the per-endpoint 3-strike auto-disable. Transient network
    // glitches and 5xx do NOT — they shouldn't be able to disable the pool.
    const auth = isAuthClassFailure(err);
    if (auth.yes) {
      void recordStrike(label, bot.id, auth.reason).catch((strikeErr) => {
        logger.warn(
          { endpoint: label, botId: bot.id, err: strikeErr },
          "[ig-public-scraper] recordStrike failed",
        );
      });
    }
    // Wave 4: bot cooldown policy. Hard semantic blocks park the bot so the
    // LRU lease layer hands out a different one on the next call. We do this
    // BEFORE wrapping in IGPublicScraperError so the cause is preserved for
    // upstream retry-with-different-bot logic. The hard-failure streak is
    // recorded in the same step (dead-session escalation).
    const hardKind = await handleBotFailure(bot, err, label);
    if (hardKind === "login_wall") {
      throw new IGLoginWallError(
        label,
        err instanceof IGHttpError ? err.url : undefined,
        err,
        bot.id,
      );
    }
    if (err instanceof IGPublicScraperError) throw err;
    throw new IGPublicScraperError(
      err instanceof Error
        ? `[ig-public-scraper] ${err.message}`
        : "[ig-public-scraper] unknown error during scrape",
      err,
    );
  } finally {
    try {
      await client.close();
    } catch (closeErr) {
      logger.warn(
        { botId: bot.id, err: closeErr },
        "client close failed during release",
      );
    }
    await releaseBot(bot.id);
  }
    });
  } catch (err) {
    if (err instanceof OperationBusyError) {
      recordLeaseUnavailable(label, err);
      recordOutcome(label, "skip", bot.id);
      await releaseBot(bot.id);
    }
    throw err;
  }
}

// Mixed transport adapter. Most reads use HTTP. Stories, clips, comments and
// likers intentionally select browser API replay; that is not UI extraction.
// Supported HTTP schema failures can recover through the distinct native UI
// adapter with the same viewer and separately reserved request budget.
async function createHttpFirstReadClient(bot: LeasedBot): Promise<IGClientPort> {
  const http = createHttpBotClientWithFingerprint(
    bot.sessionData,
    bot.fingerprint,
    bot.igUsername,
    bot.proxyEndpoint,
    bot.id,
    bot.automationIdentity,
  );

  let browser: IGClientPort | null = null;
  let browserInit: Promise<IGClientPort> | null = null;
  let lastSuccessfulClient = http;
  let native: IGClientPort | undefined;
  const getNative = () => native ??= createNativeForBot(bot, http.exportSessionData?.() ?? bot.sessionData);
  const getBrowser = async (): Promise<IGClientPort> => {
    if (browser) return browser;
    if (!browserInit) {
      logger.info(
        {
          botId: bot.id,
          proxyEndpoint: proxyEndpointLabel(bot.proxyEndpoint),
        },
        "[ig-public-scraper] opening explicit browser API transport",
      );
      browserInit = createBrowserReadClient({
        sessionData: http.exportSessionData?.() ?? bot.sessionData,
        fingerprint: bot.fingerprint,
        botUsername: bot.igUsername,
        proxyEndpoint: bot.proxyEndpoint,
        botId: bot.id,
        fallbackToHttp: false,
        automationIdentity: bot.automationIdentity,
      }).then((b) => {
        browser = b;
        return b;
      });
    }
    return browserInit;
  };

  // Some IG endpoints only return data in a real browser context even with a
  // valid session (verified in the field), so we DO escalate to the browser on
  // an HTTP failure — including auth/HTTP errors — rather than giving up. To
  // keep that from wasting bandwidth on a genuinely dead session, a one-shot
  // latch records the first browser auth-expiry: once the session is proven
  // dead this cycle, further browser escalations short-circuit instead of
  // relaunching Chromium. (The lazy single-flight browser also means concurrent
  // escalations in one cycle share a single Chromium, not one per endpoint.)
  // Two-tier latch. A browser auth rejection only proves the SESSION is dead
  // when it is structural — missing sessionid/csrftoken cookie, unparseable
  // sessionData — and those throw with NO http status. A 401/403 that carries a
  // status is IG refusing ONE endpoint for this bot's trust tier; the same
  // cookies keep reading profile/feed fine (same tier effect documented on the
  // likers note below).
  //
  // This used to be a single shared `deadErr` for both cases, which made one
  // endpoint's 401 short-circuit every other browser-routed endpoint for the
  // rest of the cycle. Stories is browser-only, so a highlights 401 made
  // stories throw the CACHED highlights error without ever issuing a request —
  // which is why stories failures were logged as "for GET highlights" and why
  // stories scored far worse (43%) than the endpoint actually breaking it
  // (highlights 71%). Same poison-latch family as the browser-transport and
  // throttle deadlocks fixed earlier: a transient, scoped failure escalated
  // into a permanent, global one.
  let sessionDeadErr: unknown = null;
  const deadEndpoints = new Map<string, unknown>();

  async function viaBrowser<T>(
    label: string,
    call: (b: IGClientPort) => Promise<T>,
  ): Promise<T> {
    if (sessionDeadErr) throw sessionDeadErr; // session structurally dead
    const priorEndpointErr = deadEndpoints.get(label);
    if (priorEndpointErr) throw priorEndpointErr; // this endpoint already refused
    try {
      const client = await getBrowser();
      const result = await call(client);
      lastSuccessfulClient = client;
      return result;
    } catch (err) {
      if (err instanceof IGAuthExpiredError) {
        if (typeof err.status === "number") deadEndpoints.set(label, err);
        else sessionDeadErr = err;
      }
      throw err;
    }
  }

  // Browser escalation handles successful but unusable media responses: a
  // schema anomaly, or the verified highlights redirect to ordinary home HTML.
  // The native UI still verifies authentication and the exact target. Everything IG or the transport
  // has already ruled on shares the browser's identity AND proxy lane, so
  // Chromium fails the same way — only slower and ~1 MB heavier:
  //   - IGRateLimitedError (429) / IGAuthExpiredError (401/403),
  //   - IGHttpError with a definitive status (4xx/5xx, or a 2xx login-wall
  //     "response not JSON"),
  //   - IGHttpError status 0 — the proxy/network fault itself. Escalating it
  //     launched Chromium on the very lane that just died: 1,865 launches for
  //     151 stories/highlights outcomes on 2026-09-02,
  //   - IGLoginWallError — the session is already known to be walled.
  function shouldEscalateToBrowser(err: unknown, label: string): boolean {
    if (err instanceof IGRateLimitedError) return false;
    if (err instanceof IGAuthExpiredError) return false;
    if (err instanceof IGLoginWallError) return false;
    if (err instanceof IGHttpError) return (label === 'highlights' || label === 'highlight-reels') && isMediaHomepageRedirect(err);
    return err instanceof IGSchemaError;
  }

  async function httpFirst<T>(
    label: string,
    httpCall: () => Promise<T>,
    browserCall: (b: IGClientPort) => Promise<T>,
  ): Promise<T> {
    try {
      return await viaHttp(httpCall);
    } catch (err) {
      if (!shouldEscalateToBrowser(err, label) || !['profile', 'posts', 'highlights', 'highlight-reels'].includes(label)) throw err;
      const startedAt = Date.now();
      const context = {
        botId: bot.id,
        endpoint: label,
        httpError: shortErrorMessage(err),
        ...(isMediaHomepageRedirect(err) ? {
          reason: 'redirected_home_html', status: err.status, responseUrlClass: 'instagram_home',
          contentType: 'html', titleClass: 'instagram',
        } : {}),
      };
      try {
        consumeScrapeAttempt();
        await reserveDailyBudgetOrThrow(bot.id, label === 'highlight-reels' ? 'highlights' : label);
        const nativeClient = getNative();
        const result = await browserCall(nativeClient);
        lastSuccessfulClient = nativeClient;
        logger.info(
          { ...context, ms: Date.now() - startedAt },
          "[ig-public-scraper] browser fallback recovered a 2xx parse anomaly",
        );
        return result;
      } catch (browserErr) {
        logger.warn(
          {
            ...context,
            browserError: shortErrorMessage(browserErr),
            ms: Date.now() - startedAt,
          },
          "[ig-public-scraper] browser fallback failed too",
        );
        throw browserErr;
      }
    }
  }

  async function viaHttp<T>(call: () => Promise<T>): Promise<T> {
    const result = await call();
    lastSuccessfulClient = http;
    return result;
  }

  return {
    exportSessionData: () => lastSuccessfulClient.exportSessionData?.() ?? '',
    fetchProfile: (username) =>
      httpFirst(
        "profile",
        () => http.fetchProfile(username),
        (b) => b.fetchProfile(username),
      ),
    // Mobile-API profile fallback is HTTP-only — no browser variant. `http` is
    // always the HTTP client built above, which implements fetchProfileById, so
    // assert it is present (the IGClientPort type marks it optional for the
    // browser/playwright transports that do not implement it).
    fetchProfileById: (userId: string) => viaHttp(() => http.fetchProfileById!(userId)),
    fetchFriendshipStatus: (targetPk) => viaHttp(() => http.fetchFriendshipStatus!(targetPk)),
    // Raw authenticated GET passthrough. Without this the object literal simply
    // DROPPED fetchRaw (the underlying http client implements it), so every
    // caller guarding on `typeof client.fetchRaw !== "function"` silently
    // no-oped — which is why getFreshMediaThumbnail() always returned null and
    // expired thumbnails could never be refreshed.
    fetchRaw: (path: string, opts?: { method?: "GET" | "POST"; body?: string }) =>
      viaHttp(() => http.fetchRaw!(path, opts)),
    // The mobile-only posts gate runs before this web adapter. Do not bypass
    // it: web posts became login-walled (operating notes, incident 25).
    fetchUserFeed: (pk, opts) =>
      httpFirst(
        "posts",
        () => http.fetchUserFeed(pk, opts),
        (b) => b.fetchUserFeed(pk, opts),
      ),
    // Reels/clips reliably return data only in a real browser session (HTTP
    // mostly comes back empty/blocked), so route them straight to the browser
    // like stories/highlights — through the same lazy single Chromium + dead-
    // session latch. Adds the one-time page.goto overhead per clips session.
    fetchUserClips: (pk, opts) =>
      viaBrowser("clips", (b) => b.fetchUserClips(pk, opts)),
    fetchUserTagged: (pk, opts) =>
      httpFirst(
        "tagged",
        () => http.fetchUserTagged(pk, opts),
        (b) => b.fetchUserTagged(pk, opts),
      ),
    fetchFollowing: (pk, opts) =>
      httpFirst(
        "following",
        () => http.fetchFollowing(pk, opts),
        (b) => b.fetchFollowing(pk, opts),
      ),
    fetchFollowers: (pk, opts) =>
      httpFirst(
        "followers",
        () => http.fetchFollowers(pk, opts),
        (b) => b.fetchFollowers(pk, opts),
      ),
    sendFollow: (targetPk) => viaHttp(() => http.sendFollow(targetPk)),
    // Stories still need a real browser session (the tray is only rendered for a
    // logged-in web session), so they go straight to the lazy browser.
    fetchStoriesTray: (pk) => viaBrowser("stories", (b) => b.fetchStoriesTray(pk)),
    // Highlights: try the mobile-API highlights_tray over HTTP FIRST, falling
    // back to the browser. The old code forced the browser for BOTH, on the
    // assumption that highlights need a rendered session — but the HTTP client
    // implements /api/v1/highlights/<pk>/highlights_tray/ and it works. Forcing
    // the browser meant highlights inherited the fragile Chromium transport, so
    // every cover URL rotted (all 26 stuck at 403) and covers rendered blank.
    fetchHighlightsTray: (pk) =>
      httpFirst(
        "highlights",
        () => http.fetchHighlightsTray(pk),
        (b) => b.fetchHighlightsTray(pk),
      ),
    fetchHighlightReels: (ids) =>
      httpFirst(
        "highlight-reels",
        () => http.fetchHighlightReels(ids),
        (b) => b.fetchHighlightReels(ids),
      ),
    // Preserve the working browser paths. HTTP parity is viewer/endpoint/
    // target-specific; a successful small-list canary is not permission to
    // switch all sessions, truncated liker lists, or comments globally.
    fetchMediaComments: (mediaId, maxId) =>
      viaBrowser("comments", (b) => b.fetchMediaComments(mediaId, maxId)),
    fetchMediaLikers: (mediaId) =>
      viaBrowser("likers", (b) => b.fetchMediaLikers(mediaId)),
    close: async () => {
      try {
        await http.close();
      } catch {
        /* ignore */
      }
      if (browser) {
        try {
          await browser.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

async function createReadClientForTransport(
  transport: ScraperReadTransport,
  bot: LeasedBot,
): Promise<IGClientPort> {
  // This opt-in was verified with HTTP GraphQL and its OWN returned cursors.
  // Never feed that opaque cursor into a mobile client or browser fallback.
  // A failure defers the saved checkpoint; ordinary/browser-only work is unchanged.
  if (viewerAffinity()?.rosterSource === "graphql") {
    if (bot.transport !== "web") throw new Error("GraphQL roster requires the verified web session transport");
    return createHttpBotClientWithFingerprint(bot.sessionData, bot.fingerprint,
      bot.igUsername, bot.proxyEndpoint, bot.id, bot.automationIdentity);
  }
  // Mobile-transport bots bypass the web/browser transports entirely. Their
  // pre-authenticated Bearer session drives ig-mobile-read-client against
  // i.instagram.com, which implements every read endpoint natively (stories
  // and highlights included — no Chromium escalation). Intercept before the
  // web-path guards (csrftoken / automation_identity), which mobile lacks.
  if (bot.transport === "mobile") {
    const mobileSession = parseMobileEnvelope(bot.sessionData);
    if (!mobileSession) {
      throw new IGPublicScraperError(
        `[ig-public-scraper] bot ${bot.igUsername} is transport=mobile but its session is not a valid mobile envelope`,
      );
    }
    return createMobileReadClient({
      session: mobileSession,
      proxyEndpoint: bot.proxyEndpoint,
      botId: bot.id,
      botUsername: bot.igUsername,
    });
  }

  if (transport === "http-first") {
    return createHttpFirstReadClient(bot);
  }
  if (transport === "browser" || transport === "browser-fallback") {
    logger.info(
      {
        transport,
        botId: bot.id,
        proxyEndpoint: proxyEndpointLabel(bot.proxyEndpoint),
      },
      "[ig-public-scraper] building browser read transport",
    );
    return createBrowserReadClient({
      sessionData: bot.sessionData,
      fingerprint: bot.fingerprint,
      botUsername: bot.igUsername,
      proxyEndpoint: bot.proxyEndpoint,
      botId: bot.id,
      fallbackToHttp: transport === "browser-fallback",
      automationIdentity: bot.automationIdentity,
    });
  }

  const http = createHttpBotClientWithFingerprint(
    bot.sessionData,
    bot.fingerprint,
    bot.igUsername,
    bot.proxyEndpoint,
    bot.id,
    bot.automationIdentity,
  );
  if (process.env.IG_MEDIA_BROWSER_FALLBACK_ENABLED !== "true") return http;
  return withMediaBrowserFallback(http, {
    createBrowser: async () => createNativeForBot(bot, http.exportSessionData?.() ?? bot.sessionData),
    beforeFallback: async endpoint => {
      // The second request consumes its own budget while retaining the same
      // operation lease, viewer, saved session and proxy as the HTTP request.
      consumeScrapeAttempt();
      await reserveDailyBudgetOrThrow(bot.id, endpoint);
    },
    onFallback: (endpoint, status) => logger.info({ botId: bot.id, endpoint, status },
      "[ig-public-scraper] media response unavailable; trying the same viewer native UI once"),
  });
}

function createNativeForBot(bot: LeasedBot, sessionData: string): IGClientPort {
  return createNativeBrowserReadClient({
    viewer: { id: bot.id, transport: bot.transport, sessionData,
      proxyEndpoint: bot.proxyEndpoint, automationIdentity: bot.automationIdentity },
    username: viewerAffinity()?.targetUsername ?? getScrapeContext().username ?? undefined,
    reserveExtra: async (endpoint, count) => {
      for (let i = 0; i < count; i++) await reserveDailyBudgetOrThrow(bot.id, endpoint);
    },
  });
}

// ── Mapping helpers ────────────────────────────────────────────────────────

const HASHTAG_RE = /#([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)/g;

export function extractHashtags(caption: string): ReadonlyArray<string> {
  if (!caption) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const matches = Array.from(caption.matchAll(HASHTAG_RE));
  for (const match of matches) {
    const tag = match[1]?.toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function mapProfile(raw: IGProfile): IGPublicProfile {
  const profilePicUrl = raw.profilePicUrl ?? "";
  return {
    igUserId: raw.pk,
    username: raw.username,
    fullName: raw.fullName ?? "",
    biography: raw.biography ?? "",
    profilePicUrl,
    profilePicUrlHd: profilePicUrl,
    isPrivate: raw.isPrivate,
    isVerified: raw.isVerified,
    ...(raw.viewerRelationshipKnown === true ? {
      viewerRelationshipKnown: true,
      followedByViewer: raw.followedByViewer,
      requestedByViewer: raw.requestedByViewer,
    } : {}),
    isBusinessAccount: false,
    externalUrl: raw.externalUrl ?? null,
    followerCount: raw.followerCount,
    followingCount: raw.followingCount,
    postCount: raw.postCount,
  };
}

function mediaTypeToPostType(
  mediaType: number,
  productType: string | null | undefined,
): IGPostType {
  if (productType === "clips") return "reel";
  switch (mediaType) {
    case 1:
      return "photo";
    case 2:
      return "video";
    case 8:
      return "carousel";
    default:
      return "photo";
  }
}

// Map one parsed IG feed item into an IGPostSummary. Used by scrapeUserPosts
// and scrapeUserPostsPage so both the "from-the-top" and the cursor-paged
// readers build identical rows (including isPinned / carouselMedia). A post is
// pinned to the profile grid iff timeline_pinned_user_ids includes the profile
// owner's numeric igUserId.
function feedItemToPostSummary(
  item: IGFeedItem,
  igUserId: string,
): IGPostSummary {
  const resolvedCaption = item.caption ?? "";
  return {
    shortcode: item.code,
    mediaId: item.id,
    postType: mediaTypeToPostType(item.mediaType, item.productType),
    thumbnailUrl: item.thumbnailUrl ?? "",
    displayUrl: item.displayUrl ?? item.thumbnailUrl ?? "",
    videoUrl: item.videoUrl ?? null,
    caption: resolvedCaption,
    likeCount: item.likeCount,
    commentCount: item.commentCount,
    videoViewCount: item.videoViewCount,
    takenAt: new Date((item.takenAt ?? 0) * 1000),
    locationName: item.locationName,
    hashtags: extractHashtags(resolvedCaption),
    isPinned: item.pinnedUserIds.includes(Number(igUserId)),
    carouselMedia: item.carouselMedia,
  };
}

function reelItemToStory(item: IGReelItem): IGStoryItem {
  const mediaType: IGStoryMediaType = item.mediaType === 2 ? "video" : "photo";
  const mediaUrl =
    mediaType === "video"
      ? item.videoUrl ?? item.imageUrl ?? item.thumbnailUrl ?? ""
      : item.imageUrl ?? item.thumbnailUrl ?? "";
  return {
    storyId: item.id,
    mediaType,
    mediaUrl,
    thumbnailUrl: item.thumbnailUrl ?? mediaUrl,
    takenAt: new Date((item.takenAt ?? 0) * 1000),
    expiresAt: new Date((item.expiringAt ?? 0) * 1000),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function scrapeProfile(username: string): Promise<IGPublicProfile> {
  if (!username || typeof username !== "string") {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeProfile requires a non-empty username",
    );
  }
  logger.debug({ username }, "scrapeProfile");
  return withBot("profile", async (client) => {
    const profile = await client.fetchProfile(username);
    if (!profile.pk || !profile.username || profile.username.toLowerCase() !== username.trim().replace(/^@/, "").toLowerCase()) {
      throw new IGPublicScraperError(
        `[ig-public-scraper] profile response missing or mismatched identity for @${username}`,
      );
    }
    return mapProfile(profile);
  });
}

// Mobile-API profile fallback: fetch a profile by its numeric user id via
// GET /api/v1/users/<id>/info/ (a different rate-limit bucket than
// web_profile_info). HTTP-only — mirrors scrapeProfile's lease + identity
// validation but calls fetchProfileById. Used by public-data-service between
// the HTTP and browser profile legs when the numeric id is already cached.
export async function scrapeProfileById(
  userId: string,
  username: string,
): Promise<IGPublicProfile> {
  if (!userId || typeof userId !== "string") {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeProfileById requires a non-empty userId",
    );
  }
  logger.debug({ userId, username }, "scrapeProfileById");
  return withBot("profile", async (client) => {
    const profile = await client.fetchProfileById!(userId);
    if (!profile.pk || !profile.username || profile.pk !== userId) {
      throw new IGPublicScraperError(
        `[ig-public-scraper] profile-info response missing or mismatched identity for @${username} (id ${userId})`,
      );
    }
    return mapProfile(profile);
  });
}

export async function scrapeProfileViaBrowser(username: string): Promise<IGPublicProfile> {
  if (!username || typeof username !== "string") {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeProfileViaBrowser requires a non-empty username",
    );
  }
  // A browser fallback must use the rendered profile's natural data, rather
  // than replaying the failed API call through a different network stack.
  return scrapeNativePublicProfile(username);
}

/** UI data reads use the normal website queries; this is not an in-page REST replay. */
export async function scrapeNativePublicProfile(username: string, userId?: string): Promise<IGPublicProfile> {
  return runWithLease("profile", () => leaseBot(new Set(), "profile", true), async (_client, bot) =>
    mapProfile(parseProfileInfoResponse(await readNativePublic(bot, "profile", username, userId))), "browser");
}

export async function scrapeNativePublicPosts(username: string, userId: string, limit = 24): Promise<ReadonlyArray<IGPostSummary>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 48) throw new IGPublicScraperError("Native public posts window must be between 1 and 48");
  return runWithLease("posts", () => leaseBot(new Set(), "posts", true), async (_client, bot) => {
    // Reserve the maximum bounded UI pagination before navigation, not after
    // the provider has already served those reads.
    // The website may prefetch one page beyond the requested window.
    for (let page = 1; page < Math.ceil(limit / 12) + 1; page++) await reserveDailyBudgetOrThrow(bot.id, "posts");
    const page = parseFeedResponse(await readNativePublic(bot, "posts", username, userId, limit));
    return page.items.map(item => feedItemToPostSummary(item, userId));
  }, "browser");
}

export async function scrapeNativePublicStories(username: string, userId: string): Promise<ReadonlyArray<IGStoryItem>> {
  return runWithLease("stories", () => leaseBot(new Set(), "stories", true), async (_client, bot) => {
    const reels = parseHighlightReelsResponse(await readNativePublic(bot, "stories", username, userId));
    const reel = reels.find(item => item.id === userId);
    if (!reel) throw new IGPublicScraperError("Native stories response missing requested owner");
    return reel.items.map(reelItemToStory);
  }, "browser");
}

export async function scrapeNativePublicHighlights(username: string, userId: string, withItems: boolean): Promise<ReadonlyArray<IGHighlight>> {
  return runWithLease("highlights", () => leaseBot(new Set(), "highlights", true), async (_client, bot) => {
    // One tray plus at most twelve normal highlight viewer navigations.
    if (withItems) for (let page = 0; page < 12; page++) await reserveDailyBudgetOrThrow(bot.id, "highlights");
    const raw = await readNativePublic(bot, "highlights", username, userId, 24, withItems);
    const tray = parseHighlightsTrayResponse(raw);
    const reels = parseHighlightReelsResponse(raw);
    return tray.items.map(item => {
      const reel = reels.find(reel => reel.id === item.id);
      if (withItems && !reel) throw new IGPublicScraperError("Native highlight response missing requested reel");
      return { highlightId: item.id, title: item.title, coverUrl: item.coverUrl ?? "", mediaCount: reel?.items.length ?? 0,
        mediaCountKnown: withItems, items: reel?.items.map(reelItemToStory) ?? [] };
    });
  }, "browser");
}

/**
 * Re-fetch a single post's fresh media (image_versions2) by its numeric media
 * id via the authenticated /media/{id}/info/ endpoint. Used to refresh
 * liked-post thumbnails whose signed IG URLs have expired. Returns the freshest
 * thumbnail URL, or null when the media is gone or the response has no image.
 */
async function fetchMediaDetailsWithClient(client: IGClientPort, mediaId: string): Promise<IGPostSummary | null> {
  if (typeof client.fetchRaw !== "function") return null;
  const body = await client.fetchRaw(`/api/v1/media/${encodeURIComponent(mediaId)}/info/`);
  const item = parseFeedResponse(body).items[0];
  if (!item?.id || item.id.split("_")[0] !== mediaId.split("_")[0]) return null;
  const rawOwner = (body as { items?: Array<{ user?: { pk?: string | number } }> })?.items?.[0]?.user?.pk;
  const ownerId = rawOwner == null ? item.id.split("_")[1] ?? "" : String(rawOwner);
  return feedItemToPostSummary(item, ownerId);
}

export async function getFreshMediaDetails(mediaId: string): Promise<IGPostSummary | null> {
  if (!mediaId) return null;
  return withBot("posts", (client) => fetchMediaDetailsWithClient(client, mediaId));
}

export async function getFreshMediaDetailsWithBot(botAccountId: string, mediaId: string): Promise<IGPostSummary | null> {
  if (!mediaId) return null;
  return withSpecificBot("posts", botAccountId, (client) => fetchMediaDetailsWithClient(client, mediaId));
}

export async function getFreshMediaThumbnail(
  mediaId: string,
): Promise<string | null> {
  if (!mediaId) return null;
  return withBot("posts", async (client) => {
    if (typeof client.fetchRaw !== "function") return null;
    const body = (await client.fetchRaw(
      `/api/v1/media/${encodeURIComponent(mediaId)}/info/`,
    )) as {
      items?: ReadonlyArray<{
        image_versions2?: { candidates?: ReadonlyArray<{ url?: string }> };
        thumbnail_url?: string;
        carousel_media?: ReadonlyArray<{
          image_versions2?: { candidates?: ReadonlyArray<{ url?: string }> };
        }>;
      }>;
    };
    const item = body?.items?.[0];
    if (!item) return null;
    return (
      item.image_versions2?.candidates?.[0]?.url ??
      item.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ??
      item.thumbnail_url ??
      null
    );
  });
}

/**
 * Re-fetch a single post's playable video URL by its numeric media id via
 * /media/{id}/info/.
 *
 * Needed because the collector only feed-scrapes the newest POSTS_PER_CYCLE
 * (12) posts, so older rows whose video_url was lost (e.g. clobbered by the
 * Tier-1 preview before the enrich-only guard landed) can never be repaired by
 * the normal cycle — nothing re-reads them. Returns null when the media is gone
 * or carries no video (a photo/carousel).
 */
export async function getFreshMediaVideoUrl(
  mediaId: string,
): Promise<string | null> {
  if (!mediaId) return null;
  return withBot("posts", async (client) => {
    if (typeof client.fetchRaw !== "function") return null;
    const body = (await client.fetchRaw(
      `/api/v1/media/${encodeURIComponent(mediaId)}/info/`,
    )) as {
      items?: ReadonlyArray<{
        video_versions?: ReadonlyArray<{ url?: string }>;
      }>;
    };
    const versions = body?.items?.[0]?.video_versions ?? [];
    const best = versions.find((v) => typeof v.url === "string" && v.url);
    return best?.url ?? null;
  });
}

const POSTS_WINDOW_MAX_PAGES = 20;

function postWindowTarget(limit: number, pageSize: number): number {
  const maximum = pageSize * POSTS_WINDOW_MAX_PAGES;
  if (!Number.isFinite(limit) || limit < 1 || limit > maximum) {
    throw new IGPublicScraperError(`Posts window must be between 1 and ${maximum}`);
  }
  return Math.floor(limit);
}

async function readPostWindow(
  bot: LeasedBot,
  label: "posts" | "clips" | "tagged",
  target: number,
  pageSize: number,
  readPage: (opts: { count: number; maxId?: string }) => Promise<IGFeedPage>,
  mapItem: (item: IGFeedItem) => IGPostSummary,
): Promise<ReadonlyArray<IGPostSummary>> {
  const collected: IGPostSummary[] = [];
  const seenItems = new Set<string>();
  const seenCursors = new Set<string>();
  const accountId = getScrapeContext().trackedAccountId;
  let cursor: string | undefined;
  let pages = 0;
  while (collected.length < target) {
    operationSignal()?.throwIfAborted();
    if (accountId && !await trackedAccountHasAccess(accountId)) {
      throw new IGPublicScraperError("Collection access ended during posts pagination");
    }
    operationSignal()?.throwIfAborted();
    if (pages >= POSTS_WINDOW_MAX_PAGES) {
      throw new IGPublicScraperError("Posts page limit reached before the requested window was complete");
    }
    // The lease reserves page one; every additional page consumes its own
    // normal quota before another provider request can start.
    if (pages > 0) await reserveDailyBudgetOrThrow(bot.id, label);
    const page = await readPage({ count: Math.min(pageSize, target - collected.length), maxId: cursor });
    pages += 1;
    const before = collected.length;
    for (const item of page.items) {
      if (collected.length >= target) break;
      if (seenItems.has(item.id)) continue;
      seenItems.add(item.id);
      collected.push(mapItem(item));
    }
    // This API returns a bounded recent-post window, not an assertion that
    // every post was enumerated. A satisfied window needs no continuation.
    if (collected.length >= target || !page.moreAvailable) return collected;
    if (collected.length === before) {
      throw new IGPublicScraperError("Posts pagination did not advance despite more available data");
    }
    if (!page.nextMaxId || seenCursors.has(page.nextMaxId)) {
      throw new IGPublicScraperError("Posts pagination is incomplete or repeats a cursor");
    }
    seenCursors.add(page.nextMaxId);
    cursor = page.nextMaxId;
  }
  return collected;
}

export async function scrapeUserPosts(
  igUserId: string,
  limit = 24,
): Promise<ReadonlyArray<IGPostSummary>> {
  if (!igUserId) throw new IGPublicScraperError("[ig-public-scraper] scrapeUserPosts requires igUserId");
  const target = postWindowTarget(limit, 24);
  logger.debug({ igUserId, limit: target }, "scrapeUserPosts");
  return withBot("posts", (client, bot) => readPostWindow(bot, "posts", target, 24,
    opts => client.fetchUserFeed(igUserId, opts), item => feedItemToPostSummary(item, igUserId)));
}

// Cursor-paged posts reader for "load more older posts". Fetches exactly ONE
// page of feed/user from the supplied maxId cursor and returns the mapped
// posts plus the page's pagination signals. Each call leases a fresh bot via
// withBot("posts", ...) — the same lease policy scrapeUserPosts uses — so the
// route layer can walk older posts one page at a time without holding a bot
// across HTTP requests. Items are mapped exactly like scrapeUserPosts
// (including isPinned / carouselMedia).
export async function scrapeUserPostsPage(
  igUserId: string,
  opts: { maxId?: string; count?: number },
): Promise<{
  posts: IGPostSummary[];
  nextMaxId: string | null;
  moreAvailable: boolean;
}> {
  if (!igUserId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeUserPostsPage requires igUserId",
    );
  }
  // feed/user caps the page size at 24 on the private web API.
  const count = Math.min(24, Math.max(1, Math.floor(opts.count ?? 24)));
  logger.debug(
    { igUserId, maxId: opts.maxId ?? null, count },
    "scrapeUserPostsPage",
  );

  return withBot("posts", async (client) => {
    const page = await client.fetchUserFeed(igUserId, {
      count,
      maxId: opts.maxId,
    });
    const posts = page.items.map((item) =>
      feedItemToPostSummary(item, igUserId),
    );
    return {
      posts,
      nextMaxId: page.nextMaxId,
      moreAvailable: page.moreAvailable,
    };
  });
}

// Wave 4: Reels-tab scraper. The clips endpoint returns the same media items
// as feed/user but limited to product_type=clips. Mapped through the same
// IGPostSummary shape so the persistence layer can keep one writer.
export async function scrapeUserClips(
  igUserId: string,
  limit = 24,
): Promise<ReadonlyArray<IGPostSummary>> {
  if (!igUserId) throw new IGPublicScraperError("[ig-public-scraper] scrapeUserClips requires igUserId");
  const target = postWindowTarget(limit, 12);
  return withBot("clips", (client, bot) => readPostWindow(bot, "clips", target, 12,
    opts => client.fetchUserClips(igUserId, opts), item => ({
      ...feedItemToPostSummary(item, igUserId), postType: "reel", isPinned: false,
      carouselMedia: item.carouselMedia ?? null,
    })));
}

// Tagged-tab windows share the same quota/progress guards while preserving
// their post type and the original carousel metadata.
export async function scrapeUserTagged(
  igUserId: string,
  limit = 24,
): Promise<ReadonlyArray<IGPostSummary>> {
  if (!igUserId) throw new IGPublicScraperError("[ig-public-scraper] scrapeUserTagged requires igUserId");
  const target = postWindowTarget(limit, 24);
  return withBot("tagged", (client, bot) => readPostWindow(bot, "tagged", target, 24,
    opts => client.fetchUserTagged(igUserId, opts), item => ({
      ...feedItemToPostSummary(item, igUserId), postType: "tagged_post", isPinned: false,
      carouselMedia: item.carouselMedia ?? null,
    })));
}

/**
 * A browser-lane transport fault: the Firefox/FastAPI lane failed to reach
 * Instagram (proxy bad gateway, SSL, navigation timeout → 502 → our status-0
 * sentinel) or IG answered with a non-JSON page. These are lane-specific and
 * transient — the same fetch through a different bot's lane usually succeeds
 * (verified live on a "failing" bot on 2026-09-04) — so stories, which are
 * browser-only, get exactly one retry on another bot. Never retried: auth
 * refusals, rate limits, checkpoints (they say something about the account).
 */
export function isBrowserLaneFault(err: unknown): boolean {
  const root = rootCauseOf(err);
  if (root instanceof IGRateLimitedError || root instanceof IGAuthExpiredError) return false;
  if (root instanceof IGHttpError) return root.status === 0;
  const msg = root instanceof Error ? root.message : String(root ?? "");
  return /\b502\b|Bad Gateway|NS_ERROR_PROXY|NS_ERROR_ABORT|SSL_ERROR|Page\.goto|Timeout \d+ms exceeded|network error/i.test(msg);
}

export async function scrapeUserStories(
  igUserId: string,
): Promise<ReadonlyArray<IGStoryItem>> {
  if (!igUserId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeUserStories requires igUserId",
    );
  }
  logger.debug({ igUserId }, "scrapeUserStories");
  return withBot("stories", async (client) => {
      let tray: IGStoriesTray;
      try {
        tray = await client.fetchStoriesTray(igUserId);
      } catch (err) {
        throw new IGPublicScraperError(
          `[ig-public-scraper] fetchStoriesTray failed for ${igUserId}`,
          err,
        );
      }
      return tray.items.map(reelItemToStory);
  });
}

// IG's /feed/reels_media/ endpoint rejects large reel_ids batches with
// 400 "Too many reels requested" — hit by accounts with many highlights
// (e.g. natgeo). Request the reels in small batches and concatenate.
// The browser /feed/reels_media/ endpoint throttles aggressively on reel_ids
// count: all-at-once → 400 "Too many reels requested"; even 20 → HTTP 572.
// 3 is field-verified to succeed (e.g. nadiadzytn: 73 highlights, 2772 items).
const HIGHLIGHT_REELS_BATCH = Math.max(
  1,
  Number(process.env.HIGHLIGHT_REELS_BATCH ?? "3") || 3,
);

async function fetchHighlightReelsChunked(
  client: Pick<IGClientPort, "fetchHighlightReels">,
  highlightIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<IGHighlightReel>> {
  if (highlightIds.length <= HIGHLIGHT_REELS_BATCH) {
    return client.fetchHighlightReels(highlightIds);
  }
  const out: IGHighlightReel[] = [];
  for (let i = 0; i < highlightIds.length; i += HIGHLIGHT_REELS_BATCH) {
    const reels = await client.fetchHighlightReels(
      highlightIds.slice(i, i + HIGHLIGHT_REELS_BATCH),
    );
    out.push(...reels);
  }
  return out;
}

export async function scrapeUserHighlights(
  igUserId: string,
  opts: { withItems?: boolean } = {},
): Promise<ReadonlyArray<IGHighlight>> {
  if (!igUserId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeUserHighlights requires igUserId",
    );
  }
  const withItems = opts.withItems === true;
  logger.debug({ igUserId, withItems }, "scrapeUserHighlights");

  return withBot("highlights", async (client) => {
    let tray: IGHighlightsTray;
    try {
      tray = await client.fetchHighlightsTray(igUserId);
    } catch (err) {
      throw new IGPublicScraperError(
        `[ig-public-scraper] fetchHighlightsTray failed for ${igUserId}`,
        err,
      );
    }

    if (!withItems || tray.items.length === 0) {
      return tray.items.map((t) => ({
        highlightId: t.id,
        title: t.title,
        coverUrl: t.coverUrl ?? "",
        mediaCount: t.mediaCount,
        items: [],
      }));
    }

    let reels: ReadonlyArray<IGHighlightReel>;
    try {
      reels = await fetchHighlightReelsChunked(client, tray.items.map((t) => t.id));
    } catch (err) {
      throw new IGPublicScraperError(
        `[ig-public-scraper] fetchHighlightReels failed for ${igUserId}`,
        err,
      );
    }
    const reelsById = new Map<string, IGHighlightReel>();
    for (const r of reels) reelsById.set(r.id, r);

    return tray.items.map((t) => {
      const reel = reelsById.get(t.id);
      return {
        highlightId: t.id,
        title: t.title,
        coverUrl: t.coverUrl ?? "",
        mediaCount: t.mediaCount,
        items: reel ? reel.items.map(reelItemToStory) : [],
      };
    });
  });
}

async function scrapeFollowPage(
  kind: "followers" | "following",
  igUserId: string,
  cursor?: string,
  excludedBotIds: ReadonlySet<string> = new Set(),
): Promise<IGFollowPage> {
  if (!igUserId) {
    throw new IGPublicScraperError(
      `[ig-public-scraper] scrapeUser${kind === "followers" ? "Followers" : "Following"} requires igUserId`,
    );
  }
  return withBot(kind, async (client, bot) => {
    const pageCursor = cursor ?? (viewerAffinity()?.rosterSource === "graphql" ? "gql:" : undefined);
    const page =
      kind === "followers"
        ? await client.fetchFollowers(igUserId, { count: rosterRequestPageSize(), maxId: pageCursor })
        : await client.fetchFollowing(igUserId, { count: rosterRequestPageSize(), maxId: pageCursor });
    // IG returned its "list withheld from you" empty-state — do NOT return an
    // empty page, which the roster would settle as "follows nobody". Fail the
    // read so a different (higher-trust) bot can retry.
    if (page.restricted && !page.limitedPreview) {
      throw new IGListRestrictedError(kind, igUserId, bot.id);
    }
    const users: IGFollowUser[] = page.users.map((u) => ({
      igUserId: u.pk,
      username: u.username,
      fullName: u.fullName ?? "",
      profilePicUrl: u.profilePicUrl ?? "",
      isPrivate: u.isPrivate,
      isVerified: u.isVerified,
    }));
    return { users, nextCursor: page.nextMaxId, ...(page.limitedPreview ? { sourceLimited: true } : {}) };
  }, excludedBotIds);
}

export function scrapeUserFollowers(
  igUserId: string,
  cursor?: string,
  excludedBotIds?: ReadonlySet<string>,
): Promise<IGFollowPage> {
  return scrapeFollowPage("followers", igUserId, cursor, excludedBotIds);
}

export function scrapeUserFollowing(
  igUserId: string,
  cursor?: string,
  excludedBotIds?: ReadonlySet<string>,
): Promise<IGFollowPage> {
  return scrapeFollowPage("following", igUserId, cursor, excludedBotIds);
}

// ── Wave 5: media comments ─────────────────────────────────────────────────
//
// scrapeMediaComments walks /api/v1/media/<media_id>/comments/ pages until
// either `has_more_comments=false`, the page cap, or the item cap is hit.
// Each page request is made with the same leased bot (one withBot() session)
// so we don't burn a fresh bot lease per page — comments are not as hot a
// target as feed/user, but rotating bots mid-walk would still look unnatural.
//
// Defaults: maxPages=10, maxItems=200. Between pages we jitter sleep
// 1000-3000ms so the request cadence doesn't look mechanical.

const COMMENTS_DEFAULT_MAX_PAGES = 10;
const COMMENTS_DEFAULT_MAX_ITEMS = 200;
const COMMENTS_PAGE_DELAY_MIN_MS = 1000;
const COMMENTS_PAGE_DELAY_MAX_MS = 3000;

export interface ScrapeMediaCommentsOptions {
  readonly maxPages?: number;
  readonly maxItems?: number;
  readonly beforePage?: () => Promise<void>;
}

function commentsJitterDelay(): Promise<void> {
  const span = COMMENTS_PAGE_DELAY_MAX_MS - COMMENTS_PAGE_DELAY_MIN_MS;
  const ms = COMMENTS_PAGE_DELAY_MIN_MS + Math.random() * span;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeMediaComments(
  shortcode: string,
  mediaId: string,
  opts: ScrapeMediaCommentsOptions = {},
): Promise<ReadonlyArray<IGComment>> {
  if (!shortcode) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeMediaComments requires shortcode",
    );
  }
  if (!mediaId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeMediaComments requires mediaId",
    );
  }

  const maxPages = Math.max(
    1,
    Math.floor(opts.maxPages ?? COMMENTS_DEFAULT_MAX_PAGES),
  );
  const maxItems = Math.max(
    1,
    Math.floor(opts.maxItems ?? COMMENTS_DEFAULT_MAX_ITEMS),
  );

  logger.debug(
    { shortcode, mediaId, maxPages, maxItems },
    "scrapeMediaComments",
  );

  return withBot("comments", async (client, bot) => {
    const collected: IGComment[] = [];
    let cursor: string | undefined;
    let pages = 0;

    const seenCursors = new Set<string>();
    while (pages < maxPages && collected.length < maxItems) {
      await opts.beforePage?.();
      if (pages > 0) await reserveDailyBudgetOrThrow(bot.id, 'comments');
      const page = await client.fetchMediaComments(mediaId, cursor);
      pages += 1;
      if (page.hasMore && (!page.nextMaxId || seenCursors.has(page.nextMaxId))) {
        throw new IGPublicScraperError('Comments pagination is incomplete or repeats a cursor');
      }
      if (page.nextMaxId) seenCursors.add(page.nextMaxId);

      for (const c of page.comments) {
        if (collected.length >= maxItems) break;
        collected.push(c);
      }

      if (!page.hasMore || !page.nextMaxId) break;
      if (collected.length >= maxItems) break;
      cursor = page.nextMaxId;

      // Jitter between pages — only if we're going to fetch another page.
      if (pages < maxPages) {
        await commentsJitterDelay();
      }
    }

    return collected;
  });
}

export type { IGComment } from "./domain/ig-client-port.js";

// ── Wave 5: media likers ───────────────────────────────────────────────────
//
// scrapeMediaLikers fetches /api/v1/media/<media_id>/likers/ once. Unlike
// comments, IG provides no pagination cursor on this endpoint and caps the
// returned array at ~100 users. We persist whatever we receive — when a
// post has more than 100 likers we surface the IG-reported total via the
// scraper return type's totalCount field upstream (caller can show "first
// 100 of N likes").
//
// One bot lease, one HTTP/2 call, no jitter loop. Bot rotation across calls
// is handled by the public-data-service runBot wrapper as usual.

export async function scrapeMediaLikers(
  shortcode: string,
  mediaId: string,
): Promise<ReadonlyArray<IGUser>> {
  if (!shortcode) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeMediaLikers requires shortcode",
    );
  }
  if (!mediaId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeMediaLikers requires mediaId",
    );
  }

  logger.debug({ shortcode, mediaId }, "scrapeMediaLikers");

  return withBot("likers", async (client) => {
    const page = await client.fetchMediaLikers(mediaId);
    return page.users;
  });
}

export type { IGUser } from "./domain/ig-client-port.js";

// ── Wave 8: bot-pinned variants for private-account collection ─────────────
//
// When a tracked account is private, only the bot whose follow request was
// accepted has authenticated visibility into its posts/stories/highlights/
// engagement. The default LRU lease (`withBot`) cannot satisfy that — these
// `*WithBot` helpers force the scrape onto a specific bot id resolved from
// `bot_follow_requests`. All other behaviour (cooldown, strikes, daily budget,
// metrics) flows through the shared `runWithLease` path.

/** One controlled recovery probe; ordinary pinned reads always honor cooldown. */
export async function probePinnedBotCooldown(
  botAccountId: string,
  targetPk: string,
  observedCooldownUntil: Date,
): Promise<void> {
  if (!/^\d+$/.test(targetPk) || !Number.isFinite(observedCooldownUntil.getTime())) {
    throw new IGPublicScraperError("Cooldown probe requires a numeric target and observed cooldown");
  }
  await withSpecificBot("posts", botAccountId, async (client) => {
    await client.fetchUserFeed(targetPk, { count: 1 });
  }, { cooldownProbeUntil: observedCooldownUntil });
}

/** Read the exact requester's relationship under its normal lease and quota. */
export async function scrapeFriendshipStatusWithBot(
  botAccountId: string,
  targetPk: string,
  beforeRead?: () => Promise<void>,
): Promise<IGFriendshipStatus> {
  if (!/^\d+$/.test(targetPk)) throw new IGPublicScraperError("Pinned friendship requires a numeric target id");
  return withSpecificBot("profile", botAccountId, async (client) => {
    if (!client.fetchFriendshipStatus) throw new IGPublicScraperError("Saved viewer transport does not support friendship checks");
    await beforeRead?.();
    operationSignal()?.throwIfAborted();
    return client.fetchFriendshipStatus(targetPk);
  }, { preserveSavedTransport: true, readTransport: "http" });
}

export async function scrapeProfileWithBot(
  botAccountId: string,
  username: string,
  igUserId?: string | null,
): Promise<IGPublicProfile> {
  if (!username) throw new IGPublicScraperError("Pinned profile requires a username");
  return withSpecificBot("profile", botAccountId, async (client) => {
    // The numeric endpoint avoids the separately throttled web profile route.
    // An error stays on this viewer; it must never trigger a pool fallback.
    const profile = igUserId && /^\d+$/.test(igUserId) && client.fetchProfileById
      ? await client.fetchProfileById(igUserId)
      : await client.fetchProfile(username);
    if (!profile.pk || !profile.username || (igUserId ? profile.pk !== igUserId : profile.username.toLowerCase() !== username.toLowerCase())) {
      throw new IGPublicScraperError("Pinned profile response has missing or mismatched identity");
    }
    return mapProfile(profile);
  });
}

export async function scrapeUserPostsPageWithBot(
  botAccountId: string,
  igUserId: string,
  opts: { maxId?: string; count?: number },
): Promise<{ posts: IGPostSummary[]; nextMaxId: string | null; moreAvailable: boolean }> {
  if (!igUserId) throw new IGPublicScraperError("Pinned posts page requires igUserId");
  const count = Math.min(24, Math.max(1, Math.floor(opts.count ?? 24)));
  return withSpecificBot("posts", botAccountId, async (client) => {
    const page = await client.fetchUserFeed(igUserId, { count, maxId: opts.maxId });
    return {
      posts: page.items.map((item) => feedItemToPostSummary(item, igUserId)),
      nextMaxId: page.nextMaxId,
      moreAvailable: page.moreAvailable,
    };
  });
}

export async function getFreshMediaThumbnailWithBot(
  botAccountId: string,
  mediaId: string,
): Promise<string | null> {
  if (!mediaId) return null;
  return withSpecificBot("posts", botAccountId, async (client) => {
    if (typeof client.fetchRaw !== "function") return null;
    const body = (await client.fetchRaw(`/api/v1/media/${encodeURIComponent(mediaId)}/info/`)) as {
      items?: ReadonlyArray<{
        image_versions2?: { candidates?: ReadonlyArray<{ url?: string }> };
        thumbnail_url?: string;
        carousel_media?: ReadonlyArray<{
          image_versions2?: { candidates?: ReadonlyArray<{ url?: string }> };
        }>;
      }>;
    };
    const item = body?.items?.[0];
    return item?.image_versions2?.candidates?.[0]?.url
      ?? item?.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url
      ?? item?.thumbnail_url ?? null;
  });
}

export async function scrapeUserPostsWithBot(
  botAccountId: string,
  igUserId: string,
  limit = 24,
): Promise<ReadonlyArray<IGPostSummary>> {
  if (!igUserId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeUserPostsWithBot requires igUserId",
    );
  }
  const target = Math.max(1, Math.floor(limit));
  return withSpecificBot("posts", botAccountId, async (client) => {
    const collected: IGPostSummary[] = [];
    let cursor: string | undefined;
    while (collected.length < target) {
      const remaining = target - collected.length;
      const pageSize = Math.min(24, remaining);
      const page = await client.fetchUserFeed(igUserId, {
        count: pageSize,
        maxId: cursor,
      });
      for (const item of page.items) {
        if (collected.length >= target) break;
        collected.push(feedItemToPostSummary(item, igUserId));
      }
      if (!page.moreAvailable || !page.nextMaxId) break;
      cursor = page.nextMaxId;
    }
    return collected;
  });
}

export async function scrapeUserStoriesWithBot(
  botAccountId: string,
  igUserId: string,
): Promise<ReadonlyArray<IGStoryItem>> {
  if (!igUserId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeUserStoriesWithBot requires igUserId",
    );
  }
  return withSpecificBot("stories", botAccountId, async (client) => {
    let tray: IGStoriesTray;
    try {
      tray = await client.fetchStoriesTray(igUserId);
    } catch (err) {
      throw new IGPublicScraperError(
        `[ig-public-scraper] fetchStoriesTray failed for ${igUserId}`,
        err,
      );
    }
    return tray.items.map(reelItemToStory);
  });
}

export async function scrapeUserHighlightsWithBot(
  botAccountId: string,
  igUserId: string,
  opts: { withItems?: boolean } = {},
): Promise<ReadonlyArray<IGHighlight>> {
  if (!igUserId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeUserHighlightsWithBot requires igUserId",
    );
  }
  const withItems = opts.withItems === true;
  return withSpecificBot("highlights", botAccountId, async (client) => {
    let tray: IGHighlightsTray;
    try {
      tray = await client.fetchHighlightsTray(igUserId);
    } catch (err) {
      throw new IGPublicScraperError(
        `[ig-public-scraper] fetchHighlightsTray failed for ${igUserId}`,
        err,
      );
    }

    if (!withItems || tray.items.length === 0) {
      return tray.items.map((t) => ({
        highlightId: t.id,
        title: t.title,
        coverUrl: t.coverUrl ?? "",
        mediaCount: t.mediaCount,
        items: [],
      }));
    }

    let reels: ReadonlyArray<IGHighlightReel>;
    try {
      reels = await fetchHighlightReelsChunked(client, tray.items.map((t) => t.id));
    } catch (err) {
      throw new IGPublicScraperError(
        `[ig-public-scraper] fetchHighlightReels failed for ${igUserId}`,
        err,
      );
    }
    const reelsById = new Map<string, IGHighlightReel>();
    for (const r of reels) reelsById.set(r.id, r);

    return tray.items.map((t) => {
      const reel = reelsById.get(t.id);
      return {
        highlightId: t.id,
        title: t.title,
        coverUrl: t.coverUrl ?? "",
        mediaCount: t.mediaCount,
        items: reel ? reel.items.map(reelItemToStory) : [],
      };
    });
  });
}

export async function scrapeMediaLikersWithBot(
  botAccountId: string,
  shortcode: string,
  mediaId: string,
): Promise<ReadonlyArray<IGUser>> {
  if (!shortcode) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeMediaLikersWithBot requires shortcode",
    );
  }
  if (!mediaId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeMediaLikersWithBot requires mediaId",
    );
  }
  return withSpecificBot("likers", botAccountId, async (client) => {
    const page = await client.fetchMediaLikers(mediaId);
    return page.users;
  });
}

export async function scrapeMediaCommentsWithBot(
  botAccountId: string,
  shortcode: string,
  mediaId: string,
  opts: ScrapeMediaCommentsOptions = {},
): Promise<ReadonlyArray<IGComment>> {
  if (!shortcode) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeMediaCommentsWithBot requires shortcode",
    );
  }
  if (!mediaId) {
    throw new IGPublicScraperError(
      "[ig-public-scraper] scrapeMediaCommentsWithBot requires mediaId",
    );
  }
  const maxPages = Math.max(
    1,
    Math.floor(opts.maxPages ?? COMMENTS_DEFAULT_MAX_PAGES),
  );
  const maxItems = Math.max(
    1,
    Math.floor(opts.maxItems ?? COMMENTS_DEFAULT_MAX_ITEMS),
  );

  return withSpecificBot("comments", botAccountId, async (client, bot) => {
    const collected: IGComment[] = [];
    let cursor: string | undefined;
    let pages = 0;

    const seenCursors = new Set<string>();
    while (pages < maxPages && collected.length < maxItems) {
      await opts.beforePage?.();
      if (pages > 0) await reserveDailyBudgetOrThrow(bot.id, 'comments');
      const page = await client.fetchMediaComments(mediaId, cursor);
      pages += 1;
      if (page.hasMore && (!page.nextMaxId || seenCursors.has(page.nextMaxId))) {
        throw new IGPublicScraperError('Comments pagination is incomplete or repeats a cursor');
      }
      if (page.nextMaxId) seenCursors.add(page.nextMaxId);

      for (const c of page.comments) {
        if (collected.length >= maxItems) break;
        collected.push(c);
      }

      if (!page.hasMore || !page.nextMaxId) break;
      if (collected.length >= maxItems) break;
      cursor = page.nextMaxId;

      if (pages < maxPages) {
        await commentsJitterDelay();
      }
    }

    return collected;
  });
}

// ── Wave 8.1: bot-pinned followers / following enumeration ─────────────────
//
// Private-account collection needs the followers + following list pulled by
// the same granted bot that's already authorised to see the profile. Unlike
// the LRU `scrapeUserFollowers` / `scrapeUserFollowing` which lease a fresh
// bot per page, these helpers walk every page inside one `withSpecificBot`
// session — same bot, same proxy, same fingerprint for the whole walk. That
// keeps the request cadence indistinguishable from a real user paging
// through a follow list.
//
// Pagination is conservative for private accounts: defaults are 10 pages /
// 1000 items. The whole walk runs under a single leased bot so any error
// propagates out of `withSpecificBot` and is surfaced by the service layer.

const FOLLOW_PAGE_DEFAULT_MAX_PAGES = 10;
const FOLLOW_PAGE_DEFAULT_MAX_ITEMS = 1000;
const FOLLOW_PAGE_DELAY_MIN_MS = 1500;
const FOLLOW_PAGE_DELAY_MAX_MS = 3500;

export interface ScrapeFollowListOptions {
  readonly maxPages?: number;
  readonly maxItems?: number;
  readonly startCursor?: string | null;
  readonly shouldStop?: () => boolean;
  readonly beforePage?: () => Promise<void>;
}

export interface PinnedFollowCapture {
  readonly users: ReadonlyArray<IGFollowUser>;
  readonly complete: boolean;
  readonly stopReason: "exhausted" | "page_cap" | "item_cap" | "shutdown" | "source_limited";
  readonly nextCursor: string | null;
  readonly pagesFetched: number;
  readonly startedFromTop: boolean;
  readonly viewerBotId: string;
}

function followJitterDelay(): Promise<void> {
  const span = FOLLOW_PAGE_DELAY_MAX_MS - FOLLOW_PAGE_DELAY_MIN_MS;
  const ms = FOLLOW_PAGE_DELAY_MIN_MS + Math.random() * span;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapeFollowListWithBot(
  kind: "followers" | "following",
  botAccountId: string,
  igUserId: string,
  opts: ScrapeFollowListOptions = {},
): Promise<PinnedFollowCapture> {
  if (!igUserId) {
    throw new IGPublicScraperError(
      `[ig-public-scraper] scrapeUser${kind === "followers" ? "Followers" : "Following"}WithBot requires igUserId`,
    );
  }
  const maxPages = Math.max(
    1,
    Math.floor(opts.maxPages ?? FOLLOW_PAGE_DEFAULT_MAX_PAGES),
  );
  const maxItems = Math.max(
    1,
    Math.floor(opts.maxItems ?? FOLLOW_PAGE_DEFAULT_MAX_ITEMS),
  );

  return withSpecificBot(kind, botAccountId, async (client, bot) => {
    const collected: IGFollowUser[] = [];
    let cursor: string | undefined = opts.startCursor ?? undefined;
    let pages = 0;
    const seen = new Set<string>();
    const capture = (stopReason: PinnedFollowCapture["stopReason"], nextCursor: string | null): PinnedFollowCapture => ({
      users: collected, complete: stopReason === "exhausted", stopReason, nextCursor,
      pagesFetched: pages, startedFromTop: !opts.startCursor, viewerBotId: bot.id,
    });

    while (pages < maxPages && collected.length < maxItems) {
      if (pages > 0 && opts.shouldStop?.()) return capture("shutdown", cursor ?? null);
      await opts.beforePage?.();
      // B13: per-page daily-budget accounting. The LRU paginator path
      // (public-data-service.paginateFollowList → runBot → withBot) leases a
      // fresh bot per page, so every page reserves one budget unit at lease
      // time. This pinned walk runs ALL pages inside one lease — it used to
      // reserve a single unit for the entire multi-page walk, under-counting
      // the pinned bot's real request volume and undermining the age-tiered
      // caps. Page 1 is covered by the lease-time reservation in
      // runWithLease; every later page reserves its own unit here so both
      // paths burn budget identically (1 page = 1 unit).
      //
      // Mid-walk exhaustion: stop the walk and THROW rather than return the
      // partial list. The service wrapper (public-data-service.runSingleBot)
      // has no channel for the LRU paginator's complete/stopReason
      // truncation signal — an `ok: true` partial would reach the collector
      // with complete=undefined and could feed the unfollow diff as if it
      // were a full roster (the B2 false-mass-unfollow class). Throwing maps
      // a budget stop onto the existing incomplete-capture handling instead:
      // runSingleBot returns `ok: false`, the collector records the error
      // outcome, skips the diff, and does NOT advance last_graph_refresh_at,
      // so the walk is retried once the UTC-day budget resets.
      if (pages > 0) {
        const budget = await checkAndIncrementBudget(bot.id, kind);
        if (!budget.allowed) {
          logger.warn(
            {
              botId: bot.id,
              kind,
              igUserId,
              pagesFetched: pages,
              itemsCollected: collected.length,
              cap: budget.cap,
            },
            "[ig-public-scraper] pinned follow walk stopped mid-walk: daily budget exhausted",
          );
          throw new IGPublicScraperError(
            `[ig-public-scraper] pinned ${kind} walk truncated by daily budget after ${pages} page(s) / ${collected.length} users (cap=${budget.cap})`,
          );
        }
      }

      const page =
        kind === "followers"
          ? await client.fetchFollowers(igUserId, { count: 50, maxId: cursor })
          : await client.fetchFollowing(igUserId, { count: 50, maxId: cursor });

      // IG withheld the list from this bot — fail rather than return a partial /
      // empty walk that would be mistaken for the real roster.
      if (page.restricted && !page.limitedPreview) {
        throw new IGListRestrictedError(kind, igUserId, bot.id);
      }

      let droppedThisPage = false;
      for (const u of page.users) {
        const key = u.username.toLowerCase();
        if (!key || seen.has(key)) continue;
        if (collected.length >= maxItems) { droppedThisPage = true; break; }
        seen.add(key);
        collected.push({
          igUserId: u.pk,
          username: u.username,
          fullName: u.fullName ?? "",
          profilePicUrl: u.profilePicUrl ?? "",
          isPrivate: u.isPrivate,
          isVerified: u.isVerified,
        });
      }

      pages += 1;
      if (page.limitedPreview) return capture("source_limited", null);
      if (!page.nextMaxId && !droppedThisPage) return capture("exhausted", null);
      if (droppedThisPage || collected.length >= maxItems) return capture("item_cap", droppedThisPage ? cursor ?? null : page.nextMaxId ?? null);
      cursor = page.nextMaxId ?? undefined;

      if (pages < maxPages) {
        await followJitterDelay();
      }
    }

    return capture("page_cap", cursor ?? null);
  });
}

export function scrapeUserFollowersWithBot(
  botAccountId: string,
  igUserId: string,
  opts: ScrapeFollowListOptions = {},
): Promise<ReadonlyArray<IGFollowUser>> {
  return scrapeFollowListWithBot("followers", botAccountId, igUserId, opts).then(capture => capture.users);
}

export function scrapeUserFollowingWithBot(
  botAccountId: string,
  igUserId: string,
  opts: ScrapeFollowListOptions = {},
): Promise<ReadonlyArray<IGFollowUser>> {
  return scrapeFollowListWithBot("following", botAccountId, igUserId, opts).then(capture => capture.users);
}

export function scrapeUserFollowersCaptureWithBot(botAccountId: string, igUserId: string, opts: ScrapeFollowListOptions = {}): Promise<PinnedFollowCapture> {
  return scrapeFollowListWithBot("followers", botAccountId, igUserId, opts);
}
export function scrapeUserFollowingCaptureWithBot(botAccountId: string, igUserId: string, opts: ScrapeFollowListOptions = {}): Promise<PinnedFollowCapture> {
  return scrapeFollowListWithBot("following", botAccountId, igUserId, opts);
}
