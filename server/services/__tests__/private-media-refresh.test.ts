import { beforeEach, describe, expect, it, vi } from "vitest";
vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
const f = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[][],
  updates: [] as Array<{ values: Record<string, unknown>; where: unknown }>,
  findGrantedBotId: vi.fn(), scrapeUserHighlights: vi.fn(), scrapeUserHighlightsWithBot: vi.fn(), getFreshMediaThumbnail: vi.fn(), getFreshMediaThumbnailWithBot: vi.fn(), getFreshMediaDetails: vi.fn(), getFreshMediaDetailsWithBot: vi.fn(), scrapeUserStories: vi.fn(), scrapeUserStoriesWithBot: vi.fn(),
}));
vi.mock("../../db.js", () => ({ db: {
  select: () => {
    let pending: Promise<Record<string, unknown>[]> | undefined;
    const q: any = { from: () => q, where: () => q, limit: () => q, then: (a: any, b: any) => (pending ??= Promise.resolve(f.rows.shift() ?? [])).then(a, b) };
    return q;
  },
  update: () => ({ set: (values: Record<string, unknown>) => ({ where: async (where: unknown) => { f.updates.push({ values, where }); } }) }),
} }));
vi.mock("../../observability/logger.js", () => ({ logger: { info() {}, warn() {}, error() {} } }));
vi.mock("../../ig-public-scraper.js", () => ({
  scrapeUserHighlights: f.scrapeUserHighlights, scrapeUserHighlightsWithBot: f.scrapeUserHighlightsWithBot, getFreshMediaThumbnail: f.getFreshMediaThumbnail, getFreshMediaThumbnailWithBot: f.getFreshMediaThumbnailWithBot,
  getFreshMediaDetails: f.getFreshMediaDetails, getFreshMediaDetailsWithBot: f.getFreshMediaDetailsWithBot, scrapeUserStories: f.scrapeUserStories, scrapeUserStoriesWithBot: f.scrapeUserStoriesWithBot,
}));
vi.mock("../private-account-access.js", () => ({ findGrantedBotId: f.findGrantedBotId }));
import { __testing } from "../media-cache.js";
const DEAD = "https://cdninstagram.com/old-frame.mp4?sig=expired";
const FRESH = "https://cdninstagram.com/old-frame.mp4?sig=fresh";
const OTHER = "https://cdninstagram.com/other-frame.mp4?sig=fresh";

beforeEach(() => {
  f.rows = []; f.updates = [];
  f.findGrantedBotId.mockReset().mockResolvedValue("approved-bot");
  f.scrapeUserHighlights.mockReset(); f.scrapeUserHighlightsWithBot.mockReset(); f.getFreshMediaThumbnail.mockReset(); f.getFreshMediaThumbnailWithBot.mockReset(); f.getFreshMediaDetails.mockReset(); f.getFreshMediaDetailsWithBot.mockReset(); f.scrapeUserStories.mockReset(); f.scrapeUserStoriesWithBot.mockReset();
});
function itemFixture(isPrivate = true) {
  f.rows = [[], [], [{ highlightCacheId: "cache" }], [{ highlightId: "highlight", trackedAccountId: "tracked" }], [{ id: "tracked", igUserId: "123", isPrivate }], [
    { id: "db-a", storyId: "story-a", mediaUrl: DEAD, thumbnailUrl: "old-a-thumb" },
    { id: "db-deleted", storyId: "deleted-story", mediaUrl: "removed-url" },
    { id: "db-b", storyId: "story-b", mediaUrl: "old-b", thumbnailUrl: "old-b-thumb" },
  ]];
  const trays = [{ highlightId: "highlight", items: [
    { storyId: "story-b", mediaUrl: OTHER, thumbnailUrl: "fresh-b-thumb" },
    { storyId: "new-story", mediaUrl: "new-frame", thumbnailUrl: "new-thumb" },
    { storyId: "story-a", mediaUrl: FRESH, thumbnailUrl: "fresh-a-thumb" },
  ] }];
  f.scrapeUserHighlightsWithBot.mockResolvedValue(trays); f.scrapeUserHighlights.mockResolvedValue(trays);
}

describe("private highlight media repair", () => {
  it("pins expired covers to an approved bot rather than a generic reader", async () => {
    f.rows = [[], [{ highlightId: "highlight", trackedAccountId: "tracked" }], [{ id: "tracked", igUserId: "123", isPrivate: true }]];
    f.scrapeUserHighlightsWithBot.mockResolvedValue([{ highlightId: "highlight", coverUrl: FRESH }]);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.findGrantedBotId).toHaveBeenCalledWith("tracked");
    expect(f.scrapeUserHighlightsWithBot).toHaveBeenCalledWith("approved-bot", "123");
    expect(f.scrapeUserHighlights).not.toHaveBeenCalled();
  });
  it("uses stable story identity when Instagram reorders, adds and deletes frames", async () => {
    itemFixture();
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.scrapeUserHighlightsWithBot).toHaveBeenCalledWith("approved-bot", "123", { withItems: true });
    expect(f.scrapeUserHighlights).not.toHaveBeenCalled();
    expect(f.updates.map(r => r.values)).toEqual([
      { mediaUrl: FRESH, thumbnailUrl: "fresh-a-thumb" },
      { mediaUrl: OTHER, thumbnailUrl: "fresh-b-thumb" },
    ]);
  });
  it("does not spend traffic or mutate private frames when the approved session is unavailable", async () => {
    itemFixture(); f.findGrantedBotId.mockResolvedValue(null);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBeNull();
    expect(f.scrapeUserHighlightsWithBot).not.toHaveBeenCalled(); expect(f.scrapeUserHighlights).not.toHaveBeenCalled(); expect(f.updates).toEqual([]);
  });
  it("continues generic public highlight repair while retaining story identity", async () => {
    itemFixture(false);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.scrapeUserHighlights).toHaveBeenCalledWith("123", { withItems: true });
    expect(f.findGrantedBotId).not.toHaveBeenCalled(); expect(f.scrapeUserHighlightsWithBot).not.toHaveBeenCalled();
  });
  it("does not substitute another frame when the requested story disappeared", async () => {
    itemFixture();
    f.scrapeUserHighlightsWithBot.mockResolvedValue([{ highlightId: "highlight", items: [{ storyId: "story-b", mediaUrl: OTHER, thumbnailUrl: "fresh-b-thumb" }] }]);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBeNull();
    expect(f.updates.map(r => r.values)).toEqual([{ mediaUrl: OTHER, thumbnailUrl: "fresh-b-thumb" }]);
  });
});


describe("private post thumbnail repair", () => {
  it("uses the approved private bot to renew a post image", async () => {
    f.rows = [[{ mediaId: "99", shortcode: "ABC", trackedAccountId: "tracked" }], [{ isPrivate: true }]];
    f.getFreshMediaThumbnailWithBot.mockResolvedValue(FRESH);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.findGrantedBotId).toHaveBeenCalledWith("tracked");
    expect(f.getFreshMediaThumbnailWithBot).toHaveBeenCalledWith("approved-bot", "99");
    expect(f.getFreshMediaThumbnail).not.toHaveBeenCalled();
  });
  it("keeps a private image unavailable when no approved session is ready", async () => {
    f.rows = [[{ mediaId: "99", shortcode: "ABC", trackedAccountId: "tracked" }], [{ isPrivate: true }]];
    f.findGrantedBotId.mockResolvedValue(null);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBeNull();
    expect(f.getFreshMediaThumbnailWithBot).not.toHaveBeenCalled(); expect(f.getFreshMediaThumbnail).not.toHaveBeenCalled();
    expect(f.updates).toEqual([]);
  });
  it("keeps public thumbnail renewal on the existing public reader", async () => {
    f.rows = [[{ mediaId: "99", shortcode: "ABC", trackedAccountId: "tracked" }], [{ isPrivate: false }]];
    f.getFreshMediaThumbnail.mockResolvedValue(FRESH);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.getFreshMediaThumbnail).toHaveBeenCalledWith("99"); expect(f.findGrantedBotId).not.toHaveBeenCalled();
  });
  it("uses the grant of the tracked account that supplied private liked-post evidence", async () => {
    f.rows = [[], [], [], [], [{ postId: "ABC", trackedAccountId: "tracked" }], [{ isPrivate: true }]];
    f.getFreshMediaThumbnailWithBot.mockResolvedValue(FRESH);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.findGrantedBotId).toHaveBeenCalledWith("tracked"); expect(f.getFreshMediaThumbnail).not.toHaveBeenCalled();
    expect(f.getFreshMediaThumbnailWithBot).toHaveBeenCalledWith("approved-bot", expect.any(String));
  });
});


describe("active story URL renewal", () => {
  function stories(isPrivate = true) {
    const expiresAt = new Date(Date.now() + 3600_000);
    f.rows = [[], [], [], [{ id: "story-row", storyId: "story-a", trackedAccountId: "tracked", mediaUrl: DEAD, thumbnailUrl: "old-thumb", expiresAt }], [{ id: "tracked", igUserId: "123", isPrivate }]];
    const fresh = [{ storyId: "other", mediaUrl: OTHER, thumbnailUrl: "other-thumb", expiresAt }, { storyId: "story-a", mediaUrl: FRESH, thumbnailUrl: "fresh-thumb", expiresAt }];
    f.scrapeUserStoriesWithBot.mockResolvedValue(fresh); f.scrapeUserStories.mockResolvedValue(fresh);
  }
  it("renews the exact active private story through its approved bot", async () => {
    stories(); expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.scrapeUserStoriesWithBot).toHaveBeenCalledWith("approved-bot", "123"); expect(f.scrapeUserStories).not.toHaveBeenCalled();
    expect(f.updates.map(row => row.values)).toEqual([{ mediaUrl: FRESH, thumbnailUrl: "fresh-thumb" }]);
  });
  it("preserves public story renewal without requiring a private grant", async () => {
    stories(false); expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.scrapeUserStories).toHaveBeenCalledWith("123"); expect(f.findGrantedBotId).not.toHaveBeenCalled();
  });
  it("never substitutes another story after the requested story has disappeared", async () => {
    stories(); f.scrapeUserStoriesWithBot.mockResolvedValue([{ storyId: "other", mediaUrl: OTHER, expiresAt: new Date(Date.now() + 3600_000) }]);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBeNull(); expect(f.updates).toEqual([]);
  });
  it("does not call Instagram for a story whose 24-hour lifetime ended", async () => {
    stories(); f.rows[3][0].expiresAt = new Date(Date.now() - 1000);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBeNull(); expect(f.scrapeUserStoriesWithBot).not.toHaveBeenCalled(); expect(f.scrapeUserStories).not.toHaveBeenCalled();
  });
  it("does not use a random public bot when the approved story reader is unavailable", async () => {
    stories(); f.findGrantedBotId.mockResolvedValue(null);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBeNull(); expect(f.scrapeUserStoriesWithBot).not.toHaveBeenCalled(); expect(f.scrapeUserStories).not.toHaveBeenCalled();
  });
});

describe("post video and carousel URL renewal", () => {
  it("renews an expired private post video using its approved bot", async () => {
    f.rows = [[{ id: "post", mediaId: "99", trackedAccountId: "tracked", videoUrl: DEAD }], [{ isPrivate: true }]];
    f.getFreshMediaDetailsWithBot.mockResolvedValue({ videoUrl: FRESH, carouselMedia: null });
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.getFreshMediaDetailsWithBot).toHaveBeenCalledWith("approved-bot", "99"); expect(f.getFreshMediaDetails).not.toHaveBeenCalled();
    expect(f.updates.map(row => row.values)).toEqual([{ videoUrl: FRESH }]);
  });
  it("renews public post videos without a private session requirement", async () => {
    f.rows = [[{ id: "post", mediaId: "99", trackedAccountId: "tracked", videoUrl: DEAD }], [{ isPrivate: false }]];
    f.getFreshMediaDetails.mockResolvedValue({ videoUrl: FRESH });
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH); expect(f.getFreshMediaDetails).toHaveBeenCalledWith("99");
    expect(f.findGrantedBotId).not.toHaveBeenCalled();
  });
  it("pins private video failures and never falls back to a public reader", async () => {
    f.rows = [[{ id: "post", mediaId: "99", trackedAccountId: "tracked", videoUrl: DEAD }], [{ isPrivate: true }]];
    f.findGrantedBotId.mockResolvedValue(null);
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBeNull(); expect(f.getFreshMediaDetails).not.toHaveBeenCalled(); expect(f.getFreshMediaDetailsWithBot).not.toHaveBeenCalled();
  });
  it("matches legacy carousel frames by stable URL path after order changes", async () => {
    const children = [{ type: "video", displayUrl: "thumb-a", videoUrl: DEAD }, { type: "video", displayUrl: "thumb-b", videoUrl: "old-b" }];
    f.rows = [[{ id: "post", mediaId: "99", trackedAccountId: "tracked", carouselMedia: children }], [{ isPrivate: true }]];
    f.getFreshMediaDetailsWithBot.mockResolvedValue({ carouselMedia: [{ type: "video", displayUrl: "new-b", videoUrl: OTHER }, { type: "video", displayUrl: "new-a", videoUrl: FRESH }] });
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(FRESH);
    expect(f.updates[0].values.carouselMedia).toEqual([{ ...children[0], videoUrl: FRESH }, children[1]]);
  });
  it("uses stable child ID when its CDN path changes", async () => {
    f.rows = [[{ id: "post", mediaId: "99", trackedAccountId: "tracked", carouselMedia: [{ mediaId: "child-a", type: "video", displayUrl: "thumb-a", videoUrl: DEAD }] }], [{ isPrivate: true }]];
    f.getFreshMediaDetailsWithBot.mockResolvedValue({ carouselMedia: [{ mediaId: "child-b", type: "video", videoUrl: FRESH }, { mediaId: "child-a", type: "video", videoUrl: OTHER }] });
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBe(OTHER);
    expect((f.updates[0].values.carouselMedia as any[])[0].videoUrl).toBe(OTHER);
  });
  it("leaves an unidentifiable legacy child unavailable instead of substituting by index", async () => {
    f.rows = [[{ id: "post", mediaId: "99", trackedAccountId: "tracked", carouselMedia: [{ type: "video", displayUrl: "thumb-a", videoUrl: DEAD }] }], [{ isPrivate: true }]];
    f.getFreshMediaDetailsWithBot.mockResolvedValue({ carouselMedia: [{ type: "video", videoUrl: OTHER }] });
    expect(await __testing.resolveFreshUrlForExpiredMedia(DEAD)).toBeNull(); expect(f.updates).toEqual([]);
  });
});
