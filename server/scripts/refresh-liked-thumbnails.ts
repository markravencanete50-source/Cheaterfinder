// Repair grey liked-post thumbnails, and REMOVE liked posts whose media is gone
// so nothing renders as a grey placeholder.
//
// like_events store a one-time IG CDN thumbnail_url captured at detection; IG
// signs those to expire in days, so older liked posts render grey. We hold the
// post SHORTCODE → decodes to the media pk; getFreshMediaThumbnail (media/<id>/
// info/) mints a fresh signed URL, written back (media-cache downloads lazily).
//
// DELETION (grey na dikhao): a post that, after N attempts across rotating bots,
// never resolves AND failed with a MEDIA error (HTTP 400/404 / empty items /
// non-JSON — i.e. the media itself, not the pool) is treated as gone and its
// like_events are deleted — but ONLY when it is older than --min-age-days, so
// recent/transiently-failing posts are never removed. A currently-liked post
// wrongly removed self-heals: the liked-by squad re-detects it next cycle.
// Pure POOL errors (daily cap / rate limit / network / no-bot / auth rejected)
// are transient → the post is kept and retried on a later run.
//
// Usage:
//   npx tsx server/scripts/refresh-liked-thumbnails.ts [--days 2] [--limit 300]
//        [--pace-ms 900] [--attempts 3] [--min-age-days 5] [--no-delete]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { shortcodeToMediaId } from "../services/media-cache.js";
import { getFreshMediaThumbnail } from "../ig-public-scraper.js";

function numArg(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}

// True when the error is the POOL's fault (transient), NOT the media's.
function isTransientPoolError(msg: string): boolean {
  return /daily cap|rate limit|rate.limited|no available bot|no leasable|network error|timeout|ECONNRESET|socket|auth rejected|throttle|proxy/i.test(
    msg,
  );
}
// True when the error points at the MEDIA being gone/unavailable.
function isMediaGoneError(msg: string): boolean {
  return /HTTP 400|HTTP 404|status 404|not JSON|not found|unavailable|media_id/i.test(msg);
}

async function main(): Promise<void> {
  const days = numArg("--days", 2);
  const limit = numArg("--limit", 300);
  const paceMs = numArg("--pace-ms", 900);
  const attempts = Math.max(1, numArg("--attempts", 3));
  const minAgeDays = numArg("--min-age-days", 5);
  const allowDelete = !process.argv.includes("--no-delete");

  const { rows } = (await db.execute(sql`
    SELECT post_id, MIN(detected_at) AS oldest
    FROM like_events
    WHERE post_id IS NOT NULL AND detected_at < NOW() - (${days} || ' days')::interval
    GROUP BY post_id
    ORDER BY post_id
    LIMIT ${limit}
  `)) as unknown as { rows: Array<{ post_id: string; oldest: string }> };

  console.log(
    `[thumb-refresh] ${rows.length} stale shortcodes (>${days}d) · attempts=${attempts} · delete=${allowDelete} (min-age ${minAgeDays}d)`,
  );
  let refreshed = 0, deleted = 0, keptTransient = 0, decodeFail = 0;

  for (const [idx, { post_id, oldest }] of rows.entries()) {
    const mediaId = shortcodeToMediaId(post_id);
    if (!mediaId) {
      decodeFail += 1;
      continue;
    }

    let fresh: string | null = null;
    let sawMediaGone = false;
    let sawOnlyTransient = true;

    for (let a = 0; a < attempts && !fresh; a += 1) {
      try {
        const url = await getFreshMediaThumbnail(mediaId);
        if (url) {
          fresh = url;
        } else {
          // null = IG returned 200 with empty items = the media has no content.
          sawMediaGone = true;
          sawOnlyTransient = false;
        }
      } catch (e) {
        const body = (e as { body?: string })?.body ?? "";
        const msg = `${e instanceof Error ? e.message : String(e)} ${body}`;
        if (isMediaGoneError(msg)) {
          sawMediaGone = true;
          sawOnlyTransient = false;
        } else if (!isTransientPoolError(msg)) {
          // Unrecognized error — treat conservatively as NON-transient so we
          // don't loop forever, but it alone won't trigger deletion (needs a
          // media-gone signal).
          sawOnlyTransient = false;
        }
      }
      if (!fresh && a < attempts - 1) await new Promise((r) => setTimeout(r, 400));
    }

    if (fresh) {
      await db.execute(sql`UPDATE like_events SET thumbnail_url = ${fresh} WHERE post_id = ${post_id}`);
      refreshed += 1;
    } else if (allowDelete && sawMediaGone && !sawOnlyTransient) {
      const ageDays = (Date.now() - new Date(oldest).getTime()) / 86_400_000;
      if (ageDays >= minAgeDays) {
        const res = (await db.execute(sql`
          DELETE FROM like_events WHERE post_id = ${post_id}
        `)) as unknown as { rowCount?: number };
        deleted += 1;
        void res;
      } else {
        keptTransient += 1; // media-gone but too recent to trust — keep for now
      }
    } else {
      keptTransient += 1; // transient/pool failure — keep, retry next run
    }

    if ((idx + 1) % 20 === 0) {
      console.log(`[thumb-refresh] ${idx + 1}/${rows.length} — refreshed=${refreshed} deleted=${deleted} kept=${keptTransient}`);
    }
    await new Promise((r) => setTimeout(r, paceMs));
  }

  console.log(
    `[thumb-refresh] DONE refreshed=${refreshed} deleted=${deleted} kept/transient=${keptTransient} decodeFail=${decodeFail}`,
  );
}

void main()
  .catch((e: unknown) => console.error("[thumb-refresh] ERROR", e instanceof Error ? e.message : String(e)))
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
