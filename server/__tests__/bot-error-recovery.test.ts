// Unit tests for withBotErrorHandling — verifies that session-invalidating
// IG errors (CSRF rejected, checkpoint_required, challenge_required,
// login_required, auth-rejected bodies) all trigger invalidateBotSession
// so the next ensureBotReady() call drives a fresh Playwright login.
//
// All external I/O is mocked. No real DB, no real network.

import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// Stub env so db.ts (transitively required by bot-collectors) does not throw
// ---------------------------------------------------------------------------

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

// ---------------------------------------------------------------------------
// Mock: ../db.js — bot-collectors imports `db` and calls `db.update(...)` on
// the cooldown branch. We stub the chained API surface that the code uses.
// ---------------------------------------------------------------------------

vi.mock("../db.js", () => {
  const updateMock = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        catch: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  }));
  return {
    db: {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      update: updateMock,
      insert: vi.fn(),
      select: vi.fn(),
      transaction: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: shared/schema.js — collectors import several drizzle table objects
// ---------------------------------------------------------------------------

vi.mock("../../shared/schema.js", () => ({
  likeEvents: {},
  followEvents: {},
  unfollowEvents: {},
  botAccounts: {},
  botFollowRequests: {},
}));

// ---------------------------------------------------------------------------
// Mock: drizzle-orm — eq/and used by collectors module-load-time imports
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  and: vi.fn((..._args: unknown[]) => true),
  eq: vi.fn((..._args: unknown[]) => true),
  // The cooldown helper now preserves longer existing cooldowns in SQL.
  or: vi.fn((..._args: unknown[]) => true),
  isNull: vi.fn((..._args: unknown[]) => true),
  lt: vi.fn((..._args: unknown[]) => true),
  sql: vi.fn((..._args: unknown[]) => true),
}));

// ---------------------------------------------------------------------------
// Mock: bot-runtime — invalidateBotSession is the spy we want to assert on
// ---------------------------------------------------------------------------

const { invalidateBotSessionMock } = vi.hoisted(() => ({
  invalidateBotSessionMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/bot-runtime.js", () => ({
  invalidateBotSession: invalidateBotSessionMock,
}));

// ---------------------------------------------------------------------------
// Mock: incidental dependencies pulled in by bot-collectors so the file can
// finish module-load. None of these are exercised by withBotErrorHandling.
// ---------------------------------------------------------------------------

vi.mock("../bot-manager.js", () => ({
  markFollowRequestAccepted: vi.fn(),
  markFollowRequestFailed: vi.fn(),
  markFollowRequestSent: vi.fn(),
  ensureBotFingerprint: vi.fn(),
}));

vi.mock("../crypto/session-envelope.js", () => ({
  decryptSessionData: (v: string) => v,
}));

vi.mock("../behavior/pacing.js", () => ({
  humanDelay: vi.fn().mockResolvedValue(undefined),
  isAwake: vi.fn(() => true),
  msUntilAwake: vi.fn(() => 0),
  reserveGlobalFollow: vi.fn(() => true),
}));

vi.mock("../behavior/caps.js", () => ({
  reserveDailyBudget: vi.fn().mockResolvedValue(undefined),
  effectiveFollowCap: vi.fn(() => 5),
  isInWarmup: vi.fn(() => false),
  IGDailyCapExceededError: class extends Error {
    resetAt = new Date();
  },
  nextMidnightUtc: vi.fn(() => new Date()),
}));

vi.mock("../behavior/decoration.js", () => ({
  decorateBeforeFollow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../behavior/device-fingerprint.js", () => ({
  resolveFingerprint: vi.fn(() => ({
    deviceId: "x",
    userAgent: "x",
    appId: "x",
    timezone: "UTC",
    locale: "en-US",
    awakeHourStart: 9,
    awakeHourEnd: 23,
  })),
}));

vi.mock("../ig-playwright-client.js", () => ({
  playwrightSendFollowByUsername: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  IGAuthExpiredError,
  IGHttpError,
  IGRateLimitedError,
} from "../ig-http-client.js";
import { withBotErrorHandling } from "../bot-collectors.js";

const invalidateSpy = invalidateBotSessionMock as unknown as MockInstance;

describe("withBotErrorHandling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through successful results unchanged", async () => {
    const result = await withBotErrorHandling("bot-1", "alice", async () => "ok");
    expect(result).toBe("ok");
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates session on IGAuthExpiredError (401/403)", async () => {
    const err = new IGAuthExpiredError("auth rejected", { status: 403 });
    await expect(
      withBotErrorHandling("bot-1", "alice", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect(invalidateSpy).toHaveBeenCalledWith("bot-1");
  });

  it("invalidates session on IGHttpError with checkpoint_required (HTTP 400)", async () => {
    const err = new IGHttpError(400, "checkpoint_required", {
      url: "https://www.instagram.com/api/v1/users/web_profile_info/",
      method: "GET",
      body: '{"message":"checkpoint_required","status":"fail"}',
      igErrorCode: "checkpoint_required",
    });
    await expect(
      withBotErrorHandling("bot-2", "bob", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect(invalidateSpy).toHaveBeenCalledWith("bot-2");
  });

  it("invalidates session on IGHttpError with challenge_required", async () => {
    const err = new IGHttpError(400, "challenge_required", {
      body: '{"message":"challenge_required"}',
      igErrorCode: "challenge_required",
    });
    await expect(
      withBotErrorHandling("bot-3", "carol", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(invalidateSpy).toHaveBeenCalledWith("bot-3");
  });

  it("invalidates session on IGHttpError with login_required", async () => {
    const err = new IGHttpError(400, "login_required", {
      body: '{"message":"login_required"}',
      igErrorCode: "login_required",
    });
    await expect(
      withBotErrorHandling("bot-4", "dave", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(invalidateSpy).toHaveBeenCalledWith("bot-4");
  });

  it("invalidates session on CSRF body fragment even without igErrorCode", async () => {
    // Edge case: an HTTP 400 / 500 surface where IG returns the CSRF
    // payload but no recognised igErrorCode. Body sniffing catches it.
    const err = new IGHttpError(400, "non-2xx", {
      body: '{"message":"CSRF token missing or incorrect","status":"fail"}',
    });
    await expect(
      withBotErrorHandling("bot-5", "eve", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(invalidateSpy).toHaveBeenCalledWith("bot-5");
  });

  it("invalidates session on auth_rejected body", async () => {
    const err = new IGHttpError(403, "auth_rejected", {
      body: '{"message":"auth_rejected","status":"fail"}',
    });
    await expect(
      withBotErrorHandling("bot-6", "frank", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(invalidateSpy).toHaveBeenCalledWith("bot-6");
  });

  it("does NOT invalidate session on IGRateLimitedError", async () => {
    const err = new IGRateLimitedError(60_000, "rate limited");
    await expect(
      withBotErrorHandling("bot-7", "grace", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does NOT invalidate session on a non-recognised IGHttpError", async () => {
    // 500 server error with no recognised code and no CSRF body — should
    // pass through untouched (collector layer decides whether to retry).
    const err = new IGHttpError(500, "internal", { body: "<html>oops</html>" });
    await expect(
      withBotErrorHandling("bot-8", "heidi", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does NOT invalidate session on a generic Error", async () => {
    const err = new Error("network glitch");
    await expect(
      withBotErrorHandling("bot-9", "ivan", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
