vi.mock("../subscription-access.js", () => ({ trackedAccountHasAccess: vi.fn(async () => true) }));
const revokeAcceptedBotAccess = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../bot-manager.js", () => ({ revokeAcceptedBotAccess }));
vi.mock("../private-account-access.js", () => {
  const primary = vi.fn(async (_id: string): Promise<string | null> => null);
  return { privateBotHasAccess: vi.fn(async () => true), findGrantedBotId: primary, findGrantedBotIds: vi.fn(async (id: string) => {
    const bot = await primary(id); return bot ? [bot] : [];
  }) };
});
// Unit tests for collectPublicData orchestration in public-data-collector.ts
// (audit fixes B2-propagation / B9 / A3 / A6).
//
// Coverage:
//   - B2: a TRUNCATED roster capture that would pass the downstream 0.90
//     ratio gate → persist*Diff is NOT called (no false mass-unfollows);
//     a truncated capture under the ratio still persists the additive side.
//   - B9: last_graph_refresh_at advances only when every enumerated capture
//     was COMPLETE.
//   - A3: profile rate-limited + browser leg dead (pool empty) → the cached
//     continuation fires (evaluated BEFORE the pool-empty abort).
//   - A6: after N consecutive cached cycles the collector stops serving
//     cache and fails the cycle so BullMQ retries surface.
//
// Everything below the collector (service, persistence, db, realtime) is
// mocked; shouldComputeUnfollowDiff / shouldEnumerateRoster stay REAL so the
// gating fidelity matches production.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { trackedAccountHasAccess } from "../subscription-access.js";
import { findGrantedBotId, findGrantedBotIds, privateBotHasAccess } from "../private-account-access.js";
import { enqueueMediaCacheUrls } from "../media-cache-jobs.js";
import { collectionCompletion, partialCollectionNeedsRetry } from "../collection-completion.js";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ── db mock — records update payloads (profile apply + valve anchor) ────────

const dbState = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<unknown>,
  // Live roster total returned by getRosterLiveTotal's aggregate COUNT. Tests
  // that exercise the diff-aware gate's completeness path set this so a roster
  // can read as "complete" (>= 0.9 * count). Defaults to 0 (legacy behavior).
  rosterTotal: 0,
}));

vi.mock("../../db.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbState.updates.push(values);
          return [];
        },
      }),
    }),
    insert: () => ({
      values: async (values: unknown) => {
        dbState.inserts.push(values);
        return [];
      },
    }),
    select: () => {
      throw new Error("unexpected db.select in collector test");
    },
    execute: async () => ({ rows: [{ total: dbState.rosterTotal }] }),
  },
}));

vi.mock("../../../shared/schema.js", () => ({
  botFollowRequests: {},
  postEngagementChecks: { mediaId: "media_id", kind: "kind" },
  profileSnapshots: {},
  trackedAccounts: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ args }),
  desc: (c: unknown) => c,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  gte: (a: unknown, b: unknown) => ({ a, b }),
  inArray: (a: unknown, b: unknown) => ({ a, b }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    strings,
    vals,
  }),
}));

// ── Service / persistence / side-effect mocks ───────────────────────────────

vi.mock("../public-data-service.js", () => ({
  parseEnvInt: (_name: string, fallback: number) => fallback,
  getPublicProfile: vi.fn(),
  getPublicProfileAsBot: vi.fn(),
  getUserPosts: vi.fn(),
  getUserStories: vi.fn(),
  getUserHighlights: vi.fn(),
  getAllUserFollowers: vi.fn(),
  getAllUserFollowing: vi.fn(),
  getPostComments: vi.fn(),
  getPostLikers: vi.fn(),
  getUserPostsAsBot: vi.fn(),
  getUserStoriesAsBot: vi.fn(),
  getUserHighlightsAsBot: vi.fn(),
  getAllUserFollowersAsBot: vi.fn(),
  getAllUserFollowingAsBot: vi.fn(),
  getPostCommentsAsBot: vi.fn(),
  getPostLikersAsBot: vi.fn(),
}));

vi.mock("../public-data-persistence.js", () => ({
  persistComments: vi.fn(async () => ({ inserted: 0 })),
  persistFollowerDiff: vi.fn(async () => ({
    completeRead: true,
    newFollowers: 0,
    newFollowerUnfollows: 0,
  })),
  persistFollowingDiff: vi.fn(async () => ({
    completeRead: true,
    newFollows: 0,
    newUnfollows: 0,
  })),
  persistHighlights: vi.fn(async () => 0),
  persistLikers: vi.fn(async () => ({ inserted: 0 })),
  persistPosts: vi.fn(async () => 0),
  persistStories: vi.fn(async () => 0),
  loadSavedHighlightMediaCounts: vi.fn(async () => new Map()),
}));

const fetchPublicProfileTier1 = vi.hoisted(() => vi.fn());
vi.mock("../public-read-client.js", () => ({
  fetchPublicProfileTier1,
}));

vi.mock("../apify-graph-fallback.js", () => ({
  resolveApifyGraphLimit: (requested: number) => Math.min(requested, 2_000),
}));

vi.mock("../roster-store.js", () => ({
  getRosterSyncHealth: vi.fn(async () => ({
    settled: true,
    settledAt: new Date(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    failureKind: null,
    nextRetryAt: null,
  })),
  recordExternalRosterSuccessCooldown: vi.fn(async () => undefined),
  recordRosterFetchFailure: vi.fn(async () => undefined),
  // Migration 0039: resumable roster pagination. The collector loads a saved
  // cursor before each walk and persists where it stopped afterwards.
  loadRosterCursor: vi.fn(async () => null),
  loadRosterViewer: vi.fn(async () => null),
  markRosterTooLarge: vi.fn(async () => undefined),
  saveRosterCursor: vi.fn(async () => undefined),
}));

vi.mock("../media-cache-jobs.js", () => ({
  enqueueMediaCacheUrls: vi.fn(async () => 0),
}));

vi.mock("../roster-background-sync.js", () => ({
  reconcileBackgroundRosters: vi.fn(async () => undefined),
  readBackgroundRosterProgress: vi.fn(async () => null),
}));

vi.mock("../realtime-events.js", () => ({
  emitRealtime: vi.fn(),
}));

vi.mock("../bandwidth-meter.js", () => ({
  withScrapeContext: vi.fn(
    async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

// Keep the REAL gating logic (shouldComputeUnfollowDiff /
// shouldEnumerateRoster); mock only the DB-backed baseline readers.
vi.mock("../diff-completeness.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../diff-completeness.js")>();
  return {
    ...actual,
    fetchLastSnapshotCounts: vi.fn(async () => null),
    fetchExpectedCount: vi.fn(async () => null),
  };
});

import {
  collectPublicData,
  isFreshEngagementPost,
  resetCachedContinuationStreaksForTests,
  shouldScrapeEngagement,
} from "../public-data-collector.js";
import {
  getPublicProfile,
  getPublicProfileAsBot,
  getUserPosts,
  getUserStories,
  getUserHighlights,
  getAllUserFollowers,
  getAllUserFollowing,
  getUserPostsAsBot,
  getUserStoriesAsBot,
  getUserHighlightsAsBot,
  getAllUserFollowersAsBot,
  getAllUserFollowingAsBot,
} from "../public-data-service.js";
import {
  persistFollowerDiff,
  persistFollowingDiff,
  persistPosts,
  persistStories,
} from "../public-data-persistence.js";
import {
  fetchExpectedCount,
  fetchLastSnapshotCounts,
} from "../diff-completeness.js";
import { getRosterSyncHealth, loadRosterCursor, loadRosterViewer, markRosterTooLarge, recordRosterFetchFailure } from "../roster-store.js";
import { readBackgroundRosterProgress, reconcileBackgroundRosters } from "../roster-background-sync.js";
import { setBackgroundRosterWorkerReady } from "../roster-background-policy.js";
import type { TrackedAccount } from "../../../shared/schema.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function buildAccount(
  overrides: Record<string, unknown> = {},
): TrackedAccount {
  return {
    id: "acct-1",
    userId: "user-1",
    igUsername: "target",
    igUserId: "igu-1",
    displayName: "Target",
    profilePicUrl: "https://pic",
    biography: "bio",
    externalUrl: null,
    isVerified: false,
    isBusinessAccount: false,
    isPrivate: false,
    accessStatus: "public",
    followerCount: 1000,
    lastGraphRefreshAt: null,
    ...overrides,
  } as unknown as TrackedAccount;
}

const LIVE_PROFILE = {
  igUserId: "igu-1",
  username: "target",
  fullName: "Target",
  biography: "bio",
  profilePicUrl: "https://pic",
  profilePicUrlHd: "https://pic",
  isPrivate: false,
  isVerified: false,
  isBusinessAccount: false,
  externalUrl: null,
  followerCount: 1000,
  followingCount: 50,
  postCount: 10,
};

interface FollowUser {
  igUserId: string;
  username: string;
  fullName: string;
  profilePicUrl: string;
  isPrivate: boolean;
  isVerified: boolean;
}

function buildUsers(count: number, prefix: string): ReadonlyArray<FollowUser> {
  return Array.from({ length: count }, (_, i) => ({
    igUserId: `${prefix}-${i}`,
    username: `${prefix}_${i}`,
    fullName: `User ${i}`,
    profilePicUrl: "",
    isPrivate: false,
    isVerified: false,
  }));
}

function completeCapture(users: ReadonlyArray<FollowUser>) {
  return {
    ok: true as const,
    data: users,
    source: "bot" as const,
    complete: true,
    stopReason: "exhausted" as const,
  };
}

function truncatedCapture(
  users: ReadonlyArray<FollowUser>,
  stopReason: "page_error" | "page_cap" | "item_cap",
) {
  return {
    ok: true as const,
    data: users,
    source: "bot" as const,
    complete: false,
    stopReason,
  };
}

const PIECE_DISABLED = {
  ok: false as const,
  source: "none" as const,
  error: "disabled in test",
};

const RATE_LIMITED_FAILURE = {
  ok: false as const,
  source: "bot" as const,
  rateLimited: true,
  error:
    "rate limited on HTTP transport (rate limited (429)); browser fallback failed: no available bot in the pool",
};

function anchorUpdates(): Array<Record<string, unknown>> {
  return dbState.updates.filter((u) => "lastGraphRefreshAt" in u);
}

beforeEach(() => {
  vi.clearAllMocks();
  setBackgroundRosterWorkerReady(false);
  vi.mocked(readBackgroundRosterProgress).mockReset().mockResolvedValue(null);
  vi.stubEnv("APIFY_GRAPH_PROVIDER_OUTAGE_FALLBACK_ENABLED", "false");
  dbState.updates.length = 0;
  dbState.inserts.length = 0;
  dbState.rosterTotal = 0;
  resetCachedContinuationStreaksForTests();
  vi.mocked(findGrantedBotId).mockResolvedValue(null);
  vi.mocked(privateBotHasAccess).mockReset().mockResolvedValue(true);
  vi.mocked(findGrantedBotIds).mockImplementation(async id => {
    const bot = await findGrantedBotId(id); return bot ? [bot] : [];
  });
  vi.mocked(getPublicProfileAsBot).mockResolvedValue({ ok: true, data: { ...LIVE_PROFILE, isPrivate: true }, source: "bot" });
  vi.mocked(getUserPostsAsBot).mockResolvedValue(PIECE_DISABLED);
  vi.mocked(getUserStoriesAsBot).mockResolvedValue(PIECE_DISABLED);
  vi.mocked(getUserHighlightsAsBot).mockResolvedValue(PIECE_DISABLED);
  vi.mocked(getAllUserFollowersAsBot).mockResolvedValue(completeCapture([]));
  vi.mocked(getAllUserFollowingAsBot).mockResolvedValue(completeCapture([]));
  vi.mocked(loadRosterCursor).mockReset().mockResolvedValue(null);
  vi.mocked(loadRosterViewer).mockReset().mockResolvedValue(null);
  vi.mocked(getRosterSyncHealth).mockImplementation(async () => ({
    settled: true, settledAt: new Date(), lastAttemptAt: null,
    lastSuccessAt: null, lastCompleteReadAt: new Date(),
    failureKind: null, lastError: null, nextRetryAt: null,
  }));

  vi.mocked(getPublicProfile).mockResolvedValue({
    ok: true,
    data: LIVE_PROFILE,
    source: "bot",
  });
  vi.mocked(getUserPosts).mockResolvedValue(PIECE_DISABLED);
  vi.mocked(getUserStories).mockResolvedValue(PIECE_DISABLED);
  vi.mocked(getUserHighlights).mockResolvedValue(PIECE_DISABLED);
  vi.mocked(getAllUserFollowers).mockResolvedValue(completeCapture([]));
  vi.mocked(getAllUserFollowing).mockResolvedValue(completeCapture([]));
  vi.mocked(fetchLastSnapshotCounts).mockResolvedValue(null);
  vi.mocked(fetchExpectedCount).mockResolvedValue(null);
  fetchPublicProfileTier1.mockResolvedValue({
    ok: false,
    reason: "no_proxy",
  });
});

describe("public posts collection evidence", () => {
  it.each(["live", "cached"] as const)("rejects an empty feed against a positive %s profile without persisting or advancing content freshness", async profileSource => {
    if (profileSource === "cached") {
      vi.mocked(getPublicProfile).mockResolvedValue(RATE_LIMITED_FAILURE);
      vi.mocked(fetchLastSnapshotCounts).mockResolvedValue({
        postCount: 10, followerCount: 1000, followingCount: 50, snapshotAt: new Date(),
      });
    }
    vi.mocked(getUserPosts).mockResolvedValue({ ok: true, source: "bot", data: [] });
    const outcome = await collectPublicData(buildAccount());
    expect(outcome.profile.ok).toBe(true);
    expect(outcome.posts).toEqual({ count: 0, source: "bot",
      error: "empty public feed despite a nonzero profile post count; retained saved posts" });
    // No cache writer runs, so existing posts and their successful-read clock
    // remain untouched while unrelated profile/roster progress is retained.
    expect(persistPosts).not.toHaveBeenCalled();
    expect(dbState.updates.some(update => "lastContentRefreshAt" in update)).toBe(false);
    const completion = collectionCompletion(outcome);
    expect(completion.status).toBe("failed");
    expect(completion.error).toContain("partial collection: posts: empty public feed");
    const now = Date.now();
    expect(partialCollectionNeedsRetry({ ...completion, completedAt: new Date(now) }, now)).toBe(false);
    expect(partialCollectionNeedsRetry({ ...completion, completedAt: new Date(now - 15 * 60_000) }, now)).toBe(true);
  });

  it("accepts a successful empty feed when the profile reports zero posts", async () => {
    vi.mocked(getPublicProfile).mockResolvedValue({ ok: true, source: "bot",
      data: { ...LIVE_PROFILE, postCount: 0, followerCount: 1, followingCount: 1 } });
    vi.mocked(getUserPosts).mockResolvedValue({ ok: true, source: "bot", data: [] });
    vi.mocked(getUserStories).mockResolvedValue({ ok: true, source: "bot", data: [] });
    vi.mocked(getUserHighlights).mockResolvedValue({ ok: true, source: "bot", data: [] });
    vi.mocked(getAllUserFollowers).mockResolvedValue(completeCapture(buildUsers(1, "f")));
    vi.mocked(getAllUserFollowing).mockResolvedValue(completeCapture(buildUsers(1, "g")));
    const outcome = await collectPublicData(buildAccount());
    expect(outcome.posts).toEqual({ count: 0, source: "bot" });
    expect(persistPosts).toHaveBeenCalledExactlyOnceWith("acct-1", [], { pinnedAuthoritative: true });
    expect(collectionCompletion(outcome)).toEqual({ status: "completed", error: null });
  });

  it("persists a nonempty recent window even when the profile has more posts", async () => {
    const post = { shortcode: "saved-post", mediaId: "123_456", postType: "photo" as const,
      thumbnailUrl: "https://scontent.cdninstagram.com/post.jpg", displayUrl: "https://scontent.cdninstagram.com/post.jpg",
      videoUrl: null, caption: "", likeCount: 0, commentCount: 0, videoViewCount: null,
      takenAt: new Date(), locationName: null, hashtags: [], isPinned: false, carouselMedia: null };
    vi.mocked(getUserPosts).mockResolvedValue({ ok: true, source: "bot", data: [post] });
    const outcome = await collectPublicData(buildAccount());
    expect(outcome.posts.error).toBeUndefined();
    expect(persistPosts).toHaveBeenCalledExactlyOnceWith("acct-1", [post], { pinnedAuthoritative: true });
  });
});

describe("accepted private collection", () => {
  const privateAccount = () => buildAccount({ isPrivate: true, accessStatus: "has_access" });
  const expectNoPublicReads = () => {
    for (const fn of [getPublicProfile, getUserPosts, getUserStories, getUserHighlights, getAllUserFollowers, getAllUserFollowing, fetchPublicProfileTier1]) {
      expect(fn).not.toHaveBeenCalled();
    }
  };

  it("records unavailable empty rosters as partial failure when the profile is nonempty", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    vi.mocked(fetchExpectedCount).mockResolvedValue(126);
    const outcome = await collectPublicData(privateAccount());
    expect(outcome.followers.error).toContain("empty roster despite a nonzero profile count");
    expect(outcome.following.error).toContain("empty roster despite a nonzero profile count");
    expect(persistFollowerDiff).not.toHaveBeenCalled();
    expect(persistFollowingDiff).not.toHaveBeenCalled();
    expect(recordRosterFetchFailure).toHaveBeenCalledTimes(2);
  });

  it("does not mark an empty private feed successful when the profile still reports posts", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    vi.mocked(getUserPostsAsBot).mockResolvedValue({ ok: true, data: [], source: "bot" });
    const outcome = await collectPublicData(privateAccount());
    expect(outcome.posts.error).toContain("empty private feed despite a nonzero profile post count");
    expect(persistPosts).not.toHaveBeenCalled();
  });

  it("accepts an explicitly empty private feed when its profile reports zero posts", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    vi.mocked(getPublicProfileAsBot).mockResolvedValue({ ok: true, data: { ...LIVE_PROFILE, isPrivate: true, postCount: 0 }, source: "bot" });
    vi.mocked(getUserPostsAsBot).mockResolvedValue({ ok: true, data: [], source: "bot" });
    const outcome = await collectPublicData(privateAccount());
    expect(outcome.posts.error).toBeUndefined();
    expect(persistPosts).toHaveBeenCalledOnce();
  });

  it("accepts a genuinely empty profile roster and the empty final page of a resumed walk", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    vi.mocked(fetchExpectedCount).mockImplementation(async (_id, kind) => kind === "following" ? 0 : 126);
    vi.mocked(loadRosterCursor).mockImplementation(async (_id, kind) => kind === "follower" ? "last-page" : null);
    const outcome = await collectPublicData(privateAccount());
    expect(outcome.followers.error).toBeUndefined();
    expect(outcome.following.error).toBeUndefined();
    expect(persistFollowerDiff).toHaveBeenCalledOnce();
    expect(persistFollowingDiff).toHaveBeenCalledOnce();
    expect(recordRosterFetchFailure).not.toHaveBeenCalled();
  });

  it("stops a collection before its next provider read when access ends during a request", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    vi.mocked(getUserStoriesAsBot).mockImplementation(async () => {
      vi.mocked(privateBotHasAccess).mockResolvedValue(false);
      return { ok: true, data: [], source: "bot" };
    });
    await expect(collectPublicData(privateAccount())).rejects.toThrow("Private collection access ended");
    expect(getUserStoriesAsBot).toHaveBeenCalledTimes(1);
    expect(getUserPostsAsBot).not.toHaveBeenCalled();
    expect(getAllUserFollowersAsBot).not.toHaveBeenCalled();
    expect(persistStories).not.toHaveBeenCalled();
    expect(enqueueMediaCacheUrls).not.toHaveBeenCalled();
    expectNoPublicReads();
  });

  it("revalidates the approval between pages of a long private roster walk", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    vi.mocked(getAllUserFollowersAsBot).mockImplementationOnce(async (_id, _bot, options) => {
      await options!.beforePage!();
      vi.mocked(privateBotHasAccess).mockResolvedValue(false);
      await options!.beforePage!();
      return completeCapture([]);
    });
    await expect(collectPublicData(privateAccount())).rejects.toThrow("Private collection access ended");
    expect(getAllUserFollowingAsBot).not.toHaveBeenCalled();
    expect(persistFollowerDiff).not.toHaveBeenCalled();
  });

  it("pins the profile, content and both rosters to the approved viewer", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    const account = privateAccount();
    const outcome = await collectPublicData(account);
    expect(outcome.profile).toEqual({ ok: true, source: "bot" });
    expect(outcome.isPrivate).toBe(true);
    expect(findGrantedBotId).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(getPublicProfileAsBot).toHaveBeenCalledExactlyOnceWith(account.igUsername, account.igUserId, "approved-bot");
    expect(getUserPostsAsBot).toHaveBeenCalledWith(account.igUsername, account.igUserId, "approved-bot", expect.any(Number));
    expect(getUserStoriesAsBot).toHaveBeenCalledWith(account.igUsername, account.igUserId, "approved-bot");
    expect(getUserHighlightsAsBot).toHaveBeenCalledWith(account.igUsername, account.igUserId, "approved-bot", false);
    expect(getAllUserFollowersAsBot).toHaveBeenCalledWith(account.igUserId, "approved-bot", expect.any(Object));
    expect(getAllUserFollowingAsBot).toHaveBeenCalledWith(account.igUserId, "approved-bot", expect.any(Object));
    expectNoPublicReads();
  });

  it("stops before any provider traffic when no usable approved viewer exists", async () => {
    const outcome = await collectPublicData(privateAccount());
    expect(outcome.profile.ok).toBe(false);
    expect(getPublicProfileAsBot).not.toHaveBeenCalled();
    expect(getUserPostsAsBot).not.toHaveBeenCalled();
    expectNoPublicReads();
  });

  it('continues through only the approved backup when the primary session expires', async () => {
    vi.mocked(findGrantedBotIds).mockResolvedValue(['primary', 'backup']);
    vi.mocked(getPublicProfileAsBot).mockResolvedValueOnce({ok:false,source:'bot',error:'saved session unavailable'});
    const account=privateAccount(); const outcome=await collectPublicData(account);
    expect(outcome.profile.ok).toBe(true);
    expect(getPublicProfileAsBot).toHaveBeenNthCalledWith(1,account.igUsername,account.igUserId,'primary');
    expect(getPublicProfileAsBot).toHaveBeenNthCalledWith(2,account.igUsername,account.igUserId,'backup');
    expect(getUserPostsAsBot).toHaveBeenCalledWith(account.igUsername,account.igUserId,'backup',expect.any(Number));
    expectNoPublicReads();
  });

  it("revokes an explicitly removed relationship and continues only through its approved backup", async () => {
    vi.mocked(findGrantedBotIds).mockResolvedValue(["primary", "backup"]);
    vi.mocked(getPublicProfileAsBot).mockResolvedValueOnce({ ok: true, source: "bot", data: {
      ...LIVE_PROFILE, isPrivate: true, followedByViewer: false, viewerRelationshipKnown: true,
    } });
    const account = privateAccount();
    expect((await collectPublicData(account)).profile.ok).toBe(true);
    expect(revokeAcceptedBotAccess).toHaveBeenCalledExactlyOnceWith(account.id, "primary");
    expect(getUserPostsAsBot).toHaveBeenCalledExactlyOnceWith(account.igUsername, account.igUserId, "backup", expect.any(Number));
    expectNoPublicReads();
  });

  it("does not serve private content or claim completion after every approval was removed", async () => {
    vi.mocked(findGrantedBotIds).mockResolvedValue(["primary", "backup"]);
    vi.mocked(getPublicProfileAsBot).mockResolvedValue({ ok: true, source: "bot", data: {
      ...LIVE_PROFILE, isPrivate: true, followedByViewer: false, viewerRelationshipKnown: true,
    } });
    const outcome = await collectPublicData(privateAccount());
    expect(outcome.profile).toMatchObject({ ok: false, error: "Approved follow relationship revoked" });
    expect(revokeAcceptedBotAccess).toHaveBeenCalledTimes(2);
    expect(getUserPostsAsBot).not.toHaveBeenCalled();
    expect(persistFollowerDiff).not.toHaveBeenCalled();
    expect(dbState.inserts).toHaveLength(0);
    expectNoPublicReads();
  });

  it("keeps approval when the profile omits relationship evidence", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    vi.mocked(getPublicProfileAsBot).mockResolvedValue({ ok: true, source: "bot", data: {
      ...LIVE_PROFILE, isPrivate: true, followedByViewer: false, viewerRelationshipKnown: false,
    } });
    expect((await collectPublicData(privateAccount())).profile.ok).toBe(true);
    expect(revokeAcceptedBotAccess).not.toHaveBeenCalled();
    expect(getUserPostsAsBot).toHaveBeenCalled();
  });

  it("does not use public/Tier-1 fallback when the approved viewer cannot be readied", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    vi.mocked(getPublicProfileAsBot).mockResolvedValue({ ok: false, source: "bot", error: "failed to ready bot: no healthy endpoint" });
    fetchPublicProfileTier1.mockResolvedValue({ ok: true, profile: LIVE_PROFILE, posts: [] });
    const outcome = await collectPublicData(privateAccount());
    expect(outcome.profile.ok).toBe(false);
    expect(getUserPostsAsBot).not.toHaveBeenCalled();
    expectNoPublicReads();
  });

  it("keeps cached-anchor continuation on the same approved viewer after a profile throttle", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    vi.mocked(getPublicProfileAsBot).mockResolvedValue({ ok: false, source: "bot", error: "rate limited (429)" });
    const outcome = await collectPublicData(privateAccount());
    expect(outcome.profile).toEqual({ ok: true, source: "cache" });
    expect(getUserPostsAsBot).toHaveBeenCalledWith("target", "igu-1", "approved-bot", expect.any(Number));
    expectNoPublicReads();
    expect(dbState.inserts).toHaveLength(0);
  });

  it("queues private posts, reels, carousel children, stories and highlights for durable media caching", async () => {
    vi.mocked(findGrantedBotId).mockResolvedValue("approved-bot");
    const post = {
      shortcode: "private-post", mediaId: "100", postType: "reel" as const,
      thumbnailUrl: "https://cdn.invalid/post-thumb", displayUrl: "https://cdn.invalid/post-display", videoUrl: "https://cdn.invalid/post-video",
      caption: "fixture", likeCount: 1, commentCount: 0, videoViewCount: 1, takenAt: new Date(), locationName: null, hashtags: [], isPinned: false,
      carouselMedia: [{ type: "video" as const, displayUrl: "https://cdn.invalid/child-display", videoUrl: "https://cdn.invalid/child-video" }],
    };
    const story = { storyId: "200", mediaType: "video" as const, mediaUrl: "https://cdn.invalid/story-video", thumbnailUrl: "https://cdn.invalid/story-thumb", takenAt: new Date(), expiresAt: new Date(Date.now()+86_400_000) };
    const highlightItem = { ...story, storyId: "300", mediaUrl: "https://cdn.invalid/highlight-video", thumbnailUrl: "https://cdn.invalid/highlight-thumb" };
    const highlight = { highlightId: "highlight:1", title: "fixture", coverUrl: "https://cdn.invalid/highlight-cover", mediaCount: 1, items: [highlightItem] };
    vi.mocked(getUserPostsAsBot).mockResolvedValue({ ok: true, source: "bot", data: [post] });
    vi.mocked(getUserStoriesAsBot).mockResolvedValue({ ok: true, source: "bot", data: [story] });
    vi.mocked(getUserHighlightsAsBot).mockResolvedValue({ ok: true, source: "bot", data: [highlight] });
    await collectPublicData(privateAccount());
    expect(enqueueMediaCacheUrls).toHaveBeenCalledExactlyOnceWith(new Set([
      LIVE_PROFILE.profilePicUrl, post.thumbnailUrl, post.displayUrl, post.videoUrl,
      post.carouselMedia[0].displayUrl, post.carouselMedia[0].videoUrl,
      story.mediaUrl, story.thumbnailUrl, highlight.coverUrl, highlightItem.mediaUrl, highlightItem.thumbnailUrl,
    ]), "scrape");
    expectNoPublicReads();
  });
});

// ── B2: truncated capture → unfollow suppression ────────────────────────────

describe("truncated capture → diff suppression (B2)", () => {
  it("skips persistFollowerDiff when truncation would pass the 0.90 gate", async () => {
    // 950 captured of expected 1000 → ratio 0.95 ≥ 0.90: the downstream
    // gate WOULD compute unfollows over a truncated roster. Must not run.
    vi.mocked(getAllUserFollowers).mockResolvedValue(
      truncatedCapture(buildUsers(950, "f"), "item_cap"),
    );
    vi.mocked(fetchExpectedCount).mockResolvedValue(1000);

    const outcome = await collectPublicData(buildAccount());

    expect(persistFollowerDiff).not.toHaveBeenCalled();
    expect(outcome.followers.error).toMatch(/truncated capture \(item_cap\)/i);
    expect(outcome.followers.newFollowers).toBe(0);
    expect(outcome.followers.newFollowerUnfollows).toBe(0);
    // The empty following response also cannot establish a positive-count roster.
    expect(persistFollowingDiff).not.toHaveBeenCalled();
    expect(outcome.following.error).toContain("empty roster despite a nonzero profile count");
  });

  it("persists the additive side when the downstream gate suppresses unfollows", async () => {
    // 500 of expected 1000 → ratio 0.5 < 0.90: persistence itself skips the
    // unfollow side, so the persist call proceeds (new followers still land).
    vi.mocked(getAllUserFollowers).mockResolvedValue(
      truncatedCapture(buildUsers(500, "f"), "page_cap"),
    );
    vi.mocked(fetchExpectedCount).mockResolvedValue(1000);

    const outcome = await collectPublicData(buildAccount());

    expect(persistFollowerDiff).toHaveBeenCalledTimes(1);
    expect(outcome.followers.error).toBeUndefined();
  });

  it("suppresses the following diff on a truncated following capture", async () => {
    vi.mocked(getAllUserFollowing).mockResolvedValue(
      truncatedCapture(buildUsers(48, "g"), "page_error"),
    );
    vi.mocked(fetchExpectedCount).mockResolvedValue(50);

    const outcome = await collectPublicData(buildAccount());

    expect(persistFollowingDiff).not.toHaveBeenCalled();
    expect(outcome.following.error).toMatch(
      /truncated capture \(page_error\)/i,
    );
  });

  it("complete captures persist both diffs normally", async () => {
    vi.mocked(getAllUserFollowers).mockResolvedValue(
      completeCapture(buildUsers(1000, "f")),
    );
    vi.mocked(getAllUserFollowing).mockResolvedValue(
      completeCapture(buildUsers(50, "g")),
    );

    const outcome = await collectPublicData(buildAccount());

    expect(persistFollowerDiff).toHaveBeenCalledTimes(1);
    expect(persistFollowingDiff).toHaveBeenCalledTimes(1);
    expect(outcome.followers.error).toBeUndefined();
    expect(outcome.following.error).toBeUndefined();
  });
});

// ── B9: force-full valve anchor ─────────────────────────────────────────────

describe("force-full valve anchor (B9)", () => {
  it.each([369, 413])("reports an exhausted %i-member follower read as incomplete when stored coverage rejects it", async captured => {
    vi.mocked(getAllUserFollowers).mockResolvedValue(completeCapture(buildUsers(captured, "followers")));
    vi.mocked(persistFollowerDiff).mockResolvedValueOnce({ completeRead: false, newFollowers: 0, newFollowerUnfollows: 0 });
    const outcome = await collectPublicData(buildAccount());
    expect(outcome.followers.error).toContain("below verified member coverage");
    expect(collectionCompletion(outcome).error).toContain("followers: roster exhausted below verified member coverage");
    expect(dbState.updates.some(u => "lastFollowersRefreshAt" in u || "lastGraphRefreshAt" in u)).toBe(false);
    expect(dbState.updates.some(u => "lastFollowingRefreshAt" in u)).toBe(true);
  });

  it("applies the same verified-coverage verdict to an exhausted following read", async () => {
    vi.mocked(getAllUserFollowing).mockResolvedValue(completeCapture(buildUsers(413, "following")));
    vi.mocked(persistFollowingDiff).mockResolvedValueOnce({ completeRead: false, newFollows: 0, newUnfollows: 0 });
    const outcome = await collectPublicData(buildAccount());
    expect(outcome.following.error).toContain("below verified member coverage");
    expect(collectionCompletion(outcome).error).toContain("following: roster exhausted below verified member coverage");
    expect(dbState.updates.some(u => "lastFollowingRefreshAt" in u || "lastGraphRefreshAt" in u)).toBe(false);
  });

  it("preserves a resumable partial leg without mislabeling it as an exhausted coverage failure", async () => {
    vi.mocked(getAllUserFollowers).mockResolvedValue({ ...truncatedCapture(buildUsers(369, "followers"), "page_cap"), nextCursor: "page-next" });
    vi.mocked(persistFollowerDiff).mockResolvedValueOnce({ completeRead: false, newFollowers: 0, newFollowerUnfollows: 0 });
    const outcome = await collectPublicData(buildAccount());
    expect(outcome.followers.error).toBeUndefined();
    expect(dbState.updates.some(u => "lastFollowersRefreshAt" in u || "lastGraphRefreshAt" in u)).toBe(false);
  });

  it("advances only the successful dimension when the other roster read fails", async () => {
    vi.mocked(getAllUserFollowers).mockResolvedValue({ok:false,source:"bot",error:"first page failed"});
    await collectPublicData(buildAccount());
    expect(dbState.updates.some(u => "lastFollowingRefreshAt" in u)).toBe(true);
    expect(dbState.updates.some(u => "lastFollowersRefreshAt" in u || "lastGraphRefreshAt" in u)).toBe(false);
  });

  it("pins public reads and starts a new epoch for a legacy cursor without its viewer", async () => {
    vi.mocked(loadRosterCursor).mockResolvedValue("LEGACY");
    await collectPublicData(buildAccount());
    expect(getAllUserFollowing).toHaveBeenCalledWith("igu-1",expect.objectContaining({startCursor:null,viewerBotId:null,pinViewer:true,savedSessionOnly:true}));
    expect(getAllUserFollowers).toHaveBeenCalledWith("target","igu-1",expect.objectContaining({startCursor:null,viewerBotId:null,pinViewer:true,savedSessionOnly:true}));
    expect(persistFollowerDiff).toHaveBeenCalledWith("acct-1",expect.any(Array),expect.objectContaining({leg:{startsEpoch:true,endsEpoch:true}}));
  });

  it("delegates an automatically enrolled cursor only after the worker is ready", async () => {
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS","");
    vi.mocked(readBackgroundRosterProgress).mockResolvedValue({source:"auto"} as Awaited<ReturnType<typeof readBackgroundRosterProgress>>);
    setBackgroundRosterWorkerReady(true);
    const result = await collectPublicData(buildAccount());
    expect(reconcileBackgroundRosters).toHaveBeenCalledTimes(1);
    expect(getAllUserFollowing).not.toHaveBeenCalled();
    expect(getAllUserFollowers).not.toHaveBeenCalled();
    expect(result.followers.error).toContain("background-sync");
    expect(anchorUpdates()).toHaveLength(0);
    setBackgroundRosterWorkerReady(false);
    await collectPublicData(buildAccount());
    expect(getAllUserFollowing).toHaveBeenCalledTimes(1);
    expect(getAllUserFollowers).toHaveBeenCalledTimes(1);
  });

  it("does not advertise a fresh roster when its data transaction failed", async () => {
    vi.mocked(getAllUserFollowers).mockResolvedValue(completeCapture(buildUsers(10, "followers")));
    vi.mocked(persistFollowerDiff).mockRejectedValueOnce(new Error("injected transaction failure"));
    const outcome = await collectPublicData(buildAccount());
    expect(outcome.followers.error).toMatch(/transaction failure/);
    expect(dbState.updates.some(u => "lastFollowersRefreshAt" in u || "lastGraphRefreshAt" in u)).toBe(false);
  });

  it("passes the actual restarted epoch and cursor into the atomic persistence path", async () => {
    const store = await import("../roster-store.js");
    vi.mocked(store.loadRosterCursor).mockResolvedValueOnce("OLD").mockResolvedValueOnce("OLD");
    vi.mocked(getAllUserFollowers).mockResolvedValue({ ...completeCapture(buildUsers(10, "followers")), startedFromTop: true, nextCursor: null });
    await collectPublicData(buildAccount());
    expect(persistFollowerDiff).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      leg: { startsEpoch: true, endsEpoch: true }, cursor: { nextCursor: null, viewerBotId: undefined },
    }));
    expect(store.saveRosterCursor).not.toHaveBeenCalled();
  });
  it("advances last_graph_refresh_at when every enumerated capture is complete", async () => {
    await collectPublicData(buildAccount());
    expect(anchorUpdates()).toHaveLength(1);
  });

  it("does NOT advance the anchor when the follower capture is truncated", async () => {
    vi.mocked(getAllUserFollowers).mockResolvedValue(
      truncatedCapture(buildUsers(500, "f"), "item_cap"),
    );
    vi.mocked(fetchExpectedCount).mockResolvedValue(1000);

    await collectPublicData(buildAccount());

    expect(anchorUpdates()).toHaveLength(0);
  });

  it("does NOT advance the anchor when the following capture is truncated", async () => {
    vi.mocked(getAllUserFollowing).mockResolvedValue(
      truncatedCapture(buildUsers(10, "g"), "page_error"),
    );
    vi.mocked(fetchExpectedCount).mockResolvedValue(50);

    await collectPublicData(buildAccount());

    expect(anchorUpdates()).toHaveLength(0);
  });

  it("does NOT advance the anchor when an enumeration failed outright", async () => {
    vi.mocked(getAllUserFollowers).mockResolvedValue({
      ok: false,
      source: "bot",
      error: "first page failed",
    });

    await collectPublicData(buildAccount());

    expect(anchorUpdates()).toHaveLength(0);
  });
});

// ── A3: cached continuation ordering ────────────────────────────────────────

describe("cached profile continuation ordering (A3)", () => {
  it("rate-limited failure + dead browser pool → continues from cache", async () => {
    vi.mocked(getPublicProfile).mockResolvedValue(RATE_LIMITED_FAILURE);
    vi.mocked(fetchLastSnapshotCounts).mockResolvedValue({
      postCount: 10,
      followerCount: 999,
      followingCount: 50,
      snapshotAt: new Date(),
    });

    const outcome = await collectPublicData(buildAccount());

    // Old behavior: isPoolEmpty matched "no available bot" first and the
    // cycle aborted with "no bot available". Now the cache continuation wins.
    expect(outcome.profile.ok).toBe(true);
    expect(outcome.profile.source).toBe("cache");
    // Cached cycles must not write a fresh profile snapshot.
    expect(dbState.inserts).toHaveLength(0);
  });

  it("genuine pool-empty (no rate limit) still aborts with no-bot-available", async () => {
    vi.mocked(getPublicProfile).mockResolvedValue({
      ok: false,
      source: "bot",
      rateLimited: false,
      error: "no available bot in the pool",
    });

    const outcome = await collectPublicData(buildAccount());

    expect(outcome.profile.ok).toBe(false);
    expect(outcome.profile.error).toBe("no bot available");
  });

  it("permanent profile failure never serves cache", async () => {
    vi.mocked(getPublicProfile).mockResolvedValue({
      ok: false,
      source: "bot",
      rateLimited: false,
      error: "user not found (404)",
    });

    const outcome = await collectPublicData(buildAccount());

    expect(outcome.profile.ok).toBe(false);
    expect(outcome.profile.error).toMatch(/user not found/i);
  });

  it("uses safe Tier-1 profile/post fallback when the proxy provider is down", async () => {
    vi.mocked(getPublicProfile).mockResolvedValue({
      ok: false,
      source: "bot",
      rateLimited: false,
      error:
        "failed to ready bot observer: [proxy-provider] no healthy endpoint after 18 probes",
    });
    fetchPublicProfileTier1.mockResolvedValue({
      ok: true,
      profile: LIVE_PROFILE,
      posts: [
        {
          shortcode: "fresh-post",
          mediaId: "media-1",
          postType: "photo",
          thumbnailUrl: "https://example.com/thumb.jpg",
          displayUrl: "https://example.com/thumb.jpg",
          videoUrl: null,
          caption: "",
          likeCount: 10,
          commentCount: 1,
          videoViewCount: null,
          takenAt: new Date(),
          locationName: null,
          hashtags: [],
          isPinned: false,
          carouselMedia: null,
        },
      ],
    });

    const outcome = await collectPublicData(buildAccount());

    expect(outcome.profile.ok).toBe(true);
    expect(outcome.profile.source).toBe("tier1-direct");
    expect(fetchPublicProfileTier1).toHaveBeenCalledWith("target");
    expect(persistPosts).toHaveBeenCalledWith(
      "acct-1",
      expect.arrayContaining([
        expect.objectContaining({ shortcode: "fresh-post" }),
      ]),
      { preview: true },
    );
  });

  it("permanent shape wins even when rate-limit text is present", async () => {
    vi.mocked(getPublicProfile).mockResolvedValue({
      ok: false,
      source: "bot",
      rateLimited: true,
      error:
        "rate limited on HTTP transport (429); browser fallback failed: checkpoint_required",
    });

    const outcome = await collectPublicData(buildAccount());

    expect(outcome.profile.ok).toBe(false);
  });
});

// ── A6: consecutive cached-continuation cutoff ──────────────────────────────

describe("consecutive cached-continuation cutoff (A6)", () => {
  beforeEach(() => {
    vi.mocked(fetchLastSnapshotCounts).mockResolvedValue({
      postCount: 10,
      followerCount: 999,
      followingCount: 50,
      snapshotAt: new Date(),
    });
  });

  it("serves cache for 3 consecutive cycles, then fails the 4th", async () => {
    vi.mocked(getPublicProfile).mockResolvedValue(RATE_LIMITED_FAILURE);
    const account = buildAccount();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const outcome = await collectPublicData(account);
      expect(outcome.profile.ok).toBe(true);
      expect(outcome.profile.source).toBe("cache");
    }

    const fourth = await collectPublicData(account);
    expect(fourth.profile.ok).toBe(false);
    expect(fourth.profile.error).toMatch(/cutoff/i);
  });

  it("a successful live fetch resets the streak", async () => {
    const account = buildAccount();

    vi.mocked(getPublicProfile).mockResolvedValue(RATE_LIMITED_FAILURE);
    await collectPublicData(account);
    await collectPublicData(account);
    await collectPublicData(account);

    // Live success → streak resets.
    vi.mocked(getPublicProfile).mockResolvedValue({
      ok: true,
      data: LIVE_PROFILE,
      source: "bot",
    });
    const live = await collectPublicData(account);
    expect(live.profile.ok).toBe(true);
    expect(live.profile.source).toBe("bot");

    // Cache is available again for a fresh streak.
    vi.mocked(getPublicProfile).mockResolvedValue(RATE_LIMITED_FAILURE);
    const cached = await collectPublicData(account);
    expect(cached.profile.ok).toBe(true);
    expect(cached.profile.source).toBe("cache");
  });

  it("streaks are tracked per tracked account", async () => {
    vi.mocked(getPublicProfile).mockResolvedValue(RATE_LIMITED_FAILURE);
    const a = buildAccount({ id: "acct-A" });
    const b = buildAccount({ id: "acct-B" });

    await collectPublicData(a);
    await collectPublicData(a);
    await collectPublicData(a);
    const aFourth = await collectPublicData(a);
    expect(aFourth.profile.ok).toBe(false);

    // Account B has its own counter and still gets cache.
    const bFirst = await collectPublicData(b);
    expect(bFirst.profile.ok).toBe(true);
    expect(bFirst.profile.source).toBe("cache");
  });
});

// ── A9: unreliable cached counts must not force a full roster enumeration ─────
//
// When the live profile is rate-limited we continue from the cached anchor. A
// stale tracked_accounts.follower_count must NOT drive the diff-aware gate into
// a full enumeration. With a snapshot baseline present, the cached anchor uses
// the SNAPSHOT counts (not the stale column), so a fresh+complete roster reads
// as "unchanged" and enumeration is skipped — saving residential bandwidth.

describe("cached profile counts → diff-aware gate (A9)", () => {
  beforeEach(() => {
    // A real snapshot baseline (follower 999 / following 50) exists.
    vi.mocked(fetchLastSnapshotCounts).mockResolvedValue({
      postCount: 10,
      followerCount: 999,
      followingCount: 50,
      snapshotAt: new Date(),
    });
    // Roster reads complete (>= 0.9 * count for both dimensions).
    dbState.rosterTotal = 1000;
  });

  it("does NOT enumerate when the stale column differs but the roster is complete+fresh", async () => {
    // Profile leg rate-limited → cached continuation. account.followerCount is
    // a stale 1500 that disagrees with the snapshot's 999; before A9 this drove
    // a false `count-changed` and a full follower enumeration.
    vi.mocked(getPublicProfile).mockResolvedValue(RATE_LIMITED_FAILURE);
    const account = buildAccount({
      followerCount: 1500,
      // Last enumerated recently → force-full TTL not tripped.
      lastGraphRefreshAt: new Date(),
    });

    const outcome = await collectPublicData(account);

    expect(outcome.profile.source).toBe("cache");
    // Gate decided "unchanged" off the snapshot baseline, not the stale column.
    expect(getAllUserFollowers).not.toHaveBeenCalled();
    expect(getAllUserFollowing).not.toHaveBeenCalled();
    expect(outcome.followers.error).toMatch(/skipped: unchanged \(diff-aware\)/i);
    expect(outcome.following.error).toMatch(/skipped: unchanged \(diff-aware\)/i);
  });

  it("a live fetch with a genuinely changed count still enumerates (gate intact)", async () => {
    // Live profile: followingCount 50 (== baseline) but the follower count
    // genuinely moved to 1100 (!= baseline 999) → count-changed must fetch.
    vi.mocked(getPublicProfile).mockResolvedValue({
      ok: true,
      data: { ...LIVE_PROFILE, followerCount: 1100, followingCount: 50 },
      source: "bot",
    });
    const account = buildAccount({ lastGraphRefreshAt: new Date() });

    await collectPublicData(account);

    // Followers changed → enumerated. Following unchanged + complete → skipped.
    expect(getAllUserFollowers).toHaveBeenCalledTimes(1);
    expect(getAllUserFollowing).not.toHaveBeenCalled();
  });

  it("does not let an old native backoff suppress a changed small roster's configured provider fallback", async () => {
    vi.stubEnv("APIFY_GRAPH_PROVIDER_OUTAGE_FALLBACK_ENABLED", "true");
    vi.mocked(getRosterSyncHealth).mockResolvedValue({
      settled: true,
      settledAt: new Date(),
      lastAttemptAt: new Date(),
      lastSuccessAt: new Date(),
      lastCompleteReadAt: new Date(),
      failureKind: "unavailable",
      lastError: "proxy provider unavailable",
      nextRetryAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    vi.mocked(getPublicProfile).mockResolvedValue({
      ok: true,
      data: { ...LIVE_PROFILE, followerCount: 1100, followingCount: 50 },
      source: "bot",
    });

    await collectPublicData(buildAccount({ lastGraphRefreshAt: new Date() }));

    expect(getAllUserFollowers).toHaveBeenCalledWith(
      "target",
      "igu-1",
      expect.objectContaining({ allowProviderOutageFallback: true }),
    );
    expect(getAllUserFollowing).not.toHaveBeenCalled();
  });

  it("allows an overdue small roster to refresh through the configured provider fallback", async () => {
    vi.stubEnv("APIFY_GRAPH_PROVIDER_OUTAGE_FALLBACK_ENABLED", "true");
    vi.mocked(getRosterSyncHealth).mockResolvedValue({
      settled: true,
      settledAt: new Date(),
      lastAttemptAt: new Date(),
      lastSuccessAt: new Date(),
      lastCompleteReadAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
      failureKind: "unavailable",
      lastError: "proxy provider unavailable",
      nextRetryAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    const staleGraphAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);

    await collectPublicData(buildAccount({ lastGraphRefreshAt: staleGraphAt }));

    expect(getAllUserFollowers).toHaveBeenCalledWith(
      "target",
      "igu-1",
      expect.objectContaining({ allowProviderOutageFallback: true }),
    );
    expect(getAllUserFollowing).toHaveBeenCalledWith(
      "igu-1",
      expect.objectContaining({ allowProviderOutageFallback: true }),
    );
  });

  it("keeps backoff active when the independent fallback itself has an auth failure", async () => {
    vi.stubEnv("APIFY_GRAPH_PROVIDER_OUTAGE_FALLBACK_ENABLED", "true");
    vi.mocked(getRosterSyncHealth).mockResolvedValue({
      settled: true,
      settledAt: new Date(),
      lastAttemptAt: new Date(),
      lastSuccessAt: new Date(),
      failureKind: "auth",
      lastError: "Apify API 401",
      nextRetryAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    vi.mocked(getPublicProfile).mockResolvedValue({
      ok: true,
      data: { ...LIVE_PROFILE, followerCount: 1100 },
      source: "bot",
    });

    await collectPublicData(buildAccount({ lastGraphRefreshAt: new Date() }));

    expect(getAllUserFollowers).not.toHaveBeenCalled();
    expect(getAllUserFollowing).not.toHaveBeenCalled();
  });
});

describe("independent verified roster freshness", () => {
  const oldRead = () => new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
  const recentAccount = () => buildAccount({
    lastGraphRefreshAt: new Date(),
    lastFollowersRefreshAt: new Date(),
    lastFollowingRefreshAt: new Date(),
  });
  const health = (lastCompleteReadAt: Date | null) => ({
    settled: true, settledAt: oldRead(), lastAttemptAt: new Date(),
    lastSuccessAt: new Date(), lastCompleteReadAt,
    failureKind: null, lastError: null, nextRetryAt: null,
  });
  beforeEach(() => {
    dbState.rosterTotal = 1000;
    vi.mocked(fetchLastSnapshotCounts).mockResolvedValue({
      followerCount: 1000, followingCount: 50, postCount: 10, snapshotAt: new Date(),
    });
  });

  it.each(["follower", "following"] as const)(
    "refreshes stale %s despite fresh shared, head-success and exhausted-walk anchors",
    async (staleKind) => {
      vi.mocked(getRosterSyncHealth).mockImplementation(async (_id, kind) =>
        health(kind === staleKind ? oldRead() : new Date()));
      await collectPublicData(recentAccount());
      expect(getAllUserFollowers).toHaveBeenCalledTimes(staleKind === "follower" ? 1 : 0);
      expect(getAllUserFollowing).toHaveBeenCalledTimes(staleKind === "following" ? 1 : 0);
    },
  );

  it("does not rewalk verified-fresh lists because the shared graph anchor is old", async () => {
    await collectPublicData(buildAccount({
      lastGraphRefreshAt: oldRead(), lastFollowersRefreshAt: new Date(),
      lastFollowingRefreshAt: new Date(),
    }));
    expect(getAllUserFollowers).not.toHaveBeenCalled();
    expect(getAllUserFollowing).not.toHaveBeenCalled();
  });

  it("never treats an unverified baseline as fresh after recent partial sightings", async () => {
    vi.mocked(getRosterSyncHealth).mockResolvedValue(health(null));
    await collectPublicData(recentAccount());
    expect(getAllUserFollowers).toHaveBeenCalledTimes(1);
    expect(getAllUserFollowing).toHaveBeenCalledTimes(1);
  });

  it("still respects an active target backoff when the complete read is stale", async () => {
    vi.mocked(getRosterSyncHealth).mockResolvedValue({
      ...health(oldRead()), failureKind: "auth", lastError: "auth rejected",
      nextRetryAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    await collectPublicData(recentAccount());
    expect(getAllUserFollowers).not.toHaveBeenCalled();
    expect(getAllUserFollowing).not.toHaveBeenCalled();
  });

  it("continues a saved epoch even if the previous verified read is fresh", async () => {
    vi.mocked(loadRosterCursor).mockImplementation(async (_id, kind) =>
      kind === "following" ? "RESUME" : null);
    vi.mocked(loadRosterViewer).mockResolvedValue("reader-1");
    await collectPublicData(recentAccount());
    expect(getAllUserFollowing).toHaveBeenCalledWith("igu-1", expect.objectContaining({
      startCursor: "RESUME", viewerBotId: "reader-1",
    }));
    expect(getAllUserFollowers).not.toHaveBeenCalled();
  });

  it("does not lift the capture cap to chase an unverified oversized roster", async () => {
    vi.mocked(getPublicProfile).mockResolvedValue({
      ok: true, source: "bot", data: { ...LIVE_PROFILE, followerCount: 335_000 },
    });
    vi.mocked(getRosterSyncHealth).mockImplementation(async (_id, kind) =>
      health(kind === "follower" ? oldRead() : new Date()));
    await collectPublicData(recentAccount());
    expect(getAllUserFollowers).not.toHaveBeenCalled();
    expect(markRosterTooLarge).toHaveBeenCalledWith("acct-1", "follower", 335_000);
  });
});

// ── 0042: age-tiered engagement re-scrape ───────────────────────────────────
//
// The waste being fixed is re-scraping OLD posts whose engagement has
// plateaued. Re-scraping a RECENT post is the feature working — its liker list
// and comment thread genuinely keep growing — so these tests pin the boundary
// in both directions. `parseEnvInt` is mocked to return its fallback, so the
// defaults under test are ENGAGEMENT_FRESH_POST_HOURS=48 /
// ENGAGEMENT_RECHECK_HOURS=24.

describe("engagement age-tiering (migration 0042)", () => {
  const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
  const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60 * 1000);

  it("treats posts inside the 48h window as fresh and older ones as stale", () => {
    expect(isFreshEngagementPost(hoursAgo(0), NOW)).toBe(true);
    expect(isFreshEngagementPost(hoursAgo(47.9), NOW)).toBe(true);
    expect(isFreshEngagementPost(hoursAgo(48.1), NOW)).toBe(false);
    expect(isFreshEngagementPost(hoursAgo(24 * 30), NOW)).toBe(false);
  });

  it("treats an undateable post as fresh so the filter can only add scraping", () => {
    expect(isFreshEngagementPost(null, NOW)).toBe(true);
    expect(isFreshEngagementPost(undefined, NOW)).toBe(true);
    expect(isFreshEngagementPost(new Date("not-a-date"), NOW)).toBe(true);
  });

  it("keeps re-scraping a fresh post every cycle even when just checked", () => {
    // THE constraint: a post published 3h ago and scraped 5 minutes ago must
    // still be scraped again this cycle.
    expect(shouldScrapeEngagement(hoursAgo(3), true, NOW)).toBe(true);
    expect(shouldScrapeEngagement(hoursAgo(47), true, NOW)).toBe(true);
  });

  it("skips an old post that was already scraped inside the recheck window", () => {
    expect(shouldScrapeEngagement(hoursAgo(72), true, NOW)).toBe(false);
    expect(shouldScrapeEngagement(hoursAgo(24 * 90), true, NOW)).toBe(false);
  });

  it("scrapes an old post whose last check has aged out of the window", () => {
    // `checkedRecently=false` is what the loader returns once the row is older
    // than ENGAGEMENT_RECHECK_HOURS — and also what it returns when the memory
    // is unreadable (fail OPEN).
    expect(shouldScrapeEngagement(hoursAgo(72), false, NOW)).toBe(true);
    expect(shouldScrapeEngagement(null, false, NOW)).toBe(true);
  });
});

it("denies collection before contacting providers when subscription access ended", async () => {
  vi.mocked(trackedAccountHasAccess).mockResolvedValueOnce(false);
  await expect(collectPublicData(buildAccount())).rejects.toThrow("active paid subscription");
  expect(getPublicProfile).not.toHaveBeenCalled();
  expect(dbState.updates).toEqual([]);
});
