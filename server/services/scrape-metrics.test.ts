// Unit tests for server/services/scrape-metrics.ts — focused on the "skip"
// outcome, which must be counted for observability but must NEVER inflate the
// attempt/failure totals or the success-rate the admin health view reads.
//
// Persistence (scrape_outcome_log) is a fire-and-forget dynamic import inside
// persistOutcome; these tests assert the in-memory aggregates only, which is
// where the failure-rate signal actually comes from.

import { afterEach, describe, expect, it, vi } from "vitest";

// scrape-metrics imports ../db (for the fire-and-forget persistOutcome insert),
// which throws at import unless DATABASE_URL is set. Stub the env and mock the
// db so these purely in-memory assertions never touch a real database.
vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
// Hoisted so the D9 hydration test can hold the SELECT open while a live
// outcome is recorded; every other call (persistOutcome inserts) resolves
// immediately with no rows.
const dbMock = vi.hoisted(() => ({
  execute: vi.fn(() => Promise.resolve<unknown>({ rows: [] })),
}));
vi.mock("../db.js", () => ({ db: dbMock, pool: {} }));

import {
  __resetForTests,
  getSnapshot,
  hydrateFromOutcomeLog,
  recordOutcome,
  outcomeRowToKind,
} from "./scrape-metrics.js";

function snapFor(endpoint: string) {
  const s = getSnapshot().endpoints.find((e) => e.endpoint === endpoint);
  if (!s) throw new Error(`no snapshot row for ${endpoint}`);
  return s;
}

describe("scrape-metrics skip accounting", () => {
  afterEach(() => __resetForTests());

  it("counts a skip without adding an attempt or a failure", () => {
    recordOutcome("likers", "skip", "bot-1");
    const s = snapFor("likers");
    expect(s.attempts).toBe(0);
    expect(s.failures).toBe(0);
    expect(s.successes).toBe(0);
    expect(s.skips).toBe(1);
  });

  it("keeps the success rate honest when skips dominate", () => {
    recordOutcome("likers", "success", "bot-1");
    for (let i = 0; i < 9; i++) recordOutcome("likers", "skip", "bot-1");
    const s = snapFor("likers");
    // 1 real attempt, 1 success -> 100%, not 1/10.
    expect(s.attempts).toBe(1);
    expect(s.successes).toBe(1);
    expect(s.failures).toBe(0);
    expect(s.skips).toBe(9);
    expect(s.successes / Math.max(s.attempts, 1)).toBe(1);
  });

  it("still counts genuine failures as attempts+failures", () => {
    recordOutcome("profile", "failure", "bot-1");
    recordOutcome("profile", "rate_limit", "bot-1");
    recordOutcome("profile", "skip", "bot-1");
    const s = snapFor("profile");
    expect(s.attempts).toBe(2);
    expect(s.failures).toBe(2);
    expect(s.skips).toBe(1);
    expect(s.lastErrorKind).toBe("rate_limit");
  });

  it("does not let a skip overwrite the lastErrorKind", () => {
    recordOutcome("comments", "checkpoint", "bot-1");
    recordOutcome("comments", "skip", "bot-1");
    expect(snapFor("comments").lastErrorKind).toBe("checkpoint");
  });
});

describe("outcomeRowToKind (hydration from scrape_outcome_log)", () => {
  it("maps success rows to success and typed failures to their kind", () => {
    expect(outcomeRowToKind("success", null)).toBe("success");
    expect(outcomeRowToKind("failure", "rate_limit")).toBe("rate_limit");
    expect(outcomeRowToKind("failure", "network")).toBe("network");
    expect(outcomeRowToKind("failure", "checkpoint")).toBe("checkpoint");
    expect(outcomeRowToKind("failure", "auth")).toBe("auth");
  });
  it("falls back to failure for unknown or missing error kinds", () => {
    expect(outcomeRowToKind("failure", null)).toBe("failure");
    expect(outcomeRowToKind("failure", "something_new")).toBe("failure");
  });
});

// D9: a live outcome recorded while the hydration SELECT is in flight used to
// sit in front of the replayed rows, so pruneOldEvents (which stops at the
// first in-window event) never reached them and 24h-old rows overstayed until
// the live row itself expired. Replayed rows are now merged into position.
describe("hydrateFromOutcomeLog with a live outcome recorded before it completes (D9)", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);

  function deferredHydration(): { pending: Promise<number>; release: (rows: unknown) => void } {
    let release: (rows: unknown) => void = () => {};
    dbMock.execute.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const pending = hydrateFromOutcomeLog(T0);
    return { pending, release };
  }

  afterEach(() => {
    __resetForTests();
    vi.useRealTimers();
    dbMock.execute.mockReset();
    dbMock.execute.mockImplementation(() => Promise.resolve<unknown>({ rows: [] }));
  });

  it("merges replayed rows into position so they still expire on time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { pending, release } = deferredHydration();

    // Live outcome while the SELECT is in flight (at = T0).
    recordOutcome("profile", "success", "bot-live");

    // Query order is newest-first, as ORDER BY occurred_at DESC returns it.
    release({
      rows: [
        { endpoint: "profile", outcome: "success", error_kind: null, occurred_at: new Date(T0 - 1 * HOUR_MS) },
        { endpoint: "profile", outcome: "failure", error_kind: "rate_limit", occurred_at: new Date(T0 - 23 * HOUR_MS) },
      ],
    });
    expect(await pending).toBe(2);

    let s = snapFor("profile");
    expect([s.attempts, s.successes, s.failures, s.lastErrorKind]).toEqual([3, 2, 1, "rate_limit"]);

    // +1h01m: the 23h-old replayed row has left the 24h window; the live row has not.
    vi.setSystemTime(T0 + 1 * HOUR_MS + 60_000);
    s = snapFor("profile");
    expect([s.attempts, s.successes, s.failures]).toEqual([2, 2, 0]);

    // +23h01m: the 1h-old replayed row expires too; only the live row remains.
    vi.setSystemTime(T0 + 23 * HOUR_MS + 60_000);
    s = snapFor("profile");
    expect([s.attempts, s.successes, s.failures]).toEqual([1, 1, 0]);
  });

  it("keeps lastErrorKind as the newest failure by time, not the last row admitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { pending, release } = deferredHydration();

    recordOutcome("likers", "checkpoint", "bot-live");
    release({
      rows: [
        { endpoint: "likers", outcome: "failure", error_kind: "rate_limit", occurred_at: new Date(T0 - 2 * HOUR_MS) },
      ],
    });
    expect(await pending).toBe(1);

    const s = snapFor("likers");
    expect([s.attempts, s.failures, s.lastErrorKind]).toEqual([2, 2, "checkpoint"]);
  });

  it("does not disturb skips (they never enter the ring)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { pending, release } = deferredHydration();

    recordOutcome("likers", "skip", "bot-live");
    release({
      rows: [
        { endpoint: "likers", outcome: "success", error_kind: null, occurred_at: new Date(T0 - 1 * HOUR_MS) },
      ],
    });
    expect(await pending).toBe(1);

    const s = snapFor("likers");
    expect([s.attempts, s.successes, s.skips]).toEqual([1, 1, 1]);
  });
});
