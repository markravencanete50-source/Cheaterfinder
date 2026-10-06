import { and, asc, eq, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { db } from '../db.js';
import { trackedAccounts } from '../../shared/schema.js';
import { assignBotToTrackedAccount } from '../bot-manager.js';
import { customerAccessSql } from './subscription-access.js';

/** One primary and one independently approved backup per private target.
 * Repeated sweeps recover queued work using a stable job id, without issuing
 * another follow. Pending access never authorizes private reads. */
export async function reconcilePrivateFollowCoverage(queue: Pick<Queue, 'add'>): Promise<number> {
  const targets = await db.select({ id: trackedAccounts.id }).from(trackedAccounts)
    .where(and(eq(trackedAccounts.isActive, true), eq(trackedAccounts.isPrivate, true),
      customerAccessSql(trackedAccounts.userId),
      sql`EXISTS (SELECT 1 FROM bot_follow_requests request
        WHERE request.tracked_account_id = ${trackedAccounts.id}
          AND request.status IN ('pending','accepted'))`,
      sql`(EXISTS (SELECT 1 FROM bot_follow_requests queued
          WHERE queued.tracked_account_id = ${trackedAccounts.id} AND queued.status = 'queued')
        OR ((SELECT count(*) FROM bot_follow_requests active
          WHERE active.tracked_account_id = ${trackedAccounts.id}
            AND active.status IN ('queued','pending','accepted')) < 2
          AND (SELECT count(*) FROM bot_follow_requests stopped
            WHERE stopped.tracked_account_id = ${trackedAccounts.id}
              AND stopped.status IN ('failed','expired','rejected')) < 3))`))
    .orderBy(asc(trackedAccounts.updatedAt)).limit(100);
  let queued = 0;
  for (const target of targets) {
    const id = await assignBotToTrackedAccount(target.id, { backup: true });
    if (!id) continue;
    await queue.add('send-follow', { botFollowRequestId: id }, {
      jobId: `private-backup-${id}`, delay: 60_000,
    });
    queued += 1;
  }
  return queued;
}
