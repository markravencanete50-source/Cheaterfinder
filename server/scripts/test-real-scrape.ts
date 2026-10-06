// ─── End-to-end live scrape test ────────────────────────────────────────────
//
// Runs the full Wave-4 pipeline against a real public IG account:
//   1. Pulls a healthy proxy + ensures bot session via leaseBot (auto-relogin
//      if needed).
//   2. Scrapes profile, posts, reels (clips), tagged posts, stories,
//      highlights, and one page of followers/following.
//   3. Reports row counts so we can eyeball coverage end-to-end.
//
// Usage:
//   npx tsx --env-file=.env server/scripts/test-real-scrape.ts <username>
//
// Default target: instagram (the official @instagram account) — a high-traffic
// public profile that always has data of every kind.

import {
  scrapeProfile,
  scrapeUserPosts,
  scrapeUserClips,
  scrapeUserTagged,
  scrapeUserStories,
  scrapeUserHighlights,
  scrapeUserFollowers,
  scrapeUserFollowing,
} from "../ig-public-scraper.js";

interface PipelineResult {
  readonly label: string;
  readonly count: number;
  readonly elapsedMs: number;
  readonly error?: string;
}

async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  countFn: (v: T) => number,
): Promise<PipelineResult> {
  const t0 = Date.now();
  try {
    const v = await fn();
    return { label, count: countFn(v), elapsedMs: Date.now() - t0 };
  } catch (err) {
    return {
      label,
      count: 0,
      elapsedMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const username = process.argv[2] ?? "instagram";
  console.log(`== live scrape: @${username} ==`);

  console.log("\n[1/8] profile");
  const profileT0 = Date.now();
  let profile;
  try {
    profile = await scrapeProfile(username);
    console.log(
      `  ✓ ${profile.username} (igUserId=${profile.igUserId}) | ${profile.followerCount} followers | ${profile.postCount} posts | ${
        ((Date.now() - profileT0) / 1000).toFixed(1)
      }s`,
    );
  } catch (err) {
    console.error(`  ✗ profile failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const igUserId = profile.igUserId;

  const results: PipelineResult[] = [];
  console.log("\n[2/8] posts (12)");
  results.push(
    await timed("posts", () => scrapeUserPosts(igUserId, 12), (xs) => xs.length),
  );
  console.log("\n[3/8] reels/clips (12)");
  results.push(
    await timed("clips", () => scrapeUserClips(igUserId, 12), (xs) => xs.length),
  );
  console.log("\n[4/8] tagged (12)");
  results.push(
    await timed("tagged", () => scrapeUserTagged(igUserId, 12), (xs) => xs.length),
  );
  console.log("\n[5/8] stories");
  results.push(
    await timed("stories", () => scrapeUserStories(igUserId), (xs) => xs.length),
  );
  console.log("\n[6/8] highlights tray");
  results.push(
    await timed(
      "highlights",
      () => scrapeUserHighlights(igUserId, { withItems: false }),
      (xs) => xs.length,
    ),
  );
  console.log("\n[7/8] followers (page 1)");
  results.push(
    await timed(
      "followers",
      () => scrapeUserFollowers(igUserId),
      (p) => p.users.length,
    ),
  );
  console.log("\n[8/8] following (page 1)");
  results.push(
    await timed(
      "following",
      () => scrapeUserFollowing(igUserId),
      (p) => p.users.length,
    ),
  );

  console.log("\n== summary ==");
  for (const r of results) {
    const status = r.error ? "✗" : "✓";
    const detail = r.error ? `FAIL: ${r.error}` : `${r.count} items`;
    console.log(
      `  ${status} ${r.label.padEnd(12)} ${detail}  (${(r.elapsedMs / 1000).toFixed(1)}s)`,
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
