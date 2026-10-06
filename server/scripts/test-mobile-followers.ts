// Can MOBILE sessions read followers/following? If yes, ~1,400 reads/day move
// off the scarce, ban-prone web pool and free that budget for likers.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { ProxyAgent, fetch as ufetch } from "undici";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { parseMobileEnvelope } from "../services/mobile-session.js";
import { proxyAgentUriForEndpoint } from "../services/proxy-provider.js";
const ORIGIN = "https://i.instagram.com";
async function main(): Promise<void> {
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE transport='mobile' AND status='available' AND session_data IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until<NOW())
    ORDER BY last_used_at ASC NULLS FIRST LIMIT 2`)) as any;
  const target = "787132"; // small public account id
  for (const bot of rows) {
    const ready = await ensureBotReady(bot.id);
    const s = parseMobileEnvelope(ready.sessionData)!;
    const dispatcher = new ProxyAgent({ uri: proxyAgentUriForEndpoint(ready.proxyEndpoint!), requestTls: { rejectUnauthorized: false } });
    const h: Record<string,string> = {
      "user-agent": s.userAgent, authorization: s.bearer,
      "x-ig-app-id": "567067343352427", "x-ig-capabilities": "3brTv10=",
      "x-ig-android-id": s.androidId, "x-ig-device-id": s.deviceUuid,
      "x-mid": s.mid, "x-ig-www-claim": s.wwwClaim || "0",
      "ig-intended-user-id": s.dsUserId, "x-ig-connection-type": "WIFI",
      accept: "*/*", "accept-language": "en-US", "accept-encoding": "gzip, deflate",
      "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
      cookie: `sessionid=${s.sessionid}; ds_user_id=${s.dsUserId}${s.mid?`; mid=${s.mid}`:""}`,
    };
    for (const [name, path] of [
      ["followers", `/api/v1/friendships/${target}/followers/?count=12`],
      ["following", `/api/v1/friendships/${target}/following/?count=12`],
    ] as const) {
      try {
        const r = await ufetch(`${ORIGIN}${path}`, { headers: h, dispatcher });
        const t = await r.text();
        let n = -1; try { n = JSON.parse(t)?.users?.length ?? -1; } catch {}
        console.log(`[mf] @${bot.ig_username} ${name}: ${r.status} ${n>=0?`USERS=${n} ✅`:`body=${t.slice(0,80)}`}`);
      } catch (e: any) { console.log(`[mf] @${bot.ig_username} ${name}: ERR ${String(e?.message||e).slice(0,60)}`); }
      await new Promise(r => setTimeout(r, 3000));
    }
    await dispatcher.close().catch(()=>{});
  }
}
main().catch(e=>console.error("[mf] ERR", e?.message??e)).finally(()=>pool.end().catch(()=>{}));
