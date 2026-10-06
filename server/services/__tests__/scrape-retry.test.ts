// Regression tests for withScrapeRetry rate-limit handling (A11).
//
// Load-bearing invariant: a 429 / IGRateLimitedError thrown by the scrape fn
// must bubble IMMEDIATELY with NO sleep. isPermanentPerBot classifies rate
// limits as permanent-per-bot so the rotation layer (runBot in
// public-data-service) handles them via bot rotation + cooldown — NOT via an
// in-place sleep in this loop. A dead "429 → sleep retryAfterMs, retry once"
// branch used to live here; these tests pin the fast-throw so nobody can
// re-introduce a sleep without a failing test.
//
// Fake timers prove no sleep fires: if withScrapeRetry awaited setTimeout, the
// promise would never settle while timers are frozen and the await would hang.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Lightweight stubs for the error/boundary modules so the test does not pull in
// db.js / undici / proxy-provider. withScrapeRetry imports these exact classes,
// so `instanceof` inside isPermanentPerBot resolves against the same stubs.
vi.mock("../endpoint-strikes.js", () => ({
  EndpointDisabledError: class EndpointDisabledError extends Error {},
}));

vi.mock("../../ig-http-client.js", () => ({
  IGAuthExpiredError: class IGAuthExpiredError extends Error {},
  IGHttpError: class IGHttpError extends Error {
    status = 0;
    igErrorCode?: string;
    body?: string;
  },
  IGRateLimitedError: class IGRateLimitedError extends Error {
    readonly retryAfterMs: number;
    constructor(retryAfterMs: number, message = "Instagram rate limited (429)") {
      super(message);
      this.name = "IGRateLimitedError";
      this.retryAfterMs = retryAfterMs;
    }
  },
}));

import { withScrapeRetry } from "../scrape-retry.js";
import { IGRateLimitedError } from "../../ig-http-client.js";

describe("withScrapeRetry — rate-limit fast-throw (A11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("throws IGRateLimitedError immediately with no sleep (timer untouched)", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const rateLimited = new IGRateLimitedError(5_000);
    const fn = vi.fn(async () => {
      throw rateLimited;
    });

    // No timer advancement: if a sleep were awaited, this would never resolve.
    await expect(withScrapeRetry("test", fn)).rejects.toBe(rateLimited);

    // The scrape fn ran exactly once — no in-place retry.
    expect(fn).toHaveBeenCalledTimes(1);
    // And no backoff/sleep timer was ever scheduled.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("throws on a generic 'rate limited' message immediately with no sleep", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const err = new Error("request was rate limited by upstream");
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(withScrapeRetry("test", fn)).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("rotates a list-restricted bot immediately with no in-place retry", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const err = new Error(
      "following list restricted by Instagram (special_empty_state)",
    );
    err.name = "IGListRestrictedError";
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(withScrapeRetry("following:test", fn)).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("rotates immediately when this bot exhausted its daily endpoint budget", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const err = new Error(
      "[ig-public-scraper] [daily-budget] bot abc hit daily cap for likers (used=20, cap=20)",
    );
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(withScrapeRetry("likers:test", fn)).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("fails a provider-wide cooldown immediately with no pointless retry sleep", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const err = new Error(
      "[proxy-provider] provider health cooldown active until 2026-07-28T06:13:19.277Z; retry later",
    );
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(withScrapeRetry("profile:test", fn)).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("fails an empty bot pool immediately and lets the next scheduler tick retry", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const err = new Error(
      "[ig-public-scraper] no eligible bot is available",
    );
    const fn = vi.fn(async () => {
      throw err;
    });

    await expect(withScrapeRetry("profile:test", fn)).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("never retries a rate limit even with a large retryAfterMs", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    // retryAfterMs well above maxDelayMs — the dead branch would have clamped
    // and slept up to maxDelayMs (30s). We assert it does neither.
    const rateLimited = new IGRateLimitedError(120_000);
    const fn = vi.fn(async () => {
      throw rateLimited;
    });

    await expect(withScrapeRetry("test", fn, { maxAttempts: 5 })).rejects.toBe(
      rateLimited,
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("still returns the value on success without scheduling a timer", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fn = vi.fn(async () => "ok");

    await expect(withScrapeRetry("test", fn)).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

describe("withScrapeRetry — deterministic root causes are not retried (D2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("does not retry a wrapped failed SQL statement", async () => {
    const dbErr = new Error("Failed query: select \"id\" from bot_accounts ...");
    const wrapped = new Error("[ig-public-scraper] lease failed", { cause: dbErr });
    const fn = vi.fn().mockRejectedValue(wrapped);
    await expect(withScrapeRetry("test", fn)).rejects.toBe(wrapped);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("does not retry an open circuit breaker", async () => {
    const open = new Error("IG circuit breaker is OPEN for bot:followers");
    open.name = "IGCircuitOpenError";
    const fn = vi.fn().mockRejectedValue(new Error("wrapped", { cause: open }));
    await expect(withScrapeRetry("test", fn)).rejects.toBeInstanceOf(Error);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
