/** Safe progress for UI consumers; never contains cursors, bot IDs or errors
 * returned by an external service. Observed counts are not new-follower counts.
 */
export interface BackgroundRosterView {
  enabled: boolean;
  status: string;
  source: string;
  baselineCompleteAt: string | null;
  expectedCount: number | null;
  seenCount: number;
  pages: number;
  lastProgressAt: string | null;
  nextRunAt: string;
  epochStartedAt?: string | null;
  lastHeadReadAt?: string | null;
  lastHeadCount?: number;
  nextHeadRunAt?: string;
  headStatus?: string;
}

/** A recent prefix is presence evidence, never proof of a fresh complete set. */
export function recentRosterCheckOverdue(progress: BackgroundRosterView, nowMs: number): boolean {
  if (!progress.enabled || !progress.nextHeadRunAt) return false;
  const next = Date.parse(progress.nextHeadRunAt);
  const last = progress.lastHeadReadAt ? Date.parse(progress.lastHeadReadAt) : NaN;
  return (Number.isFinite(next) && nowMs > next + 5*60_000) ||
    (Number.isFinite(last) && nowMs - last > 20*60_000);
}

export function backgroundRosterSyncState(progress: BackgroundRosterView | null | undefined,
  fallback: "complete" | "capped" | "syncing" | "restricted") {
  if (!progress?.enabled) return fallback;
  if (progress.status === "complete" && progress.baselineCompleteAt) return "complete";
  return progress.status === "source_limited" ? "restricted" : "syncing";
}
