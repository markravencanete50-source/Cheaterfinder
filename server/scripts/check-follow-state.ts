// Ask IG directly whether these bots follow the target, via friendships/show.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

async function main() {
  const target = process.argv[2] ?? "sample_account";
  const bots = (process.argv[3] ?? "bgxlkv696,vikasali92502").split(",");
  const { rows: t } = (await db.execute(sql`
    SELECT ig_user_id, ig_username FROM tracked_accounts WHERE ig_username=${target} LIMIT 1`)) as any;
  if (!t.length) { console.log("[fs] target not found"); return; }
  const pk = String(t[0].ig_user_id);
  console.log(`[fs] target=@${target} pk=${pk}`);
  for (const bu of bots) {
    const { rows } = (await db.execute(sql`
      SELECT id, ig_username, device_id, device_user_agent, ig_app_id, timezone, locale,
             awake_hour_start, awake_hour_end
        FROM bot_accounts WHERE ig_username=${bu.trim()} LIMIT 1`)) as any;
    if (!rows.length) { console.log(`  @${bu}: bot not found`); continue; }
    const b = rows[0];
    try {
      const ready = await ensureBotReady(String(b.id));
      const client = createHttpBotClientWithFingerprint(
        ready.sessionData,
        resolveFingerprint({
          igUsername: String(b.ig_username), deviceId: b.device_id, deviceUserAgent: b.device_user_agent,
          igAppId: b.ig_app_id, timezone: b.timezone, locale: b.locale,
          awakeHourStart: b.awake_hour_start, awakeHourEnd: b.awake_hour_end,
        }),
        String(b.ig_username),
      );
      const raw = await (client as any).fetchRaw?.(`/api/v1/friendships/show/${pk}/`);
      const txt = typeof raw === "string" ? raw : JSON.stringify(raw);
      let parsed: any = null;
      try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch {}
      if (parsed && typeof parsed === "object") {
        console.log(`  @${b.ig_username}: following=${parsed.following} outgoing_request=${parsed.outgoing_request} is_private=${parsed.is_private}`);
      } else {
        console.log(`  @${b.ig_username}: unparsed -> ${String(txt).slice(0,110)}`);
      }
    } catch (e: any) {
      console.log(`  @${b.ig_username}: ERR ${String(e?.message ?? e).slice(0,110)}`);
    }
  }
}
main().catch((e)=>console.error("[fs]",e?.message??e)).finally(()=>pool.end().catch(()=>{}));
