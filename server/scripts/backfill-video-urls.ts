// ─── Backfill NULL video_url for older video/reel posts ─────────────────────
//
// One-off, incremental, idempotent. Same shape as backfill-carousel-media.ts.
//
// PROBLEM
//   Video/reel rows need posts_cache.video_url to be playable. Two things left
//   older rows with NULL:
//     1. The Tier-1 web-profile preview persisted `videoUrl: null` and the
//        upsert wrote it straight through, wiping real URLs on every
//        revalidation. (Fixed: persistPosts now takes {preview:true} and
//        COALESCEs video_url so a null incoming can never clobber.)
//     2. The collector only feed-scrapes the newest POSTS_PER_CYCLE (12) posts,
//        so anything older is never re-read and cannot self-heal.
//   Result: posts that simply will not play, forever.
//
// APPROACH
//   Walk rows WHERE post_type IN ('video','reel') AND video_url IS NULL AND
//   media_id IS NOT NULL, and re-read each one's /media/{id}/info/ for a
//   freshly-signed video URL. One IG call per post, leased + budgeted through
//   the normal "posts" daily budget, sequential with a small delay so this can
//   never look like a burst.
//
//   Safe to re-run: it only ever fills a NULL. A row that comes back without a
//   video (deleted media, or actually a photo) is left alone and simply retried
//   on a future run.
//
//   npx tsx server/scripts/backfill-video-urls.ts [--limit=50] [--username=foo]

import "dotenv/config";
import { and, eq, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { postsCache, trackedAccounts } from "../../shared/schema.js";
import { getFreshMediaVideoUrl } from "../ig-public-scraper.js";

const DELAY_MS = 1500;

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const limit = Math.min(Math.max(Number(arg("limit") ?? "50"), 1), 500);
  const username = arg("username");

  const filters = [
    inArray(postsCache.postType, ["video", "reel"]),
    isNull(postsCache.videoUrl),
    isNotNull(postsCache.mediaId),
  ];

  if (username) {
    const [acct] = await db
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(
        and(
          eq(trackedAccounts.igUsername, username),
          eq(trackedAccounts.isActive, true),
        ),
      )
      .limit(1);
    if (!acct) throw new Error(`no active tracked account @${username}`);
    filters.push(eq(postsCache.trackedAccountId, acct.id));
  }

  const rows = await db
    .select({
      id: postsCache.id,
      shortcode: postsCache.shortcode,
      mediaId: postsCache.mediaId,
    })
    .from(postsCache)
    .where(and(...filters))
    .orderBy(sql`${postsCache.takenAt} DESC NULLS LAST`)
    .limit(limit);

  console.log(
    `[backfill-video-urls] candidates=${rows.length}${username ? ` (@${username})` : ""}`,
  );

  let fixed = 0;
  let noVideo = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const url = await getFreshMediaVideoUrl(row.mediaId!);
      if (!url) {
        noVideo += 1;
        console.log(`  · ${row.shortcode} — no video in media info (skipped)`);
      } else {
        await db
          .update(postsCache)
          .set({ videoUrl: url })
          .where(eq(postsCache.id, row.id));
        fixed += 1;
        console.log(`  ✓ ${row.shortcode} — video_url restored`);
      }
    } catch (err) {
      failed += 1;
      console.warn(
        `  ✗ ${row.shortcode} — ${err instanceof Error ? err.message.slice(0, 90) : String(err)}`,
      );
    }
    await sleep(DELAY_MS);
  }

  console.log(
    `[backfill-video-urls] fixed=${fixed} noVideo=${noVideo} failed=${failed}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
