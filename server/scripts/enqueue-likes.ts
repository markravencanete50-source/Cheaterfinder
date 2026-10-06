import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
async function main() {
  const ids = process.argv.slice(2).filter(Boolean);
  if (!ids.length) { console.error("usage: enqueue-likes <tracked_id> ..."); process.exit(1); }
  const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
  // Same retention as the production queue: without these every manual job husk
  // lived in Redis forever (the audit found completed=103 > the 100 cap).
  const q = new Queue("collection-likes", {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 50 } },
  });
  for (const id of ids) {
    await q.add("likes", { trackedAccountId: id }, { jobId: `manual-likes_${id}_${Math.floor(process.hrtime()[0])}` });
    console.log(`[enqueue-likes] queued ${id}`);
  }
  await q.close(); await connection.quit();
}
main().catch((e) => { console.error(e); process.exit(1); });
