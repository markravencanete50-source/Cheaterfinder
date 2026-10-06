// Dead-session escalation primitives (bot-cooldown.ts, migration 0044).
//
// A bot with a dead IG session used to get the same flat 10-30 min cooldown on
// every lease and burned ~450 doomed calls/day. The streak policy escalates:
// 1-2 legacy, 3-5 → 6h prefixed, ≥6 → 24h prefixed (+ session_expired for
// mobile). Every escalated reason must stay clear of the lease ban regex.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

const dbState = vi.hoisted(() => ({
  executeCalls: [] as unknown[],
  executeResult: undefined as unknown,
  setCalls: [] as Array<Record<string, unknown>>,
  reset(): void {
    dbState.executeCalls = [];
    dbState.executeResult = undefined;
    dbState.setCalls = [];
  },
}));

vi.mock("../db.js", () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      dbState.executeCalls.push(query);
      return dbState.executeResult;
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        dbState.setCalls.push(payload);
        return { where: async () => undefined };
      },
    }),
  },
}));

vi.mock("../observability/logger.js", () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = {
    warn: noop, info: noop, debug: noop, error: noop, trace: noop, fatal: noop,
  };
  logger.child = () => logger;
  return { logger, default: logger };
});

import {
  BAN_REASON_SQL_REGEX,
  COOLDOWN_REASON_PREFIX,
  applyHardFailureEscalation,
  escalationForStreak,
  recordHardFailure,
  reloginBackoffMs,
  resetHardFailureStreak,
} from "../services/bot-cooldown.js";

const HOUR_MS = 60 * 60 * 1000;
const banRegex = new RegExp(BAN_REASON_SQL_REGEX, "i");
/** Mirror of the leaseBot SQL predicate: prefixed reasons are never verdicts. */
const isLeaseExcluded = (reason: string | null): boolean => {
  const r = reason ?? "";
  return !r.startsWith(COOLDOWN_REASON_PREFIX) && banRegex.test(r);
};

/** Flatten a drizzle `sql` object into its static text (params become "?"). */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value: unknown }).value;
        return Array.isArray(value) ? value.join("") : "?";
      }
      return String(chunk);
    })
    .join("");
}

beforeEach(() => {
  dbState.reset();
});

describe("escalationForStreak", () => {
  it("leaves streaks 0-2 on the legacy per-branch behaviour", () => {
    for (const streak of [0, 1, 2]) {
      expect(escalationForStreak(streak, "web")).toEqual({ cooldownHours: null, markSessionExpired: false });
      expect(escalationForStreak(streak, "mobile")).toEqual({ cooldownHours: null, markSessionExpired: false });
    }
  });

  it("escalates streaks 3-5 to a 6h cooldown on both transports", () => {
    for (const streak of [3, 4, 5]) {
      expect(escalationForStreak(streak, "web")).toEqual({ cooldownHours: 6, markSessionExpired: false });
      expect(escalationForStreak(streak, "mobile")).toEqual({ cooldownHours: 6, markSessionExpired: false });
    }
  });

  it("escalates ≥6 to 24h, and parks only MOBILE sessions as expired", () => {
    expect(escalationForStreak(6, "web")).toEqual({ cooldownHours: 24, markSessionExpired: false });
    expect(escalationForStreak(6, "mobile")).toEqual({ cooldownHours: 24, markSessionExpired: true });
    expect(escalationForStreak(40, "mobile")).toEqual({ cooldownHours: 24, markSessionExpired: true });
  });

  it("treats a non-finite streak as no escalation", () => {
    expect(escalationForStreak(Number.NaN, "mobile")).toEqual({ cooldownHours: null, markSessionExpired: false });
  });
});

describe("recordHardFailure / resetHardFailureStreak", () => {
  it("increments atomically and returns the post-increment streak ({rows} shape)", async () => {
    dbState.executeResult = { rows: [{ consecutive_hard_failures: "4" }] };
    await expect(recordHardFailure("bot-1")).resolves.toBe(4);
    const text = sqlText(dbState.executeCalls[0]);
    expect(text).toContain("consecutive_hard_failures = consecutive_hard_failures + 1");
    expect(text).toContain("last_hard_failure_at = NOW()");
    expect(text).toContain("RETURNING consecutive_hard_failures");
  });

  it("accepts a bare array result and falls back to 0 on an empty result", async () => {
    dbState.executeResult = [{ consecutive_hard_failures: 2 }];
    await expect(recordHardFailure("bot-1")).resolves.toBe(2);
    dbState.executeResult = { rows: [] };
    await expect(recordHardFailure("bot-1")).resolves.toBe(0);
  });

  it("resets only rows whose streak is non-zero", async () => {
    await resetHardFailureStreak("bot-1");
    const text = sqlText(dbState.executeCalls[0]);
    expect(text).toContain("consecutive_hard_failures = 0");
    expect(text).toContain("consecutive_hard_failures <> 0");
  });
});

describe("applyHardFailureEscalation", () => {
  it("writes nothing for streaks below the escalation threshold", async () => {
    const decision = await applyHardFailureEscalation("bot-1", "web", 2, "forbidden: 403");
    expect(decision.cooldownHours).toBeNull();
    expect(dbState.setCalls).toHaveLength(0);
  });

  it("streak 3 (web): 6h PREFIXED cooldown that the lease never reads as a ban", async () => {
    const before = Date.now();
    await applyHardFailureEscalation("bot-1", "web", 3, "auth_rejected: [ig-http] auth rejected (status 401)");
    expect(dbState.setCalls).toHaveLength(1);
    const payload = dbState.setCalls[0]!;
    const until = payload.cooldownUntil as Date;
    expect(until.getTime() - before).toBeGreaterThanOrEqual(6 * HOUR_MS - 1000);
    expect(until.getTime() - before).toBeLessThanOrEqual(6 * HOUR_MS + 5000);
    const reason = payload.lastLoginError as string;
    expect(reason.startsWith(COOLDOWN_REASON_PREFIX)).toBe(true);
    expect(reason).toContain("auth rejected"); // raw text WOULD match the ban regex…
    expect(isLeaseExcluded(reason)).toBe(false); // …but the prefix makes it a timed cooldown
    expect(payload).not.toHaveProperty("status");
  });

  it("streak 6 (web): 24h prefixed cooldown, session kept, status untouched", async () => {
    const before = Date.now();
    await applyHardFailureEscalation("bot-1", "web", 6, "checkpoint_required: HTTP 400");
    const payload = dbState.setCalls[0]!;
    const until = payload.cooldownUntil as Date;
    expect(until.getTime() - before).toBeGreaterThanOrEqual(24 * HOUR_MS - 1000);
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("sessionData");
    expect(isLeaseExcluded(payload.lastLoginError as string)).toBe(false);
  });

  it("streak 6 (mobile): parks as session_expired with an UNPREFIXED verdict", async () => {
    await applyHardFailureEscalation("bot-1", "mobile", 6, "mobile_auth: HTTP 401");
    const payload = dbState.setCalls[0]!;
    expect(payload.status).toBe("session_expired");
    const reason = payload.lastLoginError as string;
    expect(reason).toBe("mobile session dead: 6 consecutive auth failures");
    expect(reason.startsWith(COOLDOWN_REASON_PREFIX)).toBe(false);
  });

  it("streak 4 (mobile): still a timed 6h cooldown, not yet a verdict", async () => {
    await applyHardFailureEscalation("bot-1", "mobile", 4, "mobile_auth: HTTP 403");
    const payload = dbState.setCalls[0]!;
    expect(payload).not.toHaveProperty("status");
    expect((payload.lastLoginError as string).startsWith(COOLDOWN_REASON_PREFIX)).toBe(true);
  });
});

describe("reloginBackoffMs", () => {
  it("backs off geometrically 2h → 4h → 8h and caps at 16h", () => {
    expect(reloginBackoffMs(0)).toBe(2 * HOUR_MS);
    expect(reloginBackoffMs(1)).toBe(4 * HOUR_MS);
    expect(reloginBackoffMs(2)).toBe(8 * HOUR_MS);
    expect(reloginBackoffMs(3)).toBe(16 * HOUR_MS);
    expect(reloginBackoffMs(12)).toBe(16 * HOUR_MS);
  });

  it("treats garbage attempt counts as a first attempt", () => {
    expect(reloginBackoffMs(Number.NaN)).toBe(2 * HOUR_MS);
    expect(reloginBackoffMs(-3)).toBe(2 * HOUR_MS);
    expect(reloginBackoffMs(1.9)).toBe(4 * HOUR_MS);
  });
});
