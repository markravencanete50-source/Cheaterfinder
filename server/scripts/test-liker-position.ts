// Test the ranking claim: when a tracked user liked a post, WHERE do they
// appear in the likers list IG returns? If IG ranks them near the top even on
// high-like posts, filtering by like_count is wrong.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";
import { shortcodeToMediaId } from "../services/media-cache.js";

async function main(): Promise<void> {
  // Known positives: posts we already recorded as liked by a tracked user.
  const { rows: ev } = (await db.execute(sql`
    SELECT le.post_id, le.owner_username, ta.ig_username AS tracked, p.like_count
    FROM like_events le
    JOIN tracked_accounts ta ON ta.id = le.tracked_account_id
    LEFT JOIN posts_cache p ON p.shortcode = le.post_id
    ORDER BY le.detected_at DESC LIMIT 5
  `)) as any;
  console.log(`[pos] testing ${ev.length} known-liked posts`);

  const { rows: bots } = (await db.execute(sql`
    SELECT DISTINCT b.id, b.ig_username FROM bot_accounts b
    JOIN scrape_outcome_log s ON s.bot_id=b.id AND s.endpoint='likers' AND s.outcome='success'
    WHERE b.transport='web' AND b.status='available' AND b.session_data IS NOT NULL
      AND b.automation_identity IS NOT NULL AND (b.cooldown_until IS NULL OR b.cooldown_until<NOW())
      AND (b.proxy_url IS NOT NULL OR b.proxy_expires_at > NOW() + INTERVAL '2 minutes')
    LIMIT 1
  `)) as any;
  if (!bots[0]) throw new Error("no bot");
  const ready = await ensureBotReady(bots[0].id);
  const c = createHttpBotClientWithFingerprint(
    ready.sessionData, null, bots[0].ig_username, ready.proxyEndpoint, bots[0].id, ready.automationIdentity);
  console.log(`[pos] viewer bot=@${bots[0].ig_username} (does NOT follow the tracked users)`);

  for (const e of ev) {
    const mediaId = shortcodeToMediaId(e.post_id);
    if (!mediaId) continue;
    try {
      const page: any = await c.fetchMediaLikers(mediaId);
      const names = page.users.map((u: any) => (u.username || "").toLowerCase());
      const idx = names.indexOf(String(e.tracked).toLowerCase());
      console.log(`[pos] ${e.post_id} likes=${e.like_count ?? "?"} returned=${names.length} tracked=@${e.tracked} position=${idx >= 0 ? idx + 1 : "NOT FOUND"}`);
    } catch (err: any) {
      console.log(`[pos] ${e.post_id}: FAIL ${String(err?.message||err).slice(0,60)}`);
    }
    await new Promise(r => setTimeout(r, 3500));
  }
  // Ordering probe on a known-live, high-like post: is the returned slice
  // ranked (stable/relationship-based) or just a chronological tail?
  try {
    const a: any = await c.fetchMediaLikers("3958042443021183429");
    console.log(`[pos] ORDER-PROBE returned=${a.users.length} total=${a.totalCount} first5=${a.users.slice(0,5).map((u:any)=>u.username).join(",")}`);
  } catch (err: any) {
    console.log(`[pos] ORDER-PROBE FAIL ${String(err?.message||err).slice(0,60)}`);
  }
  await c.close();
}
main().catch(e => console.error("[pos] ERR", e?.message||e)).finally(() => pool.end().catch(()=>{}));
