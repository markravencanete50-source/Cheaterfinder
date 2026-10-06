// Backfill Instagram publication times for legacy like_events rows. Instagram
// media ids are Snowflake-like, so their creation time can be recovered locally
// without fetching each post.

import "dotenv/config";

import { eq, isNull } from "drizzle-orm";

import { db, pool } from "../db.js";
import { likeEvents } from "../../shared/schema.js";
import { postCreatedAt } from "../services/ig-media-time.js";

function shortcodeFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: likeEvents.id,
      postId: likeEvents.postId,
      postUrl: likeEvents.postUrl,
    })
    .from(likeEvents)
    .where(isNull(likeEvents.postTakenAt));

  let updated = 0;
  let unresolved = 0;
  for (const row of rows) {
    const numericId = row.postId.split("_")[0];
    const createdAt =
      postCreatedAt(numericId) ?? postCreatedAt(shortcodeFromUrl(row.postUrl));
    if (!createdAt) {
      unresolved += 1;
      continue;
    }
    await db
      .update(likeEvents)
      .set({ postTakenAt: createdAt })
      .where(eq(likeEvents.id, row.id));
    updated += 1;
  }

  console.log(
    `[like-time-backfill] scanned=${rows.length} updated=${updated} unresolved=${unresolved}`,
  );
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error("[like-time-backfill] fatal:", error);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
