// One-account authenticated content smoke test.
//
// Unlike the full collector, this deliberately calls exactly one request per
// content family: posts, active stories, and a full highlights read (tray plus
// reel items). It is intended for a manually selected, already-tracked account
// and persists through the same cache functions the web UI consumes.
//
// Required environment:
//   TEST_LIVE_CONTENT=1
//   TEST_IG_USERNAME=<already tracked username>
//
// This script never creates users/tracked accounts, never scans a roster, and
// prints only result counts and safe error summaries.

import "dotenv/config";

import { eq } from "drizzle-orm";

import { db, pool } from "../db.js";
import { trackedAccounts } from "../../shared/schema.js";
import {
  getUserHighlights,
  getUserPosts,
  getUserStories,
} from "../services/public-data-service.js";
import {
  persistHighlights,
  persistPosts,
  persistStories,
} from "../services/public-data-persistence.js";

const username = process.env.TEST_IG_USERNAME?.trim().toLowerCase();
const CONTENT_ENDPOINTS = ["posts", "stories", "highlights"] as const;
type ContentEndpoint = (typeof CONTENT_ENDPOINTS)[number];

function requireTestInputs(): string {
  if (process.env.TEST_LIVE_CONTENT !== "1") {
    throw new Error("Refusing to run: set TEST_LIVE_CONTENT=1 explicitly");
  }
  if (!username) {
    throw new Error("Refusing to run: set TEST_IG_USERNAME to an existing tracked account");
  }
  return username;
}

function selectedEndpoints(): ReadonlySet<ContentEndpoint> {
  const raw = process.env.TEST_LIVE_CONTENT_ENDPOINTS ?? CONTENT_ENDPOINTS.join(",");
  const selected = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (selected.length === 0) {
    throw new Error("Refusing to run: TEST_LIVE_CONTENT_ENDPOINTS cannot be empty");
  }
  for (const endpoint of selected) {
    if (!CONTENT_ENDPOINTS.includes(endpoint as ContentEndpoint)) {
      throw new Error(`Refusing to run: unsupported content endpoint ${endpoint}`);
    }
  }
  return new Set(selected as ContentEndpoint[]);
}

function summary<T>(
  result:
    | { readonly ok: true; readonly data: ReadonlyArray<T>; readonly source: string }
    | { readonly ok: false; readonly error: string; readonly source: string },
) {
  return result.ok
    ? { ok: true, source: result.source, count: result.data.length }
    : { ok: false, source: result.source, error: result.error };
}

async function main(): Promise<void> {
  const target = requireTestInputs();
  const endpoints = selectedEndpoints();
  const [account] = await db
    .select({
      id: trackedAccounts.id,
      igUserId: trackedAccounts.igUserId,
      igUsername: trackedAccounts.igUsername,
    })
    .from(trackedAccounts)
    .where(eq(trackedAccounts.igUsername, target))
    .limit(1);

  if (!account) {
    throw new Error(`Tracked account @${target} was not found`);
  }
  if (!account.igUserId) {
    throw new Error(`Tracked account @${target} has no resolved Instagram user id`);
  }

  // Sequential by design: a new test bot should make a short, realistic
  // content check, not three simultaneous authenticated calls.
  const posts = endpoints.has("posts")
    ? await getUserPosts(account.igUsername, account.igUserId, 12)
    : null;
  if (posts?.ok) {
    await persistPosts(account.id, posts.data, { pinnedAuthoritative: true });
  }

  const stories = endpoints.has("stories")
    ? await getUserStories(account.igUsername, account.igUserId)
    : null;
  if (stories?.ok) {
    await persistStories(account.id, stories.data);
  }

  // withItems=true reads the highlight tray and its reels through one leased
  // client, which lets this be a genuine full-content test with one endpoint
  // budget reservation.
  const highlights = endpoints.has("highlights")
    ? await getUserHighlights(
        account.igUsername,
        account.igUserId,
        true,
      )
    : null;
  if (highlights?.ok) {
    await persistHighlights(account.id, highlights.data);
  }

  const output = {
    target: `@${target}`,
    posts: posts ? summary(posts) : { skipped: true },
    stories: stories ? summary(stories) : { skipped: true },
    highlights: highlights ? summary(highlights) : { skipped: true },
  };
  console.log(JSON.stringify(output, null, 2));

  if (
    (posts !== null && !posts.ok) ||
    (stories !== null && !stories.ok) ||
    (highlights !== null && !highlights.ok)
  ) {
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[live-content-test] ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
