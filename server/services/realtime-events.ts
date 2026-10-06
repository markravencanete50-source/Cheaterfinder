// ─── Real-time event bus for tracked-account changes ───────────────────────
//
// Wave 4: every time the collector pipeline writes new data for a tracked
// account (profile snapshot, posts, stories, highlights, follower diff) we
// emit a typed event on this in-process bus. The SSE endpoint subscribes and
// fans events out to connected dashboard clients, so the UI live-updates as
// scrapes complete instead of waiting for the next React-Query poll.
//
// Single-process design (Node EventEmitter). If/when this app is split into
// multiple worker processes the swap is to a Redis pub/sub adapter behind
// the same `emit` / `subscribe` API.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from "node:events";

export type RealtimeEventKind =
  | "profile.updated"
  | "posts.added"
  | "stories.changed"
  | "highlights.changed"
  | "followers.changed"
  | "following.changed";

export interface RealtimeEvent {
  readonly kind: RealtimeEventKind;
  readonly trackedAccountId: string;
  readonly igUsername: string;
  /** Quantity inserted/updated (rows, items, deltas — kind-dependent). */
  readonly count: number;
  readonly at: string; // ISO timestamp
  /** Optional extra payload — e.g. follower/following count for cards. */
  readonly payload?: Record<string, unknown>;
}

const bus = new EventEmitter();
// Allow many SSE connections — Node's default 10 is too low for a dashboard
// where each tab opens a stream.
bus.setMaxListeners(100);

const CHANNEL = "rt";

export function emitRealtime(event: Omit<RealtimeEvent, "at">): void {
  const enriched: RealtimeEvent = {
    ...event,
    at: new Date().toISOString(),
  };
  bus.emit(CHANNEL, enriched);
}

/**
 * Subscribe to all real-time events. Returns an unsubscribe handle.
 */
export function subscribeRealtime(
  handler: (event: RealtimeEvent) => void,
): () => void {
  bus.on(CHANNEL, handler);
  return () => {
    bus.off(CHANNEL, handler);
  };
}

/** Remap a shared IG-user update to rows this authenticated customer owns. */
export function ownedRealtimeEvents(
  event: RealtimeEvent,
  ownedTwinIds: ReadonlyMap<string, readonly string[]>,
): RealtimeEvent[] {
  return [...ownedTwinIds].flatMap(([ownedId, twinIds]) =>
    ownedId === event.trackedAccountId || twinIds.includes(event.trackedAccountId)
      ? [{ ...event, trackedAccountId: ownedId }]
      : [],
  );
}
