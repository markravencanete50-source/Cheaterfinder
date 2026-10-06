// ─── Bot cooldown helpers — checkpoint + rate-limit cooling ──────────────────
//
// Wave 4: when an IG call comes back with a hard signal (checkpoint_required,
// 403 forbidden, 429 rate-limit) the affected bot needs to step out of the
// pool for a while. This module owns the single write point that updates
// `bot_accounts.cooldown_until` + `last_login_error` so the LRU lease layer
// stops handing the bot out until the cooldown window has elapsed.
//
// Splitting this from bot-collectors.ts keeps the cooldown policy reusable by
// the public scraper (which has no follow-request context) and the private
// follow flow (bot-collectors), and gives us one place to evolve the policy
// (jitter, escalating cooldowns, paging an admin, etc.) without touching call
// sites.
// ─────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "../db.js";
import { botAccounts } from "../../shared/schema.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "bot-cooldown" });

const HOUR_MS = 60 * 60 * 1000;
const MAX_ERROR_LEN = 500;

// ── Rotation-context rate-limit cooldown policy (fix A4) ─────────────────────
//
// Default policy: a 429 parks the bot for IG_RATE_LIMIT_COOLDOWN_MIN_MS
// (floor 4h). That is correct when the caller will NOT retry with another
// bot — the 429 is treated as a pool-wide throttle signal and the job defers.
//
// Rotation context: public-data-service deliberately retries a rate-limited
// profile fetch with a different bot (small budget + pool-wide guard). In
// that case the 429 is not yet proven pool-wide, and parking every
// rotated-past bot for 4h turns ONE throttled fetch into "N bots × 4h" of
// lost pool capacity. The service wraps those attempts in
// `withRotationRateLimitCooldownPolicy`, which switches to a short cooldown:
// honor the upstream Retry-After when present (min 60s), else fall back to
// PROFILE_ROTATION_COOLDOWN_MS (default 20 min; recommended 15-30 min).
// IG_RATE_LIMIT_ROTATION_COOLDOWN_MS is accepted as a legacy alias.
//
// AsyncLocalStorage is used because the cooldown write happens deep inside
// ig-public-scraper (applyBotCooldown), which has no parameter path from the
// service layer — the policy rides the async call chain instead.

const DEFAULT_ROTATION_RATE_LIMIT_FLOOR_MS = 20 * 60 * 1000; // 20 min

interface RateLimitCooldownPolicy {
  readonly floorMs: number;
}

const rateLimitCooldownPolicy = new AsyncLocalStorage<RateLimitCooldownPolicy>();

function rotationFloorMs(): number {
  const configured = Number(
    process.env.PROFILE_ROTATION_COOLDOWN_MS ??
      process.env.IG_RATE_LIMIT_ROTATION_COOLDOWN_MS ??
      "",
  );
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(configured, 60_000);
  }
  return DEFAULT_ROTATION_RATE_LIMIT_FLOOR_MS;
}

function defaultRateLimitFloorMs(): number {
  const configuredFloorMs = Number(
    process.env.IG_RATE_LIMIT_COOLDOWN_MIN_MS ?? String(4 * HOUR_MS),
  );
  return Number.isFinite(configuredFloorMs) && configuredFloorMs > 0
    ? Math.max(configuredFloorMs, 60_000)
    : 4 * HOUR_MS;
}

/**
 * Run `fn` with the short rotation-context rate-limit cooldown policy active.
 * Any `cooldownBotForRateLimit` call made (transitively) inside `fn` uses the
 * short floor instead of the 4h pool-wide default.
 */
export function withRotationRateLimitCooldownPolicy<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return rateLimitCooldownPolicy.run({ floorMs: rotationFloorMs() }, fn);
}

/**
 * Resolve the effective cooldown for a 429.
 *
 * Two-tier policy:
 *   - rotation context (caller retries with a different bot): honor the
 *     upstream Retry-After when present — even when it is SHORTER than the
 *     rotation default — clamped to a 60s minimum; with no Retry-After fall
 *     back to the short rotation default (PROFILE_ROTATION_COOLDOWN_MS).
 *   - default / pool-wide context: Retry-After extends but never undercuts
 *     the long floor (IG_RATE_LIMIT_COOLDOWN_MIN_MS, default 4h).
 *
 * Exported for unit tests.
 */
export function resolveRateLimitCooldownMs(retryAfterMs: number): {
  readonly effectiveMs: number;
  readonly rotationContext: boolean;
} {
  const policy = rateLimitCooldownPolicy.getStore();
  const hasRetryAfter = Number.isFinite(retryAfterMs) && retryAfterMs > 0;
  if (policy !== undefined) {
    const effectiveMs = hasRetryAfter
      ? Math.max(retryAfterMs, 60_000)
      : policy.floorMs;
    return { effectiveMs, rotationContext: true };
  }
  const floorMs = defaultRateLimitFloorMs();
  const ms = hasRetryAfter ? retryAfterMs : floorMs;
  return { effectiveMs: Math.max(ms, floorMs), rotationContext: false };
}

function clampReason(reason: string): string {
  if (!reason) return "(no reason)";
  return reason.length > MAX_ERROR_LEN ? reason.slice(0, MAX_ERROR_LEN) : reason;
}

/**
 * Cool down a bot for `hours` (default 24) because IG served a checkpoint /
 * forbidden / similar hard semantic block. Records the reason on
 * `last_login_error` so admin tooling can surface it.
 */
/**
 * Reasons that mark a bot as PERMANENTLY unleasable until a relogin clears them.
 * Single source of truth: `leaseBot` interpolates this into SQL and the tests
 * assert every timed-cooldown reason stays clear of it.
 */
export const BAN_REASON_SQL_REGEX =
  "auth rejected|csrf token|sessionid cookie|csrftoken cookie|checkpoint|required|suspended|rejected username/password|login information .* incorrect";

/**
 * Marker for reasons that describe a TIMED cooldown, not a verdict. Before
 * this, `cooldownBotForCheckpoint` stored the raw IG message ("…checkpoint_
 * required…", "auth rejected (status 401)…") in the same column `leaseBot`
 * reads as a ban list, so every 12h/24h cooldown silently became a permanent
 * exclusion with status='available' — 10 of 35 leasable web bots were zombied
 * that way by 2026-09-02, invisible to every status count.
 */
export const COOLDOWN_REASON_PREFIX = "cooldown: ";

export function formatCooldownReason(reason: string): string {
  const trimmed = reason.trim();
  return trimmed.startsWith(COOLDOWN_REASON_PREFIX)
    ? trimmed
    : `${COOLDOWN_REASON_PREFIX}${trimmed}`;
}

export async function cooldownBotForCheckpoint(
  botId: string,
  reason: string,
  hours = 24,
  ifCurrent?: SQL,
): Promise<void> {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      `[bot-cooldown] cooldownBotForCheckpoint: invalid hours=${hours}`,
    );
  }
  const now = new Date();
  const until = new Date(now.getTime() + hours * HOUR_MS);
  const safeReason = clampReason(formatCooldownReason(reason));

  logger.warn(
    { botId, hours, until: until.toISOString(), reason: safeReason },
    "[bot-cooldown] checkpoint cooldown",
  );

  await db
    .update(botAccounts)
    .set({
      cooldownUntil: until,
      lastLoginError: safeReason,
      updatedAt: now,
    })
    // A delayed worker can require its observed session/identity to still match.
    // Such a write also preserves any stronger hold installed since its read.
    .where(ifCurrent
      ? and(eq(botAccounts.id, botId), ifCurrent,
        or(isNull(botAccounts.cooldownUntil), lt(botAccounts.cooldownUntil, until)))
      : eq(botAccounts.id, botId));
}

/**
 * Cool down a bot after a 429. The duration depends on context (see
 * `resolveRateLimitCooldownMs`): pool-wide default keeps the long 4h floor;
 * rotation context honors the upstream Retry-After (min 60s) or the short
 * rotation default — see `withRotationRateLimitCooldownPolicy` above.
 */
export async function cooldownBotForRateLimit(
  botId: string,
  retryAfterMs: number,
  ifCurrent?: SQL,
): Promise<void> {
  const { effectiveMs, rotationContext } =
    resolveRateLimitCooldownMs(retryAfterMs);
  const now = new Date();
  const until = new Date(now.getTime() + effectiveMs);

  logger.warn(
    {
      botId,
      retryAfterMs: effectiveMs,
      rotationContext,
      until: until.toISOString(),
    },
    "[bot-cooldown] rate-limit cooldown",
  );

  await db
    .update(botAccounts)
    .set({
      cooldownUntil: until,
      // Prefixed like every timed cooldown: the warmer's candidate query excludes
        // 'rate limited|retry-after' and, unprefixed, kept excluding the bot after
        // its cooldown expired.
        lastLoginError: formatCooldownReason(
          `rate limited; retry-after=${effectiveMs}ms${rotationContext ? " (rotation)" : ""}`,
        ),
      updatedAt: now,
    })
    // Preserve both the expiry and reason of a stronger active hold.
    .where(and(eq(botAccounts.id, botId), ...(ifCurrent ? [ifCurrent] : []),
      or(isNull(botAccounts.cooldownUntil), lt(botAccounts.cooldownUntil, until))));
}

// ── Dead-session escalation (consecutive hard-failure streak) ────────────────
//
// A bot whose IG session is dead answers EVERY lease with the same auth-class
// refusal (mobile 401/403, HTTP 400 checkpoint/challenge_required, a login-wall
// HTML page on likers) and, before this, was only ever parked for a flat
// 10-30 minutes. Three such bots alone burned ~450 doomed IG calls a day. The
// scraper now records every hard failure in `bot_accounts.consecutive_hard_
// failures` (migration 0044), resets it on any success, and escalates the
// timed cooldown as the streak grows. Rate limits and network faults never
// count — they say nothing about the session.
//
// Streak → cooldown policy (pure, exported for tests):
//   1-2  : existing per-branch behaviour, no escalation
//   3-5  : 6h prefixed cooldown
//   ≥6   : 24h prefixed cooldown; a MOBILE session is additionally parked as
//          status='session_expired' with an UNPREFIXED verdict, because a
//          bought Bearer session cannot be re-logged in — only re-imported.

export type BotTransport = "web" | "mobile";

export interface HardFailureEscalation {
  readonly cooldownHours: number | null;
  readonly markSessionExpired: boolean;
}

const ESCALATION_MID_STREAK = 3;
const ESCALATION_HIGH_STREAK = 6;
const ESCALATION_MID_HOURS = 6;
const ESCALATION_HIGH_HOURS = 24;

export function escalationForStreak(
  streak: number,
  transport: BotTransport,
): HardFailureEscalation {
  if (!Number.isFinite(streak) || streak < ESCALATION_MID_STREAK) {
    return { cooldownHours: null, markSessionExpired: false };
  }
  if (streak < ESCALATION_HIGH_STREAK) {
    return { cooldownHours: ESCALATION_MID_HOURS, markSessionExpired: false };
  }
  return {
    cooldownHours: ESCALATION_HIGH_HOURS,
    markSessionExpired: transport === "mobile",
  };
}

function rowsOf<T>(result: unknown): ReadonlyArray<T> {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Increment the bot's consecutive hard-failure streak and return the new
 * value. Throws if the column is missing (migration 0044 not applied) — the
 * scraper treats that as "no escalation" and keeps the legacy behaviour.
 */
export async function recordHardFailure(botId: string): Promise<number> {
  const result = await db.execute(sql`
    UPDATE bot_accounts SET
      consecutive_hard_failures = consecutive_hard_failures + 1,
      last_hard_failure_at = NOW(),
      updated_at = NOW()
    WHERE id = ${botId}
    RETURNING consecutive_hard_failures
  `);
  const [row] = rowsOf<{ consecutive_hard_failures: number | string }>(result);
  const streak = Number(row?.consecutive_hard_failures ?? 0);
  return Number.isFinite(streak) ? streak : 0;
}

/**
 * A successful IG call proves the session is alive: clear the streak. The
 * WHERE guard makes the common case (streak already 0) a no-op row-wise.
 */
export async function resetHardFailureStreak(botId: string): Promise<void> {
  await db.execute(sql`
    UPDATE bot_accounts SET
      consecutive_hard_failures = 0,
      updated_at = NOW()
    WHERE id = ${botId} AND consecutive_hard_failures <> 0
  `);
}

/**
 * Apply the escalation chosen by `escalationForStreak`. Returns the decision
 * so callers can log it. Runs AFTER the per-branch cooldown write, so the
 * escalated window and reason override the flat one.
 */
export async function applyHardFailureEscalation(
  botId: string,
  transport: BotTransport,
  streak: number,
  reason: string,
): Promise<HardFailureEscalation> {
  const decision = escalationForStreak(streak, transport);
  if (decision.cooldownHours === null) return decision;

  const now = new Date();
  const until = new Date(now.getTime() + decision.cooldownHours * HOUR_MS);
  if (decision.markSessionExpired) {
    // Verdict, not a timed cooldown: unprefixed on purpose and paired with a
    // status change so the lease query stops selecting the row outright.
    const verdict = clampReason(
      `mobile session dead: ${streak} consecutive auth failures`,
    );
    logger.warn(
      { botId, streak, transport, reason: verdict },
      "[bot-cooldown] hard-failure streak; parking mobile session as expired",
    );
    await db
      .update(botAccounts)
      .set({
        status: "session_expired",
        cooldownUntil: until,
        lastLoginError: verdict,
        updatedAt: now,
      })
      .where(eq(botAccounts.id, botId));
    return decision;
  }

  const safeReason = clampReason(
    formatCooldownReason(`hard-failure streak ${streak}: ${reason}`),
  );
  logger.warn(
    { botId, streak, transport, hours: decision.cooldownHours, until: until.toISOString() },
    "[bot-cooldown] hard-failure streak; escalating cooldown",
  );
  await db
    .update(botAccounts)
    .set({
      cooldownUntil: until,
      lastLoginError: safeReason,
      updatedAt: now,
    })
    .where(eq(botAccounts.id, botId));
  return decision;
}

// ── Relogin back-off (bot-runtime L3 + relogin sweeper L4) ───────────────────
//
// A transport/timeout/navigation failure during an automation login is not a
// verdict on the account, but re-driving Firefox through the same lane every
// lease is the fastest way to get one flagged. Back off geometrically on the
// row's login_attempt_count: 2h, 4h, 8h, then a flat 16h.

const RELOGIN_BACKOFF_BASE_MS = 2 * HOUR_MS;
const RELOGIN_BACKOFF_MAX_EXPONENT = 3;

export function reloginBackoffMs(attempts: number): number {
  const safe = Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0;
  const exponent = Math.min(safe, RELOGIN_BACKOFF_MAX_EXPONENT);
  return RELOGIN_BACKOFF_BASE_MS * 2 ** exponent;
}
