import { afterEach, describe, expect, it, vi } from "vitest";
import { rosterRequestPageSize, rosterViewerPinEnabled, withViewerAffinity } from "../viewer-affinity.js";

afterEach(() => vi.unstubAllEnvs());

describe("dimension-scoped roster reader canary", () => {
  it("only enables the tested target and dimension", () => {
    vi.stubEnv("ROSTER_PIN_VIEWER_TARGETS", " SampleAccount:following ");
    expect(rosterViewerPinEnabled("sample_account", "following")).toBe(true);
    expect(rosterViewerPinEnabled("sample_account", "follower")).toBe(false);
    expect(rosterViewerPinEnabled("other", "following")).toBe(false);
    expect(rosterViewerPinEnabled(undefined, "following")).toBe(false);
  });
  it("keeps explicit both-dimension targets compatible", () => {
    vi.stubEnv("ROSTER_PIN_VIEWER_TARGETS", "first:following, second");
    expect(rosterViewerPinEnabled("second", "following")).toBe(true);
    expect(rosterViewerPinEnabled("second", "follower")).toBe(true);
    expect(rosterViewerPinEnabled("first", "follower")).toBe(false);
  });
  it("does not implicitly enable unconfigured targets", () => {
    vi.stubEnv("ROSTER_PIN_VIEWER_TARGETS", "");
    expect(rosterViewerPinEnabled("sample_account", "following")).toBe(false);
  });
});

describe("explicit roster page-size experiment", () => {
  it("retains 50 for all ordinary collection", () => {
    expect(rosterRequestPageSize()).toBe(50);
  });
  it.each([100, 200])("accepts a bounded %s-member read only inside its context", async count => {
    expect(await withViewerAffinity({ pin: true, rosterPageSize: count }, async () => rosterRequestPageSize())).toBe(count);
    expect(rosterRequestPageSize()).toBe(50);
  });
  it.each([0, -1, 300, NaN, Infinity])("does not allow invalid or unbounded size %s", async count => {
    expect(await withViewerAffinity({ pin: true, rosterPageSize: count }, async () => rosterRequestPageSize())).toBe(50);
  });
});
