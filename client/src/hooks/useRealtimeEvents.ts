// ─── SSE subscription for real-time tracked-account updates ─────────────────
//
// Wave 4: opens an EventSource against /api/realtime/events and forwards
// every dispatched event to the supplied handler. The dashboard wires this
// up once on mount; the handler typically invalidates relevant React-Query
// caches so the UI re-fetches just the slice that changed.
//
// Handles reconnect-on-error (browser EventSource does this automatically
// but we double-tap by re-creating after a 5s window if it stays in CLOSED).

import { useEffect, useRef } from "react";

export type RealtimeEventKind =
  | "profile.updated"
  | "posts.added"
  | "stories.changed"
  | "highlights.changed"
  | "followers.changed"
  | "following.changed";

export interface RealtimeEvent {
  kind: RealtimeEventKind;
  trackedAccountId: string;
  igUsername: string;
  count: number;
  at: string;
  payload?: Record<string, unknown>;
}

type Handler = (event: RealtimeEvent) => void;

export function useRealtimeEvents(handler: Handler, enabled = true): void {
  const handlerRef = useRef<Handler>(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;

    const url = "/api/realtime/events";
    let source: EventSource | null = null;
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;

    const open = (): void => {
      source = new EventSource(url, { withCredentials: true });

      const KINDS: RealtimeEventKind[] = [
        "profile.updated",
        "posts.added",
        "stories.changed",
        "highlights.changed",
        "followers.changed",
        "following.changed",
      ];

      for (const kind of KINDS) {
        source.addEventListener(kind, (raw: MessageEvent) => {
          try {
            const parsed = JSON.parse(raw.data) as RealtimeEvent;
            handlerRef.current(parsed);
          } catch {
            /* malformed event — ignore */
          }
        });
      }

      source.onerror = () => {
        // Browser will try to reconnect automatically. As a backstop, if it
        // stays in CLOSED for more than 5s, we close + re-open.
        if (source && source.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          reopenTimer = setTimeout(open, 5_000);
        }
      };
    };

    open();

    return () => {
      if (reopenTimer) clearTimeout(reopenTimer);
      if (source) source.close();
    };
  }, [enabled]);
}
