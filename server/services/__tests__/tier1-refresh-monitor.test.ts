import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../../../shared/schema.js", () => ({ trackedAccounts: {} }));
vi.mock("../public-read-client.js", () => ({
  refreshPublicProfileTier1: vi.fn(),
}));
vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import {
  __testing,
  runTier1RefreshSweep,
  type Tier1RefreshCandidate,
  type Tier1RefreshSweepConfig,
} from "../tier1-refresh-monitor.js";

const CONFIG: Tier1RefreshSweepConfig = {
  staleMs: 30 * 60 * 1000,
  batchSize: 20,
  gapMs: 100,
  maxConsecutiveFailures: 3,
};

function candidate(id: string): Tier1RefreshCandidate {
  return {
    id,
    userId: `user-${id}`,
    igUsername: `account-${id}`,
    isActive: true,
    lastProfileRefreshAt: null,
  };
}

describe("runTier1RefreshSweep", () => {
  beforeEach(() => {
    __testing.resetRetryBackoff();
  });

  it("refreshes candidates sequentially and spaces requests", async () => {
    const rows = [candidate("1"), candidate("2"), candidate("3")];
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const refresh = vi.fn(async (account: { id: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(account.id);
      await Promise.resolve();
      active -= 1;
      return { ok: true as const, posts: 1, isPrivate: false };
    });
    const delay = vi.fn(async () => undefined);

    const result = await runTier1RefreshSweep(CONFIG, {
      listCandidates: vi.fn(async () => rows),
      refresh,
      delay,
      now: () => 1_000_000,
      random: () => 0,
      shouldStop: () => false,
    });

    expect(order).toEqual(["1", "2", "3"]);
    expect(maxActive).toBe(1);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 100);
    expect(result).toEqual({
      considered: 3,
      refreshed: 3,
      failed: 0,
      skipped: 0,
      stoppedEarly: false,
      failureReasons: {},
    });
  });

  it("stops the sweep after the configured consecutive failure budget", async () => {
    const rows = [candidate("1"), candidate("2"), candidate("3"), candidate("4")];
    const refresh = vi.fn(async () => ({
      ok: false as const,
      reason: "rate_limited" as const,
    }));

    const result = await runTier1RefreshSweep(CONFIG, {
      listCandidates: vi.fn(async () => rows),
      refresh,
      delay: vi.fn(async () => undefined),
      now: () => 1_000_000,
      random: () => 0,
      shouldStop: () => false,
    });

    expect(refresh).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      considered: 4,
      refreshed: 0,
      failed: 3,
      skipped: 0,
      stoppedEarly: true,
      failureReasons: { rate_limited: 3 },
    });
  });

  it("does not count inactive or in-flight accounts as endpoint failures", async () => {
    const rows = [candidate("1"), candidate("2"), candidate("3")];
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "in_flight" })
      .mockResolvedValueOnce({ ok: false, reason: "inactive" })
      .mockResolvedValueOnce({ ok: true, posts: 0, isPrivate: true });

    const result = await runTier1RefreshSweep(CONFIG, {
      listCandidates: vi.fn(async () => rows),
      refresh,
      delay: vi.fn(async () => undefined),
      now: () => 1_000_000,
      random: () => 0,
      shouldStop: () => false,
    });

    expect(result).toEqual({
      considered: 3,
      refreshed: 1,
      failed: 0,
      skipped: 2,
      stoppedEarly: false,
      failureReasons: {},
    });
  });

  it("backs off a repeatedly failing account without delaying healthy candidates", async () => {
    const rows = [candidate("bad"), candidate("good")];
    let now = 1_000_000;
    const refresh = vi.fn(async (account: { id: string }) =>
      account.id === "bad"
        ? ({ ok: false as const, reason: "error" as const })
        : ({ ok: true as const, posts: 1, isPrivate: false }),
    );
    const deps = {
      listCandidates: vi.fn(async () => rows),
      refresh,
      delay: vi.fn(async () => undefined),
      now: () => now,
      random: () => 0,
      shouldStop: () => false,
    };

    const first = await runTier1RefreshSweep(CONFIG, deps);
    expect(first).toMatchObject({
      considered: 2,
      refreshed: 1,
      failed: 1,
      skipped: 0,
      failureReasons: { error: 1 },
    });

    now += 15 * 60 * 1000;
    const second = await runTier1RefreshSweep(CONFIG, deps);
    expect(second).toMatchObject({
      considered: 2,
      refreshed: 1,
      failed: 0,
      skipped: 1,
      failureReasons: {},
    });
    expect(refresh.mock.calls.map(([account]) => account.id)).toEqual([
      "bad",
      "good",
      "good",
    ]);

    now += 15 * 60 * 1000;
    await runTier1RefreshSweep(CONFIG, deps);
    expect(refresh.mock.calls.filter(([account]) => account.id === "bad")).toHaveLength(2);
    expect(__testing.retryIsDue("bad", now + 59 * 60 * 1000)).toBe(false);
    expect(__testing.retryIsDue("bad", now + 60 * 60 * 1000)).toBe(true);
  });
});
