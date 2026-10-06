import { and, eq } from "drizzle-orm";
import type { Queue } from "bullmq";
import { db } from "../db.js";
import { trackedAccounts } from "../../shared/schema.js";
import { getPublicPostsRetryAt } from "../ig-public-scraper.js";
import { customerAccessSql } from "./subscription-access.js";

/** This local admission failure occurs before an upstream posts request. */
export function publicPostsPoolUnavailable(error: string | undefined): boolean {
  return typeof error === "string" && (/no available bot in the pool/i.test(error) || /^no bot available$/i.test(error.trim()));
}

/** Read-only readiness prediction; normal worker/lease/quota gates still own
 * execution. No configuration, bot counters or recurring phase is changed. */
export async function enqueuePublicPostsCapacityRetry(
  queue: Pick<Queue, "add">,
  trackedAccountId: string,
  nowMs = Date.now(),
): Promise<Date | null> {
  const [account] = await db.select({ username: trackedAccounts.igUsername })
    .from(trackedAccounts).where(and(eq(trackedAccounts.id, trackedAccountId), eq(trackedAccounts.isActive, true),
      eq(trackedAccounts.isPrivate, false), eq(trackedAccounts.accessStatus, "public"),
      customerAccessSql(trackedAccounts.userId))).limit(1);
  if (!account) return null;
  const availableAt = await getPublicPostsRetryAt(new Date(nowMs), account.username);
  const expiresMs = availableAt?.getTime();
  if (expiresMs === undefined || !Number.isFinite(expiresMs) || expiresMs <= nowMs) return null;
  const retryAt = new Date(expiresMs + 1_000);
  await queue.add("collect-profile", {
    trackedAccountId,
    force: true,
    source: "public-posts-capacity",
    capacityObservedAt: new Date(nowMs).toISOString(),
  }, {
    jobId: `public-posts-capacity_${trackedAccountId}_${expiresMs}`,
    delay: retryAt.getTime() - nowMs,
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  return retryAt;
}
