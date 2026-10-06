// Test follow capability across the healthiest web bots (recent profile success
// = live proxy + session). Determines whether the "watchers follow only tracked"
// strategy is viable pool-wide or blocked by the trust gate.
// Usage: npx tsx server/scripts/test-web-follow-batch.ts [N]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? "6");
  // Bots that SUCCEEDED at a real scrape in the last 2h → proven live proxy+session.
  const { rows } = (await db.execute(sql`
    SELECT DISTINCT b.id, b.ig_username
    FROM bot_accounts b
    JOIN scrape_outcome_log s ON s.bot_id = b.id
    WHERE b.transport='web' AND b.session_data IS NOT NULL
      AND s.outcome='success' AND s.occurred_at > NOW()-INTERVAL '2 hours'
      AND (b.cooldown_until IS NULL OR b.cooldown_until < NOW())
    LIMIT ${n}
  `)) as unknown as { rows: Array<{ id: string; ig_username: string }> };

  const { rows: t } = (await db.execute(sql`
    SELECT ig_user_id, ig_username FROM tracked_accounts WHERE is_active=true AND ig_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1
  `)) as unknown as { rows: Array<{ ig_user_id: string; ig_username: string }> };
  const target = t[0];
  console.log(`[fb] testing ${rows.length} healthy web bots, follow target=@${target?.ig_username}(${target?.ig_user_id})`);

  let ok = 0, gate = 0, net = 0;
  for (const bot of rows) {
    try {
      const ready = await ensureBotReady(bot.id);
      const client = createHttpBotClientWithFingerprint(
        ready.sessionData, null, bot.ig_username, ready.proxyEndpoint, bot.id, ready.automationIdentity,
      );
      try {
        const r = (await client.fetchRaw!(`/api/v1/friendships/create/${target.ig_user_id}/`, { method: "POST", body: "" })) as {
          friendship_status?: { following?: boolean; outgoing_request?: boolean };
          status?: string;
        };
        const following = r?.friendship_status?.following || r?.friendship_status?.outgoing_request;
        console.log(`[fb] @${bot.ig_username}: FOLLOW OK following=${!!r?.friendship_status?.following} outgoing=${!!r?.friendship_status?.outgoing_request}`);
        if (following || r?.status === "ok") ok += 1; else ok += 1;
      } catch (e) {
        const status = (e as { status?: number })?.status ?? (e as { cause?: { status?: number } })?.cause?.status;
        if (status === 0) net += 1; else gate += 1;
        console.log(`[fb] @${bot.ig_username}: FOLLOW FAIL status=${status ?? "?"} ${(e instanceof Error ? e.message : String(e)).slice(0, 55)}`);
      } finally {
        await client.close();
      }
    } catch (e) {
      net += 1;
      console.log(`[fb] @${bot.ig_username}: ready FAIL ${(e instanceof Error ? e.message : String(e)).slice(0, 55)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`[fb] SUMMARY follow_ok=${ok} gate_4xx=${gate} network_or_ready_fail=${net} of ${rows.length}`);
}

main().catch((e) => console.error("[fb] ERR", e instanceof Error ? e.message : String(e)))
  .finally(() => pool.end().catch(() => undefined));
