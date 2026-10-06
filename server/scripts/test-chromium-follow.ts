// Drive the REAL Chromium follow flow (playwrightSendFollowByUsername): open the
// target's profile in a headless Chrome carrying the bot's cookies + proxy, move
// the mouse, then find and click the Follow button.
//
// This path exists and is unit-tested, but nothing in production calls it:
// createPlaywrightBotClient.sendFollow only receives a pk, so it logs a
// "pk-only fallback" and hands the write to the HTTP transport instead. Every
// previous "browser follow doesn't work" result was therefore measuring HTTP.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import { playwrightSendFollowByUsername } from "../ig-playwright-client.js";

async function main() {
  const targetUsername = process.argv[2] ?? "sample_account";
  const n = Number(process.argv[3] ?? "2");

  const { rows } = (await db.execute(sql`
    SELECT b.id, b.ig_username, b.proxy_endpoint, b.device_id, b.device_user_agent,
           b.ig_app_id, b.timezone, b.locale, b.awake_hour_start, b.awake_hour_end
      FROM bot_accounts b
     WHERE b.transport='web' AND b.session_data IS NOT NULL
       AND b.automation_identity IS NOT NULL
       AND b.status IN ('available','in_use')
       AND (b.cooldown_until IS NULL OR b.cooldown_until < NOW())
     ORDER BY random() LIMIT ${n}
  `)) as unknown as { rows: Array<Record<string, unknown>> };

  console.log(`[cf] target=@${targetUsername} bots=${rows.length}`);
  for (const b of rows) {
    const botId = String(b.id);
    const igUsername = String(b.ig_username);
    try {
      const ready = await ensureBotReady(botId);
      const res = await playwrightSendFollowByUsername({
        sessionData: ready.sessionData,
        fingerprint: resolveFingerprint({
          igUsername,
          deviceId: b.device_id as string | null,
          deviceUserAgent: b.device_user_agent as string | null,
          igAppId: b.ig_app_id as string | null,
          timezone: b.timezone as string | null,
          locale: b.locale as string | null,
          awakeHourStart: b.awake_hour_start as number | null,
          awakeHourEnd: b.awake_hour_end as number | null,
        }),
        botUsername: igUsername,
        proxyUrl: (ready as { proxyUrl?: string }).proxyUrl ?? (b.proxy_endpoint as string | null) ?? undefined,
        targetUsername,
      });
      console.log(`[cf] @${igUsername} -> ${res === null ? "NULL (no button / error)" : JSON.stringify(res)}`);
    } catch (e: any) {
      console.log(`[cf] @${igUsername} THREW ${String(e?.message ?? e).slice(0, 140)}`);
    }
  }
}
main().catch((e) => console.error("[cf]", e?.message ?? e)).finally(() => pool.end().catch(() => {}));
