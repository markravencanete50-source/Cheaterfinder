// ─── Bot pool size monitor ───────────────────────────────────────────────────
//
// Wave 5 task B: ops wants a clear signal when the active bot pool is too
// small to absorb a real load — we recommend ≥5 bots in `available` status
// to keep the assignment loop healthy.
//
// We poll on a 10-minute interval (cheap COUNT(*) query) and emit a warn-
// level structured log line when the pool dips below the threshold. The
// alerting layer (pino → operator dashboard) keys on the
// `module: "bot-pool-monitor"` field.
// ─────────────────────────────────────────────────────────────────────────────

import { eq, count } from "drizzle-orm";
import { db } from "./db.js";
import { botAccounts } from "../shared/schema.js";
import { logger as baseLogger } from "./observability/logger.js";

const logger = baseLogger.child({ module: "bot-pool-monitor" });

/** Pool-size warning threshold. Below this we log a warning every interval. */
export const BOT_POOL_WARN_BELOW = 5;

/** Default check interval — 10 minutes. */
export const BOT_POOL_CHECK_INTERVAL_MS = 10 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single pool-size check. Exported so the seed endpoint can trigger an
 * immediate re-check after the pool changes (without waiting up to 10 min).
 */
export async function checkBotPoolOnce(): Promise<{ active: number }> {
  const [row] = await db
    .select({ count: count() })
    .from(botAccounts)
    .where(eq(botAccounts.status, "available"));

  const active = row?.count ?? 0;

  if (active < BOT_POOL_WARN_BELOW) {
    logger.warn(
      { active, threshold: BOT_POOL_WARN_BELOW },
      `[bot-pool] WARNING: only ${active} active bots, recommend ${BOT_POOL_WARN_BELOW}+`,
    );
  } else {
    logger.debug({ active }, "bot pool size OK");
  }
  return { active };
}

/**
 * Start the periodic pool-size check. Idempotent — calling twice is a no-op.
 * Returns the underlying timer handle so tests can clear it.
 */
export function startBotPoolMonitor(
  intervalMs: number = BOT_POOL_CHECK_INTERVAL_MS,
): void {
  if (timer) return;
  // Fire once at startup so operators see the initial value in logs without
  // waiting for the first interval tick.
  void checkBotPoolOnce().catch((err: unknown) => {
    logger.error({ err }, "initial bot pool check failed");
  });
  timer = setInterval(() => {
    void checkBotPoolOnce().catch((err: unknown) => {
      logger.error({ err }, "scheduled bot pool check failed");
    });
  }, intervalMs);
  // Don't keep the event loop alive just for this check — a graceful
  // shutdown should still terminate.
  if (typeof timer.unref === "function") timer.unref();
}

/** Stop the periodic pool-size check. Used during graceful shutdown / tests. */
export function stopBotPoolMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

