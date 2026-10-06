// One-off: reactivate tracked accounts and re-register their refresh schedulers.
//
// A raw is_active flip is not enough — each active account needs its per-account
// BullMQ scheduler (`account-refresh:<id>`) registered, exactly as the admin
// PATCH endpoint does. This script performs both, then enqueues an immediate
// force refresh so the account repopulates without waiting for the first tick.
//
//   npx tsx server/scripts/reactivate-accounts.ts <trackedAccountId> [<id> ...]

import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { inArray } from "drizzle-orm";
import { db, pool } from "../db.js";
import { trackedAccounts } from "../../shared/schema.js";
import { registerAccountRefresh } from "../workers/account-refresh-registrar.js";

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter(Boolean);
  if (ids.length === 0) {
    console.error("usage: reactivate-accounts <tracked_account_id> [<id> ...]");
    process.exit(1);
  }

  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("collection-profile", { connection });

  const updated = await db
    .update(trackedAccounts)
    .set({ isActive: true })
    .where(inArray(trackedAccounts.id, ids))
    .returning({ id: trackedAccounts.id, igUsername: trackedAccounts.igUsername });

  for (const row of updated) {
    await registerAccountRefresh(queue, row.id);
    const jobId = `reactivate_${row.id}_${Date.now()}`;
    await queue.add(
      "profile",
      { trackedAccountId: row.id, force: true, source: "reactivate" },
      { jobId, removeOnComplete: 100, removeOnFail: 50 },
    );
    console.log(`[reactivate] active + scheduled + enqueued @${row.igUsername} (${row.id})`);
  }

  console.log(`[reactivate] done count=${updated.length}`);
  await queue.close();
  await connection.quit();
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
