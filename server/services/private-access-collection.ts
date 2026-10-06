import { and, eq, inArray, sql } from "drizzle-orm";
import type { Queue } from "bullmq";
import { db } from "../db.js";
import { botFollowRequests, trackedAccounts } from "../../shared/schema.js";
import { customerAccessSql } from "./subscription-access.js";
import { markFollowRequestAccepted } from "../bot-manager.js";

/** Recover a committed approval whose immediate Redis enqueue was interrupted.
 * Stable job IDs make repeated checks safe; no Instagram follow is repeated. */
export async function reconcilePrivateAccessCollections(queue: Pick<Queue, "add">): Promise<number> {
  const rows = await db.select({ id: botFollowRequests.id, trackedAccountId: trackedAccounts.id,
    userId: trackedAccounts.userId, accessStatus: trackedAccounts.accessStatus })
    .from(botFollowRequests)
    .innerJoin(trackedAccounts, eq(botFollowRequests.trackedAccountId, trackedAccounts.id))
    .where(and(
      eq(botFollowRequests.status, "accepted"), eq(trackedAccounts.isActive, true),
      eq(trackedAccounts.isPrivate, true), inArray(trackedAccounts.accessStatus, ["has_access", "pending_access", "access_denied"]),
      customerAccessSql(trackedAccounts.userId),
      sql`(${trackedAccounts.accessStatus} <> 'has_access'
        OR ${trackedAccounts.lastProfileRefreshAt} IS NULL
        OR ${trackedAccounts.lastProfileRefreshAt} < ${botFollowRequests.resolvedAt})`,
    ))
    .orderBy(botFollowRequests.resolvedAt).limit(100);
  for (const row of rows) {
    if (row.accessStatus !== "has_access") {
      await markFollowRequestAccepted(row.id, row.userId);
    }
    await queue.add("collect-profile", { trackedAccountId: row.trackedAccountId, force: true, source: "private-access-granted" },
      { jobId: `private-access-${row.id}` });
  }
  return rows.length;
}
