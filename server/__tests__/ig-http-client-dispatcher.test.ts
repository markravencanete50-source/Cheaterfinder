// B15 (resource-leak fix): tests for undici dispatcher teardown in
// ig-http-client.ts.
//
// Under high proxy rotation a client's dispatcher was closed fire-and-forget,
// so open CONNECT tunnels could accumulate before GC. The fix:
//   - closeDispatcher() AWAITS dispatcher.close(), bounded by a 5s timeout
//     guard (Promise.race) so a stuck tunnel can't hang teardown, and logs —
//     never swallows — close failures.
//   - setDispatcher() enforces the invariant that replacing a dispatcher
//     closes the one it replaces.
//   - closeClientDispatcher() awaits the close and clears the slot so the same
//     dispatcher can't be double-closed.
//
// These exercise that logic against fake `Dispatcher`-shaped objects (a stub
// `close()` we can spy on / make hang) — no real sockets, no real undici.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Dispatcher } from "undici";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

// bandwidth-meter is the only transitive import of ig-http-client that pulls
// in the real db chain at module load. Stub it so the module loads cleanly.
vi.mock("../services/bandwidth-meter.js", () => ({
  recordBytes: vi.fn(),
}));

vi.mock("../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import {
  closeDispatcher,
  closeClientDispatcher,
  createBotClient,
  setDispatcher,
  type DispatcherSlot,
} from "../ig-http-client.js";

describe("createBotClient production transport guard", () => {
  it("fails before parsing a session when automation identity is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() =>
        createBotClient("not-even-session-json", {
          botUsername: "guard-test",
          proxyEndpoint: "127.0.0.1:9999",
        }),
      ).toThrow(/refusing legacy direct Instagram transport/);
    } finally {
      vi.stubEnv("NODE_ENV", "test");
    }
  });
});

// Minimal Dispatcher stub: only `close()` matters for these tests. We cast
// through `unknown` because we deliberately implement just the slice the
// lifecycle helpers touch.
function makeDispatcher(close: () => Promise<void>): Dispatcher {
  return { close } as unknown as Dispatcher;
}

describe("closeDispatcher (B15 awaited close + timeout guard)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("awaits dispatcher.close() on the happy path", async () => {
    const close = vi.fn(() => Promise.resolve());
    const dispatcher = makeDispatcher(close);

    await closeDispatcher(dispatcher);

    expect(close).toHaveBeenCalledTimes(1);
    // Clean close logs nothing.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resolves via the timeout guard when close() never settles", async () => {
    vi.useFakeTimers();
    // A close that hangs forever — the guard must win the race.
    const close = vi.fn(() => new Promise<void>(() => {}));
    const dispatcher = makeDispatcher(close);

    const pending = closeDispatcher(dispatcher);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // Before the guard fires, the promise is still pending.
    await Promise.resolve();
    expect(settled).toBe(false);

    // Advance past the 5s guard; the race resolves on the timeout branch.
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(settled).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dispatcher close exceeded"),
    );
  });

  it("logs (does not throw) when close() rejects", async () => {
    const close = vi.fn(() => Promise.reject(new Error("socket gone")));
    const dispatcher = makeDispatcher(close);

    await expect(closeDispatcher(dispatcher)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dispatcher close failed: socket gone"),
    );
  });

  it("logs (does not throw) when close() throws synchronously", async () => {
    const close = vi.fn(() => {
      throw new Error("already destroyed");
    });
    const dispatcher = makeDispatcher(close as () => Promise<void>);

    await expect(closeDispatcher(dispatcher)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dispatcher close failed: already destroyed"),
    );
  });
});

describe("setDispatcher (B15 every-replacement-closes invariant)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("closes the previous dispatcher when a new one replaces it", async () => {
    const closeOld = vi.fn(() => Promise.resolve());
    const closeNew = vi.fn(() => Promise.resolve());
    const oldD = makeDispatcher(closeOld);
    const newD = makeDispatcher(closeNew);
    const slot: DispatcherSlot = { dispatcher: oldD };

    setDispatcher(slot, newD);

    // New dispatcher is installed; old one is being closed.
    expect(slot.dispatcher).toBe(newD);
    // setDispatcher fires the close without awaiting; flush the microtask/timer
    // queue so the fire-and-forget close runs.
    await vi.waitFor(() => expect(closeOld).toHaveBeenCalledTimes(1));
    // The replacement itself is untouched (only the displaced one is closed).
    expect(closeNew).not.toHaveBeenCalled();
  });

  it("does not close when the same dispatcher is re-assigned", async () => {
    const close = vi.fn(() => Promise.resolve());
    const same = makeDispatcher(close);
    const slot: DispatcherSlot = { dispatcher: same };

    setDispatcher(slot, same);

    expect(slot.dispatcher).toBe(same);
    // Re-assigning the identical reference must NOT close it (would kill the
    // live tunnel we're still using).
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
  });

  it("installs a dispatcher into an empty slot without any close", async () => {
    const close = vi.fn(() => Promise.resolve());
    const fresh = makeDispatcher(close);
    const slot: DispatcherSlot = { dispatcher: null };

    setDispatcher(slot, fresh);

    expect(slot.dispatcher).toBe(fresh);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
  });

  it("closes the displaced dispatcher when the slot is cleared (next set null)", async () => {
    const close = vi.fn(() => Promise.resolve());
    const existing = makeDispatcher(close);
    const slot: DispatcherSlot = { dispatcher: existing };

    setDispatcher(slot, null);

    expect(slot.dispatcher).toBeNull();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});

describe("closeClientDispatcher (B15 awaited teardown, no double-close)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("awaits the dispatcher close and clears the slot", async () => {
    const close = vi.fn(() => Promise.resolve());
    const slot: DispatcherSlot = { dispatcher: makeDispatcher(close) };

    await closeClientDispatcher(slot);

    expect(close).toHaveBeenCalledTimes(1);
    expect(slot.dispatcher).toBeNull();
  });

  it("is a no-op (and does not throw) when the slot is already empty", async () => {
    const slot: DispatcherSlot = { dispatcher: null };
    await expect(closeClientDispatcher(slot)).resolves.toBeUndefined();
    expect(slot.dispatcher).toBeNull();
  });

  it("does not close the same dispatcher twice across repeated teardown", async () => {
    const close = vi.fn(() => Promise.resolve());
    const slot: DispatcherSlot = { dispatcher: makeDispatcher(close) };

    await closeClientDispatcher(slot);
    await closeClientDispatcher(slot);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
