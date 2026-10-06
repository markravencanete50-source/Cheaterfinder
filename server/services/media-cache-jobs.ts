import { Queue } from "bullmq";
import IORedis from "ioredis";
import { cacheMediaUrl, isAllowedMediaUrl, mediaCacheKey, resolveCachedMediaUrls } from "./media-cache.js";
import { logger } from "../observability/logger.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
connection.on("error", (err) =>
  logger.error({ module: "redis", queue: "media-cache", err: err.message }, "redis error"),
);

export const mediaCacheQueue = new Queue("media-cache", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 15000 },
    removeOnComplete: true,
    removeOnFail: { count: 50 },
  },
});

export async function enqueueMediaCacheUrls(
  urls: Iterable<string | null | undefined>,
  reason = "viewer",
): Promise<number> {
  const originals = Array.from(
    new Set(
      Array.from(urls)
        .filter((url): url is string => typeof url === "string" && url.length > 0)
        .filter(isAllowedMediaUrl),
    ),
  );

  if (originals.length === 0) return 0;

  const cached = await resolveCachedMediaUrls(originals);
  const missing = new Map<string, string>();
  for (const url of originals) {
    if (!cached.has(url)) missing.set(mediaCacheKey(url), url);
  }
  const pending: Array<{ name: string; data: { url: string; reason: string }; opts: { jobId: string } }> = [];
  let recovered = 0;
  for (const [key, url] of missing) {
    const jobId = `media-${key}`;
    const existing = await mediaCacheQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") {
        // Recover retained jobs from older releases and allow a new signature
        // to repair a failed asset. Repeated views cannot hot-loop a dead URL.
        if (state === "failed" && existing.data.url === url &&
            Date.now() - (existing.finishedOn ?? existing.timestamp) < 10 * 60_000) continue;
        try {
          await existing.updateData({ url, reason });
          // BullMQ atomically checks the terminal set. Removing by id after
          // getState could instead delete another caller's replacement job.
          await existing.retry(state, { resetAttemptsMade: true, resetAttemptsStarted: true });
          recovered++;
          continue;
        } catch (error) {
          const code = (error as { code?: number }).code;
          if (code === -3) continue; // Another caller already recovered it.
          if (code !== -1) throw error; // Removed by retention: add below.
        }
      } else if (state !== "unknown") {
        // Preserve a running attempt, but give queued retries the newest URL.
        if (state !== "active" && existing.data.url !== url) await existing.updateData({ url, reason });
        continue;
      }
    }
    pending.push({
      name: "cache-media",
      data: { url, reason },
      // BullMQ reserves ':' in custom job ids, so keep this delimiter simple.
      opts: { jobId },
    });
  }
  if (pending.length) await mediaCacheQueue.addBulk(pending);
  return pending.length + recovered;
}

export async function processMediaCacheUrl(url: string) {
  const result = await cacheMediaUrl(url);
  // BullMQ only retries rejected attempts. A failed cache result must not be
  // recorded as a completed job that permanently suppresses future repairs.
  if (result.status === "failed") throw new Error("media cache download failed");
  return result;
}
