// ─── Integration test for the profile collection worker ────────────────────
//
// Exercises the real end-to-end public-data path — no mocks, no DB stubs.
// Run with:
//
//   npx tsx server/scripts/test-worker-integration.ts
//
// Preconditions:
//   - DATABASE_URL points at a working Postgres (the `cheaterfinder_ai` DB)
//   - At least one working bot in bot_accounts (Apify removed — the bot
//     pool is the only public-data source)
//   - SESSION_DATA_KEY set (if any bot rows store encrypted sessions)
//
// The script:
//   1. Creates a throw-away user + tracked_accounts row for @taylorswift
//      (idempotent — reuses the row on re-run).
//   2. Invokes the public-data collector directly (same code path as the
//      profile worker — no BullMQ involved for determinism).
//   3. Asserts: tracked_accounts.profile_pic_url is a https URL,
//      profile_snapshots has is_verified = true, and at least one of
//      posts_cache / stories_cache / highlights_cache has rows.
//   4. Always leaves the test row in place (the next run reuses it) so you
//      can inspect state in psql. Use DELETE FROM users WHERE email=... to
//      clean up.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";

import { and, count, eq } from "drizzle-orm";

import { db, pool } from "../db.js";
import {
  users,
  trackedAccounts,
  profileSnapshots,
  postsCache,
  storiesCache,
  highlightsCache,
  followerEvents,
} from "../../shared/schema.js";
import { collectPublicData } from "../services/public-data-collector.js";

const TARGET_USERNAME = process.env.TEST_IG_USERNAME ?? "taylorswift";
const TEST_USER_EMAIL = "test-worker-integration@cheaterfinder.test";
const TEST_USER_NAME = "Worker Integration Test";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function ensureTestUser(): Promise<string> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, TEST_USER_EMAIL))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(users)
    .values({ email: TEST_USER_EMAIL, name: TEST_USER_NAME })
    .returning();
  return created.id;
}

async function ensureTrackedAccount(userId: string): Promise<string> {
  const [existing] = await db
    .select()
    .from(trackedAccounts)
    .where(
      and(
        eq(trackedAccounts.userId, userId),
        eq(trackedAccounts.igUsername, TARGET_USERNAME),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(trackedAccounts)
    .values({
      userId,
      igUsername: TARGET_USERNAME,
      displayName: TARGET_USERNAME,
    })
    .returning();
  return created.id;
}

async function main(): Promise<void> {
  console.log(`[test] target username: ${TARGET_USERNAME}`);

  const userId = await ensureTestUser();
  const trackedAccountId = await ensureTrackedAccount(userId);
  console.log(`[test] trackedAccountId=${trackedAccountId}`);

  const [account] = await db
    .select()
    .from(trackedAccounts)
    .where(eq(trackedAccounts.id, trackedAccountId))
    .limit(1);
  assert(account, "tracked account should exist");

  console.log("[test] invoking collectPublicData…");
  const started = Date.now();
  const outcome = await collectPublicData(account!);
  const elapsedMs = Date.now() - started;
  console.log(`[test] collector done in ${elapsedMs}ms`);
  console.log("[test] outcome:", JSON.stringify(outcome, null, 2));

  const failures: string[] = [];

  // Assertion 1: profile fetch succeeded
  try {
    assert(outcome.profile.ok, `profile fetch failed: ${outcome.profile.error ?? "?"}`);
  } catch (err) {
    failures.push((err as Error).message);
  }

  // Assertion 2: tracked_accounts.profile_pic_url is populated and https
  const [hydrated] = await db
    .select()
    .from(trackedAccounts)
    .where(eq(trackedAccounts.id, trackedAccountId))
    .limit(1);
  console.log(
    "[test] tracked_accounts (after collector):",
    JSON.stringify(
      {
        igUserId: hydrated?.igUserId,
        profilePicUrl: hydrated?.profilePicUrl,
        followerCount: hydrated?.followerCount,
        isVerified: hydrated?.isVerified,
        biography: hydrated?.biography?.slice(0, 40),
      },
      null,
      2,
    ),
  );
  try {
    assert(
      typeof hydrated?.profilePicUrl === "string" &&
        hydrated!.profilePicUrl!.startsWith("https://"),
      `tracked_accounts.profile_pic_url should be https: got ${hydrated?.profilePicUrl}`,
    );
  } catch (err) {
    failures.push((err as Error).message);
  }

  // Assertion 3: profile_snapshots has a row with is_verified = true
  const [snap] = await db
    .select()
    .from(profileSnapshots)
    .where(eq(profileSnapshots.trackedAccountId, trackedAccountId))
    .orderBy(profileSnapshots.snapshotAt)
    .limit(1);
  console.log(
    "[test] latest profile_snapshot:",
    JSON.stringify(
      {
        fullName: snap?.fullName,
        isVerified: snap?.isVerified,
        followerCount: snap?.followerCount,
        followingCount: snap?.followingCount,
        postCount: snap?.postCount,
      },
      null,
      2,
    ),
  );
  try {
    assert(snap, "profile_snapshots row should exist");
    assert(snap?.isVerified === true, `profile_snapshots.is_verified !== true (got ${snap?.isVerified})`);
  } catch (err) {
    failures.push((err as Error).message);
  }

  // Assertion 4: at least one of posts_cache / stories_cache / highlights_cache has rows
  const [[postsRow], [storiesRow], [highlightsRow], [followersRow]] = await Promise.all([
    db.select({ n: count() }).from(postsCache).where(eq(postsCache.trackedAccountId, trackedAccountId)),
    db.select({ n: count() }).from(storiesCache).where(eq(storiesCache.trackedAccountId, trackedAccountId)),
    db.select({ n: count() }).from(highlightsCache).where(eq(highlightsCache.trackedAccountId, trackedAccountId)),
    db.select({ n: count() }).from(followerEvents).where(eq(followerEvents.trackedAccountId, trackedAccountId)),
  ]);
  const postsCount = Number(postsRow?.n ?? 0);
  const storiesCount = Number(storiesRow?.n ?? 0);
  const highlightsCount = Number(highlightsRow?.n ?? 0);
  const followersCount = Number(followersRow?.n ?? 0);
  console.log(
    `[test] cache counts → posts=${postsCount} stories=${storiesCount} highlights=${highlightsCount} followers=${followersCount}`,
  );
  try {
    assert(
      postsCount > 0 || storiesCount > 0 || highlightsCount > 0,
      "expected at least one of posts_cache / stories_cache / highlights_cache to have rows",
    );
  } catch (err) {
    failures.push((err as Error).message);
  }

  if (failures.length > 0) {
    console.error("\n[test] FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log("\n[test] ALL ASSERTIONS PASSED");
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("[test] fatal error:", err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
