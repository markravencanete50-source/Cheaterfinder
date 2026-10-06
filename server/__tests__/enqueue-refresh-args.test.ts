// Unit tests for the enqueue-refresh CLI argument parser (2026-09-02 audit, C11b).
//
// Regression: `--all` was taken as an account id and a `manual_--all_…` job
// was queued and failed. The parser now supports `--all` and rejects any other
// `-`-prefixed token. The script guards `main()` behind a direct-run check, so
// importing it here runs nothing.

import { describe, it, expect } from "vitest";

const { parseEnqueueRefreshArgs, buildManualRefreshJobId, USAGE } = await import(
  "../scripts/enqueue-refresh.js"
);

describe("parseEnqueueRefreshArgs", () => {
  it("rejects an empty argv with the usage line", () => {
    expect(parseEnqueueRefreshArgs([])).toEqual({ ok: false, error: USAGE });
  });

  it("accepts --all on its own", () => {
    expect(parseEnqueueRefreshArgs(["--all"])).toEqual({ ok: true, mode: "all" });
  });

  it("refuses --all mixed with account ids", () => {
    const parsed = parseEnqueueRefreshArgs(["--all", "acct-1"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/cannot be combined/);
  });

  it("rejects unknown flags instead of treating them as ids (regression)", () => {
    const parsed = parseEnqueueRefreshArgs(["--al"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/unknown flag\(s\): --al/);
  });

  it("rejects a short unknown flag even alongside --all", () => {
    const parsed = parseEnqueueRefreshArgs(["-x", "--all"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/unknown flag\(s\): -x/);
  });

  it("returns de-duplicated ids in first-seen order, ignoring blank tokens", () => {
    expect(parseEnqueueRefreshArgs(["acct-1", "  ", "acct-2", "acct-1"])).toEqual({
      ok: true,
      mode: "ids",
      ids: ["acct-1", "acct-2"],
    });
  });
});

describe("buildManualRefreshJobId", () => {
  it("uses '_' separators only (BullMQ rejects ':' in custom ids)", () => {
    const id = buildManualRefreshJobId("acct-1", 1_700_000_000_000);
    expect(id).toBe("manual_acct-1_1700000000000");
    expect(id).not.toContain(":");
  });
});
