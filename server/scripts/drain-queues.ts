// One-shot: drain pending jobs from all bot-related BullMQ queues so the
// next server start doesn't immediately re-trigger a flood of IG calls.
// Keeps queue config (meta) intact — only wipes wait/delayed/active job
// payloads + the repeat schedules so bot-pool-rescue doesn't auto-reschedule.

import { Queue } from "bullmq";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const url = new URL(REDIS_URL);
const connection = {
  host: url.hostname,
  port: Number(url.port) || 6379,
  password: url.password || undefined,
};

const QUEUES = [
  "collection-profile",
  "collection-likes",
  "collection-follows",
  "bot-pool-rescue",
  "bot-follow-check",
  "bot-follow-request",
  "bot-warmer",
  "bot-cooldown-probe",
  "refresh-sweep",
  "report-generate",
  "email-send",
  "retention",
];

interface QueueState {
  name: string;
  wait: number;
  delayed: number;
  active: number;
  removed: number;
  repeatables: number;
}

async function drainQueue(name: string): Promise<QueueState> {
  const q = new Queue(name, { connection });
  const before = await q.getJobCounts("wait", "delayed", "active", "paused");
  const repeatables = await q.getRepeatableJobs();

  // Drain wait + delayed; do NOT touch active (BullMQ refuses, and they will
  // expire naturally when the worker process is gone).
  await q.drain(true).catch(() => undefined);

  // Remove every repeatable schedule so bot-pool-rescue doesn't immediately
  // re-enqueue itself on next worker boot. startWorkers() re-registers them
  // when WORKERS_DISABLED is unset, so this is a transient cleanup.
  for (const r of repeatables) {
    await q.removeRepeatableByKey(r.key).catch(() => undefined);
  }

  const after = await q.getJobCounts("wait", "delayed", "active");
  await q.close();
  return {
    name,
    wait: before.wait,
    delayed: before.delayed,
    active: before.active,
    removed: (before.wait - after.wait) + (before.delayed - after.delayed),
    repeatables: repeatables.length,
  };
}

const results = await Promise.all(QUEUES.map(drainQueue));
console.log(
  results
    .map(
      (r) =>
        `${r.name.padEnd(22)} wait=${r.wait} delayed=${r.delayed} active=${r.active} removed=${r.removed} repeatables=${r.repeatables}`,
    )
    .join("\n"),
);
console.log("\nDrain complete.");
process.exit(0);
