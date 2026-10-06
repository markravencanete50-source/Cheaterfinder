// Unit tests for server/services/realtime-events.ts
// Pure in-process EventEmitter tests — no external dependencies.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  emitRealtime,
  subscribeRealtime,
  ownedRealtimeEvents,
  type RealtimeEvent,
} from "./realtime-events.js";

describe("owned twin realtime routing", () => {
  const event: RealtimeEvent = { kind: "followers.changed", trackedAccountId: "canonical-other-owner", igUsername: "shared_profile", count: 2, at: "2026-09-07T00:00:00Z" };
  it("delivers canonical updates using only the recipient's owned row id", () => {
    expect(ownedRealtimeEvents(event, new Map([["owned", ["owned", "canonical-other-owner"]]])))
      .toEqual([{ ...event, trackedAccountId: "owned" }]);
  });
  it("does not expose an unrelated user's update", () => {
    expect(ownedRealtimeEvents(event, new Map([["owned", ["owned", "different-profile"]]]))).toEqual([]);
  });
  it("does not duplicate a directly owned canonical event", () => {
    expect(ownedRealtimeEvents(event, new Map([[event.trackedAccountId, [event.trackedAccountId]]]))).toEqual([event]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventBase() {
  return {
    kind: "profile.updated" as const,
    trackedAccountId: "acct-001",
    igUsername: "testuser",
    count: 3,
  };
}

// ---------------------------------------------------------------------------
// Basic subscribe → emit flow
// ---------------------------------------------------------------------------

describe("emitRealtime → subscribeRealtime", () => {
  it("subscriber receives the emitted event", () => {
    const received: RealtimeEvent[] = [];
    const unsub = subscribeRealtime((ev) => received.push(ev));

    emitRealtime(makeEventBase());
    unsub();

    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("profile.updated");
  });

  it("adds an ISO timestamp (at field) to every event", () => {
    const before = new Date().toISOString();
    let captured: RealtimeEvent | null = null;
    const unsub = subscribeRealtime((ev) => { captured = ev; });

    emitRealtime(makeEventBase());
    unsub();

    expect(captured).not.toBeNull();
    const at = (captured as RealtimeEvent).at;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(at >= before).toBe(true);
  });

  it("preserves all input fields on the enriched event", () => {
    let captured: RealtimeEvent | null = null;
    const unsub = subscribeRealtime((ev) => { captured = ev; });

    emitRealtime({
      ...makeEventBase(),
      payload: { followers: 1200 },
    });
    unsub();

    const ev = captured as RealtimeEvent;
    expect(ev.trackedAccountId).toBe("acct-001");
    expect(ev.igUsername).toBe("testuser");
    expect(ev.count).toBe(3);
    expect(ev.payload).toEqual({ followers: 1200 });
  });
});

// ---------------------------------------------------------------------------
// Multiple subscribers
// ---------------------------------------------------------------------------

describe("multiple subscribers", () => {
  it("all active subscribers receive the same event", () => {
    const results: Array<RealtimeEvent[]> = [[], [], []];
    const unsubs = results.map((arr) =>
      subscribeRealtime((ev) => arr.push(ev)),
    );

    emitRealtime(makeEventBase());
    unsubs.forEach((u) => u());

    for (const arr of results) {
      expect(arr).toHaveLength(1);
      expect(arr[0].kind).toBe("profile.updated");
    }
  });

  it("subscribers receive independent copies (same object reference is OK, but all get it)", () => {
    const a: RealtimeEvent[] = [];
    const b: RealtimeEvent[] = [];
    const unA = subscribeRealtime((ev) => a.push(ev));
    const unB = subscribeRealtime((ev) => b.push(ev));

    emitRealtime({ ...makeEventBase(), kind: "posts.added", count: 5 });
    unA();
    unB();

    expect(a[0].kind).toBe("posts.added");
    expect(b[0].kind).toBe("posts.added");
    expect(a[0]).toBe(b[0]); // same reference — EventEmitter passes same obj
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe handle
// ---------------------------------------------------------------------------

describe("unsubscribe handle", () => {
  it("stops receiving events after unsubscribing", () => {
    const received: RealtimeEvent[] = [];
    const unsub = subscribeRealtime((ev) => received.push(ev));

    emitRealtime(makeEventBase()); // should be received
    unsub();
    emitRealtime(makeEventBase()); // should NOT be received

    expect(received).toHaveLength(1);
  });

  it("other subscribers are not affected when one unsubscribes", () => {
    const a: RealtimeEvent[] = [];
    const b: RealtimeEvent[] = [];
    const unA = subscribeRealtime((ev) => a.push(ev));
    const unB = subscribeRealtime((ev) => b.push(ev));

    emitRealtime(makeEventBase()); // both receive
    unA();
    emitRealtime(makeEventBase()); // only b receives

    unB();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("calling unsubscribe multiple times does not throw", () => {
    const unsub = subscribeRealtime(() => undefined);
    expect(() => {
      unsub();
      unsub(); // idempotent (EventEmitter.off is safe to call multiple times)
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// High listener count (we raised the max to 100)
// ---------------------------------------------------------------------------

describe("listener limit raised to 100", () => {
  it("accepts more than 10 simultaneous subscribers without warnings", () => {
    const warnSpy = vi.spyOn(process, "emit");
    const unsubs: Array<() => void> = [];

    for (let i = 0; i < 50; i++) {
      unsubs.push(subscribeRealtime(() => undefined));
    }

    // Should not have emitted 'warning' for MaxListenersExceededWarning
    const warnings = warnSpy.mock.calls.filter(
      (call) => call[0] === "warning",
    );
    expect(warnings).toHaveLength(0);

    unsubs.forEach((u) => u());
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Event kind variants
// ---------------------------------------------------------------------------

describe("all RealtimeEventKind values are accepted", () => {
  const kinds = [
    "profile.updated",
    "posts.added",
    "stories.changed",
    "highlights.changed",
    "followers.changed",
    "following.changed",
  ] as const;

  for (const kind of kinds) {
    it(`emits and receives kind="${kind}"`, () => {
      let captured: RealtimeEvent | null = null;
      const unsub = subscribeRealtime((ev) => { captured = ev; });
      emitRealtime({ ...makeEventBase(), kind });
      unsub();
      expect((captured as RealtimeEvent).kind).toBe(kind);
    });
  }
});
