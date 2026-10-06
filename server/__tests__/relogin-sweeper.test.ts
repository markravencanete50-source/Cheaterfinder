// Relogin sweeper: recovers parked (session_expired) web bots in small,
// human-paced batches and stops the run on the first suspension/checkpoint.
// All I/O is injected or mocked — no DB, no Redis, no login.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../db.js", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
}));

vi.mock("../observability/logger.js", () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = {
    warn: noop, info: noop, debug: noop, error: noop, trace: noop, fatal: noop,
  };
  logger.child = () => logger;
  return { logger, default: logger };
});

vi.mock("../services/bot-runtime.js", () => ({
  reloginParkedBot: vi.fn(),
  isBotAutoLoginEnabled: () => true,
  RELOGIN_TERMINAL_REASON_PATTERNS: [
    "%suspend%", "%incorrect%", "%rejected username%", "%bad_credentials%",
    "%bad credentials%", "%invalid password%", "%account disabled%",
    "%captcha%", "%checkpoint%", "%challenge%",
  ],
}));

import {
  DEFAULT_RELOGIN_BATCH,
  DEFAULT_RELOGIN_SWEEP_SEC,
  INTER_BOT_DELAY_MAX_MS,
  INTER_BOT_DELAY_MIN_MS,
  buildReloginCandidateSql,
  interBotDelayMs,
  isStopSignal,
  readReloginBatch,
  readReloginSweepMs,
  reloginBackoffMs,
  runReloginSweep,
} from "../workers/relogin-sweeper.js";

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value: unknown }).value;
        return Array.isArray(value) ? value.join("") : `<${String(value)}>`;
      }
      // Bound parameters arrive as bare primitives in this drizzle version (no
      // Param wrapper), so render them the same way for the assertions.
      if (typeof chunk === "string" || typeof chunk === "number") return `<${chunk}>`;
      return String(chunk);
    })
    .join("");
}

describe("readReloginSweepMs", () => {
  it("defaults to 30 minutes", () => {
    expect(readReloginSweepMs({})).toBe(DEFAULT_RELOGIN_SWEEP_SEC * 1000);
    expect(DEFAULT_RELOGIN_SWEEP_SEC).toBe(1800);
  });
  it("reads RELOGIN_SWEEP_SEC and clamps to 5 min .. 24h", () => {
    expect(readReloginSweepMs({ RELOGIN_SWEEP_SEC: "600" })).toBe(600_000);
    expect(readReloginSweepMs({ RELOGIN_SWEEP_SEC: "1" })).toBe(300_000);
    expect(readReloginSweepMs({ RELOGIN_SWEEP_SEC: "999999" })).toBe(86_400_000);
  });
  it("falls back to the default on garbage instead of disabling the sweep", () => {
    expect(readReloginSweepMs({ RELOGIN_SWEEP_SEC: "abc" })).toBe(1_800_000);
    expect(readReloginSweepMs({ RELOGIN_SWEEP_SEC: "-5" })).toBe(1_800_000);
  });
});

describe("readReloginBatch", () => {
  it("defaults to 2 and clamps to 1..5", () => {
    expect(readReloginBatch({})).toBe(DEFAULT_RELOGIN_BATCH);
    expect(readReloginBatch({ RELOGIN_SWEEP_BATCH: "9" })).toBe(5);
    expect(readReloginBatch({ RELOGIN_SWEEP_BATCH: "3" })).toBe(3);
    expect(readReloginBatch({ RELOGIN_SWEEP_BATCH: "0" })).toBe(2);
    expect(readReloginBatch({ RELOGIN_SWEEP_BATCH: "x" })).toBe(2);
  });
});

describe("interBotDelayMs", () => {
  it("spans exactly 30-90 s", () => {
    expect(interBotDelayMs(() => 0)).toBe(INTER_BOT_DELAY_MIN_MS);
    expect(interBotDelayMs(() => 1)).toBe(INTER_BOT_DELAY_MAX_MS);
    expect(interBotDelayMs(() => 0.5)).toBe(60_000);
    expect(INTER_BOT_DELAY_MIN_MS).toBe(30_000);
    expect(INTER_BOT_DELAY_MAX_MS).toBe(90_000);
  });
});

describe("buildReloginCandidateSql", () => {
  it("selects only parked, TOTP-capable, automation-ready web bots outside cooldown", () => {
    const text = sqlText(buildReloginCandidateSql(2));
    expect(text).toContain("status = 'session_expired'");
    expect(text).toContain("transport = 'web'");
    expect(text).toContain("totp_secret IS NOT NULL");
    expect(text).toContain("NULLIF(BTRIM(totp_secret), '') IS NOT NULL");
    expect(text).toContain("NULLIF(BTRIM(ig_password_encrypted), '') IS NOT NULL");
    expect(text).toContain("automation_identity IS NOT NULL");
    expect(text).toContain("cooldown_until IS NULL OR cooldown_until < NOW()");
    expect(text).toContain("last_login_error IS NULL");
    expect(text).toContain("NOT ILIKE ALL (");
    const compiled = new PgDialect().sqlToQuery(buildReloginCandidateSql(2));
    expect(compiled.sql).toContain("NOT ILIKE ALL ($1::text[])");
    expect(compiled.params[0]).toEqual(expect.arrayContaining([
      "%suspend%", "%incorrect%", "%rejected username%", "%bad_credentials%",
      "%captcha%", "%checkpoint%", "%challenge%",
    ]));
    expect(text).toContain("ORDER BY updated_at ASC");
    expect(text).toContain("LIMIT <2>");
  });
  it("never re-logs reserve-tier rows (nothing can lease them) and clamps the batch", () => {
    const text = sqlText(buildReloginCandidateSql(50));
    expect(text).toContain("tier IN ('canary', 'worker')");
    expect(text).toContain("LIMIT <5>");
    expect(sqlText(buildReloginCandidateSql(0))).toContain("LIMIT <1>");
  });
});

describe("isStopSignal", () => {
  it("stops on a ban verdict or any suspension/checkpoint/captcha reason", () => {
    expect(isStopSignal("banned", null)).toBe(true);
    expect(isStopSignal("session_expired", "[bot-runtime] IG suspended foo")).toBe(true);
    expect(isStopSignal("session_expired", "checkpoint_required on /accounts/login")).toBe(true);
    expect(isStopSignal("session_expired", "[bot-runtime] IG requires CAPTCHA for foo")).toBe(true);
  });
  it("keeps going on transport/back-off reasons and on a clean row", () => {
    expect(isStopSignal("session_expired", "cooldown: login retry: navigation: Page.goto timeout")).toBe(false);
    expect(isStopSignal("available", null)).toBe(false);
    expect(isStopSignal(undefined, undefined)).toBe(false);
  });
});

describe("reloginBackoffMs (re-export)", () => {
  it("is the shared geometric back-off", () => {
    expect(reloginBackoffMs(0)).toBe(2 * 60 * 60 * 1000);
    expect(reloginBackoffMs(3)).toBe(16 * 60 * 60 * 1000);
  });
});

describe("runReloginSweep", () => {
  const rows = [
    { id: "b1", ig_username: "one" },
    { id: "b2", ig_username: "two" },
    { id: "b3", ig_username: "three" },
  ];
  const sleep = vi.fn(async (_ms: number) => undefined);
  const delays = [31_000, 45_000, 89_000];
  let delayIdx = 0;
  const delayMs = () => delays[delayIdx++ % delays.length]!;

  beforeEach(() => {
    sleep.mockClear();
    delayIdx = 0;
  });

  it("counts outcomes and paces bots 30-90 s apart (no sleep after the last)", async () => {
    const relogin = vi.fn()
      .mockResolvedValueOnce("recovered")
      .mockResolvedValueOnce("skipped")
      .mockResolvedValueOnce("failed");
    const verdict = vi.fn(async () => ({ status: "session_expired", last_login_error: "cooldown: login retry: timeout" }));

    const result = await runReloginSweep({
      candidates: async () => rows,
      relogin,
      verdict,
      sleep,
      delayMs,
    });

    expect(result).toEqual({ scanned: 3, attempted: 2, recovered: 1, skipped: 1 });
    expect(relogin.mock.calls.map((c) => c[0])).toEqual(["b1", "b2", "b3"]);
    expect(sleep).toHaveBeenCalledTimes(2);
    for (const [ms] of sleep.mock.calls) {
      expect(ms).toBeGreaterThanOrEqual(30_000);
      expect(ms).toBeLessThanOrEqual(90_000);
    }
    // The verdict is only consulted after a FAILED attempt.
    expect(verdict).toHaveBeenCalledTimes(1);
    expect(verdict).toHaveBeenCalledWith("b3");
  });

  it("stops the whole run on the first suspension and counts the rest as skipped", async () => {
    const relogin = vi.fn().mockResolvedValue("failed");
    const verdict = vi.fn(async () => ({ status: "banned", last_login_error: "[bot-runtime] IG suspended one" }));

    const result = await runReloginSweep({
      candidates: async () => rows,
      relogin,
      verdict,
      sleep,
      delayMs,
    });

    expect(result).toEqual({ scanned: 3, attempted: 1, recovered: 0, skipped: 2 });
    expect(relogin).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops on a checkpoint reason even when the status stayed session_expired", async () => {
    const relogin = vi.fn().mockResolvedValue("failed");
    const verdict = vi.fn(async () => ({ status: "session_expired", last_login_error: "checkpoint_required" }));
    const result = await runReloginSweep({ candidates: async () => rows, relogin, verdict, sleep, delayMs });
    expect(result.attempted).toBe(1);
    expect(relogin).toHaveBeenCalledTimes(1);
  });

  it("stops after an unrecorded recovery failure instead of assuming it preceded network I/O", async () => {
    const relogin = vi.fn()
      .mockRejectedValueOnce(new Error("bot b1 not found"))
      .mockResolvedValueOnce("recovered")
      .mockResolvedValueOnce("recovered");
    const verdict = vi.fn(async () => null);
    const result = await runReloginSweep({ candidates: async () => rows, relogin, verdict, sleep, delayMs });
    expect(result).toEqual({ scanned: 3, attempted: 1, recovered: 0, skipped: 2 });
    expect(sleep).not.toHaveBeenCalled();
    expect(relogin).toHaveBeenCalledOnce();
  });

  it.each(["missing", "unreadable"])("stops when a failed login has a %s verdict", async (kind) => {
    const relogin = vi.fn().mockResolvedValue("failed");
    const verdict = vi.fn(async () => {
      if (kind === "unreadable") throw new Error("database unavailable");
      return null;
    });
    const result = await runReloginSweep({ candidates: async () => rows, relogin, verdict, sleep, delayMs });
    expect(result).toEqual({ scanned: 3, attempted: 1, recovered: 0, skipped: 2 });
    expect(relogin).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns zeros and touches nothing when there are no candidates", async () => {
    const relogin = vi.fn();
    const result = await runReloginSweep({ candidates: async () => [], relogin, sleep, delayMs });
    expect(result).toEqual({ scanned: 0, attempted: 0, recovered: 0, skipped: 0 });
    expect(relogin).not.toHaveBeenCalled();
  });

  it("never overlaps two runs (re-entrancy guard)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const relogin = vi.fn(async () => { await gate; return "recovered" as const; });
    const first = runReloginSweep({ candidates: async () => rows.slice(0, 1), relogin, sleep, delayMs });
    const second = await runReloginSweep({ candidates: async () => rows, relogin, sleep, delayMs });
    expect(second).toEqual({ scanned: 0, attempted: 0, recovered: 0, skipped: 0 });
    release();
    await expect(first).resolves.toEqual({ scanned: 1, attempted: 1, recovered: 1, skipped: 0 });
  });
});
