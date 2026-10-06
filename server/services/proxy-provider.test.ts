// Unit tests for server/services/proxy-provider.ts
// All network calls are mocked — no real HTTP traffic.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// undici mock — probeEndpoint dynamically imports undici; we mock it at the
// module registry level so the dynamic import returns our controlled version.
// ---------------------------------------------------------------------------

// Mutable control objects referenced safely inside the factory (no hoisting issue).
//
//  * fetchOk / fetchIp drive the simple "all probes pass / all fail" tests.
//  * healthyHosts, when non-null, makes a probe succeed only for the listed
//    `host:port` lanes (parsed out of the ProxyAgent uri). This lets the
//    budget/concurrency tests place the single healthy endpoint at a chosen
//    position in the batch.
//  * lastProxyUris records the ProxyAgent uris seen by the mock so a test can
//    assert how many probes ran (budget) and that real credentials reached
//    undici unredacted.
//  * probeDelayMs lets a test stall a probe so we can observe race-cancel via
//    the AbortSignal.
const undiciControl: {
  fetchOk: boolean;
  fetchIp: string;
  healthyHosts: string[] | null;
  lastProxyUris: string[];
  abortedCount: number;
  probeDelayMs: number;
  delayForHost: Record<string, number>;
} = {
  fetchOk: true,
  fetchIp: "203.0.113.1",
  healthyHosts: null,
  lastProxyUris: [],
  abortedCount: 0,
  probeDelayMs: 0,
  delayForHost: {},
};

function hostPortFromUri(uri: string): string {
  // uri is http://[user:pass@]host:port — strip scheme + creds for matching.
  const noScheme = uri.replace(/^https?:\/\//i, "");
  const afterCreds = noScheme.includes("@")
    ? noScheme.slice(noScheme.indexOf("@") + 1)
    : noScheme;
  return afterCreds;
}

vi.mock("undici", () => ({
  ProxyAgent: function ProxyAgent(opts: { uri: string }) {
    undiciControl.lastProxyUris.push(opts.uri);
    return { __uri: opts.uri };
  },
  fetch: async (
    _url: string,
    init: { dispatcher?: { __uri?: string }; signal?: AbortSignal },
  ) => {
    const uri = init?.dispatcher?.__uri ?? "";
    const host = hostPortFromUri(uri);
    const delay = undiciControl.delayForHost[host] ?? undiciControl.probeDelayMs;
    if (delay > 0) {
      // Honour an external abort (race-cancel) while stalling. Clean the
      // listener up on normal resolution so a later abort() can't fire a
      // stale listener for a fetch that already completed.
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          undiciControl.abortedCount += 1;
          init?.signal?.removeEventListener("abort", onAbort);
          reject(new Error("aborted"));
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          init?.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        init?.signal?.addEventListener("abort", onAbort);
      });
    }
    const ok =
      undiciControl.healthyHosts === null
        ? undiciControl.fetchOk
        : undiciControl.healthyHosts.includes(hostPortFromUri(uri));
    return {
      ok,
      status: ok ? 200 : 500,
      text: async () =>
        ok ? `<html><body>${"x".repeat(600)}</body></html>` : undiciControl.fetchIp,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  },
}));

// ---------------------------------------------------------------------------
// Logger mock — single stable child so tests can assert on emitted records.
// vi.hoisted makes the spy available when proxy-provider.ts calls
// `logger.child(...)` at module-load time (before the const would init).
// ---------------------------------------------------------------------------

const loggerSpy = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../observability/logger.js", () => ({
  logger: {
    child: () => loggerSpy,
  },
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import {
  fetchEndpoints,
  isEndpointFresh,
  fetchHealthyEndpoints,
  redactProxyListSample,
  scrubProxyCredential,
  proxyAgentUriForEndpoint,
  resetProxyProviderHealth,
} from "./proxy-provider.js";

beforeEach(() => {
  resetProxyProviderHealth();
  // Production may define the atomic DataImpulse override in .env. Tests set
  // it explicitly only when exercising that path.
  vi.stubEnv("DATAIMPULSE_PROXY_URL", "");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_BODY = [
  "192.168.1.1:8080",
  "10.0.0.1:9000",
  "172.16.0.5:3128",
].join("\n");

function makeFetchResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// fetchEndpoints — successful parse
// ---------------------------------------------------------------------------

describe("fetchEndpoints — successful parse", () => {
  beforeEach(() => {
    vi.stubEnv("SMARTPROXY_API_URL", "https://provider.example.com/api");
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeFetchResponse(SAMPLE_BODY),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("parses three valid host:port lines", async () => {
    const endpoints = await fetchEndpoints();
    expect(endpoints).toHaveLength(3);
  });

  it("maps each line to the correct endpoint string", async () => {
    const endpoints = await fetchEndpoints();
    const values = endpoints.map((e) => e.endpoint);
    expect(values).toContain("192.168.1.1:8080");
    expect(values).toContain("10.0.0.1:9000");
    expect(values).toContain("172.16.0.5:3128");
  });

  it("derives sessionId from the endpoint lane", async () => {
    const endpoints = await fetchEndpoints();
    const first = endpoints.find((e) => e.endpoint === "192.168.1.1:8080");
    expect(first?.sessionId).toBe("192.168.1.1:8080");
  });

  it("sets expiresAt ~30 minutes in the future", async () => {
    const before = Date.now();
    const endpoints = await fetchEndpoints();
    const after = Date.now();
    for (const ep of endpoints) {
      const ms = ep.expiresAt.getTime();
      expect(ms).toBeGreaterThan(before + 29 * 60 * 1000);
      expect(ms).toBeLessThan(after + 31 * 60 * 1000);
    }
  });

  it("ignores blank lines and non-IP lines in the body", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeFetchResponse("# comment\n192.168.1.1:8080\n\nbadline\n10.0.0.1:9000"),
    );
    const endpoints = await fetchEndpoints();
    expect(endpoints).toHaveLength(2);
  });

  it("parses lines separated by literal \\n (txt with lb=\\n format)", async () => {
    const body = "192.168.1.1:8080\\n10.0.0.1:9000";
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(body));
    const endpoints = await fetchEndpoints();
    expect(endpoints).toHaveLength(2);
  });

  it("forwards count option as num query param", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeFetchResponse(SAMPLE_BODY),
    );
    await fetchEndpoints({ count: 7 });
    const calledUrl = String((spy.mock.calls[0] as [string])[0]);
    expect(calledUrl).toContain("num=7");
  });

  it("forwards country option as cc query param", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeFetchResponse(SAMPLE_BODY),
    );
    await fetchEndpoints({ country: "GB" });
    const calledUrl = String((spy.mock.calls[0] as [string])[0]);
    expect(calledUrl).toContain("cc=GB");
  });

  it("uses apiUrl override instead of env var", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeFetchResponse(SAMPLE_BODY),
    );
    await fetchEndpoints({ apiUrl: "https://override.example.com/ep" });
    const calledUrl = String((spy.mock.calls[0] as [string])[0]);
    expect(calledUrl).toContain("override.example.com");
  });
});

// ---------------------------------------------------------------------------
// fetchEndpoints — static authenticated port range
// ---------------------------------------------------------------------------

describe("fetchEndpoints — static authenticated range", () => {
  beforeEach(() => {
    vi.stubEnv("STATIC_PROXY_HOST", "gw.example.com");
    vi.stubEnv("STATIC_PROXY_PORT_START", "10000");
    vi.stubEnv("STATIC_PROXY_PORT_END", "10004");
    vi.stubEnv("STATIC_PROXY_USERNAME", "user");
    vi.stubEnv("STATIC_PROXY_PASSWORD", "pass");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("generates canonical authenticated endpoints from a port range", async () => {
    const endpoints = await fetchEndpoints({ count: 3, purpose: "public-read" });
    expect(endpoints).toHaveLength(3);
    expect(endpoints.every((ep) => ep.endpoint.startsWith("gw.example.com:"))).toBe(true);
    expect(endpoints.every((ep) => ep.endpoint.endsWith(":user:pass"))).toBe(true);
  });

  it("prefers an atomic DataImpulse gateway credential over the legacy range", async () => {
    vi.stubEnv(
      "DATAIMPULSE_PROXY_URL",
      "new-user:new-pass@gw.dataimpulse.test:823",
    );

    const endpoints = await fetchEndpoints({
      count: 3,
      purpose: "public-read",
    });

    expect(endpoints).toHaveLength(3);
    expect(
      endpoints.every((ep) =>
        /^gw\.dataimpulse\.test:823:new-user;sessid\.di[a-z0-9]+:new-pass$/.test(
          ep.endpoint,
        ),
      ),
    ).toBe(true);
    expect(new Set(endpoints.map((ep) => ep.endpoint)).size).toBe(3);
    expect(new Set(endpoints.map((ep) => ep.sessionId)).size).toBe(3);
  });

  it("pins each DataImpulse probe to its own sticky session for later reuse", async () => {
    vi.stubEnv(
      "DATAIMPULSE_PROXY_URL",
      "account__cr.ch:secret@gw.dataimpulse.com:823",
    );

    const before = Date.now();
    const endpoints = await fetchEndpoints({
      count: 2,
      country: "US",
      purpose: "public-read",
    });
    const after = Date.now();

    expect(endpoints).toHaveLength(2);
    expect(
      endpoints.every((ep) =>
        ep.endpoint.includes(":account__cr.us;sessid.") &&
        ep.endpoint.endsWith(":secret"),
      ),
    ).toBe(true);
    expect(new Set(endpoints.map((ep) => ep.endpoint)).size).toBe(2);
    for (const endpoint of endpoints) {
      expect(endpoint.expiresAt.getTime()).toBeGreaterThan(
        before + 29 * 60 * 1000,
      );
      expect(endpoint.expiresAt.getTime()).toBeLessThan(
        after + 31 * 60 * 1000,
      );
    }
  });

  it("caps generated endpoints to the configured port range size", async () => {
    const endpoints = await fetchEndpoints({ count: 20 });
    expect(endpoints).toHaveLength(5);
  });

  it("uses 24 hour freshness for static range ports", async () => {
    const before = Date.now();
    const [endpoint] = await fetchEndpoints({
      count: 1,
      purpose: "public-read",
    });
    const after = Date.now();
    expect(endpoint?.expiresAt.getTime()).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
    expect(endpoint?.expiresAt.getTime()).toBeLessThan(after + 25 * 60 * 60 * 1000);
  });

  it("uses the existing 24-hour assignment validity for fixed sticky lanes", async () => {
    vi.stubEnv("STATIC_PROXY_HOST", "gw.dataimpulse.com");

    const before = Date.now();
    const [endpoint] = await fetchEndpoints({
      count: 1,
      purpose: "public-read",
    });
    const after = Date.now();

    expect(endpoint?.expiresAt.getTime()).toBeGreaterThan(
      before + 23 * 60 * 60 * 1000,
    );
    expect(endpoint?.expiresAt.getTime()).toBeLessThan(
      after + 25 * 60 * 60 * 1000,
    );
  });

  it("does not duplicate a single DataImpulse sticky port as rotating exits", async () => {
    vi.stubEnv("STATIC_PROXY_HOST", "gw.dataimpulse.com");
    vi.stubEnv("STATIC_PROXY_PORT_START", "10000");
    vi.stubEnv("STATIC_PROXY_PORT_END", "10000");

    const endpoints = await fetchEndpoints({
      count: 5,
      purpose: "public-read",
    });

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.sessionId).toBe("gw.dataimpulse.com:10000");
  });

  it("permits the existing fixed sticky lane policy for account sessions", async () => {
    vi.stubEnv("STATIC_PROXY_HOST", "gw.dataimpulse.com");

    const endpoints = await fetchEndpoints({ count: 1, purpose: "account-session" });
    expect(endpoints).toHaveLength(1);
    expect(Number(endpoints[0].endpoint.split(":")[1])).toBeGreaterThanOrEqual(10_000);
  });

  it("uses the optional public sticky-port range with atomic credentials", async () => {
    vi.stubEnv(
      "DATAIMPULSE_PROXY_URL",
      "example-user:example-pass@gw.dataimpulse.com:823",
    );
    vi.stubEnv("DATAIMPULSE_PROXY_PORT_START", "10000");
    vi.stubEnv("DATAIMPULSE_PROXY_PORT_END", "19998");

    const endpoints = await fetchEndpoints({
      count: 3,
      purpose: "public-read",
    });

    expect(endpoints).toHaveLength(3);
    expect(endpoints.every((endpoint) => {
      const port = Number(endpoint.endpoint.split(":")[1]);
      return port >= 10_000 && port <= 19_998;
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchEndpoints — error cases
// ---------------------------------------------------------------------------

describe("fetchEndpoints — error cases", () => {
  beforeEach(() => {
    vi.stubEnv("SMARTPROXY_API_URL", "https://provider.example.com/api");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("throws when response body has no valid IP:port lines", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(""));
    await expect(fetchEndpoints()).rejects.toThrow(/empty endpoint list/);
  });

  it("throws when the HTTP response is not ok", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeFetchResponse("", false, 403),
    );
    await expect(fetchEndpoints()).rejects.toThrow(/HTTP 403/);
  });

  it("throws when SMARTPROXY_API_URL is not configured", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SMARTPROXY_API_URL", "");
    await expect(fetchEndpoints()).rejects.toThrow(/SMARTPROXY_API_URL/);
  });
});

// ---------------------------------------------------------------------------
// isEndpointFresh
// ---------------------------------------------------------------------------

describe("isEndpointFresh", () => {
  it("returns true for an expiry more than 2 minutes in the future", () => {
    const future = new Date(Date.now() + 5 * 60 * 1000);
    expect(isEndpointFresh(future)).toBe(true);
  });

  it("returns false for an expiry at exactly the guard boundary (2 min)", () => {
    // REFRESH_GUARD_MS = 2 * 60 * 1000; condition is strict >, so equal is false
    const boundary = new Date(Date.now() + 2 * 60 * 1000);
    expect(isEndpointFresh(boundary)).toBe(false);
  });

  it("returns false for a past expiry", () => {
    const past = new Date(Date.now() - 1000);
    expect(isEndpointFresh(past)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isEndpointFresh(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isEndpointFresh(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchHealthyEndpoints — uses the undici mock defined at the top
// probeEndpoint uses undici internally; we control it via undiciControl.
// ---------------------------------------------------------------------------

describe("fetchHealthyEndpoints — filtering via undici mock", () => {
  const BATCH = "10.0.0.1:8001\n10.0.0.2:8002\n10.0.0.3:8003";

  beforeEach(() => {
    vi.stubEnv("SMARTPROXY_API_URL", "https://provider.example.com/api");
    undiciControl.fetchOk = true;
    undiciControl.fetchIp = "203.0.113.1";
    undiciControl.healthyHosts = null;
    undiciControl.lastProxyUris = [];
    undiciControl.abortedCount = 0;
    undiciControl.probeDelayMs = 0;
    undiciControl.delayForHost = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns up to wanted healthy endpoints when all probes succeed", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(BATCH));
    undiciControl.fetchOk = true;
    undiciControl.fetchIp = "203.0.113.1"; // valid IP

    const result = await fetchHealthyEndpoints(2);
    expect(result).toHaveLength(2);
    expect(result.every((ep) => typeof ep.endpoint === "string")).toBe(true);
  });

  it("returns 1 endpoint when wanted=1 and all probes succeed", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(BATCH));
    undiciControl.fetchOk = true;
    undiciControl.fetchIp = "1.2.3.4";

    const result = await fetchHealthyEndpoints(1);
    expect(result).toHaveLength(1);
  });

  it("throws when all probes fail (non-ok response)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(BATCH));
    undiciControl.fetchOk = false; // all probes fail

    await expect(fetchHealthyEndpoints(1)).rejects.toThrow(/no healthy endpoint/);
  });

});

// ---------------------------------------------------------------------------
// B5 — credential redaction at log / error boundaries
// ---------------------------------------------------------------------------

describe("redactProxyListSample — no credentials in log sample", () => {
  it("masks user:pass from every authenticated line, keeping host:port:auth", () => {
    const body = [
      "gw.example.com:10000:secretuser:secretpass",
      "gw.example.com:10001:secretuser:secretpass",
    ].join("\n");

    const sample = redactProxyListSample(body);

    expect(sample).not.toContain("secretuser");
    expect(sample).not.toContain("secretpass");
    expect(sample).toContain("gw.example.com:10000:auth");
  });

  it("handles literal \\n separators and caps the number of lines", () => {
    const body =
      "h1:1:u:p\\nh2:2:u:p\\nh3:3:u:p\\nh4:4:u:p\\nh5:5:u:p\\nh6:6:u:p";
    const sample = redactProxyListSample(body, 3);
    // 3 lines max, none carry the password token.
    expect(sample.split(" | ")).toHaveLength(3);
    expect(sample).not.toContain(":u:p");
  });

  it("keeps unauthenticated host:port lines intact (no creds to leak)", () => {
    const sample = redactProxyListSample("1.2.3.4:8080\n5.6.7.8:9090");
    expect(sample).toContain("1.2.3.4:8080");
    expect(sample).toContain("5.6.7.8:9090");
  });
});

describe("fetchHealthyEndpoints — warn log on empty parse never leaks creds", () => {
  beforeEach(() => {
    vi.stubEnv("SMARTPROXY_API_URL", "https://provider.example.com/api");
    loggerSpy.warn.mockClear();
    loggerSpy.info.mockClear();
    undiciControl.healthyHosts = null;
    undiciControl.lastProxyUris = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("logs only the redacted sample (host:port:auth), never user:pass", async () => {
    // A body that parses to ZERO endpoints (all lines unparsable as host:port)
    // but still carries credential-looking tokens we must never log verbatim.
    const leaky = "junkline-no-colon\nanother junk line with secretpass here";
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(leaky));

    await expect(fetchEndpoints()).rejects.toThrow(/empty endpoint list/);

    expect(loggerSpy.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(loggerSpy.warn.mock.calls[0]?.[0] ?? {});
    // The raw body must not appear verbatim in the structured log record.
    expect(logged).not.toContain("secretpass");
    // The old code logged `body.slice(0,200)` — assert we are NOT doing that.
    expect(logged).not.toContain("junkline-no-colon");
  });
});

describe("scrubProxyCredential — strips known endpoint creds from messages", () => {
  const EP = "gw.example.com:10000:secretuser:secretpass";

  it("replaces the wire URI form with the safe label", () => {
    const uri = proxyAgentUriForEndpoint(EP); // http://secretuser:secretpass@gw.example.com:10000
    const msg = `connect ECONNREFUSED via ${uri} during request`;
    const scrubbed = scrubProxyCredential(msg, EP);
    expect(scrubbed).not.toContain("secretuser");
    expect(scrubbed).not.toContain("secretpass");
    expect(scrubbed).toContain("gw.example.com:10000:auth");
    // Surrounding context (used by downstream error classification) survives.
    expect(scrubbed).toContain("ECONNREFUSED");
  });

  it("replaces the colon-delimited form too", () => {
    const msg = `bad proxy line ${EP} rejected`;
    const scrubbed = scrubProxyCredential(msg, EP);
    expect(scrubbed).not.toContain("secretuser:secretpass");
    expect(scrubbed).toContain("gw.example.com:10000:auth");
  });

  it("is a no-op for unauthenticated endpoints (nothing secret to scrub)", () => {
    const msg = "timeout on 1.2.3.4:8080";
    expect(scrubProxyCredential(msg, "1.2.3.4:8080")).toBe(msg);
  });

  it("is a no-op when endpoint is null/undefined", () => {
    expect(scrubProxyCredential("some msg", null)).toBe("some msg");
    expect(scrubProxyCredential("some msg", undefined)).toBe("some msg");
  });
});

// ---------------------------------------------------------------------------
// B10 — probe latency budget + concurrency + fail-fast
// ---------------------------------------------------------------------------

describe("fetchHealthyEndpoints — probe budget (B10)", () => {
  // A batch big enough that the old code would probe all 20; the budget must
  // cap how many probes actually run.
  const BIG_BATCH = Array.from({ length: 20 }, (_, i) => `10.0.0.${i}:${8000 + i}`).join(
    "\n",
  );

  beforeEach(() => {
    vi.stubEnv("SMARTPROXY_API_URL", "https://provider.example.com/api");
    vi.stubEnv("PROXY_PROBE_MAX_ATTEMPTS", "5");
    vi.stubEnv("PROXY_PROBE_CONCURRENCY", "3");
    undiciControl.healthyHosts = null;
    undiciControl.lastProxyUris = [];
    undiciControl.abortedCount = 0;
    undiciControl.probeDelayMs = 0;
    undiciControl.delayForHost = {};
    undiciControl.fetchOk = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("probes at most PROXY_PROBE_MAX_ATTEMPTS endpoints before failing fast", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(BIG_BATCH));
    // No host is healthy → exhaust the budget, then fail fast.
    undiciControl.healthyHosts = [];

    await expect(fetchHealthyEndpoints(1)).rejects.toThrow(
      /no healthy endpoint after 5 probe\(s\) \(budget 5\)/,
    );
    // Each unhealthy probe opens exactly one ProxyAgent (first undici call
    // returns non-ok and short-circuits the second). So uri count == probes.
    expect(undiciControl.lastProxyUris.length).toBe(5);
  });

  it("stops early once a healthy endpoint is found in the first wave", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(BIG_BATCH));
    // Only the very first endpoint is healthy.
    undiciControl.healthyHosts = ["10.0.0.0:8000"];

    const result = await fetchHealthyEndpoints(1);
    expect(result).toHaveLength(1);
    expect(result[0].endpoint).toBe("10.0.0.0:8000");
    // First wave is 3 concurrent probes; we never start a second wave.
    expect(undiciControl.lastProxyUris.length).toBeLessThanOrEqual(3);
  });

  it("honours a custom (smaller) attempt budget from the env", async () => {
    vi.stubEnv("PROXY_PROBE_MAX_ATTEMPTS", "2");
    vi.stubEnv("PROXY_PROBE_CONCURRENCY", "2");
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(BIG_BATCH));
    undiciControl.healthyHosts = [];

    await expect(fetchHealthyEndpoints(1)).rejects.toThrow(
      /no healthy endpoint after 2 probe\(s\) \(budget 2\)/,
    );
    expect(undiciControl.lastProxyUris.length).toBe(2);
  });

  it("runs caller-owned browser probes sequentially", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(BIG_BATCH));
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const probe = vi.fn(async (endpoint: string) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return calls === 3 ? endpoint : null;
    });

    const result = await fetchHealthyEndpoints(1, { probe });

    expect(result).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });

  it("honours a smaller per-flow attempt cap for browser preflight", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(BIG_BATCH));
    const probe = vi.fn(async () => null);

    await expect(
      fetchHealthyEndpoints(1, { probe, maxAttempts: 2 }),
    ).rejects.toThrow(/after 2 probe\(s\) \(budget 2\)/);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("passes REAL credentials to undici (redaction must not corrupt the dispatcher uri)", async () => {
    vi.stubEnv("STATIC_PROXY_HOST", "gw.example.com");
    vi.stubEnv("STATIC_PROXY_PORT_START", "10000");
    vi.stubEnv("STATIC_PROXY_PORT_END", "10010");
    vi.stubEnv("STATIC_PROXY_USERNAME", "realuser");
    vi.stubEnv("STATIC_PROXY_PASSWORD", "realpass");
    undiciControl.healthyHosts = null;
    undiciControl.fetchOk = true;

    const result = await fetchHealthyEndpoints(1);
    expect(result).toHaveLength(1);
    // The dispatcher must receive the *unredacted* credentials — consumers
    // (undici/Playwright) need them to actually authenticate.
    const uri = undiciControl.lastProxyUris[0] ?? "";
    expect(uri).toContain("realuser");
    expect(uri).toContain("realpass");
  });

  it("races the wave: first healthy wins and aborts the still-stalling siblings", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(global, "fetch").mockResolvedValue(makeFetchResponse(BIG_BATCH));
      // All hosts are "healthy", but the first endpoint in the wave returns in
      // 100ms while the other two stall 5s. With wanted=1 and a concurrency-3
      // wave the fast one wins; the two slow probes are aborted mid-stall via
      // the shared controller before paying their full timeout.
      undiciControl.healthyHosts = null;
      undiciControl.fetchOk = true;
      undiciControl.delayForHost = {
        "10.0.0.0:8000": 100, // fast winner
        "10.0.0.1:8001": 5_000, // slow loser
        "10.0.0.2:8002": 5_000, // slow loser
      };

      const promise = fetchHealthyEndpoints(1);
      // Advance past the winner's two-fetch latency (2×100ms) but well short
      // of the slow siblings' 5s — they must be aborted, not run to timeout.
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;

      expect(result).toHaveLength(1);
      expect(result[0].endpoint).toBe("10.0.0.0:8000");
      // First wave launched 3 probes; the two slow ones were aborted.
      expect(undiciControl.lastProxyUris.length).toBe(3);
      expect(undiciControl.abortedCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
