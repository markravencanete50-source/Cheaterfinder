import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isTrialPreview, PREVIEW_MEDIA_URL, sanitizeTrialPreview, unwrapPreviewCursor, wrapPreviewCursor,
  type TrialPreviewKind,
} from "../trial-preview.js";

const scope = { userId: "customer-a", trackedAccountId: "account-a", dimension: "followers" as const };
const cursor = "2026-09-27T12:40:17.432Z|actual.last_follower";
const realProfile = {
  igUsername: "tracked.account", displayName: "Tracked Account", profilePicUrl: "/api/media/permitted-avatar",
  isVerified: true, isPrivate: false, followerCount: 1593, followingCount: 275, postCount: 46,
};
const project = (kind: TrialPreviewKind, value: unknown, userId = scope.userId) =>
  sanitizeTrialPreview(kind, value, userId, scope) as any;

beforeEach(() => vi.stubEnv("SESSION_SECRET", "isolated-preview-test-secret"));
afterEach(() => vi.unstubAllEnvs());

/** Compare the actual JSON wire contract, excluding the deliberate preview marker. */
function shape(value: any): any {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "trialPreview")
      .map(([key, child]) => [key, shape(child)]));
  }
  return "scalar";
}

describe("trial preview policy", () => {
  it("requires the literal trialing status and never treats active or missing billing as a trial", () => {
    expect(isTrialPreview({ status: "trialing" })).toBe(true);
    for (const subscription of [undefined, null, {}, { status: "active" }, { status: "past_due" }, { status: "canceled" }]) {
      expect(isTrialPreview(subscription)).toBe(false);
    }
  });

  it("keeps only the allowed current profile, including its latest snapshot, and redacts historical profiles", () => {
    const snapshot = { ...realProfile, fullName: "Tracked Account", biography: "Secret profile biography",
      externalUrl: "https://secret.example", profilePicUrlHd: "https://cdn.example/hd.jpg", snapshotAt: new Date("2026-09-26T00:00:00Z") };
    const payload = { ...realProfile, id: "account-a", userId: "customer-a", isActive: true, accessStatus: "public",
      biography: snapshot.biography, externalUrl: snapshot.externalUrl,
      profileSnapshots: [snapshot, { ...snapshot, followerCount: 1520 }], postsNextCursor: "actual-ig-cursor" };
    const result = project("account", payload);
    expect(result).toMatchObject({ ...realProfile, id: "account-a", userId: "customer-a", isActive: true,
      accessStatus: "public", biography: null, externalUrl: null, postsNextCursor: null, trialPreview: true });
    expect(result.profileSnapshots[0]).toMatchObject({ ...realProfile, fullName: "Tracked Account", biography: null,
      externalUrl: null, profilePicUrlHd: PREVIEW_MEDIA_URL });
    expect(result.profileSnapshots[1].followerCount).toBeNull();
    expect(result.profileSnapshots[1].fullName).toBe("Instagram User");
    expect(result.profileSnapshots[1].igUsername).toMatch(/^user_[a-f0-9]{12}$/);
    expect(result.profileSnapshots[1].profilePicUrl).toBe(PREVIEW_MEDIA_URL);
    expect(result.profileSnapshots[0].snapshotAt).not.toBe(snapshot.snapshotAt.toISOString());
    expect(Number.isFinite(Date.parse(result.profileSnapshots[0].snapshotAt))).toBe(true);
    expect(shape(result)).toEqual(shape(payload));
    expect(payload.profileSnapshots[1].followerCount).toBe(1520);
  });

  it("keeps each account-list profile while redacting collected likes/follows and internal provider cursors", () => {
    const result = project("accounts", [{ ...realProfile, id: "account-a", likeCount: 119, followCount: 82,
      igUserId: "123456789012", postsNextCursor: "provider-cursor" }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ...realProfile, id: "account-a", likeCount: null, followCount: null,
      postsNextCursor: null, trialPreview: true });
    expect(result[0].igUserId).toMatch(/^preview_/);
  });

  it("recursively removes identities, content, links, original dates and media from all viewer sections", () => {
    const actual = {
      ...realProfile, profileSnapshot: { ...realProfile, fullName: "Tracked Account", biography: "Secret bio" },
      recentPosts: [{ shortcode: "REALSHORTCODE", postType: "carousel", thumbnailUrl: "https://secret.example/thumb",
        displayUrl: "https://secret.example/image", videoUrl: "https://secret.example/video", caption: "SECRET_CAPTION",
        likeCount: 7283, commentCount: 817, videoViewCount: 9900, takenAt: "2026-09-27T01:02:03Z",
        hashtags: ["SECRET_HASH_ONE", "SECRET_HASH_TWO"],
        carouselMedia: [{ type: "video", displayUrl: "https://secret.example/child", videoUrl: "https://secret.example/childvideo" }] }],
      recentLikes: [{ postId: "REALPOSTID", ownerUsername: "secret.liked_account", postUrl: "https://instagram.com/p/REALPOSTID",
        thumbnailUrl: "https://secret.example/liked", likesCount: 453, detectedAt: "2026-09-27T03:02:01Z" }],
      stories: [{ storyId: "REALSTORYID", mediaType: "video", mediaUrl: "https://secret.example/story",
        thumbnailUrl: "https://secret.example/storythumb", takenAt: "2026-09-27T01:00:00Z", expiresAt: "2026-09-28T01:00:00Z" }],
      highlights: [{ highlightId: "REALHIGHLIGHTID", title: "SECRET_HIGHLIGHT_TITLE", coverUrl: "https://secret.example/cover",
        mediaCount: 72, items: [{ storyId: "REALCHILDSTORYID", mediaUrl: "https://secret.example/highlight-child" }] }],
      recentFollows: [{ followedUsername: "secret.followed", followedDisplayName: "SECRET_FOLLOWED_NAME", followedPfpUrl: "https://secret.example/followed" }],
      recentFollowers: [{ followerUsername: "secret.follower", followerDisplayName: "SECRET_FOLLOWER_NAME", followerPfpUrl: "https://secret.example/follower" }],
      recentUnfollows: [{ unfollowedUsername: "secret.unfollowed", unfollowedPfpUrl: "https://secret.example/unfollowed" }],
      recentFollowerUnfollows: [{ unfollowerUsername: "secret.unfollower", unfollowerPfpUrl: "https://secret.example/unfollower" }],
      weeklyStats: { totalLikes: 9001, totalFollows: 191, totalUnfollows: 391, totalPosts: 871 },
      topNiche: "SECRET_NICHE", peakActivityHour: 21,
      activityByDate: [{ date: "2026-09-27", count: 481 }], activityByHour: [{ hour: 21, count: 718 }],
      futureNewPrivateField: { leakedText: "SECRET_FUTURE_TEXT", leakedNumber: 19617 },
    };
    const result = project("viewer", actual);
    const serialized = JSON.stringify(result);
    for (const marker of ["SECRET_", "https://secret.example", "secret.", "REALSHORTCODE", "REALPOSTID", "REALSTORYID",
      "REALHIGHLIGHTID", "REALCHILDSTORYID", "2026-09-27", "2026-09-28", "19617", "9001"]) {
      expect(serialized).not.toContain(marker);
    }
    expect(result).toMatchObject(realProfile);
    expect(result.profileSnapshot).toMatchObject({ ...realProfile, fullName: "Tracked Account", biography: null });
    expect(result.recentPosts[0]).toMatchObject({ postType: "carousel", likeCount: null, commentCount: null,
      videoViewCount: null, trialPreview: true, videoUrl: PREVIEW_MEDIA_URL });
    expect(result.recentPosts[0].carouselMedia[0]).toMatchObject({ type: "video", videoUrl: PREVIEW_MEDIA_URL });
    expect(result.recentLikes[0].postUrl).toBeNull();
    expect(result.activityByHour).toEqual([{ hour: 21, count: null }]);
    expect(shape(result)).toEqual(shape(actual));
  });

  it.each(["likers", "comments"] as const)("redacts the exact engagement count in the %s envelope", kind => {
    const result = project(kind, { items: [{ username: "someone" }], total: 1, expectedTotal: 9163, isPartial: true });
    expect(result).toMatchObject({ total: 1, expectedTotal: null, isPartial: true });
  });

  it("uses stable customer-scoped identities independent of row positions and endpoint names", () => {
    const first = project("likers", { items: [{ username: "Alice", igUserId: "1001" }, { username: "bob" }] });
    const second = project("roster", { items: [{ username: "bob" }, { username: "alice", igUserId: "1001" }], nextCursor: null });
    const comments = project("comments", { items: [{ author: "ALICE" }] });
    const anotherUser = project("likers", { items: [{ username: "Alice", igUserId: "1001" }] }, "customer-b");
    expect(first.items[0].username).toBe(second.items[1].username);
    expect(first.items[0].igUserId).toBe(second.items[1].igUserId);
    expect(first.items[0].username).toBe(comments.items[0].author);
    expect(first.items[0].username).not.toBe(first.items[1].username);
    expect(first.items[0].username).not.toBe(anotherUser.items[0].username);
  });

  it.each(["feed", "posts", "likers", "comments"] as const)("preserves %s page keys, cardinality and operational pagination", kind => {
    const payload = { items: [{ id: "event-a", username: "private.one", displayName: "Private One", pfpUrl: "https://private/image",
      text: "SECRET_COMMENT", likeCount: 1249, createdAt: "2026-09-27T00:01:01Z" },
    { id: "event-b", username: "private.two", displayName: null, pfpUrl: null, text: null, likeCount: null, createdAt: null }],
    total: 2, limit: 2, offset: 4, hasMore: true };
    const result = project(kind, payload);
    expect(shape(result)).toEqual(shape(payload));
    expect(result).toMatchObject({ total: 2, limit: 2, offset: 4, hasMore: true, trialPreview: true });
    expect(result.items.map((item: any) => item.id)).toEqual(["event-a", "event-b"]);
    expect(result.items[0]).toMatchObject({ displayName: "Instagram User", pfpUrl: PREVIEW_MEDIA_URL,
      likeCount: null, text: "Activate subscription to view this content." });
    expect(result.items[1]).toMatchObject({ displayName: null, pfpUrl: null, createdAt: null });
  });

  it("scrambles reports' nested metric labels, leaderboard media and historical growth without changing shape", () => {
    const payload = { items: [{ id: "report-a", igUsername: "tracked.account", type: "weekly", status: "ready",
      periodStart: "2026-09-20T00:00:00Z", periodEnd: "2026-09-27T00:00:00Z", totalLikes: 678,
      metrics: { summary: { netFollowerChange: 543, accountsFollowed: 987 },
        profile: { followerCountStart: 800, followerCountEnd: 900 },
        topHashtags: [{ label: "SECRET_TAG", count: 72 }], topInterests: [{ label: "SECRET_INTEREST", count: 20 }],
        topLikedAccounts: [{ label: "secret.account", count: 60 }],
        likesLeaderboard: [{ username: "secret.account", count: 60, thumbnails: ["https://private/one", "https://private/two"] }],
        followedAccounts: [{ username: "secret.follower", displayName: "Secret Follower", detectedAt: "2026-09-22T00:00:00Z" }],
        dailySeries: [{ date: "2026-09-21", followers: 873, following: 128 }] } }], limit: 20, offset: 0 };
    const result = project("reports", payload);
    expect(shape(result)).toEqual(shape(payload));
    expect(result.items[0]).toMatchObject({ id: "report-a", type: "weekly", status: "ready", trialPreview: true });
    expect(result.items[0].metrics.likesLeaderboard[0].thumbnails).toEqual([PREVIEW_MEDIA_URL, PREVIEW_MEDIA_URL]);
    expect(result.items[0].metrics.topLikedAccounts[0].label).toBe(result.items[0].metrics.likesLeaderboard[0].username);
    for (const marker of ["SECRET_", "secret.", "Secret Follower", "https://private", "2026-09-", "543", "987"]) {
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });

  it("redacts activity notifications but preserves billing/access notices and notification read IDs", () => {
    const operational = ["subscription_updated", "trial_ending", "payment_failed", "access_granted", "access_pending"]
      .map((type, index) => ({ id: `notice-${index}`, type, title: "Important account information", body: "Update card in billing",
        isRead: false, createdAt: "2026-09-27T00:00:00Z" }));
    const activity = { id: "activity-a", type: "new_like", title: "Real activity", body: "@secret.name liked real posts",
      isRead: false, dedupeKey: "like:account-a:REALSHORTCODE", createdAt: "2026-09-27T00:00:00Z" };
    const result = project("notifications", { items: [...operational, activity], limit: 50, offset: 0 });
    expect(result.items.slice(0, operational.length)).toEqual(operational);
    expect(result.items.at(-1)).toMatchObject({ id: "activity-a", type: "new_like", isRead: false,
      title: "Activity preview", body: "Activate subscription to view this content.", trialPreview: true });
    expect(JSON.stringify(result.items.at(-1))).not.toContain("secret.name");
    expect(result.items.at(-1).dedupeKey).not.toContain("REALSHORTCODE");
  });

  it("keeps realtime invalidation identity and kind while removing collected change counts", () => {
    const result = project("realtime", { kind: "following.changed", trackedAccountId: "account-a", igUsername: "tracked.account",
      count: 579, at: "2026-09-27T00:00:00Z", payload: { added: 432, removed: 147 } });
    expect(result).toMatchObject({ kind: "following.changed", trackedAccountId: "account-a", count: null,
      payload: { added: null, removed: null }, trialPreview: true });
    expect(Number.isFinite(Date.parse(result.at))).toBe(true);
  });

  it("synthetic timestamps and redacted responses remain deterministic without mutating inputs", () => {
    const input = { items: [{ username: "friend", firstSeenAt: new Date("2026-09-20"), pfpUrl: "https://real/avatar" }], nextCursor: null };
    const before = JSON.stringify(input);
    expect(project("roster", input)).toEqual(project("roster", input));
    expect(JSON.stringify(input)).toBe(before);
  });

  it("fails closed if stable pseudonymization cannot be keyed", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => project("viewer", realProfile)).toThrow("SESSION_SECRET");
  });
});

describe("confidential preview seek cursors", () => {
  it("round trips the exact seek position while hiding the username and timestamp", () => {
    const token = wrapPreviewCursor(cursor, scope)!;
    expect(token).toMatch(/^tp1\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("actual.last_follower");
    expect(Buffer.from(token.slice(4), "base64url").toString("utf8")).not.toContain("actual.last_follower");
    expect(unwrapPreviewCursor(token, scope)).toBe(cursor);
    expect(wrapPreviewCursor(cursor, scope)).not.toBe(token);
    expect(wrapPreviewCursor(null, scope)).toBeNull();
  });

  it("sanitizes a roster response without discarding its next-page position", () => {
    const payload = { items: [{ username: "actual.last_follower", firstSeenAt: cursor.split("|")[0] }], nextCursor: cursor,
      total: 71, loadedTotal: 71, expectedTotal: 71, syncState: "complete" };
    const result = project("roster", payload);
    expect(shape(result)).toEqual(shape(payload));
    expect(result.total).toBe(71);
    expect(unwrapPreviewCursor(result.nextCursor, scope)).toBe(cursor);
    expect(JSON.stringify(result)).not.toContain("actual.last_follower");
  });

  it.each([
    { userId: "customer-b" }, { trackedAccountId: "account-b" }, { dimension: "following" as const },
  ])("rejects replay under another user, tracked account or roster dimension: %j", change => {
    expect(() => unwrapPreviewCursor(wrapPreviewCursor(cursor, scope)!, { ...scope, ...change })).toThrow("Invalid preview cursor");
  });

  it("rejects modified ciphertext, unencrypted legacy cursors, oversized tokens and missing scope", () => {
    const token = wrapPreviewCursor(cursor, scope)!;
    const bytes = Buffer.from(token.slice(4), "base64url");
    bytes[bytes.length - 1] ^= 1;
    for (const bad of [cursor, `tp1.${bytes.toString("base64url")}`, "tp1.bad", `${token}=`, `${token}\n`, "tp1." + "a".repeat(6000)]) {
      expect(() => unwrapPreviewCursor(bad, scope)).toThrow("Invalid preview cursor");
    }
    expect(() => sanitizeTrialPreview("roster", { nextCursor: cursor }, "customer-a")).toThrow("requires an account and dimension");
  });

  it("invalidates old cursor tokens when the server session secret rotates", () => {
    const token = wrapPreviewCursor(cursor, scope)!;
    vi.stubEnv("SESSION_SECRET", "new-isolated-preview-secret");
    expect(() => unwrapPreviewCursor(token, scope)).toThrow("Invalid preview cursor");
  });
});
