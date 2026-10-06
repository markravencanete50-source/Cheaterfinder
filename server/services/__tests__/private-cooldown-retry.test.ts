import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ readerRetry: vi.fn() }));
vi.mock("../private-account-access.js", () => ({ getPrivateReaderRetryAt: f.readerRetry }));
import { enqueuePrivateCooldownRetry } from "../private-cooldown-retry.js";
import { collectionCompletion } from "../collection-completion.js";
const NOW = Date.parse("2026-09-24T01:06:14.000Z");
const EXPIRES = new Date("2026-09-24T02:06:14.952Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); f.readerRetry.mockReset().mockResolvedValue(null); });
afterEach(() => vi.useRealTimers());

describe("private reader cooldown wake-up", () => {
  it("wakes just after the known expiry instead of the next three-hour account tick", async () => {
    f.readerRetry.mockResolvedValue(EXPIRES);
    const add = vi.fn().mockResolvedValue({});
    expect(await enqueuePrivateCooldownRetry({ add }, "track")).toEqual(new Date(EXPIRES.getTime() + 1000));
    expect(add).toHaveBeenCalledExactlyOnceWith("collect-profile", { trackedAccountId: "track", force: true, source: "private-cooldown", cooldownObservedAt: new Date(NOW).toISOString() }, {
      jobId: `private-cooldown_track_${EXPIRES.getTime()}`, delay: 3_601_952, removeOnComplete: 100, removeOnFail: 50,
    });
  });
  it("uses the same BullMQ identity for concurrent observations of one cooldown", async () => {
    f.readerRetry.mockResolvedValue(EXPIRES);
    const jobs = new Map<string, unknown>();
    const add = vi.fn(async (_name, data, opts) => { if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, data); });
    await Promise.all([enqueuePrivateCooldownRetry({ add }, "track"), enqueuePrivateCooldownRetry({ add }, "track", NOW + 100)]);
    expect(jobs.size).toBe(1);
    expect(add.mock.calls.map(c => c[2].jobId)).toEqual(Array(2).fill(`private-cooldown_track_${EXPIRES.getTime()}`));
  });
  it.each([null, new Date(NOW), new Date(NOW - 1), new Date(NaN)])("does not invent a wake-up without a future eligible-reader cooldown (%s)", async value => {
    f.readerRetry.mockResolvedValue(value); const add = vi.fn();
    expect(await enqueuePrivateCooldownRetry({ add }, "track")).toBeNull(); expect(add).not.toHaveBeenCalled();
  });
  it("propagates queue failure rather than claiming a recovery was scheduled", async () => {
    f.readerRetry.mockResolvedValue(EXPIRES); const add = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await expect(enqueuePrivateCooldownRetry({ add }, "track")).rejects.toThrow("queue unavailable");
  });
});

const workerSource = readFileSync(new URL("../../workers.ts", import.meta.url), "utf8");
const workerBody = workerSource.slice(workerSource.indexOf("function createProfileWorker()"), workerSource.indexOf("// ─── Worker: collection-likes"));
function fixture() {
  const account = { id: "track", userId: "owner", isActive: true, isPrivate: true, accessStatus: "has_access", igUsername: "fixture" };
  const writes: any[] = [];
  const queue = { add: vi.fn().mockResolvedValue({}) };
  const outcome: any = { isPrivate: true, profile: { ok: true, source: "bot" }, posts: { count: 1 }, stories: {}, highlights: {}, followers: {}, following: {} };
  const ctx: any = {
    Date, Error, Number, process: { env: {} },
    Worker: class { process: any; constructor(_name: string, processor: any) { this.process = processor; } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    withCorrelation: (_context: any, run: any) => run(), createRedisConnection: () => ({}), LONG_JOB_STALL_OPTIONS: {},
    OperationBusyError: class extends Error {},
    privateLeases: new Set<string>(),
    withOperationLease: async (key: string, run: any) => {
      if (ctx.privateLeases.has(key)) throw new ctx.OperationBusyError();
      ctx.privateLeases.add(key);
      try { return await run(); } finally { ctx.privateLeases.delete(key); }
    },
    ACCOUNT_REFRESH_JOB_NAME: "account-refresh", trackedAccounts: {}, collectionJobs: {}, profileSnapshots: {},
    eq: () => true, sql: () => true, and: () => true, inArray: () => true, desc: () => true,
    latestCollection: null,
    db: {
      insert: () => ({ values: () => ({ returning: async () => [{ id: "audit" }] }) }),
      execute: async () => ({ rows: [{ id: "audit" }] }),
      select: () => ({ from: (table: any) => {
        const result = () => table === ctx.collectionJobs ? (ctx.latestCollection ? [ctx.latestCollection] : []) : [account];
        const query: any = { where: () => query, orderBy: () => query, limit: async () => result() };
        return query;
      } }),
      update: () => ({ set: (value: any) => { writes.push(value); return { where: async () => ({}) }; } }),
    },
    customerHasAccess: vi.fn().mockResolvedValue(true),
    enqueuePrivateCooldownRetry,
    collectPublicData: vi.fn().mockResolvedValue(outcome), collectionCompletion,
    collectionProfileQueue: queue, collectionLikesQueue: {},
    enqueueLikesAfterProfile: vi.fn().mockResolvedValue("scheduled"),
    assignBotToTrackedAccount: vi.fn(), botFollowRequestQueue: { add: vi.fn() },
    enqueueDeferredProfileRetry: vi.fn().mockResolvedValue("scheduled"),
    profileBackoffAuditUpdate: (_scheduled: boolean, error: string) => ({ status: "failed", completedAt: new Date(), error }),
  };
  vm.createContext(ctx); vm.runInContext(transformSync(workerBody, { loader: "ts", format: "cjs" }).code, ctx);
  const run = (data: any = { trackedAccountId: "track", force: true }, name = "account-refresh") => ctx.createProfileWorker().process({ name, data });
  return { ctx, account, outcome, queue, writes, run };
}

describe("production profile worker cooldown recovery", () => {
  it("defers a scheduled private tick before provider traffic and records a closed failed audit", async () => {
    const t = fixture(); f.readerRetry.mockResolvedValue(EXPIRES);
    expect(await t.run({ trackedAccountId: "track" })).toEqual({ deferred: true, retryAt: "2026-09-24T02:06:15.952Z" });
    expect(t.ctx.collectPublicData).not.toHaveBeenCalled(); expect(t.ctx.assignBotToTrackedAccount).not.toHaveBeenCalled();
    expect(t.ctx.enqueueDeferredProfileRetry).not.toHaveBeenCalled(); expect(t.queue.add).toHaveBeenCalledTimes(1);
    expect(t.writes.at(-1)).toMatchObject({ status: "failed", completedAt: expect.any(Date), error: expect.stringContaining("02:06:15.952Z") });
  });
  it("rechecks an extended cooldown when an older one-off wakes, without a provider read", async () => {
    const t = fixture(); const extended = new Date(EXPIRES.getTime() + 4 * 3_600_000); f.readerRetry.mockResolvedValue(extended);
    await t.run({ trackedAccountId: "track", force: true, source: "private-cooldown" }, "collect-profile");
    expect(t.ctx.collectPublicData).not.toHaveBeenCalled();
    expect(t.queue.add.mock.calls[0][2].jobId).toBe(`private-cooldown_track_${extended.getTime()}`);
  });
  it.each(["inactive", "unentitled"])("does no recovery/provider work after %s", async reason => {
    const t = fixture(); if (reason === "inactive") t.account.isActive = false; else t.ctx.customerHasAccess.mockResolvedValue(false);
    await t.run({ trackedAccountId: "track", force: true, source: "private-cooldown" }, "collect-profile");
    expect(f.readerRetry).not.toHaveBeenCalled(); expect(t.ctx.collectPublicData).not.toHaveBeenCalled(); expect(t.queue.add).not.toHaveBeenCalled();
  });
  it.each(["pending_access", "access_denied", "public"])("never turns a stale one-off into a new follow after access changes to %s", async access => {
    const t = fixture(); t.account.accessStatus = access;
    expect(await t.run({ trackedAccountId: "track", force: true, source: "private-cooldown" }, "collect-profile")).toEqual({ skipped: "private-access-changed" });
    expect(f.readerRetry).not.toHaveBeenCalled(); expect(t.ctx.collectPublicData).not.toHaveBeenCalled(); expect(t.ctx.assignBotToTrackedAccount).not.toHaveBeenCalled();
  });
  it("collects normally when an approved healthy reader is already available", async () => {
    const t = fixture(); await t.run(); expect(t.ctx.collectPublicData).toHaveBeenCalledExactlyOnceWith(t.account); expect(t.queue.add).not.toHaveBeenCalled();
  });
  it("schedules the cooldown created by a failed profile read instead of waiting for the next scheduler tick", async () => {
    const t = fixture(); f.readerRetry.mockResolvedValueOnce(null).mockResolvedValue(EXPIRES);
    t.outcome.profile = { ok: false, error: "rate limited" };
    expect(await t.run()).toMatchObject({ deferred: true, retryAt: "2026-09-24T02:06:15.952Z" });
    expect(t.queue.add).toHaveBeenCalledTimes(1); expect(t.ctx.enqueueDeferredProfileRetry).not.toHaveBeenCalled();
    expect(t.writes.at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("rate limited") });
  });
  it("keeps a partial content failure visible and schedules the newly cooling reader", async () => {
    const t = fixture(); f.readerRetry.mockResolvedValueOnce(null).mockResolvedValue(EXPIRES); t.outcome.posts.error = "viewer cooling down";
    await t.run(); expect(t.queue.add).toHaveBeenCalledTimes(1);
    expect(t.writes.at(-1)).toMatchObject({ status: "failed", error: "partial collection: posts: viewer cooling down" });
  });
  it("does not loop a broken session when no otherwise usable accepted reader has a known cooldown", async () => {
    const t = fixture(); t.outcome.profile = { ok: false, error: "No healthy accepted bot available for private collection" };
    await expect(t.run()).rejects.toThrow("No healthy accepted bot"); expect(t.queue.add).not.toHaveBeenCalled();
    expect(t.writes.at(-1).status).toBe("failed");
  });
  it("skips both delayed expiry jobs after an intervening successful full collection", async () => {
    const t = fixture(); vi.setSystemTime(EXPIRES.getTime() + 60_000);
    t.ctx.latestCollection = { status: "completed", error: null, completedAt: new Date(EXPIRES.getTime() + 10_000) };
    for (const observedAt of [NOW, NOW + 30_000]) {
      expect(await t.run({ trackedAccountId: "track", force: true, source: "private-cooldown", cooldownObservedAt: new Date(observedAt).toISOString() }, "collect-profile"))
        .toEqual({ skipped: "private-already-recovered" });
    }
    expect(t.ctx.collectPublicData).not.toHaveBeenCalled(); expect(t.queue.add).not.toHaveBeenCalled();
    expect(t.writes.every(w => w.error?.startsWith("skipped:"))).toBe(true);
  });
  it("still recovers a newer partial failure even with a fresh profile and a prior successful collection", async () => {
    const t = fixture(); vi.setSystemTime(EXPIRES.getTime() + 60_000);
    t.ctx.latestCollection = { status: "failed", error: "partial collection: posts unavailable", completedAt: new Date(EXPIRES.getTime() + 10_000) };
    await t.run({ trackedAccountId: "track", force: true, source: "private-cooldown", cooldownObservedAt: new Date(NOW).toISOString() }, "collect-profile");
    expect(t.ctx.collectPublicData).toHaveBeenCalledExactlyOnceWith(t.account);
  });
  it("does not suppress needed recovery using a successful collection older than the observed failure", async () => {
    const t = fixture(); t.ctx.latestCollection = { status: "completed", error: null, completedAt: new Date(NOW - 1) };
    await t.run({ trackedAccountId: "track", force: true, source: "private-cooldown", cooldownObservedAt: new Date(NOW).toISOString() }, "collect-profile");
    expect(t.ctx.collectPublicData).toHaveBeenCalledExactlyOnceWith(t.account);
  });
  it.each(["account-refresh", "collect-profile"])("serializes a concurrent expiry job behind an existing %s without another viewer read", async name => {
    const t = fixture(); let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    t.ctx.collectPublicData.mockImplementation(async () => { await pending; return t.outcome; });
    const first = t.run({ trackedAccountId: "track", force: true, ...(name === "collect-profile" ? { source: "private-cooldown", cooldownObservedAt: new Date(NOW).toISOString() } : {}) }, name);
    for (let i = 0; i < 20 && !t.ctx.collectPublicData.mock.calls.length; i++) await Promise.resolve();
    expect(t.ctx.collectPublicData).toHaveBeenCalledTimes(1);
    expect(await t.run({ trackedAccountId: "track", force: true, source: "private-cooldown", cooldownObservedAt: new Date(NOW + 1).toISOString() }, "collect-profile"))
      .toEqual({ skipped: "private-in-progress" });
    expect(t.ctx.collectPublicData).toHaveBeenCalledTimes(1); expect(t.queue.add).not.toHaveBeenCalled();
    complete(); await first; expect(t.ctx.privateLeases.size).toBe(0);
  });
  it("preserves the observed failure boundary through a generic temporary retry", async () => {
    const t = fixture(); t.ctx.PROFILE_TEMP_BACKOFF_MS = 60_000;
    t.outcome.profile = { ok: false, error: "hit daily cap" };
    const cooldownObservedAt = new Date(NOW).toISOString();
    await t.run({ trackedAccountId: "track", force: true, source: "private-cooldown", cooldownObservedAt }, "collect-profile");
    expect(t.ctx.enqueueDeferredProfileRetry).toHaveBeenCalledExactlyOnceWith(t.queue, "track", 60_000, NOW,
      { force: true, source: "private-cooldown", cooldownObservedAt });
  });
  it("does not report a deferred success if Redis rejected the one-off", async () => {
    const t = fixture(); f.readerRetry.mockResolvedValue(EXPIRES); t.queue.add.mockRejectedValue(new Error("queue unavailable"));
    await expect(t.run()).rejects.toThrow("queue unavailable"); expect(t.ctx.collectPublicData).not.toHaveBeenCalled();
    expect(t.writes.at(-1).status).toBe("failed");
  });
});

describe("generic retry payload persistence", () => {
  it("retains the cooldown observation in the actual deferred queue payload", async () => {
    const start = workerSource.indexOf("export function buildDeferredProfileJobData(");
    const end = workerSource.indexOf("export const collectionProfileQueue", start);
    const ctx: any = { Date, Error, PROFILE_TEMP_BACKOFF_MS: 60_000, buildDeferredProfileJobId: () => "stable",
      SCHEDULED_JOB_STATES: new Set(), logger: { warn() {} } };
    vm.createContext(ctx);
    vm.runInContext(transformSync(workerSource.slice(start,end).replaceAll("export ", ""), {loader:"ts",format:"cjs"}).code,ctx);
    const queue = { getJob: vi.fn().mockResolvedValue(null), add: vi.fn().mockResolvedValue({}) };
    const carry = { force: true, source: "private-cooldown", cooldownObservedAt: new Date(NOW).toISOString() };
    await ctx.enqueueDeferredProfileRetry(queue,"track",60_000,NOW,carry);
    expect(queue.add).toHaveBeenCalledExactlyOnceWith("profile",{trackedAccountId:"track",...carry},
      {delay:60_000,removeOnComplete:100,removeOnFail:50,jobId:"stable"});
  });
});
