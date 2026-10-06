// Recover only bots that currently have no session_data.
//
// Unlike force-relogin-pool.ts, this script does not wipe working sessions.
// It walks available bots with credentials but missing sessions, drives the
// normal ensureBotReady() login path, and leaves successful encrypted
// session_data on the row.

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { proxyEndpointLabel } from "../services/proxy-provider.js";

interface BotRow {
  id: string;
  ig_username: string;
  tier: string;
}

async function listMissingSessionBots(limit: number): Promise<BotRow[]> {
  const gmailOnly = String(process.env.RECOVER_GMAIL_ONLY ?? "false").toLowerCase() === "true";
  const result = (await db.execute(sql`
    SELECT id, ig_username, tier
    FROM bot_accounts
    WHERE status = 'available'
      AND session_data IS NULL
      AND ig_password_encrypted IS NOT NULL
      AND totp_secret IS NOT NULL
      AND imap_host IS NULL
      AND (${gmailOnly} = false OR ig_username ILIKE '%@gmail.com')
      AND COALESCE(last_login_error, '') !~* 'account .* suspended|login flow stuck on unknown screen|rejected username/password|login information .* incorrect'
      AND (
        cooldown_until IS NULL
        OR cooldown_until <= NOW()
      )
    ORDER BY
      CASE
        WHEN tier = 'reserve' THEN 0
        WHEN tier = 'worker' THEN 1
        WHEN tier = 'canary' THEN 2
        ELSE 3
      END,
      last_used_at ASC NULLS FIRST
    LIMIT ${limit}
  `)) as unknown as { rows: BotRow[] };
  return result.rows;
}

async function main(): Promise<void> {
  const limitArg = Number(process.argv[2] ?? "5");
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : 5;
  const bots = await listMissingSessionBots(limit);
  console.log(`[recover-sessions] candidates=${bots.length}`);

  let ok = 0;
  let failed = 0;
  for (const bot of bots) {
    const start = Date.now();
    try {
      const ctx = await ensureBotReady(bot.id);
      ok += 1;
      console.log(
        `[recover-sessions] PASS @${bot.ig_username} tier=${bot.tier} proxy=${proxyEndpointLabel(ctx.proxyEndpoint)} ms=${Date.now() - start}`,
      );
    } catch (err) {
      failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      console.log(
        `[recover-sessions] FAIL @${bot.ig_username} tier=${bot.tier} ms=${Date.now() - start} reason=${reason.slice(0, 240)}`,
      );
    }
  }

  console.log(`[recover-sessions] done ok=${ok} failed=${failed}`);
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
