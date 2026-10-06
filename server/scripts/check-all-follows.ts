// For every ACTIVE tracked account, ask IG whether each watcher bot follows it.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

async function main() {
  const { rows: bots } = (await db.execute(sql`
    SELECT id, ig_username, device_id, device_user_agent, ig_app_id, timezone, locale,
           awake_hour_start, awake_hour_end
      FROM bot_accounts WHERE role::text LIKE '%watcher%' AND session_data IS NOT NULL
      ORDER BY ig_username`)) as any;
  const { rows: targets } = (await db.execute(sql`
    SELECT DISTINCT ig_username, ig_user_id FROM tracked_accounts
     WHERE is_active AND ig_user_id IS NOT NULL ORDER BY ig_username`)) as any;
  console.log(`[af] watchers=${bots.length} targets=${targets.length}`);

  for (const t of targets) {
    const followers: string[] = [];
    const errors: string[] = [];
    for (const b of bots) {
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
        const raw = await (client as any).fetchRaw?.(`/api/v1/friendships/show/${t.ig_user_id}/`);
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed?.following) followers.push(String(b.ig_username));
        else if (parsed?.outgoing_request) followers.push(`${b.ig_username}(pending)`);
      } catch (e: any) {
        // Never swallow: a silent catch here made every target read as
        // "NO WATCHER FOLLOWS" when the probe had actually errored.
        errors.push(`${b.ig_username}:${String(e?.message ?? e).slice(0, 40)}`);
      }
      await new Promise((s) => setTimeout(s, 400));
    }
    console.log(
      `  @${t.ig_username}: ${followers.length ? "FOLLOWED BY " + followers.join(", ") : "none"}` +
      (errors.length ? `   [probe errors: ${errors.length}]` : ""),
    );
  }
}
main().catch((e)=>console.error("[af]",e?.message??e)).finally(()=>pool.end().catch(()=>{}));
