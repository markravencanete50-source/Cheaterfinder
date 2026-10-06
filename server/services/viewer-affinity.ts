import { AsyncLocalStorage } from "node:async_hooks";

export interface ViewerAffinity {
  botId?: string;
  /** Pin after the first successful page; each page still acquires/releases. */
  pin: boolean;
  roles?: readonly ("scraper" | "feed_watcher" | "reels_watcher")[];
  targetUsername?: string;
  /** Opt-in read experiment / bounded background page size; default stays 50. */
  rosterPageSize?: number;
  /** Existing native GraphQL connection, opt-in after target visibility check. */
  rosterSource?: "auto" | "graphql";
  /** Read-only background work cannot provision a replacement login. */
  savedSessionOnly?: boolean;
  /** Bounded background pages defer errors; no nested retry/rotation storm. */
  singleAttempt?: boolean;
}
const viewers = new AsyncLocalStorage<ViewerAffinity>();
export function viewerAffinity(): ViewerAffinity | undefined { return viewers.getStore(); }
export function withViewerAffinity<T>(viewer: ViewerAffinity, work: () => Promise<T>): Promise<T> {
  return viewers.run(viewer, work);
}
export function targetCanaryEnabled(name: string, username?: string): boolean {
  if (!username) return false;
  return (process.env[name] ?? "").split(",").map(s => s.trim().toLowerCase()).includes(username.toLowerCase());
}

/** Bare usernames retain both-dimension opt-in; qualified entries are narrower.
 * A small following-list canary must not also pin a target's huge follower walk.
 */
export function rosterViewerPinEnabled(username: string | undefined, dimension: "follower" | "following"): boolean {
  if (!username) return false;
  return targetCanaryEnabled("ROSTER_PIN_VIEWER_TARGETS", username) ||
    targetCanaryEnabled("ROSTER_PIN_VIEWER_TARGETS", `${username}:${dimension}`);
}

export function rosterRequestPageSize(): number {
  const requested = viewerAffinity()?.rosterPageSize;
  return requested === 100 || requested === 200 ? requested : 50;
}
