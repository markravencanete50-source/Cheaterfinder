import { describe, expect, it } from "vitest";
import { mediaImageCandidates, proxyUrl } from "../img-proxy";

describe("authorized media URL handling", () => {
  it.each([null, undefined, "", "   "])("treats %s as missing", value => {
    expect(proxyUrl(value)).toBe("");
  });
  it("keeps signed customer and admin URLs unchanged", () => {
    for (const value of ["/api/media/asset?trackedAccountId=account&sig=signature",
      "/api/admin/media/asset?sig=signature", "/api/img-proxy?url=https%3A%2F%2Fcdninstagram.com%2Fa.jpg"]) {
      expect(proxyUrl(value)).toBe(value);
    }
  });
  it("proxies permitted hosts with query strings intact", () => {
    const url = "https://scontent.cdninstagram.com/photo.jpg?sig=a%2Bb&expires=9";
    expect(proxyUrl(url)).toBe(`/api/img-proxy?url=${encodeURIComponent(url)}`);
    expect(proxyUrl("//scontent.fbcdn.net/a.jpg")).toBe(`/api/img-proxy?url=${encodeURIComponent("https://scontent.fbcdn.net/a.jpg")}`);
  });
  it("matches host boundaries, not URL text or deceptive domain suffixes", () => {
    const urls = ["https://example.invalid/cdninstagram.com/image", "https://cdninstagram.com.example.invalid/a", "https://example.invalid/?url=fbcdn.net"];
    urls.forEach(url => expect(proxyUrl(url)).toBe(url));
  });
  it.each(["javascript:alert(1)", "http://scontent.fbcdn.net/a.jpg", "https://user:password@cdninstagram.com/a.jpg"])("does not emit unsafe/proxy-rejected URL %s", url => {
    expect(proxyUrl(url)).toBe("");
  });
  it("empty display image cannot suppress a valid thumbnail", () => {
    expect(mediaImageCandidates("  ", "/api/media/thumbnail?sig=ok")).toEqual(["/api/media/thumbnail?sig=ok"]);
  });
  it("deduplicates already-proxied and raw versions of the same source", () => {
    const raw = "https://cdninstagram.com/a.jpg";
    expect(mediaImageCandidates(raw, proxyUrl(raw))).toEqual([proxyUrl(raw)]);
  });
  it("does not turn protected-media denial into an unprotected CDN read", () => {
    expect(mediaImageCandidates("/api/media/display?sig=ok", "https://cdninstagram.com/thumb.jpg"))
      .toEqual(["/api/media/display?sig=ok"]);
    expect(mediaImageCandidates("/api/admin/media/display", "/api/img-proxy?url=x"))
      .toEqual(["/api/admin/media/display"]);
  });
  it("allows distinct protected fallback assets to enforce their own access checks", () => {
    expect(mediaImageCandidates("/api/media/display?sig=a", "/api/media/thumb?sig=b"))
      .toEqual(["/api/media/display?sig=a", "/api/media/thumb?sig=b"]);
  });
  it("preserves the same fallback boundary for absolute app-media URLs", () => {
    expect(mediaImageCandidates("https://app.example.invalid/api/media/display?sig=a", "https://cdninstagram.com/thumb.jpg"))
      .toEqual(["https://app.example.invalid/api/media/display?sig=a"]);
  });
});
