import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapAction } from "../caps.js";

// Never use the application's DATABASE_URL. Only the existing isolated audit
// database is allowed, on an explicitly non-production loopback port.
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (target.pathname !== "/cheaterfinder_backend_fix_test_20260907"
    || !["127.0.0.1", "localhost"].includes(target.hostname)
    || !target.port || target.port === "5432") {
    throw new Error("Guarded scratch database required for follow-cap tests");
  }
}

(url ? describe : describe.skip)("daily follow reservation — real database", () => {
  const id = randomUUID();
  const day = 86_400_000;
  let pool: typeof import("../../db.js").pool;
  let caps: typeof import("../caps.js");
  let createdAt: Date;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", url!);
    vi.stubEnv("CAP_DAILY_FOLLOWS", "150");
    vi.stubEnv("CAP_DAILY_PROFILE_VIEWS", "500");
    vi.stubEnv("CAP_DAILY_PRIVATE_REQUESTS", "30");
    ({ pool } = await import("../../db.js"));
    caps = await import("../caps.js");
    await pool.query("INSERT INTO bot_accounts(id,ig_username) VALUES($1,$2)", [id, `cap_fixture_${id}`]);
  });

  beforeEach(async () => {
    const now = new Date();
    createdAt = new Date(now.getTime() - 4 * day);
    await pool.query(`UPDATE bot_accounts SET created_at=$2,max_follows=5,
      daily_follows_used=0,daily_profile_views_used=13,daily_counters_reset_at=$3 WHERE id=$1`,
    [id, createdAt, now]);
  });

  afterAll(async () => {
    try {
      if (pool) await pool.query("DELETE FROM bot_accounts WHERE id=$1", [id]);
    } finally {
      if (pool) await pool.end();
      vi.unstubAllEnvs();
    }
  });

  const state = async () => (await pool.query(`SELECT created_at,max_follows,daily_follows_used,
    daily_profile_views_used,daily_counters_reset_at FROM bot_accounts WHERE id=$1`, [id])).rows[0];

  const followActions: CapAction[] = ["follows", "privateRequests"];
  for (const action of followActions) {
    it.each([0, 2])(`refuses ${action} at age day %i without spending any counter`, async (age) => {
      await pool.query("UPDATE bot_accounts SET created_at=$2 WHERE id=$1", [id, new Date(Date.now() - age * day)]);
      const before = await state();
      await expect(caps.reserveDailyBudget(id, action)).rejects.toBeInstanceOf(caps.IGDailyCapExceededError);
      expect(await state()).toEqual(before);
    });

    it.each([3, 6])(`enforces five ${action} at age day %i and preserves spent units`, async (age) => {
      await pool.query("UPDATE bot_accounts SET created_at=$2,daily_follows_used=4 WHERE id=$1", [id, new Date(Date.now() - age * day)]);
      await expect(caps.reserveDailyBudget(id, action)).resolves.toBe(0);
      await expect(caps.reserveDailyBudget(id, action)).rejects.toBeInstanceOf(caps.IGDailyCapExceededError);
      const row = await state();
      expect(row.daily_follows_used).toBe(5);
      expect(row.daily_profile_views_used).toBe(13);
    });

    it(`honors a disabled mature bot for ${action}`, async () => {
      await pool.query("UPDATE bot_accounts SET created_at=$2,max_follows=0 WHERE id=$1", [id, new Date(Date.now() - 12 * day)]);
      const before = await state();
      await expect(caps.reserveDailyBudget(id, action)).rejects.toBeInstanceOf(caps.IGDailyCapExceededError);
      expect(await state()).toEqual(before);
    });
  }

  it("serializes mixed concurrent private/public reservations at the fifth unit", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      caps.reserveDailyBudget(id, index % 2 ? "privateRequests" : "follows")));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(5);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected).toHaveLength(7);
    expect(rejected.every(result => result.reason instanceof caps.IGDailyCapExceededError)).toBe(true);
    const row = await state();
    expect(row.daily_follows_used).toBe(5);
    expect(row.daily_profile_views_used).toBe(13);
    expect(row.created_at).toEqual(createdAt);
  });

  it("applies the private cap once to the shared counter without capping later public follows at thirty", async () => {
    await pool.query("UPDATE bot_accounts SET created_at=$2,daily_follows_used=29 WHERE id=$1", [id, new Date(Date.now() - 12 * day)]);
    await expect(caps.reserveDailyBudget(id, "privateRequests")).resolves.toBe(0);
    await expect(caps.reserveDailyBudget(id, "privateRequests")).rejects.toBeInstanceOf(caps.IGDailyCapExceededError);
    expect((await state()).daily_follows_used).toBe(30);
    await expect(caps.reserveDailyBudget(id, "follows")).resolves.toBe(119);
    expect((await state()).daily_follows_used).toBe(31);
  });

  it("retains the mature public cap and the lower bot-specific override", async () => {
    await pool.query("UPDATE bot_accounts SET created_at=$2,daily_follows_used=149 WHERE id=$1", [id, new Date(Date.now() - 12 * day)]);
    await expect(caps.reserveDailyBudget(id, "follows")).resolves.toBe(0);
    await expect(caps.reserveDailyBudget(id, "follows")).rejects.toBeInstanceOf(caps.IGDailyCapExceededError);
    expect((await state()).daily_follows_used).toBe(150);
    await pool.query("UPDATE bot_accounts SET max_follows=1,daily_follows_used=29 WHERE id=$1", [id]);
    await expect(caps.reserveDailyBudget(id, "follows")).resolves.toBe(0);
    await expect(caps.reserveDailyBudget(id, "follows")).rejects.toBeInstanceOf(caps.IGDailyCapExceededError);
    expect((await state()).daily_follows_used).toBe(30);
  });

  it("does not let the five-unit ramp exceed a lower configured global follow cap", async () => {
    const original = caps.DAILY_CAPS.follows;
    caps.DAILY_CAPS.follows = 2;
    try {
      await expect(caps.reserveDailyBudget(id, "follows")).resolves.toBe(1);
      await expect(caps.reserveDailyBudget(id, "privateRequests")).resolves.toBe(0);
      await expect(caps.reserveDailyBudget(id, "privateRequests")).rejects.toBeInstanceOf(caps.IGDailyCapExceededError);
      expect((await state()).daily_follows_used).toBe(2);
    } finally {
      caps.DAILY_CAPS.follows = original;
    }
  });

  it("rolls yesterday's counters over only for a permitted reservation", async () => {
    const yesterday = new Date(Date.now() - day);
    await pool.query("UPDATE bot_accounts SET daily_follows_used=149,daily_profile_views_used=78,daily_counters_reset_at=$2 WHERE id=$1", [id, yesterday]);
    await expect(caps.reserveDailyBudget(id, "privateRequests")).resolves.toBe(4);
    const row = await state();
    expect(row.daily_follows_used).toBe(1);
    expect(row.daily_profile_views_used).toBe(0);
    expect(row.daily_counters_reset_at.toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(row.created_at).toEqual(createdAt);
  });

  it("rolls back a tentative rollover when a zero override rejects the reservation", async () => {
    await pool.query("UPDATE bot_accounts SET max_follows=0,daily_follows_used=9,daily_profile_views_used=78,daily_counters_reset_at=$2 WHERE id=$1", [id, new Date(Date.now() - day)]);
    const before = await state();
    await expect(caps.reserveDailyBudget(id, "follows")).rejects.toBeInstanceOf(caps.IGDailyCapExceededError);
    expect(await state()).toEqual(before);
  });

  it("keeps profile-view accounting independent of a zero follow allowance", async () => {
    await pool.query("UPDATE bot_accounts SET created_at=$2,max_follows=0,daily_follows_used=3,daily_profile_views_used=499 WHERE id=$1", [id, new Date()]);
    await expect(caps.reserveDailyBudget(id, "profileViews")).resolves.toBe(0);
    await expect(caps.reserveDailyBudget(id, "profileViews")).rejects.toBeInstanceOf(caps.IGDailyCapExceededError);
    const row = await state();
    expect(row.daily_profile_views_used).toBe(500);
    expect(row.daily_follows_used).toBe(3);
  });
});
