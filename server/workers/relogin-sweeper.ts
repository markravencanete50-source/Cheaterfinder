// ─── Relogin sweeper — recover parked web bots ───────────────────────────────
//
// `autoLogin` only ever ran inside `ensureBotReady`, which only runs on lease,
// and `leaseBot` selects `status='available'` — so nothing ever selected a
// `session_expired` row and 60 web bots (54 with TOTP, 57 with a Firefox
// automation identity) were parked forever. This sweep re-drives the existing
// automation login for a SMALL batch of them per tick, spaced 30-90 s apart,
// and stops the whole run the moment IG answers with a suspension/checkpoint —
// logins are the most ban-prone moment we have, so the run is deliberately
// slow and deliberately quits early.
//
// Wiring: `server/workers.ts` calls `runReloginSweep()` on a
// `readReloginSweepMs()` interval behind RELOGIN_SWEEP_ENABLED. Nothing here
// touches BullMQ.
//
// All login logic lives in bot-runtime (`reloginParkedBot`); this module only
// selects candidates, paces the run, and decides when to stop.
// ─────────────────────────────────────────────────────────────────────────────

import { sql, type SQL } from "drizzle-orm";

import { db } from "../db.js";
import { logger as baseLogger } from "../observability/logger.js";
import { reloginParkedBot, RELOGIN_TERMINAL_REASON_PATTERNS, type ReloginOutcome } from "../services/bot-runtime.js";

export { reloginBackoffMs } from "../services/bot-cooldown.js";
export { RELOGIN_TERMINAL_REASON_PATTERNS } from "../services/bot-runtime.js";

const logger = baseLogger.child({ module: "worker:relogin-sweeper" });

export const DEFAULT_RELOGIN_SWEEP_SEC = 1_800;
const MIN_RELOGIN_SWEEP_SEC = 300; // 5 min — below this the run never finishes its own delays
const MAX_RELOGIN_SWEEP_SEC = 86_400; // 24h

export const DEFAULT_RELOGIN_BATCH = 2;
export const MAX_RELOGIN_BATCH = 5;

/** Human-paced gap between two login attempts in one run. */
export const INTER_BOT_DELAY_MIN_MS = 30_000;
export const INTER_BOT_DELAY_MAX_MS = 90_000;

/**
 * Sweep cadence in ms from RELOGIN_SWEEP_SEC, clamped. An unparseable value
 * falls back to the default rather than disabling the sweep.
 */
export function readReloginSweepMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RELOGIN_SWEEP_SEC ?? DEFAULT_RELOGIN_SWEEP_SEC);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RELOGIN_SWEEP_SEC * 1000;
  const clamped = Math.min(
    MAX_RELOGIN_SWEEP_SEC,
    Math.max(MIN_RELOGIN_SWEEP_SEC, Math.floor(raw)),
  );
  return clamped * 1000;
}

/** Bots per run from RELOGIN_SWEEP_BATCH: default 2, clamped to 1..5. */
export function readReloginBatch(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RELOGIN_SWEEP_BATCH ?? DEFAULT_RELOGIN_BATCH);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RELOGIN_BATCH;
  return Math.min(MAX_RELOGIN_BATCH, Math.max(1, Math.floor(raw)));
}

/** Uniform 30-90 s; `rng` is injectable for tests. */
export function interBotDelayMs(rng: () => number = Math.random): number {
  const span = INTER_BOT_DELAY_MAX_MS - INTER_BOT_DELAY_MIN_MS;
  const r = Math.min(1, Math.max(0, rng()));
  return Math.round(INTER_BOT_DELAY_MIN_MS + r * span);
}

/**
 * Candidate query, exported so tests can assert the predicate. Only parked
 * ('session_expired') WEB bots with a TOTP secret and a Firefox automation
 * identity, outside any cooldown, whose last error is not a terminal verdict.
 * Local setup failures receive a cooldown so one row cannot monopolise the
 * oldest-updated window; rows with no password are excluded outright. The
 * tier filter is a deliberate tightening beyond the brief: `leaseBot` only
 * ever hands out worker/canary rows, so re-logging a reserve bot would spend a
 * login (the most ban-prone action) on an account nothing can use.
 */
export function buildReloginCandidateSql(limit: number): SQL {
  const safeLimit = Math.min(MAX_RELOGIN_BATCH, Math.max(1, Math.floor(limit)));
  return sql`
    SELECT id, ig_username
    FROM bot_accounts
    WHERE status = 'session_expired'
      AND transport = 'web'
      AND tier IN ('canary', 'worker')
      AND totp_secret IS NOT NULL
      AND NULLIF(BTRIM(totp_secret), '') IS NOT NULL
      AND NULLIF(BTRIM(ig_password_encrypted), '') IS NOT NULL
      AND automation_identity IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until < NOW())
      AND (
        last_login_error IS NULL
        OR last_login_error NOT ILIKE ALL (${sql.param([...RELOGIN_TERMINAL_REASON_PATTERNS])}::text[])
      )
    ORDER BY updated_at ASC
    LIMIT ${safeLimit}
  `;
}

/**
 * After a failed attempt, decide whether the run must stop: IG suspended or
 * checkpointed the account (bot-runtime routes a suspension to
 * status='banned'; a checkpoint/challenge/captcha surfaces in the reason).
 */
export function isStopSignal(
  status: string | null | undefined,
  lastLoginError: string | null | undefined,
): boolean {
  if (status === "banned") return true;
  const reason = (lastLoginError ?? "").toLowerCase();
  return /suspend|checkpoint|challenge|captcha/.test(reason);
}

export interface ReloginSweepResult {
  readonly scanned: number;
  readonly attempted: number;
  readonly recovered: number;
  readonly skipped: number;
}

interface CandidateRow {
  readonly id: string;
  readonly ig_username: string;
}

interface VerdictRow {
  readonly status: string | null;
  readonly last_login_error: string | null;
}

function rowsOf<T>(result: unknown): ReadonlyArray<T> {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
}

async function loadCandidates(limit: number): Promise<ReadonlyArray<CandidateRow>> {
  const result = await db.execute(buildReloginCandidateSql(limit));
  return rowsOf<CandidateRow>(result);
}

async function loadVerdict(botId: string): Promise<VerdictRow | null> {
  const result = await db.execute(sql`
    SELECT status, last_login_error FROM bot_accounts WHERE id = ${botId}
  `);
  return rowsOf<VerdictRow>(result)[0] ?? null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Injection points for tests; production callers pass nothing. */
export interface ReloginSweepDeps {
  readonly relogin?: (botId: string) => Promise<ReloginOutcome>;
  readonly candidates?: (limit: number) => Promise<ReadonlyArray<CandidateRow>>;
  readonly verdict?: (botId: string) => Promise<VerdictRow | null>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly delayMs?: () => number;
  readonly batch?: number;
}

let sweepInFlight = false;

/**
 * One sweep: up to `batch` candidates, 30-90 s apart, stopping on the first
 * suspension/checkpoint. Re-entrancy guarded — a slow login must not overlap
 * the next interval tick.
 */
export async function runReloginSweep(
  deps: ReloginSweepDeps = {},
): Promise<ReloginSweepResult> {
  const relogin = deps.relogin ?? reloginParkedBot;
  const candidates = deps.candidates ?? loadCandidates;
  const verdict = deps.verdict ?? loadVerdict;
  const sleep = deps.sleep ?? defaultSleep;
  const delayMs = deps.delayMs ?? interBotDelayMs;
  const batch = deps.batch ?? readReloginBatch();

  if (sweepInFlight) {
    logger.info("[relogin-sweep] previous run still in flight; skipping tick");
    return { scanned: 0, attempted: 0, recovered: 0, skipped: 0 };
  }
  sweepInFlight = true;
  try {
    const rows = await candidates(batch);
    let attempted = 0;
    let recovered = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      let outcome: ReloginOutcome;
      let unrecordedFailure = false;
      try {
        outcome = await relogin(row.id);
      } catch (err) {
        // A thrown error can also mean a verdict could not be persisted after
        // network I/O. Its safety is unknown; do not try the next identity.
        logger.error(
          { botId: row.id, username: row.ig_username, err: err instanceof Error ? err.message : String(err) },
          "[relogin-sweep] relogin threw",
        );
        outcome = "failed";
        unrecordedFailure = true;
      }

      if (outcome === "skipped") {
        skipped += 1;
      } else {
        attempted += 1;
        if (outcome === "recovered") recovered += 1;
      }
      logger.info(
        { botId: row.id, username: row.ig_username, outcome, position: i + 1, of: rows.length },
        "[relogin-sweep] bot processed",
      );

      if (outcome === "failed") {
        const v = await verdict(row.id).catch(() => null);
        if (unrecordedFailure || !v || isStopSignal(v.status, v.last_login_error)) {
          const remaining = rows.length - (i + 1);
          skipped += remaining;
          logger.warn(
            {
              botId: row.id,
              username: row.ig_username,
              status: v?.status ?? null,
              reason: v?.last_login_error?.slice(0, 160) ?? null,
              remaining,
            },
            "[relogin-sweep] unsafe or unavailable login verdict; stopping this run",
          );
          break;
        }
      }

      if (i < rows.length - 1) {
        await sleep(delayMs());
      }
    }

    const result = { scanned: rows.length, attempted, recovered, skipped };
    logger.info(result, "[relogin-sweep] run complete");
    return result;
  } finally {
    sweepInFlight = false;
  }
}

export const __testing = {
  MIN_RELOGIN_SWEEP_SEC,
  MAX_RELOGIN_SWEEP_SEC,
};
