import { describe, it, expect, vi } from "vitest";

// The module under test imports server/db.ts transitively; stub the connection
// string so importing it does not require a live database. Matches the pattern
// used by bot-cooldown.test.ts / bot-warmer.test.ts.
vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
// The signing key is derived from SESSION_SECRET at call time, so it must be
// set before the first sign/verify call.
vi.stubEnv("SESSION_SECRET", "test-secret-for-mobile-auth");

const { __testing } = await import("../mobile-auth.js");
const { signToken, verifyToken, passwordVersion, ACCESS_TTL_SEC, REFRESH_TTL_SEC } =
  __testing;

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-123",
    typ: "access" as const,
    pv: passwordVersion("$2a$12$abcdefghijklmnopqrstuv"),
    iat: now,
    exp: now + ACCESS_TTL_SEC,
    jti: "abc123",
    ...overrides,
  };
}

describe("mobile-auth token signing", () => {
  it("round-trips a valid token", () => {
    const c = claims();
    const decoded = verifyToken(signToken(c as never));
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe("user-123");
    expect(decoded!.typ).toBe("access");
  });

  it("rejects a tampered payload", () => {
    const token = signToken(claims() as never);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify(claims({ sub: "attacker" })),
    ).toString("base64url");
    expect(verifyToken(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const [header, payload] = signToken(claims() as never).split(".");
    expect(verifyToken(`${header}.${payload}.deadbeef`)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyToken("not-a-jwt")).toBeNull();
    expect(verifyToken("a.b")).toBeNull();
    expect(verifyToken("")).toBeNull();
    expect(verifyToken(signToken(null as never))).toBeNull();
    expect(verifyToken(signToken([] as never))).toBeNull();
  });

  it("rejects an expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = signToken(claims({ iat: now - 7200, exp: now - 60 }) as never);
    expect(verifyToken(expired)).toBeNull();
  });

  it("rejects an unknown token type", () => {
    expect(verifyToken(signToken(claims({ typ: "magic" }) as never))).toBeNull();
  });

  it("issues refresh tokens with a longer lifetime than access tokens", () => {
    expect(REFRESH_TTL_SEC).toBeGreaterThan(ACCESS_TTL_SEC);
  });
});

describe("password fingerprint", () => {
  it("changes when the password hash changes", () => {
    const before = passwordVersion("$2a$12$one");
    const after = passwordVersion("$2a$12$two");
    expect(before).not.toBe(after);
  });

  it("is stable for the same hash", () => {
    expect(passwordVersion("$2a$12$same")).toBe(passwordVersion("$2a$12$same"));
  });

  it("handles a null hash without throwing", () => {
    expect(passwordVersion(null)).toHaveLength(16);
  });

  it("invalidates a token minted before a password change", () => {
    const token = signToken(claims({ pv: passwordVersion("$2a$12$old") }) as never);
    const decoded = verifyToken(token);
    // Signature is still valid — revocation happens in resolveUser, which
    // compares the claim against the *current* hash.
    expect(decoded).not.toBeNull();
    expect(decoded!.pv).not.toBe(passwordVersion("$2a$12$new"));
  });
});
