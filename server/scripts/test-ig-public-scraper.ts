// ─── Live smoke test for ig-public-scraper ─────────────────────────────────
//
// Run against a real bot session. Exits non-zero on any assertion failure.
//
//   npx tsx server/scripts/test-ig-public-scraper.ts
//
// Preconditions:
//   - DATABASE_URL set
//   - SESSION_DATA_KEY set (if any bot rows store encrypted sessions)
//   - at least one bot_accounts row with status='available' and a valid
//     Playwright storageState in session_data
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";

import {
  scrapeProfile,
  scrapeUserFollowers,
  scrapeUserHighlights,
  scrapeUserPosts,
  scrapeUserStories,
} from "../ig-public-scraper.js";
import { pool } from "../db.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`ASSERT FAIL: ${message}`);
  }
}

async function main(): Promise<void> {
  const target = process.env.TEST_IG_USERNAME ?? "taylorswift";
  const failures: string[] = [];

  // 1) scrapeProfile
  console.log(`[test] scrapeProfile(${target})...`);
  const profile = await scrapeProfile(target);
  console.log(
    JSON.stringify(
      {
        step: "profile",
        igUserId: profile.igUserId,
        username: profile.username,
        followerCount: profile.followerCount,
        followingCount: profile.followingCount,
        postCount: profile.postCount,
        isVerified: profile.isVerified,
        isPrivate: profile.isPrivate,
      },
      null,
      2,
    ),
  );
  try {
    assert(profile.igUserId.length > 0, "profile.igUserId empty");
    assert(
      profile.username.toLowerCase() === target.toLowerCase(),
      `profile.username mismatch: ${profile.username}`,
    );
    assert(
      profile.followerCount > 100_000_000,
      `followerCount <= 100M: ${profile.followerCount}`,
    );
    assert(profile.isVerified === true, "isVerified !== true");
  } catch (err) {
    console.error("[test]", err instanceof Error ? err.message : err);
    failures.push("scrapeProfile");
  }

  // 2) scrapeUserPosts
  try {
    console.log(`[test] scrapeUserPosts(${profile.igUserId}, 5)...`);
    const posts = await scrapeUserPosts(profile.igUserId, 5);
    console.log(
      JSON.stringify(
        {
          step: "posts",
          count: posts.length,
          sample: posts[0]
            ? {
                shortcode: posts[0].shortcode,
                postType: posts[0].postType,
                likeCount: posts[0].likeCount,
                commentCount: posts[0].commentCount,
                hashtags: posts[0].hashtags,
                captionPreview: posts[0].caption.slice(0, 80),
                thumbnailUrlLen: posts[0].thumbnailUrl.length,
              }
            : null,
        },
        null,
        2,
      ),
    );
    assert(posts.length === 5, `expected 5 posts, got ${posts.length}`);
    assert(
      posts.every((p) => p.shortcode.length > 0),
      "some posts missing shortcode",
    );
  } catch (err) {
    console.error("[test]", err instanceof Error ? err.message : err);
    failures.push("scrapeUserPosts");
  }

  // 3) scrapeUserStories
  try {
    console.log(`[test] scrapeUserStories(${profile.igUserId})...`);
    const stories = await scrapeUserStories(profile.igUserId);
    console.log(
      JSON.stringify(
        {
          step: "stories",
          count: stories.length,
          sample: stories[0]
            ? {
                storyId: stories[0].storyId,
                mediaType: stories[0].mediaType,
                mediaUrlLen: stories[0].mediaUrl.length,
                takenAt: stories[0].takenAt.toISOString(),
                expiresAt: stories[0].expiresAt.toISOString(),
              }
            : null,
        },
        null,
        2,
      ),
    );
    assert(Array.isArray(stories), "stories is not an array");
  } catch (err) {
    console.error("[test]", err instanceof Error ? err.message : err);
    failures.push("scrapeUserStories");
  }

  // 4) scrapeUserHighlights
  try {
    console.log(`[test] scrapeUserHighlights(${profile.igUserId})...`);
    const highlights = await scrapeUserHighlights(profile.igUserId);
    console.log(
      JSON.stringify(
        {
          step: "highlights",
          count: highlights.length,
          sample: highlights[0]
            ? {
                highlightId: highlights[0].highlightId,
                title: highlights[0].title,
                mediaCount: highlights[0].mediaCount,
                coverUrlLen: highlights[0].coverUrl.length,
              }
            : null,
        },
        null,
        2,
      ),
    );
    assert(Array.isArray(highlights), "highlights is not an array");
  } catch (err) {
    console.error("[test]", err instanceof Error ? err.message : err);
    failures.push("scrapeUserHighlights");
  }

  // 5) scrapeUserFollowers (smoke — single page, don't assert content)
  try {
    console.log(`[test] scrapeUserFollowers(${profile.igUserId})...`);
    const page = await scrapeUserFollowers(profile.igUserId);
    console.log(
      JSON.stringify(
        {
          step: "followers",
          count: page.users.length,
          hasCursor: page.nextCursor !== null,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("[test]", err instanceof Error ? err.message : err);
    failures.push("scrapeUserFollowers");
  }

  if (failures.length > 0) {
    console.error(`[test] FAILED: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("[test] all assertions passed");
  }
}

main()
  .catch((err) => {
    console.error("[test] fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  });
