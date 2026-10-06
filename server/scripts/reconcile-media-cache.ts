// Reconcile media_assets against disk. The media-cache dir gets wiped during
// disk-full recovery, but the DB rows stay status='cached' with a local_path
// that no longer exists — so readCachedMediaAsset / resolveCachedMediaUrls hand
// the frontend a dead /media/<key> URL and images render blank, and the media
// never re-caches (the row still says "cached").
//
// This deletes every 'cached' row whose file is missing, so the frontend falls
// back to img-proxy (re-fetch from IG + re-cache) and future scrapes re-enqueue
// them. Dry-run by default; pass --apply to delete.
//
//   npx tsx server/scripts/reconcile-media-cache.ts [--apply]

import "dotenv/config";
import { existsSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../db.js";
import { mediaAssets } from "../../shared/schema.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const rows = await db
    .select({ id: mediaAssets.id, localPath: mediaAssets.localPath })
    .from(mediaAssets)
    .where(eq(mediaAssets.status, "cached"));

  const missing = rows
    .filter((r) => !r.localPath || !existsSync(r.localPath))
    .map((r) => r.id);

  console.log(
    `[reconcile-media] cached_rows=${rows.length} missing_file=${missing.length} present=${rows.length - missing.length}`,
  );

  if (!apply) {
    console.log("[reconcile-media] DRY RUN — pass --apply to delete the stale rows");
    await pool.end();
    return;
  }

  let deleted = 0;
  for (let i = 0; i < missing.length; i += 1000) {
    const chunk = missing.slice(i, i + 1000);
    await db.delete(mediaAssets).where(inArray(mediaAssets.id, chunk));
    deleted += chunk.length;
  }
  console.log(`[reconcile-media] deleted ${deleted} stale rows`);
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
