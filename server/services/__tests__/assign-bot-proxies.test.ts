// Unit tests for server/scripts/assign-bot-proxies.ts and the
// `getOrAssignBotProxy` / `countryForBotIndex` helpers added to
// server/services/proxy-provider.ts.
//
// Everything that touches the network or the DB is mocked so the suite runs
// in a few milliseconds and is safe to run in CI without secrets.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Env stub — db.ts throws at import if DATABASE_URL is missing.
// ---------------------------------------------------------------------------

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
vi.stubEnv("SMARTPROXY_API_URL", "https://provider.example.com/api");
// These tests drive the provider's API path (they mock global.fetch). The real
// .env configures a STATIC_PROXY_* range, and dotenv leaks it into process.env
// here — the provider then serves a static endpoint, never calls fetch, and the
// "rejects on a failed fetch" cases resolve instead. Pin the static range OFF so
// the suite tests what it claims to and stops depending on the machine's .env.
vi.stubEnv("STATIC_PROXY_HOST", "");
vi.stubEnv("STATIC_PROXY_PORT_START", "");
vi.stubEnv("STATIC_PROXY_PORT_END", "");
vi.stubEnv("STATIC_PROXY_USERNAME", "");
vi.stubEnv("STATIC_PROXY_PASSWORD", "");
vi.stubEnv("DATAIMPULSE_PROXY_URL", "");
vi.stubEnv("PROXY_GATEWAY_HOST", "");
vi.stubEnv("PROXY_GATEWAY_PORT", "");
vi.stubEnv("PROXY_GATEWAY_USERNAME", "");
vi.stubEnv("PROXY_GATEWAY_PASSWORD", "");

// ---------------------------------------------------------------------------
// Logger mock — silences info/warn during the test run.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock the db module so the script never opens a real connection.
// vi.hoisted ensures the mock fn is available when vi.mock factories run.
// ---------------------------------------------------------------------------

const { dbExecute } = vi.hoisted(() => ({ dbExecute: vi.fn() }));

vi.mock("../../db.js", () => ({
  db: { execute: dbExecute },
}));

// ---------------------------------------------------------------------------
// drizzle-orm sql tag — a tagged-template proxy that captures arguments so
// SQL strings don't need to be parsed in tests.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  sql: new Proxy(
    Object.assign((...args: unknown[]) => args, {
      raw: (...args: unknown[]) => args,
      join: (...args: unknown[]) => args,
    }),
    {
      get(target, prop) {
        if (prop === "raw") return (...args: unknown[]) => args;
        if (prop === "join") return (...args: unknown[]) => args;
        return (target as Record<string | symbol, unknown>)[prop];
      },
      apply(_target, _thisArg, args) {
        return args;
      },
    },
  ),
}));

// ---------------------------------------------------------------------------
// Imports — must come *after* the vi.mock calls above.
// ---------------------------------------------------------------------------

import {
  assignBotProxies,
} from "../../scripts/assign-bot-proxies.js";
import {
  countryForBotIndex,
  COUNTRY_SCHEDULE,
  getOrAssignBotProxy,
  type BotProxyState,
  type ProxyEndpoint,
} from "../proxy-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SeedBot {
  id: string;
  ig_username: string;
  session_data: string | null;
  proxy_endpoint: string | null;
  proxy_session_id: string | null;
  proxy_expires_at: Date | null;
}

function bot(
  id: string,
  username: string,
  overrides: Partial<SeedBot> = {},
): SeedBot {
  return {
    id,
    ig_username: username,
    session_data: null,
    proxy_endpoint: null,
    proxy_session_id: null,
    proxy_expires_at: null,
    ...overrides,
  };
}

function makeEndpoint(
  endpoint: string,
  sessionId: string,
  ttlMs = 30 * 60 * 1000,
): ProxyEndpoint {
  return {
    endpoint,
    sessionId,
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

function setupSelect(rows: SeedBot[]): void {
  // First call is the SELECT; subsequent calls are the per-bot UPDATEs.
  dbExecute.mockReset();
  dbExecute.mockResolvedValueOnce({ rows });
  dbExecute.mockResolvedValue({ rows: [] });
}

// ---------------------------------------------------------------------------
// countryForBotIndex — deterministic stratified schedule
// ---------------------------------------------------------------------------

describe("countryForBotIndex", () => {
  it("exposes the documented schedule (US 60 / GB 25 / DE 10 / FR 5)", () => {
    expect(COUNTRY_SCHEDULE.map((s) => s.country)).toEqual([
      "US",
      "GB",
      "DE",
      "FR",
    ]);
    expect(COUNTRY_SCHEDULE.map((s) => s.cumulative)).toEqual([
      0.6, 0.85, 0.95, 1.0,
    ]);
  });

  it("returns US for the first bot in any pool", () => {
    expect(countryForBotIndex(0, 1)).toBe("US");
    expect(countryForBotIndex(0, 100)).toBe("US");
  });

  it("matches the schedule on a 100-bot pool", () => {
    const counts: Record<string, number> = { US: 0, GB: 0, DE: 0, FR: 0 };
    for (let i = 0; i < 100; i += 1) {
      const c = countryForBotIndex(i, 100);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    expect(counts).toEqual({ US: 60, GB: 25, DE: 10, FR: 5 });
  });

  it("is deterministic — same (index,total) always yields the same country", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(countryForBotIndex(i, 20)).toBe(countryForBotIndex(i, 20));
    }
  });

  it("approximates the schedule on small pools (<10 bots)", () => {
    // For very small pools the exact percentages can't fit, but the prefix
    // must still start with US-only and cover at least one secondary country
    // when total is large enough.
    const seven = Array.from({ length: 7 }, (_, i) =>
      countryForBotIndex(i, 7),
    );
    expect(seven[0]).toBe("US");
    expect(seven.includes("GB")).toBe(true);
  });

  it("guards against out-of-range indices by clamping into the valid slot range", () => {
    // Negative indices clamp to slot 0 (US), oversized indices clamp to the
    // last slot — for total=10 that's index 9 (DE bucket: position=0.95).
    expect(countryForBotIndex(-1, 10)).toBe("US");
    expect(countryForBotIndex(99, 10)).toBe("DE");
    // For total=20 the last slot does land in FR.
    expect(countryForBotIndex(99, 20)).toBe("FR");
  });

  it("returns US when total is zero", () => {
    expect(countryForBotIndex(0, 0)).toBe("US");
  });
});

// ---------------------------------------------------------------------------
// getOrAssignBotProxy — pure helper, no DB
// ---------------------------------------------------------------------------

describe("getOrAssignBotProxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the cached lane when sticky window is fresh", async () => {
    const fresh = new Date(Date.now() + 20 * 60 * 1000);
    const state: BotProxyState = {
      proxyEndpoint: "1.2.3.4:8080",
      proxySessionId: "8080",
      proxyExpiresAt: fresh,
    };
    const result = await getOrAssignBotProxy(state, { country: "US" });
    expect(result.refreshed).toBe(false);
    expect(result.endpoint.endpoint).toBe("1.2.3.4:8080");
    expect(result.endpoint.sessionId).toBe("8080");
  });

  it("re-fetches when the bot has no stored lane", async () => {
    const state: BotProxyState = {
      proxyEndpoint: null,
      proxySessionId: null,
      proxyExpiresAt: null,
    };
    // Stub the network layer indirectly through fetch + undici mocks isn't
    // worth wiring here — the canonical happy-path is exercised in the
    // assignBotProxies tests below where `resolve` is injected.
    // For this test we just assert the helper attempts a fresh fetch and
    // surfaces the provider failure shape rather than silently falling back.
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 500 }),
    );
    await expect(getOrAssignBotProxy(state, { country: "US" }))
      .rejects.toThrow();
  });

  it("re-fetches when the cached lane is past the refresh guard", async () => {
    const state: BotProxyState = {
      proxyEndpoint: "1.2.3.4:8080",
      proxySessionId: "8080",
      proxyExpiresAt: new Date(Date.now() - 60_000),
    };
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 500 }),
    );
    await expect(getOrAssignBotProxy(state, { country: "US" }))
      .rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assignBotProxies — script behaviour with injected fakes
// ---------------------------------------------------------------------------

describe("assignBotProxies", () => {
  const noDelay = async () => {};

  beforeEach(() => {
    dbExecute.mockReset();
  });

  it("returns an empty result when there are no bots", async () => {
    setupSelect([]);
    const resolve = vi.fn();
    const result = await assignBotProxies({ resolve, delay: noDelay });
    expect(result.totals).toEqual({
      total: 0,
      assigned: 0,
      skipped: 0,
      errored: 0,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("assigns endpoints to bots without a session_id", async () => {
    const bots: SeedBot[] = [
      bot("id-1", "alice"),
      bot("id-2", "bob"),
      bot("id-3", "carol"),
    ];
    setupSelect(bots);
    const resolve = vi.fn().mockImplementation(async () => ({
      endpoint: makeEndpoint("9.9.9.9:7777", "7777"),
      refreshed: true,
    }));

    const result = await assignBotProxies({ resolve, delay: noDelay });

    expect(resolve).toHaveBeenCalledTimes(3);
    expect(result.totals.assigned).toBe(3);
    expect(result.totals.skipped).toBe(0);
    expect(result.totals.errored).toBe(0);
    // 1 SELECT + 3 UPDATEs
    expect(dbExecute).toHaveBeenCalledTimes(4);
  });

  it("skips bots that already have a fresh sticky session_id", async () => {
    const fresh = new Date(Date.now() + 20 * 60 * 1000);
    const bots: SeedBot[] = [
      bot("id-1", "alice", {
        proxy_endpoint: "1.1.1.1:8001",
        proxy_session_id: "8001",
        proxy_expires_at: fresh,
      }),
      bot("id-2", "bob"),
    ];
    setupSelect(bots);
    const resolve = vi.fn().mockResolvedValue({
      endpoint: makeEndpoint("9.9.9.9:7777", "7777"),
      refreshed: true,
    });

    const result = await assignBotProxies({ resolve, delay: noDelay });

    expect(resolve).toHaveBeenCalledTimes(1); // only bob
    expect(result.totals.skipped).toBe(1);
    expect(result.totals.assigned).toBe(1);
    expect(
      result.outcomes.find((o) => o.igUsername === "alice")?.action,
    ).toBe("skip");
    expect(
      result.outcomes.find((o) => o.igUsername === "bob")?.action,
    ).toBe("assigned");
  });

  it("re-assigns bots whose sticky window has expired", async () => {
    const expired = new Date(Date.now() - 5 * 60 * 1000);
    const bots: SeedBot[] = [
      bot("id-1", "alice", {
        proxy_endpoint: "1.1.1.1:8001",
        proxy_session_id: "8001",
        proxy_expires_at: expired,
      }),
    ];
    setupSelect(bots);
    const resolve = vi.fn().mockResolvedValue({
      endpoint: makeEndpoint("2.2.2.2:9090", "9090"),
      refreshed: true,
    });

    const result = await assignBotProxies({ resolve, delay: noDelay });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.totals.assigned).toBe(1);
    expect(result.totals.skipped).toBe(0);
  });

  it("refuses to rotate an expired lane underneath an authenticated session", async () => {
    const expired = new Date(Date.now() - 5 * 60 * 1000);
    const bots: SeedBot[] = [
      bot("id-1", "alice", {
        session_data: "v1:encrypted-session",
        proxy_endpoint: "1.1.1.1:8001",
        proxy_session_id: "8001",
        proxy_expires_at: expired,
      }),
    ];
    setupSelect(bots);
    const resolve = vi.fn();

    const result = await assignBotProxies({ resolve, delay: noDelay });

    expect(resolve).not.toHaveBeenCalled();
    expect(dbExecute).toHaveBeenCalledTimes(1);
    expect(result.totals.errored).toBe(1);
    expect(result.outcomes[0]?.reason).toContain("refusing IP rotation");
  });

  it("captures provider errors as per-bot failures without aborting the run", async () => {
    const bots: SeedBot[] = [
      bot("id-1", "alice"),
      bot("id-2", "bob"),
      bot("id-3", "carol"),
    ];
    setupSelect(bots);
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        endpoint: makeEndpoint("1.1.1.1:1111", "1111"),
        refreshed: true,
      })
      .mockRejectedValueOnce(new Error("provider exhausted"))
      .mockResolvedValueOnce({
        endpoint: makeEndpoint("3.3.3.3:3333", "3333"),
        refreshed: true,
      });

    const result = await assignBotProxies({ resolve, delay: noDelay });

    expect(result.totals.assigned).toBe(2);
    expect(result.totals.errored).toBe(1);
    expect(
      result.outcomes.find((o) => o.igUsername === "bob")?.reason,
    ).toContain("provider exhausted");
  });

  it("distributes countries across bots according to the schedule", async () => {
    // 20 bots → 12 US, 5 GB, 2 DE, 1 FR
    const bots: SeedBot[] = Array.from({ length: 20 }, (_, i) =>
      bot(`id-${i}`, `user${i}`),
    );
    setupSelect(bots);
    const resolve = vi.fn().mockImplementation(async () => ({
      endpoint: makeEndpoint("9.9.9.9:7777", "7777"),
      refreshed: true,
    }));

    const result = await assignBotProxies({ resolve, delay: noDelay });

    const counts: Record<string, number> = {};
    for (const o of result.outcomes) {
      counts[o.country] = (counts[o.country] ?? 0) + 1;
    }
    expect(counts).toEqual({ US: 12, GB: 5, DE: 2, FR: 1 });

    // The country passed into the resolver matches the outcome country.
    for (let i = 0; i < bots.length; i += 1) {
      const callArgs = resolve.mock.calls[i];
      expect(callArgs?.[1]).toMatchObject({
        country: result.outcomes[i].country,
      });
    }
  });

  it("paces sequential provider calls via the injected delay", async () => {
    const bots: SeedBot[] = [
      bot("id-1", "alice"),
      bot("id-2", "bob"),
      bot("id-3", "carol"),
    ];
    setupSelect(bots);
    const resolve = vi.fn().mockResolvedValue({
      endpoint: makeEndpoint("9.9.9.9:7777", "7777"),
      refreshed: true,
    });
    const delay = vi.fn().mockResolvedValue(undefined);

    await assignBotProxies({ resolve, delay });

    // 3 bots → 2 inter-bot gaps (no gap after the last one).
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(3_000);
  });

  it("processes bots in stable created_at,ig_username order", async () => {
    const bots: SeedBot[] = [
      bot("id-a", "aaa"),
      bot("id-b", "bbb"),
      bot("id-c", "ccc"),
    ];
    setupSelect(bots);
    const seen: string[] = [];
    const resolve = vi.fn().mockImplementation(async (state, opts) => {
      seen.push(`${opts?.country}`);
      void state;
      return {
        endpoint: makeEndpoint("9.9.9.9:7777", "7777"),
        refreshed: true,
      };
    });

    const result = await assignBotProxies({ resolve, delay: noDelay });
    expect(result.outcomes.map((o) => o.igUsername)).toEqual([
      "aaa",
      "bbb",
      "ccc",
    ]);
    // 3 bots → positions 0.167 (US), 0.5 (US), 0.833 (GB).
    expect(seen).toEqual(["US", "US", "GB"]);
  });
});
