import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { parseMobileEnvelope } from "../services/mobile-session.js";
import { createMobileReadClient } from "../ig-mobile-read-client.js";

const t = (label: string, since: number) =>
  console.error(`[diag] ${label} took ${Date.now() - since}ms`);

async function main(): Promise<void> {
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE transport='mobile' AND role='feed_watcher' AND session_data IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until < NOW())
    ORDER BY last_used_at ASC NULLS FIRST LIMIT 1
  `)) as unknown as { rows: Array<{ id: string; ig_username: string }> };
  const bot = rows[0];
  if (!bot) throw new Error("no leasable mobile feed_watcher");
  console.error(`[diag] bot=@${bot.ig_username}`);

  let s = Date.now();
  const ready = await ensureBotReady(bot.id);
  t("ensureBotReady", s);

  const session = parseMobileEnvelope(ready.sessionData);
  if (!session) throw new Error("bad envelope");
  const client = createMobileReadClient({
    session,
    proxyEndpoint: ready.proxyEndpoint,
    botId: bot.id,
    botUsername: bot.ig_username,
  });

  s = Date.now();
  try {
    const raw = (await client.fetchRaw!("/api/v1/feed/timeline/", {
      method: "POST",
      body: "reason=cold_start_fetch&is_pull_to_refresh=0",
    })) as { feed_items?: unknown[] };
    t("fetchRaw feed/timeline", s);
    console.error(`[diag] feed_items=${Array.isArray(raw?.feed_items) ? raw.feed_items.length : "?"}`);
  } catch (e) {
    t("fetchRaw feed/timeline (ERR)", s);
    console.error(`[diag] fetch err: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }

  s = Date.now();
  await client.close();
  t("close", s);
  console.error("[diag] DONE");
}

void main()
  .catch((e: unknown) => console.error("[diag] ERROR", e instanceof Error ? e.message : String(e)))
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
