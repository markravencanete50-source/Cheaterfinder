// Pause / resume all collection queues.
//
// Used when the upstream proxy is dead: every scrape attempted through a dead
// gateway is a wasted bot call that can strike an endpoint breaker or get a
// session flagged, so collection is halted at the queue rather than left to
// fail request-by-request. Pausing (not deleting) keeps every queued job and
// every repeatable scheduler intact, so `resume` restores the prior state.
import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const QUEUES = [
  "collection-profile",
  "collection-likes",
  "collection-follows",
] as const;

async function main() {
  const action = (process.argv[2] ?? "").toLowerCase();
  if (action !== "pause" && action !== "resume" && action !== "status") {
    console.error("usage: collection-pause <pause|resume|status>");
    process.exit(1);
  }
  const connection = new IORedis(
    process.env.REDIS_URL || "redis://127.0.0.1:6379",
    { maxRetriesPerRequest: null },
  );
  for (const name of QUEUES) {
    const q = new Queue(name, { connection });
    try {
      if (action === "pause") await q.pause();
      if (action === "resume") await q.resume();
      const paused = await q.isPaused();
      const counts = await q.getJobCounts("wait", "active", "delayed");
      console.log(
        `[collection] ${name}: paused=${paused} wait=${counts.wait} active=${counts.active} delayed=${counts.delayed}`,
      );
    } catch (err) {
      console.error(
        `[collection] ${name}: FAILED ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await q.close();
    }
  }
  await connection.quit();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
