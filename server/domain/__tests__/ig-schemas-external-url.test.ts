// Regression tests for externalUrl resolution in parseProfileResponse (A8).
//
// IG commonly returns external_url: "" (or whitespace) on profiles that have no
// link button but DO carry entries in bio_links. The schema preserves "" so a
// raw `??` chain would short-circuit on the empty string and never reach the
// bio_links fallback, then persist "" verbatim. parseProfileResponse must:
//   - treat empty/whitespace external_url as absent and fall through to bio_links
//   - resolve to a trimmed non-empty URL or null (never "")

import { describe, it, expect } from "vitest";
import { parseProfileResponse } from "../ig-schemas.js";

function profileRaw(user: Record<string, unknown>): unknown {
  return {
    data: {
      user: {
        id: "123",
        username: "target",
        ...user,
      },
    },
  };
}

describe("parseProfileResponse externalUrl resolution (A8)", () => {
  it('falls through to bio_links when external_url is "" ', () => {
    const result = parseProfileResponse(
      profileRaw({
        external_url: "",
        bio_links: [{ url: "https://linktr.ee/target" }],
      }),
    );
    expect(result.externalUrl).toBe("https://linktr.ee/target");
  });

  it("falls through to bio_links when external_url is whitespace-only", () => {
    const result = parseProfileResponse(
      profileRaw({
        external_url: "   ",
        bio_links: [{ url: "https://example.com/bio" }],
      }),
    );
    expect(result.externalUrl).toBe("https://example.com/bio");
  });

  it('resolves to null (not "") when no url is present anywhere', () => {
    const result = parseProfileResponse(
      profileRaw({ external_url: "", bio_links: [] }),
    );
    expect(result.externalUrl).toBeNull();
  });

  it('resolves to null when external_url is "" and bio_links entries are empty', () => {
    const result = parseProfileResponse(
      profileRaw({
        external_url: "",
        bio_links: [{ url: "" }, { url: "  " }],
      }),
    );
    expect(result.externalUrl).toBeNull();
  });

  it("trims a present external_url", () => {
    const result = parseProfileResponse(
      profileRaw({ external_url: "  https://site.com  " }),
    );
    expect(result.externalUrl).toBe("https://site.com");
  });

  it("prefers a real external_url over bio_links", () => {
    const result = parseProfileResponse(
      profileRaw({
        external_url: "https://primary.com",
        bio_links: [{ url: "https://secondary.com" }],
      }),
    );
    expect(result.externalUrl).toBe("https://primary.com");
  });

  it("falls through bio_links lynx_url and external_url_linkshimmed in order", () => {
    // No external_url, bio_links has only lynx_url, plus a linkshimmed URL.
    // Order: external_url → bio url → external_url_linkshimmed → bio lynx_url.
    const result = parseProfileResponse(
      profileRaw({
        external_url: "",
        external_url_linkshimmed: "https://l.instagram.com/shim",
        bio_links: [{ lynx_url: "https://lynx.example/x" }],
      }),
    );
    // bio url is empty, so linkshimmed wins before the lynx fallback.
    expect(result.externalUrl).toBe("https://l.instagram.com/shim");
  });
});
