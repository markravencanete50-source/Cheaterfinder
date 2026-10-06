import { describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
vi.mock("../../db.js", () => ({ db: {} }));

import { __testing } from "../report-data.js";

describe("report interest derivation", () => {
  it("counts a readable caption topic once per liked post", () => {
    expect(
      __testing.captionInterests([
        { caption: "Tennis tennis tennis is life" },
        { caption: "A tennis weekend with friends" },
      ]),
    ).toContainEqual({ label: "Sports & fitness", count: 2 });
  });

  it("ignores handles, short noise, and common words", () => {
    const result = __testing.captionInterests([{ caption: "This is me with @someone — yuh!" }]);
    expect(result).toEqual([]);
  });

  it("uses readable post-format labels as the honest final fallback", () => {
    expect(__testing.formatInterestFallback("carousel")).toBe("Carousel posts");
    expect(__testing.formatInterestFallback("reel")).toBe("Reels");
  });
});
