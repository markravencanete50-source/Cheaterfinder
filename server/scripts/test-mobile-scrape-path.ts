// Exercise the FULL production scrape path (leaseBot label-gating → transport
// routing → mobile client) via the exported scrapeProfile/scrapeUserPosts, and
// report which bot + transport actually served each call. Read-only.
//
// Usage: npx tsx server/scripts/test-mobile-scrape-path.ts [target]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { scrapeProfile, scrapeUserPosts } from "../ig-public-scraper.js";

async function lastServedBot(): Promise<{ ig_username: string; transport: string } | null> {
  const { rows } = (await db.execute(sql`
    SELECT ig_username, transport FROM bot_accounts
    WHERE tier IN ('worker','canary') AND last_used_at IS NOT NULL
    ORDER BY last_used_at DESC LIMIT 1
  `)) as unknown as { rows: Array<{ ig_username: string; transport: string }> };
  return rows[0] ?? null;
}

async function main(): Promise<void> {
  const target = process.argv[2] ?? "natgeo";

  try {
    const p = await scrapeProfile(target);
    const bot = await lastServedBot();
    console.log(
      `[scrape] scrapeProfile("${target}") OK: @${p.username} followers=${p.followerCount} posts=${p.postCount}`,
    );
    console.log(`[scrape]   served by @${bot?.ig_username} transport=${bot?.transport}`);

    const posts = await scrapeUserPosts(p.igUserId, 6);
    const bot2 = await lastServedBot();
    console.log(`[scrape] scrapeUserPosts OK: items=${posts.length}`);
    console.log(`[scrape]   served by @${bot2?.ig_username} transport=${bot2?.transport}`);
  } catch (e) {
    console.log(`[scrape] FAIL ${e instanceof Error ? e.message : String(e)}`);
  }
}

void main()
  .catch((e: unknown) => {
    console.error("[scrape] ERROR", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
