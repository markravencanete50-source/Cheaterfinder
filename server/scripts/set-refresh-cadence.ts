// Set the scraping refresh cadence live (no restart) and re-register every
// active account's scheduler at the new interval. Mirrors the admin
// PUT /api/admin/refresh-interval path.
//
//   npx tsx server/scripts/set-refresh-cadence.ts <seconds>

import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { pool } from "../db.js";
import { setRefreshInterval } from "../services/refresh-config.js";
import { reconcileAccountRefreshes } from "../workers/account-refresh-registrar.js";

async function main(): Promise<void> {
  const sec = Number(process.argv[2]);
  if (!Number.isFinite(sec) || sec <= 0) {
    console.error("usage: set-refresh-cadence <seconds>");
    process.exit(1);
  }
  const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue("collection-profile", { connection });

  const cfg = await setRefreshInterval(sec, "agent-cadence-fix");
  const rec = await reconcileAccountRefreshes(queue);

  console.log(
    `[cadence] set intervalSec=${cfg.intervalSec} (source=${cfg.source}); reconcile added=${rec.added} removed=${rec.removed} active=${rec.active}`,
  );

  await queue.close();
  await connection.quit();
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
