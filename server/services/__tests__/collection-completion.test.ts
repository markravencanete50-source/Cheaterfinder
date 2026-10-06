import { describe, expect, it } from "vitest";
import { collectionCompletion, partialCollectionNeedsRetry } from "../collection-completion.js";
import type { CollectOutcome } from "../public-data-collector.js";

const complete = (): CollectOutcome => ({
  profile: { ok: true, source: "bot" },
  posts: { count: 12, source: "bot" }, stories: { count: 0, source: "bot" }, highlights: { count: 2, source: "bot" },
  following: { source: "bot", newFollows: 0, newUnfollows: 0 },
  followers: { source: "bot", newFollowers: 0, newFollowerUnfollows: 0 }, isPrivate: false,
});

describe("collection completion evidence", () => {
  it("accepts a real empty stories response", () => expect(collectionCompletion(complete())).toEqual({ status: "completed", error: null }));
  it.each(["posts", "stories", "highlights", "following", "followers"] as const)("does not hide %s failure behind a successful profile", feature => {
    const outcome = complete();
    expect(collectionCompletion({ ...outcome, [feature]: { ...outcome[feature], error: "HTTP 500" } })).toEqual({ status: "failed", error: `partial collection: ${feature}: HTTP 500` });
  });
  it("surfaces engagement failures independently from successful posts", () => {
    const result = collectionCompletion({ ...complete(), engagement: {
      likers: { checked: 1, failed: 2, skipped: 0 }, comments: { checked: 3, failed: 0, skipped: 0 },
    } });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("likers: 2 post reads failed; 1 succeeded");
  });
  it("does not call intentionally disabled or fresh features failures", () => {
    const result = collectionCompletion({ ...complete(),
      posts: { count: 0, source: "none", error: "posts disabled" },
      following: { source: "none", newFollows: 0, newUnfollows: 0, error: "skipped: unchanged (diff-aware)" },
    });
    expect(result.status).toBe("completed");
  });
  it("keeps a restricted roster visibly incomplete", () => {
    const outcome = complete();
    expect(collectionCompletion({ ...outcome, following: { ...outcome.following, error: "skipped: restricted-backoff (diff-aware)" } }).status).toBe("failed");
  });
  it("surfaces a top-level engagement failure", () => {
    expect(collectionCompletion({ ...complete(), engagement: { likers: { checked: 0, failed: 0, skipped: 0 }, comments: { checked: 0, failed: 0, skipped: 0 }, error: "database unavailable" } }).error).toContain("engagement: database unavailable");
  });
  it("bounds stored diagnostics", () => {
    expect(collectionCompletion({ ...complete(), posts: { count: 0, source: "bot", error: "x".repeat(9000) } }).error?.length).toBe(4000);
  });
});

describe("partial collection recovery", () => {
  const now = Date.now();
  const row = { status: "failed", error: "partial collection: posts: HTTP 500", completedAt: new Date(now - 15 * 60_000) };
  it("allows the next scheduled cycle to repair media despite a fresh profile", () => expect(partialCollectionNeedsRetry(row, now)).toBe(true));
  it("does not immediately hammer a failed read", () => expect(partialCollectionNeedsRetry({ ...row, completedAt: new Date(now - 1000) }, now)).toBe(false));
  it.each([undefined, { ...row, status: "completed" }, { ...row, completedAt: null }, { ...row, error: "skipped: inactive" }])("ignores non-partial evidence", previous => expect(partialCollectionNeedsRetry(previous, now)).toBe(false));
});
