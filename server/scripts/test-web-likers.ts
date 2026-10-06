// Prove a WEB bot can actually READ likers now that the age floor unlocked the
// cap — i.e. the aged accounts pass IG's trust gate for /media/<id>/likers/.
// Usage: npx tsx server/scripts/test-web-likers.ts [N]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? "4");
  // Get a media pk to test against: a recent post from any tracked account.
  const { rows: mrow } = (await db.execute(sql`
    SELECT ig_media_id FROM posts_cache WHERE ig_media_id ~ '^[0-9]+$' ORDER BY taken_at DESC NULLS LAST LIMIT 1
  `).catch(() => ({ rows: [] }))) as unknown as { rows: Array<{ ig_media_id: string }> };
  let mediaId = mrow[0]?.ig_media_id;
  if (!mediaId) mediaId = "3958042443021183429"; // fallback: a known public media pk
  console.log(`[wl] testing likers on media ${mediaId} across ${n} web bots`);

  const { rows } = (await db.execute(sql`
    SELECT DISTINCT b.id, b.ig_username
    FROM bot_accounts b JOIN scrape_outcome_log s ON s.bot_id=b.id
    WHERE b.transport='web' AND b.session_data IS NOT NULL AND b.automation_identity IS NOT NULL
      AND s.outcome='success' AND s.occurred_at > NOW()-INTERVAL '3 hours'
      AND (b.cooldown_until IS NULL OR b.cooldown_until<NOW())
    LIMIT ${n}
  `)) as unknown as { rows: Array<{ id: string; ig_username: string }> };

  let ok = 0, gated = 0;
  for (const bot of rows) {
    try {
      const ready = await ensureBotReady(bot.id);
      const client = createHttpBotClientWithFingerprint(
        ready.sessionData, null, bot.ig_username, ready.proxyEndpoint, bot.id, ready.automationIdentity,
      );
      try {
        const page = await client.fetchMediaLikers(mediaId);
        console.log(`[wl] @${bot.ig_username}: LIKERS OK users=${page.users.length} total=${page.totalCount}`);
        ok += 1;
      } catch (e) {
        const status = (e as { status?: number })?.status;
        const body = (e as { body?: string })?.body;
        gated += 1;
        console.log(`[wl] @${bot.ig_username}: LIKERS FAIL status=${status ?? "?"} ${(e instanceof Error ? e.message : String(e)).slice(0, 55)} ${body ? ":: " + body.slice(0, 70) : ""}`);
      } finally {
        await client.close();
      }
    } catch (e) {
      console.log(`[wl] @${bot.ig_username}: ready FAIL ${(e instanceof Error ? e.message : String(e)).slice(0, 55)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`[wl] SUMMARY likers_ok=${ok} gated=${gated} of ${rows.length}`);
}

main().catch((e) => console.error("[wl] ERR", e instanceof Error ? e.message : String(e)))
  .finally(() => pool.end().catch(() => undefined));
