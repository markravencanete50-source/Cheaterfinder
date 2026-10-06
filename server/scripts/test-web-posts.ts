// Read-only diagnostic: is the web/pyhttpz lane login-walled on
// /api/v1/feed/user/? Prints status + a body prefix for a few healthy web bots.
// Usage: npx tsx server/scripts/test-web-posts.ts [N]  (sibling of test-web-likers.ts)
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? "3");
  const { rows: acc } = (await db.execute(sql`
    SELECT ig_user_id, ig_username FROM tracked_accounts
    WHERE is_active AND ig_user_id IS NOT NULL LIMIT 1
  `)) as unknown as { rows: Array<{ ig_user_id: string; ig_username: string }> };
  const pk = acc[0]?.ig_user_id;
  if (!pk) { console.log("[pp] no active tracked account with ig_user_id"); return; }
  console.log(`[pp] target @${acc[0].ig_username} pk=${pk}`);

  const { rows } = (await db.execute(sql`
    SELECT DISTINCT b.id, b.ig_username FROM bot_accounts b
    JOIN scrape_outcome_log s ON s.bot_id = b.id
    WHERE b.transport='web' AND b.status='available' AND b.session_data IS NOT NULL
      AND b.automation_identity IS NOT NULL
      AND (b.cooldown_until IS NULL OR b.cooldown_until < NOW())
      AND s.outcome='success' AND s.occurred_at > NOW() - INTERVAL '3 hours'
    LIMIT ${n}
  `)) as unknown as { rows: Array<{ id: string; ig_username: string }> };
  console.log(`[pp] testing ${rows.length} web bots`);

  for (const bot of rows) {
    try {
      const ready = await ensureBotReady(bot.id);
      const client = createHttpBotClientWithFingerprint(
        ready.sessionData, null, bot.ig_username, ready.proxyEndpoint, bot.id, ready.automationIdentity,
      );
      try {
        const page = await client.fetchUserFeed(pk, { count: 3 });
        console.log(`[pp] @${bot.ig_username}: POSTS OK items=${page.items?.length ?? "?"}`);
      } catch (e) {
        const err = e as { status?: number; body?: string; message?: string };
        console.log(`[pp] @${bot.ig_username}: POSTS FAIL status=${err.status ?? "?"} msg=${(err.message ?? "").slice(0, 70)}`);
        if (err.body) console.log(`      body[0:160]=${err.body.replace(/\s+/g, " ").slice(0, 160)}`);
      } finally { await client.close(); }
    } catch (e) {
      console.log(`[pp] @${bot.ig_username}: ready FAIL ${(e instanceof Error ? e.message : String(e)).slice(0, 70)}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}
main().catch((e) => console.error("[pp] ERR", e instanceof Error ? e.message : String(e)))
  .finally(() => pool.end().catch(() => undefined));
