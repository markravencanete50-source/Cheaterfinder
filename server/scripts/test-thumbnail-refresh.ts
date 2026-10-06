// Test whether getFreshMediaThumbnail (media/<id>/info/, leased under the
// mobile-capable "posts" label) can re-sign a stale liked-post thumbnail — and
// which transport served it. Read-only.
//
// Usage: npx tsx server/scripts/test-thumbnail-refresh.ts

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { getFreshMediaThumbnail } from "../ig-public-scraper.js";
import { shortcodeToMediaId } from "../services/media-cache.js";

async function main(): Promise<void> {
  const { rows } = (await db.execute(sql`
    SELECT post_id, left(thumbnail_url, 40) AS thumb, detected_at
    FROM like_events
    WHERE post_id IS NOT NULL
    ORDER BY detected_at DESC LIMIT 4
  `)) as unknown as { rows: Array<{ post_id: string; thumb: string; detected_at: string }> };

  if (rows.length === 0) {
    console.log("[thumb] no like_events found");
    return;
  }

  for (const r of rows) {
    const mediaId = shortcodeToMediaId(r.post_id);
    console.log(`[thumb] shortcode=${r.post_id} -> mediaId=${mediaId ?? "decode-failed"}`);
    if (!mediaId) continue;
    try {
      const fresh = await getFreshMediaThumbnail(mediaId);
      console.log(`[thumb]   getFreshMediaThumbnail -> ${fresh ? "OK: " + fresh.slice(0, 55) + "…" : "null"}`);
    } catch (e) {
      console.log(`[thumb]   FAIL ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }

  const { rows: last } = (await db.execute(sql`
    SELECT ig_username, transport FROM bot_accounts
    WHERE tier IN ('worker','canary') AND last_used_at IS NOT NULL
    ORDER BY last_used_at DESC LIMIT 1
  `)) as unknown as { rows: Array<{ ig_username: string; transport: string }> };
  console.log(`[thumb] last-served bot: @${last[0]?.ig_username} transport=${last[0]?.transport}`);
}

void main()
  .catch((e: unknown) => console.error("[thumb] ERROR", e instanceof Error ? e.message : String(e)))
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
