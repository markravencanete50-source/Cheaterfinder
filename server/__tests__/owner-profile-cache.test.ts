import { describe, it, expect, vi } from "vitest";

// The module also exports a DB writer; the pure resolver under test must not
// drag a live Postgres connection or the pino transport into the test process.
vi.mock("../db.js", () => ({ db: { execute: async () => ({ rows: [] }) } }));
vi.mock("../observability/logger.js", () => ({
  logger: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
}));
import { resolveOwnerProfileFromCache } from "../services/owner-profile-cache.js";

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const HOUR = 3_600_000;
const TTL = 168 * HOUR;

describe("resolveOwnerProfileFromCache", () => {
  it("returns the cached verdict when fresh and complete (public owner)", () => {
    const v = resolveOwnerProfileFromCache(
      { igUserId: "123", ownerIsPrivate: false, ownerProfileCheckedAt: new Date(NOW - HOUR) },
      NOW,
      TTL,
    );
    expect(v).toEqual({ igUserId: "123", isPrivate: false });
  });

  it("returns a private verdict so the caller can skip the owner without any call", () => {
    const v = resolveOwnerProfileFromCache(
      { igUserId: "9", ownerIsPrivate: true, ownerProfileCheckedAt: new Date(NOW - 2 * HOUR).toISOString() },
      NOW,
      TTL,
    );
    expect(v).toEqual({ igUserId: "9", isPrivate: true });
  });

  it("misses when the verdict is older than the TTL", () => {
    const v = resolveOwnerProfileFromCache(
      { igUserId: "1", ownerIsPrivate: false, ownerProfileCheckedAt: new Date(NOW - TTL - 1) },
      NOW,
      TTL,
    );
    expect(v).toBeNull();
  });

  it("misses when ig_user_id is unknown — never guesses an id", () => {
    const v = resolveOwnerProfileFromCache(
      { igUserId: null, ownerIsPrivate: false, ownerProfileCheckedAt: new Date(NOW) },
      NOW,
      TTL,
    );
    expect(v).toBeNull();
  });

  it("misses when no verdict was ever recorded (roster-builder rows)", () => {
    expect(
      resolveOwnerProfileFromCache({ igUserId: "1", ownerIsPrivate: null, ownerProfileCheckedAt: null }, NOW, TTL),
    ).toBeNull();
  });

  it("misses on an unparseable timestamp (fail closed)", () => {
    expect(
      resolveOwnerProfileFromCache({ igUserId: "1", ownerIsPrivate: false, ownerProfileCheckedAt: "not-a-date" }, NOW, TTL),
    ).toBeNull();
  });

  it("TTL of 0 disables the cache entirely", () => {
    expect(
      resolveOwnerProfileFromCache({ igUserId: "1", ownerIsPrivate: false, ownerProfileCheckedAt: new Date(NOW) }, NOW, 0),
    ).toBeNull();
  });
});
