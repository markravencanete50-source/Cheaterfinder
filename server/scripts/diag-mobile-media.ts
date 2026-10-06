// Print the raw mobile media/<id>/info/ response (status + body) for one or
// more media ids, to see WHY mobile returns 400 (deleted? private? param?).
// Usage: npx tsx server/scripts/diag-mobile-media.ts <mediaId> [<mediaId> ...]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { parseMobileEnvelope } from "../services/mobile-session.js";
import { createMobileReadClient } from "../ig-mobile-read-client.js";

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter(Boolean);
  if (ids.length === 0) throw new Error("usage: <mediaId> ...");

  const { rows } = (await db.execute(sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE transport='mobile' AND session_data IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until < NOW())
    ORDER BY last_used_at ASC NULLS FIRST LIMIT 1
  `)) as unknown as { rows: Array<{ id: string; ig_username: string }> };
  const bot = rows[0];
  if (!bot) throw new Error("no mobile bot");
  const ready = await ensureBotReady(bot.id);
  const session = parseMobileEnvelope(ready.sessionData)!;
  const client = createMobileReadClient({
    session, proxyEndpoint: ready.proxyEndpoint, botId: bot.id, botUsername: bot.ig_username,
  });
  console.log(`[diag-media] bot @${bot.ig_username}`);

  for (const mediaId of ids) {
    try {
      const body = await client.fetchRaw!(`/api/v1/media/${encodeURIComponent(mediaId)}/info/`);
      const keys = body && typeof body === "object" ? Object.keys(body as object).join(",") : "?";
      console.log(`[diag-media] ${mediaId}: OK keys=[${keys}]`);
    } catch (e) {
      const status = (e as { status?: number })?.status;
      const bodyStr = (e as { body?: string })?.body;
      console.log(`[diag-media] ${mediaId}: FAIL status=${status ?? "?"} body=${bodyStr ? bodyStr.slice(0, 220) : (e instanceof Error ? e.message.slice(0, 120) : String(e))}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await client.close();
}

main()
  .catch((e) => console.error("[diag-media] ERR", e instanceof Error ? e.message : String(e)))
  .finally(() => pool.end().catch(() => undefined));
