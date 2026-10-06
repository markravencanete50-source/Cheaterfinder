// Tests for deriving a post's publish time from its Instagram media id.
//
// Issue 3 (2026-07-16): the liked-posts section is sorted by post date, but
// post_taken_at was NULL for ~every row (the liked-by facepile media carries no
// taken_at), so the sort silently fell back to detection time. Instagram media
// ids encode the creation time, so we recover the post date from the id alone.
// If the epoch or bit-shift here drifts, every liked-posts sort breaks — hence
// the pinned known-value checks.

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
// media-cache.js (imported transitively for shortcodeToMediaId) touches db at
// module load; the stubbed URL is enough for it to import.

// Dynamic import is intentional: ESM static imports run before stubEnv(),
// which made db.ts see a missing DATABASE_URL during module initialization.
const { postCreatedAt } = await import("../ig-media-time.js");

describe("postCreatedAt", () => {
  it("derives a plausible recent date from a real shortcode", () => {
    // Da0xCCjlWuE decoded live to 2026-07-15 in the investigation.
    const d = postCreatedAt("Da0xCCjlWuE");
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString().slice(0, 7)).toBe("2026-07");
  });

  it("derives an older date from an older shortcode", () => {
    // CtKrTu2sAlM → 2023-06.
    expect(postCreatedAt("CtKrTu2sAlM")!.toISOString().slice(0, 4)).toBe("2023");
  });

  it("orders two shortcodes by their true post date", () => {
    // A newer post must derive to a later time than an older one — the property
    // the liked-posts sort depends on.
    const newer = postCreatedAt("Da0xCCjlWuE")!; // 2026-07
    const older = postCreatedAt("CtKrTu2sAlM")!; // 2023-06
    expect(newer.getTime()).toBeGreaterThan(older.getTime());
  });

  it("accepts a numeric media pk directly", () => {
    // pk for a mid-2020s post; just assert it decodes to a plausible range.
    const d = postCreatedAt("3200000000000000001");
    expect(d).toBeInstanceOf(Date);
    expect(d!.getUTCFullYear()).toBeGreaterThanOrEqual(2020);
  });

  it("returns null for non-decodable / mock ids", () => {
    expect(postCreatedAt("mock_post_1")).toBeNull(); // '_' not in the alphabet? '_' IS, but derived time is absurd
    expect(postCreatedAt("")).toBeNull();
    expect(postCreatedAt(null)).toBeNull();
    expect(postCreatedAt(undefined)).toBeNull();
  });

  it("rejects ids that decode to an implausible (future) time", () => {
    // A 39-char 'shortcode' decodes to an astronomically large pk → future date.
    expect(postCreatedAt("DAy2tXkRSgoHuTHqcnPP7p5tAQfV-PO06MTJPw0")).toBeNull();
  });
});
