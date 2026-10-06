// One-shot: enqueue an immediate profile-collection job for a tracked username
// so the worker fetches & persists fresh data right now.
//
//   npx tsx --env-file=.env server/scripts/force-refresh.ts wire.fluid

import IORedis from "ioredis";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

function createRedisConnection(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}

async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username) {
    throw new Error("usage: force-refresh.ts <ig_username>");
  }

  const result = (await db.execute(sql`
    SELECT id
    FROM tracked_accounts
    WHERE LOWER(ig_username) = LOWER(${username})
    ORDER BY is_active DESC, updated_at DESC
    LIMIT 1
  `)) as unknown as { rows: Array<{ id: string }> };
  const tracked = result.rows[0];
  if (!tracked) {
    throw new Error(`no tracked_account for ${username}`);
  }

  const connection = createRedisConnection();
  const queue = new Queue("collection-profile", { connection });
  const job = await queue.add(
    "profile",
    { trackedAccountId: tracked.id, force: true, source: "manual-force" },
    { removeOnComplete: 100, removeOnFail: 50 },
  );
  console.log(`enqueued profile job ${job.id} for ${username} (${tracked.id})`);
  await queue.close();
  await connection.quit();
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
