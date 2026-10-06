// ─── Force re-login for the entire bot pool ────────────────────────────────
//
// One-shot recovery script invoked when every bot has an invalid session
// (CSRF rejected, checkpoint required, etc). Walks every previously-seeded
// bot, nulls its session_data + proxy_endpoint + cooldown_until, then drives
// a fresh ensureBotReady() which fetches a new sticky proxy and runs the
// Playwright auto-login pipeline. Writes the new encrypted session_data
// back to the row via the existing pipeline.
//
// Sequential (concurrency 1) so we don't hammer Smartproxy / the IG login
// surface with 7 simultaneous Chromium browsers.
//
// Run with:
//   npx tsx server/scripts/force-relogin-pool.ts
//
// Env required (same as runtime):
//   DATABASE_URL, BOT_CRED_KEY, SMARTPROXY_USER, SMARTPROXY_PASS, ...
// ───────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { proxyEndpointLabel } from "../services/proxy-provider.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "force-relogin-pool" });

interface PoolBotRow {
  id: string;
  ig_username: string;
}

interface BotOutcome {
  igUsername: string;
  ok: boolean;
  reason: string;
  durationMs: number;
}

async function listBots(): Promise<readonly PoolBotRow[]> {
  // last_login_at IS NOT NULL filters to bots we've actually attempted to
  // log in before. Freshly-seeded rows that haven't been driven through
  // login at all should not be force-relogged from this script.
  const result = (await db.execute(sql`
    SELECT id, ig_username
    FROM bot_accounts
    WHERE last_login_at IS NOT NULL
    ORDER BY ig_username
  `)) as unknown as { rows: PoolBotRow[] };
  return result.rows;
}

async function resetBot(botId: string): Promise<void> {
  await db.execute(sql`
    UPDATE bot_accounts SET
      session_data = NULL,
      proxy_endpoint = NULL,
      proxy_session_id = NULL,
      proxy_expires_at = NULL,
      cooldown_until = NULL,
      updated_at = NOW()
    WHERE id = ${botId}
  `);
}

async function forceReloginOne(bot: PoolBotRow): Promise<BotOutcome> {
  const start = Date.now();
  try {
    await resetBot(bot.id);
    logger.info(
      { botId: bot.id, username: bot.ig_username },
      "[force-relogin] reset row, driving ensureBotReady",
    );
    const ctx = await ensureBotReady(bot.id);
    const durationMs = Date.now() - start;
    logger.info(
      {
        botId: bot.id,
        username: bot.ig_username,
        proxyEndpoint: proxyEndpointLabel(ctx.proxyEndpoint),
        durationMs,
      },
      "[force-relogin] success",
    );
    return {
      igUsername: bot.ig_username,
      ok: true,
      reason: `success via ${proxyEndpointLabel(ctx.proxyEndpoint)}`,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        botId: bot.id,
        username: bot.ig_username,
        durationMs,
        err: reason,
      },
      "[force-relogin] failed",
    );
    return {
      igUsername: bot.ig_username,
      ok: false,
      reason: reason.slice(0, 200),
      durationMs,
    };
  }
}

async function main(): Promise<void> {
  const bots = await listBots();
  if (bots.length === 0) {
    logger.warn("[force-relogin] no bots with last_login_at IS NOT NULL");
    return;
  }
  logger.info({ count: bots.length }, "[force-relogin] starting sequential pass");

  const outcomes: BotOutcome[] = [];
  for (const bot of bots) {
    // Sequential: never two browsers at once.
    const outcome = await forceReloginOne(bot);
    outcomes.push(outcome);
  }

  const ok = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - ok;
  logger.info(
    { total: outcomes.length, ok, failed },
    "[force-relogin] pass complete",
  );

  // Print a per-bot table so the operator can see at a glance which bots
  // recovered and which need manual IG account intervention.
  for (const o of outcomes) {
    const tag = o.ok ? "PASS" : "FAIL";
    // eslint-disable-next-line no-console
    console.log(
      `[force-relogin] ${tag} @${o.igUsername} (${o.durationMs}ms) — ${o.reason}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "[force-relogin] FAILED",
    );
    process.exit(1);
  },
);
