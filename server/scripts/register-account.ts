import { Queue } from "bullmq";
import IORedis from "ioredis";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { trackedAccounts } from "../../shared/schema.js";
import { registerAccountRefresh } from "../workers/account-refresh-registrar.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: register-account <tracked_account_id>");
  process.exit(1);
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("collection-profile", { connection });
  const [acc] = await db.select().from(trackedAccounts).where(eq(trackedAccounts.id, id));
  if (!acc) {
    console.error("not found");
    process.exit(1);
  }
  await registerAccountRefresh(queue, acc);
  console.log("registered scheduler for", acc.igUsername, acc.id);
  await queue.close();
  await connection.quit();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
