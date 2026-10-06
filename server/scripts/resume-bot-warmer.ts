// One-shot: resume the bot-warmer queue.
//
// Why: the queue was left PAUSED (meta.paused=1) with jobs stranded in the
// paused list. A paused queue means the hourly warming sweep never runs, so
// bot_accounts.warming_day never advances past 0. Day 0 caps likers/stories/
// comments/highlights at ZERO (see server/behavior/daily-budget.ts BUDGET_TABLE),
// which made like-event collection structurally impossible pool-wide — the
// "No like events found" symptom — for as long as the queue stayed paused.
//
// Nothing in the codebase pauses this queue, so resuming is durable: only a
// manual pause could stop it again.
//
//   npx tsx server/scripts/resume-bot-warmer.ts

import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("bot-warmer", { connection });

  const before = await queue.getJobCounts(
    "wait",
    "active",
    "delayed",
    "paused",
    "failed",
  );
  const wasPaused = await queue.isPaused();
  console.log(
    `[resume-bot-warmer] before: paused=${wasPaused} counts=${JSON.stringify(before)}`,
  );

  if (wasPaused) {
    await queue.resume();
    console.log("[resume-bot-warmer] queue resumed");
  } else {
    console.log("[resume-bot-warmer] queue was not paused — no action");
  }

  const after = await queue.getJobCounts(
    "wait",
    "active",
    "delayed",
    "paused",
    "failed",
  );
  console.log(
    `[resume-bot-warmer] after:  paused=${await queue.isPaused()} counts=${JSON.stringify(after)}`,
  );

  await queue.close();
  await connection.quit();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
