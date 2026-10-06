// Wave 6: tests for the per-bot daily IG-call budget.
//
// Two layers:
//  1. Pure unit tests for the schedule + endpoint normalization. No DB.
//  2. Integration tests that exercise the atomic INSERT ... ON CONFLICT
//     ... WHERE count < $cap upsert against a real Postgres connection.
//     These require TEST_DATABASE_URL to be set; otherwise the suite is skipped
//     so CI without a DB still runs the unit layer.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, afterEach } from "vitest";

// These tests assert the RAW BUDGET_TABLE values, but endpointDailyCap() scales
// finite caps by DAILY_CAP_MULTIPLIER — an ops lever that dotenv loads from the
// process environment. Without pinning it, the whole schedule suite fails on
// any machine whose environment sets a multiplier != 1, which reads as a code
// regression when it is only config bleed. Pin it so the suite is hermetic.
//
// Never fall back to DATABASE_URL here: developers commonly point it at the
// live service. DB-backed cases are opt-in through TEST_DATABASE_URL only. The
// placeholder keeps the pure module import valid without opening a connection.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim();
vi.stubEnv(
  "DATABASE_URL",
  TEST_DATABASE_URL || "postgres://mock:mock@localhost/mock",
);
vi.stubEnv("DAILY_CAP_MULTIPLIER", "1");
// A pre-aged production pool must not turn the day-0/day-7 fixtures into
// day-14 bots. Test the canonical age table, not the operator's overrides.
vi.stubEnv("BOT_AGE_FLOOR_DAYS", "0");
vi.stubEnv("LIKERS_DAILY_CAP", "");
vi.stubEnv("BOT_READ_WARMUP_ENABLED", "true");

const {
  BUDGET_TABLE,
  READ_DAILY_CAPS,
  readWarmupEnabled,
  endpointDailyCap,
  normalizeEndpoint, importDayLikersCap } = await import("../daily-budget.js");

// ─── Unit: schedule lookup ──────────────────────────────────────────────────

describe("BUDGET_TABLE", () => {
  it("covers age days 0, 1, 2, 3-5, 6-13, 14+ tiers", () => {
    const minDays = BUDGET_TABLE.map((t) => t.minDay).sort((a, b) => a - b);
    expect(minDays).toEqual([0, 1, 2, 3, 6, 14]);
  });

  it("monotonically grows the profile cap with age", () => {
    const ageDays = [0, 1, 2, 3, 6, 14, 30];
    const caps = ageDays.map((d) =>
      endpointDailyCap(daysAgo(d), "profile"),
    );
    for (let i = 1; i < caps.length; i += 1) {
      expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]!);
    }
  });
});

describe("endpointDailyCap", () => {
  it("returns the day-0 caps for a freshly-created bot", () => {
    const created = daysAgo(0);
    expect(endpointDailyCap(created, "profile")).toBe(5);
    expect(endpointDailyCap(created, "posts")).toBe(3);
    expect(endpointDailyCap(created, "followers")).toBe(2);
    expect(endpointDailyCap(created, "stories")).toBe(0);
    expect(endpointDailyCap(created, "highlights")).toBe(0);
    expect(endpointDailyCap(created, "likers")).toBe(0);
    expect(endpointDailyCap(created, "comments")).toBe(0);
    expect(endpointDailyCap(created, "reels")).toBe(0);
  });

  it("returns the day-1 caps once a full UTC day has elapsed", () => {
    const created = daysAgo(1);
    expect(endpointDailyCap(created, "profile")).toBe(10);
    expect(endpointDailyCap(created, "posts")).toBe(5);
    expect(endpointDailyCap(created, "followers")).toBe(5);
    expect(endpointDailyCap(created, "stories")).toBe(1);
    expect(endpointDailyCap(created, "highlights")).toBe(1);
  });

  it("returns the day-2 caps", () => {
    const created = daysAgo(2);
    expect(endpointDailyCap(created, "profile")).toBe(20);
    expect(endpointDailyCap(created, "posts")).toBe(15);
    expect(endpointDailyCap(created, "followers")).toBe(10);
    // likers gated to matured (day-14+) bots; young tiers are 0
    expect(endpointDailyCap(created, "likers")).toBe(0);
    expect(endpointDailyCap(created, "reels")).toBe(0);
  });

  it("returns the day-3..5 caps", () => {
    for (const d of [3, 4, 5]) {
      const created = daysAgo(d);
      expect(endpointDailyCap(created, "profile")).toBe(30);
      expect(endpointDailyCap(created, "posts")).toBe(25);
      expect(endpointDailyCap(created, "followers")).toBe(20);
      expect(endpointDailyCap(created, "reels")).toBe(3);
    }
  });

  it("returns the day-6..13 caps", () => {
    for (const d of [6, 10, 13]) {
      const created = daysAgo(d);
      expect(endpointDailyCap(created, "profile")).toBe(50);
      expect(endpointDailyCap(created, "stories")).toBe(10);
      expect(endpointDailyCap(created, "reels")).toBe(8);
    }
  });

  it("returns unlimited (effectively) caps at day 14+ for profile/posts/followers", () => {
    const created = daysAgo(20);
    expect(endpointDailyCap(created, "profile")).toBeGreaterThanOrEqual(1000);
    expect(endpointDailyCap(created, "posts")).toBeGreaterThanOrEqual(1000);
    expect(endpointDailyCap(created, "followers")).toBeGreaterThanOrEqual(1000);
    // The "limited" endpoints stay limited even at full age.
    expect(endpointDailyCap(created, "stories")).toBe(30);
    expect(endpointDailyCap(created, "reels")).toBe(20);
  });

  it("normalizes raw scrape labels with a username/userId suffix", () => {
    const created = daysAgo(7);
    expect(endpointDailyCap(created, "profile:wire.fluid")).toBe(50);
    expect(endpointDailyCap(created, "followers-all:80264514554")).toBe(50);
    expect(endpointDailyCap(created, "following:80264514554")).toBe(50);
    expect(endpointDailyCap(created, "comments:abc123")).toBe(10);
  });

  it("returns 0 for unknown endpoints", () => {
    expect(endpointDailyCap(daysAgo(30), "wat")).toBe(0);
    expect(endpointDailyCap(daysAgo(30), "")).toBe(0);
  });
});

describe("normalizeEndpoint", () => {
  it("collapses synonyms onto canonical buckets", () => {
    expect(normalizeEndpoint("profile")).toBe("profile");
    expect(normalizeEndpoint("posts")).toBe("posts");
    expect(normalizeEndpoint("tagged")).toBe("posts");
    expect(normalizeEndpoint("clips")).toBe("reels");
    expect(normalizeEndpoint("reels")).toBe("reels");
    expect(normalizeEndpoint("followers")).toBe("followers");
    expect(normalizeEndpoint("followers-all")).toBe("followers");
    expect(normalizeEndpoint("following")).toBe("followers");
    expect(normalizeEndpoint("following-all")).toBe("followers");
    expect(normalizeEndpoint("stories")).toBe("stories");
    expect(normalizeEndpoint("highlights")).toBe("highlights");
    expect(normalizeEndpoint("likers")).toBe("likers");
    expect(normalizeEndpoint("comments")).toBe("comments");
  });

  it("strips the colon-suffix carried by scrape labels", () => {
    expect(normalizeEndpoint("profile:wire.fluid")).toBe("profile");
    expect(normalizeEndpoint("followers-all:80264514554")).toBe("followers");
    expect(normalizeEndpoint("comments:CzAbC123")).toBe("comments");
    expect(normalizeEndpoint("likers:CzAbC123")).toBe("likers");
  });

  it("returns null for unbudgeted or unknown labels", () => {
    expect(normalizeEndpoint("login")).toBeNull();
    expect(normalizeEndpoint("login:bot1")).toBeNull();
    expect(normalizeEndpoint("wat")).toBeNull();
    expect(normalizeEndpoint("")).toBeNull();
  });
});

describe("reads without import-date waiting", () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const keys = ["BOT_READ_WARMUP_ENABLED", "BOT_AGE_FLOOR_DAYS", "LIKERS_DAILY_CAP",
    "BOT_IMPORT_GRACE_HOURS", "LIKERS_IMPORT_DAY_CAP", "DAILY_CAP_MULTIPLIER",
    "MOBILE_DAILY_CAP", "MOBILE_ROSTER_ENABLED"];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.BOT_READ_WARMUP_ENABLED = "false";
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("allows every supported read immediately with a finite daily budget", () => {
    for (const [endpoint, expected] of Object.entries(READ_DAILY_CAPS)) {
      const cap = endpointDailyCap(now, endpoint, now, "web");
      expect(cap).toBe(expected);
      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThanOrEqual(50);
    }
  });

  it("does not depend on, or modify, the recorded import date or age floor", () => {
    process.env.BOT_AGE_FLOOR_DAYS = "60";
    for (const created of [new Date(0), now, new Date(now.getTime() + 86400000)]) {
      const recorded = created.getTime();
      expect(endpointDailyCap(created, "stories", now)).toBe(30);
      expect(endpointDailyCap(created, "posts", now)).toBe(50);
      expect(created.getTime()).toBe(recorded);
    }
  });

  it("removes the import-day liker wait while honoring the explicit daily cap", () => {
    process.env.BOT_IMPORT_GRACE_HOURS = "24";
    process.env.LIKERS_IMPORT_DAY_CAP = "0";
    process.env.LIKERS_DAILY_CAP = "5";
    expect(endpointDailyCap(now, "likers:example", now)).toBe(5);
    process.env.DAILY_CAP_MULTIPLIER = "2";
    expect(endpointDailyCap(now, "likers:example", now)).toBe(10);
  });

  it("keeps unsupported mobile reads unavailable", () => {
    process.env.MOBILE_DAILY_CAP = "60";
    process.env.MOBILE_ROSTER_ENABLED = "true";
    for (const endpoint of ["profile", "posts", "following", "followers"]) {
      expect(endpointDailyCap(now, endpoint, now, "mobile")).toBe(60);
    }
    for (const endpoint of ["stories", "highlights", "likers", "comments", "reels"]) {
      expect(endpointDailyCap(now, endpoint, now, "mobile")).toBe(0);
    }
    process.env.MOBILE_ROSTER_ENABLED = "false";
    expect(endpointDailyCap(now, "followers", now, "mobile")).toBe(0);
  });

  it("normalizes aliases and keeps unknown endpoints at zero", () => {
    expect(endpointDailyCap(now, "following-all:123", now)).toBe(50);
    expect(endpointDailyCap(now, "tagged:123", now)).toBe(50);
    expect(endpointDailyCap(now, "clips:123", now)).toBe(20);
    expect(endpointDailyCap(now, "unknown", now)).toBe(0);
  });

  it("requires an explicit false setting and can restore the original schedule", () => {
    process.env.BOT_READ_WARMUP_ENABLED = " False ";
    expect(readWarmupEnabled()).toBe(false);
    for (const value of [undefined, "", "true", "misspelled"]) {
      if (value === undefined) delete process.env.BOT_READ_WARMUP_ENABLED;
      else process.env.BOT_READ_WARMUP_ENABLED = value;
      expect(readWarmupEnabled()).toBe(true);
      expect(endpointDailyCap(now, "stories", now)).toBe(0);
    }
  });
});

// ─── Integration: real Postgres ─────────────────────────────────────────────
//
// These exercise the actual atomic upsert. They require TEST_DATABASE_URL
// pointing at an isolated test database AND for migration 0013 to have been
// applied. We ensure isolation by:
//   - Creating a one-shot bot row with a random ig_username at suite start.
//   - Truncating the bot's bot_daily_calls rows before each test.
//   - Deleting the bot row at suite end.
//
// If TEST_DATABASE_URL is missing we skip the whole block.

const HAS_DB = Boolean(TEST_DATABASE_URL);

describe.skipIf(!HAS_DB)("integration: checkAndIncrementBudget atomicity", () => {
  // Lazy imports so the unit suite above doesn't pay the db.ts cost when
  // DATABASE_URL is unset.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let testBotId: string;

  beforeAll(async () => {
    mod = await import("../daily-budget.js");
    const dbModule = await import("../../db.js");
    db = dbModule.db;
    const { sql } = await import("drizzle-orm");

    // Create a fresh bot with createdAt = 30 days ago so the day-14+ tier
    // applies. We pick a tier with finite caps for the cap-hit assertion
    // (profile is unlimited at 14+, but stories/highlights = 30/30).
    const username = `__test_budget_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const created = await db.execute<{ id: string }>(sql`
      INSERT INTO bot_accounts (ig_username, status, created_at)
      VALUES (${username}, 'available', now() - interval '30 days')
      RETURNING id
    `);
    const rows = Array.isArray(created)
      ? (created as Array<{ id: string }>)
      : ((created as { rows?: Array<{ id: string }> }).rows ?? []);
    if (rows.length === 0) throw new Error("failed to seed test bot");
    testBotId = rows[0]!.id;
  });

  afterAll(async () => {
    if (!testBotId) return;
    const { sql } = await import("drizzle-orm");
    // ON DELETE CASCADE on bot_daily_calls means we only need to wipe the
    // bot row; the children go with it.
    await db.execute(sql`DELETE FROM bot_accounts WHERE id = ${testBotId}`);
  });

  beforeEach(async () => {
    const { sql } = await import("drizzle-orm");
    await db.execute(
      sql`DELETE FROM bot_daily_calls WHERE bot_id = ${testBotId}`,
    );
  });

  it("increments the count atomically across 100 concurrent calls (cap >> N)", async () => {
    // profile at 30-day age = unlimited (1_000_000), so all 100 should pass.
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        mod.checkAndIncrementBudget(testBotId, "profile"),
      ),
    );
    const allowed = results.filter((r) => r.allowed);
    expect(allowed).toHaveLength(N);
    // The post-increment counts should be exactly 1..N (no duplicates, no
    // gaps), proving the upsert serialized correctly.
    const counts = results.map((r) => r.used).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it("stops at the cap when N concurrent callers exceed the budget", async () => {
    // stories at 30-day age = cap of 30. Fire 100 concurrent calls.
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        mod.checkAndIncrementBudget(testBotId, "stories"),
      ),
    );
    const allowed = results.filter((r) => r.allowed);
    const denied = results.filter((r) => !r.allowed);
    expect(allowed).toHaveLength(30);
    expect(denied).toHaveLength(70);
    // Every denied call should report cap=30, used=30.
    for (const d of denied) {
      expect(d.cap).toBe(30);
      expect(d.used).toBe(30);
    }
    // Allowed counts are 1..30 in some order.
    const allowedCounts = allowed.map((r) => r.used).sort((a, b) => a - b);
    expect(allowedCounts).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("returns allowed=false once the cap has been hit", async () => {
    // Burn the comments cap (10) sequentially so the day-14+ tier applies.
    for (let i = 0; i < 10; i += 1) {
      const r = await mod.checkAndIncrementBudget(testBotId, "comments");
      expect(r.allowed).toBe(true);
      expect(r.used).toBe(i + 1);
      expect(r.cap).toBe(30); // comments at 30-day age = 30 cap
    }
    // Hit it 21 more times — 30 - 10 = 20 still allowed, then deny.
    for (let i = 0; i < 20; i += 1) {
      const r = await mod.checkAndIncrementBudget(testBotId, "comments");
      expect(r.allowed).toBe(true);
    }
    const denied = await mod.checkAndIncrementBudget(testBotId, "comments");
    expect(denied.allowed).toBe(false);
    expect(denied.cap).toBe(30);
    expect(denied.used).toBe(30);
  });

  it("handles raw scrape-label input (profile:username, followers-all:id)", async () => {
    const r1 = await mod.checkAndIncrementBudget(
      testBotId,
      "profile:wire.fluid",
    );
    expect(r1.allowed).toBe(true);
    expect(r1.endpoint).toBe("profile");

    const r2 = await mod.checkAndIncrementBudget(
      testBotId,
      "followers-all:80264514554",
    );
    expect(r2.allowed).toBe(true);
    expect(r2.endpoint).toBe("followers");
  });

  it("treats day rollover as a fresh budget (new row at next UTC date)", async () => {
    // Burn 30 stories under today's date.
    for (let i = 0; i < 30; i += 1) {
      const r = await mod.checkAndIncrementBudget(testBotId, "stories");
      expect(r.allowed).toBe(true);
    }
    const today = await mod.checkAndIncrementBudget(testBotId, "stories");
    expect(today.allowed).toBe(false);

    // Simulate "tomorrow" by injecting a future `now`. The function uses
    // utcDayKey(now) for the row PK, so a different day = a different row.
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const r = await mod.checkAndIncrementBudget(
      testBotId,
      "stories",
      tomorrow,
    );
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(1);
  });

  it("getBudgetStatus reports per-endpoint used vs. cap for today", async () => {
    await mod.checkAndIncrementBudget(testBotId, "profile");
    await mod.checkAndIncrementBudget(testBotId, "profile");
    await mod.checkAndIncrementBudget(testBotId, "stories");
    const status = await mod.getBudgetStatus(testBotId);
    const profile = status.today.find(
      (e: { endpoint: string }) => e.endpoint === "profile",
    );
    const stories = status.today.find(
      (e: { endpoint: string }) => e.endpoint === "stories",
    );
    const reels = status.today.find(
      (e: { endpoint: string }) => e.endpoint === "reels",
    );
    expect(profile?.used).toBe(2);
    expect(stories?.used).toBe(1);
    // No calls yet → 0 used, but the cap is still reported.
    expect(reels?.used).toBe(0);
    expect(reels?.cap).toBe(20); // 30-day age → reels cap 20
  });

  it("resetTodayBudget clears today's rows and lets calls flow again", async () => {
    // Fill stories to the cap.
    for (let i = 0; i < 30; i += 1) {
      await mod.checkAndIncrementBudget(testBotId, "stories");
    }
    const denied = await mod.checkAndIncrementBudget(testBotId, "stories");
    expect(denied.allowed).toBe(false);

    const cleared = await mod.resetTodayBudget(testBotId);
    expect(cleared).toBeGreaterThan(0);

    const afterReset = await mod.checkAndIncrementBudget(
      testBotId,
      "stories",
    );
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.used).toBe(1);
  });

  it("reserves fresh-bot read budgets atomically when waiting is disabled", async () => {
    const { sql } = await import("drizzle-orm");
    const previous = process.env.BOT_READ_WARMUP_ENABLED;
    process.env.BOT_READ_WARMUP_ENABLED = "false";
    const importedAt = new Date();
    try {
      await db.execute(sql`UPDATE bot_accounts SET created_at = ${importedAt} WHERE id = ${testBotId}`);
      const results = await Promise.all(Array.from({ length: 50 }, () =>
        mod.checkAndIncrementBudget(testBotId, "stories")));
      expect(results.filter(r => r.allowed)).toHaveLength(30);
      expect(results.filter(r => !r.allowed)).toHaveLength(20);
      expect(results.every(r => r.cap === 30)).toBe(true);
      const status = await mod.getBudgetStatus(testBotId);
      expect(status.today.find((e: { endpoint: string }) => e.endpoint === "stories"))
        .toMatchObject({ used: 30, cap: 30 });
      const stored = await db.execute(sql`SELECT created_at FROM bot_accounts WHERE id = ${testBotId}`);
      expect(new Date(stored.rows[0].created_at).getTime()).toBe(importedAt.getTime());
    } finally {
      if (previous === undefined) delete process.env.BOT_READ_WARMUP_ENABLED;
      else process.env.BOT_READ_WARMUP_ENABLED = previous;
      await db.execute(sql`UPDATE bot_accounts SET created_at = now() - interval '30 days' WHERE id = ${testBotId}`);
    }
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

describe("importDayLikersCap (import-day ramp)", () => {
  const now = new Date("2026-09-02T20:00:00Z");
  afterEach(() => {
    delete process.env.LIKERS_IMPORT_DAY_CAP;
    delete process.env.BOT_IMPORT_GRACE_HOURS;
  });
  it("caps likers at 15 for a bot created inside the 24h grace window", () => {
    expect(importDayLikersCap(new Date(now.getTime() - 3_600_000), now, 60)).toBe(15);
  });
  it("never raises the cap above the tier cap", () => {
    expect(importDayLikersCap(new Date(now.getTime() - 3_600_000), now, 10)).toBe(10);
  });
  it("leaves the tier cap alone once the grace window has passed", () => {
    expect(importDayLikersCap(new Date(now.getTime() - 25 * 3_600_000), now, 60)).toBe(60);
  });
  it("honours LIKERS_IMPORT_DAY_CAP and a zero grace window", () => {
    process.env.LIKERS_IMPORT_DAY_CAP = "5";
    expect(importDayLikersCap(new Date(now.getTime() - 60_000), now, 60)).toBe(5);
    process.env.BOT_IMPORT_GRACE_HOURS = "0";
    expect(importDayLikersCap(new Date(now.getTime() - 60_000), now, 60)).toBe(60);
  });
});
