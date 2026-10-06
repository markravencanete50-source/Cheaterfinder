import type { Queue } from "bullmq";
import { getPrivateReaderRetryAt } from "./private-account-access.js";

/** Wake an approved account after its earliest otherwise-usable reader cools.
 * This never changes a recurring refresh phase or performs a provider action.
 * The worker rechecks access and viewer health when the one-off actually runs. */
export async function enqueuePrivateCooldownRetry(
  queue: Pick<Queue, "add">,
  trackedAccountId: string,
  nowMs = Date.now(),
): Promise<Date | null> {
  const cooldownUntil = await getPrivateReaderRetryAt(trackedAccountId, new Date(nowMs));
  const expiresMs = cooldownUntil?.getTime();
  if (expiresMs === undefined || !Number.isFinite(expiresMs) || expiresMs <= nowMs) return null;
  const retryAt = new Date(expiresMs + 1_000);
  // The observed expiry identifies one recovery attempt even if multiple jobs
  // discover it. A later extended cooldown gets its own safe wake-up; the old
  // job may only recheck/defer, never bypass the newer viewer cooldown.
  await queue.add("collect-profile", {
    trackedAccountId,
    force: true,
    source: "private-cooldown",
    cooldownObservedAt: new Date(nowMs).toISOString(),
  }, {
    jobId: `private-cooldown_${trackedAccountId}_${expiresMs}`,
    delay: retryAt.getTime() - nowMs,
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  return retryAt;
}
