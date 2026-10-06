import { Queue, Worker } from "bullmq";
import type IORedis from "ioredis";
import { logger } from "../observability/logger.js";
import { runBackgroundRosterBatch } from "../services/roster-background-sync.js";
import { setBackgroundRosterWorkerReady } from "../services/roster-background-policy.js";

let queue: Queue | undefined;
export function getBackgroundRosterQueue(connection: IORedis): Queue {
  return queue ??= new Queue("collection-roster", {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
  });
}

/** One durable tick, not a job for each page. Each tick chooses the oldest due
 * canonical target, does at most five pages and releases capacity for others.
 * Restarting reuses the repeat schedule and the atomic database checkpoint.
 */
export function startBackgroundRosterWorker(connection: IORedis): Worker {
  const worker = new Worker("collection-roster", () => runBackgroundRosterBatch(), {
    connection, concurrency: 1,
  });
  getBackgroundRosterQueue(connection).add("roster-batch", {}, {
    repeat: { every: 60_000, jobId: "roster-background-recurring" },
  }).then(() => {
    setBackgroundRosterWorkerReady(true);
    logger.info({ module: "workers" }, "bounded background roster worker scheduled");
  }).catch(error => {
    setBackgroundRosterWorkerReady(false);
    logger.error({ error, module: "workers" }, "background roster schedule failed; collector delegation disabled");
  });
  worker.on("closing", () => setBackgroundRosterWorkerReady(false));
  return worker;
}
