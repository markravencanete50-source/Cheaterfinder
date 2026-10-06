// Check a media/<id>/info/ via a WEB bot to disambiguate a mobile 400: is the
// media genuinely gone (web also 4xx) or just a mobile-transport quirk (web OK)?
// Usage: npx tsx server/scripts/check-media-web.ts <mediaId> [<mediaId> ...]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter(Boolean);
  if (ids.length === 0) throw new Error("usage: check-media-web.ts <mediaId> ...");

  const { rows } = (await db.execute(sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE transport='web' AND status='available' AND tier IN ('worker','canary')
      AND automation_identity IS NOT NULL AND session_data IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until < NOW())
    ORDER BY last_used_at ASC NULLS FIRST LIMIT 1
  `)) as unknown as { rows: Array<{ id: string; ig_username: string }> };
  const bot = rows[0];
  if (!bot) throw new Error("no leasable web bot");
  console.log(`[web-check] using web bot @${bot.ig_username}`);

  const ready = await ensureBotReady(bot.id);
  const client = createHttpBotClientWithFingerprint(
    ready.sessionData,
    null,
    bot.ig_username,
    ready.proxyEndpoint,
    bot.id,
    ready.automationIdentity,
  );

  for (const mediaId of ids) {
    try {
      const body = (await client.fetchRaw!(`/api/v1/media/${encodeURIComponent(mediaId)}/info/`)) as {
        items?: unknown[];
      };
      const n = Array.isArray(body?.items) ? body.items.length : 0;
      console.log(`[web-check] ${mediaId}: WEB OK items=${n} → ${n > 0 ? "EXISTS (mobile quirk)" : "EMPTY (deleted)"}`);
    } catch (e) {
      const status = (e as { status?: number })?.status ?? (e as { cause?: { status?: number } })?.cause?.status;
      const msg = e instanceof Error ? e.message.slice(0, 90) : String(e);
      console.log(`[web-check] ${mediaId}: WEB FAIL status=${status ?? "?"} ${msg} → ${status === 404 ? "DELETED" : "transient/ambiguous"}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await client.close();
}

main()
  .catch((e) => console.error("[web-check] ERR", e instanceof Error ? e.message : String(e)))
  .finally(() => pool.end().catch(() => undefined));
