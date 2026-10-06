import "dotenv/config";
import {
  scrapeUserStories,
  scrapeUserHighlights,
} from "../ig-public-scraper.js";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<void> {
  const t = Date.now();
  try {
    const r = await fn();
    const n = Array.isArray(r) ? r.length : "?";
    console.log(`[test] ${label}: OK (${n} items) in ${Date.now() - t}ms`);
  } catch (e) {
    console.log(
      `[test] ${label}: FAIL in ${Date.now() - t}ms → ${
        (e as Error)?.message?.slice(0, 160)
      }`,
    );
  }
}

async function main() {
  const igUserId = process.argv[2] || "00000000000"; // example_account
  console.log(`[test] igUserId=${igUserId}`);
  await timed("stories", () => scrapeUserStories(igUserId));
  await timed("highlights", () => scrapeUserHighlights(igUserId, { withItems: true }));
  process.exit(0);
}
main();
