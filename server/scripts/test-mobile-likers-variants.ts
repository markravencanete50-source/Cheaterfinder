// Can MOBILE (Bearer IGT:2) sessions read likers? Plain call returns 403
// login_required. Test the plausible unlocks:
//  A. baseline (control)
//  B. WARMED: do a real profile+feed read first so IG sets a valid
//     x-ig-set-www-claim, then reuse that claim on likers
//  C. NAV-CHAIN: send X-IG-Nav-Chain (the app's UI path) — IG uses it to
//     validate that a sensitive read came from a plausible screen flow
//  D. WARMED + NAV-CHAIN + media/info first (full human-like sequence)
import "dotenv/config";
import { sql } from "drizzle-orm";
import { ProxyAgent, fetch as ufetch } from "undici";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { parseMobileEnvelope } from "../services/mobile-session.js";
import { proxyAgentUriForEndpoint } from "../services/proxy-provider.js";

const ORIGIN = "https://i.instagram.com";
const APP_ID = "567067343352427";

async function main(): Promise<void> {
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE transport='mobile' AND status='available' AND session_data IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until<NOW())
    ORDER BY last_used_at ASC NULLS FIRST LIMIT 1`)) as any;
  const bot = rows[0];
  const ready = await ensureBotReady(bot.id);
  const s = parseMobileEnvelope(ready.sessionData)!;
  const dispatcher = new ProxyAgent({ uri: proxyAgentUriForEndpoint(ready.proxyEndpoint!), requestTls: { rejectUnauthorized: false } });
  let claim = s.wwwClaim || "0";
  console.log(`[ml] bot=@${bot.ig_username}`);

  const call = async (path: string, extra: Record<string,string> = {}) => {
    const h: Record<string,string> = {
      "user-agent": s.userAgent, authorization: s.bearer,
      "x-ig-app-id": APP_ID, "x-ig-capabilities": "3brTv10=",
      "x-ig-android-id": s.androidId, "x-ig-device-id": s.deviceUuid,
      "x-mid": s.mid, "x-ig-www-claim": claim,
      "ig-intended-user-id": s.dsUserId,
      "x-ig-connection-type": "WIFI", accept: "*/*",
      "accept-language": "en-US", "accept-encoding": "gzip, deflate",
      "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
      cookie: `sessionid=${s.sessionid}; ds_user_id=${s.dsUserId}${s.mid?`; mid=${s.mid}`:""}`,
      ...extra,
    };
    const r = await ufetch(`${ORIGIN}${path}`, { headers: h, dispatcher });
    const set = r.headers.get("x-ig-set-www-claim");
    if (set) claim = set;
    const t = await r.text();
    return { status: r.status, body: t, claimSet: !!set };
  };

  // Warm: profile then feed (both known-good on mobile) to earn a real claim
  const prof = await call(`/api/v1/users/787132/info/`);
  console.log(`[ml] warm profile: ${prof.status} claim_set=${prof.claimSet} claim=${claim.slice(0,12)}`);
  const feed = await call(`/api/v1/feed/user/787132/?count=6`);
  let mediaId = "";
  try { mediaId = JSON.parse(feed.body)?.items?.[0]?.pk?.toString() ?? ""; } catch {}
  console.log(`[ml] warm feed: ${feed.status} mediaId=${mediaId||"none"}`);
  if (!mediaId) { console.log("[ml] no media to test"); return; }

  const nav = { "x-ig-nav-chain": "MainFeedFragment:feed_timeline:1:cold_start:::,ProfileMediaTabFragment:profile:2:button::,MediaLikersFragment:likers:3:button::" };

  const variants: Array<[string, () => Promise<any>]> = [
    ["A baseline likers        ", () => call(`/api/v1/media/${mediaId}/likers/`)],
    ["B warmed claim (as-is)   ", () => call(`/api/v1/media/${mediaId}/likers/`)],
    ["C nav-chain              ", () => call(`/api/v1/media/${mediaId}/likers/`, nav)],
    ["D media/info then likers ", async () => { await call(`/api/v1/media/${mediaId}/info/`); await new Promise(r=>setTimeout(r,2000)); return call(`/api/v1/media/${mediaId}/likers/`, nav); }],
  ];
  for (const [name, fn] of variants) {
    try {
      const r = await fn();
      let n = -1; try { n = JSON.parse(r.body)?.users?.length ?? -1; } catch {}
      console.log(`[ml] ${name}: ${r.status} ${n>=0?`USERS=${n} ✅`:`body=${r.body.slice(0,90)}`}`);
    } catch (e: any) { console.log(`[ml] ${name}: ERR ${String(e?.message||e).slice(0,60)}`); }
    await new Promise(r => setTimeout(r, 4000));
  }
  await dispatcher.close().catch(()=>{});
}
main().catch(e=>console.error("[ml] ERR", e?.message||e)).finally(()=>pool.end().catch(()=>{}));
