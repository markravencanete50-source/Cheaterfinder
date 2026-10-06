// Test whether the liked-by SQUAD endpoints work on a mobile Bearer session:
//   feed_watcher  → POST /api/v1/feed/timeline/
//   reels_watcher → POST /api/v1/clips/discover/
// If they return 200 JSON, the 55 mobile bots can power the liked-by squad
// (dedicated liked-by capacity that never touches the web pool). Read-only.
//
// Usage: npx tsx server/scripts/test-mobile-squad-endpoints.ts <mobile_bot_username>

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { parseMobileEnvelope } from "../services/mobile-session.js";
import { createMobileReadClient } from "../ig-mobile-read-client.js";

async function main(): Promise<void> {
  const username = process.argv[2] ?? "addisonmerie_agullo_5025";
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE lower(ig_username)=${username.toLowerCase()} AND transport='mobile' LIMIT 1
  `)) as unknown as { rows: Array<{ id: string; ig_username: string }> };
  const bot = rows[0];
  if (!bot) throw new Error(`mobile bot ${username} not found`);

  const ready = await ensureBotReady(bot.id);
  const session = parseMobileEnvelope(ready.sessionData);
  if (!session) throw new Error("not a mobile envelope");
  const client = createMobileReadClient({
    session,
    proxyEndpoint: ready.proxyEndpoint,
    botId: bot.id,
    botUsername: bot.ig_username,
  });

  const probes: Array<{ name: string; path: string; body: string }> = [
    { name: "feed/timeline", path: "/api/v1/feed/timeline/", body: "reason=cold_start_fetch&is_pull_to_refresh=0" },
    { name: "clips/discover", path: "/api/v1/clips/discover/", body: "" },
  ];

  for (const p of probes) {
    try {
      const raw = (await client.fetchRaw!(p.path, { method: "POST", body: p.body })) as Record<string, unknown>;
      const keys = raw && typeof raw === "object" ? Object.keys(raw).slice(0, 6).join(",") : "?";
      const items = Array.isArray((raw as { feed_items?: unknown[] })?.feed_items)
        ? (raw as { feed_items: unknown[] }).feed_items.length
        : Array.isArray((raw as { items?: unknown[] })?.items)
          ? (raw as { items: unknown[] }).items.length
          : "?";
      console.log(`[squad] ${p.name}: OK status-ok keys=[${keys}] items=${items}`);
    } catch (e) {
      const body = (e as { body?: string })?.body;
      console.log(`[squad] ${p.name}: FAIL ${(e instanceof Error ? e.message : String(e)).slice(0, 90)}${body ? " :: " + body.slice(0, 120) : ""}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  await client.close();
}

void main()
  .catch((e: unknown) => console.error("[squad] ERROR", e instanceof Error ? e.message : String(e)))
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
