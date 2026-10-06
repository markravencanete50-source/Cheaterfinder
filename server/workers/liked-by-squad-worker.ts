// ─── Liked-by squad worker (Wave 9) ──────────────────────────────────────────
//
// Scheduler + processor for the "liked-by inference" watcher squad. Gated
// entirely behind LIKED_BY_SQUAD_ENABLED (default OFF): shipping this code is
// inert until an operator flips the flag AND has seeded watcher bots via
// server/scripts/assign-liked-by-roles.ts.
//
// Model:
//   - One repeatable "harvest-sweep" job fires every LIKED_BY_SQUAD_INTERVAL_SEC
//     (default 1500s ≈ 25 min).
//   - Each tick, for each kind (feed → feed_watcher bots, reels → reels_watcher
//     bots), it walks the watcher pool SEQUENTIALLY (concurrency 1 worker, no
//     per-target fan-out — "one bot is enough per private-style task"):
//       1. ensureWatcherFollows: follow a bounded rotating slice of active
//          tracked users so the feed facepiles populate.
//       2. harvestLikedBy: poll the feed and persist matched likes into
//          like_events.
//     A rate-limited / circuit-open / auth-expired watcher is skipped (the
//     harvester already cooled a throttled bot) and we ROTATE to the next
//     watcher.
//
// Public API: startLikedBySquadWorker(connection) + getLikedBySquadQueue().
// server/workers.ts wires this in alongside the other opt-in workers.
// ─────────────────────────────────────────────────────────────────────────────

import { Queue, Worker } from "bullmq";
import type IORedis from "ioredis";
import { isShuttingDown } from "../services/shutdown-state.js";

import { logger as baseLogger, withCorrelation } from "../observability/logger.js";
import {
  ensureWatcherFollows,
  harvestLikedBy,
  isRotateSignal,
  loadWatcherBotIds,
  type WatcherKind,
} from "../services/liked-by-harvester.js";

const logger = baseLogger.child({ module: "worker:liked-by-squad" });

const QUEUE_NAME = "liked-by-squad";
const SWEEP_JOB_NAME = "harvest-sweep";

const KINDS: readonly WatcherKind[] = ["feed", "reels"];

function readBoundedIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

// Cadence: default 25 min. Bounded 5 min .. 2 h.
function sweepIntervalMs(): number {
  return readBoundedIntEnv("LIKED_BY_SQUAD_INTERVAL_SEC", 1500, 300, 7200) * 1000;
}

// Follow-maintenance knobs. maxNewFollows=0 disables auto-follow (operator
// manages watcher follows manually) while still harvesting.
function followOptions(): { maxProbes: number; maxNewFollows: number } {
  return {
    maxProbes: readBoundedIntEnv("LIKED_BY_FOLLOW_MAX_PROBES", 12, 0, 100),
    maxNewFollows: readBoundedIntEnv("LIKED_BY_MAX_NEW_FOLLOWS", 6, 0, 30),
  };
}

let queueSingleton: Queue | null = null;

export function getLikedBySquadQueue(connection: IORedis): Queue {
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

interface SweepTotals {
  watchers: number;
  followed: number;
  /** REAL friendship probes sent to IG across all watchers this sweep. */
  probed: number;
  /** Follow targets answered from watcher_follow_state without an IG call. */
  cached: number;
  inserted: number;
  errors: number;
  stoppedEarly: boolean;
}

async function runKind(
  kind: WatcherKind,
  totals: SweepTotals,
): Promise<void> {
  const botIds = await loadWatcherBotIds(kind);
  if (botIds.length === 0) {
    logger.info({ kind }, "no eligible watcher bots for kind; skipping");
    return;
  }
  totals.watchers += botIds.length;

  const follow = followOptions();
  for (const botId of botIds) {
    if (isShuttingDown()) { totals.stoppedEarly=true; break; }
    try {
      const follows = await ensureWatcherFollows(botId, follow);
      totals.followed += follows.followed;
      totals.probed += follows.probed;
      totals.cached += follows.cached;
      if (isShuttingDown()) { totals.stoppedEarly=true; break; }
      const harvest = await harvestLikedBy(botId, kind);
      totals.inserted += harvest.inserted;
      logger.info(
        {
          kind,
          botId,
          followed: follows.followed,
          probed: follows.probed,
          cached: follows.cached,
          fetchedPosts: harvest.fetchedPosts,
          matched: harvest.matched,
          inserted: harvest.inserted,
        },
        "watcher cycle complete",
      );
    } catch (err) {
      totals.errors += 1;
      // Rotate signals are expected churn (throttle / dead session); the
      // harvester already cooled a rate-limited bot. Anything else is logged
      // and we move to the next watcher — one bad watcher never aborts the
      // sweep.
      const rotate = isRotateSignal(err);
      logger.warn(
        {
          kind,
          botId,
          rotate,
          err: err instanceof Error ? err.message : String(err),
        },
        rotate
          ? "watcher throttled/expired; rotating to next"
          : "watcher cycle failed; continuing",
      );
    }
  }
}

async function runHarvestSweep(): Promise<SweepTotals> {
  const totals: SweepTotals = {
    watchers: 0,
    followed: 0,
    probed: 0,
    cached: 0,
    inserted: 0,
    errors: 0,
    stoppedEarly: false,
  };
  for (const kind of KINDS) {
    if (isShuttingDown()) { totals.stoppedEarly=true; break; }
    await runKind(kind, totals);
  }
  return totals;
}

/**
 * Boot the liked-by squad worker. Idempotent per process — call exactly once
 * from workers.ts (only when LIKED_BY_SQUAD_ENABLED is set).
 */
export function startLikedBySquadWorker(connection: IORedis): Worker {
  const queue = getLikedBySquadQueue(connection);
  const intervalMs = sweepIntervalMs();

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== SWEEP_JOB_NAME) {
        logger.warn({ name: job.name }, "unknown liked-by job, skipping");
        return;
      }
      return withCorrelation(
        { module: "worker:liked-by-squad", jobId: String(job.id ?? "") },
        async () => {
          logger.info("running liked-by harvest sweep");
          try {
            const totals = await runHarvestSweep();
            logger.info({ ...totals }, "liked-by harvest sweep complete");
            return totals;
          } catch (err) {
            logger.error(
              { err: err instanceof Error ? err.message : String(err) },
              "liked-by harvest sweep failed",
            );
            throw err;
          }
        },
      );
    },
    // Concurrency 1: watchers are polled serially so we never fan out parallel
    // authenticated traffic across the residential pool.
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, err: err?.message },
      "liked-by job failed",
    );
  });

  void queue
    .add(
      SWEEP_JOB_NAME,
      {},
      { repeat: { every: intervalMs, jobId: "liked-by-harvest-recurring" } },
    )
    .catch((err) =>
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to schedule liked-by harvest sweep",
      ),
    );

  logger.info({ intervalMs }, "liked-by squad worker started");
  return worker;
}

export const __testing = {
  QUEUE_NAME,
  SWEEP_JOB_NAME,
  KINDS,
  sweepIntervalMs,
  followOptions,
  runHarvestSweep,
};
