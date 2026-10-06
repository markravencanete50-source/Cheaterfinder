// Verify the two squad prerequisites on a mobile bot:
//   1) sendFollow (friendships/create) — needed by ensureFollows to seed the
//      facepile mechanism. If gated, mobile watchers can't self-seed follows.
//   2) /api/v1/clips/discover/ — the reels_watcher feed.
// Read-mostly; sendFollow is a real follow (uses a tracked account as target).
// Usage: npx tsx server/scripts/diag-mobile-squad2.ts

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { parseMobileEnvelope } from "../services/mobile-session.js";
import { createMobileReadClient } from "../ig-mobile-read-client.js";

async function main(): Promise<void> {
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE transport='mobile' AND role='feed_watcher' AND session_data IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until < NOW())
    ORDER BY last_used_at ASC NULLS FIRST LIMIT 1
  `)) as unknown as { rows: Array<{ id: string; ig_username: string }> };
  const bot = rows[0];
  if (!bot) throw new Error("no mobile feed_watcher");

  // A real tracked account to follow (the follow target ensureFollows would use).
  const { rows: t } = (await db.execute(sql`
    SELECT ig_user_id, ig_username FROM tracked_accounts
    WHERE is_active=true AND ig_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1
  `)) as unknown as { rows: Array<{ ig_user_id: string; ig_username: string }> };
  const target = t[0];

  const ready = await ensureBotReady(bot.id);
  const session = parseMobileEnvelope(ready.sessionData)!;
  const client = createMobileReadClient({
    session, proxyEndpoint: ready.proxyEndpoint, botId: bot.id, botUsername: bot.ig_username,
  });
  console.log(`[sq2] bot=@${bot.ig_username} target=@${target?.ig_username}(${target?.ig_user_id})`);

  // 1) sendFollow
  try {
    const fs = await client.sendFollow(target.ig_user_id);
    console.log(`[sq2] sendFollow: OK following=${fs.following} outgoing=${fs.outgoingRequest}`);
  } catch (e) {
    const body = (e as { body?: string })?.body;
    console.log(`[sq2] sendFollow: FAIL ${(e instanceof Error ? e.message : String(e)).slice(0, 80)} ${body ? ":: " + body.slice(0, 120) : ""}`);
  }
  await new Promise((r) => setTimeout(r, 4000));

  // 2) clips/discover (reels feed)
  try {
    const raw = (await client.fetchRaw!("/api/v1/clips/discover/", { method: "POST", body: "" })) as Record<string, unknown>;
    const keys = raw && typeof raw === "object" ? Object.keys(raw).slice(0, 6).join(",") : "?";
    console.log(`[sq2] clips/discover: OK keys=[${keys}]`);
  } catch (e) {
    const body = (e as { body?: string })?.body;
    console.log(`[sq2] clips/discover: FAIL ${(e instanceof Error ? e.message : String(e)).slice(0, 80)} ${body ? ":: " + body.slice(0, 120) : ""}`);
  }
  await client.close();
}

main().catch((e) => console.error("[sq2] ERR", e instanceof Error ? e.message : String(e)))
  .finally(() => pool.end().catch(() => undefined));
