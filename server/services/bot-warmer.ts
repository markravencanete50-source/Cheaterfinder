// ─── Bot warmer ──────────────────────────────────────────────────────────────
//
// Wave 6: fresh bot accounts trip IG's risk heuristics on the higher-trust
// read endpoints — stories (`/feed/user/<pk>/reel_media/`), highlights
// (`/highlights/<pk>/highlights_tray/`), reels (`/api/v1/clips/user/`), and
// tagged feed (`/usertags/<pk>/feed/`). The result is HTTP 400 with
// `checkpoint_required` even when the cookies are perfectly valid.
//
// Industry-standard mitigation: warming. Each bot performs a randomised low
// volume browsing session daily for 5-7 days, gradually escalating to the
// "trust-gated" endpoints. Each successful run nudges `warming_day` up by 1
// (capped at 7 = fully warmed); after that the scheduler stops enqueueing
// warm jobs for the bot.
//
// This module is a pure scheduler-friendly function. The BullMQ wrapper lives
// in server/workers/bot-warmer-worker.ts; the manual trigger lives in
// server/admin-routes.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from "drizzle-orm";

import { db } from "../db.js";
import {
  createHttpBotClientWithFingerprint,
  IGAuthExpiredError,
  IGHttpError,
  IGRateLimitedError,
} from "../ig-http-client.js";
import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import { logger as baseLogger } from "../observability/logger.js";
import { ensureBotReady } from "./bot-runtime.js";
import { KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX } from "./proxy-durability.js";
import {
  cooldownBotForCheckpoint,
  cooldownBotForRateLimit,
  withRotationRateLimitCooldownPolicy,
} from "./bot-cooldown.js";
import { COOLDOWN_REASON_PREFIX } from "./bot-cooldown.js";
import {
  isEndpointMobileOnly,
  isIgWebThrottleBody,
} from "../ig-public-scraper.js";
import { withScrapeRetry } from "./scrape-retry.js";
import { OperationBusyError, withOperationLease, operationSignal } from "./operation-lease.js";
import { reserveOrThrow } from "../behavior/daily-budget.js";
import { IGDailyCapExceededError } from "../behavior/caps.js";
import { isShuttingDown, waitForShutdownOrTimeout } from "./shutdown-state.js";
import {
  recordOutcome,
  type ScrapeEndpoint,
  type ScrapeOutcomeKind,
} from "./scrape-metrics.js";

const logger = baseLogger.child({ module: "bot-warmer" });

// ─── Public types ───────────────────────────────────────────────────────────

export type WarmIntensity = "low" | "med" | "high";

export interface WarmOptions {
  readonly durationMs?: number;
  readonly intensity?: WarmIntensity;
}

/**
 * Why a warm session stopped. `rate_limit` is the quiet exit: IG asked the bot
 * to slow down, the bot took a short cooldown, and nothing about the session
 * was learned — it must not feed the dead-session streak.
 */
export type WarmSessionEnd =
  | "budget"
  | "deadline"
  | "rate_limit"
  | "checkpoint"
  | "failure_limit"
  | "shutdown"
  | "skipped";

export interface WarmOutcome {
  readonly botId: string;
  readonly started: Date;
  readonly ended: Date;
  readonly actionsCompleted: number;
  readonly actionsFailed: number;
  readonly advancedToDay: number;
  readonly endedBy: WarmSessionEnd;
}

// ─── Tuning constants ──────────────────────────────────────────────────────

/** Hard cap on a single warm session in real time. Acts as a safety belt
 *  alongside the action counter. */
const DEFAULT_DURATION_MS = 30 * 60 * 1000;

/** Per-intensity action budget. Real users don't view 50 endpoints in a
 *  30-minute browse session. Numbers tuned conservatively. */
const ACTIONS_BY_INTENSITY: Record<WarmIntensity, number> = {
  low: 10,
  med: 15,
  high: 20,
};

const SLEEP_MIN_MS = 8_000;
const SLEEP_MAX_MS = 30_000;

/**
 * Cooldown written when a warm action is throttled and IG sent no usable
 * Retry-After (the 401 "please wait" web throttle, a bare 429). Mirrors the
 * scraper's 10-minute `ig web throttle` cooldown. The warmer used to call
 * `cooldownBotForRateLimit` under the pool-wide default, so every throttled
 * warm action benched the bot for the 4 h floor: on 2026-09-02, 16 of 17 warm
 * sessions ended that way and the warmer wrote 18 of the day's 23 four-hour
 * cooldowns — a net capacity sink. `WARMER_RATE_LIMIT_COOLDOWN_MS` overrides
 * (floor 60 s).
 */
const DEFAULT_WARM_THROTTLE_COOLDOWN_MS = 10 * 60 * 1000;

function warmThrottleCooldownMs(): number {
  const configured = Number(process.env.WARMER_RATE_LIMIT_COOLDOWN_MS ?? "");
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(configured, 60_000);
  }
  return DEFAULT_WARM_THROTTLE_COOLDOWN_MS;
}

interface Decoy {
  readonly username: string;
  /** IG numeric id, pinned so a warm session never has to resolve it through
   *  web_profile_info — the endpoint whose rate limit ended 16 of 17 warm
   *  sessions on 2026-09-02. Values verified against roster_members. */
  readonly pk: string;
}

/** Public IG accounts used as warm decoys. We pick well-known celebrities so
 *  the bot looks like any other curious user. The list is intentionally tiny
 *  and stable — a longer list would just amplify per-call attribution risk. */
const DECOYS: ReadonlyArray<Decoy> = [
  { username: "cristiano", pk: "173560420" },
  { username: "leomessi", pk: "427553890" },
  { username: "natgeo", pk: "787132" },
  { username: "nasa", pk: "528817151" },
  { username: "instagram", pk: "25025320" },
];

/** Grid page size for a warm posts read — what the web app requests when a
 *  profile grid is opened. */
const WARM_FEED_COUNT = 12;

const MAX_WARMING_DAY = 7;

// ─── Bot row helpers ───────────────────────────────────────────────────────

interface BotWarmRow {
  readonly id: string;
  readonly ig_username: string;
  readonly ig_user_id: string | null;
  readonly warming_day: number;
  readonly tier: string;
  readonly status: string;
  readonly automation_identity: unknown;
  readonly cooldown_until?: Date | string | null;
  readonly warm_failure_streak?: number;
}

interface WarmSessionSnapshot {
  readonly session_data: string;
  readonly proxy_url: string | null;
  readonly proxy_endpoint: string | null;
  readonly proxy_expires_at: Date | string | null;
  readonly automation_identity: unknown;
  readonly transport: string;
}

function warmSessionSnapshotPredicate(snapshot: WarmSessionSnapshot) {
  return sql`session_data = ${snapshot.session_data}
    AND proxy_url IS NOT DISTINCT FROM ${snapshot.proxy_url}
    AND proxy_endpoint IS NOT DISTINCT FROM ${snapshot.proxy_endpoint}
    AND proxy_expires_at IS NOT DISTINCT FROM ${snapshot.proxy_expires_at}
    AND automation_identity IS NOT DISTINCT FROM ${snapshot.automation_identity == null ? null : JSON.stringify(snapshot.automation_identity)}::jsonb
    AND transport = ${snapshot.transport}`;
}

async function loadBot(botId: string): Promise<BotWarmRow> {
  const result = (await db.execute(sql`
    SELECT id, ig_username, ig_user_id, warming_day,
           tier, status, automation_identity, cooldown_until, warm_failure_streak
    FROM bot_accounts
    WHERE id = ${botId}
  `)) as unknown as { rows: BotWarmRow[] };
  const bot = result.rows[0];
  if (!bot) throw new Error(`[bot-warmer] bot ${botId} not found`);
  return bot;
}

async function persistAdvancement(
  botId: string,
  newDay: number,
  snapshot: WarmSessionSnapshot,
): Promise<void> {
  const capped = Math.min(MAX_WARMING_DAY, Math.max(0, newDay));
  await db.execute(sql`
    UPDATE bot_accounts SET
      warming_day = ${capped},
      last_warming_at = NOW(),
      updated_at = NOW()
    WHERE id = ${botId} AND status = 'available' AND ${warmSessionSnapshotPredicate(snapshot)}
  `);
}

// ─── Action plan ────────────────────────────────────────────────────────────

/**
 * Mapping from warming_day → recommended intensity. Day 0/1 = low, 2/3 = med,
 * 4+ = high. Manual callers can still override via `opts.intensity`.
 */
export function intensityForWarmingDay(day: number): WarmIntensity {
  if (day <= 1) return "low";
  if (day <= 3) return "med";
  return "high";
}

// No warm action reads web_profile_info any more. The scraper moved its
// profile reads off that endpoint because its rate limit is the tightest on
// the web transport; the warmer kept hitting it (every action resolved a pk
// through it) and 16 of 17 warm sessions on 2026-09-02 ended on that limit.
// Posts and story/highlight/tagged trays take a pk, which is pinned per decoy.
type ActionKind =
  | "browseSelfPosts"
  | "browseDecoyPosts"
  | "viewDecoyStory"
  | "viewDecoyHighlight"
  | "viewDecoyTagged";

interface PlannedAction {
  readonly kind: ActionKind;
  /** Endpoint label used by recordOutcome. */
  readonly metricEndpoint: ScrapeEndpoint;
}

const POSTS_ACTIONS: ReadonlyArray<PlannedAction> = [
  { kind: "browseSelfPosts", metricEndpoint: "posts" },
  { kind: "browseDecoyPosts", metricEndpoint: "posts" },
];

/**
 * Stand-ins for the two posts actions while `posts` is routed to the mobile
 * transport only (see isEndpointMobileOnly).
 *
 * The warmer drives WEB sessions exclusively, so a menu entry whose endpoint
 * the web lane can no longer serve is not merely unproductive — it is actively
 * harmful. IG answers /api/v1/feed/user/ on the web lane with HTTP 200 and an
 * HTML login page; runAction records that as a failed action, the session
 * spends its whole budget failing, and the failures feed the bot's
 * hard-failure streak. Because both LOW actions were posts reads and LOW is
 * the base of every intensity, that was the entire warmer: over the 24 h to
 * 2026-09-05, 12 warm sessions completed 0 actions and failed 57, and 44
 * actions escalated to "giving up" — the mechanism meant to keep web sessions
 * healthy was benching them instead.
 *
 * Both substitutes are HTTP-first on the web lane (83% and 77% success over
 * the same window), so neither launches Firefox and neither adds metered proxy
 * bandwidth. When the gate is off, the menu is byte-for-byte the original.
 */
const POSTS_SUBSTITUTE_ACTIONS: ReadonlyArray<PlannedAction> = [
  { kind: "viewDecoyHighlight", metricEndpoint: "highlights" },
  { kind: "viewDecoyTagged", metricEndpoint: "tagged" },
];

const MED_EXTRA: PlannedAction = {
  kind: "viewDecoyStory",
  metricEndpoint: "stories",
};

/**
 * Warm action kinds withheld from the menu, from WARM_DISABLED_ACTIONS
 * (comma-separated; `none` or empty re-enables everything).
 *
 * Same principle as the posts substitution above: an action the web lane
 * cannot currently complete is worse than no action, because a failure spends
 * the session's budget AND feeds the bot's hard-failure streak. `stories` is
 * the default entry — IG answers the decoy trays with HTTP 400, 51 failures
 * against 28 successes over the 12 h to 2026-09-05, and the first warm session
 * after the posts fix still lost 7 of its 15 actions to that one kind. It is
 * also the most expensive kind by far: stories is browser-routed, so every
 * attempt launches a Firefox that loads a full instagram.com page through the
 * metered proxy (~3 MB measured) to earn a 400.
 *
 * Re-enable with WARM_DISABLED_ACTIONS=none and a restart when stories
 * recovers on the web lane; no deploy needed.
 */
const DISABLED_ACTION_KINDS: ReadonlySet<string> = (() => {
  const raw = (process.env.WARM_DISABLED_ACTIONS ?? "viewDecoyStory")
    .trim()
    .toLowerCase();
  if (raw === "" || raw === "none") return new Set<string>();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
})();

/**
 * Drop disabled kinds. Falls back to the unfiltered list if the filter would
 * empty the menu — a misconfigured knob must not leave a warm session with
 * nothing to do, which would look identical to a dead warmer.
 */
function withoutDisabled(
  actions: ReadonlyArray<PlannedAction>,
): ReadonlyArray<PlannedAction> {
  const kept = actions.filter(
    (action) => !DISABLED_ACTION_KINDS.has(action.kind.toLowerCase()),
  );
  return kept.length > 0 ? kept : actions;
}

const HIGH_EXTRA: ReadonlyArray<PlannedAction> = [
  { kind: "viewDecoyHighlight", metricEndpoint: "highlights" },
  { kind: "viewDecoyTagged", metricEndpoint: "tagged" },
];

/** The two base actions, swapped out while the web posts lane is walled. */
function baseActions(): ReadonlyArray<PlannedAction> {
  return isEndpointMobileOnly("posts") ? POSTS_SUBSTITUTE_ACTIONS : POSTS_ACTIONS;
}

function actionMenu(
  intensity: WarmIntensity,
): ReadonlyArray<PlannedAction> {
  const low = baseActions();
  if (intensity === "low") return withoutDisabled(low);
  const med = [...low, MED_EXTRA];
  if (intensity === "med") return withoutDisabled(med);
  return withoutDisabled([...med, ...HIGH_EXTRA]);
}

// ─── Randomised pacing ─────────────────────────────────────────────────────

function jitterSleep(): Promise<"shutdown" | "timeout"> {
  const span = SLEEP_MAX_MS - SLEEP_MIN_MS;
  const delay = SLEEP_MIN_MS + Math.floor(Math.random() * span);
  return waitForShutdownOrTimeout(delay);
}

function pickRandom<T>(items: ReadonlyArray<T>): T {
  return items[Math.floor(Math.random() * items.length)];
}

// ─── Action runners ────────────────────────────────────────────────────────

interface WarmContext {
  readonly botId: string;
  readonly igUsername: string;
  readonly igUserId: string | null;
  readonly client: {
    readonly fetchUserFeed: (
      pk: string,
      opts?: { count?: number },
    ) => Promise<unknown>;
    readonly fetchStoriesTray: (pk: string) => Promise<unknown>;
    readonly fetchHighlightsTray: (pk: string) => Promise<unknown>;
    readonly fetchUserTagged: (
      pk: string,
      opts?: { count?: number },
    ) => Promise<unknown>;
  };
}

async function runAction(
  action: PlannedAction,
  ctx: WarmContext,
): Promise<void> {
  switch (action.kind) {
    case "browseSelfPosts": {
      // Open our own grid (GET /api/v1/feed/user/<pk>/). A bot row without
      // ig_user_id browses a decoy grid instead — never resolve the id via
      // web_profile_info, that is the endpoint this menu exists to avoid.
      const pk = ctx.igUserId ?? pickRandom(DECOYS).pk;
      await ctx.client.fetchUserFeed(pk, { count: WARM_FEED_COUNT });
      return;
    }
    case "browseDecoyPosts": {
      const decoy = pickRandom(DECOYS);
      await ctx.client.fetchUserFeed(decoy.pk, { count: WARM_FEED_COUNT });
      return;
    }
    case "viewDecoyStory": {
      const decoy = pickRandom(DECOYS);
      await ctx.client.fetchStoriesTray(decoy.pk);
      return;
    }
    case "viewDecoyHighlight": {
      const decoy = pickRandom(DECOYS);
      await ctx.client.fetchHighlightsTray(decoy.pk);
      return;
    }
    case "viewDecoyTagged": {
      const decoy = pickRandom(DECOYS);
      await ctx.client.fetchUserTagged(decoy.pk, { count: 6 });
      return;
    }
    default: {
      const exhaustive: never = action.kind;
      throw new Error(`[bot-warmer] unknown action kind: ${String(exhaustive)}`);
    }
  }
}

function classifyError(err: unknown): ScrapeOutcomeKind {
  if (err instanceof IGRateLimitedError) return "rate_limit";
  if (err instanceof IGAuthExpiredError) {
    // The scraper distinguishes IG's 401 "please wait a few minutes"
    // (igweb_rollout throttle, session still valid) from a real auth failure;
    // the warmer did not, and benched 10 healthy web bots for 24h on a single
    // throttled warm action. Same body test, same verdict.
    if (typeof err.body === "string" && isIgWebThrottleBody(err.body)) {
      return "rate_limit";
    }
    return "checkpoint";
  }
  if (err instanceof IGHttpError) {
    if (err.igErrorCode === "checkpoint_required") return "checkpoint";
    if (err.igErrorCode === "challenge_required") return "checkpoint";
    if (err.status === 429) return "rate_limit";
  }
  return "failure";
}

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Run a single warming session for a bot. Idempotent for callers — the bot
 * runtime resolves proxy + session before any traffic is sent. The function
 * never throws on individual action failures; tracking-day advancement is
 * conditional on at least one action succeeding (so a fully-blocked bot
 * doesn't graduate falsely).
 */
// Repeated authentication/checkpoint rejections without a successful action
// eventually require session recovery. Transport failures and generic HTTP
// errors do not prove that a saved session has expired; they must not turn a
// proxy/endpoint outage into a pool-wide session-expiration verdict.
const DEAD_SESSION_STREAK = 3;

/**
 * bot-runtime's rotation guard: an authenticated session with no fresh lane
 * must not be moved to a new exit IP. For the warmer that is "not now", never
 * "broken" — exported for tests.
 */
export function isLaneRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes("refusing ip rotation") ||
    message.includes("has no fresh proxy lane")
  );
}

export async function warmBot(
  botId: string,
  opts: WarmOptions = {},
): Promise<WarmOutcome> {
  try {
    return await warmOwnedBot(botId, opts);
  } catch (err) {
    if (!(err instanceof OperationBusyError)) throw err;
    const bot = await loadBot(botId);
    const now = new Date();
    return { botId, started: now, ended: now, actionsCompleted: 0,
      actionsFailed: 0, advancedToDay: bot.warming_day, endedBy: "skipped" };
  }
}

async function warmOwnedBot(botId: string, opts: WarmOptions): Promise<WarmOutcome> {
  const started = new Date();
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  const sessionDeadlineAt = started.getTime() + durationMs;

  const bot = await loadBot(botId);

  if (isShuttingDown()) {
    return { botId, started, ended: new Date(), actionsCompleted: 0, actionsFailed: 0,
      advancedToDay: bot.warming_day, endedBy: "shutdown" };
  }

  // A delayed job can outlive the roster migration that created it. In
  // production, acknowledge that obsolete work without touching its proxy,
  // session, or the legacy TypeScript transport. Only migrated, active
  // canary/worker rows may perform a warm session.
  const isProductionWarmCandidate =
    bot.automation_identity &&
    (bot.tier === "canary" || bot.tier === "worker") &&
    bot.status === "available";
  if ((process.env.NODE_ENV === "production" && !isProductionWarmCandidate) ||
      (bot.cooldown_until && new Date(bot.cooldown_until).getTime() > Date.now())) {
    logger.info(
      { botId, tier: bot.tier, status: bot.status },
      "[bot-warmer] skipping obsolete or ineligible warm job",
    );
    return {
      botId,
      started,
      ended: new Date(),
      actionsCompleted: 0,
      actionsFailed: 0,
      advancedToDay: bot.warming_day,
      endedBy: "skipped",
    };
  }

  const intensity =
    opts.intensity ?? intensityForWarmingDay(bot.warming_day);
  const actionBudget = ACTIONS_BY_INTENSITY[intensity];
  const menu = actionMenu(intensity);

  logger.info(
    {
      botId,
      igUsername: bot.ig_username,
      warmingDay: bot.warming_day,
      intensity,
      actionBudget,
      durationMs,
    },
    "[bot-warmer] starting warm session",
  );

  // Warming uses an existing saved session; the recovery sweeper owns login.
  // Recheck eligibility after obtaining ownership, because the initial row can
  // become disabled, cooled, or session-less while waiting for the bot lease.
  let prepared: { ready: Awaited<ReturnType<typeof ensureBotReady>>; snapshot: WarmSessionSnapshot } | null;
  try {
    prepared = await withOperationLease(`bot:${botId}`, async () => {
      // Keep this opaque stored snapshot inside the initialization lease. A
      // later login or proxy/identity replacement must retire this warm client.
      const current = (await db.execute(sql`
        SELECT session_data, proxy_url, proxy_endpoint, proxy_expires_at, automation_identity, transport
        FROM bot_accounts
        WHERE id = ${botId} AND status = 'available' AND session_data IS NOT NULL
          AND (cooldown_until IS NULL OR cooldown_until <= NOW())
          AND (${process.env.NODE_ENV !== "production"}
            OR (tier IN ('worker', 'canary') AND automation_identity IS NOT NULL))
      `)) as unknown as { rows: WarmSessionSnapshot[] };
      const snapshot = current.rows[0];
      if (!snapshot?.session_data) return null;
      const ready = await ensureBotReady(botId, { allowLogin: false });
      return { ready, snapshot };
    });
  } catch (err) {
    if (isLaneRefusal(err)) {
      logger.info(
        { botId, igUsername: bot.ig_username, err: err instanceof Error ? err.message : String(err) },
        "[bot-warmer] no proxy lane for authenticated session; skipping this sweep",
      );
      return {
        botId,
        started,
        ended: new Date(),
        actionsCompleted: 0,
        actionsFailed: 0,
        advancedToDay: bot.warming_day,
        endedBy: "skipped",
      };
    }
    throw err;
  }
  if (!prepared) {
    return { botId, started, ended: new Date(), actionsCompleted: 0, actionsFailed: 0,
      advancedToDay: bot.warming_day, endedBy: "skipped" };
  }
  const { ready, snapshot } = prepared;
  const fingerprint = resolveFingerprint({
    igUsername: bot.ig_username,
  });
  const client = createHttpBotClientWithFingerprint(
    ready.sessionData,
    fingerprint,
    bot.ig_username,
    ready.proxyEndpoint,
    botId,
    ready.automationIdentity,
  );

  const ctx: WarmContext = {
    botId,
    igUsername: bot.ig_username,
    igUserId: bot.ig_user_id,
    client,
  };

  let actionsCompleted = 0;
  let actionsFailed = 0;
  let consecutiveFailures = 0;
  let endedBy: WarmSessionEnd = "budget";

  try {
    for (let i = 0; i < actionBudget; i += 1) {
      if (isShuttingDown()) { endedBy = "shutdown"; break; }
      operationSignal()?.throwIfAborted();
      if (Date.now() >= sessionDeadlineAt) {
        logger.info(
          { botId, actionsRun: i, actionBudget },
          "[bot-warmer] session deadline reached, stopping early",
        );
        endedBy = "deadline";
        break;
      }

      const action = pickRandom(menu);
      const label = `warm:${action.kind}` as const;

      try {
        const ranAction = await withScrapeRetry(label, () => withOperationLease(`bot:${botId}`, async () => {
          if (isShuttingDown()) { const error = new Error("warming paused for shutdown"); error.name = "AbortError"; throw error; }
          operationSignal()?.throwIfAborted();
          // Collection can cool or invalidate this bot while the warmer sleeps.
          // Recheck under each action's shared lease, including retry attempts,
          // before consuming quota or using the client created at session start.
          const current = (await db.execute(sql`
            SELECT id FROM bot_accounts
            WHERE id = ${botId} AND status = 'available' AND session_data IS NOT NULL
              AND (cooldown_until IS NULL OR cooldown_until <= NOW())
              AND (${process.env.NODE_ENV !== "production"}
                OR (tier IN ('worker', 'canary') AND automation_identity IS NOT NULL))
              AND ${warmSessionSnapshotPredicate(snapshot)}
          `)) as unknown as { rows: { id: string }[] };
          if (!current.rows.length) return false;
          operationSignal()?.throwIfAborted();
          await reserveOrThrow(botId, action.metricEndpoint);
          await runAction(action, ctx);
          return true;
        }));
        if (!ranAction) { endedBy = "skipped"; break; }
        recordOutcome(action.metricEndpoint, "success", botId);
        actionsCompleted += 1;
        consecutiveFailures = 0;
        logger.debug(
          {
            botId,
            kind: action.kind,
            endpoint: action.metricEndpoint,
            step: i + 1,
            of: actionBudget,
          },
          "[bot-warmer] action ok",
        );
      } catch (err) {
        if (isShuttingDown()) { endedBy = "shutdown"; break; }
        if (err instanceof OperationBusyError) { endedBy = "skipped"; break; }
        if (err instanceof IGDailyCapExceededError) {
          endedBy = "budget";
          break;
        }
        const kind = classifyError(err);
        recordOutcome(action.metricEndpoint, kind, botId);
        actionsFailed += 1;
        consecutiveFailures += 1;
        logger.warn(
          {
            botId,
            kind: action.kind,
            endpoint: action.metricEndpoint,
            err: err instanceof Error ? err.message : String(err),
          },
          "[bot-warmer] action failed",
        );
        if (kind === "rate_limit") {
          // A throttled warm action is not a pool-wide signal — it is one
          // idle bot being told to slow down. Under the default policy
          // `cooldownBotForRateLimit` applies the 4 h floor; the rotation
          // policy honours IG's Retry-After (>= 60 s) or, when IG sent none
          // (the 401 "please wait" throttle), the scraper's short web-throttle
          // window. End the session quietly: short cooldown, no streak, no
          // verdict.
          const retryAfterMs =
            err instanceof IGRateLimitedError && err.retryAfterMs > 0
              ? err.retryAfterMs
              : warmThrottleCooldownMs();
          await withRotationRateLimitCooldownPolicy(() =>
            cooldownBotForRateLimit(botId, retryAfterMs,
              sql`status = 'available' AND ${warmSessionSnapshotPredicate(snapshot)}`),
          );
          endedBy = "rate_limit";
          logger.info(
            {
              botId,
              kind: action.kind,
              endpoint: action.metricEndpoint,
              cooldownMs: retryAfterMs,
            },
            "[bot-warmer] throttled; ending warm session quietly",
          );
          break;
        }
        if (kind === "checkpoint") {
          await cooldownBotForCheckpoint(
            botId,
            err instanceof Error ? err.message : String(err),
            24,
            sql`status = 'available' AND ${warmSessionSnapshotPredicate(snapshot)}`,
          );
          endedBy = "checkpoint";
          logger.warn(
            { botId, kind: action.kind, endpoint: action.metricEndpoint },
            "[bot-warmer] checkpoint/auth issue hit; stopping warm session",
          );
          break;
        }
        if (consecutiveFailures >= 3 || kind === "auth") {
          endedBy = "failure_limit";
          break;
        }
      }

      if (i < actionBudget - 1) {
        if (await jitterSleep() === "shutdown") { endedBy = "shutdown"; break; }
      }
    }
  } finally {
    try {
      await (
        client as unknown as { close: () => Promise<void> | void }
      ).close?.();
    } catch (closeErr) {
      logger.warn(
        { botId, err: closeErr },
        "[bot-warmer] client close failed",
      );
    }
  }

  // Advancement policy: bump warming_day by 1 if at least one action
  // succeeded AND we're not already at the cap. This prevents a fully
  // blocked bot from graduating just because the scheduler ran.
  const shouldAdvance =
    actionsCompleted > 0 && bot.warming_day < MAX_WARMING_DAY;
  const advancedToDay = shouldAdvance
    ? Math.min(MAX_WARMING_DAY, bot.warming_day + 1)
    : bot.warming_day;

  await persistAdvancement(botId, advancedToDay, snapshot);

  // Only an explicit authentication/checkpoint outcome may extend the saved
  // session's rejection streak. Network failures, generic HTTP failures and
  // throttles neither clear nor extend it. A successful action still clears
  // it, and the checkpoint cooldown above remains in force independently.
  const failedSession = actionsFailed > 0 && endedBy === "checkpoint";
  if (actionsCompleted > 0 || failedSession) {
    // Increment/reset and expiry share one conditional write. A result from the
    // old client must never overwrite a replacement session or an admin hold,
    // even if that replacement landed after the action's lease was released.
    const result = (await db.execute(sql`
      UPDATE bot_accounts SET
        warm_failure_streak = CASE WHEN ${actionsCompleted > 0} THEN 0 ELSE warm_failure_streak + 1 END,
        status = CASE WHEN ${actionsCompleted === 0} AND warm_failure_streak + 1 >= ${DEAD_SESSION_STREAK}
          THEN 'session_expired'::bot_status ELSE status END,
        updated_at = NOW()
      WHERE id = ${botId} AND status = 'available' AND ${warmSessionSnapshotPredicate(snapshot)}
      RETURNING warm_failure_streak, status
    `)) as unknown as { rows: { warm_failure_streak: number; status: string }[] };
    const updated = result?.rows?.[0];
    if (updated?.status === "session_expired") {
      logger.warn(
        { botId, igUsername: bot.ig_username, streak: updated.warm_failure_streak },
        "[bot-warmer] dead session; marked session_expired for relogin",
      );
    }
  }

  const ended = new Date();
  logger.info(
    {
      botId,
      igUsername: bot.ig_username,
      actionsCompleted,
      actionsFailed,
      endedBy,
      previousDay: bot.warming_day,
      advancedToDay,
      durationMs: ended.getTime() - started.getTime(),
    },
    "[bot-warmer] warm session complete",
  );

  return {
    botId,
    started,
    ended,
    actionsCompleted,
    actionsFailed,
    advancedToDay,
    endedBy,
  };
}

// ─── Read-side helpers (consumed by admin status endpoint) ─────────────────

export interface WarmingStatusRow {
  readonly botId: string;
  readonly igUsername: string;
  readonly warmingDay: number;
  readonly lastWarmingAt: string | null;
  readonly daysUntilFullyWarmed: number;
}

export async function getWarmingStatus(): Promise<ReadonlyArray<WarmingStatusRow>> {
  const result = (await db.execute(sql`
    SELECT id, ig_username, warming_day, last_warming_at
    FROM bot_accounts
    ORDER BY warming_day ASC, ig_username ASC
  `)) as unknown as {
    rows: ReadonlyArray<{
      id: string;
      ig_username: string;
      warming_day: number;
      last_warming_at: Date | string | null;
    }>;
  };

  return result.rows.map((row) => ({
    botId: row.id,
    igUsername: row.ig_username,
    warmingDay: row.warming_day,
    lastWarmingAt:
      row.last_warming_at instanceof Date
        ? row.last_warming_at.toISOString()
        : (row.last_warming_at as string | null),
    daysUntilFullyWarmed: Math.max(0, MAX_WARMING_DAY - row.warming_day),
  }));
}

/**
 * Returns the bots that are still in the warming ramp AND haven't run a
 * scrape (either real or warming) within the cooldown window — these are the
 * candidates the scheduler should enqueue. Bots that did real scraping
 * recently are skipped to avoid double-burning their daily request budget.
 */
export interface WarmingCandidate {
  readonly botId: string;
  readonly igUsername: string;
  readonly warmingDay: number;
}

export async function findWarmingCandidates(
  scrapeCooldownMs: number = 60 * 60 * 1000,
): Promise<ReadonlyArray<WarmingCandidate>> {
  const cutoff = new Date(Date.now() - scrapeCooldownMs).toISOString();
  const result = (await db.execute(sql`
    SELECT id, ig_username, warming_day
    FROM bot_accounts
    WHERE warming_day < ${MAX_WARMING_DAY}
      AND last_login_at IS NOT NULL
      AND tier IN ('canary', 'worker')
      AND status = 'available'
      AND automation_identity IS NOT NULL
      -- No fresh-lane precondition here: lanes are allocated lazily by
      -- ensureBotReady (the same path collection uses) and warmBot skips the
      -- bot when the rotation guard refuses. Only a known-rotating explicit
      -- proxy_url is excluded, because the runtime rejects it before any request.
      AND (
        proxy_url IS NULL
        OR proxy_url !~* ${KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX}
      )
      AND (last_used_at IS NULL OR last_used_at < ${cutoff})
      AND (last_warming_at IS NULL OR last_warming_at < ${cutoff})
      -- timed-cooldown reasons (prefixed) are not verdicts; cooldown_until gates them
      AND (COALESCE(last_login_error, '') LIKE ${COOLDOWN_REASON_PREFIX + '%'}
           OR ((last_login_error IS NULL OR last_login_error NOT LIKE 'checkpoint_required%')
               AND COALESCE(last_login_error, '') !~* 'rate limited|retry-after|auth rejected|csrf token'))
      AND (cooldown_until IS NULL OR cooldown_until < NOW())
    ORDER BY warming_day ASC, ig_username ASC
  `)) as unknown as {
    rows: ReadonlyArray<{
      id: string;
      ig_username: string;
      warming_day: number;
    }>;
  };
  return result.rows.map((row) => ({
    botId: row.id,
    igUsername: row.ig_username,
    warmingDay: row.warming_day,
  }));
}

export const __testing = {
  ACTIONS_BY_INTENSITY,
  MAX_WARMING_DAY,
  DEFAULT_WARM_THROTTLE_COOLDOWN_MS,
  DECOYS,
  actionMenu,
  baseActions,
  intensityForWarmingDay,
  classifyError,
  warmThrottleCooldownMs,
};
