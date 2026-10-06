// Unit tests for the roster walk knobs added in the 2026-09-02 audit (lane C):
//   C8 — ROSTER_FORCE_FULL_TTL_MS default 6 h → 24 h for SETTLED rosters only.
//   C9 — ROSTER_HEAD_PAGES (default 3, 0 disables) for deferred large rosters.
//
// The policy is pure; the DB module is mocked only because diff-completeness
// also exports DB-backed helpers.

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => [] }),
        }),
      }),
    }),
  },
}));

const {
  resolveForceFullTtlMs,
  forceFullTtlFor,
  shouldEnumerateRoster,
  resolveHeadPages,
  FORCE_FULL_ENUM_TTL_DEFAULT_MS,
  FORCE_FULL_ENUM_TTL_MIN_MS,
  SEEDING_FORCE_FULL_ENUM_TTL_MS,
  ROSTER_HEAD_PAGES_DEFAULT,
  ROSTER_HEAD_PAGES_MAX,
} = await import("../services/diff-completeness.js");

const HOUR_MS = 60 * 60 * 1000;

describe("C8: force-full valve TTL", () => {
  it("defaults to 24 h when the env is unset or blank", () => {
    expect(FORCE_FULL_ENUM_TTL_DEFAULT_MS).toBe(24 * HOUR_MS);
    expect(resolveForceFullTtlMs(undefined)).toBe(24 * HOUR_MS);
    expect(resolveForceFullTtlMs("   ")).toBe(24 * HOUR_MS);
  });

  it("honours ROSTER_FORCE_FULL_TTL_MS", () => {
    expect(resolveForceFullTtlMs(String(6 * HOUR_MS))).toBe(6 * HOUR_MS);
    expect(resolveForceFullTtlMs(String(48 * HOUR_MS))).toBe(48 * HOUR_MS);
  });

  it("clamps absurdly short values to the 30-minute floor and rejects garbage", () => {
    expect(resolveForceFullTtlMs("1000")).toBe(FORCE_FULL_ENUM_TTL_MIN_MS);
    expect(resolveForceFullTtlMs("0")).toBe(24 * HOUR_MS);
    expect(resolveForceFullTtlMs("-5")).toBe(24 * HOUR_MS);
    expect(resolveForceFullTtlMs("soon")).toBe(24 * HOUR_MS);
  });

  it("a settled roster gets the settled TTL; a seeding roster keeps the historical 6 h", () => {
    expect(forceFullTtlFor(true)).toBe(24 * HOUR_MS);
    expect(forceFullTtlFor(false)).toBe(SEEDING_FORCE_FULL_ENUM_TTL_MS);
    expect(SEEDING_FORCE_FULL_ENUM_TTL_MS).toBe(6 * HOUR_MS);
  });

  it("an operator asking for something shorter than 6 h speeds up seeding rosters too", () => {
    expect(forceFullTtlFor(false, 2 * HOUR_MS)).toBe(2 * HOUR_MS);
    expect(forceFullTtlFor(true, 2 * HOUR_MS)).toBe(2 * HOUR_MS);
  });

  it("an unchanged, complete roster last walked 7 h ago is left alone once settled", () => {
    // tracked_user_4 following on 2026-09-02: counts unchanged, roster held
    // in full, yet the 6 h valve forced a 44-page walk.
    const base = {
      currentCount: 1_127,
      prevCount: 1_127,
      liveRosterTotal: 1_127,
      lastCaptureAtMs: 0,
      nowMs: 7 * HOUR_MS,
    };
    expect(
      shouldEnumerateRoster({ ...base, forceFullTtlMs: forceFullTtlFor(true) }),
    ).toEqual({ fetch: false, reason: "unchanged" });
    expect(
      shouldEnumerateRoster({ ...base, forceFullTtlMs: forceFullTtlFor(false) }),
    ).toEqual({ fetch: true, reason: "force-full-valve" });
    expect(
      shouldEnumerateRoster({
        ...base,
        nowMs: 25 * HOUR_MS,
        forceFullTtlMs: forceFullTtlFor(true),
      }),
    ).toEqual({ fetch: true, reason: "force-full-valve" });
  });
});

describe("C9: ROSTER_HEAD_PAGES", () => {
  it("defaults to 3 pages", () => {
    expect(ROSTER_HEAD_PAGES_DEFAULT).toBe(3);
    expect(resolveHeadPages(undefined)).toBe(3);
    expect(resolveHeadPages("")).toBe(3);
    expect(resolveHeadPages("three")).toBe(3);
  });

  it("0 disables the head-walk and negatives collapse to 0", () => {
    expect(resolveHeadPages("0")).toBe(0);
    expect(resolveHeadPages("-2")).toBe(0);
  });

  it("accepts small integers and clamps large ones", () => {
    expect(resolveHeadPages("5")).toBe(5);
    expect(resolveHeadPages("2.9")).toBe(2);
    expect(resolveHeadPages("999")).toBe(ROSTER_HEAD_PAGES_MAX);
  });
});
