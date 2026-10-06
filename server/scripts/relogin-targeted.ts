// ─── Targeted re-login for a subset of the bot pool ────────────────────────
//
// Like force-relogin-pool.ts but filtered to a specific status (and optional
// limit) so we can (a) validate the login pipeline on expendable
// session_expired bots before touching healthy ones, and (b) refresh only the
// "available" bots' stale csrftokens without driving banned accounts.
//
// Run with:
//   STATUS=session_expired LIMIT=6 npx tsx server/scripts/relogin-targeted.ts
//   STATUS=available LIMIT=40 npx tsx server/scripts/relogin-targeted.ts
//
// Env: DATABASE_URL, BOT_CRED_KEY, proxy + IMAP creds (same as runtime).
// ───────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { proxyEndpointLabel } from "../services/proxy-provider.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "relogin-targeted" });

const STATUS = process.env.STATUS ?? "session_expired";
const LIMIT = Math.max(1, Number(process.env.LIMIT ?? "6") || 6);

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
  const result = (await db.execute(sql`
    SELECT id, ig_username
    FROM bot_accounts
    WHERE status = ${STATUS}
      AND last_login_at IS NOT NULL
      AND ig_password_encrypted IS NOT NULL
    ORDER BY ig_username
    LIMIT ${LIMIT}
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

async function reloginOne(bot: PoolBotRow): Promise<BotOutcome> {
  const start = Date.now();
  try {
    await resetBot(bot.id);
    logger.info({ botId: bot.id, username: bot.ig_username }, "reset row, driving ensureBotReady");
    const ctx = await ensureBotReady(bot.id);
    const durationMs = Date.now() - start;
    logger.info(
      { username: bot.ig_username, proxyEndpoint: proxyEndpointLabel(ctx.proxyEndpoint), durationMs },
      "success",
    );
    return { igUsername: bot.ig_username, ok: true, reason: `via ${proxyEndpointLabel(ctx.proxyEndpoint)}`, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ username: bot.ig_username, durationMs, err: reason }, "failed");
    return { igUsername: bot.ig_username, ok: false, reason: reason.slice(0, 200), durationMs };
  }
}

async function main(): Promise<void> {
  const bots = await listBots();
  logger.info({ status: STATUS, limit: LIMIT, count: bots.length }, "starting sequential relogin pass");
  if (bots.length === 0) return;

  const outcomes: BotOutcome[] = [];
  for (const bot of bots) {
    outcomes.push(await reloginOne(bot));
  }

  const ok = outcomes.filter((o) => o.ok).length;
  logger.info({ total: outcomes.length, ok, failed: outcomes.length - ok }, "pass complete");
  for (const o of outcomes) {
    // eslint-disable-next-line no-console
    console.log(`[relogin] ${o.ok ? "PASS" : "FAIL"} @${o.igUsername} (${o.durationMs}ms) — ${o.reason}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, "FAILED");
    process.exit(1);
  },
);
