import type { CollectOutcome } from "./public-data-collector.js";

/** A successful profile read says nothing about the other requested features. */
export function collectionCompletion(outcome: CollectOutcome): {
  status: "completed" | "failed";
  error: string | null;
} {
  const failures: string[] = [];
  if (!outcome.profile.ok) failures.push(`profile: ${outcome.profile.error ?? "read failed"}`);
  for (const feature of ["posts", "stories", "highlights", "following", "followers"] as const) {
    const error = outcome[feature].error;
    if (!error || error === "private account" || /^(posts|stories|highlights|follow graph) disabled$/.test(error)) continue;
    // A restriction cooldown is not evidence that the data is complete.
    if (error.startsWith("skipped:") && !error.includes("restricted-backoff")) continue;
    failures.push(`${feature}: ${error}`);
  }
  if (outcome.engagement?.error) failures.push(`engagement: ${outcome.engagement.error}`);
  for (const feature of ["likers", "comments"] as const) {
    const result = outcome.engagement?.[feature];
    if (result?.failed) failures.push(`${feature}: ${result.failed} post reads failed; ${result.checked} succeeded`);
  }
  return failures.length
    ? { status: "failed", error: `partial collection: ${failures.join(" | ")}`.slice(0, 4_000) }
    : { status: "completed", error: null };
}

/** Scheduled retries respect a quiet period; a fresh profile must not hide failed media. */
export function partialCollectionNeedsRetry(
  previous: { status: string; error: string | null; completedAt: Date | null } | undefined,
  now = Date.now(),
): boolean {
  if (previous?.status !== "failed" || !previous.error?.startsWith("partial collection:") || !previous.completedAt) return false;
  const age = now - previous.completedAt.getTime();
  return Number.isFinite(age) && age >= 15 * 60_000;
}
