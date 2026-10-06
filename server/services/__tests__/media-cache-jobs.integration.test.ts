// Opt-in, real BullMQ/Redis regression tests. This suite starts and stops its
// own empty Redis instance; it never uses a supplied REDIS_URL or provider.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Worker, type Job } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ cache: vi.fn() }));
vi.mock("../../observability/logger.js", () => ({ logger: { error: vi.fn() } }));
vi.mock("../media-cache.js", () => ({
  isAllowedMediaUrl: (url: string) => url.startsWith("https://scontent.cdninstagram.com/"),
  mediaCacheKey: (url: string) => new URL(url).pathname.slice(1),
  resolveCachedMediaUrls: async () => new Map(),
  cacheMediaUrl: f.cache,
}));

describe.runIf(process.env.MEDIA_CACHE_REDIS_INTEGRATION === "1")("media repair jobs (isolated real Redis)", () => {
  let redis: ChildProcess | undefined, dir: string, port: number;
  let jobs: typeof import("../media-cache-jobs.js");
  const workers: Worker[] = [];

  async function waitForState(job: Job, expected: string) {
    const until = Date.now() + 8_000;
    while (Date.now() < until) {
      if (await job.getState() === expected) return;
      await pause(20);
    }
    throw new Error(`Fixture job did not reach ${expected}; actual ${await job.getState()}`);
  }
  function startWorker() {
    const worker = new Worker("media-cache", job => jobs.processMediaCacheUrl(job.data.url), {
      connection: { host: "127.0.0.1", port }, concurrency: 1,
    });
    worker.on("error", () => {});
    workers.push(worker);
    return worker;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cheaterfinder-media-queue-test-"));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    if (port === 6379) throw new Error("Refusing production Redis port");
    redis = spawn("/usr/bin/redis-server", [
      "--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no",
      "--maxmemory", "32mb", "--maxmemory-policy", "noeviction", "--dir", dir,
    ], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Isolated Redis startup timed out")), 5_000);
      redis!.once("error", error => { clearTimeout(timer); reject(error); });
      redis!.once("exit", () => { clearTimeout(timer); reject(new Error("Isolated Redis exited during startup")); });
      redis!.stdout!.on("data", chunk => {
        if (chunk.toString().includes("Ready to accept connections")) { clearTimeout(timer); resolve(); }
      });
    });
    vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${port}/0`);
    jobs = await import("../media-cache-jobs.js");
    await jobs.mediaCacheQueue.waitUntilReady();
  }, 10_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(workers.splice(0).map(worker => worker.close()));
    f.cache.mockReset();
  });
  afterAll(async () => {
    if (jobs) {
      const client = await jobs.mediaCacheQueue.client;
      await jobs.mediaCacheQueue.close();
      client.disconnect();
    }
    if (redis && redis.exitCode == null && redis.signalCode == null) {
      const exited = new Promise<void>(resolve => redis!.once("exit", () => resolve()));
      redis.kill("SIGTERM");
      await exited;
    }
    if (dir) await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each(["completed", "failed"] as const)("concurrent repair of a retained %s job queues exactly one attempt", async state => {
    const old = `https://scontent.cdninstagram.com/${state}.jpg?sig=old`;
    const fresh = old.replace("sig=old", "sig=new");
    const jobId = `media-${state}.jpg`;
    f.cache.mockResolvedValue({ cacheKey: `${state}.jpg`, status: state === "failed" ? "failed" : "cached" });
    const seed = await jobs.mediaCacheQueue.add("cache-media", { url: old }, {
      jobId, attempts: 1, removeOnComplete: false, removeOnFail: false,
    });
    const worker = startWorker();
    await waitForState(seed, state);
    await worker.close();
    f.cache.mockReset().mockResolvedValue({ cacheKey: `${state}.jpg`, status: "cached" });

    // Synchronize only the observation: both callers see the terminal state.
    // The ensuing updateData/retry operations use real BullMQ Redis scripts.
    let arrivals = 0, release!: () => void;
    const observed = new Promise<void>(resolve => { release = resolve; });
    const getJob = jobs.mediaCacheQueue.getJob.bind(jobs.mediaCacheQueue);
    const spy = vi.spyOn(jobs.mediaCacheQueue, "getJob").mockImplementation(async id => {
      const job = await getJob(id);
      if (job?.id === jobId) {
        const getState = job.getState.bind(job);
        job.getState = async () => {
          const current = await getState();
          if (++arrivals === 2) release();
          await observed;
          return current;
        };
      }
      return job;
    });
    const results = await Promise.all([jobs.enqueueMediaCacheUrls([fresh]), jobs.enqueueMediaCacheUrls([fresh])]);
    spy.mockRestore();
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    const waiting = await jobs.mediaCacheQueue.getWaiting();
    expect(waiting.map(job => job.id)).toEqual([jobId]);
    expect(waiting[0].data.url).toBe(fresh);
    expect(waiting[0].attemptsMade).toBe(0);
    startWorker();
    await waitForState(waiting[0], "completed");
    expect(f.cache).toHaveBeenCalledExactlyOnceWith(fresh);
  }, 15_000);

  it("a failed cache result causes a delayed BullMQ retry, then a real completion", async () => {
    const url = "https://scontent.cdninstagram.com/retry.jpg";
    f.cache.mockResolvedValueOnce({ cacheKey: "retry.jpg", status: "failed" })
      .mockResolvedValueOnce({ cacheKey: "retry.jpg", status: "cached" });
    const job = await jobs.mediaCacheQueue.add("cache-media", { url }, {
      jobId: "media-retry.jpg", attempts: 2, backoff: { type: "fixed", delay: 400 }, removeOnComplete: false,
    });
    startWorker();
    await waitForState(job, "delayed");
    expect(f.cache).toHaveBeenCalledTimes(1);
    await waitForState(job, "completed");
    expect(f.cache).toHaveBeenCalledTimes(2);
    const completed = await jobs.mediaCacheQueue.getJob(job.id!);
    expect(completed?.attemptsMade).toBe(2);
    expect(completed?.returnvalue).toMatchObject({ status: "cached" });
  }, 15_000);
});
