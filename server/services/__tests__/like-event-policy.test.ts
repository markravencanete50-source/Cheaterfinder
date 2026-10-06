import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { isLikedPostAfterTrackingStart } from "../like-event-policy.js";

const trackingStarted = new Date("2026-07-20T12:00:00.000Z");

describe("liked-post boundary — post_date mode (original, opt-in)", () => {
  beforeEach(() => {
    process.env.LIKE_EVENT_WINDOW = "post_date";
  });
  afterEach(() => {
    delete process.env.LIKE_EVENT_WINDOW;
  });

  it("shows only posts published strictly after tracking started", () => {
    expect(
      isLikedPostAfterTrackingStart(
        new Date("2026-07-20T12:00:01.000Z"),
        trackingStarted,
      ),
    ).toBe(true);
    expect(
      isLikedPostAfterTrackingStart(
        new Date("2026-07-20T11:59:59.000Z"),
        trackingStarted,
      ),
    ).toBe(false);
  });

  it("does not treat an equal or missing publication date as new", () => {
    expect(isLikedPostAfterTrackingStart(trackingStarted, trackingStarted)).toBe(
      false,
    );
    expect(isLikedPostAfterTrackingStart(null, trackingStarted)).toBe(false);
  });
});

describe("liked-post boundary — observed mode (default)", () => {
  afterEach(() => {
    delete process.env.LIKE_EVENT_WINDOW;
  });

  it("REPORTS a like seen now on a post published before tracking began", () => {
    // The regression this mode exists to fix: accounts added recently could
    // never surface a like, because almost nothing they like was published
    // inside their short window.
    expect(
      isLikedPostAfterTrackingStart(
        new Date("2026-01-01T00:00:00.000Z"),
        trackingStarted,
      ),
    ).toBe(true);
  });

  it("still hides likes OBSERVED before tracking began (no history dump)", () => {
    expect(
      isLikedPostAfterTrackingStart(
        new Date("2026-01-01T00:00:00.000Z"),
        trackingStarted,
        new Date("2026-06-30T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("reports a like observed after tracking began, whatever the post age", () => {
    expect(
      isLikedPostAfterTrackingStart(
        new Date("2024-09-08T00:00:00.000Z"),
        trackingStarted,
        new Date("2026-08-31T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("does not depend on the post date being present", () => {
    expect(isLikedPostAfterTrackingStart(null, trackingStarted)).toBe(true);
  });
});
