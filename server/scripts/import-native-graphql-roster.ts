// One-off/operator import for a public Instagram profile whose REST
// friendship endpoint returns `special_empty_state`. The normal HTTP client
// transparently switches to Instagram's authenticated public GraphQL
// connection and this script walks the cursors to exhaustion before touching
// the materialized roster.
//
// Usage:
//   npx tsx server/scripts/import-native-graphql-roster.ts tracked_user_1

// A truncated capture is rejected: partial results must never be mistaken for
// absence evidence or turn missing pages into false unfollows.

import "dotenv/config";

import { and, desc, eq, sql } from "drizzle-orm";

import { db, pool } from "../db.js";
import { trackedAccounts } from "../../shared/schema.js";
import {
  getAllUserFollowers,
  getAllUserFollowing,
} from "../services/public-data-service.js";
import {
  persistFollowerDiff,
  persistFollowingDiff,
} from "../services/public-data-persistence.js";

const pagination = {
  maxPages: 200,
  maxItems: 5_000,
  pageDelayMinMs: 1_500,
  pageDelayMaxMs: 2_500,
} as const;

async function main(): Promise<void> {
  const username = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!username) {
    throw new Error("usage: import-native-graphql-roster.ts <username>");
  }

  const accounts = await db
    .select({
      id: trackedAccounts.id,
      igUsername: trackedAccounts.igUsername,
      igUserId: trackedAccounts.igUserId,
    })
    .from(trackedAccounts)
    .where(
      and(
        sql`lower(${trackedAccounts.igUsername}) = lower(${username})`,
        eq(trackedAccounts.isActive, true),
      ),
    )
    .orderBy(desc(trackedAccounts.updatedAt));

  if (accounts.length === 0) {
    throw new Error(`no active tracked account found for @${username}`);
  }
  const igUserId = accounts[0]?.igUserId;
  if (!igUserId) throw new Error(`@${username} has no Instagram numeric user id`);
  if (accounts.some((account) => account.igUserId !== igUserId)) {
    throw new Error(`active @${username} records disagree on Instagram user id`);
  }

  console.log(`[native-graphql-roster] fetching @${username} followers + following`);
  const [followers, following] = await Promise.all([
    getAllUserFollowers(username, igUserId, pagination),
    getAllUserFollowing(igUserId, {
      ...pagination,
      fallbackUsername: username,
    }),
  ]);

  if (!followers.ok) throw new Error(`followers failed: ${followers.error}`);
  if (!following.ok) throw new Error(`following failed: ${following.error}`);
  if (!followers.complete) {
    throw new Error(
      `followers truncated (${followers.stopReason}) after ${followers.data.length} rows`,
    );
  }
  if (!following.complete) {
    throw new Error(
      `following truncated (${following.stopReason}) after ${following.data.length} rows`,
    );
  }

  console.log(
    `[native-graphql-roster] complete capture followers=${followers.data.length} following=${following.data.length}`,
  );

  const now = new Date();
  for (const account of accounts) {
    const followerDiff = await persistFollowerDiff(account.id, followers.data, {
      trustedBaseline: true,
    });
    const followingDiff = await persistFollowingDiff(account.id, following.data, {
      trustedBaseline: true,
    });
    await db
      .update(trackedAccounts)
      .set({
        lastFollowersRefreshAt: now,
        lastFollowingRefreshAt: now,
        lastGraphRefreshAt: now,
        updatedAt: now,
      })
      .where(eq(trackedAccounts.id, account.id));
    console.log(
      `[native-graphql-roster] @${account.igUsername} imported followers=${followers.data.length} following=${following.data.length} newFollowers=${followerDiff.newFollowers} newFollows=${followingDiff.newFollows}`,
    );
  }
}

main()
  .then(async () => {
    await pool.end();
    // Bot/runtime modules keep background handles (Redis) alive in operator
    // processes. The database work is complete at this point, so terminate
    // explicitly instead of leaving the shell command hanging.
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(
      "[native-graphql-roster] fatal:",
      error instanceof Error ? error.message : String(error),
    );
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
