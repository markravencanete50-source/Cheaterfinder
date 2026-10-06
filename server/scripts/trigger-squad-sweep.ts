// Fire the liked-by squad's harvest sweep immediately instead of waiting for the
// next 25-minute repeatable tick.
import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";

async function main() {
  const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
  const q = new Queue("liked-by-squad", { connection });
  const job = await q.add("harvest-sweep", {}, { jobId: `manual-sweep-${Date.now()}`, removeOnComplete: 20, removeOnFail: 10 });
  console.log(`[sweep] enqueued job ${job.id}`);
  await q.close(); await connection.quit();
}
main().catch((e) => { console.error("[sweep]", e?.message ?? e); process.exit(1); });
