// Our earlier follow test used the MOBILE/private path
// (/api/v1/friendships/create/<pk>/) with WEB browser sessions — IG answers
// that with an HTML login page for web cookies. The real web app uses
// /api/v1/web/friendships/<pk>/follow/. Test BOTH so we know whether follow is
// truly walled or we were just calling the wrong endpoint.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

async function main(): Promise<void> {
  const { rows: t } = (await db.execute(sql`
    SELECT ig_user_id, ig_username FROM tracked_accounts
    WHERE is_active=true AND ig_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1
  `)) as any;
  const target = t[0];

  const { rows } = (await db.execute(sql`
    SELECT DISTINCT b.id, b.ig_username FROM bot_accounts b
    JOIN scrape_outcome_log s ON s.bot_id=b.id
    WHERE b.transport='web' AND b.status='available' AND b.session_data IS NOT NULL
      AND b.automation_identity IS NOT NULL
      AND s.outcome='success' AND s.occurred_at > NOW()-INTERVAL '6 hours'
      AND (b.cooldown_until IS NULL OR b.cooldown_until<NOW())
    LIMIT 3
  `)) as any;
  console.log(`[fe] target=@${target.ig_username}(${target.ig_user_id}) bots=${rows.length}`);

  for (const bot of rows) {
    const ready = await ensureBotReady(bot.id);
    const c = createHttpBotClientWithFingerprint(
      ready.sessionData, null, bot.ig_username, ready.proxyEndpoint, bot.id, ready.automationIdentity);
    for (const [name, path] of [
      ["WEB /web/friendships/follow ", `/web/friendships/${target.ig_user_id}/follow/`],
      ["WEB unfollow /unfollow      ", `/web/friendships/${target.ig_user_id}/unfollow/`],
    ] as const) {
      try {
        const r: any = await c.fetchRaw!(path, { method: "POST", body: "" });
        console.log(`[fe] @${bot.ig_username} ${name}: OK ${JSON.stringify(r).slice(0,90)}`);
      } catch (e: any) {
        console.log(`[fe] @${bot.ig_username} ${name}: FAIL ${String(e?.message||e).slice(0,60)}`);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    await c.close();
  }
}
main().catch(e => console.error("[fe] ERR", e?.message||e)).finally(() => pool.end().catch(()=>{}));
