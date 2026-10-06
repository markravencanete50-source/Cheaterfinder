// Wave 9: unit tests for the pure liked-by feed parser. No I/O — exercises the
// defensive envelope handling and liker/username extraction against the shapes
// IG uses for the home (feed_items) and reels (items) feeds.

import { describe, it, expect } from "vitest";
import {
  extractHashtags,
  parseLikedByFeed,
} from "../liked-by-feed-parser.js";

function media(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: "3200000000000000001",
    id: "3200000000000000001_555",
    code: "CxAbC123",
    media_type: 1,
    like_count: 42,
    comment_count: 3,
    user: { username: "zara_pakistan" },
    caption: { text: "new drop #eid #summer" },
    image_versions2: {
      candidates: [{ url: "https://scontent.example/img_hi.jpg", width: 1080 }],
    },
    facepile_top_likers: [{ pk: "1", username: "Shophoria.PK" }],
    ...overrides,
  };
}

describe("parseLikedByFeed", () => {
  it("extracts a suggested post from the home feed_items / explore_story envelope", () => {
    const raw = {
      feed_items: [
        { explore_story: { media_or_ad: media() } },
        { end_of_feed_demarcator: { title: "You're all caught up" } },
      ],
    };
    const out = parseLikedByFeed(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      postId: "3200000000000000001",
      shortcode: "CxAbC123",
      ownerUsername: "zara_pakistan",
      postType: "photo",
      thumbnailUrl: "https://scontent.example/img_hi.jpg",
      likeCount: 42,
    });
    // Liker usernames are lower-cased for case-insensitive matching.
    expect(out[0].likerUsernames).toEqual(["shophoria.pk"]);
  });

  it("handles the reels items / media envelope and reel product_type", () => {
    const raw = {
      items: [
        {
          media: media({
            media_type: 2,
            product_type: "clips",
            top_likers: ["someone", "shophoria.pk"],
            facepile_top_likers: [],
          }),
        },
      ],
    };
    const out = parseLikedByFeed(raw);
    expect(out).toHaveLength(1);
    expect(out[0].postType).toBe("reel");
    expect(out[0].likerUsernames).toEqual(["someone", "shophoria.pk"]);
  });

  it("pulls usernames out of social_context user objects and nested users", () => {
    const raw = {
      feed_items: [
        {
          media_or_ad: media({
            facepile_top_likers: [],
            top_likers: [],
            social_context: [
              { type: "liked_by", user: { username: "alice" } },
              { users: [{ username: "Bob" }, "carol"] },
            ],
          }),
        },
      ],
    };
    const out = parseLikedByFeed(raw);
    expect(out[0].likerUsernames.sort()).toEqual(["alice", "bob", "carol"]);
  });

  it("drops posts with no liker facepile", () => {
    const raw = {
      feed_items: [
        { explore_story: { media_or_ad: media({ facepile_top_likers: [] }) } },
      ],
    };
    expect(parseLikedByFeed(raw)).toHaveLength(0);
  });

  it("deduplicates the same post appearing across containers", () => {
    const m = media();
    const raw = {
      feed_items: [{ explore_story: { media_or_ad: m } }],
      items: [{ media: m }],
    };
    expect(parseLikedByFeed(raw)).toHaveLength(1);
  });

  it("never treats the post owner as a liker", () => {
    const raw = {
      feed_items: [
        {
          explore_story: {
            media_or_ad: media({
              user: { username: "owner_handle" },
              facepile_top_likers: [{ username: "real_liker" }],
            }),
          },
        },
      ],
    };
    const out = parseLikedByFeed(raw);
    expect(out[0].ownerUsername).toBe("owner_handle");
    expect(out[0].likerUsernames).not.toContain("owner_handle");
    expect(out[0].likerUsernames).toEqual(["real_liker"]);
  });

  it("is robust to garbage / missing fields", () => {
    expect(parseLikedByFeed(null)).toEqual([]);
    expect(parseLikedByFeed({})).toEqual([]);
    expect(parseLikedByFeed({ feed_items: "nope" })).toEqual([]);
    expect(parseLikedByFeed({ feed_items: [null, 5, {}] })).toEqual([]);
  });
});

// ── Post publish date (migration 0030) ──────────────────────────────────────
//
// The parser used to drop IG's `taken_at`, leaving detected_at (when we
// INFERRED the like) as the only date. Every surface then ordered liked posts by
// detection, so a week-old post noticed five minutes ago outranked one published
// this morning — reported as "liked post order off".

describe("taken_at extraction", () => {
  it("converts IG's unix SECONDS into a Date", () => {
    const takenAt = Math.floor(Date.UTC(2026, 6, 1, 12, 0, 0) / 1000);
    const [post] = parseLikedByFeed({ items: [{ media: media({ taken_at: takenAt }) }] });
    expect(post.takenAt?.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  it("returns null when taken_at is absent", () => {
    const [post] = parseLikedByFeed({ items: [{ media: media() }] });
    expect(post.takenAt).toBeNull();
  });

  it("rejects 0 / negative / absurd values rather than inventing 1970", () => {
    for (const bad of [0, -1, null, "yesterday", undefined]) {
      const [post] = parseLikedByFeed({ items: [{ media: media({ taken_at: bad }) }] });
      expect(post.takenAt).toBeNull();
    }
  });

  it("rejects a value that is already milliseconds (would land far in the future)", () => {
    const ms = Date.UTC(2026, 6, 1) ; // seconds-vs-ms mixup
    const [post] = parseLikedByFeed({ items: [{ media: media({ taken_at: ms }) }] });
    expect(post.takenAt).toBeNull();
  });
});

describe("extractHashtags", () => {
  it("returns unique hashtags and tolerates null", () => {
    expect(extractHashtags("hello #eid #summer #eid")).toEqual(["#eid", "#summer"]);
    expect(extractHashtags(null)).toEqual([]);
    expect(extractHashtags("")).toEqual([]);
  });
});
