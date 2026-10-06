import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ rows: [] as any[], predicate: null as any, capacity: vi.fn() }));
vi.mock("../../db.js", () => ({ db: { select: () => ({ from: () => ({ where: (predicate: any) => { f.predicate = predicate; return { limit: async () => f.rows }; } }) }) } }));
vi.mock("../../ig-public-scraper.js", () => ({ getPublicPostsRetryAt: f.capacity }));
import { enqueuePublicPostsCapacityRetry, publicPostsPoolUnavailable } from "../public-posts-capacity-retry.js";
import { collectionCompletion } from "../collection-completion.js";
const NOW = Date.parse("2026-09-23T23:06:00.000Z"), READY = new Date("2026-09-24T00:00:00.000Z");
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); f.rows = [{ username: "public_fixture" }]; f.predicate = null; f.capacity.mockReset().mockResolvedValue(null); });
afterEach(() => vi.useRealTimers());

describe("public posts capacity wake-up policy", () => {
  it.each(["no available bot in the pool", "[ig-public-scraper] no available bot in the pool", "no bot available"])("recognizes local pool failure: %s", message => {
    expect(publicPostsPoolUnavailable(message)).toBe(true);
  });
  it.each([undefined, "session expired", "checkpoint required", "HTTP 429", "empty feed", "posts disabled", "missing profile"])("does not treat unrelated/permanent failure as known capacity: %s", message => {
    expect(publicPostsPoolUnavailable(message)).toBe(false);
  });
  it("uses a known reset time, exact current target username and stable expiry identity", async () => {
    f.capacity.mockResolvedValue(READY); const add = vi.fn().mockResolvedValue({});
    expect(await enqueuePublicPostsCapacityRetry({ add }, "track")).toEqual(new Date(READY.getTime() + 1000));
    expect(f.capacity).toHaveBeenCalledExactlyOnceWith(new Date(NOW), "public_fixture");
    expect(add).toHaveBeenCalledExactlyOnceWith("collect-profile", {
      trackedAccountId: "track", force: true, source: "public-posts-capacity", capacityObservedAt: new Date(NOW).toISOString(),
    }, { jobId: `public-posts-capacity_track_${READY.getTime()}`, delay: 3_241_000, removeOnComplete: 100, removeOnFail: 50 });
  });
  it("checks current active public entitlement before even predicting capacity", async () => {
    f.rows = []; const add = vi.fn();
    expect(await enqueuePublicPostsCapacityRetry({ add }, "track")).toBeNull();
    expect(f.capacity).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
    const query = new PgDialect().sqlToQuery(f.predicate);
    expect(query.sql).toContain('"tracked_accounts"."is_active"'); expect(query.sql).toContain('"tracked_accounts"."is_private"');
    expect(query.sql).toContain("stripe_customer_id"); expect(query.sql).toContain("stripe_subscription_id"); expect(query.sql).toContain("trial_ends_at");
    expect(query.params).toEqual(expect.arrayContaining(["track", true, false, "public"]));
  });
  it.each([null, new Date(NOW), new Date(NOW - 1), new Date(NaN)])("does not invent a future reset when capacity result is %s", async value => {
    f.capacity.mockResolvedValue(value); const add = vi.fn(); expect(await enqueuePublicPostsCapacityRetry({ add }, "track")).toBeNull(); expect(add).not.toHaveBeenCalled();
  });
  it("deduplicates repeated observations of the same capacity reset", async () => {
    f.capacity.mockResolvedValue(READY); const jobs = new Map<string, unknown>();
    const add = vi.fn(async (_name, data, options) => { if (!jobs.has(options.jobId)) jobs.set(options.jobId, data); });
    await Promise.all([enqueuePublicPostsCapacityRetry({ add }, "track"), enqueuePublicPostsCapacityRetry({ add }, "track", NOW + 500)]);
    expect(jobs.size).toBe(1);
  });
  it("does not report a successful schedule after a queue rejection", async () => {
    f.capacity.mockResolvedValue(READY); const add = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await expect(enqueuePublicPostsCapacityRetry({ add }, "track")).rejects.toThrow("queue unavailable");
  });
});

const source = readFileSync(new URL("../../workers.ts", import.meta.url), "utf8");
const body = source.slice(source.indexOf("function createProfileWorker()"), source.indexOf("// ─── Worker: collection-likes"));
function fixture() {
  const account = { id: "track", userId: "owner", isActive: true, isPrivate: false, accessStatus: "public", igUsername: "public_fixture" };
  const writes: any[] = [], queue = { add: vi.fn().mockResolvedValue({}) };
  const outcome: any = { isPrivate: false, profile: { ok: true, source: "bot" }, posts: { count: 0, source: "bot", error: "no available bot in the pool" }, stories: {}, highlights: {}, followers: {}, following: {} };
  const ctx: any = { Date, Error, Number, process: { env: {} },
    Worker: class { process: any; constructor(_name: string, process: any) { this.process = process; } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    withCorrelation: (_context: any, run: any) => run(), createRedisConnection: () => ({}), LONG_JOB_STALL_OPTIONS: {},
    OperationBusyError: class extends Error {}, leases: new Set<string>(),
    withOperationLease: async (key: string, run: any) => { if (ctx.leases.has(key)) throw new ctx.OperationBusyError(); ctx.leases.add(key); try { return await run(); } finally { ctx.leases.delete(key); } },
    ACCOUNT_REFRESH_JOB_NAME: "account-refresh", trackedAccounts: {}, collectionJobs: {}, profileSnapshots: {},
    eq: () => true, sql: () => true, and: () => true, inArray: () => true, desc: () => true,
    latestCollection: null,
    db: {
      insert: () => ({ values: () => ({ returning: async () => [{ id: "audit" }] }) }), execute: async () => ({ rows: [{ id: "audit" }] }),
      select: () => ({ from: (table: any) => { const query: any = { where: () => query, orderBy: () => query,
        limit: async () => table === ctx.collectionJobs ? (ctx.latestCollection ? [ctx.latestCollection] : []) : [account] }; return query; } }),
      update: () => ({ set: (value: any) => { writes.push(value); return { where: async () => ({}) }; } }),
    },
    customerHasAccess: vi.fn().mockResolvedValue(true), enqueuePrivateCooldownRetry: vi.fn().mockResolvedValue(null),
    enqueuePublicPostsCapacityRetry, publicPostsPoolUnavailable,
    collectPublicData: vi.fn().mockResolvedValue(outcome), collectionCompletion, collectionProfileQueue: queue, collectionLikesQueue: {},
    enqueueLikesAfterProfile: vi.fn().mockResolvedValue("scheduled"), assignBotToTrackedAccount: vi.fn(), botFollowRequestQueue: { add: vi.fn() },
    enqueueDeferredProfileRetry: vi.fn().mockResolvedValue("scheduled"), PROFILE_TEMP_BACKOFF_MS: 60_000,
    profileBackoffAuditUpdate: (_scheduled: boolean, error: string) => ({ status: "failed", completedAt: new Date(), error }),
  };
  vm.createContext(ctx); vm.runInContext(transformSync(body, { loader: "ts", format: "cjs" }).code, ctx);
  const run = (data: any = { trackedAccountId: "track", force: true }, name = "account-refresh") => ctx.createProfileWorker().process({ name, data });
  const recovery = () => ({ trackedAccountId: "track", force: true, source: "public-posts-capacity", capacityObservedAt: new Date(NOW).toISOString() });
  return { account, writes, queue, outcome, ctx, run, recovery };
}

describe("production public partial collection recovery", () => {
  it("preserves the failed partial audit and adds one known-capacity recovery after profile success", async () => {
    const t = fixture(); f.capacity.mockResolvedValue(READY); await t.run();
    expect(t.writes.at(-1)).toMatchObject({ status: "failed", error: "partial collection: posts: no available bot in the pool" });
    expect(t.ctx.collectPublicData).toHaveBeenCalledExactlyOnceWith(t.account); expect(t.queue.add).toHaveBeenCalledTimes(1);
    expect(t.ctx.assignBotToTrackedAccount).not.toHaveBeenCalled();
  });
  it.each(["session expired", "checkpoint required", "HTTP 429", "empty posts feed",
    "empty public feed despite a nonzero profile post count; retained saved posts"])("keeps %s visible without scheduling a speculative capacity retry", async error => {
    const t = fixture(); t.outcome.posts.error = error; f.capacity.mockResolvedValue(READY); await t.run();
    expect(f.capacity).not.toHaveBeenCalled(); expect(t.queue.add).not.toHaveBeenCalled(); expect(t.writes.at(-1).status).toBe("failed");
  });
  it("does not loop when every reader is permanently unavailable and there is no known reset", async () => {
    const t = fixture(); await t.run(); expect(t.queue.add).not.toHaveBeenCalled(); expect(t.writes.at(-1).status).toBe("failed");
  });
  it("defers an extended capacity limit before any provider work", async () => {
    const t = fixture(); f.capacity.mockResolvedValue(new Date(READY.getTime() + 3_600_000));
    expect(await t.run(t.recovery(), "collect-profile")).toMatchObject({ deferred: true });
    expect(t.ctx.collectPublicData).not.toHaveBeenCalled(); expect(t.queue.add).toHaveBeenCalledTimes(1);
  });
  it.each(["inactive", "unentitled"])("does no prediction, enqueue or provider work after %s", async state => {
    const t = fixture(); if (state === "inactive") t.account.isActive = false; else t.ctx.customerHasAccess.mockResolvedValue(false);
    await t.run(t.recovery(), "collect-profile"); expect(f.capacity).not.toHaveBeenCalled(); expect(t.queue.add).not.toHaveBeenCalled(); expect(t.ctx.collectPublicData).not.toHaveBeenCalled();
  });
  it.each(["pending_access", "has_access"])("cannot turn a public recovery into a private follow/read after privacy changes (%s)", async access => {
    const t = fixture(); t.account.isPrivate = true; t.account.accessStatus = access;
    expect(await t.run(t.recovery(), "collect-profile")).toEqual({ skipped: "public-access-changed" });
    expect(f.capacity).not.toHaveBeenCalled(); expect(t.ctx.collectPublicData).not.toHaveBeenCalled(); expect(t.ctx.assignBotToTrackedAccount).not.toHaveBeenCalled();
  });
  it("does not create a follow when the upstream profile turns private during public recovery", async () => {
    const t = fixture(); t.outcome.isPrivate = true; t.outcome.posts.error = "private account";
    await t.run(t.recovery(), "collect-profile");
    expect(t.ctx.assignBotToTrackedAccount).not.toHaveBeenCalled(); expect(t.ctx.botFollowRequestQueue.add).not.toHaveBeenCalled();
    expect(t.queue.add).not.toHaveBeenCalled();
  });
  it("suppresses old/new delayed reset jobs after an intervening complete successful collection", async () => {
    const t = fixture(); f.capacity.mockResolvedValue(READY);
    t.ctx.latestCollection = { status: "completed", error: null, completedAt: new Date(NOW + 50_000) };
    for (const observedAt of [NOW, NOW + 1000]) expect(await t.run({ ...t.recovery(), capacityObservedAt: new Date(observedAt).toISOString() }, "collect-profile"))
      .toEqual({ skipped: "public-already-recovered" });
    expect(t.ctx.collectPublicData).not.toHaveBeenCalled(); expect(t.queue.add).not.toHaveBeenCalled(); expect(f.capacity).not.toHaveBeenCalled();
  });
  it("still retries a newer partial result despite a recent profile", async () => {
    const t = fixture(); t.ctx.latestCollection = { status: "failed", error: "partial collection: posts unavailable", completedAt: new Date(NOW + 1) };
    delete t.outcome.posts.error; await t.run(t.recovery(), "collect-profile"); expect(t.ctx.collectPublicData).toHaveBeenCalledTimes(1);
  });
  it.each(["account-refresh", "collect-profile"])("serializes public recovery against a concurrent %s", async name => {
    const t = fixture(); let done!: () => void; const pending = new Promise<void>(resolve => { done = resolve; });
    t.ctx.collectPublicData.mockImplementation(async () => { await pending; return t.outcome; });
    const first = t.run(name === "collect-profile" ? t.recovery() : undefined, name);
    for (let i = 0; i < 30 && !t.ctx.collectPublicData.mock.calls.length; i++) await Promise.resolve();
    expect(t.ctx.collectPublicData).toHaveBeenCalledTimes(1);
    expect(await t.run(t.recovery(), "collect-profile")).toEqual({ skipped: "profile-in-progress" });
    done(); await first; expect(t.ctx.collectPublicData).toHaveBeenCalledTimes(1); expect(t.ctx.leases.size).toBe(0);
  });
  it("keeps the partial failure visible if queue insertion fails", async () => {
    const t = fixture(); f.capacity.mockResolvedValue(READY); t.queue.add.mockRejectedValue(new Error("queue unavailable")); await t.run();
    expect(t.writes.at(-1)).toMatchObject({ status: "failed", error: "partial collection: posts: no available bot in the pool" });
  });
  it("preserves capacity observation through a generic profile backoff", async () => {
    const t = fixture(); t.outcome.profile = { ok: false, error: "rate limited" };
    await t.run(t.recovery(), "collect-profile");
    expect(t.ctx.enqueueDeferredProfileRetry).toHaveBeenCalledExactlyOnceWith(t.queue, "track", 60_000, NOW,
      { force: true, source: "public-posts-capacity", cooldownObservedAt: undefined, capacityObservedAt: new Date(NOW).toISOString() });
  });
});
