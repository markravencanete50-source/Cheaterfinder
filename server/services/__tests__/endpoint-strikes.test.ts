// ─── Tests for per-endpoint 3-strikes auto-disable (Wave 6) ─────────────────
//
// Coverage:
//   - 1 strike from 1 bot           → not disabled
//   - 2 strikes from 2 bots         → not disabled
//   - 3 strikes from 3 distinct bots→ disabled
//   - 3 strikes from the SAME bot   → not disabled (must be DISTINCT bots)
//   - recordSuccess clears strikes + lifts disable
//   - 24h auto-clear: a disabled row whose enabled_again_at has passed is
//     reported as not-disabled (lazy GC inside isEndpointDisabled)
//   - B7 half-open probe: blocked before the probe window; exactly one
//     probe claim after it; probe success → CLOSED; probe failure → disable
//     extended (capped at 24h from now) + probe window re-armed; manual
//     re-enable still works; ENDPOINT_DISABLE_PROBE_AFTER_MS env override
//
// Approach:
//   - Mock drizzle-orm helpers to return a passthrough { __ctx } object that
//     encodes the (endpoint, cutoff, now) the where clause was built with.
//   - Mock shared/schema.js to return bare column descriptors with `name`
//     set to the underlying SQL column name — that's what our drizzle-orm
//     mock keys off of when extracting context.
//   - Mock db.js with a hand-written chainable that walks the operation
//     based on the call sequence and resolves against an in-memory store.
// All time is controlled via vitest fake timers so the 1h window and 24h
// disable window can be exercised deterministically.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

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

// ── In-memory store ─────────────────────────────────────────────────────────

interface StrikeRow {
  endpoint: string;
  botId: string;
  failedAt: Date;
}

interface DisabledRow {
  endpoint: string;
  disabledAt: Date;
  enabledAgainAt: Date;
  reason: string | null;
}

const store = vi.hoisted(() => {
  const strikes: StrikeRow[] = [];
  const disabled: DisabledRow[] = [];
  return {
    strikes,
    disabled,
    reset(): void {
      strikes.length = 0;
      disabled.length = 0;
    },
  };
});

// ── Mock drizzle-orm helpers — passthrough context tags ─────────────────────

vi.mock("drizzle-orm", () => {
  type Ctx = {
    endpoint?: string;
    cutoff?: Date;
    activeNow?: Date;
    expiredNow?: Date;
    probeCutoff?: Date;
  };
  function tag(ctx: Ctx): { __ctx: Ctx } {
    return { __ctx: ctx };
  }
  return {
    and: (...parts: Array<{ __ctx?: Ctx } | undefined>): { __ctx: Ctx } => {
      const merged: Ctx = {};
      for (const p of parts) {
        if (p && typeof p === "object" && "__ctx" in p && p.__ctx) {
          Object.assign(merged, p.__ctx);
        }
      }
      return tag(merged);
    },
    eq: (col: { name?: string }, value: unknown) => {
      if (col?.name === "endpoint") return tag({ endpoint: String(value) });
      return tag({});
    },
    gte: (col: { name?: string }, value: unknown) => {
      if (col?.name === "failed_at") return tag({ cutoff: value as Date });
      if (col?.name === "enabled_again_at")
        return tag({ activeNow: value as Date });
      return tag({});
    },
    lt: (col: { name?: string }, value: unknown) => {
      if (col?.name === "enabled_again_at")
        return tag({ expiredNow: value as Date });
      return tag({});
    },
    lte: (col: { name?: string }, value: unknown) => {
      if (col?.name === "disabled_at")
        return tag({ probeCutoff: value as Date });
      return tag({});
    },
    sql: Object.assign(
      (_strings: TemplateStringsArray, ..._values: unknown[]) => ({
        raw: "sql-template",
      }),
      {},
    ),
  };
});

// ── Mock schema — minimal column descriptors ────────────────────────────────

vi.mock("../../../shared/schema.js", () => {
  const col = (name: string) => ({ name });
  return {
    endpointStrikes: {
      __table: "endpoint_strikes",
      endpoint: col("endpoint"),
      botId: col("bot_id"),
      failedAt: col("failed_at"),
    },
    endpointDisabled: {
      __table: "endpoint_disabled",
      endpoint: col("endpoint"),
      disabledAt: col("disabled_at"),
      enabledAgainAt: col("enabled_again_at"),
      reason: col("reason"),
    },
  };
});

// ── Mock db — chainable that interprets calls against the in-memory store ──

interface Ctx {
  endpoint?: string;
  cutoff?: Date;
  activeNow?: Date;
  expiredNow?: Date;
  probeCutoff?: Date;
}

function mergeCtx(target: Ctx, clause: { __ctx?: Ctx } | undefined): void {
  if (clause && clause.__ctx) Object.assign(target, clause.__ctx);
}

vi.mock("../../db.js", () => {
  type SelectKind = "distinctBots" | "rows";

  function makeInsertChain(table: { __table?: string }): unknown {
    const tableName = table.__table;
    const buffered: Array<Record<string, unknown>> = [];
    const chain: Record<string, unknown> = {};

    chain.values = (rows: unknown) => {
      const list = Array.isArray(rows) ? rows : [rows];
      buffered.push(...(list as Array<Record<string, unknown>>));
      return chain;
    };

    chain.onConflictDoNothing = () => {
      if (tableName === "endpoint_strikes") {
        for (const r of buffered) {
          const row = r as unknown as StrikeRow;
          const exists = store.strikes.some(
            (s) =>
              s.endpoint === row.endpoint &&
              s.botId === row.botId &&
              s.failedAt.getTime() === row.failedAt.getTime(),
          );
          if (!exists) store.strikes.push(row);
        }
      }
      return Promise.resolve([]);
    };

    chain.onConflictDoUpdate = (_spec: {
      target: unknown;
      set: Record<string, unknown>;
    }) => {
      if (tableName === "endpoint_disabled") {
        for (const r of buffered) {
          const row = r as unknown as DisabledRow;
          const idx = store.disabled.findIndex(
            (d) => d.endpoint === row.endpoint,
          );
          if (idx === -1) store.disabled.push(row);
          else store.disabled[idx] = { ...store.disabled[idx], ...row };
        }
      }
      return Promise.resolve([]);
    };

    return chain;
  }

  function makeSelectChain(cols?: Record<string, unknown>): unknown {
    const ctx: Ctx = {};
    let kind: SelectKind = "rows";
    if (cols && "distinctBots" in cols) kind = "distinctBots";

    const chain: Record<string, unknown> = {};
    chain.from = (_table: unknown) => chain;
    chain.where = (clause: { __ctx?: Ctx }) => {
      mergeCtx(ctx, clause);
      return chain;
    };

    chain.limit = async (_n: number): Promise<unknown[]> => {
      // Used by getActiveDisabled / isEndpointDisabled with activeNow filter.
      const now = ctx.activeNow ?? new Date();
      const row = store.disabled.find(
        (d) => d.endpoint === ctx.endpoint && d.enabledAgainAt >= now,
      );
      return row ? [row] : [];
    };

    // Awaitable for: distinct-bots count, or list-of-disabled (admin).
    (chain as { then?: unknown }).then = (
      resolve: (rows: unknown[]) => void,
    ): void => {
      if (kind === "distinctBots") {
        const ep = ctx.endpoint;
        const cutoff = ctx.cutoff ?? new Date(0);
        const seen = new Set<string>();
        for (const s of store.strikes) {
          if (s.endpoint === ep && s.failedAt >= cutoff) seen.add(s.botId);
        }
        resolve([{ distinctBots: seen.size }]);
        return;
      }
      // List path (admin getDisabledEndpoints): no endpoint filter, just
      // activeNow.
      const now = ctx.activeNow ?? new Date();
      const rows = store.disabled.filter((d) => d.enabledAgainAt >= now);
      resolve(rows);
    };

    return chain;
  }

  function makeDeleteChain(table: { __table?: string }): unknown {
    const tableName = table.__table;
    const ctx: Ctx = {};
    const chain: Record<string, unknown> = {};

    chain.where = (clause: { __ctx?: Ctx }) => {
      mergeCtx(ctx, clause);
      return chain;
    };

    chain.returning = async (): Promise<unknown[]> => {
      if (tableName === "endpoint_disabled") {
        const before = store.disabled.length;
        for (let i = store.disabled.length - 1; i >= 0; i -= 1) {
          if (store.disabled[i].endpoint === ctx.endpoint) {
            store.disabled.splice(i, 1);
          }
        }
        const removed = before - store.disabled.length;
        return Array.from({ length: removed }, () => ({
          endpoint: ctx.endpoint,
        }));
      }
      return [];
    };

    (chain as { then?: unknown }).then = (
      resolve: (rows: unknown[]) => void,
    ): void => {
      if (tableName === "endpoint_strikes") {
        const ep = ctx.endpoint;
        const cutoff = ctx.cutoff;
        for (let i = store.strikes.length - 1; i >= 0; i -= 1) {
          const s = store.strikes[i];
          if (s.endpoint === ep) {
            if (cutoff === undefined || s.failedAt >= cutoff) {
              store.strikes.splice(i, 1);
            }
          }
        }
        resolve([]);
        return;
      }

      if (tableName === "endpoint_disabled") {
        const ep = ctx.endpoint;
        if (ctx.expiredNow !== undefined) {
          // Lazy GC: delete only rows whose enabledAgainAt < expiredNow.
          for (let i = store.disabled.length - 1; i >= 0; i -= 1) {
            const d = store.disabled[i];
            if (d.endpoint === ep && d.enabledAgainAt < ctx.expiredNow) {
              store.disabled.splice(i, 1);
            }
          }
        } else {
          // Manual enable: delete every row for that endpoint.
          for (let i = store.disabled.length - 1; i >= 0; i -= 1) {
            if (store.disabled[i].endpoint === ep) {
              store.disabled.splice(i, 1);
            }
          }
        }
        resolve([]);
        return;
      }
      resolve([]);
    };

    return chain;
  }

  // B7: conditional UPDATE used by the half-open probe claim (in
  // getActiveDisabled) and the probe-failure extension (in recordStrike).
  // Mirrors Postgres semantics: only rows matching ALL where-clauses are
  // mutated, and .returning() reports exactly the rows that changed — so an
  // already-claimed probe (fresh disabled_at > probeCutoff) returns [].
  function makeUpdateChain(table: { __table?: string }): unknown {
    const tableName = table.__table;
    const ctx: Ctx = {};
    let setValues: Partial<DisabledRow> = {};
    const chain: Record<string, unknown> = {};

    chain.set = (vals: Partial<DisabledRow>) => {
      setValues = vals;
      return chain;
    };
    chain.where = (clause: { __ctx?: Ctx }) => {
      mergeCtx(ctx, clause);
      return chain;
    };
    chain.returning = async (): Promise<unknown[]> => {
      if (tableName !== "endpoint_disabled") return [];
      const updated: Array<{ endpoint: string }> = [];
      for (const d of store.disabled) {
        if (ctx.endpoint !== undefined && d.endpoint !== ctx.endpoint) continue;
        if (ctx.activeNow !== undefined && d.enabledAgainAt < ctx.activeNow) {
          continue;
        }
        if (ctx.probeCutoff !== undefined && d.disabledAt > ctx.probeCutoff) {
          continue;
        }
        Object.assign(d, setValues);
        updated.push({ endpoint: d.endpoint });
      }
      return updated;
    };

    return chain;
  }

  return {
    db: {
      insert: (table: unknown) => makeInsertChain(table as { __table?: string }),
      select: (cols?: Record<string, unknown>) => makeSelectChain(cols),
      delete: (table: unknown) => makeDeleteChain(table as { __table?: string }),
      update: (table: unknown) => makeUpdateChain(table as { __table?: string }),
    },
  };
});

// ── Module under test (after all mocks) ─────────────────────────────────────

import {
  EndpointDisabledError,
  __TESTING__,
  getActiveDisabled,
  getDisabledEndpoints,
  isEndpointDisabled,
  manualEnableEndpoint,
  recordStrike,
  recordSuccess,
} from "../endpoint-strikes.js";

const ENDPOINT = "likers";

beforeEach(() => {
  store.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-07T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("endpoint-strikes", () => {
  it("1 strike from 1 bot → not disabled", async () => {
    await recordStrike(ENDPOINT, "bot-A", "401");
    expect(await isEndpointDisabled(ENDPOINT)).toBe(false);
    expect(store.strikes.length).toBe(1);
    expect(store.disabled.length).toBe(0);
  });

  it("2 strikes from 2 distinct bots → not disabled", async () => {
    await recordStrike(ENDPOINT, "bot-A", "401");
    await recordStrike(ENDPOINT, "bot-B", "403");
    expect(await isEndpointDisabled(ENDPOINT)).toBe(false);
    expect(store.disabled.length).toBe(0);
  });

  it("3 strikes from 3 distinct bots → DISABLED", async () => {
    await recordStrike(ENDPOINT, "bot-A", "401");
    await recordStrike(ENDPOINT, "bot-B", "403");
    await recordStrike(ENDPOINT, "bot-C", "checkpoint_required");
    expect(await isEndpointDisabled(ENDPOINT)).toBe(true);
    expect(store.disabled.length).toBe(1);
    const row = store.disabled[0];
    expect(row.endpoint).toBe(ENDPOINT);
    const expectedUntil = Date.now() + __TESTING__.DISABLE_DURATION_MS;
    expect(row.enabledAgainAt.getTime()).toBe(expectedUntil);
    expect(row.reason).toContain("3 distinct bots");
  });

  it("3 strikes from the SAME bot → NOT disabled (distinct bots required)", async () => {
    await recordStrike(ENDPOINT, "bot-A", "401");
    vi.advanceTimersByTime(1000);
    await recordStrike(ENDPOINT, "bot-A", "401");
    vi.advanceTimersByTime(1000);
    await recordStrike(ENDPOINT, "bot-A", "401");
    expect(await isEndpointDisabled(ENDPOINT)).toBe(false);
    expect(store.disabled.length).toBe(0);
  });

  it("recordSuccess clears strikes and lifts the disable", async () => {
    await recordStrike(ENDPOINT, "bot-A");
    await recordStrike(ENDPOINT, "bot-B");
    await recordStrike(ENDPOINT, "bot-C");
    expect(await isEndpointDisabled(ENDPOINT)).toBe(true);

    await recordSuccess(ENDPOINT);
    expect(await isEndpointDisabled(ENDPOINT)).toBe(false);
    expect(store.strikes.length).toBe(0);
    expect(store.disabled.length).toBe(0);
  });

  it("strikes outside the 1h window do NOT count toward threshold", async () => {
    await recordStrike(ENDPOINT, "bot-A", "401");
    await recordStrike(ENDPOINT, "bot-B", "403");
    expect(await isEndpointDisabled(ENDPOINT)).toBe(false);

    // Advance 2 hours past the 1h rolling window.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    await recordStrike(ENDPOINT, "bot-C", "checkpoint_required");

    // Only bot-C is inside the rolling window → still under threshold.
    expect(await isEndpointDisabled(ENDPOINT)).toBe(false);
  });

  it("disable expires after 24h (lazy GC inside isEndpointDisabled)", async () => {
    await recordStrike(ENDPOINT, "bot-A");
    await recordStrike(ENDPOINT, "bot-B");
    await recordStrike(ENDPOINT, "bot-C");
    expect(await isEndpointDisabled(ENDPOINT)).toBe(true);

    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(await isEndpointDisabled(ENDPOINT)).toBe(false);
    expect(store.disabled.length).toBe(0);
  });

  it("getActiveDisabled returns the full disabled-row info when active", async () => {
    await recordStrike(ENDPOINT, "bot-A", "401");
    await recordStrike(ENDPOINT, "bot-B", "403");
    await recordStrike(ENDPOINT, "bot-C", "checkpoint_required");

    const info = await getActiveDisabled(ENDPOINT);
    expect(info).not.toBeNull();
    if (!info) throw new Error("expected info");
    expect(info.endpoint).toBe(ENDPOINT);
    expect(info.until.getTime()).toBeGreaterThan(Date.now());
    expect(info.reason).toContain("3 distinct bots");
  });

  it("getDisabledEndpoints lists currently-disabled endpoints", async () => {
    await recordStrike("likers", "bot-A");
    await recordStrike("likers", "bot-B");
    await recordStrike("likers", "bot-C");

    const list = await getDisabledEndpoints();
    expect(list.length).toBe(1);
    expect(list[0].endpoint).toBe("likers");
  });

  it("manualEnableEndpoint clears the disabled row and recent strikes", async () => {
    await recordStrike(ENDPOINT, "bot-A");
    await recordStrike(ENDPOINT, "bot-B");
    await recordStrike(ENDPOINT, "bot-C");
    expect(await isEndpointDisabled(ENDPOINT)).toBe(true);

    const wasDisabled = await manualEnableEndpoint(ENDPOINT);
    expect(wasDisabled).toBe(true);
    expect(await isEndpointDisabled(ENDPOINT)).toBe(false);
    expect(store.strikes.length).toBe(0);
  });

  it("EndpointDisabledError carries endpoint, until, reason", () => {
    const until = new Date("2026-05-08T12:00:00Z");
    const err = new EndpointDisabledError("likers", until, "test reason");
    expect(err.name).toBe("EndpointDisabledError");
    expect(err.endpoint).toBe("likers");
    expect(err.until).toEqual(until);
    expect(err.reason).toBe("test reason");
    expect(err.message).toContain("likers");
    expect(err.message).toContain(until.toISOString());
  });
});

// ─── B7: half-open probe recovery ───────────────────────────────────────────

describe("half-open probe (B7)", () => {
  const PROBE_MS = __TESTING__.DEFAULT_PROBE_AFTER_MS;

  async function disableEndpoint(): Promise<void> {
    await recordStrike(ENDPOINT, "bot-A", "feedback_required");
    await recordStrike(ENDPOINT, "bot-B", "feedback_required");
    await recordStrike(ENDPOINT, "bot-C", "feedback_required");
    expect(store.disabled.length).toBe(1);
  }

  it("blocks every caller before the probe window elapses (OPEN)", async () => {
    await disableEndpoint();
    vi.advanceTimersByTime(PROBE_MS - 60_000);
    expect(await getActiveDisabled(ENDPOINT)).not.toBeNull();
    // No claim happened — disabledAt untouched.
    expect(store.disabled[0].disabledAt.getTime()).toBe(
      Date.now() - (PROBE_MS - 60_000),
    );
  });

  it("after the probe window, exactly ONE caller is let through and the window re-arms", async () => {
    await disableEndpoint();
    vi.advanceTimersByTime(PROBE_MS + 1000);

    // First caller claims the probe → null (call proceeds).
    expect(await getActiveDisabled(ENDPOINT)).toBeNull();
    // The claim stamped disabled_at = now (probe clock re-armed).
    expect(store.disabled[0].disabledAt.getTime()).toBe(Date.now());

    // Subsequent callers are still blocked…
    expect(await getActiveDisabled(ENDPOINT)).not.toBeNull();
    vi.advanceTimersByTime(PROBE_MS - 60_000);
    expect(await getActiveDisabled(ENDPOINT)).not.toBeNull();

    // …until another full probe window has elapsed.
    vi.advanceTimersByTime(2 * 60_000);
    expect(await getActiveDisabled(ENDPOINT)).toBeNull();
  });

  it("probe success → recordSuccess clears the disable and strikes (CLOSED)", async () => {
    await disableEndpoint();
    vi.advanceTimersByTime(PROBE_MS + 1000);
    expect(await getActiveDisabled(ENDPOINT)).toBeNull(); // probe claimed

    await recordSuccess(ENDPOINT);

    expect(await isEndpointDisabled(ENDPOINT)).toBe(false);
    expect(await getActiveDisabled(ENDPOINT)).toBeNull();
    expect(store.disabled.length).toBe(0);
    expect(store.strikes.length).toBe(0);
  });

  it("probe failure → recordStrike extends the disable (capped at 24h from now) and re-arms the window", async () => {
    await disableEndpoint();
    const originalUntil = store.disabled[0].enabledAgainAt.getTime();

    vi.advanceTimersByTime(PROBE_MS + 1000);
    expect(await getActiveDisabled(ENDPOINT)).toBeNull(); // probe claimed

    await recordStrike(ENDPOINT, "bot-D", "feedback_required");

    expect(store.disabled.length).toBe(1);
    const row = store.disabled[0];
    expect(row.enabledAgainAt.getTime()).toBe(
      Date.now() + __TESTING__.DISABLE_DURATION_MS,
    );
    expect(row.enabledAgainAt.getTime()).toBeGreaterThan(originalUntil);
    expect(row.reason).toContain("probe failed");

    // Still blocked for everyone…
    expect(await getActiveDisabled(ENDPOINT)).not.toBeNull();
    // …and the NEXT probe needs another full window after the failure.
    vi.advanceTimersByTime(PROBE_MS + 1000);
    expect(await getActiveDisabled(ENDPOINT)).toBeNull();
  });

  it("a probe-failure strike does NOT run the 3-distinct-bot threshold logic", async () => {
    await disableEndpoint();
    vi.advanceTimersByTime(PROBE_MS + 1000);
    expect(await getActiveDisabled(ENDPOINT)).toBeNull(); // probe claimed

    // Single probe-failure strike from one bot — extension path, the
    // disabled row stays singular (no duplicate upsert from the threshold
    // branch) and the reason reflects the probe failure.
    await recordStrike(ENDPOINT, "bot-D", "feedback_required");
    expect(store.disabled.length).toBe(1);
    expect(store.disabled[0].reason).toContain("probe failed");
    expect(store.disabled[0].reason).not.toContain("distinct bots");
  });

  it("manual admin re-enable still works after a probe-failure extension", async () => {
    await disableEndpoint();
    vi.advanceTimersByTime(PROBE_MS + 1000);
    expect(await getActiveDisabled(ENDPOINT)).toBeNull(); // probe claimed
    await recordStrike(ENDPOINT, "bot-D", "feedback_required"); // extended

    const removed = await manualEnableEndpoint(ENDPOINT);
    expect(removed).toBe(true);
    expect(await getActiveDisabled(ENDPOINT)).toBeNull();
    expect(store.disabled.length).toBe(0);
    expect(store.strikes.length).toBe(0);
  });

  it("isEndpointDisabled is a passive read — it never consumes the probe slot", async () => {
    await disableEndpoint();
    vi.advanceTimersByTime(PROBE_MS + 1000);

    // Passive check: still reports disabled, does not claim.
    expect(await isEndpointDisabled(ENDPOINT)).toBe(true);
    expect(store.disabled[0].disabledAt.getTime()).toBe(
      Date.now() - (PROBE_MS + 1000),
    );

    // The probe slot is still available for the real gate.
    expect(await getActiveDisabled(ENDPOINT)).toBeNull();
  });

  it("honours the ENDPOINT_DISABLE_PROBE_AFTER_MS env override", async () => {
    vi.stubEnv("ENDPOINT_DISABLE_PROBE_AFTER_MS", "60000");
    try {
      await disableEndpoint();
      vi.advanceTimersByTime(30_000);
      expect(await getActiveDisabled(ENDPOINT)).not.toBeNull();
      vi.advanceTimersByTime(31_000);
      expect(await getActiveDisabled(ENDPOINT)).toBeNull(); // probe at 61s
    } finally {
      vi.stubEnv("ENDPOINT_DISABLE_PROBE_AFTER_MS", "");
    }
  });

  it("probeAfterMs falls back to the default for unset/garbage/non-positive env", () => {
    vi.stubEnv("ENDPOINT_DISABLE_PROBE_AFTER_MS", "");
    expect(__TESTING__.probeAfterMs()).toBe(PROBE_MS);
    vi.stubEnv("ENDPOINT_DISABLE_PROBE_AFTER_MS", "garbage");
    expect(__TESTING__.probeAfterMs()).toBe(PROBE_MS);
    vi.stubEnv("ENDPOINT_DISABLE_PROBE_AFTER_MS", "-5");
    expect(__TESTING__.probeAfterMs()).toBe(PROBE_MS);
    vi.stubEnv("ENDPOINT_DISABLE_PROBE_AFTER_MS", "0");
    expect(__TESTING__.probeAfterMs()).toBe(PROBE_MS);
    vi.stubEnv("ENDPOINT_DISABLE_PROBE_AFTER_MS", "120000");
    expect(__TESTING__.probeAfterMs()).toBe(120_000);
    vi.stubEnv("ENDPOINT_DISABLE_PROBE_AFTER_MS", "");
  });
});
