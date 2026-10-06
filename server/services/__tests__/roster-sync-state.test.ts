// Unit tests for computeRosterSyncState — the pure helper that decides how
// honest the roster UI is about completeness. Pure function, no I/O.
//
// Coverage:
//   - huge account (reported >> enumerable cap) → "capped", never "syncing"
//   - near-complete capture (>= 90% of reachable) → "complete"
//   - completed enumeration but still short (lastGraphRefreshAt set) → "capped"
//   - genuinely incomplete + never fully enumerated → "syncing"
//   - empty / first-capture edge cases

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
// Keep this pure-helper suite independent of the optional integration DB.
const { computeRosterSyncState } = await import("../roster.js");

const CAP = 15000;

describe("computeRosterSyncState", () => {
  it("flags huge accounts as capped, not syncing", () => {
    // natgeo: 149 captured of 269M reported, last enumeration completed.
    expect(
      computeRosterSyncState({
        loadedTotal: 149,
        reportedTotal: 269_269_626,
        lastGraphRefreshAt: new Date(),
        cap: CAP,
      }),
    ).toBe("capped");
  });

  it("caps an oversized roster even before its baseline settles", () => {
    expect(
      computeRosterSyncState({
        loadedTotal: 862,
        reportedTotal: 20_134_436,
        lastGraphRefreshAt: null,
        baselineSettled: false,
        cap: CAP,
      }),
    ).toBe("capped");
  });

  it("treats a near-complete capture as complete (>=90% of reachable)", () => {
    // following 181 of 193 reported = 93.8%.
    expect(
      computeRosterSyncState({
        loadedTotal: 181,
        reportedTotal: 193,
        lastGraphRefreshAt: new Date(),
        cap: CAP,
      }),
    ).toBe("complete");
  });

  it("caps when a full enumeration completed but we're still short", () => {
    // 485 of 660 (73%) but last_graph_refresh advanced → IG won't give the rest.
    expect(
      computeRosterSyncState({
        loadedTotal: 485,
        reportedTotal: 660,
        lastGraphRefreshAt: new Date(),
        cap: CAP,
      }),
    ).toBe("capped");
  });

  it("reports syncing while a reachable roster has never fully enumerated", () => {
    // sample_account-style: 4537 of 9342 (49%), enumeration never completed.
    expect(
      computeRosterSyncState({
        loadedTotal: 4537,
        reportedTotal: 9342,
        lastGraphRefreshAt: null,
        cap: CAP,
      }),
    ).toBe("syncing");
  });

  it("is complete when loaded meets the reachable total exactly", () => {
    expect(
      computeRosterSyncState({
        loadedTotal: 332,
        reportedTotal: 332,
        lastGraphRefreshAt: null,
        cap: CAP,
      }),
    ).toBe("complete");
  });

  it("does not show endless syncing when loaded already exceeds reported", () => {
    expect(
      computeRosterSyncState({
        loadedTotal: 675,
        reportedTotal: 674,
        lastGraphRefreshAt: null,
        baselineSettled: false,
        cap: CAP,
      }),
    ).toBe("complete");
  });

  it("treats zero reported with zero loaded as complete (nothing to sync)", () => {
    expect(
      computeRosterSyncState({
        loadedTotal: 0,
        reportedTotal: 0,
        lastGraphRefreshAt: null,
        cap: CAP,
      }),
    ).toBe("complete");
  });

  it("does not mark a 1-follower account complete before any enumeration", () => {
    // Regression: floor(1 * 0.9) === 0 would wrongly return "complete".
    expect(
      computeRosterSyncState({
        loadedTotal: 0,
        reportedTotal: 1,
        lastGraphRefreshAt: null,
        cap: CAP,
      }),
    ).toBe("syncing");
  });

  it("reports syncing on a fresh account with a reported count but no capture", () => {
    expect(
      computeRosterSyncState({
        loadedTotal: 0,
        reportedTotal: 1803,
        lastGraphRefreshAt: null,
        cap: CAP,
      }),
    ).toBe("syncing");
  });

  it("accepts string timestamps (DB driver shape) as a completed enumeration", () => {
    expect(
      computeRosterSyncState({
        loadedTotal: 485,
        reportedTotal: 660,
        lastGraphRefreshAt: "2026-06-17T08:34:26.630Z",
        cap: CAP,
      }),
    ).toBe("capped");
  });

  it("does not trust a legacy refresh anchor before the materialized baseline settles", () => {
    expect(
      computeRosterSyncState({
        loadedTotal: 0,
        reportedTotal: 1_402,
        lastGraphRefreshAt: "2026-07-16T17:22:00.000Z",
        baselineSettled: false,
        cap: CAP,
      }),
    ).toBe("syncing");
  });

  it("surfaces an active special-empty-state backoff as restricted", () => {
    expect(
      computeRosterSyncState({
        loadedTotal: 0,
        reportedTotal: 1_867,
        lastGraphRefreshAt: "2026-07-16T09:19:00.000Z",
        baselineSettled: false,
        failureKind: "list_restricted",
        nextRetryAt: new Date(Date.now() + 60_000),
        cap: CAP,
      }),
    ).toBe("restricted");
  });

  it.each(["rate_limited", "auth", "unavailable"])(
    "surfaces an active %s refresh failure while preserving the saved roster",
    (failureKind) => {
      expect(
        computeRosterSyncState({
          loadedTotal: 1_866,
          reportedTotal: 1_868,
          lastGraphRefreshAt: "2026-07-25T15:08:43.737Z",
          baselineSettled: true,
          failureKind,
          nextRetryAt: new Date(Date.now() + 60_000),
          cap: CAP,
        }),
      ).toBe("restricted");
    },
  );
});
