import { describe, expect, it, vi } from "vitest";
import { recoveryStatus, runRecoverySweep } from "../recovery-watchdog.js";

describe("recovery watchdog", () => {
  it("does not overlap a slow sweep", async () => {
    let release!: () => void;
    const slow = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const first = runRecoverySweep({ schedulers: slow });
    const second = runRecoverySweep({ schedulers: slow });
    expect(first).toBe(second);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(recoveryStatus().running).toBe(true);
    release(); await first;
    expect(recoveryStatus().running).toBe(false);
  });
  it("records failed steps while allowing independent repairs", async () => {
    const repair = vi.fn(async () => 2);
    await runRecoverySweep({ schedulers: async () => { throw Error("Redis unavailable"); }, collections: repair });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(recoveryStatus().failedSteps).toEqual(["schedulers"]);
    expect(recoveryStatus().lastFinishedAt).not.toBeNull();
    await runRecoverySweep({ schedulers: async () => 1, collections: repair });
    expect(recoveryStatus().failedSteps).toEqual([]);
    expect(recoveryStatus().lastSuccessAt).not.toBeNull();
  });
  it("does not expose mutable internal status", () => {
    recoveryStatus().failedSteps.push("fake");
    expect(recoveryStatus().failedSteps).not.toContain("fake");
  });
});
