// Actual viewer route and preview middleware over HTTP, with collection/DB
// boundaries using synthetic fixtures. No application queues or providers start.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import vm from "node:vm";
import express from "express";
import { transformSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTrialPreviewMiddleware } from "../services/trial-preview-http.js";
import { isTrialPreview, PREVIEW_MEDIA_URL } from "../services/trial-preview.js";

const source = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");
const start = source.indexOf('  app.get("/api/viewer/:username"');
const end = source.indexOf("  // STRIPE WEBHOOK", start);
if (start < 0 || end <= start) throw Error("Production viewer extraction boundary missing");
const code = transformSync(source.slice(start, end), { loader: "ts", format: "cjs" }).code;
const when = new Date("2026-09-24T13:42:00.000Z");
const boundary = new Date("2026-09-02T00:00:00.000Z");
const avatar = "https://cdninstagram.com/tracked-avatar.jpg";

function sourceRows(): unknown[][] {
  return [
    [{ id: "account_fixture", userId: "viewer_fixture", igUsername: "tracked_account", displayName: "Tracked Account", profilePicUrl: avatar,
      biography: "private context fixture", externalUrl: "https://fixture.invalid/profile-context", isVerified: true, isPrivate: false, isActive: true,
      followerCount: 923, trackingStarted: new Date("2026-09-01T00:00:00Z"), followingFirstCompleteAt: boundary,
      lastFollowersRefreshAt: when, lastFollowingRefreshAt: when }],
    [{ id: "like_fixture", postId: "real-liked-post", ownerUsername: "real_liked_owner", postType: "photo",
      thumbnailUrl: "https://cdninstagram.com/liked-private.jpg", postUrl: "https://instagram.com/p/real-liked-post/",
      hashtags: ["sensitive_interest"], likesCount: 641, commentsCount: 17, videoViewCount: 132,
      postTakenAt: when, detectedAt: when }],
    [{ followedUsername: "real_followed_account", followedDisplayName: "Real Followed Name", detectedAt: when }],
    [{ fullName: "Tracked Account", profilePicUrl: avatar, profilePicUrlHd: "https://cdninstagram.com/tracked-hd.jpg",
      biography: "private context fixture", externalUrl: "https://fixture.invalid/profile-context", isVerified: true, isPrivate: false,
      followerCount: 923, followingCount: 47, postCount: 13, snapshotAt: when }],
    [{ value: 1 }], [{ value: 1 }], [{ value: 1 }],
    [{ shortcode: "real-private-shortcode", postType: "carousel", thumbnailUrl: "https://cdninstagram.com/post-thumbnail.jpg",
      displayUrl: "https://cdninstagram.com/post-display.jpg", videoUrl: "https://cdninstagram.com/post-video.mp4",
      caption: "A sensitive post caption", likeCount: 874, commentCount: 53, videoViewCount: 1264,
      takenAt: when, hashtags: ["private_hashtag"], isPinned: false,
      carouselMedia: [{ mediaType: "video", displayUrl: "https://cdninstagram.com/child-display.jpg", videoUrl: "https://cdninstagram.com/child-video.mp4" }] }],
    [{ type: "carousel", total: 1, cachedAt: when, publishedThisWeek: 1 }],
    [{ storyId: "real_story", mediaType: "video", mediaUrl: "https://cdninstagram.com/story.mp4", thumbnailUrl: "https://cdninstagram.com/story.jpg",
      takenAt: when, expiresAt: new Date("2026-09-27T13:42:00Z"), cachedAt: when }],
    [{ id: "highlight_cache", highlightId: "real_highlight", title: "Sensitive highlight title", coverUrl: "https://cdninstagram.com/highlight.jpg", mediaCount: 1, cachedAt: when }],
    [{ followerUsername: "real_follower_one", followerDisplayName: "Real Follower One", followerPfpUrl: "https://cdninstagram.com/follower-one.jpg", detectedAt: when },
      { followerUsername: "real_follower_two", followerDisplayName: "Real Follower Two", followerPfpUrl: "https://cdninstagram.com/follower-two.jpg", detectedAt: when }],
    [{ unfollowerUsername: "real_departed_follower", unfollowerDisplayName: "Real Departed Follower", unfollowerPfpUrl: "https://cdninstagram.com/departed-follower.jpg", detectedAt: when }],
    [{ unfollowedUsername: "real_unfollowed_account", unfollowedDisplayName: "Real Unfollowed Name", unfollowedPfpUrl: "https://cdninstagram.com/unfollowed.jpg", detectedAt: when }],
    [{ usernameLower: "real_followed_account", displayName: "Real Followed Name", pfpUrl: "https://cdninstagram.com/followed.jpg" }],
    [{ highlightCacheId: "highlight_cache", storyId: "real_highlight_story", mediaType: "video", mediaUrl: "https://cdninstagram.com/highlight-video.mp4",
      thumbnailUrl: "https://cdninstagram.com/highlight-thumbnail.jpg", takenAt: when }],
  ];
}

describe("production viewer with trial preview middleware", () => {
  let server: Server, base: string, pendingRows: unknown[][], previewStatus = "trialing";
  const select = vi.fn();
  beforeAll(async () => {
    vi.stubEnv("SESSION_SECRET", "isolated-viewer-preview-fixture-secret");
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: "viewer_fixture", role: "user" } as Express.User;
      next();
    });
    app.use(createTrialPreviewMiddleware({
      isPreview: async () => isTrialPreview({ status: previewStatus }), isAvatar: async () => false,
      sendPlaceholder: res => { res.type("image/png").end(); },
    }));
    select.mockImplementation(() => {
      const rows = pendingRows.shift();
      if (!rows) throw Error("Unexpected production viewer database query");
      const chain: any = {
        from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain, groupBy: () => chain,
        then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    });
    const table = new Proxy({}, { get: (_target, field) => String(field) });
    const ctx = {
      app, Date, db: { select },
      isAuthenticated: (_req: unknown, _res: unknown, next: () => void) => next(),
      firstParam: (value: unknown) => String(value), validateTimezone: () => "UTC", parsePostTypeFilter: () => "all",
      privateContentUnavailable: () => false, maybeRevalidateTier1: vi.fn(),
      trackedAccounts: table, likeEvents: table, followEvents: table, profileSnapshots: table, rosterMembers: table,
      postsCache: table, storiesCache: table, highlightsCache: table, followerEvents: table, followerUnfollowEvents: table, highlightItemsCache: table,
      eq: () => true, and: () => true, inArray: () => true, gt: () => true, gte: () => true, asc: () => true, desc: () => true,
      sql: () => true, count: () => true, likedPostAfterTrackingStart: () => true,
      visibleFollowEventsSql: () => true, visibleRosterDeparturesSql: () => true, visibleFollowerUnfollowsSql: () => true,
      canonicalTwinId: async (id: string) => id, twinTrackedAccountIds: async (id: string) => [id],
      getRosterSyncHealth: async () => ({ settled: true, settledAt: boundary, failureKind: null, lastAttemptAt: when,
        lastSuccessAt: when, lastCompleteReadAt: when, nextRetryAt: null }),
      followActivityBoundary: () => boundary,
      getFollowersRosterStats: async () => ({ total: 923, lastUpdatedAt: when }),
      getFollowingRosterStats: async () => ({ total: 47, lastUpdatedAt: when }),
      readBackgroundRosterView: async () => null, backgroundRosterSyncState: (_value: unknown, fallback: string) => fallback,
      computeRosterSyncState: () => "complete", isUnfollowRosterTrusted: () => true,
      readPostsCollectionState: async () => ({ state: "available", savedTotal: 1, recordedProfileCount: 13, recordedProfileAt: when.toISOString(),
        lastPostsReadAt: when.toISOString(), lastAttemptAt: when.toISOString(), nextRetryAt: null, trackingActive: true, source: "account" }),
      dedupeLikedPostsByPostId: (rows: unknown[]) => rows, pinnedFirstPosts: (rows: unknown[]) => rows,
      resolveCachedMediaUrls: async () => new Map(), enqueueMediaCacheUrls: async () => {}, logger: { warn: vi.fn() },
    };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(process.env.STRESS_FAULT_PORT ?? 0), "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  async function viewer(status: string) {
    previewStatus = status; pendingRows = sourceRows();
    const response = await fetch(`${base}/api/viewer/tracked_account?tz=UTC`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(pendingRows).toEqual([]); // Full handler, including nested highlight mapping, executed.
    return { body, response };
  }

  it("serves synthetic tool data and the real permitted profile summary to trialing users", async () => {
    const { body, response } = await viewer("trialing");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({ trialPreview: true, igUsername: "tracked_account", displayName: "Tracked Account", profilePicUrl: avatar,
      isVerified: true, isPrivate: false, followerCount: 923, followingCount: 47, postCount: 13, biography: null, externalUrl: null });
    expect(body.recentFollowers).toHaveLength(2);
    expect(body.recentFollowers[0]).toMatchObject({ followerUsername: expect.stringMatching(/^user_[a-f0-9]+$/), followerDisplayName: "Instagram User", followerPfpUrl: PREVIEW_MEDIA_URL });
    expect(body.recentFollows[0].followedUsername).toMatch(/^user_[a-f0-9]+$/);
    expect(body.recentLikes[0]).toMatchObject({ ownerUsername: expect.stringMatching(/^user_[a-f0-9]+$/), postUrl: null, likesCount: null, commentsCount: null });
    expect(body.recentPosts[0]).toMatchObject({ trialPreview: true, shortcode: expect.stringMatching(/^preview_/),
      likeCount: null, commentCount: null, videoViewCount: null, thumbnailUrl: PREVIEW_MEDIA_URL, displayUrl: PREVIEW_MEDIA_URL, videoUrl: PREVIEW_MEDIA_URL });
    expect(body.recentPosts[0].carouselMedia[0]).toMatchObject({ trialPreview: true, displayUrl: PREVIEW_MEDIA_URL, videoUrl: PREVIEW_MEDIA_URL });
    expect(body.stories[0]).toMatchObject({ trialPreview: true, mediaType: "video", mediaUrl: PREVIEW_MEDIA_URL });
    expect(body.highlights[0].items[0]).toMatchObject({ trialPreview: true, mediaUrl: PREVIEW_MEDIA_URL });
    expect(body.weeklyStats).toEqual({ totalLikes: null, totalFollows: null, totalUnfollows: null, totalPosts: null });
    expect(body.activityByHour).toHaveLength(24); expect(body.activityByHour.every((hour: any) => hour.count === null)).toBe(true);
    const encoded = JSON.stringify(body);
    for (const secret of ["real_follower_one", "real_followed_account", "real_liked_owner", "real-private-shortcode", "Sensitive highlight title", "private context fixture", "sensitive_interest", "A sensitive post caption"]) {
      expect(encoded).not.toContain(secret);
    }
    expect(body.recentFollowers[0].detectedAt).not.toBe(when.toISOString());
  });

  it("keeps real tool data unchanged for active users", async () => {
    const { body } = await viewer("active");
    expect(body).not.toHaveProperty("trialPreview");
    expect(body.biography).toBe("private context fixture");
    expect(body.recentFollowers[0]).toEqual({ followerUsername: "real_follower_one", followerDisplayName: "Real Follower One",
      followerPfpUrl: "https://cdninstagram.com/follower-one.jpg", detectedAt: when.toISOString() });
    expect(body.recentPosts[0]).toMatchObject({ shortcode: "real-private-shortcode", caption: "A sensitive post caption", likeCount: 874, commentCount: 53, videoViewCount: 1264 });
    expect(body.recentLikes[0].ownerUsername).toBe("real_liked_owner");
    expect(body.weeklyStats).toEqual({ totalLikes: 1, totalFollows: 1, totalUnfollows: 1, totalPosts: 1 });
    expect(body.highlights[0].items[0].mediaUrl).toBe("https://cdninstagram.com/highlight-video.mp4");
  });

  it("preserves every production response key and array length apart from additive preview flags", async () => {
    const real = (await viewer("active")).body, preview = (await viewer("trialing")).body;
    function compare(realValue: any, previewValue: any, path = "viewer") {
      if (Array.isArray(realValue)) {
        expect(Array.isArray(previewValue), path).toBe(true);
        expect(previewValue.length, path).toBe(realValue.length);
        realValue.forEach((value, index) => compare(value, previewValue[index], `${path}[${index}]`));
      } else if (realValue && typeof realValue === "object") {
        expect(Object.keys(previewValue).filter(key => key !== "trialPreview").sort(), path).toEqual(Object.keys(realValue).sort());
        for (const key of Object.keys(realValue)) compare(realValue[key], previewValue[key], `${path}.${key}`);
      }
    }
    compare(real, preview);
    const repeat = (await viewer("trialing")).body;
    expect(repeat.recentFollowers.map((row: any) => row.followerUsername)).toEqual(preview.recentFollowers.map((row: any) => row.followerUsername));
    expect(repeat.recentPosts[0].shortcode).toBe(preview.recentPosts[0].shortcode);
  });
});
