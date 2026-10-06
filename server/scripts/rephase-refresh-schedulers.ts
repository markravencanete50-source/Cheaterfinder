import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  ACCOUNT_REFRESH_PREFIX,
  computeRefreshOffsetMs,
  registerAccountRefresh,
  unregisterAccountRefresh,
} from "../workers/account-refresh-registrar.js";

/**
 * One-off: give every ACTIVE tracked account's refresh scheduler its stable,
 * account-specific phase.
 *
 * BullMQ pins an `every` scheduler's phase at creation and ignores `startDate`
 * on later upserts, so the stagger shipped in `registerAccountRefresh` only
 * reaches schedulers created after the deploy. The nine live ones still share
 * the phase reconcile gave them (all within 24 ms). Remove + re-register each
 * one back to back; the gap is milliseconds and the next tick lands at the
 * hashed offset inside the current interval.
 */
async function main(): Promise<void> {
  const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue("collection-profile", { connection });
  try {
    const { rows } = (await db.execute(sql`
      SELECT id, ig_username FROM tracked_accounts WHERE is_active = true ORDER BY ig_username
    `)) as unknown as { rows: Array<{ id: string; ig_username: string }> };

    for (const row of rows) {
      await unregisterAccountRefresh(queue, row.id);
      await registerAccountRefresh(queue, row.id);
      console.log(`[rephase] ${row.ig_username} ${row.id.slice(0, 8)} re-registered`);
    }

    const schedulers = await queue.getJobSchedulers(0, -1, true);
    const buckets = new Map<number, number>();
    for (const s of schedulers) {
      if (!s.id?.startsWith(ACCOUNT_REFRESH_PREFIX) || !s.every) continue;
      const every = Number(s.every);
      const accountId = s.id.slice(ACCOUNT_REFRESH_PREFIX.length);
      const expected = computeRefreshOffsetMs(accountId, every);
      const next = s.next ?? 0;
      const bucket = Math.floor((next % every) / 600_000);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      const drift = Math.abs((next % every) - expected);
      console.log(
        `[rephase] ${accountId.slice(0, 8)} next=${new Date(next).toISOString().slice(11, 19)}Z ` +
          `bucket=${bucket} phaseDriftMs=${drift}`,
      );
    }
    console.log(
      `[rephase] ${schedulers.length} schedulers across ${buckets.size} distinct 10-minute buckets`,
    );
  } finally {
    await queue.close();
    await connection.quit();
  }
}

main().catch((err) => {
  console.error("[rephase] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
