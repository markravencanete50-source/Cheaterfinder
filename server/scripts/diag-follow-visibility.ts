// Does following the tracked account lift it into the visible liker slice?
// IG ranks liker lists by the VIEWER's relationships, so a bot that follows the
// tracked user should surface that user near the top even on a post with tens of
// thousands of likes — where an unrelated viewer sees ~100 of them and 0% odds.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

async function main() {
  const target = (process.argv[2] ?? "sample_account").toLowerCase();
  const botUser = process.argv[3] ?? "bgxlkv696";
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username, device_id, device_user_agent, ig_app_id, timezone, locale,
           awake_hour_start, awake_hour_end
      FROM bot_accounts WHERE ig_username = ${botUser} LIMIT 1`)) as any;
  if (!rows.length) { console.log("[fv] bot not found"); return; }
  const b = rows[0];
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
  // Owners sample follows that posted recently, biggest posts first.
  // Take owner ig_user_id straight from the roster. Fresh bots are refused by
  // web_profile_info (HTTP 400), and a profile call is not needed to read a
  // feed — it only cost us the whole diagnostic.
  const { rows: owners } = (await db.execute(sql`
    SELECT rm.username, rm.ig_user_id FROM roster_members rm
      JOIN tracked_accounts ta ON ta.id=rm.tracked_account_id
     WHERE ta.ig_username=${target} AND rm.dimension='following' AND rm.is_current
       AND rm.ig_user_id IS NOT NULL
       AND rm.last_post_at > NOW()-INTERVAL '10 days'
     ORDER BY rm.last_post_at DESC LIMIT 6`)) as any;
  console.log(`[fv] bot=@${b.ig_username} target=@${target} owners=${owners.length}`);
  for (const o of owners) {
    try {
      const feed = await client.fetchUserFeed(String(o.ig_user_id), { count: 3 });
      for (const p of (feed?.items ?? []).slice(0, 2)) {
        if (!p.id) continue;
        const page = await client.fetchMediaLikers(p.id);
        const names = (page?.users ?? []).map((u: any) => String(u.username ?? "").toLowerCase());
        const idx = names.indexOf(target);
        console.log(`  @${o.username} likes=${p.likeCount ?? "?"} returned=${names.length} targetRank=${idx >= 0 ? idx + 1 : "ABSENT"}`);
        await new Promise((s) => setTimeout(s, 900));
      }
    } catch (e: any) { console.log(`  @${o.username} ERR ${String(e?.message ?? e).slice(0,80)}`); }
  }
}
main().catch((e) => console.error("[fv]", e?.message ?? e)).finally(() => pool.end().catch(() => {}));
