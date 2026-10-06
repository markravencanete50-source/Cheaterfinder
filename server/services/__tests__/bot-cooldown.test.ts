// Unit tests for the two-tier rate-limit cooldown policy in bot-cooldown.ts
// (audit fix A4).
//
// Policy under test:
//   - default / pool-wide context: Retry-After extends but never undercuts
//     the long floor (IG_RATE_LIMIT_COOLDOWN_MIN_MS, default 4h).
//   - rotation context (withRotationRateLimitCooldownPolicy): honor the
//     upstream Retry-After when present (min 60s) — even when SHORTER than
//     the rotation default — else fall back to PROFILE_ROTATION_COOLDOWN_MS
//     (default 20 min).
//
// The DB write path of cooldownBotForRateLimit is exercised against a
// recording db mock so the rotation marker on last_login_error is covered.

import { describe, it, expect, beforeEach, vi } from "vitest";

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

// Recording db mock — captures every update().set() payload.
const dbState = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  cooldownUntil: null as Date | null,
}));

vi.mock("../../db.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async (allowed: boolean) => {
          if (allowed) dbState.updates.push(values);
          return [];
        },
      }),
    }),
  },
}));

vi.mock("../../../shared/schema.js", () => ({
  botAccounts: { id: "id", cooldownUntil: "cooldown_until" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => true,
  and: (...values: Array<boolean | { matches: boolean }>) => values.every(value =>
    typeof value === "object" ? value.matches : value),
  or: (...values: boolean[]) => values.some(Boolean),
  isNull: () => dbState.cooldownUntil === null,
  lt: (_column: unknown, until: Date) => dbState.cooldownUntil !== null && dbState.cooldownUntil < until,
}));

import {
  cooldownBotForRateLimit,
  cooldownBotForCheckpoint,
  resolveRateLimitCooldownMs,
  withRotationRateLimitCooldownPolicy,
} from "../bot-cooldown.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

beforeEach(() => {
  dbState.updates.length = 0;
  dbState.cooldownUntil = null;
  vi.unstubAllEnvs();
  vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
});

describe("resolveRateLimitCooldownMs — default (pool-wide) context", () => {
  it("no retry-after → long 4h floor", () => {
    const { effectiveMs, rotationContext } = resolveRateLimitCooldownMs(0);
    expect(effectiveMs).toBe(4 * HOUR_MS);
    expect(rotationContext).toBe(false);
  });

  it("short retry-after never undercuts the long floor", () => {
    const { effectiveMs } = resolveRateLimitCooldownMs(30_000);
    expect(effectiveMs).toBe(4 * HOUR_MS);
  });

  it("long retry-after extends past the floor", () => {
    const { effectiveMs } = resolveRateLimitCooldownMs(6 * HOUR_MS);
    expect(effectiveMs).toBe(6 * HOUR_MS);
  });
});

describe("resolveRateLimitCooldownMs — rotation context", () => {
  it("no retry-after → short rotation default (20 min), not 4h", async () => {
    await withRotationRateLimitCooldownPolicy(async () => {
      const { effectiveMs, rotationContext } = resolveRateLimitCooldownMs(0);
      expect(effectiveMs).toBe(20 * MINUTE_MS);
      expect(rotationContext).toBe(true);
    });
  });

  it("honors a retry-after SHORTER than the rotation default", async () => {
    await withRotationRateLimitCooldownPolicy(async () => {
      const { effectiveMs } = resolveRateLimitCooldownMs(5 * MINUTE_MS);
      expect(effectiveMs).toBe(5 * MINUTE_MS);
    });
  });

  it("clamps a bogus tiny retry-after to 60s", async () => {
    await withRotationRateLimitCooldownPolicy(async () => {
      const { effectiveMs } = resolveRateLimitCooldownMs(10_000);
      expect(effectiveMs).toBe(MINUTE_MS);
    });
  });

  it("honors a retry-after LONGER than the rotation default", async () => {
    await withRotationRateLimitCooldownPolicy(async () => {
      const { effectiveMs } = resolveRateLimitCooldownMs(6 * HOUR_MS);
      expect(effectiveMs).toBe(6 * HOUR_MS);
    });
  });

  it("PROFILE_ROTATION_COOLDOWN_MS tunes the no-retry-after fallback", async () => {
    vi.stubEnv("PROFILE_ROTATION_COOLDOWN_MS", String(15 * MINUTE_MS));
    await withRotationRateLimitCooldownPolicy(async () => {
      const { effectiveMs } = resolveRateLimitCooldownMs(0);
      expect(effectiveMs).toBe(15 * MINUTE_MS);
    });
  });

  it("legacy IG_RATE_LIMIT_ROTATION_COOLDOWN_MS alias still works", async () => {
    vi.stubEnv("IG_RATE_LIMIT_ROTATION_COOLDOWN_MS", String(10 * MINUTE_MS));
    await withRotationRateLimitCooldownPolicy(async () => {
      const { effectiveMs } = resolveRateLimitCooldownMs(0);
      expect(effectiveMs).toBe(10 * MINUTE_MS);
    });
  });

  it("the policy does not leak outside the wrapped chain", async () => {
    await withRotationRateLimitCooldownPolicy(async () => {
      expect(resolveRateLimitCooldownMs(0).rotationContext).toBe(true);
    });
    expect(resolveRateLimitCooldownMs(0).rotationContext).toBe(false);
  });
});

describe("cooldownBotForRateLimit — DB write", () => {
  it("rejects a stale session guard for both cooldown kinds and preserves longer guarded holds", async () => {
    type Guard = NonNullable<Parameters<typeof cooldownBotForRateLimit>[2]>;
    const stale = { matches: false } as unknown as Guard;
    const current = { matches: true } as unknown as Guard;
    await cooldownBotForRateLimit("bot-1", 0, stale);
    await cooldownBotForCheckpoint("bot-1", "checkpoint_required", 24, stale);
    expect(dbState.updates).toEqual([]);

    dbState.cooldownUntil = new Date(Date.now() + 48 * HOUR_MS);
    await cooldownBotForRateLimit("bot-1", 0, current);
    await cooldownBotForCheckpoint("bot-1", "checkpoint_required", 24, current);
    expect(dbState.updates).toEqual([]);

    dbState.cooldownUntil = null;
    await cooldownBotForCheckpoint("bot-1", "checkpoint_required", 24, current);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0].lastLoginError).toBe("cooldown: checkpoint_required");
  });

  it("preserves a longer existing checkpoint hold and its reason", async () => {
    dbState.cooldownUntil = new Date(Date.now() + 24 * HOUR_MS);
    await cooldownBotForRateLimit("bot-1", 0);
    expect(dbState.updates).toEqual([]);
  });

  it("extends an existing hold when Retry-After requires a later expiry", async () => {
    const before = Date.now();
    dbState.cooldownUntil = new Date(before + 24 * HOUR_MS);
    await cooldownBotForRateLimit("bot-1", 30 * HOUR_MS);
    expect(dbState.updates).toHaveLength(1);
    expect((dbState.updates[0].cooldownUntil as Date).getTime()).toBeGreaterThanOrEqual(before + 30 * HOUR_MS);
  });

  it("rotation context stamps the (rotation) marker and short window", async () => {
    await withRotationRateLimitCooldownPolicy(async () => {
      await cooldownBotForRateLimit("bot-1", 0);
    });
    expect(dbState.updates).toHaveLength(1);
    const update = dbState.updates[0];
    expect(String(update.lastLoginError)).toContain("(rotation)");
    const until = update.cooldownUntil as Date;
    const windowMs = until.getTime() - Date.now();
    expect(windowMs).toBeGreaterThan(15 * MINUTE_MS);
    expect(windowMs).toBeLessThanOrEqual(20 * MINUTE_MS + 1000);
  });

  it("default context keeps the 4h floor and no rotation marker", async () => {
    await cooldownBotForRateLimit("bot-2", 30_000);
    expect(dbState.updates).toHaveLength(1);
    const update = dbState.updates[0];
    expect(String(update.lastLoginError)).not.toContain("(rotation)");
    const until = update.cooldownUntil as Date;
    const windowMs = until.getTime() - Date.now();
    expect(windowMs).toBeGreaterThan(3.9 * HOUR_MS);
  });
});
