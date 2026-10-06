// Surface the REAL error from a watcher's friendship probe (no silent catch).
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import { createBotClient } from "../ig-http-client.js";

async function main() {
  const { rows: t } = (await db.execute(sql`
    SELECT ig_username, ig_user_id FROM tracked_accounts WHERE is_active AND ig_user_id IS NOT NULL LIMIT 1`)) as any;
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username, device_id, device_user_agent, ig_app_id, timezone, locale,
           awake_hour_start, awake_hour_end
      FROM bot_accounts WHERE role::text LIKE '%watcher%' ORDER BY ig_username LIMIT 3`)) as any;
  console.log(`[wp] target=@${t[0].ig_username} pk=${t[0].ig_user_id}`);
  for (const b of rows) {
    try {
      const ready = await ensureBotReady(String(b.id));
      console.log(`  @${b.ig_username} proxyEndpoint=${(ready as any).proxyEndpoint ?? "NONE"}`);
      const client = createBotClient(ready.sessionData, {
        fingerprint: resolveFingerprint({
          igUsername: String(b.ig_username), deviceId: b.device_id, deviceUserAgent: b.device_user_agent,
          igAppId: b.ig_app_id, timezone: b.timezone, locale: b.locale,
          awakeHourStart: b.awake_hour_start, awakeHourEnd: b.awake_hour_end,
        }),
        botUsername: String(b.ig_username),
        botId: String(b.id),
        proxyEndpoint: (ready as any).proxyEndpoint,
        automationIdentity: (ready as any).automationIdentity,
      });
      const st = await client.fetchFriendshipStatus(String(t[0].ig_user_id));
      console.log(`     -> following=${st.following} outgoing=${st.outgoingRequest}`);
      client.close?.();
    } catch (e: any) {
      console.log(`     -> ERROR ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
}
main().catch((e)=>console.error("[wp]",e?.message??e)).finally(()=>pool.end().catch(()=>{}));
