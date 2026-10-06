// Unit tests for the process-wide shutdown latch (2026-09-02 audit, lane C4).
//
// The flag is what lets the like-evidence owner loop and the roster page walk
// yield inside the 170 s drain budget instead of racing pm2's SIGKILL.

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  isShuttingDown,
  markShuttingDown,
  resetShutdownStateForTests,
  shutdownElapsedMs,
  onShutdown,
  shutdownCleanupFailures,
  waitForShutdownOrTimeout,
} from "../services/shutdown-state.js";

describe("shutdown-state", () => {
  beforeEach(() => resetShutdownStateForTests());

  it("starts in the running state", () => {
    expect(isShuttingDown()).toBe(false);
    expect(shutdownElapsedMs()).toBeNull();
  });

  it("latches on markShuttingDown and reports elapsed time", () => {
    markShuttingDown(1_000);
    expect(isShuttingDown()).toBe(true);
    expect(shutdownElapsedMs(4_500)).toBe(3_500);
  });

  it("is idempotent — a second signal keeps the first timestamp", () => {
    markShuttingDown(1_000);
    markShuttingDown(9_000);
    expect(shutdownElapsedMs(10_000)).toBe(9_000);
  });

  it("never reports a negative elapsed time", () => {
    markShuttingDown(5_000);
    expect(shutdownElapsedMs(4_000)).toBe(0);
  });

  it("resets for tests", () => {
    markShuttingDown();
    resetShutdownStateForTests();
    expect(isShuttingDown()).toBe(false);
    expect(shutdownElapsedMs()).toBeNull();
  });

  it("closes registered streams once and allows normal disconnect cleanup", () => {
    const active = vi.fn(), disconnected = vi.fn();
    onShutdown(active); const unsubscribe = onShutdown(disconnected); unsubscribe();
    markShuttingDown();markShuttingDown();
    expect(active).toHaveBeenCalledTimes(1);expect(disconnected).not.toHaveBeenCalled();
    const late=vi.fn();onShutdown(late);expect(late).toHaveBeenCalledTimes(1);
  });
  it("one cleanup error does not prevent other streams from closing", () => {
    onShutdown(()=>{throw new Error("fixture");});const closed=vi.fn();onShutdown(closed);
    markShuttingDown();expect(closed).toHaveBeenCalledOnce();expect(shutdownCleanupFailures()).toBe(1);
  });
  it("wakes a long pacing delay immediately on shutdown", async () => {
    const waiting=waitForShutdownOrTimeout(30_000);markShuttingDown();
    expect(await waiting).toBe("shutdown");expect(await waitForShutdownOrTimeout(30_000)).toBe("shutdown");
  });
  it("normal pacing expires and unregisters its callback", async () => {
    expect(await waitForShutdownOrTimeout(1)).toBe("timeout");markShuttingDown();
    expect(shutdownCleanupFailures()).toBe(0);
  });
});
