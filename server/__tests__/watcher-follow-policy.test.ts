import { describe, it, expect } from "vitest";
import { shouldProbeTarget, stateFromFriendship } from "../services/watcher-follow-policy.js";

const NOW = Date.UTC(2026, 8, 2, 16, 0, 0);
const H = 3_600_000;
const REVERIFY = 24 * H;

describe("stateFromFriendship", () => {
  it("maps following / requested / neither", () => {
    expect(stateFromFriendship({ following: true, outgoingRequest: false })).toBe("following");
    expect(stateFromFriendship({ following: false, outgoingRequest: true })).toBe("requested");
    expect(stateFromFriendship({ following: false, outgoingRequest: false })).toBe("not_following");
  });
});

describe("shouldProbeTarget", () => {
  it("probes a pair never observed", () => {
    expect(shouldProbeTarget(undefined, NOW, REVERIFY)).toBe(true);
  });
  it("does NOT re-probe a fresh 'following' pair (the steady state that cost ~2,250 calls/day)", () => {
    expect(shouldProbeTarget({ state: "following", verifiedAt: new Date(NOW - H) }, NOW, REVERIFY)).toBe(false);
    expect(shouldProbeTarget({ state: "requested", verifiedAt: new Date(NOW - 2 * H) }, NOW, REVERIFY)).toBe(false);
  });
  it("re-verifies once the window has passed", () => {
    expect(shouldProbeTarget({ state: "following", verifiedAt: new Date(NOW - REVERIFY - 1) }, NOW, REVERIFY)).toBe(true);
  });
  it("probes 'not_following' when the watcher can follow, else windows it like the rest", () => {
    const row = { state: "not_following" as const, verifiedAt: new Date(NOW - H) };
    expect(shouldProbeTarget(row, NOW, REVERIFY)).toBe(true);
    expect(shouldProbeTarget(row, NOW, REVERIFY, { canFollow: false })).toBe(false);
  });
  it("windows 'unavailable' (a hard refusal is not retried every sweep — lesson 5)", () => {
    expect(shouldProbeTarget({ state: "unavailable", verifiedAt: new Date(NOW - H) }, NOW, REVERIFY)).toBe(false);
  });
  it("fails open on an unparseable verified_at", () => {
    expect(shouldProbeTarget({ state: "following", verifiedAt: "garbage" }, NOW, REVERIFY)).toBe(true);
  });
});
