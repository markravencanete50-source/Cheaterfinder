// ─── Bot warmer worker (Wave 6) ──────────────────────────────────────────────
//
// Daily scheduler + processor for bot account warming.
//
// Scheduling model:
//   - One repeatable BullMQ job ("warming-sweep") fires every hour.
//   - On each tick, the sweep enumerates bots with `warming_day < 7` AND
//     `last_login_at IS NOT NULL` AND have NOT been touched (by warming or
//     a real scrape) in the last 1h.
//   - For each candidate, the sweep enqueues a "warm-bot" job with a random
//     delay 0..14h. This staggers warming across the 09:00-23:00 window so
//     the whole pool doesn't hit IG at the same minute.
//
// Worker model:
//   - One worker, concurrency 1, processes the "warm-bot" jobs serially.
//     This avoids hammering the proxy and respects per-bot isolation.
//
// Public API exported here is just `startBotWarmerWorker(connection)` and
// `getBotWarmerQueue()`. The main `server/workers.ts` boot loop wires this
// in alongside the other workers.
// ─────────────────────────────────────────────────────────────────────────────

import { Queue, Worker, type Job } from "bullmq";
import type IORedis from "ioredis";

import { logger as baseLogger, withCorrelation } from "../observability/logger.js";
import {
  findWarmingCandidates,
  intensityForWarmingDay,
  warmBot,
  type WarmIntensity,
  type WarmOutcome,
} from "../services/bot-warmer.js";

const logger = baseLogger.child({ module: "worker:bot-warmer" });

const QUEUE_NAME = "bot-warmer";
const SWEEP_JOB_NAME = "warming-sweep";
const WARM_JOB_NAME = "warm-bot";

/** Sweep cadence — once per hour. The sweep itself is cheap; the per-bot
 *  jobs it enqueues carry randomised delays that spread the actual warming
 *  load over the 14-hour active window. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Bots are warmed during the 09:00-23:00 server-time window. The sweep
 *  picks a random delay 0..14h per bot so they don't cluster. */
const WARM_WINDOW_HOURS = 14;

/** Skip warming for any bot that did a real scrape (or warm) within the
 *  last hour — avoids double-burning the daily request budget. */
// How long a bot must have been idle (no lease, no warm) before it is a warming
// candidate. This was a fixed 1h — against a web pool that is leased around the
// clock, no bot was ever idle that long, so the sweep found 0 candidates for
// days and 59 bots never left warming_day 0. Warming is ordinary browsing; it is
// safe to interleave with collection, and the per-bot-per-day jobId already
// caps it at one warm session a day. WARMER_IDLE_MINUTES (default 20, 1..240).
const SCRAPE_COOLDOWN_MS = (() => {
  const raw = Number(process.env.WARMER_IDLE_MINUTES ?? "20");
  const minutes = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 240) : 20;
  return minutes * 60 * 1000;
})();

interface WarmJobPayload {
  readonly botId: string;
  readonly intensity: WarmIntensity;
}

let queueSingleton: Queue | null = null;

export function getBotWarmerQueue(connection: IORedis): Queue {
  if (queueSingleton) return queueSingleton;
  queueSingleton = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 25 },
    },
  });
  return queueSingleton;
}

function pickStaggeredDelayMs(): number {
  const span = WARM_WINDOW_HOURS * 60 * 60 * 1000;
  return Math.floor(Math.random() * span);
}

async function runWarmingSweep(connection: IORedis): Promise<{
  scanned: number;
  enqueued: number;
}> {
  const candidates = await findWarmingCandidates(SCRAPE_COOLDOWN_MS);
  if (candidates.length === 0) {
    return { scanned: 0, enqueued: 0 };
  }

  const queue = getBotWarmerQueue(connection);
  let enqueued = 0;
  let deduped = 0;
  for (const candidate of candidates) {
    const intensity = intensityForWarmingDay(candidate.warmingDay);
    const delay = pickStaggeredDelayMs();
    const payload: WarmJobPayload = {
      botId: candidate.botId,
      intensity,
    };
    // Stable per-bot-per-day jobId stops duplicates if the sweep fires twice
    // within the same day (ops restart, etc.). BullMQ does NOT throw on a
    // duplicate id — it silently returns the existing job — so a same-day husk
    // that FAILED for a transient reason (no proxy lane, stalled by a deploy)
    // would block the bot's warm for the rest of the day. Remove such husks
    // and re-add; leave completed jobs and permanent failures alone.
    const jobId = warmJobId(candidate.botId);
    try {
      const existing = await queue.getJob(jobId);
      if (existing) {
        const failedReason = existing.failedReason ?? "";
        const isFailed = await existing.isFailed();
        if (isFailed && isTransientWarmFailure(failedReason)) {
          await existing.remove();
          logger.info(
            { botId: candidate.botId, jobId, failedReason: failedReason.slice(0, 160) },
            "[warming-sweep] removed transient failed husk; re-enqueueing",
          );
        } else {
          deduped += 1;
          logger.debug(
            { botId: candidate.botId, jobId, failedReason: failedReason.slice(0, 160) || null },
            "[warming-sweep] same-day warm job already present; not re-adding",
          );
          continue;
        }
      }
      await queue.add(WARM_JOB_NAME, payload, { delay, jobId });
      enqueued += 1;
    } catch (err) {
      // A real error (Redis unavailable, serialisation) — never a duplicate.
      logger.error(
        {
          botId: candidate.botId,
          jobId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[warming-sweep] enqueue failed",
      );
    }
  }
  if (deduped > 0) {
    logger.info({ deduped }, "[warming-sweep] candidates already scheduled today");
  }
  return { scanned: candidates.length, enqueued };
}

function warmJobId(botId: string, now: Date = new Date()): string {
  return `warm:${botId}:${now.toISOString().slice(0, 10)}`;
}

/**
 * Failed-job reasons that describe a passing condition, not a verdict on the
 * bot: no proxy lane at that moment, a deploy stalling the job, a transport
 * blip. Exported for tests.
 */
export function isTransientWarmFailure(reason: string | null | undefined): boolean {
  const r = (reason ?? "").toLowerCase();
  if (!r) return false;
  return (
    r.includes("proxy lane") ||
    r.includes("refusing ip rotation") ||
    r.includes("stalled") ||
    r.includes("failed to obtain healthy proxy") ||
    r.includes("econnreset") ||
    r.includes("etimedout") ||
    r.includes("socket hang up")
  );
}

async function processWarmJob(job: Job<WarmJobPayload>): Promise<WarmOutcome> {
  const { botId, intensity } = job.data;
  return withCorrelation(
    { module: "worker:bot-warmer", botId, jobId: String(job.id ?? "") },
    async () => {
      logger.info({ botId, intensity }, "starting warm-bot job");
      const outcome = await warmBot(botId, { intensity });
      logger.info(
        {
          botId,
          actionsCompleted: outcome.actionsCompleted,
          actionsFailed: outcome.actionsFailed,
          advancedToDay: outcome.advancedToDay,
          endedBy: outcome.endedBy,
        },
        "warm-bot job complete",
      );
      return outcome;
    },
  );
}

/**
 * Boot the bot-warmer worker. Idempotent — calling twice would create two
 * workers, so the main `workers.ts` loop should call this exactly once.
 */
export function startBotWarmerWorker(connection: IORedis): Worker {
  const queue = getBotWarmerQueue(connection);

  const worker = new Worker<WarmJobPayload | Record<string, never>>(
    QUEUE_NAME,
    async (job) => {
      if (job.name === SWEEP_JOB_NAME) {
        return withCorrelation(
          { module: "worker:bot-warmer", jobId: String(job.id ?? "") },
          async () => {
            logger.info("running warming sweep");
            try {
              const { scanned, enqueued } = await runWarmingSweep(connection);
              logger.info({ scanned, enqueued }, "warming sweep complete");
              return { scanned, enqueued };
            } catch (err) {
              logger.error({ err }, "warming sweep failed");
              throw err;
            }
          },
        );
      }
      if (job.name === WARM_JOB_NAME) {
        return processWarmJob(job as Job<WarmJobPayload>);
      }
      logger.warn({ name: job.name }, "unknown bot-warmer job, skipping");
    },
    {
      connection,
      // CRITICAL: concurrency 1 — only one bot warms at a time. Two warming
      // bots in parallel would compete for proxy CONNECT tunnels and create
      // a sustained spike that defeats the whole "look like a real user"
      // exercise.
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, err: err.message },
      "bot-warmer job failed",
    );
  });

  // Schedule the recurring sweep.
  void queue
    .add(
      SWEEP_JOB_NAME,
      {},
      {
        repeat: {
          every: SWEEP_INTERVAL_MS,
          jobId: "bot-warmer-sweep-recurring",
        },
      },
    )
    .catch((err) =>
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to schedule warming sweep",
      ),
    );

  // Boot tick: run a sweep ~10s after startup so a fresh deploy doesn't wait
  // a full hour for the first warming round.
  void queue
    .add(SWEEP_JOB_NAME, {}, { delay: 10_000, jobId: undefined })
    .catch((err) =>
      // No jobId here, so this can never be a duplicate — it is a real fault.
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to schedule boot warming sweep",
      ),
    );

  logger.info(
    {
      sweepIntervalMs: SWEEP_INTERVAL_MS,
      warmWindowHours: WARM_WINDOW_HOURS,
    },
    "bot-warmer worker started",
  );
  return worker;
}

export const __testing = {
  QUEUE_NAME,
  SWEEP_JOB_NAME,
  WARM_JOB_NAME,
  SWEEP_INTERVAL_MS,
  WARM_WINDOW_HOURS,
  SCRAPE_COOLDOWN_MS,
  pickStaggeredDelayMs,
  warmJobId,
  isTransientWarmFailure,
};
