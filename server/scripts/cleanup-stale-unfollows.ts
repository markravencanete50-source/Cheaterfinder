// ─── Cleanup stale (false-positive) follower_unfollow_events ────────────────
//
// Wave 5 hotfix: prior to the diff-completeness gate, partial-capture
// scrapes (e.g. 12 followers seen for an account that actually has 495)
// emitted a flood of false-positive unfollow events. Those rows are
// detectable today: the "unfollower" username STILL appears in the latest
// follower_events for the same tracked_account, meaning the person never
// actually unfollowed — they were just absent from one short scrape and
// re-detected on the next.
//
// This script deletes those false-positive rows. It is idempotent: the
// SELECT-then-DELETE approach only removes rows whose username currently
// has a matching follower_events row. New unfollow events written after
// this run remain untouched.
//
// Run with:
//   npx tsx server/scripts/cleanup-stale-unfollows.ts
//
// Env required:
//   DATABASE_URL
// ────────────────────────────────────────────────────────────────────────────

import { sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  followerEvents,
  followerUnfollowEvents,
  trackedAccounts,
} from "../../shared/schema.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "cleanup-stale-unfollows" });

interface CleanupSummary {
  readonly trackedAccountId: string;
  readonly igUsername: string;
  readonly removed: number;
}

async function countAllUnfollows(): Promise<number> {
  const rows = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM ${followerUnfollowEvents}`,
  );
  // drizzle's execute returns a result object; normalize to first row.
  const first = (rows as unknown as { rows?: Array<{ count: string }> })
    .rows?.[0] ?? (rows as unknown as Array<{ count: string }>)[0];
  return Number.parseInt(first?.count ?? "0", 10);
}

async function cleanupForAccount(
  trackedAccountId: string,
  igUsername: string,
): Promise<CleanupSummary> {
  // Delete unfollow rows where the unfollower's username STILL exists in
  // follower_events for the same tracked account. Those rows are by
  // definition false positives: a user can't simultaneously be a current
  // follower and an unfollower.
  const result = await db.execute<{ id: string }>(sql`
    DELETE FROM ${followerUnfollowEvents}
    WHERE tracked_account_id = ${trackedAccountId}
      AND LOWER(unfollower_username) IN (
        SELECT LOWER(follower_username)
        FROM ${followerEvents}
        WHERE tracked_account_id = ${trackedAccountId}
      )
    RETURNING id
  `);

  const deleted =
    (result as unknown as { rowCount?: number }).rowCount ??
    (result as unknown as { rows?: Array<{ id: string }> }).rows?.length ??
    (result as unknown as Array<{ id: string }>).length ??
    0;

  return {
    trackedAccountId,
    igUsername,
    removed: deleted,
  };
}

async function main(): Promise<void> {
  const before = await countAllUnfollows();
  logger.info({ before }, "[cleanup] starting; total follower_unfollow_events");

  const accounts = await db
    .select({
      id: trackedAccounts.id,
      igUsername: trackedAccounts.igUsername,
    })
    .from(trackedAccounts);

  let totalRemoved = 0;
  const perAccount: CleanupSummary[] = [];

  for (const acct of accounts) {
    try {
      const summary = await cleanupForAccount(acct.id, acct.igUsername);
      if (summary.removed > 0) {
        perAccount.push(summary);
        totalRemoved += summary.removed;
        logger.info(
          {
            trackedAccountId: summary.trackedAccountId,
            igUsername: summary.igUsername,
            removed: summary.removed,
          },
          "[cleanup] removed stale unfollow rows for account",
        );
      }
    } catch (err: unknown) {
      logger.error(
        {
          trackedAccountId: acct.id,
          igUsername: acct.igUsername,
          err: err instanceof Error ? err.message : String(err),
        },
        "[cleanup] failed to clean account",
      );
    }
  }

  const after = await countAllUnfollows();

  logger.info(
    {
      accountsTouched: perAccount.length,
      before,
      after,
      totalRemoved,
    },
    "[cleanup] done",
  );

  // Surface a concise human-readable summary on stdout for ops.
  // This is a script, not server code — direct stdout writes are appropriate.
  process.stdout.write(
    `[cleanup-stale-unfollows] before=${before} after=${after} removed=${totalRemoved} accountsTouched=${perAccount.length}\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[cleanup] fatal",
    );
    process.exit(1);
  });
