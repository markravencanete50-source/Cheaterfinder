// Tests for the expired-signature recovery path in media-cache.ts.
//
// Instagram CDN URLs are signed and expire. Once they do, the CDN answers 403,
// the stored thumbnail_url is dead, and readCachedMediaAsset's self-heal just
// re-fetches the SAME dead URL — so the image stays broken forever. That was
// 3,375 permanently-broken images in production. resolveFreshUrlForExpiredMedia
// maps the dead URL back to its media id and asks IG for a freshly-signed one.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../../observability/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { selectRows, updateSpy, getFreshMediaThumbnail } = vi.hoisted(() => ({
  selectRows: { value: [] as Array<Record<string, unknown>> },
  updateSpy: vi.fn(),
  getFreshMediaThumbnail: vi.fn(),
}));

// Minimal drizzle chain stubs — only the shapes media-cache actually calls.
vi.mock("../../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => selectRows.value }),
      }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          updateSpy(values);
        },
      }),
    }),
  },
}));

vi.mock("../../ig-public-scraper.js", () => ({ getFreshMediaThumbnail, getFreshMediaThumbnailWithBot: vi.fn() }));

import { __testing, mediaCacheKey } from "../media-cache.js";

const DEAD_URL = "https://scontent.cdninstagram.com/v/t51/dead.jpg?_nc_sid=old";
const FRESH_URL = "https://scontent.cdninstagram.com/v/t51/dead.jpg?_nc_sid=new";

beforeEach(() => {
  selectRows.value = [];
  updateSpy.mockReset();
  getFreshMediaThumbnail.mockReset();
});

describe("isExpiredSignatureError", () => {
  it("matches a 403 (expired signature — a fresh URL exists)", () => {
    expect(__testing.isExpiredSignatureError("media upstream status 403")).toBe(
      true,
    );
  });

  it("does NOT match 410 — the media is gone, no signature can revive it", () => {
    expect(__testing.isExpiredSignatureError("media upstream status 410")).toBe(
      false,
    );
  });

  it("does NOT match unrelated failures (timeouts, size caps)", () => {
    expect(__testing.isExpiredSignatureError("media fetch timeout")).toBe(false);
    expect(__testing.isExpiredSignatureError("media too large: 45073250")).toBe(
      false,
    );
  });
});

describe("resolveFreshUrlForExpiredMedia", () => {
  it("returns a freshly-signed URL and persists it so later views cost no IG call", async () => {
    selectRows.value = [{ mediaId: "123456789", shortcode: "ABC123" }];
    getFreshMediaThumbnail.mockResolvedValue(FRESH_URL);

    const fresh = await __testing.resolveFreshUrlForExpiredMedia(DEAD_URL);

    expect(fresh).toBe(FRESH_URL);
    expect(getFreshMediaThumbnail).toHaveBeenCalledWith("123456789");
    // Must write the fresh URL to BOTH posts_cache and like_events, otherwise
    // the next render re-requests the dead URL and pays the refresh again.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ thumbnailUrl: FRESH_URL }),
    );
  });

  it("returns null when the URL maps to no post (nothing to refresh)", async () => {
    selectRows.value = [];
    const fresh = await __testing.resolveFreshUrlForExpiredMedia(DEAD_URL);
    expect(fresh).toBeNull();
    expect(getFreshMediaThumbnail).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns null when the post has no numeric media id — never spends an IG call", async () => {
    selectRows.value = [{ mediaId: null, shortcode: "ABC123" }];
    const fresh = await __testing.resolveFreshUrlForExpiredMedia(DEAD_URL);
    expect(fresh).toBeNull();
    expect(getFreshMediaThumbnail).not.toHaveBeenCalled();
  });

  it("returns null when IG has no image for the media", async () => {
    selectRows.value = [{ mediaId: "123456789", shortcode: "ABC123" }];
    getFreshMediaThumbnail.mockResolvedValue(null);
    const fresh = await __testing.resolveFreshUrlForExpiredMedia(DEAD_URL);
    expect(fresh).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns null when IG hands back the same dead URL (avoids a pointless retry)", async () => {
    selectRows.value = [{ mediaId: "123456789", shortcode: "ABC123" }];
    getFreshMediaThumbnail.mockResolvedValue(DEAD_URL);
    const fresh = await __testing.resolveFreshUrlForExpiredMedia(DEAD_URL);
    expect(fresh).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

// ── Stable cache identity ────────────────────────────────────────────────────
// IG re-signs every media URL on each scrape AND load-balances the CDN host, so
// keying the cache on the full URL treated one image as endless new assets:
// 200,547 rows for 59,090 real images (70.5% duplicates, ~21 GB) — the engine
// behind the recurring disk-full and constant re-downloads over metered proxy.
describe("mediaCacheKey — stable across IG URL re-signing", () => {
  const PATH = "/v/t51.82787-15/731736057_1787_n.jpg";
  const a = `https://scontent-ord5-3.cdninstagram.com${PATH}?oh=00_SIG_A&oe=1111&_nc_sid=aaa`;
  const b = `https://scontent-ber1-1.cdninstagram.com${PATH}?oh=00_SIG_B&oe=2222&_nc_sid=bbb`;

  it("gives the SAME key when only host + signature rotate", () => {
    expect(mediaCacheKey(a)).toBe(mediaCacheKey(b));
  });

  it("gives DIFFERENT keys for genuinely different assets", () => {
    const other = `https://scontent-ord5-3.cdninstagram.com/v/t51.82787-15/OTHER_n.jpg?oh=00_SIG_A`;
    expect(mediaCacheKey(a)).not.toBe(mediaCacheKey(other));
  });

  it("uses only the path as identity", () => {
    expect(__testing.stableMediaPath(a)).toBe(PATH);
    expect(__testing.stableMediaPath(b)).toBe(PATH);
  });

  it("falls back to the whole string when unparseable (never collide two assets)", () => {
    expect(__testing.stableMediaPath("not a url")).toBe("not a url");
  });
});
