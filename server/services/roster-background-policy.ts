// Pure policy: opt-in by canonical public username and roster dimension.
export type BackgroundRosterDimension = "follower" | "following";
export interface BackgroundRosterTarget { username: string; dimension: BackgroundRosterDimension; source: "auto" | "graphql" }

export function backgroundRosterTargets(raw = process.env.ROSTER_BACKGROUND_TARGETS ?? ""): BackgroundRosterTarget[] {
  const targets = new Map<string, BackgroundRosterTarget>();
  for (const item of raw.split(",")) {
    const parts = item.trim().toLowerCase().split(":");
    if (parts.length < 2 || parts.length > 3) continue;
    const [username, dimension, source = "auto"] = parts;
    if (!/^[a-z0-9._]{1,30}$/.test(username ?? "") || !["follower", "following"].includes(dimension) || !["auto", "graphql"].includes(source)) continue;
    targets.set(`${username}:${dimension}`, { username, dimension: dimension as BackgroundRosterDimension, source: source as "auto" | "graphql" });
  }
  return [...targets.values()];
}

// Collector delegation is permitted only after this process has successfully
// registered the durable worker schedule. A failed boot must not disable the
// existing collection path merely because an environment flag is present.
let workerReady = false;
export function setBackgroundRosterWorkerReady(ready: boolean): void { workerReady = ready; }
export function backgroundRosterWorkerReady(): boolean { return workerReady; }

export function backgroundRosterTarget(username: string, dimension: BackgroundRosterDimension): BackgroundRosterTarget | undefined {
  return backgroundRosterTargets().find(target => target.username === username.toLowerCase() && target.dimension === dimension);
}

export const BACKGROUND_ROSTER_BATCH_PAGES = 5;
export const BACKGROUND_ROSTER_BATCH_ITEMS = 500;
export const BACKGROUND_ROSTER_BATCH_BUDGET_MS = 90_000;
export const BACKGROUND_ROSTER_COMPLETE_TTL_MS = 24 * 60 * 60 * 1_000;
export const BACKGROUND_ROSTER_HEAD_INTERVAL_MS = 15 * 60_000;
export const BACKGROUND_ROSTER_HEAD_PAGES = 2;

/** A known reader cooldown is the earliest safe retry, not another arbitrary
 * 15-minute wait. Unknown failures retain the conservative fallback. */
export function nextBackgroundReadRetryAt(cooldownUntil: Date | string | null, nowMs: number): Date {
  const cooldown = cooldownUntil == null ? NaN : +new Date(cooldownUntil);
  return new Date(Number.isFinite(cooldown) && cooldown > nowMs ? cooldown + 1_000 : nowMs + 15 * 60_000);
}

/** A queued tick may run immediately after a slow batch finishes. Pace that
 * boundary inside the bounded job; a future DB due time would discard the tick
 * and idle for another whole scheduler minute. */
export function backgroundRosterBoundaryPauseMs(lastReadAt: Date | string | null, nowMs: number, random = Math.random()): number {
  if (lastReadAt == null) return 0;
  const last = new Date(lastReadAt).getTime();
  if (!Number.isFinite(last)) return 0;
  const gap = 9_000 + Math.min(1,Math.max(0,random))*7_000;
  return Math.max(0,gap-Math.max(0,nowMs-last));
}

/** Schedule full passes start-to-start. A >24h pass must not incur another
 * 24h blind wait after finishing. Failed/limited passes retain their backoff. */
export function nextBackgroundFullReadAt(epochStartedAt: Date | string | null, nowMs: number): Date {
  const start = epochStartedAt == null ? null : new Date(epochStartedAt).getTime();
  return new Date(Math.max(nowMs + 1_000,
    (start != null && Number.isFinite(start) ? start : nowMs) + BACKGROUND_ROSTER_COMPLETE_TTL_MS));
}

export function managedRosterCompleteReadMinimum(expected: number): number {
  if (!Number.isFinite(expected) || expected < 0) throw new Error("Reliable expected roster count required");
  return Math.ceil(expected * 0.9);
}
