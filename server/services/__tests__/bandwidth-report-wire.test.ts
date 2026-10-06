// ─── Tests for the wire block of the admin bandwidth report ─────────────────
//
// `report.wire` is the kernel-measured, billable gateway figure read from
// `proxy_wire_samples`. That table is written by an OPTIONAL root-only sampler
// and created by migration 0047, so on a host where neither has happened the
// query fails with `relation "proxy_wire_samples" does not exist`.
//
// Coverage:
//   - the table query failing degrades `wire` to zeros and still returns the
//     rest of the report (it must never 500 the whole panel)
//   - a successful read maps bigint-as-string sums, the sample count, the
//     coverage span and the first-sample timestamp (Date → ISO)
//   - an empty window (table exists, no rows in range) reports zeros with
//     firstSampleAt null, which the UI renders as "measuring…"

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

interface WireBehavior {
  mode: "throw" | "rows";
  rows: Array<Record<string, unknown>>;
}

const state = vi.hoisted(() => ({
  wire: { mode: "rows", rows: [] } as {
    mode: "throw" | "rows";
    rows: Array<Record<string, unknown>>;
  },
}));

/**
 * Drizzle's `sql` template yields an object whose chunks carry the literal SQL
 * fragments. Serializing it is enough to tell which statement is being run —
 * we only need to single out the proxy_wire_samples SELECT.
 */
function describeSql(query: unknown): string {
  try {
    return JSON.stringify(query);
  } catch {
    return String(query);
  }
}

vi.mock("../../db.js", () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      if (describeSql(query).includes("proxy_wire_samples")) {
        if (state.wire.mode === "throw") {
          throw new Error('relation "proxy_wire_samples" does not exist');
        }
        return { rows: state.wire.rows };
      }
      return { rows: [] };
    }),
  },
}));

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

import { db } from "../../db.js";
// The execute mock still supplies all SELECT results; model a shared snapshot.
db.transaction = (async work => work(db as never)) as typeof db.transaction;
import { __resetForTests, getBandwidthReport } from "../bandwidth-meter.js";

function setWire(behavior: WireBehavior): void {
  state.wire = behavior;
}

describe("getBandwidthReport().wire", () => {
  beforeEach(() => {
    __resetForTests();
    setWire({ mode: "rows", rows: [] });
  });

  it("reports zeros when the proxy_wire_samples query fails", async () => {
    setWire({ mode: "throw", rows: [] });

    const report = await getBandwidthReport("7d");

    expect(report.wire).toEqual({
      bytesIn: 0,
      bytesOut: 0,
      totalBytes: 0,
      samples: 0,
      coverageSeconds: 0,
      firstSampleAt: null,
      lastSampleAt: null,
      available: false,
    });
    // The rest of the report must still be intact — a missing sampler table is
    // not a reason to lose the attribution view.
    expect(report.window).toBe("7d");
    expect(report.byProfile).toEqual([]);
    expect(report.totals.totalBytes).toBe(0);
  });

  it("sums bigint-as-string counters and normalizes the first sample time", async () => {
    setWire({
      mode: "rows",
      rows: [
        {
          bytes_in: "54000000000",
          bytes_out: "3000000000",
          samples: "7200",
          coverage_seconds: "432000",
          first_sample_at: new Date("2026-08-30T12:00:00.000Z"),
          last_sample_at: new Date("2026-09-04T12:00:00.000Z"),
        },
      ],
    });

    const report = await getBandwidthReport("7d");

    expect(report.wire.bytesIn).toBe(54_000_000_000);
    expect(report.wire.bytesOut).toBe(3_000_000_000);
    expect(report.wire.totalBytes).toBe(57_000_000_000);
    expect(report.wire.samples).toBe(7_200);
    expect(report.wire.coverageSeconds).toBe(432_000);
    expect(report.wire.firstSampleAt).toBe("2026-08-30T12:00:00.000Z");
    expect(report.wire.lastSampleAt).toBe("2026-09-04T12:00:00.000Z");
    expect(report.wire.available).toBe(true);
  });

  it("reports zeros with a null first sample for an empty window", async () => {
    setWire({
      mode: "rows",
      rows: [
        {
          bytes_in: "0",
          bytes_out: "0",
          samples: "0",
          coverage_seconds: "0",
          first_sample_at: null,
        },
      ],
    });

    const report = await getBandwidthReport("1h");

    expect(report.wire.samples).toBe(0);
    expect(report.wire.totalBytes).toBe(0);
    expect(report.wire.firstSampleAt).toBeNull();
  });
});
