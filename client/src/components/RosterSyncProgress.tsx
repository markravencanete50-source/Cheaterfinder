import { recentRosterCheckOverdue, type BackgroundRosterView } from "../../../shared/roster-background";

const labels: Record<string, string> = {
  pending: "Queued", syncing: "Syncing", cooldown: "Waiting to retry",
  awaiting_profile: "Waiting for a current profile count", source_limited: "Source limited — full read not verified",
  complete: "Full read verified",
  source_mismatch: "Paused — saved cursor needs its original read context",
};

export function RosterSyncProgress({ progress, label }: { progress?: BackgroundRosterView | null; label: string }) {
  if (!progress) return null;
  return <div className="mt-2 space-y-1 text-xs" data-testid="roster-sync-progress" role="status">
    <p>{label}: {progress.enabled ? labels[progress.status] ?? "Pending" : "Background sync paused"}.</p>
    <p>{progress.seenCount.toLocaleString()} distinct members observed in this scan
      {progress.expectedCount != null ? ` / ${progress.expectedCount.toLocaleString()} reported at scan start` : ""}
      {` · ${progress.pages.toLocaleString()} pages`}. These are observations, not new followers.</p>
    <p>{progress.lastProgressAt ? `Progress saved ${new Date(progress.lastProgressAt).toLocaleString()}.` : "No batch saved yet."}
      {progress.enabled && progress.status !== "complete" ? ` Next eligible attempt: ${new Date(progress.nextRunAt).toLocaleString()}.` : ""}</p>
    {progress.nextHeadRunAt && <div data-testid="roster-recent-check">
      <p>{progress.lastHeadReadAt
        ? `Recent visible members: ${(progress.lastHeadCount ?? 0).toLocaleString()} checked ${new Date(progress.lastHeadReadAt).toLocaleString()}.`
        : "Recent visible members: no successful check yet."}
        {progress.enabled ? ` Next eligible check: ${new Date(progress.nextHeadRunAt).toLocaleString()}.` : ""}</p>
      {(progress.headStatus === "retrying" || recentRosterCheckOverdue(progress,Date.now())) && <p className="text-amber-600" role="alert">Recent check delayed — these observations may be out of date.</p>}
      {progress.headStatus === "source_limited" && <p>Instagram limited the recent view.</p>}
      {progress.headStatus === "partial" && <p>Recent check stopped early; only returned members were saved.</p>}
      <p>This partial check cannot verify every change or missing member. Full reconciliation continues separately.</p>
    </div>}
    {!progress.baselineCompleteAt && <p>Initial full roster is not yet verified. Backfill does not generate new-follow or unfollow activity.</p>}
  </div>;
}
