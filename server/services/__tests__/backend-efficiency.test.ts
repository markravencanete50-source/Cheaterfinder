import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
vi.mock("../../db.js", () => ({ db: { execute: vi.fn(async () => ({ rows: [] })) } }));
import { shouldReadLikeCandidate, isCapacityUnavailable } from "../scan-efficiency.js";
import { withScrapeOperation, consumeScrapeAttempt, currentScrapeOperation, ScrapeAttemptBudgetError } from "../scrape-operation.js";
import { OperationBusyError, withOperationLease } from "../operation-lease.js";
import { operationSignal } from "../operation-context.js";
import { feedTransportKey, markHttpFeedWalled, shouldSkipWalledHttp } from "../feed-transport-policy.js";
import { chooseCurrentSubscription } from "../stripe-webhook-safety.js";
import { createMobileSession, rotateMobileSession, refreshDigest } from "../mobile-session-store.js";

describe("new evidence, unchanged freshness", () => {
  it("skips known positives but still reads a fresh unchecked post", () => {
    const known = new Set(["positive"]), checked = new Set(["seen-media"]);
    expect(shouldReadLikeCandidate({ shortcode: "positive", mediaId: "old" }, known, checked)).toBe(false);
    expect(shouldReadLikeCandidate({ shortcode: "new", mediaId: "seen-media" }, known, checked)).toBe(false);
    expect(shouldReadLikeCandidate({ shortcode: "new", mediaId: "fresh-media" }, known, checked)).toBe(true);
  });
  it("distinguishes exhausted capacity from an empty/absent owner", () => {
    expect(isCapacityUnavailable("no available bot in the pool")).toBe(true);
    expect(isCapacityUnavailable("hit daily cap for posts")).toBe(true);
    expect(isCapacityUnavailable("shared scrape attempt budget exhausted")).toBe(true);
    expect(isCapacityUnavailable("rate limited: auth rejected (status 401)")).toBe(true);
    expect(isCapacityUnavailable("Instagram throttled this read")).toBe(true);
    expect(isCapacityUnavailable("profile not found")).toBe(false);
  });
  it("only skips the proven HTTP lane, keyed by session and endpoint", () => {
    const key = feedTransportKey("bot", "session", "/feed");
    markHttpFeedWalled(key, 1000);
    expect(shouldSkipWalledHttp(key, 2000)).toBe(true);
    expect(shouldSkipWalledHttp(feedTransportKey("bot", "new-session", "/feed"), 2000)).toBe(false);
    expect(shouldSkipWalledHttp(key, 1000 + 6 * 3600_000)).toBe(false);
  });
});

describe("one retry budget across nested wrappers", () => {
  it("nested callers share seven attempts, separate operations start fresh", async () => {
    await withScrapeOperation(async () => {
      const id = currentScrapeOperation()!.id;
      for (let i = 0; i < 7; i++) await withScrapeOperation(async () => {
        expect(currentScrapeOperation()!.id).toBe(id);
        consumeScrapeAttempt();
      });
      expect(() => consumeScrapeAttempt()).toThrow(ScrapeAttemptBudgetError);
    });
    await withScrapeOperation(async () => expect(currentScrapeOperation()!.attempts).toBe(0));
  });
});

describe("cross-process execution ownership", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("does not execute busy work or consume remote budget", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const work = vi.fn();
    await expect(withOperationLease("bot:x", work, { execute } as never)).rejects.toThrow(OperationBusyError);
    expect(work).not.toHaveBeenCalled();
  });
  it("releases after success and failure, propagating the ownership signal", async () => {
    const execute = vi.fn(async () => ({ rows: [{ token: "owned" }] }));
    await expect(withOperationLease("bot:x", async signal => {
      expect(operationSignal()).toBe(signal);
      throw new Error("fetch failed");
    }, { execute } as never)).rejects.toThrow("fetch failed");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(operationSignal()).toBeUndefined();
  });
  it("aborts when lease renewal loses ownership", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [{ token: "owned" }] }).mockResolvedValue({ rows: [] });
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const work = withOperationLease("bot:x", async signal => {
      acquired();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }, { execute } as never);
    const rejected = expect(work).rejects.toThrow("execution lease lost");
    await ready;
    await vi.advanceTimersByTimeAsync(40_000);
    await rejected;
  });
});

describe("mobile refresh and subscription replay safety", () => {
  it("stores a digest, not the usable refresh credential", async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: "session" }] }));
    expect(await createMobileSession("session", "user", "secret-jti", new Date(), { execute } as never)).toBe(true);
    expect(refreshDigest("secret-jti")).not.toContain("secret-jti");
  });
  it("revokes the family after a failed refresh compare-and-swap", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    expect(await rotateMobileSession("session", "user", "old", "new", new Date(), { execute } as never)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("an old cancellation cannot replace an active subscription", () => {
    const active = { id: "new", status: "active", created: 200 };
    const canceled = { id: "old", status: "canceled", created: 100 };
    expect(chooseCurrentSubscription([canceled, active] as never)).toBe(active);
    expect(chooseCurrentSubscription([])).toBeNull();
  });
});
