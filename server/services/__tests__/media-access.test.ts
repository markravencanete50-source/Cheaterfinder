import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signMediaUrl, verifyMediaSignature } from "../media-access.js";

const secret = "isolated-media-signature-test-secret";
const cacheKey = "a1".repeat(32);
const scope = { userId: "user-one", trackedAccountId: "track-one" };

function signedUrl(overrides: Partial<typeof scope> = {}) {
  return new URL(signMediaUrl(cacheKey, { ...scope, ...overrides }), "https://app.invalid");
}

function signature(overrides: Partial<typeof scope> = {}) {
  return signedUrl(overrides).searchParams.get("sig")!;
}

beforeEach(() => vi.stubEnv("SESSION_SECRET", secret));
afterEach(() => vi.unstubAllEnvs());

describe("customer-bound cached media URLs", () => {
  it("keeps the frontend-compatible media path and binds the original account", () => {
    const url = signedUrl();
    expect(url.pathname).toBe(`/api/media/${cacheKey}`);
    expect(url.searchParams.get("trackedAccountId")).toBe(scope.trackedAccountId);
    expect(url.searchParams.has("userId")).toBe(false);
    expect(verifyMediaSignature(cacheKey, scope.userId, scope.trackedAccountId, url.searchParams.get("sig"))).toBe(true);
  });

  it("rejects another paid customer's replay of a leaked URL", () => {
    expect(verifyMediaSignature(cacheKey, "user-two", scope.trackedAccountId, signature())).toBe(false);
  });

  it("rejects changing the account or asset on a valid URL", () => {
    const sig = signature();
    expect(verifyMediaSignature(cacheKey, scope.userId, "track-two", sig)).toBe(false);
    expect(verifyMediaSignature("b2".repeat(32), scope.userId, scope.trackedAccountId, sig)).toBe(false);
  });

  it("allows the same shared cache file to have independent authorized twin URLs", () => {
    const first = signedUrl();
    const second = signedUrl({ userId: "user-two", trackedAccountId: "track-two" });
    expect(second.pathname).toBe(first.pathname);
    expect(second.search).not.toBe(first.search);
    expect(verifyMediaSignature(cacheKey, "user-two", "track-two", second.searchParams.get("sig"))).toBe(true);
    expect(verifyMediaSignature(cacheKey, "user-two", "track-two", first.searchParams.get("sig"))).toBe(false);
  });

  it("separates account contexts when one customer sees the same asset in several reports", () => {
    const sig = signature();
    const other = signature({ trackedAccountId: "report-other-target" });
    expect(other).not.toBe(sig);
    expect(verifyMediaSignature(cacheKey, scope.userId, "report-other-target", other)).toBe(true);
  });

  it("has unambiguous identifier boundaries", () => {
    expect(signature({ userId: "a-b", trackedAccountId: "c" }))
      .not.toBe(signature({ userId: "a", trackedAccountId: "b-c" }));
  });

  it("rejects a tampered signature of the correct length", () => {
    const sig = signature();
    const tampered = `${sig[0] === "a" ? "b" : "a"}${sig.slice(1)}`;
    expect(verifyMediaSignature(cacheKey, scope.userId, scope.trackedAccountId, tampered)).toBe(false);
  });

  it("does not accept the same payload signed directly with the session secret", () => {
    const unseparated = createHmac("sha256", secret)
      .update(JSON.stringify([cacheKey, scope.userId, scope.trackedAccountId]))
      .digest("hex");
    expect(verifyMediaSignature(cacheKey, scope.userId, scope.trackedAccountId, unseparated)).toBe(false);
  });

  it("invalidates old URLs when the signing secret rotates", () => {
    const old = signature();
    vi.stubEnv("SESSION_SECRET", "replacement-isolated-media-secret");
    expect(verifyMediaSignature(cacheKey, scope.userId, scope.trackedAccountId, old)).toBe(false);
    expect(verifyMediaSignature(cacheKey, scope.userId, scope.trackedAccountId, signature())).toBe(true);
  });

  it("keeps the signature valid for an open gallery while leaving live authorization to the route", () => {
    const sig = signature();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
      expect(verifyMediaSignature(cacheKey, scope.userId, scope.trackedAccountId, sig)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, "", "   "])("fails closed when SESSION_SECRET is %j", (value) => {
    const sig = signature();
    vi.stubEnv("SESSION_SECRET", value);
    expect(() => signMediaUrl(cacheKey, scope)).toThrow("SESSION_SECRET is required for media access");
    expect(verifyMediaSignature(cacheKey, scope.userId, scope.trackedAccountId, sig)).toBe(false);
  });

  it.each([undefined, null, "", "g".repeat(64), "a".repeat(63), "a".repeat(65), "A".repeat(64), "a".repeat(64) + "\n", ["a".repeat(64)], { sig: "a".repeat(64) }])(
    "rejects malformed or duplicated signature input %j",
    (value) => expect(verifyMediaSignature(cacheKey, scope.userId, scope.trackedAccountId, value)).toBe(false),
  );

  it.each([undefined, null, "", "../track", "track?sig=x", "a\u0000b", "a b", "track-one\n", "x".repeat(129), ["track-one"], { id: "track-one" }])(
    "rejects malformed or duplicated identifier input %j",
    (value) => {
      const sig = signature();
      expect(verifyMediaSignature(cacheKey, value, scope.trackedAccountId, sig)).toBe(false);
      expect(verifyMediaSignature(cacheKey, scope.userId, value, sig)).toBe(false);
      expect(() => signMediaUrl(cacheKey, { ...scope, trackedAccountId: value as string })).toThrow("Invalid media access scope");
    },
  );

  it.each([undefined, null, "", "../asset", "a".repeat(63), "a".repeat(65), "A".repeat(64), cacheKey + "\n", [cacheKey]])(
    "rejects malformed cache key input %j",
    (value) => {
      expect(verifyMediaSignature(value, scope.userId, scope.trackedAccountId, signature())).toBe(false);
      expect(() => signMediaUrl(value as string, scope)).toThrow("Invalid media access scope");
    },
  );
});
