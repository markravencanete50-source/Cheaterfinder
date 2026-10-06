// Promote available live bots into the "liked-by inference" watcher squad by
// setting bot_accounts.role. Feed watchers poll POST /api/v1/feed/timeline/;
// reels watchers poll POST /api/v1/clips/discover/. Only the `role` column is
// touched — tier/status are left alone (a watcher may still be leased by the
// scraper pool; dedicating it fully is a separate operator decision).
//
//   npx tsx server/scripts/assign-liked-by-roles.ts <feedCount> [<reelsCount>]
//
// Example: 2 feed watchers + 1 reels watcher
//   npx tsx server/scripts/assign-liked-by-roles.ts 2 1
//
// Idempotent-ish: only bots currently role='scraper' with a live session and no
// active cooldown are eligible, so re-running promotes NEW bots rather than
// re-promoting the existing squad. Never logs credentials.

import "dotenv/config";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { botAccounts } from "../../shared/schema.js";

function parseCount(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

async function promote(
  ids: string[],
  role: "feed_watcher" | "reels_watcher",
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(botAccounts)
    .set({ role, updatedAt: new Date() })
    .where(inArray(botAccounts.id, ids));
}

async function main(): Promise<void> {
  const feedCount = parseCount(process.argv[2], 0);
  const reelsCount = parseCount(process.argv[3], 0);
  const total = feedCount + reelsCount;

  if (total === 0) {
    console.error(
      "usage: assign-liked-by-roles <feedCount> [<reelsCount>] (at least one > 0)",
    );
    process.exit(1);
  }

  // Eligible = plain scraper bots with a live session and no active cooldown.
  // Freshest login first so the squad gets the healthiest sessions.
  const candidates = await db
    .select({ id: botAccounts.id, igUsername: botAccounts.igUsername })
    .from(botAccounts)
    .where(
      and(
        eq(botAccounts.role, "scraper"),
        eq(botAccounts.status, "available"),
        isNotNull(botAccounts.sessionData),
        sql`(${botAccounts.cooldownUntil} IS NULL OR ${botAccounts.cooldownUntil} < NOW())`,
      ),
    )
    .orderBy(desc(botAccounts.lastLoginAt))
    .limit(total);

  if (candidates.length < total) {
    console.warn(
      `[liked-by-roles] only ${candidates.length} eligible bot(s) available; requested ${total}. Assigning what we can.`,
    );
  }

  const feedBots = candidates.slice(0, feedCount);
  const reelsBots = candidates.slice(feedCount, feedCount + reelsCount);

  await promote(
    feedBots.map((b) => b.id),
    "feed_watcher",
  );
  await promote(
    reelsBots.map((b) => b.id),
    "reels_watcher",
  );

  for (const b of feedBots) {
    console.log(`[liked-by-roles] @${b.igUsername} -> feed_watcher`);
  }
  for (const b of reelsBots) {
    console.log(`[liked-by-roles] @${b.igUsername} -> reels_watcher`);
  }
  console.log(
    `[liked-by-roles] done: ${feedBots.length} feed_watcher, ${reelsBots.length} reels_watcher. ` +
      "Enable with LIKED_BY_SQUAD_ENABLED=true, then restart the worker process.",
  );

  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
