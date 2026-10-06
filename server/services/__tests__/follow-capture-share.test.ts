import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildShareKey,
  withSharedFollowCapture,
  resetFollowCaptureShare,
  followCaptureShareSize,
} from "../follow-capture-share.js";

describe("shared follow captures (multi-customer de-duplication)", () => {
  beforeEach(() => {
    resetFollowCaptureShare();
    process.env.FOLLOW_CAPTURE_SHARE_TTL_MS = "900000";
  });
  afterEach(() => {
    delete process.env.FOLLOW_CAPTURE_SHARE_TTL_MS;
    resetFollowCaptureShare();
  });

  it("fetches once when two customers track the same account", async () => {
    const fetch = vi.fn(async () => ({ ok: true, data: ["a", "b"] }));
    const key = buildShareKey("follower", "123", null);
    const [first, second] = await Promise.all([
      withSharedFollowCapture(key, "l", fetch),
      withSharedFollowCapture(key, "l", fetch),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("does NOT share across different accounts", async () => {
    const fetch = vi.fn(async () => ({ ok: true }));
    await withSharedFollowCapture(buildShareKey("follower", "111", null), "l", fetch);
    await withSharedFollowCapture(buildShareKey("follower", "222", null), "l", fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT share across dimensions for the same account", async () => {
    const fetch = vi.fn(async () => ({ ok: true }));
    await withSharedFollowCapture(buildShareKey("follower", "123", null), "l", fetch);
    await withSharedFollowCapture(buildShareKey("following", "123", null), "l", fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT share when the resume cursors differ — the slices are different", async () => {
    const fetch = vi.fn(async () => ({ ok: true }));
    await withSharedFollowCapture(buildShareKey("follower", "123", null), "l", fetch);
    await withSharedFollowCapture(buildShareKey("follower", "123", "CURSOR_X"), "l", fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares when both callers resume from the same cursor", async () => {
    const fetch = vi.fn(async () => ({ ok: true }));
    const key = buildShareKey("follower", "123", "CURSOR_X");
    await withSharedFollowCapture(key, "l", fetch);
    await withSharedFollowCapture(key, "l", fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not serve a failed capture to the next caller", async () => {
    const failing = vi.fn(async () => { throw new Error("boom"); });
    const key = buildShareKey("follower", "123", null);
    await expect(withSharedFollowCapture(key, "l", failing)).rejects.toThrow("boom");
    const ok = vi.fn(async () => ({ ok: true }));
    await expect(withSharedFollowCapture(key, "l", ok)).resolves.toEqual({ ok: true });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("TTL=0 disables sharing entirely", async () => {
    process.env.FOLLOW_CAPTURE_SHARE_TTL_MS = "0";
    const fetch = vi.fn(async () => ({ ok: true }));
    const key = buildShareKey("follower", "123", null);
    await withSharedFollowCapture(key, "l", fetch);
    await withSharedFollowCapture(key, "l", fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache a resolved provider failure as a successful capture", async () => {
    const key = buildShareKey("follower", "123", null);
    await withSharedFollowCapture(key, "l", async () => ({ ok: false, error: "no capacity" }));
    const retry = vi.fn(async () => ({ ok: true, data: [] }));
    expect(await withSharedFollowCapture(key, "l", retry)).toEqual({ ok: true, data: [] });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("bounds memory so large captures cannot accumulate", async () => {
    process.env.FOLLOW_CAPTURE_SHARE_MAX_ENTRIES = "3";
    const fetch = vi.fn(async () => ({ ok: true }));
    for (let i = 0; i < 10; i++) {
      await withSharedFollowCapture(buildShareKey("follower", `u${i}`, null), "l", fetch);
    }
    expect(followCaptureShareSize()).toBeLessThanOrEqual(4);
    delete process.env.FOLLOW_CAPTURE_SHARE_MAX_ENTRIES;
  });
});
