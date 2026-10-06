import { deleteCustomerAccount, CustomerBillingBusyError, CustomerDeletionBillingError, CustomerAccountMissingError } from "./services/customer-billing-lifecycle.js";
import type { Express, Request, Response } from "express";
import { eq, desc, and, count, sql, ilike, or, inArray } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db } from "./db.js";
import {
  users,
  trackedAccounts,
  subscriptions,
  likeEvents,
  followEvents,
  unfollowEvents,
  notifications,
  collectionJobs,
  botAccounts,
  botFollowRequests,
  profileSnapshots,
} from "../shared/schema.js";
import { isAuthenticated, isAdmin, requireCsrfToken } from "./auth.js";
import { registerAdminTrackedContentRoutes } from "./admin-tracked-content-routes.js";
import { adminContentScope, firstNonemptyString } from "./services/admin-tracked-content.js";
import { validateBotSessionData } from "../shared/validation.js";
import { stripe } from "./stripe.js";
import { getQueues, collectionProfileQueue } from "./workers.js";
import {
  registerAccountRefresh,
  unregisterAccountRefresh,
  reconcileAccountRefreshes,
} from "./workers/account-refresh-registrar.js";
import {
  getBandwidthReport,
  type BandwidthWindow,
} from "./services/bandwidth-meter.js";
import {
  getRefreshInterval,
  setRefreshInterval,
  MIN_REFRESH_SEC,
  MAX_REFRESH_SEC,
} from "./services/refresh-config.js";
import {
  markFollowRequestFailed,
  rotateBotForTrackedAccount,
} from "./bot-manager.js";
import { logger as baseLogger } from "./observability/logger.js";
import { proxyEndpointLabel } from "./services/proxy-provider.js";
import { ensureEncrypted } from "./crypto/session-envelope.js";
import { encryptCredential } from "./crypto/credentials.js";
import { SHORT_LIVED_ACCOUNT_PROXY_SQL_REGEX } from "./services/proxy-durability.js";
import { leasableBotSqlPredicate } from "./ig-public-scraper.js";
import { readCapacityDiagnostics } from "./services/scrape-capacity.js";
import { readCollectionHealth, type CollectionHealth } from "./services/collection-health.js";
import { recoveryStatus, type RecoveryStatus } from "./services/recovery-watchdog.js";
import { ADMIN_ACTIVITY_TYPES, readAdminActivity, type AdminActivityType } from "./services/admin-activity.js";
import { imapHostFor } from "./services/imap-host.js";
import { trackedAccountHasAccess } from "./services/subscription-access.js";
import { checkBotPoolOnce } from "./bot-pool-monitor.js";
import { likedPostAfterJoinedAccountTrackingStart } from "./services/like-event-policy.js";
import {
  countVisibleLikedPostsByAccount,
  dedupeLikedPostsByPostId,
  twinTrackedAccountIds,
  canonicalTwinId,
} from "./services/tracked-account-twins.js";
import { followActivityFilters, countVisibleFollowEvents, countRosterDepartures } from "./services/roster.js";
import {
  getBreakerSnapshot,
  resetBreaker,
} from "./domain/ig-circuit-breaker.js";
import { getParseFailureCount } from "./domain/ig-schemas.js";
import { getSnapshot as getMetricsSnapshot } from "./services/scrape-metrics.js";
import {
  getWarmingStatus,
  warmBot,
} from "./services/bot-warmer.js";
import {
  resetTodayBudget,
  getBudgetStatus,
} from "./behavior/daily-budget.js";
import {
  getDisabledEndpoints,
  manualEnableEndpoint,
} from "./services/endpoint-strikes.js";
import {
  getScraperReadTransport,
  SCRAPER_READ_TRANSPORTS,
  setScraperReadTransport,
} from "./services/scraper-transport-config.js";

/**
 * Platform like totals count a liked POST once per IG USER, not once per
 * tracked row: "twins" (two customers tracking the same account) each hold
 * their own copy of the same like. Keyed on ig_user_id with a username
 * fallback (mirrors tracked-account-twins) and, for LEFT JOINs, the row id.
 * Row-level gates (tracking start) still apply through the join.
 */
const distinctLikedPostCount = sql<number>`count(DISTINCT (
  COALESCE(
    NULLIF(${trackedAccounts.igUserId}, ''),
    'u:' || lower(${trackedAccounts.igUsername}),
    'r:' || ${likeEvents.trackedAccountId}
  ),
  ${likeEvents.postId}
))::int`;

const logger = baseLogger.child({ module: "admin-routes" });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fix #1: parsePagination now accepts `page` (1-based) in addition to `offset` */
function parsePagination(query: Record<string, unknown>): {
  limit: number;
  offset: number;
} {
  const requestedLimit = parseInt(String(query.limit ?? "20"), 10);
  const requestedPage = parseInt(String(query.page ?? "1"), 10);
  const limit = Math.min(
    100,
    Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20),
  );
  const page = Math.max(
    1,
    Number.isFinite(requestedPage) ? requestedPage : 1,
  );
  const rawOffset = query.offset
    ? Math.max(0, parseInt(String(query.offset), 10) || 0)
    : Math.max(0, (page - 1) * limit);
  // Do not silently clamp valid pages. The previous 5,000-row cap made the
  // UI advertise later pages while repeatedly returning page 251, hiding
  // thousands of activity/job rows from admins.
  return { limit, offset: rawOffset };
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

// Reject malformed :id path params before they hit the DB. All record ids in
// this schema are UUIDs (gen_random_uuid). A non-UUID id can never match a row,
// so we fail fast with 400 rather than running a guaranteed-empty query.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: string): boolean {
  return UUID_RE.test(id);
}

/** Fix #17: escape LIKE wildcards to prevent pattern injection */
function escapeLike(s: string): string {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// SECURITY: bot mutation handlers use `.returning()` (the FULL row), which
// includes credential columns (igPasswordEncrypted, emailPasswordEncrypted,
// totpSecret, emailAddress, sessionData) and a proxy URL with embedded
// user:pass. This strips every secret and replaces proxyUrl with a safe label,
// mirroring the explicit projection in GET /api/admin/bots. Use it before
// returning any bot row to the admin UI.
function stripBotSecrets<T extends Record<string, unknown>>(bot: T) {
  const {
    sessionData: _sessionData,
    igPasswordEncrypted: _igPw,
    emailPasswordEncrypted: _emailPw,
    totpSecret: _totp,
    emailAddress: _email,
    proxyUrl: _proxy,
    ...rest
  } = bot;
  return {
    ...rest,
    proxyUrl: proxyEndpointLabel(
      (bot as { proxyUrl?: string | null }).proxyUrl ?? null,
    ),
  };
}

/** Shared by status edits and Disable. Call only after parking the bot so a
 * concurrent assignment cannot give it fresh work while capacity is released. */
async function reconcileStoppedBotFollowRequests(botId: string, status: "disabled" | "banned"): Promise<void> {
  const reasons = ["Bot disabled by admin", "Bot banned by admin"];
  const requests = await db.select({
    id: botFollowRequests.id,
    trackedAccountId: botFollowRequests.trackedAccountId,
    status: botFollowRequests.status,
  }).from(botFollowRequests).where(and(eq(botFollowRequests.botAccountId, botId), or(
    inArray(botFollowRequests.status, ["queued", "pending"]),
    // A repeated save also repairs a prior enqueue failure, without releasing
    // capacity twice or allocating another replacement for an already queued one.
    and(eq(botFollowRequests.status, "failed"), inArray(botFollowRequests.error, reasons)),
  )));
  for (const request of requests) {
    if (request.status !== "failed") await markFollowRequestFailed(request.id, `Bot ${status} by admin`);
  }
  for (const trackedAccountId of new Set(requests.map(request => request.trackedAccountId))) {
    const [target] = await db.select({ isPrivate: trackedAccounts.isPrivate }).from(trackedAccounts)
      .where(eq(trackedAccounts.id, trackedAccountId)).limit(1);
    if (!target?.isPrivate) continue;
    if (!await trackedAccountHasAccess(trackedAccountId)) continue;
    const queued = await db.select({ id: botFollowRequests.id }).from(botFollowRequests)
      .where(and(eq(botFollowRequests.trackedAccountId, trackedAccountId), eq(botFollowRequests.status, "queued")));
    const requestIds = queued.map(request => request.id);
    if (!requestIds.length) {
      // Repeated saves must not allocate another viewer once the replacement
      // is pending or accepted. The bot manager checks this under its target
      // lock, which also covers simultaneous admin recovery requests.
      const replacement = await rotateBotForTrackedAccount(trackedAccountId, { onlyIfNoActive: true });
      if (replacement) requestIds.push(replacement);
    }
    for (const botFollowRequestId of requestIds) {
      await getQueues().botFollowRequestQueue.add("send-follow", { botFollowRequestId }, {
        jobId: `private-backup-${botFollowRequestId}`, delay: 60_000,
      });
    }
  }
}

// ─── Health snapshot helpers (Wave 5) ────────────────────────────────────────

type IntegrationStatus = "live" | "placeholder" | "missing";

function classifyIntegration(
  value: string | undefined,
  placeholderPrefixes: ReadonlyArray<string>,
): IntegrationStatus {
  if (!value || value.trim() === "") return "missing";
  for (const prefix of placeholderPrefixes) {
    if (value.startsWith(prefix)) return "placeholder";
  }
  return "live";
}

function hasConfiguredProxyProvider(): boolean {
  return Boolean(
    (
      process.env.STATIC_PROXY_HOST &&
        process.env.STATIC_PROXY_PORT_START &&
        process.env.STATIC_PROXY_PORT_END &&
        process.env.STATIC_PROXY_USERNAME &&
        process.env.STATIC_PROXY_PASSWORD
    ) || process.env.DATAIMPULSE_PROXY_URL || (
      process.env.PROXY_GATEWAY_HOST && process.env.PROXY_GATEWAY_PORT &&
      process.env.PROXY_GATEWAY_USERNAME && process.env.PROXY_GATEWAY_PASSWORD
    ),
  );
}

interface IntegrationsHealth {
  readonly stripe: IntegrationStatus;
  readonly resend: IntegrationStatus;
  readonly smartproxy: IntegrationStatus;
}

function getIntegrationsHealth(): IntegrationsHealth {
  return {
    stripe: classifyIntegration(process.env.STRIPE_SECRET_KEY, [
      "sk_placeholder",
      "sk_test_placeholder",
    ]),
    resend: classifyIntegration(process.env.RESEND_API_KEY, ["re_placeholder"]),
    smartproxy: hasConfiguredProxyProvider()
      ? "live"
      : classifyIntegration(process.env.SMARTPROXY_API_URL, [
        "http://placeholder",
        "https://placeholder",
      ]),
  };
}

interface BotHealthRow {
  readonly id: string;
  readonly igUsername: string;
  readonly status: string;
  readonly lastLoginAt: string | null;
  readonly lastLoginError: string | null;
  readonly cooldownUntil: string | null;
  readonly loginAttemptCount: number;
  readonly hasSessionData: boolean;
  readonly proxyEndpoint: string | null;
  readonly proxyExpiresAt: string | null;
}

interface QueueDepth {
  readonly name: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly error?: string;
}

interface ProxyHealth {
  readonly lastFetchAt: string | null;
  readonly lastBatchHealthy: string;
  readonly quotaRemaining: string | null;
}

interface HealthSnapshot {
  readonly status: "green" | "yellow" | "red";
  readonly generatedAt: string;
  readonly scraperTransport: Awaited<ReturnType<typeof getScraperReadTransport>>;
  readonly bots: ReadonlyArray<BotHealthRow>;
  readonly endpoints: ReturnType<typeof getMetricsSnapshot>["endpoints"];
  readonly queues: ReadonlyArray<QueueDepth>;
  readonly integrations: IntegrationsHealth;
  readonly proxy: ProxyHealth;
  readonly collection: CollectionHealth;
  readonly recovery: RecoveryStatus;
  readonly summary: {
    readonly totalBots: number;
    readonly availableBots: number;
    readonly warmSessionBots: number;
    readonly rateLimitedBots: number;
    readonly recoverableNoSessionBots: number;
    readonly cooldownBots: number;
    readonly bannedBots: number;
    readonly sessionExpiredBots: number;
    /**
     * Accounts parked out of the pool entirely (status='disabled', typically
     * tier='retired'). Without this bucket the panel's numbers do not add up:
     * 747 of 1035 rows were invisible, so "Total 1035 / Available 86" read like
     * a catastrophic pool failure when most of those rows were a legacy pool
     * deliberately retired on 2026-08-15.
     */
    readonly retiredBots: number;
    readonly visibleBotRows: number;
    readonly activePoolBots: number;
    readonly leaseableBots: number;
    readonly shortLivedProxyBots: number;
    readonly expiredLaneBots: number;
  };
}

function deriveOverallStatus(
  activePool: number,
  leaseable: number,
  rateLimited: number,
  workersDisabled: boolean,
  collection: CollectionHealth,
  recovery: RecoveryStatus,
  queues: ReadonlyArray<QueueDepth>,
): "green" | "yellow" | "red" {
  if (workersDisabled) return "red";
  if (activePool === 0 || leaseable === 0) return "red";
  if (rateLimited >= leaseable) return "red";
  if (leaseable < 3) return "yellow";
  if (leaseable < Math.max(1, Math.floor(activePool / 4))) return "yellow";
  if (queues.some(queue => queue.error)) return "yellow";
  if (collection.verification !== "verified" || collection.incompleteProfiles > 0 ||
      collection.staleFollowerRosters > 0 || collection.staleFollowingRosters > 0 ||
      collection.awaitingApprovalProfiles > 0 || collection.accessDeniedProfiles > 0 ||
      collection.missingProfileBaselines > 0 || collection.blockedPrivateReaders > 0 ||
      collection.providerBlockedProfiles > 0) return "yellow";
  const recoveredAt = recovery.lastSuccessAt ? Date.parse(recovery.lastSuccessAt) : NaN;
  if (recovery.failedSteps.length || !Number.isFinite(recoveredAt) || Date.now() - recoveredAt > 15 * 60_000) return "yellow";
  return "green";
}

const HEALTH_QUEUE_NAMES = [
  "collection-profile",
  "collection-likes",
  "collection-follows",
  "collection-roster",
  "report-generate",
  "email-send",
  "bot-follow-request",
  "bot-follow-check",
  "retention",
  "refresh-sweep",
  "bot-cooldown-probe",
  "bot-pool-rescue",
  "bot-warmer",
] as const;

async function buildHealthSnapshot(): Promise<HealthSnapshot> {
  // Fast aggregations only — no row scans.
  const snapshotNow = new Date();
  const queues = getQueues();
  const queueByName = new Map<string, ReturnType<typeof getQueues>[keyof ReturnType<typeof getQueues>]>(
    Object.values(queues).map((q) => [q.name, q] as const),
  );

  const [botRows, [botSummaryRow], queueDepths, scraperTransport, collection] =
    await Promise.all([
    db
      .select({
        id: botAccounts.id,
        igUsername: botAccounts.igUsername,
        status: botAccounts.status,
        lastLoginAt: botAccounts.lastLoginAt,
        lastLoginError: botAccounts.lastLoginError,
        cooldownUntil: botAccounts.cooldownUntil,
        loginAttemptCount: botAccounts.loginAttemptCount,
        sessionData: botAccounts.sessionData,
        proxyEndpoint: botAccounts.proxyEndpoint,
        proxyExpiresAt: botAccounts.proxyExpiresAt,
      })
      .from(botAccounts)
      .orderBy(desc(botAccounts.updatedAt))
      .limit(200),
    db
      .select({
        totalBots: count(),
        activePoolBots: sql<number>`
          count(*) FILTER (WHERE ${botAccounts.tier} IN ('canary', 'worker'))
        `,
        availableBots: sql<number>`
          count(*) FILTER (
            WHERE ${botAccounts.tier} IN ('canary', 'worker')
              AND ${botAccounts.status} = 'available'
          )
        `,
        warmSessionBots: sql<number>`
          count(*) FILTER (
            WHERE ${leasableBotSqlPredicate({ now: snapshotNow })}
              AND ${botAccounts.sessionData} IS NOT NULL
              AND length(${botAccounts.sessionData}) > 0
          )
        `,
        // The ONE leasable definition (audit D7, 2026-09-03): the bot-level
        // half of leaseBot's WHERE, imported from ig-public-scraper.ts so this
        // number is what the lease actually selects from. The copy that lived
        // here had a hard-coded ban regex missing two verdicts, no `cooldown: `
        // carve-out (lesson 16) and required session_data even with auto-login
        // on — it could disagree with the lease in either direction.
        leaseableBots: sql<number>`
          count(*) FILTER (WHERE ${leasableBotSqlPredicate({ now: snapshotNow })})
        `,
        shortLivedProxyBots: sql<number>`
          count(*) FILTER (
            WHERE ${botAccounts.tier} IN ('canary', 'worker')
              AND ${botAccounts.status} = 'available'
              AND ${botAccounts.proxyUrl} ~* ${SHORT_LIVED_ACCOUNT_PROXY_SQL_REGEX}
          )
        `,
        expiredLaneBots: sql<number>`
          count(*) FILTER (
            WHERE ${botAccounts.tier} IN ('canary', 'worker')
              AND ${botAccounts.status} = 'available'
              AND ${botAccounts.proxyUrl} IS NULL
              AND ${botAccounts.sessionData} IS NOT NULL
              AND (
                ${botAccounts.proxyEndpoint} IS NULL
                OR ${botAccounts.proxyExpiresAt} IS NULL
                OR ${botAccounts.proxyExpiresAt} <= NOW() + INTERVAL '2 minutes'
              )
          )
        `,
        rateLimitedBots: sql<number>`
          count(*) FILTER (
            WHERE ${botAccounts.tier} IN ('canary', 'worker')
              AND ${botAccounts.status} = 'available'
              AND ${botAccounts.cooldownUntil} > NOW()
              AND COALESCE(${botAccounts.lastLoginError}, '') ~*
              'rate limit|please wait a few minutes|ig web throttle'
          )
        `,
        recoverableNoSessionBots: sql<number>`
          count(*) FILTER (
            WHERE ${botAccounts.tier} IN ('canary', 'worker')
              AND ${botAccounts.status} = 'available'
              AND (
                ${botAccounts.sessionData} IS NULL
                OR length(${botAccounts.sessionData}) = 0
              )
          )
        `,
        cooldownBots: sql<number>`
          count(*) FILTER (
            WHERE ${botAccounts.tier} IN ('canary', 'worker')
              AND (${botAccounts.status} = 'cooldown' OR ${botAccounts.cooldownUntil} > NOW())
          )
        `,
        bannedBots: sql<number>`
          count(*) FILTER (WHERE ${botAccounts.status} = 'banned')
        `,
        sessionExpiredBots: sql<number>`
          count(*) FILTER (WHERE ${botAccounts.status} = 'session_expired')
        `,
        retiredBots: sql<number>`
          count(*) FILTER (WHERE ${botAccounts.status} = 'disabled')
        `,
      })
      .from(botAccounts),
    Promise.all(
      HEALTH_QUEUE_NAMES.map(async (name): Promise<QueueDepth> => {
        const queue = queueByName.get(name);
        if (!queue) {
          return { name, waiting: 0, active: 0, delayed: 0, failed: 0, error: "Queue not registered" };
        }
        try {
          const counts = await queue.getJobCounts(
            "waiting",
            "active",
            "delayed",
            "failed",
          );
          return {
            name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          };
        } catch (err) {
          logger.warn({ queue: name, err }, "queue depth read failed");
          return { name, waiting: 0, active: 0, delayed: 0, failed: 0, error: "Queue state unavailable" };
        }
      }),
    ),
    getScraperReadTransport(),
    readCollectionHealth(),
  ]);

  const bots: BotHealthRow[] = botRows.map((b) => ({
    id: b.id,
    igUsername: b.igUsername,
    status: b.status,
    lastLoginAt: b.lastLoginAt ? b.lastLoginAt.toISOString() : null,
    lastLoginError: b.lastLoginError,
    cooldownUntil: b.cooldownUntil ? b.cooldownUntil.toISOString() : null,
    loginAttemptCount: b.loginAttemptCount,
    hasSessionData: typeof b.sessionData === "string" && b.sessionData.length > 0,
    proxyEndpoint: proxyEndpointLabel(b.proxyEndpoint),
    proxyExpiresAt: b.proxyExpiresAt ? b.proxyExpiresAt.toISOString() : null,
  }));

  const totalBots = Number(botSummaryRow?.totalBots ?? 0);
  const availableBots = Number(botSummaryRow?.availableBots ?? 0);
  const activePoolBots = Number(botSummaryRow?.activePoolBots ?? 0);
  const warmSessionBots = Number(botSummaryRow?.warmSessionBots ?? 0);
  const leaseableBots = Number(botSummaryRow?.leaseableBots ?? 0);
  const shortLivedProxyBots = Number(botSummaryRow?.shortLivedProxyBots ?? 0);
  const expiredLaneBots = Number(botSummaryRow?.expiredLaneBots ?? 0);
  const rateLimitedBots = Number(botSummaryRow?.rateLimitedBots ?? 0);
  const recoverableNoSessionBots = Number(
    botSummaryRow?.recoverableNoSessionBots ?? 0,
  );
  const cooldownBots = Number(botSummaryRow?.cooldownBots ?? 0);
  const bannedBots = Number(botSummaryRow?.bannedBots ?? 0);
  const sessionExpiredBots = Number(botSummaryRow?.sessionExpiredBots ?? 0);
  const retiredBots = Number(botSummaryRow?.retiredBots ?? 0);

  const metricsSnapshot = getMetricsSnapshot();

  // Smartproxy quota: provider has no quota API exposed to us.
  // TODO: when Smartproxy publishes a balance/quota endpoint, replace the null
  // below with a real fetch + cache. For now we intentionally surface "unknown"
  // rather than fabricating a number.
  const proxy: ProxyHealth = {
    lastFetchAt: null,
    lastBatchHealthy: "unknown",
    quotaRemaining: null,
  };

  const recovery = recoveryStatus();
  return {
    status: deriveOverallStatus(
      activePoolBots,
      leaseableBots,
      rateLimitedBots,
      process.env.WORKERS_DISABLED === "1",
      collection,
      recovery,
      queueDepths,
    ),
    generatedAt: new Date().toISOString(),
    scraperTransport,
    bots,
    endpoints: metricsSnapshot.endpoints,
    queues: queueDepths,
    integrations: getIntegrationsHealth(),
    proxy,
    collection,
    recovery,
    summary: {
      totalBots,
      availableBots,
      warmSessionBots,
      rateLimitedBots,
      recoverableNoSessionBots,
      cooldownBots,
      bannedBots,
      sessionExpiredBots,
      retiredBots,
      visibleBotRows: bots.length,
      activePoolBots,
      leaseableBots,
      shortLivedProxyBots,
      expiredLaneBots,
    },
  };
}

// ─── Allowed enum values (for validation) ────────────────────────────────────

const ALLOWED_BOT_STATUSES = [
  "available",
  "in_use",
  "cooldown",
  "disabled",
  "banned",
  "session_expired",
];
const ALLOWED_ACCESS_STATUSES = ["public", "pending_access", "has_access", "access_denied"];
const ALLOWED_SUBSCRIPTION_FILTERS = [
  "all",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "no_subscription",
] as const;
const ALLOWED_FOLLOW_REQUEST_STATUSES = [
  "queued",
  "pending",
  "accepted",
  "rejected",
  "expired",
  "failed",
] as const;
type FollowRequestStatus = (typeof ALLOWED_FOLLOW_REQUEST_STATUSES)[number];
// Literal union mirroring accessStatusEnum in shared/schema.ts; lets the
// allowlist-checked `access` filter narrow without an `as any` cast.
type AccessStatus = "public" | "pending_access" | "has_access" | "access_denied";
// Sourced from shared/schema.ts: jobStatusEnum / jobTypeEnum on collectionJobs.
// `as const` so the literal unions can narrow the drizzle filter without `as any`.
const ALLOWED_JOB_STATUSES = ["pending", "running", "completed", "failed"] as const;
const ALLOWED_JOB_TYPES = ["profile", "likes", "follows", "report"] as const;
type JobStatus = (typeof ALLOWED_JOB_STATUSES)[number];
type JobType = (typeof ALLOWED_JOB_TYPES)[number];
const scraperTransportBodySchema = z.object({
  transport: z.enum(SCRAPER_READ_TRANSPORTS),
});

// ─── Fix #18: Rate limiting for admin routes ─────────────────────────────────

const adminRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: { message: "Too many admin requests, please try again in a minute" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Wave 2: stricter limiter for PATCH /api/admin/bots/:id/session. Session
// re-auth uploads are security-sensitive; 10/hour per admin IP makes abuse
// expensive while comfortably covering legitimate operational use.
const botSessionReauthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { message: "Too many session re-auth attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for the two heaviest admin operations: POST
// /api/admin/system/heal (bulk cooldown clear + breaker reset) and POST
// /api/admin/bots/seed (bulk encrypt + upsert + pool re-check). 5/15min per
// admin IP keeps these expensive paths from being hammered while comfortably
// covering legitimate operational use.
const expensiveOpsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many requests for this operation, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Body shape for the session re-auth endpoint. The detailed cookie-array
// validation lives in validateBotSessionData; Zod here just confirms the
// top-level property exists.
const reauthSessionBodySchema = z.object({
  sessionData: z
    .string({ required_error: "sessionData is required" })
    .min(1, "sessionData is required"),
});

// ─── Wave 5 task B: bot seed schema ──────────────────────────────────────────
// Body for POST /api/admin/bots/seed. Mirrors the JSON fixture format used
// by server/scripts/seed-bots.ts so admins can copy/paste from the same
// source-of-truth document. Each bot row carries IG creds + an email mailbox
// the worker can poll for IG verification codes.
const seedBotSchema = z.object({
  ig_username: z
    .string({ required_error: "ig_username is required" })
    .trim()
    .min(1, "ig_username is required")
    .max(254, "ig_username must be 254 characters or less")
    .toLowerCase(),
  ig_password: z
    .string({ required_error: "ig_password is required" })
    .min(1, "ig_password is required"),
  email: z
    .string({ required_error: "email is required" })
    .trim()
    .toLowerCase()
    .email("email must be a valid address"),
  email_password: z
    .string()
    .optional()
    .nullable(),
  totp_secret: z
    .string()
    .trim()
    .optional()
    .nullable(),
});

const seedBotsBodySchema = z.object({
  bots: z
    .array(seedBotSchema)
    .min(1, "bots must contain at least one entry")
    .max(50, "bots may not contain more than 50 entries per call"),
});

type SeedBotInput = z.infer<typeof seedBotSchema>;

// ─── Twin-aware tracked-account reads ────────────────────────────────────────
//
// `like_events` is keyed by tracked_account_id, but liked-post evidence is a
// property of the INSTAGRAM USER. Two customers tracking the same account each
// run their own like-evidence scan and end up holding different subsets of the
// same person's likes. Admin views always show the UNION of those "twins", with
// no `likedPostAfterTrackingStart` gate — support needs the whole picture, not
// one customer's forward-only slice.

/** Distinct liked posts across a twin set (posts, not rows). */
async function twinLikedPostTotal(twinIds: readonly string[]): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(distinct ${likeEvents.postId})` })
    .from(likeEvents)
    .where(inArray(likeEvents.trackedAccountId, [...twinIds]));
  return Number(row?.value ?? 0);
}

/** Same canonical roster and evidence gates as the customer's tracked row. */
async function visibleAccountFollowTotals(
  account: { id: string; trackingStarted: Date },
  end = new Date(),
): Promise<{ followCount: number; unfollowCount: number }> {
  const [rosterAccountId, filters] = await Promise.all([
    canonicalTwinId(account.id),
    followActivityFilters(account.id),
  ]);
  const start = filters.boundary && filters.boundary > account.trackingStarted
    ? filters.boundary : account.trackingStarted;
  const [followCount, unfollowCount] = await Promise.all([
    countVisibleFollowEvents({ trackedAccountId: account.id, rosterAccountId, boundary: filters.boundary }, start, end),
    countRosterDepartures({ rosterAccountId, unfollowsTrusted: filters.unfollowsTrusted && filters.boundary !== null, start, end }),
  ]);
  return { followCount, unfollowCount };
}

/**
 * One page of the deduped liked-post union.
 *
 * A post can appear once per twin, so the fetch pool scales with the twin count
 * — otherwise the dedupe would eat rows the page still needed and pagination
 * would return short pages. Ordering mirrors the customer-facing gallery:
 * newest POST first, undated legacy rows last.
 */
async function twinLikedPostsPage(
  twinIds: readonly string[],
  limit: number,
  offset: number,
) {
  const rows = await db
    .select()
    .from(likeEvents)
    .where(inArray(likeEvents.trackedAccountId, [...twinIds]))
    .orderBy(
      sql`${likeEvents.postTakenAt} DESC NULLS LAST`,
      desc(likeEvents.detectedAt),
    )
    .limit((offset + limit) * Math.max(1, twinIds.length));
  return dedupeLikedPostsByPostId(rows).slice(offset, offset + limit);
}

// ─── Admin route registration ─────────────────────────────────────────────────

export function registerAdminRoutes(app: Express): void {
  app.get("/api/admin/scrape-capacity", isAuthenticated, isAdmin, async (_req, res, next) => {
    try { res.json({ window: "24h", failuresBeforeRequest: await readCapacityDiagnostics() }); }
    catch (err) { next(err); }
  });

  // Apply rate limiter to all /api/admin routes
  app.use("/api/admin", adminRateLimiter);

  // Fix #15: admin mutation routes require a double-submit CSRF token
  // in addition to the global X-Requested-With / Origin check in index.ts.
  // GETs skip this automatically via requireCsrfToken's safeMethods branch.
  app.use("/api/admin", requireCsrfToken);

  // ── Wave 2 task C: IG circuit breaker diagnostics ──────────────────────
  app.get(
    "/api/admin/ig-breaker",
    isAuthenticated,
    isAdmin,
    (_req: Request, res: Response) => {
      const snapshot = getBreakerSnapshot();
      res.json({
        ...snapshot,
        parseFailures: getParseFailureCount(),
      });
    },
  );

  app.post(
    "/api/admin/ig-breaker/reset",
    isAuthenticated,
    isAdmin,
    (_req: Request, res: Response) => {
      resetBreaker();
      res.json({ message: "breaker reset", ...getBreakerSnapshot() });
    },
  );

  // ── Wave 5: GET /api/admin/health — production observability ────────────
  app.get(
    "/api/admin/health",
    isAuthenticated,
    isAdmin,
    async (_req: Request, res: Response) => {
      try {
        const snapshot = await buildHealthSnapshot();
        res.set("Cache-Control", "private, no-store");
        res.json(snapshot);
      } catch (err) {
        logger.error({ route: "GET /api/admin/health", err }, "error");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  app.get(
    "/api/admin/scraper-transport",
    isAuthenticated,
    isAdmin,
    async (_req: Request, res: Response) => {
      try {
        const current = await getScraperReadTransport({ forceRefresh: true });
        res.json({
          current,
          options: SCRAPER_READ_TRANSPORTS.map((value) => ({
            value,
            label:
              value === "http"
                ? "HTTP"
                : value === "browser"
                  ? "Browser"
                  : "Browser fallback",
          })),
        });
      } catch (err) {
        logger.error(
          { route: "GET /api/admin/scraper-transport", err },
          "error",
        );
        res.status(500).json({ message: "Failed to load scraper transport" });
      }
    },
  );

  app.put(
    "/api/admin/scraper-transport",
    isAuthenticated,
    isAdmin,
    async (req: Request, res: Response) => {
      try {
        const parsed = scraperTransportBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            message: "Invalid scraper transport",
            errors: parsed.error.flatten(),
          });
        }
        const updatedBy = (req.user as { id?: string } | undefined)?.id ?? null;
        const current = await setScraperReadTransport(
          parsed.data.transport,
          updatedBy,
        );
        res.json({ current });
      } catch (err) {
        logger.error(
          { route: "PUT /api/admin/scraper-transport", err },
          "error",
        );
        res.status(500).json({ message: "Failed to update scraper transport" });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BANDWIDTH ATTRIBUTION
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/admin/bandwidth?window=1h|24h|7d|30d
  // Returns scrape bandwidth broken down by profile, by user, and by endpoint
  // for the requested rolling window.
  app.get(
    "/api/admin/bandwidth",
    isAuthenticated,
    isAdmin,
    async (req: Request, res: Response) => {
      try {
        const allowed: BandwidthWindow[] = ["1h", "24h", "7d", "30d"];
        const raw = String(req.query.window ?? "24h");
        const window = (allowed as string[]).includes(raw)
          ? (raw as BandwidthWindow)
          : "24h";
        const report = await getBandwidthReport(window);
        res.json(report);
      } catch (err) {
        logger.error({ route: "GET /api/admin/bandwidth", err }, "error");
        res.status(500).json({ message: "Failed to load bandwidth report" });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // REFRESH CADENCE CONTROL
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/admin/refresh-interval — current scraping refresh cadence.
  app.get(
    "/api/admin/refresh-interval",
    isAuthenticated,
    isAdmin,
    async (_req: Request, res: Response) => {
      try {
        const current = await getRefreshInterval();
        res.json({ current });
      } catch (err) {
        logger.error({ route: "GET /api/admin/refresh-interval", err }, "error");
        res.status(500).json({ message: "Failed to load refresh interval" });
      }
    },
  );

  // PUT /api/admin/refresh-interval — set cadence and re-register every active
  // per-account scheduler with the new `every`. Body: { intervalSec: number }.
  const refreshIntervalBodySchema = z.object({
    intervalSec: z.number().int().min(MIN_REFRESH_SEC).max(MAX_REFRESH_SEC),
  });

  app.put(
    "/api/admin/refresh-interval",
    isAuthenticated,
    isAdmin,
    requireCsrfToken,
    async (req: Request, res: Response) => {
      try {
        const parsed = refreshIntervalBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            message: `intervalSec must be between ${MIN_REFRESH_SEC} and ${MAX_REFRESH_SEC} seconds`,
            errors: parsed.error.flatten(),
          });
        }
        const updatedBy = (req.user as { id?: string } | undefined)?.id ?? null;
        const current = await setRefreshInterval(
          parsed.data.intervalSec,
          updatedBy,
        );
        // Apply the new cadence to all active per-account schedulers now.
        const reconcile = await reconcileAccountRefreshes(
          collectionProfileQueue,
        ).catch((err) => {
          logger.error(
            { route: "PUT /api/admin/refresh-interval", err },
            "reconcile after interval change failed",
          );
          return null;
        });
        res.json({
          current,
          applied: reconcile
            ? { rescheduled: reconcile.active, added: reconcile.added }
            : null,
        });
      } catch (err) {
        logger.error({ route: "PUT /api/admin/refresh-interval", err }, "error");
        res.status(500).json({ message: "Failed to update refresh interval" });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BOT MANAGEMENT ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/admin/bots — Fix #8: add pagination
  app.get("/api/admin/bots", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const { limit, offset } = parsePagination(req.query);
      const search = String(req.query.search ?? "").trim();
      const status = String(req.query.status ?? "all");
      if (status !== "all" && !ALLOWED_BOT_STATUSES.includes(status)) {
        res.status(400).json({ message: "Invalid bot status" });
        return;
      }
      const conditions: any[] = [];
      if (search) {
        const escaped = escapeLike(search);
        conditions.push(
          or(
            ilike(botAccounts.igUsername, `%${escaped}%`),
            ilike(botAccounts.displayName, `%${escaped}%`),
          ),
        );
      }
      if (status !== "all") {
        conditions.push(
          eq(
            botAccounts.status,
            status as
              | "available"
              | "in_use"
              | "cooldown"
              | "disabled"
              | "banned"
              | "session_expired",
          ),
        );
      }
      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      let countQuery = db.select({ count: count() }).from(botAccounts);
      if (whereClause) {
        countQuery = countQuery.where(whereClause) as typeof countQuery;
      }
      const [totalResult] = await countQuery;

      let botQuery = db
        .select({
          id: botAccounts.id,
          igUsername: botAccounts.igUsername,
          igUserId: botAccounts.igUserId,
          displayName: botAccounts.displayName,
          proxyUrl: botAccounts.proxyUrl,
          status: botAccounts.status,
          maxFollows: botAccounts.maxFollows,
          currentFollows: botAccounts.currentFollows,
          lastUsedAt: botAccounts.lastUsedAt,
          cooldownUntil: botAccounts.cooldownUntil,
          createdAt: botAccounts.createdAt,
          updatedAt: botAccounts.updatedAt,
        })
        .from(botAccounts);
      if (whereClause) {
        botQuery = botQuery.where(whereClause) as typeof botQuery;
      }
      const bots = await botQuery
        .orderBy(desc(botAccounts.createdAt))
        .limit(limit)
        .offset(offset);

      // C7: never ship the embedded user:pass proxy credential to the admin UI.
      // Redact to the host:port[:auth] label form. The bot table only DISPLAYS
      // this string (truncated), so the label is fully sufficient there. NOTE:
      // the edit dialog pre-fills its proxyUrl input from this value, so the PUT
      // handler below detects a label-form value and treats it as "unchanged"
      // to avoid clobbering the real stored credential on a no-op save.
      const items = bots.map((b) => ({
        ...b,
        proxyUrl: proxyEndpointLabel(b.proxyUrl),
      }));

      res.json({ items, total: totalResult.count, limit, offset });
    } catch (err) {
      logger.error({ route: "GET /api/admin/bots", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Wave 5 task B: POST /api/admin/bots/seed ─────────────────────────────
  //
  // Self-serve bulk seed for the bot pool. Mirrors what server/scripts/
  // seed-bots.ts does from a shell session, but available as an admin-only
  // HTTP call so operators don't need server access to add accounts.
  //
  // Body shape:
  //   { bots: [{ ig_username, ig_password, email, email_password?, totp_secret? }, ...] }
  //
  // Behavior per row:
  //   • Encrypt ig_password and optional email_password (separate from session_data).
  //   • Derive imap_host via the shared imapHostFor helper so this path
  //     stays in lockstep with the shell seed script.
  //   • Upsert by ig_username (case-insensitive); existing bots get their
  //     creds rotated, new bots are inserted with status=available.
  //   • session_data left NULL — the auto-login worker fills it on first use.
  //
  // Auth: isAuthenticated + isAdmin. CSRF: enforced by /api/admin chain.
  // Rate-limited by the global adminRateLimiter (60/min) which is plenty
  // for a bulk-paste workflow.
  app.post(
    "/api/admin/bots/seed",
    isAuthenticated,
    isAdmin,
    expensiveOpsLimiter,
    async (req: Request, res: Response) => {
      const parsed = seedBotsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const seeded: Array<{ igUsername: string; action: "inserted" | "updated" }> = [];
      const failed: Array<{ igUsername: string; error: string }> = [];

      for (const bot of parsed.data.bots as SeedBotInput[]) {
        try {
          const igPasswordEnc = encryptCredential(bot.ig_password);
          const emailPasswordEnc = bot.email_password
            ? encryptCredential(bot.email_password)
            : null;
          const imapHost = imapHostFor(bot.email);

          const result = await db.execute(sql`
            INSERT INTO bot_accounts (
              ig_username,
              session_data,
              ig_password_encrypted,
              email_address,
              email_password_encrypted,
              imap_host,
              imap_port,
              totp_secret,
              status
            ) VALUES (
              ${bot.ig_username},
              NULL,
              ${igPasswordEnc},
              ${bot.email},
              ${emailPasswordEnc},
              ${imapHost},
              993,
              ${bot.totp_secret ? encryptCredential(bot.totp_secret) : null},
              'available'
            )
            ON CONFLICT (ig_username) DO UPDATE SET
              ig_password_encrypted = EXCLUDED.ig_password_encrypted,
              email_address = EXCLUDED.email_address,
              email_password_encrypted = EXCLUDED.email_password_encrypted,
              imap_host = EXCLUDED.imap_host,
              imap_port = EXCLUDED.imap_port,
              totp_secret = EXCLUDED.totp_secret,
              updated_at = NOW()
            RETURNING (xmax = 0) AS inserted
          `);
          // pg returns rows on the result object; guard the shape because
          // drizzle's execute() return type is intentionally loose.
          const rows = (result as unknown as { rows?: Array<{ inserted: boolean }> }).rows ?? [];
          const action: "inserted" | "updated" = rows[0]?.inserted ? "inserted" : "updated";
          seeded.push({ igUsername: bot.ig_username, action });
          logger.info(
            { igUsername: bot.ig_username, action },
            "[admin/bots/seed] upserted bot",
          );
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : "unknown error";
          logger.error(
            { igUsername: bot.ig_username, err },
            "[admin/bots/seed] upsert failed",
          );
          failed.push({ igUsername: bot.ig_username, error: message });
        }
      }

      // Trigger an immediate pool re-check so the operator gets fast
      // feedback in logs that the warning state cleared (or didn't).
      void checkBotPoolOnce().catch((err: unknown) =>
        logger.error({ err }, "post-seed bot pool check failed"),
      );

      const status = failed.length === 0 ? 200 : 207; // multi-status when partial
      res.status(status).json({
        message:
          failed.length === 0
            ? `Seeded ${seeded.length} bot(s)`
            : `Seeded ${seeded.length} bot(s), ${failed.length} failed`,
        seeded,
        failed,
      });
    },
  );

  // POST /api/admin/bots — Fix #16: input validation
  app.post("/api/admin/bots", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const { igUsername, igUserId, displayName, sessionData, proxyUrl, maxFollows } = req.body as {
        igUsername?: string;
        igUserId?: string;
        displayName?: string;
        sessionData?: string;
        proxyUrl?: string;
        maxFollows?: number;
      };

      // Fix #16: validate igUsername
      if (!igUsername || typeof igUsername !== "string" || igUsername.trim().length === 0) {
        res.status(400).json({ message: "igUsername is required and must be non-empty" });
        return;
      }
      if (igUsername.trim().length > 30) {
        res.status(400).json({ message: "igUsername must be 30 characters or less" });
        return;
      }

      // Fix #16: validate sessionData (shape + size)
      if (!sessionData || typeof sessionData !== "string" || sessionData.trim().length === 0) {
        res.status(400).json({ message: "sessionData is required and must be non-empty" });
        return;
      }
      const sessionCheck = validateBotSessionData(sessionData);
      if (!sessionCheck.ok) {
        res.status(400).json({ message: sessionCheck.error });
        return;
      }

      // Fix #16: validate maxFollows
      if (maxFollows !== undefined) {
        if (typeof maxFollows !== "number" || maxFollows < 1 || maxFollows > 100) {
          res.status(400).json({ message: "maxFollows must be between 1 and 100" });
          return;
        }
      }

      // Wave 2 task E: encrypt session data at rest before insert.
      const [bot] = await db.insert(botAccounts).values({
        igUsername: igUsername.trim().toLowerCase(),
        igUserId: igUserId || null,
        displayName: displayName || null,
        sessionData: ensureEncrypted(sessionData),
        proxyUrl: proxyUrl || null,
        maxFollows: maxFollows ?? 5,
      }).returning();

      // Don't return sessionData in response
      const safeBotData = stripBotSecrets(bot);
      res.status(201).json(safeBotData);
    } catch (err: any) {
      if (err?.code === "23505") {
        res.status(409).json({ message: "A bot with this username already exists" });
        return;
      }
      logger.error({ route: "POST /api/admin/bots", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // PUT /api/admin/bots/:id — Fix #16: input validation
  app.put("/api/admin/bots/:id", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }
      const { sessionData, proxyUrl, status, maxFollows, displayName } = req.body as {
        sessionData?: string;
        proxyUrl?: string;
        status?: string;
        maxFollows?: number;
        displayName?: string;
      };
      const [currentBot] = await db
        .select({
          id: botAccounts.id,
          status: botAccounts.status,
          proxyUrl: botAccounts.proxyUrl,
        })
        .from(botAccounts)
        .where(eq(botAccounts.id, id))
        .limit(1);
      if (!currentBot) {
        res.status(404).json({ message: "Bot account not found" });
        return;
      }

      // Fix #16: validate status
      if (status !== undefined && !ALLOWED_BOT_STATUSES.includes(status)) {
        res.status(400).json({ message: `Invalid status. Allowed: ${ALLOWED_BOT_STATUSES.join(", ")}` });
        return;
      }

      // Fix #16: validate maxFollows
      if (maxFollows !== undefined) {
        if (typeof maxFollows !== "number" || maxFollows < 1 || maxFollows > 100) {
          res.status(400).json({ message: "maxFollows must be between 1 and 100" });
          return;
        }
      }

      // Fix #16: validate igUsername (displayName here, but also sessionData)
      if (sessionData !== undefined) {
        if (typeof sessionData !== "string" || sessionData.trim().length === 0) {
          res.status(400).json({ message: "sessionData must be non-empty" });
          return;
        }
        const sessionCheck = validateBotSessionData(sessionData);
        if (!sessionCheck.ok) {
          res.status(400).json({ message: sessionCheck.error });
          return;
        }
      }
      if (
        currentBot.status === "session_expired" &&
        status === "available" &&
        sessionData === undefined
      ) {
        res.status(400).json({
          message:
            "A fresh session is required before an expired bot can be made available.",
        });
        return;
      }

      const updates: Record<string, any> = { updatedAt: new Date() };
      // Wave 2 task E: encrypt session data at rest before update.
      if (sessionData !== undefined) updates.sessionData = ensureEncrypted(sessionData);
      if (proxyUrl !== undefined) updates.proxyUrl = proxyUrl;
      if (status !== undefined) updates.status = status;
      if (maxFollows !== undefined) updates.maxFollows = maxFollows;
      if (displayName !== undefined) updates.displayName = displayName;

      // C7 clobber guard: GET /api/admin/bots now returns proxyUrl REDACTED to
      // its host:port[:auth] label. The edit dialog pre-fills its proxyUrl input
      // from that redacted value, so a no-op "Save" would otherwise overwrite
      // the real stored credential with the credential-less label and break the
      // proxy. If the submitted proxyUrl equals the redacted label of the value
      // already on record, the admin didn't actually change it — drop it from
      // the update so the stored credential is preserved.
      if (proxyUrl !== undefined && proxyUrl !== null) {
        if (proxyUrl === proxyEndpointLabel(currentBot.proxyUrl)) {
          delete updates.proxyUrl;
        }
      }

      let [updated] = await db
        .update(botAccounts)
        .set(updates)
        .where(eq(botAccounts.id, id))
        .returning();

      if (status === "disabled" || status === "banned") {
        try {
          await reconcileStoppedBotFollowRequests(id, status);
        } catch (err) {
          logger.error({ botId: id, err }, "bot status saved but follow cleanup incomplete");
          res.status(503).json({ message: `Bot is ${status}, but follow-request recovery could not finish. Save this status again to retry recovery.` });
          return;
        }
        [updated] = await db.select().from(botAccounts).where(eq(botAccounts.id, id)).limit(1);
      }

      // Redact the proxy credential in the PUT echo too, mirroring the GET.
      const safeBotData = stripBotSecrets(updated);
      res.json({ ...safeBotData, proxyUrl: proxyEndpointLabel(updated.proxyUrl) });
    } catch (err) {
      logger.error({ route: "PUT /api/admin/bots/:id", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Wave 2 task C: PATCH /api/admin/bots/:id/session ──────────────────────
  //
  // Self-serve re-auth pipeline. When a bot's IG session expires (detected by
  // bot-collectors emitting IGAuthExpiredError, bot is moved to status
  // session_expired), the admin generates a fresh Playwright session locally
  // and PATCHes the JSON blob here. We validate the shape, encrypt it at
  // rest, re-activate the bot, and clear any stale cooldown.
  //
  // Rate-limited (10/hr) and CSRF-protected via the global /api/admin chain.
  app.patch(
    "/api/admin/bots/:id/session",
    isAuthenticated,
    isAdmin,
    botSessionReauthLimiter,
    async (req: Request, res: Response) => {
      try {
        const id = firstParam(req.params.id);
        if (!isValidId(id)) {
          res.status(400).json({ message: "Invalid ID format" });
          return;
        }

        const parseResult = reauthSessionBodySchema.safeParse(req.body);
        if (!parseResult.success) {
          res.status(400).json({
            message: "Validation failed",
            errors: parseResult.error.issues.map((i) => ({
              field: i.path.join("."),
              message: i.message,
            })),
          });
          return;
        }

        const { sessionData } = parseResult.data;

        // Full shape + size validation — same schema POST/PUT use.
        const sessionCheck = validateBotSessionData(sessionData);
        if (!sessionCheck.ok) {
          res.status(400).json({ message: sessionCheck.error });
          return;
        }

        const [existing] = await db
          .select({ id: botAccounts.id, igUsername: botAccounts.igUsername, status: botAccounts.status })
          .from(botAccounts)
          .where(eq(botAccounts.id, id))
          .limit(1);

        if (!existing) {
          res.status(404).json({ message: "Bot account not found" });
          return;
        }

        // Reactivate the bot. We always set status back to "available" on a
        // successful re-auth, regardless of whether it was "session_expired",
        // "cooldown", or "banned" — the admin has explicitly told us this
        // session is good. cooldownUntil is cleared so bot-manager can pick
        // it immediately.
        const [updated] = await db
          .update(botAccounts)
          .set({
            sessionData: ensureEncrypted(sessionData),
            status: "available",
            cooldownUntil: null,
            updatedAt: new Date(),
          })
          .where(eq(botAccounts.id, id))
          .returning();

        logger.info(
          { botId: id, igUsername: existing.igUsername, priorStatus: existing.status },
          "bot session re-authenticated",
        );

        const safeBotData = stripBotSecrets(updated);
        res.json({ message: "Bot session re-authenticated", bot: safeBotData });
      } catch (err) {
        logger.error({ route: "PATCH /api/admin/bots/:id/session", err }, "error");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // DELETE /api/admin/bots/:id — retain access history and acknowledge recovery
  app.delete("/api/admin/bots/:id", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }

      const [bot] = await db
        .select({ id: botAccounts.id })
        .from(botAccounts)
        .where(eq(botAccounts.id, id))
        .limit(1);

      if (!bot) {
        res.status(404).json({ message: "Bot account not found" });
        return;
      }

      const [accepted] = await db.select({ id: botFollowRequests.id }).from(botFollowRequests)
        .where(and(eq(botFollowRequests.botAccountId, id), eq(botFollowRequests.status, "accepted"))).limit(1);
      if (accepted) {
        // Accepted evidence remains useful after pause or a subscription lapse:
        // cascading it away would lose the approved viewer on a later resume.
        res.status(409).json({ message: "This bot has accepted account-access history and cannot be deleted. Use Disable to retire it while preserving those access records." });
        return;
      }

      await db.update(botAccounts).set({ status: "disabled", updatedAt: new Date() })
        .where(eq(botAccounts.id, id));
      try {
        // Keep the original failed rows until every replacement enqueue is
        // acknowledged. A repeated Delete repairs the same queued replacement
        // through this shared helper instead of releasing capacity a second time.
        await reconcileStoppedBotFollowRequests(id, "disabled");
      } catch (err) {
        logger.error({ botId: id, err }, "bot deletion deferred until follow recovery completes");
        res.status(503).json({ message: "The bot was not deleted and remains disabled. Follow-request recovery could not finish; retry Delete when the queue is available." });
        return;
      }

      const outcome = await db.transaction(async tx => {
        // Match the request -> bot lock order used by capacity release. Locks
        // are held only for the final database check/delete, never Redis I/O.
        const requests = await tx.select({ status: botFollowRequests.status }).from(botFollowRequests)
          .where(eq(botFollowRequests.botAccountId, id)).orderBy(botFollowRequests.id).for("update");
        if (requests.some(request => ["queued", "pending", "accepted"].includes(request.status))) return "access-history";
        const [current] = await tx.select({ status: botAccounts.status }).from(botAccounts)
          .where(eq(botAccounts.id, id)).for("update");
        if (!current) return "missing";
        if (current.status !== "disabled" && current.status !== "banned") return "reactivated";
        // A new child could have committed before the bot lock was acquired.
        // The lock now fences further FK inserts until the delete commits.
        const [newRequest] = await tx.select({ id: botFollowRequests.id }).from(botFollowRequests)
          .where(and(eq(botFollowRequests.botAccountId, id), inArray(botFollowRequests.status, ["queued", "pending", "accepted"]))).limit(1);
        if (newRequest) return "access-history";
        await tx.delete(botAccounts).where(eq(botAccounts.id, id));
        return "deleted";
      });
      if (outcome === "access-history") {
        res.status(409).json({ message: "The bot gained live or accepted access records during this action and was not deleted. Use Disable for operational retirement." });
        return;
      }
      if (outcome === "reactivated") {
        res.status(409).json({ message: "Another action reactivated this bot, so it was not deleted. Refresh the bot list before trying again." });
        return;
      }
      if (outcome === "missing") {
        res.status(404).json({ message: "Bot account not found" });
        return;
      }

      res.json({ message: "Bot account deleted" });
    } catch (err) {
      logger.error({ route: "DELETE /api/admin/bots/:id", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // GET /api/admin/bots/:id/follow-requests
  app.get("/api/admin/bots/:id/follow-requests", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }
      const requests = await db
        .select()
        .from(botFollowRequests)
        .where(eq(botFollowRequests.botAccountId, id))
        .orderBy(desc(botFollowRequests.queuedAt))
        .limit(200);
      res.json(requests);
    } catch (err) {
      logger.error({ route: "GET /api/admin/bots/:id/follow-requests", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // GET /api/admin/stats — Fix #7: replace .filter() with GROUP BY
  app.get("/api/admin/stats", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      // Fix #7: Bot stats with GROUP BY
      const botStatRows = await db
        .select({
          status: botAccounts.status,
          count: count(),
        })
        .from(botAccounts)
        .groupBy(botAccounts.status);

      const botMap = new Map(botStatRows.map(r => [r.status, r.count]));
      const totalBots = botStatRows.reduce((sum, r) => sum + r.count, 0);

      // Fix #7: Follow request stats with GROUP BY
      const frStatRows = await db
        .select({
          status: botFollowRequests.status,
          count: count(),
        })
        .from(botFollowRequests)
        .groupBy(botFollowRequests.status);

      const frMap = new Map(frStatRows.map(r => [r.status, r.count]));
      const totalFollowRequests = frStatRows.reduce((sum, r) => sum + r.count, 0);

      // Fix #7: Tracked account stats with GROUP BY
      const accountStatRows = await db
        .select({
          isPrivate: trackedAccounts.isPrivate,
          count: count(),
        })
        .from(trackedAccounts)
        .groupBy(trackedAccounts.isPrivate);

      const accountMap = new Map(accountStatRows.map(r => [String(r.isPrivate), r.count]));
      const totalTrackedAccounts = accountStatRows.reduce((sum, r) => sum + r.count, 0);

      res.json({
        totalBots,
        availableBots: botMap.get("available") ?? 0,
        activeBots: botMap.get("in_use") ?? 0,
        // Keep historical "disabledBots" (disabled + banned) aggregate for
        // dashboard backward compatibility, but also surface the finer-grained
        // counts so ops can tell the difference between a banned bot and one
        // with an expired session that can be re-authed.
        disabledBots: (botMap.get("disabled") ?? 0) + (botMap.get("banned") ?? 0),
        bannedBots: botMap.get("banned") ?? 0,
        sessionExpiredBots: botMap.get("session_expired") ?? 0,
        cooldownBots: botMap.get("cooldown") ?? 0,
        totalFollowRequests,
        pendingRequests: (frMap.get("pending") ?? 0) + (frMap.get("queued") ?? 0),
        acceptedRequests: frMap.get("accepted") ?? 0,
        failedRequests: (frMap.get("failed") ?? 0) + (frMap.get("rejected") ?? 0),
        totalTrackedAccounts,
        privateAccounts: accountMap.get("true") ?? 0,
        publicAccounts: accountMap.get("false") ?? 0,
      });
    } catch (err) {
      logger.error({ route: "GET /api/admin/stats", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // GET /api/admin/follow-requests — Fix #8: add pagination
  app.get("/api/admin/follow-requests", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const { limit, offset } = parsePagination(req.query);
      const status = String(req.query.status ?? "all");
      if (
        status !== "all" &&
        !(ALLOWED_FOLLOW_REQUEST_STATUSES as readonly string[]).includes(status)
      ) {
        res.status(400).json({ message: "Invalid follow request status" });
        return;
      }
      const statusCondition =
        status === "all"
          ? undefined
          : eq(
              botFollowRequests.status,
              status as FollowRequestStatus,
            );

      let countQuery = db.select({ count: count() }).from(botFollowRequests);
      if (statusCondition) {
        countQuery = countQuery.where(statusCondition) as typeof countQuery;
      }
      const [totalResult] = await countQuery;

      let requestQuery = db
        .select({
          id: botFollowRequests.id,
          botAccountId: botFollowRequests.botAccountId,
          trackedAccountId: botFollowRequests.trackedAccountId,
          status: botFollowRequests.status,
          queuedAt: botFollowRequests.queuedAt,
          sentAt: botFollowRequests.sentAt,
          resolvedAt: botFollowRequests.resolvedAt,
          retryCount: botFollowRequests.retryCount,
          error: botFollowRequests.error,
          expiresAt: botFollowRequests.expiresAt,
          botUsername: botAccounts.igUsername,
          targetUsername: trackedAccounts.igUsername,
        })
        .from(botFollowRequests)
        .leftJoin(botAccounts, eq(botFollowRequests.botAccountId, botAccounts.id))
        .leftJoin(trackedAccounts, eq(botFollowRequests.trackedAccountId, trackedAccounts.id));

      if (statusCondition) {
        requestQuery = requestQuery.where(statusCondition) as typeof requestQuery;
      }

      const requests = await requestQuery
        .orderBy(desc(botFollowRequests.queuedAt))
        .limit(limit)
        .offset(offset);

      res.json({ items: requests, total: totalResult.count, limit, offset });
    } catch (err) {
      logger.error({ route: "GET /api/admin/follow-requests", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NEW ADMIN ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  // ── 1. GET /api/admin/overview — Fix #6: parallelize with Promise.all ───

  app.get("/api/admin/overview", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      // Fix #6: parallelize all count queries
      const [
        // User counts
        [totalUsers],
        [newThisWeek],
        [activeThisMonth],
        // Subscription counts (use GROUP BY)
        subStatRows,
        subPlanRows,
        // Tracked account counts
        [totalAccounts],
        [activeAccounts],
        [inactiveAccounts],
        [privateAccountsCount],
        [publicAccountsCount],
        [pendingAccessCount],
        // Event counts
        activitySummary,
        // Bot stats (GROUP BY)
        botStatRows,
        // Job counts
        [totalJobs],
        jobStatRows,
        [failedLast24h],
      ] = await Promise.all([
        // Users
        db.select({ count: count() }).from(users),
        db.select({ count: count() }).from(users).where(sql`${users.createdAt} > NOW() - INTERVAL '7 days'`),
        db.select({ count: count() }).from(users).where(sql`${users.updatedAt} > NOW() - INTERVAL '30 days'`),
        // Subscriptions GROUP BY
        db.select({ status: subscriptions.status, count: count() }).from(subscriptions).groupBy(subscriptions.status),
        db
          .select({ plan: subscriptions.plan, count: count() })
          .from(subscriptions)
          .where(
            inArray(subscriptions.status, ["trialing", "active", "past_due"]),
          )
          .groupBy(subscriptions.plan),
        // Tracked accounts
        db.select({ count: count() }).from(trackedAccounts),
        db.select({ count: count() }).from(trackedAccounts).where(eq(trackedAccounts.isActive, true)),
        db.select({ count: count() }).from(trackedAccounts).where(eq(trackedAccounts.isActive, false)),
        db.select({ count: count() }).from(trackedAccounts).where(eq(trackedAccounts.isPrivate, true)),
        db.select({ count: count() }).from(trackedAccounts).where(eq(trackedAccounts.isPrivate, false)),
        db.select({ count: count() }).from(trackedAccounts).where(eq(trackedAccounts.accessStatus, "pending_access")),
        // Exactly the same evidence/identity/noise rules as Activity.
        readAdminActivity({type:"all",search:"",limit:0,offset:0}),
        // Bots GROUP BY
        db.select({ status: botAccounts.status, count: count() }).from(botAccounts).groupBy(botAccounts.status),
        // Jobs
        db.select({ count: count() }).from(collectionJobs),
        db.select({ status: collectionJobs.status, count: count() }).from(collectionJobs).groupBy(collectionJobs.status),
        db.select({ count: count() }).from(collectionJobs).where(and(
          eq(collectionJobs.status, "failed"),
          sql`${collectionJobs.completedAt} > NOW() - INTERVAL '24 hours'`,
        )),
      ]);

      // Build subscription maps
      const subStatusMap = new Map(subStatRows.map(r => [r.status, r.count]));
      const subPlanMap = new Map(subPlanRows.map(r => [r.plan, r.count]));
      const totalSubs = subStatRows.reduce((sum, r) => sum + r.count, 0);

      // Build bot map
      const botMap = new Map(botStatRows.map(r => [r.status, r.count]));

      // Build job map
      const jobMap = new Map(jobStatRows.map(r => [r.status, r.count]));

      res.json({
        users: {
          total: totalUsers.count,
          newThisWeek: newThisWeek.count,
          activeThisMonth: activeThisMonth.count,
        },
        subscriptions: {
          total: totalSubs,
          trialing: subStatusMap.get("trialing") ?? 0,
          active: subStatusMap.get("active") ?? 0,
          pastDue: subStatusMap.get("past_due") ?? 0,
          canceled: subStatusMap.get("canceled") ?? 0,
          starterPlan: subPlanMap.get("starter") ?? 0,
          standardPlan: subPlanMap.get("standard") ?? 0,
          proPlan: subPlanMap.get("pro") ?? 0,
          legacyPlans:
            (subPlanMap.get("weekly") ?? 0) +
            (subPlanMap.get("monthly") ?? 0),
        },
        trackedAccounts: {
          total: totalAccounts.count,
          active: activeAccounts.count,
          inactive: inactiveAccounts.count,
          private: privateAccountsCount.count,
          public: publicAccountsCount.count,
          pendingAccess: pendingAccessCount.count,
        },
        events: activitySummary.summary,
        bots: {
          total: botStatRows.reduce((sum, r) => sum + r.count, 0),
          available: botMap.get("available") ?? 0,
          inUse: botMap.get("in_use") ?? 0,
          cooldown: botMap.get("cooldown") ?? 0,
          disabled: botMap.get("disabled") ?? 0,
          banned: botMap.get("banned") ?? 0,
          sessionExpired: botMap.get("session_expired") ?? 0,
        },
        jobs: {
          total: totalJobs.count,
          pending: jobMap.get("pending") ?? 0,
          running: jobMap.get("running") ?? 0,
          completed: jobMap.get("completed") ?? 0,
          failed: jobMap.get("failed") ?? 0,
          failedLast24h: failedLast24h.count,
        },
      });
    } catch (err) {
      logger.error({ route: "GET /api/admin/overview", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 2. GET /api/admin/users — Fix #2: nest subscription, Fix #3: no_subscription, Fix #17: escapeLike ─

  app.get("/api/admin/users", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const { limit, offset } = parsePagination(req.query);
      const search = String(req.query.search ?? "").trim();
      const status = String(req.query.status ?? "all");
      if (
        !(ALLOWED_SUBSCRIPTION_FILTERS as readonly string[]).includes(status)
      ) {
        res.status(400).json({ message: "Invalid subscription status" });
        return;
      }

      // Build where conditions
      const conditions: any[] = [];

      // Fix #17: escape LIKE wildcards in search
      if (search) {
        const escaped = escapeLike(search);
        conditions.push(
          or(
            ilike(users.email, `%${escaped}%`),
            ilike(users.name, `%${escaped}%`),
          ),
        );
      }
      if (status === "no_subscription") {
        conditions.push(sql`${subscriptions.id} IS NULL`);
      } else if (status !== "all") {
        conditions.push(
          eq(
            subscriptions.status,
            status as "trialing" | "active" | "past_due" | "canceled",
          ),
        );
      }
      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      // Count tracked accounts per user as a sub-select
      const trackedCountSq = db
        .select({
          userId: trackedAccounts.userId,
          count: count().as("tracked_count"),
        })
        .from(trackedAccounts)
        .where(eq(trackedAccounts.isActive, true))
        .groupBy(trackedAccounts.userId)
        .as("tracked_counts");

      // Base query with left join to subscriptions and tracked counts
      let baseQuery = db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
          subscriptionId: subscriptions.id,
          subscriptionStatus: subscriptions.status,
          subscriptionPlan: subscriptions.plan,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          trialEndsAt: subscriptions.trialEndsAt,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          trackedAccountCount: trackedCountSq.count,
        })
        .from(users)
        .leftJoin(subscriptions, eq(users.id, subscriptions.userId))
        .leftJoin(trackedCountSq, eq(users.id, trackedCountSq.userId));

      // Apply search and subscription status together. Calling `.where()`
      // twice can replace the earlier clause in dynamic query builders, which
      // made combined search + status filters return unrelated users.
      if (whereClause) {
        baseQuery = baseQuery.where(whereClause) as any;
      }

      // Get total count (separate query for accurate count with filters)
      let countQuery = db
        .select({ count: count() })
        .from(users)
        .leftJoin(subscriptions, eq(users.id, subscriptions.userId));

      if (whereClause) {
        countQuery = countQuery.where(whereClause) as any;
      }

      const [totalResult] = await countQuery;

      const rawItems = await (baseQuery as any)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);

      // Fix #2: nest subscription data into a `subscription` object
      const items = (rawItems as any[]).map((row: any) => {
        const { subscriptionId, subscriptionStatus, subscriptionPlan, currentPeriodEnd, trialEndsAt, cancelAtPeriodEnd, ...userFields } = row;
        return {
          ...userFields,
          subscription: subscriptionId
            ? {
                id: subscriptionId,
                status: subscriptionStatus,
                plan: subscriptionPlan,
                currentPeriodEnd,
                trialEndsAt,
                cancelAtPeriodEnd,
              }
            : null,
        };
      });

      res.json({ items, total: totalResult.count });
    } catch (err) {
      logger.error({ route: "GET /api/admin/users", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 3. GET /api/admin/users/:id — Fix #15: limit subscription fields ──

  app.get("/api/admin/users/:id", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }

      const [user] = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      // Fix #15: select only needed subscription fields
      const [rawSub] = await db
        .select({
          id: subscriptions.id,
          status: subscriptions.status,
          plan: subscriptions.plan,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          trialEndsAt: subscriptions.trialEndsAt,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, id))
        .limit(1);

      // Tracked accounts with event counts
      const userAccounts = await db
        .select()
        .from(trackedAccounts)
        .where(eq(trackedAccounts.userId, id))
        .orderBy(desc(trackedAccounts.trackingStarted));

      const accountIds = userAccounts.map(a => a.id);

      let likeCounts: Map<string, number> = new Map();
      let followCounts: Map<string, number> = new Map();
      let unfollowCounts: Map<string, number> = new Map();

      if (accountIds.length > 0) {
        likeCounts = await countVisibleLikedPostsByAccount(accountIds);
        const end = new Date();
        // Match the customer's canonical roster, settlement boundary and trust
        // rules; raw event counts include seeding noise and returned members.
        for (const account of userAccounts) {
          const totals = await visibleAccountFollowTotals(account, end);
          followCounts.set(account.id, totals.followCount);
          unfollowCounts.set(account.id, totals.unfollowCount);
        }
      }

      const trackedAccountsWithCounts = userAccounts.map(a => ({
        id: a.id,
        igUsername: a.igUsername,
        displayName: a.displayName,
        isActive: a.isActive,
        isPrivate: a.isPrivate,
        accessStatus: a.accessStatus,
        followerCount: a.followerCount,
        trackingStarted: a.trackingStarted,
        likeCount: likeCounts.get(a.id) ?? 0,
        followCount: followCounts.get(a.id) ?? 0,
        unfollowCount: unfollowCounts.get(a.id) ?? 0,
      }));

      // Recent notifications
      const recentNotifications = await db
        .select({
          id: notifications.id,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          isRead: notifications.isRead,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(eq(notifications.userId, id))
        .orderBy(desc(notifications.createdAt))
        .limit(20);

      // Aggregate stats
      let totalLikes = 0;
      let totalFollows = 0;
      let totalUnfollows = 0;
      for (const a of trackedAccountsWithCounts) {
        totalLikes += a.likeCount;
        totalFollows += a.followCount;
        totalUnfollows += a.unfollowCount;
      }

      res.json({
        user,
        subscription: rawSub ?? null,
        trackedAccounts: trackedAccountsWithCounts,
        recentNotifications,
        stats: { totalLikes, totalFollows, totalUnfollows },
      });
    } catch (err) {
      logger.error({ route: "GET /api/admin/users/:id", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 4. DELETE /api/admin/users/:id — Fix #13: prevent self-deletion ───

  app.delete("/api/admin/users/:id", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }

      // Fix #13: prevent admin self-deletion
      if (id === req.user!.id) {
        res.status(400).json({ message: "Cannot delete your own admin account" });
        return;
      }

      const [user] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }

      // Block deletion of other admin accounts. Admin removal is a
      // sensitive operation that should go through an explicit role
      // demotion, not a one-click delete from the user table.
      if (user.role === "admin") {
        res.status(403).json({ message: "Cannot delete another admin account" });
        return;
      }

      await deleteCustomerAccount(id, stripe);

      res.json({ message: "User deleted successfully" });
    } catch (err) {
      if (err instanceof CustomerBillingBusyError) { res.status(409).json({ message: err.message }); return; }
      if (err instanceof CustomerAccountMissingError) { res.status(404).json({ message: "User not found" }); return; }
      if (err instanceof CustomerDeletionBillingError) { res.status(502).json({ message: err.message }); return; }
      logger.error({ route: "DELETE /api/admin/users/:id", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 5. GET /api/admin/tracked-accounts — Fix #4: status filter, Fix #17: escapeLike ─

  app.get("/api/admin/tracked-accounts", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const { limit, offset } = parsePagination(req.query);
      const search = String(req.query.search ?? "").trim();
      // Fix #4: read status param for active/inactive filter
      const status = String(req.query.status ?? "all");
      const access = String(req.query.access ?? "all");
      // The admin UI's "Mine" chip used to filter the CURRENT PAGE client-side,
      // so an admin's own accounts sitting on page 3 simply vanished. Filter in
      // SQL instead. Unknown values are ignored rather than rejected — the chip
      // is a convenience, not an API contract.
      const owner = String(req.query.owner ?? "all");

      // Build conditions
      const conditions: any[] = [];

      // Fix #17: escape LIKE wildcards
      if (search) {
        const escaped = escapeLike(search);
        conditions.push(
          or(
            ilike(trackedAccounts.igUsername, `%${escaped}%`),
            ilike(users.email, `%${escaped}%`),
            ilike(users.name, `%${escaped}%`),
          ),
        );
      }

      if (owner === "me") {
        conditions.push(eq(trackedAccounts.userId, req.user!.id));
      }

      // Fix #4: use status param for active/inactive
      if (status === "active") {
        conditions.push(eq(trackedAccounts.isActive, true));
      } else if (status === "inactive") {
        conditions.push(eq(trackedAccounts.isActive, false));
      }

      // Validate the access filter against the access-status allowlist before it
      // reaches drizzle. Reject unknown values rather than casting with `as any`.
      if (access !== "all") {
        if (!ALLOWED_ACCESS_STATUSES.includes(access)) {
          res.status(400).json({ message: "Invalid access" });
          return;
        }
        conditions.push(
          eq(trackedAccounts.accessStatus, access as AccessStatus),
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Count
      let countQuery = db
        .select({ count: count() })
        .from(trackedAccounts)
        .leftJoin(users, eq(trackedAccounts.userId, users.id));
      if (whereClause) {
        countQuery = countQuery.where(whereClause) as any;
      }
      const [totalResult] = await countQuery;

      // Fetch with user info
      let dataQuery = db
        .select({
          id: trackedAccounts.id,
          igUsername: trackedAccounts.igUsername,
          displayName: trackedAccounts.displayName,
          profilePicUrl: trackedAccounts.profilePicUrl,
          followerCount: trackedAccounts.followerCount,
          isActive: trackedAccounts.isActive,
          isPrivate: trackedAccounts.isPrivate,
          accessStatus: trackedAccounts.accessStatus,
          trackingStarted: trackedAccounts.trackingStarted,
          updatedAt: trackedAccounts.updatedAt,
          userId: trackedAccounts.userId,
          userEmail: users.email,
          userName: users.name,
          // Count owners across the full identity, before search/owner/page
          // filters. Private evidence remains scoped to its customer row.
          ownerCount: sql<number>`(SELECT count(DISTINCT owner_row.user_id)::int
            FROM tracked_accounts owner_row
            WHERE owner_row.is_active = true AND (
              (${trackedAccounts.isPrivate} = true AND owner_row.id = ${trackedAccounts.id}) OR
              (${trackedAccounts.isPrivate} = false AND owner_row.is_private = false AND (
                (NULLIF(btrim(${trackedAccounts.igUserId}), '') IS NOT NULL AND owner_row.ig_user_id = ${trackedAccounts.igUserId}) OR
                (NULLIF(btrim(${trackedAccounts.igUserId}), '') IS NULL AND lower(owner_row.ig_username) = lower(${trackedAccounts.igUsername}))
              ))
            ))`,
        })
        .from(trackedAccounts)
        .leftJoin(users, eq(trackedAccounts.userId, users.id));

      if (whereClause) {
        dataQuery = dataQuery.where(whereClause) as any;
      }

      const items = await (dataQuery as any)
        .orderBy(desc(trackedAccounts.trackingStarted))
        .limit(limit)
        .offset(offset);

      // Get event counts for returned accounts
      const accountIds = (items as any[]).map((a: any) => a.id);
      let likeCountMap: Map<string, number> = new Map();
      let followCountMap: Map<string, number> = new Map();
      let unfollowCountMap: Map<string, number> = new Map();

      if (accountIds.length > 0) {
        const end = new Date();
        const [likeResults, followResults] = await Promise.all([
          // Twin union deduped by post id, gated per row — equals the
          // customer's dashboard header for that row.
          countVisibleLikedPostsByAccount(accountIds),
          // Follow logs also contain baseline discoveries, transient churn and
          // historical twin copies. Read the canonical roster with the same
          // per-customer tracking boundary as user detail instead of summing logs.
          Promise.all((items as Array<{ id: string; trackingStarted: Date }>).map(async (account) => ({
            id: account.id,
            ...await visibleAccountFollowTotals(account, end),
          }))),
        ]);

        likeCountMap = likeResults;
        followCountMap = new Map(followResults.map(r => [r.id, r.followCount]));
        unfollowCountMap = new Map(followResults.map(r => [r.id, r.unfollowCount]));
      }

      const enrichedItems = (items as any[]).map((item: any) => ({
        ...item,
        likeCount: likeCountMap.get(item.id) ?? 0,
        followCount: followCountMap.get(item.id) ?? 0,
        unfollowCount: unfollowCountMap.get(item.id) ?? 0,
      }));

      res.json({ items: enrichedItems, total: totalResult.count });
    } catch (err) {
      logger.error({ route: "GET /api/admin/tracked-accounts", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 5b. GET /api/admin/tracked-accounts/:id — twin-aware account detail ──────
  //
  // Registered BEFORE the PATCH/:id route below so `/:id/liked-posts` is
  // matched by its own handler rather than by a broader `/:id` pattern.

  app.get("/api/admin/tracked-accounts/:id", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }

      const [account] = await db
        .select({
          id: trackedAccounts.id,
          igUsername: trackedAccounts.igUsername,
          igUserId: trackedAccounts.igUserId,
          displayName: trackedAccounts.displayName,
          profilePicUrl: trackedAccounts.profilePicUrl,
          followerCount: trackedAccounts.followerCount,
          isActive: trackedAccounts.isActive,
          isPrivate: trackedAccounts.isPrivate,
          accessStatus: trackedAccounts.accessStatus,
          trackingStarted: trackedAccounts.trackingStarted,
          userId: trackedAccounts.userId,
          userEmail: users.email,
          userName: users.name,
        })
        .from(trackedAccounts)
        .leftJoin(users, eq(trackedAccounts.userId, users.id))
        .where(eq(trackedAccounts.id, id))
        .limit(1);

      if (!account) {
        res.status(404).json({ message: "Tracked account not found" });
        return;
      }

      const twinIds = await twinTrackedAccountIds(id);
      const [owners, likeCount, followTotals, [profile]] = await Promise.all([
        db
          .select({
            trackedAccountId: trackedAccounts.id,
            userId: trackedAccounts.userId,
            userEmail: users.email,
            userName: users.name,
            trackingStarted: trackedAccounts.trackingStarted,
            isActive: trackedAccounts.isActive,
          })
          .from(trackedAccounts)
          .leftJoin(users, eq(trackedAccounts.userId, users.id))
          .where(and(inArray(trackedAccounts.id, twinIds), eq(trackedAccounts.isActive, true)))
          .orderBy(trackedAccounts.trackingStarted),
        twinLikedPostTotal(twinIds),
        visibleAccountFollowTotals(account),
        db.select({ profilePicUrl: profileSnapshots.profilePicUrl, profilePicUrlHd: profileSnapshots.profilePicUrlHd,
          fullName: profileSnapshots.fullName }).from(profileSnapshots)
          .where(eq(profileSnapshots.trackedAccountId, await canonicalTwinId(id)))
          .orderBy(desc(profileSnapshots.snapshotAt)).limit(1),
      ]);

      res.json({
        account: { ...account,
          profilePicUrl: firstNonemptyString(account.profilePicUrl, profile?.profilePicUrl, profile?.profilePicUrlHd),
          displayName: firstNonemptyString(account.displayName, profile?.fullName, account.igUsername),
        },
        owners,
        stats: { likeCount, ...followTotals },
      });
    } catch (err) {
      logger.error({ route: "GET /api/admin/tracked-accounts/:id", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  registerAdminTrackedContentRoutes(app);

  // ── 5c. GET /api/admin/tracked-accounts/:id/liked-posts ──────────────────────
  //
  // The full deduped twin union, matching the client `ActivityEvent` shape so
  // the admin UI can reuse LikedPostsGallery. Thumbnails are returned raw —
  // the client proxies Instagram CDN URLs itself.

  app.get("/api/admin/tracked-accounts/:id/liked-posts", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }
      const { limit, offset } = parsePagination(req.query);
      const scope = await adminContentScope(id);
      if (!scope) { res.status(404).json({ message: "Tracked account not found" }); return; }
      res.setHeader("Cache-Control", "private, no-store");
      if (!scope.access.allowed) {
        res.status(403).json({ message: "Private account content is unavailable", code: scope.access.reason });
        return;
      }
      const twinIds = await twinTrackedAccountIds(id);
      const [rows, total] = await Promise.all([
        twinLikedPostsPage(twinIds, limit, offset),
        twinLikedPostTotal(twinIds),
      ]);

      const items = rows.map((row) => ({
        id: row.postId,
        eventType: "like" as const,
        detectedAt: row.detectedAt,
        postTakenAt: row.postTakenAt,
        postId: row.postId,
        ownerUsername: row.ownerUsername,
        postType: row.postType,
        postUrl: row.postUrl,
        thumbnailUrl: row.thumbnailUrl,
        caption: row.caption,
        hashtags: row.hashtags ?? [],
        likesCount: row.likesCount,
        commentsCount: row.commentsCount,
        videoViewCount: row.videoViewCount,
        locationName: row.locationName,
      }));

      res.json({ items, total });
    } catch (err) {
      logger.error({ route: "GET /api/admin/tracked-accounts/:id/liked-posts", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 6. PATCH /api/admin/tracked-accounts/:id — Fix #16: validate accessStatus ─

  app.patch("/api/admin/tracked-accounts/:id", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }
      const { isActive, accessStatus } = req.body as {
        isActive?: boolean;
        accessStatus?: string;
      };

      // Fix #16: validate accessStatus
      if (accessStatus !== undefined && !ALLOWED_ACCESS_STATUSES.includes(accessStatus)) {
        res.status(400).json({ message: `Invalid accessStatus. Allowed: ${ALLOWED_ACCESS_STATUSES.join(", ")}` });
        return;
      }

      const updates: Record<string, any> = { updatedAt: new Date() };
      if (isActive !== undefined) updates.isActive = isActive;
      if (accessStatus !== undefined) updates.accessStatus = accessStatus;

      const [updated] = await db
        .update(trackedAccounts)
        .set(updates)
        .where(eq(trackedAccounts.id, id))
        .returning();

      if (!updated) {
        res.status(404).json({ message: "Tracked account not found" });
        return;
      }

      // Sync the per-account refresh scheduler when isActive flips. Both
      // helpers are idempotent so it is safe to call on every PATCH that
      // touches isActive.
      if (isActive === true) {
        await registerAccountRefresh(collectionProfileQueue, id);
      } else if (isActive === false) {
        await unregisterAccountRefresh(collectionProfileQueue, id);
      }

      res.json(updated);
    } catch (err) {
      logger.error({ route: "PATCH /api/admin/tracked-accounts/:id", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 7. GET /api/admin/activity — Fix #5: add total count, Fix #17: escapeLike ─

  app.get("/api/admin/activity", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const { limit, offset } = parsePagination(req.query);
      const type = String(req.query.type ?? "all");
      if (!ADMIN_ACTIVITY_TYPES.includes(type as AdminActivityType)) {
        res.status(400).json({ message: "Invalid activity type" });
        return;
      }
      const search = String(req.query.search ?? "").trim();
      res.set("Cache-Control", "private, no-store");
      // Old open tabs only understand three icons/types. New clients explicitly
      // opt into both follower directions, so rollout cannot crash an old tab.
      res.json(await readAdminActivity({ type: type as AdminActivityType, search, limit, offset,
        includeFollowers: req.query.v === "2" || type === "follower" || type === "follower_unfollow" }));
    } catch (err) {
      logger.error({ route: "GET /api/admin/activity", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 8. GET /api/admin/queues ───────────────────────────────────────────────

  app.get("/api/admin/queues", isAuthenticated, isAdmin, async (_req: Request, res: Response) => {
    try {
      const queues = getQueues();
      const queueEntries = Object.values(queues);

      const results = await Promise.all(
        queueEntries.map(async (queue) => {
          try {
            const counts = await queue.getJobCounts(
              "waiting", "active", "completed", "failed", "delayed", "paused",
            );
            return {
              name: queue.name,
              waiting: counts.waiting ?? 0,
              active: counts.active ?? 0,
              completed: counts.completed ?? 0,
              failed: counts.failed ?? 0,
              delayed: counts.delayed ?? 0,
              paused: counts.paused ?? 0,
            };
          } catch (queueErr) {
            logger.error({ queue: queue.name, err: queueErr }, "error reading queue");
            return {
              name: queue.name,
              waiting: 0,
              active: 0,
              completed: 0,
              failed: 0,
              delayed: 0,
              paused: 0,
              error: "Unable to read queue status",
            };
          }
        }),
      );

      res.json({ queues: results });
    } catch (err) {
      logger.error({ route: "GET /api/admin/queues", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 9. GET /api/admin/jobs ─────────────────────────────────────────────────

  app.get("/api/admin/jobs", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const { limit, offset } = parsePagination(req.query);
      const status = String(req.query.status ?? "all");
      const jobType = String(req.query.jobType ?? "all");

      // Validate enum filters against the schema allowlists before they reach
      // drizzle. Reject unknown values rather than silently casting with `as any`.
      if (status !== "all" && !(ALLOWED_JOB_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ message: "Invalid status" });
        return;
      }
      if (jobType !== "all" && !(ALLOWED_JOB_TYPES as readonly string[]).includes(jobType)) {
        res.status(400).json({ message: "Invalid jobType" });
        return;
      }

      const conditions: any[] = [];

      // Safe to narrow to the enum type: both values are now allowlist-checked.
      if (status !== "all") {
        conditions.push(eq(collectionJobs.status, status as JobStatus));
      }

      if (jobType !== "all") {
        conditions.push(eq(collectionJobs.jobType, jobType as JobType));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Count
      let countQuery = db.select({ count: count() }).from(collectionJobs);
      if (whereClause) {
        countQuery = countQuery.where(whereClause) as any;
      }
      const [totalResult] = await countQuery;

      // Data
      let dataQuery = db
        .select({
          id: collectionJobs.id,
          trackedAccountId: collectionJobs.trackedAccountId,
          jobType: collectionJobs.jobType,
          status: collectionJobs.status,
          startedAt: collectionJobs.startedAt,
          completedAt: collectionJobs.completedAt,
          error: collectionJobs.error,
          igUsername: trackedAccounts.igUsername,
        })
        .from(collectionJobs)
        .leftJoin(trackedAccounts, eq(collectionJobs.trackedAccountId, trackedAccounts.id));

      if (whereClause) {
        dataQuery = dataQuery.where(whereClause) as any;
      }

      const items = await (dataQuery as any)
        .orderBy(desc(collectionJobs.startedAt))
        .limit(limit)
        .offset(offset);

      res.json({ items, total: totalResult.count });
    } catch (err) {
      logger.error({ route: "GET /api/admin/jobs", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 10. POST /api/admin/jobs/:id/retry ─────────────────────────────────────

  app.post("/api/admin/jobs/:id/retry", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }

      const [job] = await db
        .select()
        .from(collectionJobs)
        .where(eq(collectionJobs.id, id))
        .limit(1);

      if (!job) {
        res.status(404).json({ message: "Job not found" });
        return;
      }

      if (job.status !== "failed") {
        res.status(409).json({ message: "Only failed jobs can be retried. Refresh the job list to see its current status." });
        return;
      }

      // Only profile workers claim and complete collection_jobs audit rows.
      // Likes/follows workers do not, and collection_jobs.id is NOT reports.id.
      // Keep historical failures intact rather than turning them into pending
      // rows that can never complete or enqueueing an unrelated report ID.
      if (job.jobType !== "profile") {
        res.status(409).json({
          message: job.jobType === "report"
            ? "This audit row has no linked report ID. Regenerate the report from the account's Reports page."
            : "This legacy job cannot be retried independently. Retry a failed profile collection for this tracked account to refresh its collection pipeline.",
        });
        return;
      }

      // Claim before enqueueing so a fast worker can see its pending audit row.
      // The status predicate also prevents simultaneous retry clicks from
      // enqueueing duplicate work after both have read the same failed row.
      const [claimed] = await db
        .update(collectionJobs)
        .set({ status: "pending", error: null, startedAt: null, completedAt: null })
        .where(and(eq(collectionJobs.id, id), eq(collectionJobs.status, "failed")))
        .returning({ id: collectionJobs.id });
      if (!claimed) {
        res.status(409).json({ message: "This job has already changed status. Refresh the job list before retrying." });
        return;
      }

      try {
        // Keep one queue entry for this failed attempt if Redis accepted the
        // first request but its acknowledgement was lost. A later worker
        // failure receives a new timestamp and can be retried independently.
        const attemptAt = (job.completedAt ?? job.startedAt)?.getTime() ?? 0;
        await getQueues().collectionProfileQueue.add("collect-profile", { trackedAccountId: job.trackedAccountId }, {
          jobId: `admin-profile-retry-${id}-${attemptAt}`,
        });
      } catch (err) {
        // Redis rejection must not strand an audit row in pending or erase the
        // original diagnostic. Do not overwrite a worker that already claimed
        // the row if enqueue acknowledgement failed after delivery.
        await db.update(collectionJobs).set({
          status: "failed",
          error: job.error,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        }).where(and(eq(collectionJobs.id, id), eq(collectionJobs.status, "pending")));
        logger.error({ jobId: id, err }, "admin job retry enqueue failed");
        res.status(503).json({ message: "The collection queue did not confirm this retry. Refresh the job list and try again when the queue is available." });
        return;
      }

      res.json({ message: "Job re-enqueued successfully" });
    } catch (err) {
      logger.error({ route: "POST /api/admin/jobs/:id/retry", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 11. POST /api/admin/bots/:id/reset-cooldown — Fix #19: check status ──

  app.post("/api/admin/bots/:id/reset-cooldown", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }

      const [bot] = await db
        .select()
        .from(botAccounts)
        .where(eq(botAccounts.id, id))
        .limit(1);

      if (!bot) {
        res.status(404).json({ message: "Bot account not found" });
        return;
      }

      // Fix #19: only allow reset-cooldown if bot is currently in cooldown
      if (bot.status !== "cooldown") {
        res.status(400).json({ message: "Only bots in cooldown status can have their cooldown reset" });
        return;
      }

      const [updated] = await db
        .update(botAccounts)
        .set({
          status: "available",
          cooldownUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(botAccounts.id, id))
        .returning();

      const safeBotData = stripBotSecrets(updated);
      res.json({ message: "Cooldown reset", bot: safeBotData });
    } catch (err) {
      logger.error({ route: "POST /api/admin/bots/:id/reset-cooldown", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 12. POST /api/admin/bots/:id/disable — Fix #20: handle active follow requests ─

  app.post("/api/admin/bots/:id/disable", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }

      const [bot] = await db
        .select()
        .from(botAccounts)
        .where(eq(botAccounts.id, id))
        .limit(1);

      if (!bot) {
        res.status(404).json({ message: "Bot account not found" });
        return;
      }

      // Park first: releasing a full bot's capacity must not briefly make it
      // available to an assignment racing this admin action.
      await db
        .update(botAccounts)
        .set({ status: "disabled", updatedAt: new Date() })
        .where(eq(botAccounts.id, id));
      try {
        await reconcileStoppedBotFollowRequests(id, "disabled");
      } catch (err) {
        logger.error({ botId: id, err }, "bot disabled but follow cleanup incomplete");
        res.status(503).json({ message: "Bot is disabled, but follow-request recovery could not finish. Save the disabled status again in Edit Bot to retry recovery." });
        return;
      }
      const [updated] = await db.select().from(botAccounts).where(eq(botAccounts.id, id)).limit(1);

      const safeBotData = stripBotSecrets(updated);
      res.json({ message: "Bot disabled", bot: safeBotData });
    } catch (err) {
      logger.error({ route: "POST /api/admin/bots/:id/disable", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 13. POST /api/admin/bots/:id/enable ───────────────────────────────────

  app.post("/api/admin/bots/:id/enable", isAuthenticated, isAdmin, async (req: Request, res: Response) => {
    try {
      const id = firstParam(req.params.id);
      if (!isValidId(id)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }

      const [bot] = await db
        .select()
        .from(botAccounts)
        .where(eq(botAccounts.id, id))
        .limit(1);

      if (!bot) {
        res.status(404).json({ message: "Bot account not found" });
        return;
      }

      if (bot.status !== "disabled") {
        res.status(400).json({ message: "Only disabled bots can be enabled" });
        return;
      }

      const [updated] = await db
        .update(botAccounts)
        .set({ status: "available", updatedAt: new Date() })
        .where(eq(botAccounts.id, id))
        .returning();

      const safeBotData = stripBotSecrets(updated);
      res.json({ message: "Bot enabled", bot: safeBotData });
    } catch (err) {
      logger.error({ route: "POST /api/admin/bots/:id/enable", err }, "error");
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── 14. GET /api/admin/bots/warming-status (Wave 6) ────────────────────
  // Per-bot warming progress dashboard feed. Returns one row per bot with
  // its current warming_day (0..7) and estimated days until fully warmed.
  // Note: route is registered BEFORE the dynamic /api/admin/bots/:id/warm
  // route so Express's path matcher doesn't treat "warming-status" as an id.
  app.get(
    "/api/admin/bots/warming-status",
    isAuthenticated,
    isAdmin,
    async (_req: Request, res: Response) => {
      try {
        const rows = await getWarmingStatus();
        res.json({ data: rows });
      } catch (err) {
        logger.error(
          { route: "GET /api/admin/bots/warming-status", err },
          "error",
        );
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ── 15. POST /api/admin/bots/:id/warm (Wave 6) ─────────────────────────
  // Manual one-off trigger for a warm session. Useful for ops to validate a
  // single bot or force-advance a stuck row. Runs synchronously and returns
  // the WarmOutcome. Note: a full session can take up to 30 min — callers
  // should adjust their HTTP timeouts accordingly OR pass durationMs.
  const warmBodySchema = z.object({
    durationMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
    intensity: z.enum(["low", "med", "high"]).optional(),
  });

  app.post(
    "/api/admin/bots/:id/warm",
    isAuthenticated,
    isAdmin,
    async (req: Request, res: Response) => {
      try {
        const id = firstParam(req.params.id);
        if (!isValidId(id)) {
          res.status(400).json({ message: "Invalid ID format" });
          return;
        }

        const [bot] = await db
          .select({ id: botAccounts.id })
          .from(botAccounts)
          .where(eq(botAccounts.id, id))
          .limit(1);

        if (!bot) {
          res.status(404).json({ message: "Bot account not found" });
          return;
        }

        const parsed = warmBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            message: "Invalid warm options",
            errors: parsed.error.issues,
          });
          return;
        }

        const outcome = await warmBot(id, parsed.data);
        res.json({
          message: "Warm session complete",
          outcome,
        });
      } catch (err) {
        logger.error({ route: "POST /api/admin/bots/:id/warm", err }, "error");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ── Self-healing: emergency manual override ───────────────────────────────
  // Clears every active bot cooldown AND closes the IG circuit breaker.
  // Useful for ops when an incident has been resolved upstream and we want
  // the pool back to full strength immediately rather than waiting on the
  // automated cooldown probe + breaker half-open cycle.
  app.post(
    "/api/admin/system/heal",
    isAuthenticated,
    isAdmin,
    expensiveOpsLimiter,
    async (_req: Request, res: Response) => {
      try {
        const breakerSnapshotBefore = getBreakerSnapshot();
        const breakerWasOpen = breakerSnapshotBefore.state !== "CLOSED";

        const cleared = await db
          .update(botAccounts)
          .set({ cooldownUntil: null, updatedAt: new Date() })
          .where(sql`${botAccounts.cooldownUntil} IS NOT NULL`)
          .returning({ id: botAccounts.id });

        resetBreaker();

        logger.info(
          {
            route: "POST /api/admin/system/heal",
            clearedCooldowns: cleared.length,
            breakerWasOpen,
          },
          "system heal triggered",
        );

        res.json({
          clearedCooldowns: cleared.length,
          breakerWasOpen,
          breaker: getBreakerSnapshot(),
        });
      } catch (err) {
        logger.error({ route: "POST /api/admin/system/heal", err }, "error");
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ── Wave 6: per-endpoint 3-strikes auto-disable ──────────────────────────
  //
  // GET  /api/admin/endpoints/disabled       — list endpoints currently in
  //                                            the 24h auto-disable window.
  // POST /api/admin/endpoints/:endpoint/enable
  //                                          — operator override: clear the
  //                                            disabled row and wipe recent
  //                                            strikes so a future failure
  //                                            doesn't immediately re-disable.
  app.get(
    "/api/admin/endpoints/disabled",
    isAuthenticated,
    isAdmin,
    async (_req: Request, res: Response) => {
      try {
        const disabled = await getDisabledEndpoints();
        res.json({
          endpoints: disabled.map((d) => ({
            endpoint: d.endpoint,
            disabledAt: d.disabledAt.toISOString(),
            until: d.until.toISOString(),
            reason: d.reason,
          })),
        });
      } catch (err) {
        logger.error(
          { route: "GET /api/admin/endpoints/disabled", err },
          "error",
        );
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  app.post(
    "/api/admin/endpoints/:endpoint/enable",
    isAuthenticated,
    isAdmin,
    requireCsrfToken,
    async (req: Request, res: Response) => {
      const endpoint = String(req.params.endpoint ?? "").trim();
      if (!endpoint) {
        res.status(400).json({ message: "endpoint required" });
        return;
      }
      try {
        const removed = await manualEnableEndpoint(endpoint);
        logger.info(
          { route: "POST /api/admin/endpoints/:endpoint/enable", endpoint, removed },
          "endpoint manual enable",
        );
        res.json({ endpoint, enabled: true, wasDisabled: removed });
      } catch (err) {
        logger.error(
          {
            route: "POST /api/admin/endpoints/:endpoint/enable",
            endpoint,
            err,
          },
          "error",
        );
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );

  // ── Wave 6: per-bot daily call budget ────────────────────────────────────
  //
  // Emergency override that clears today's bot_daily_calls rows for one bot.
  // Useful when ops needs to push a bot back into rotation immediately
  // (e.g. cap was tripped by a bug in the cap schedule, or a tracked account
  // urgently needs a refresh and the rest of the pool is cooling down).
  // Day-rollover at midnight UTC will clear the row anyway — this just
  // brings that forward.
  app.post(
    "/api/admin/bots/:id/budget/reset",
    isAuthenticated,
    isAdmin,
    requireCsrfToken,
    async (req: Request, res: Response) => {
      const botId = firstParam(req.params.id);
      if (!isValidId(botId)) {
        res.status(400).json({ message: "Invalid ID format" });
        return;
      }
      try {
        const before = await getBudgetStatus(botId);
        const cleared = await resetTodayBudget(botId);
        const after = await getBudgetStatus(botId);
        logger.info(
          {
            route: "POST /api/admin/bots/:id/budget/reset",
            botId,
            cleared,
          },
          "bot daily budget reset",
        );
        res.json({
          botId,
          clearedRows: cleared,
          before: before.today,
          after: after.today,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        if (msg.includes("not found")) {
          res.status(404).json({ message: "Bot not found", botId });
          return;
        }
        logger.error(
          { route: "POST /api/admin/bots/:id/budget/reset", botId, err },
          "error",
        );
        res.status(500).json({ message: "Internal server error" });
      }
    },
  );
}
