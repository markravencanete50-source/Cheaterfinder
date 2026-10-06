// Run the full liked-by squad path (prepareWatcher → mobile client →
// /feed/timeline/ → facepile parse → like_events) on ONE mobile feed_watcher,
// proving the squad works over the mobile transport. Read-only-ish (may insert
// like_events, which is the intended effect).
//
// Usage: npx tsx server/scripts/test-mobile-squad-harvest.ts

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { harvestLikedBy } from "../services/liked-by-harvester.js";

async function main(): Promise<void> {
  const uname = process.argv[2];
  const { rows } = (await db.execute(
    uname
      ? sql`SELECT id, ig_username FROM bot_accounts WHERE lower(ig_username)=${uname.toLowerCase()} AND transport='mobile' LIMIT 1`
      : sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE transport='mobile' AND role='feed_watcher' AND session_data IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until < NOW())
    ORDER BY last_used_at ASC NULLS FIRST LIMIT 1
  `,
  )) as unknown as { rows: Array<{ id: string; ig_username: string }> };
  const bot = rows[0];
  if (!bot) throw new Error("no leasable mobile feed_watcher found");

  console.log(`[squad-harvest] watcher=@${bot.ig_username} kind=feed`);
  try {
    const result = await harvestLikedBy(bot.id, "feed");
    console.log(`[squad-harvest] OK ${JSON.stringify(result)}`);
  } catch (e) {
    console.log(`[squad-harvest] FAIL ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
}

void main()
  .catch((e: unknown) => console.error("[squad-harvest] ERROR", e instanceof Error ? e.message : String(e)))
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
