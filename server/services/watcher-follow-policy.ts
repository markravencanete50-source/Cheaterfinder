import type { IGFriendshipStatus } from "../ig-http-client.js";
import type { WatcherFollowStateValue } from "../../shared/schema.js";

// Pure decision helpers for the liked-by squad's follow probes. Kept apart from
// liked-by-harvester.ts (which drags Playwright, the bot runtime and the DB in
// at import time) so they can be unit-tested with no mocks.

/** The projection of a watcher_follow_state row the probe decision needs. */
export interface WatcherFollowStateRow {
  readonly state: WatcherFollowStateValue;
  readonly verifiedAt: Date | string | null;
}

export interface ShouldProbeOptions {
  /**
   * Whether this watcher can ACT on a 'not_following' verdict (web transport →
   * Chromium follow). A watcher that cannot follow learns nothing actionable
   * from re-probing a pair it does not follow, so for it 'not_following' is
   * re-verified on the same window as every other state. Defaults to true.
   */
  readonly canFollow?: boolean;
}

export type ObservedFollowState = Extract<
  WatcherFollowStateValue,
  "following" | "requested" | "not_following"
>;
export type LandedFollowState = Extract<WatcherFollowStateValue, "following" | "requested">;

/** Map IG's friendship verdict onto the persisted pair state. */
export function stateFromFriendship(
  status: Pick<IGFriendshipStatus, "following" | "outgoingRequest">,
): ObservedFollowState {
  if (status.following) return "following";
  if (status.outgoingRequest) return "requested";
  return "not_following";
}

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Should this (watcher, target) pair be probed against IG this cycle?
 *   - no row                                    → yes (never observed)
 *   - 'not_following' and the watcher can follow → yes (the probe guards the
 *                                                  Chromium follow that follows)
 *   - anything else                             → only once `verified_at` is
 *                                                  older than the re-verify window
 *   - unparseable `verified_at`                 → yes (fail open)
 *
 * 'unavailable' deliberately sits in the windowed bucket: it marks a hard,
 * non-checkpoint probe failure, and re-probing a pair IG refused 25 minutes ago
 * is the deterministic-retry pattern that burns accounts (lesson 5).
 */
export function shouldProbeTarget(
  row: WatcherFollowStateRow | undefined,
  nowMs: number,
  reverifyMs: number,
  opts: ShouldProbeOptions = {},
): boolean {
  if (!row) return true;
  if (row.state === "not_following" && (opts.canFollow ?? true)) return true;
  const verifiedMs = toMs(row.verifiedAt);
  if (verifiedMs === null) return true;
  return nowMs - verifiedMs > reverifyMs;
}
