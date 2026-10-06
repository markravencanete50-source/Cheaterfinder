import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { OperationBusyError, resultRows, withOperationLease } from "./operation-lease.js";

/** Freshness belongs to the successful READ, including empty/unchanged results,
 * not to the first-seen timestamp of a liker/comment row. Failures stay due.
 */
export async function refreshEngagementOnce(
  mediaId: string,
  kind: "likers" | "comments",
  refresh: () => Promise<boolean>,
): Promise<void> {
  try {
    await withOperationLease(`interactive:${kind}:${mediaId}`, async (signal) => {
      const recent = resultRows(await db.execute(sql`
        SELECT 1 FROM interactive_refresh_state
        WHERE media_id = ${mediaId} AND kind = ${kind}
          AND succeeded_at > now() - interval '5 minutes'
        UNION ALL
        SELECT 1 FROM post_engagement_checks
        WHERE media_id = ${mediaId} AND kind = ${kind}
          AND checked_at > now() - interval '5 minutes'
        LIMIT 1
      `));
      if (recent.length) return;
      if (!await refresh()) return;
      signal.throwIfAborted();
      await db.execute(sql`
        INSERT INTO interactive_refresh_state (media_id, kind, succeeded_at)
        VALUES (${mediaId}, ${kind}, now())
        ON CONFLICT (media_id, kind) DO UPDATE SET succeeded_at = EXCLUDED.succeeded_at
      `);
    });
  } catch (err) {
    if (!(err instanceof OperationBusyError)) throw err;
    // Another request owns the refresh; this caller serves the existing cache.
  }
}
