import { describe, expect, it, vi } from "vitest";

vi.mock("../media-cache.js", () => ({
  cacheMediaUrl: vi.fn(), mediaCacheKey: vi.fn(), readCachedMediaAsset: vi.fn(),
}));

import { __testing } from "../report-pdf.js";

describe("report period comparison", () => {
  it.each([[null, 8], [8, null], [null, null]] as const)(
    "omits comparison when either observation is missing (%s, %s)", (current, previous) => {
      expect(__testing.deltaChip(current, previous)).toBe("");
    },
  );
  it("keeps a measured zero distinct from missing data", () => {
    expect(__testing.deltaChip(0, 8)).toContain("8 vs last");
    expect(__testing.deltaChip(0, 0)).toContain("no change");
    expect(__testing.deltaChip(8, 0)).toContain("8 vs last");
  });
});
