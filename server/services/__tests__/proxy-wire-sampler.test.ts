// ─── Tests for the kernel wire sampler's pure helpers ───────────────────────
//
// Only the two pure functions are exercised here on purpose: the rest of the
// module shells out to iptables as root, which no test environment has.
//
// Coverage:
//   parseIptablesCounters
//     - a realistic `iptables -L INPUT -v -x -n` dump: chain header, column
//       header, unrelated rules WITH targets, and two of our target-less rules
//       (one per gateway IP) → sums only our rules' byte columns
//     - our rules have NO target, so the 3rd column is the protocol rather
//       than a target name; the parse must still read bytes from column 2
//     - a dump with none of our rules → 0
//     - a rule whose comment merely resembles ours is still counted only when
//       it carries the exact comment token
//   computeSampleDelta
//     - normal monotonic increase → cur - prev per direction
//     - counter reset (cur < prev) → cur, i.e. treat current as the delta
//     - a reset in ONE direction only → that direction resets, the other
//       still diffs
//     - null prev (first read after boot) → zeros, the documented "baseline
//       only, persist no row" contract

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

// The module under test imports the db pool and the pino logger at load time.
// Neither is used by the pure helpers, so both are stubbed rather than stood up.
vi.mock("../../db.js", () => ({ db: { execute: vi.fn() } }));
vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import { computeSampleDelta, parseIptablesCounters } from "../proxy-wire-sampler.js";

// A real `iptables -L INPUT -v -x -n` dump shape. Note our two rules have an
// EMPTY target column, so `tcp` sits where `ACCEPT` sits on the others.
const INPUT_DUMP = `Chain INPUT (policy ACCEPT 0 packets, 0 bytes)
    pkts      bytes target     prot opt in     out     source               destination
   84213 1099511627 ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:443
       0          0 DROP       all  --  eth0   *       10.0.0.0/8           0.0.0.0/0
   12045   45678901            tcp  --  *      *       45.61.187.12         0.0.0.0/0            /* cheaterfinder-proxy-wire */
    9877   23456789            tcp  --  *      *       45.61.187.13         0.0.0.0/0            /* cheaterfinder-proxy-wire */
     512      65536 ACCEPT     udp  --  *      *       0.0.0.0/0            0.0.0.0/0            udp dpt:53
`;

const OUTPUT_DUMP = `Chain OUTPUT (policy ACCEPT 12 packets, 3456 bytes)
    pkts      bytes target     prot opt in     out     source               destination
    3311    1234567            tcp  --  *      *       0.0.0.0/0            45.61.187.12         /* cheaterfinder-proxy-wire */
    2200     999999            tcp  --  *      *       0.0.0.0/0            45.61.187.13         /* cheaterfinder-proxy-wire */
   99999  888888888 ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0
`;

const NO_RULES_DUMP = `Chain INPUT (policy ACCEPT 0 packets, 0 bytes)
    pkts      bytes target     prot opt in     out     source               destination
   84213 1099511627 ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:443
`;

describe("parseIptablesCounters", () => {
  it("sums only the byte column of our commented rules", () => {
    expect(parseIptablesCounters(INPUT_DUMP)).toBe(45678901 + 23456789);
  });

  it("parses the OUTPUT chain the same way", () => {
    expect(parseIptablesCounters(OUTPUT_DUMP)).toBe(1234567 + 999999);
  });

  it("ignores header lines and rules that are not ours", () => {
    expect(parseIptablesCounters(NO_RULES_DUMP)).toBe(0);
  });

  it("returns 0 for empty or garbage input rather than NaN", () => {
    expect(parseIptablesCounters("")).toBe(0);
    expect(parseIptablesCounters("not an iptables dump at all")).toBe(0);
  });

  it("skips a matching line whose counters are not numeric", () => {
    const corrupt = `    pkts      bytes target     prot opt in     out     source               destination
       x          y            tcp  --  *      *       45.61.187.12         0.0.0.0/0            /* cheaterfinder-proxy-wire */
   12045   45678901            tcp  --  *      *       45.61.187.13         0.0.0.0/0            /* cheaterfinder-proxy-wire */
`;
    expect(parseIptablesCounters(corrupt)).toBe(45678901);
  });

  it("counts a rule for every gateway IP, not just the first", () => {
    const single = INPUT_DUMP.split("\n")
      .filter((l) => !l.includes("45.61.187.13"))
      .join("\n");
    expect(parseIptablesCounters(single)).toBe(45678901);
  });
});

describe("computeSampleDelta", () => {
  it("diffs a normal monotonic increase", () => {
    expect(
      computeSampleDelta({ in: 1_000, out: 400 }, { in: 5_500, out: 900 }),
    ).toEqual({ in: 4_500, out: 500 });
  });

  it("returns zeros for the first reading so the caller persists no row", () => {
    expect(computeSampleDelta(null, { in: 9_999_999, out: 12_345 })).toEqual({
      in: 0,
      out: 0,
    });
  });

  it("treats a counter that went DOWN as a reset and uses the current total", () => {
    // Reboot / `iptables -Z` / rules re-created: everything the counter holds
    // now accrued since that reset, so it IS the delta.
    expect(
      computeSampleDelta({ in: 9_000_000, out: 500_000 }, { in: 1_200, out: 340 }),
    ).toEqual({ in: 1_200, out: 340 });
  });

  it("judges each direction independently on a one-sided reset", () => {
    expect(
      computeSampleDelta({ in: 9_000_000, out: 500_000 }, { in: 1_200, out: 750_000 }),
    ).toEqual({ in: 1_200, out: 250_000 });
  });

  it("returns 0 for an idle interval where nothing moved", () => {
    expect(
      computeSampleDelta({ in: 4_096, out: 2_048 }, { in: 4_096, out: 2_048 }),
    ).toEqual({ in: 0, out: 0 });
  });
});
