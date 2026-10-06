// One-off/operator import for an Instagram graph that native sessions cannot
// enumerate (for example a public profile returning special_empty_state).
//
// Usage:
//   npx tsx server/scripts/import-external-roster.ts tracked_user_1
//   npx tsx server/scripts/import-external-roster.ts example_account --following-only

// The persistence path is the production one: completeness gating, materialized
// roster reconciliation, churn cancellation, and silent baseline seeding all
// remain in force. A short provider response cannot be marked authoritative.

import "dotenv/config";

import { and, desc, eq, sql } from "drizzle-orm";

import { db, pool } from "../db.js";
import { trackedAccounts } from "../../shared/schema.js";
import { fetchApifyGraph } from "../services/apify-graph-fallback.js";
import {
  persistFollowerDiff,
  persistFollowingDiff,
} from "../services/public-data-persistence.js";
import { recordExternalRosterSuccessCooldown } from "../services/roster-store.js";

type Dimension = "followers" | "following";

async function main(): Promise<void> {
  const username = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!username) {
    throw new Error("usage: import-external-roster.ts <username> [--followers-only|--following-only]");
  }

  const followersOnly = process.argv.includes("--followers-only");
  const followingOnly = process.argv.includes("--following-only");
  if (followersOnly && followingOnly) {
    throw new Error("choose at most one of --followers-only and --following-only");
  }
  const dimensions: Dimension[] = followersOnly
    ? ["followers"]
    : followingOnly
      ? ["following"]
      : ["followers", "following"];

  const accounts = await db
    .select({ id: trackedAccounts.id, igUsername: trackedAccounts.igUsername })
    .from(trackedAccounts)
    .where(
      and(
        sql`lower(${trackedAccounts.igUsername}) = lower(${username})`,
        eq(trackedAccounts.isActive, true),
      ),
    )
    .orderBy(desc(trackedAccounts.updatedAt));

  if (accounts.length === 0) throw new Error(`no active tracked account found for @${username}`);
  if (accounts.length > 1) {
    console.log(`[external-roster] @${username} belongs to ${accounts.length} active tracking records; importing each`);
  }

  // The service enforces APIFY_GRAPH_MAX_ITEMS as the real upper bound.
  const requestedLimit = Number(process.env.APIFY_GRAPH_MAX_ITEMS ?? 2_000);
  const fetched = await Promise.all(
    dimensions.map(async (dimension) => ({
      dimension,
      users: await fetchApifyGraph(username, dimension, requestedLimit),
    })),
  );

  const now = new Date();
  for (const account of accounts) {
    const completed = new Set<Dimension>();
    for (const item of fetched) {
      if (item.dimension === "followers") {
        const outcome = await persistFollowerDiff(account.id, item.users, {
          trustedBaseline: true,
        });
        await recordExternalRosterSuccessCooldown(account.id, "follower");
        await db
          .update(trackedAccounts)
          .set({ lastFollowersRefreshAt: now, updatedAt: now })
          .where(eq(trackedAccounts.id, account.id));
        console.log(
          `[external-roster] @${account.igUsername} followers=${item.users.length} new=${outcome.newFollowers} left=${outcome.newFollowerUnfollows}`,
        );
      } else {
        const outcome = await persistFollowingDiff(account.id, item.users, {
          trustedBaseline: true,
        });
        await recordExternalRosterSuccessCooldown(account.id, "following");
        await db
          .update(trackedAccounts)
          .set({ lastFollowingRefreshAt: now, updatedAt: now })
          .where(eq(trackedAccounts.id, account.id));
        console.log(
          `[external-roster] @${account.igUsername} following=${item.users.length} new=${outcome.newFollows} left=${outcome.newUnfollows}`,
        );
      }
      completed.add(item.dimension);
    }

    if (completed.has("followers") && completed.has("following")) {
      await db
        .update(trackedAccounts)
        .set({ lastGraphRefreshAt: now, updatedAt: now })
        .where(eq(trackedAccounts.id, account.id));
    }
  }
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error("[external-roster] fatal:", error);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
