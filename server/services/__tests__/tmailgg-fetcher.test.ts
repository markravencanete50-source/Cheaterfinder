// Unit tests for server/services/tmailgg-fetcher.ts
// Network is fully mocked — no real HTTP traffic.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { fetchLatestIgCode, __test__ } from "../tmailgg-fetcher.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const SAMPLE_CSRF = "csrf-token-12345";
const SAMPLE_COOKIE = "tmailgg_session=abc123def; XSRF-TOKEN=xyz";

const LANDING_HTML = `<!DOCTYPE html><html><head>
  <meta name="csrf-token" content="${SAMPLE_CSRF}">
  <title>tmailgg</title>
</head><body><h1>tmailgg</h1></body></html>`;

function makeFetchResponse(
  body: string,
  init: { status?: number; setCookie?: string } = {},
): Response {
  const headers = new Headers();
  if (init.setCookie) headers.set("set-cookie", init.setCookie);
  return new Response(body, {
    status: init.status ?? 200,
    headers,
  });
}

function igMessage(opts: {
  id?: string;
  ageMs: number;
  subject?: string;
  content?: string;
  now?: number;
}): Record<string, unknown> {
  const now = opts.now ?? Date.now();
  return {
    id: opts.id ?? "msg-1",
    receivedAt: new Date(now - opts.ageMs).toISOString(),
    subject: opts.subject ?? "Your Instagram verification code",
    content: opts.content ?? "<p>Your code is <b>481629</b>. Do not share.</p>",
  };
}

// Build a fetch mock that walks a script of responses keyed by URL+method.
function scriptedFetch(
  script: Array<{ urlMatch: RegExp | string; method?: string; respond: () => Response | Promise<Response> }>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; method: string; body?: string }> } {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const cursor = { i: 0 };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });

    // Find next matching script step.
    for (let i = cursor.i; i < script.length; i++) {
      const step = script[i];
      const wantMethod = (step.method ?? "GET").toUpperCase();
      const matches =
        method === wantMethod &&
        (typeof step.urlMatch === "string"
          ? url.includes(step.urlMatch)
          : step.urlMatch.test(url));
      if (matches) {
        cursor.i = i + 1;
        return await step.respond();
      }
    }
    throw new Error(
      `scriptedFetch: no script entry for ${method} ${url} (cursor=${cursor.i})`,
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

// ─── unit tests for the pure helpers ────────────────────────────────────────

describe("tmailgg-fetcher pure helpers", () => {
  it("parseAddress accepts a normal address", () => {
    expect(__test__.parseAddress("lesreh@tmailgg.site")).toEqual({
      local: "lesreh",
      domain: "tmailgg.site",
    });
  });

  it("parseAddress rejects malformed input", () => {
    expect(__test__.parseAddress("")).toBeNull();
    expect(__test__.parseAddress("nope")).toBeNull();
    expect(__test__.parseAddress("@nope")).toBeNull();
    expect(__test__.parseAddress("nope@")).toBeNull();
  });

  it("stripHtml removes tags and collapses whitespace", () => {
    const out = __test__.stripHtml(
      "<div>Your code is <b>123456</b>.<script>x</script></div>",
    );
    expect(out).toContain("Your code is 123456");
    expect(out).not.toContain("<");
    expect(out).not.toContain("script");
  });

  it("receivedAtMs handles ISO strings, ms numbers, and seconds", () => {
    expect(__test__.receivedAtMs({ id: 1, receivedAt: "2026-01-01T00:00:00Z" })).toBe(
      Date.parse("2026-01-01T00:00:00Z"),
    );
    expect(__test__.receivedAtMs({ id: 1, receivedAt: 1_700_000_000_000 })).toBe(
      1_700_000_000_000,
    );
    // seconds (< 1e12) should be promoted to ms
    expect(__test__.receivedAtMs({ id: 1, receivedAt: 1_700_000_000 })).toBe(
      1_700_000_000_000,
    );
  });

  it("looksLikeIgEmail picks up subject hints", () => {
    expect(__test__.looksLikeIgEmail("Your Instagram code", "")).toBe(true);
    expect(__test__.looksLikeIgEmail("Verification code", "")).toBe(true);
    expect(__test__.looksLikeIgEmail("Random promo", "")).toBe(false);
  });

  it("looksLikeIgEmail picks up body hints when subject is silent", () => {
    expect(
      __test__.looksLikeIgEmail("Hi", "From security@mail.instagram.com please use 123456"),
    ).toBe(true);
  });

  it("pickFreshIgCode picks the freshest IG message and ignores stale ones", () => {
    const now = 1_700_000_000_000;
    const messages = [
      // stale (10 min old) — must be ignored even though it's a valid IG msg
      {
        id: "old",
        receivedAt: new Date(now - 600_000).toISOString(),
        subject: "Instagram verification code",
        content: "Code: 999999",
      },
      // fresh + matching
      {
        id: "fresh",
        receivedAt: new Date(now - 30_000).toISOString(),
        subject: "Your Instagram code",
        content: "<p>Use <b>123456</b> to log in.</p>",
      },
      // fresh but not IG-related
      {
        id: "noise",
        receivedAt: new Date(now - 5_000).toISOString(),
        subject: "Welcome to Newsletter",
        content: "Today's deals: 654321 off",
      },
    ];

    const code = __test__.pickFreshIgCode(messages, {
      maxAgeMs: 240_000,
      now: () => now,
    });
    expect(code).toBe("123456");
  });

  it("pickFreshIgCode returns null when nothing fresh + IG-shaped is present", () => {
    const now = 1_700_000_000_000;
    const messages = [
      {
        id: "stale",
        receivedAt: new Date(now - 600_000).toISOString(),
        subject: "Instagram code",
        content: "Code: 111111",
      },
    ];
    const code = __test__.pickFreshIgCode(messages, {
      maxAgeMs: 240_000,
      now: () => now,
    });
    expect(code).toBeNull();
  });
});

// ─── integration-ish tests for fetchLatestIgCode ────────────────────────────

describe("fetchLatestIgCode happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens a session, claims the address, and extracts a code", async () => {
    const now = 1_700_000_000_000;

    const { fetchImpl, calls } = scriptedFetch([
      {
        urlMatch: /\/$/,
        method: "GET",
        respond: () =>
          makeFetchResponse(LANDING_HTML, { setCookie: SAMPLE_COOKIE }),
      },
      {
        urlMatch: "/create",
        method: "POST",
        respond: () => makeFetchResponse("{}"),
      },
      {
        urlMatch: "/messages",
        method: "POST",
        respond: () =>
          makeFetchResponse(
            JSON.stringify({
              mailbox: "lesreh@tmailgg.site",
              messages: [igMessage({ ageMs: 30_000, now })],
            }),
          ),
      },
    ]);

    const code = await fetchLatestIgCode("lesreh@tmailgg.site", {
      fetchImpl,
      now: () => now,
      maxAgeMs: 240_000,
      totalTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });

    expect(code).toBe("481629");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ method: "GET" });
    expect(calls[1]).toMatchObject({ method: "POST" });
    expect(calls[1].url).toContain("/create");
    expect(calls[1].body).toContain("name=lesreh");
    expect(calls[1].body).toContain("domain=tmailgg.site");
    expect(calls[2].url).toContain("/messages");
    expect(calls[2].body).toContain(`_token=${SAMPLE_CSRF}`);
  });
});

// `now` must advance for the deadline check to ever fire. Reuses a real
// monotonic clock in the test so the polling loop terminates predictably.
function makeAdvancingClock(start: number, stepMs: number): () => number {
  let t = start;
  return () => {
    const out = t;
    t += stepMs;
    return out;
  };
}

describe("fetchLatestIgCode freshness gate", () => {
  it("ignores messages older than maxAgeMs", async () => {
    const baseNow = 1_700_000_000_000;
    // Advance 50ms per call — totalTimeoutMs=200 means ~4 polls then exit.
    const now = makeAdvancingClock(baseNow, 50);
    // Snapshot for building stale messages relative to start of the run
    const messageNow = baseNow;

    const { fetchImpl } = scriptedFetch([
      {
        urlMatch: /\/$/,
        method: "GET",
        respond: () =>
          makeFetchResponse(LANDING_HTML, { setCookie: SAMPLE_COOKIE }),
      },
      { urlMatch: "/create", method: "POST", respond: () => makeFetchResponse("{}") },
      // Every poll returns the same stale message
      ...Array.from({ length: 50 }, () => ({
        urlMatch: "/messages",
        method: "POST",
        respond: () =>
          makeFetchResponse(
            JSON.stringify({
              mailbox: "lesreh@tmailgg.site",
              messages: [igMessage({ ageMs: 600_000, now: messageNow })], // 10 min old
            }),
          ),
      })),
    ]);

    const code = await fetchLatestIgCode("lesreh@tmailgg.site", {
      fetchImpl,
      now,
      maxAgeMs: 240_000,
      totalTimeoutMs: 200,
      pollIntervalMs: 1,
    });

    expect(code).toBeNull();
  });
});

describe("fetchLatestIgCode polling", () => {
  it("retries when the first poll has no IG message and then finds one", async () => {
    const now = 1_700_000_000_000;

    const { fetchImpl, calls } = scriptedFetch([
      // open session
      {
        urlMatch: /\/$/,
        method: "GET",
        respond: () =>
          makeFetchResponse(LANDING_HTML, { setCookie: SAMPLE_COOKIE }),
      },
      // claim
      { urlMatch: "/create", method: "POST", respond: () => makeFetchResponse("{}") },
      // first /messages — empty inbox
      {
        urlMatch: "/messages",
        method: "POST",
        respond: () =>
          makeFetchResponse(JSON.stringify({ mailbox: "lesreh@tmailgg.site", messages: [] })),
      },
      // second /messages — code arrived
      {
        urlMatch: "/messages",
        method: "POST",
        respond: () =>
          makeFetchResponse(
            JSON.stringify({
              mailbox: "lesreh@tmailgg.site",
              messages: [igMessage({ ageMs: 5_000, now, content: "Code: 778899" })],
            }),
          ),
      },
    ]);

    const code = await fetchLatestIgCode("lesreh@tmailgg.site", {
      fetchImpl,
      now: () => now,
      maxAgeMs: 240_000,
      totalTimeoutMs: 200,
      pollIntervalMs: 5, // tiny poll for fast test
    });

    expect(code).toBe("778899");
    // session GET + /create happen once; /messages twice
    const messagesCalls = calls.filter((c) => c.url.includes("/messages"));
    expect(messagesCalls.length).toBe(2);
  });

  it("returns null when no IG message ever arrives within the budget", async () => {
    const baseNow = 1_700_000_000_000;
    const now = makeAdvancingClock(baseNow, 50);

    const { fetchImpl } = scriptedFetch([
      { urlMatch: /\/$/, method: "GET", respond: () => makeFetchResponse(LANDING_HTML, { setCookie: SAMPLE_COOKIE }) },
      { urlMatch: "/create", method: "POST", respond: () => makeFetchResponse("{}") },
      ...Array.from({ length: 50 }, () => ({
        urlMatch: "/messages",
        method: "POST",
        respond: () =>
          makeFetchResponse(JSON.stringify({ mailbox: "lesreh@tmailgg.site", messages: [] })),
      })),
    ]);

    const code = await fetchLatestIgCode("lesreh@tmailgg.site", {
      fetchImpl,
      now,
      maxAgeMs: 240_000,
      totalTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    expect(code).toBeNull();
  });
});

describe("fetchLatestIgCode resilience", () => {
  it("returns null on invalid email address", async () => {
    const code = await fetchLatestIgCode("not-an-email", {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      totalTimeoutMs: 10,
    });
    expect(code).toBeNull();
  });

  it("retries on a transient 522 from Cloudflare and recovers", async () => {
    const now = 1_700_000_000_000;

    const { fetchImpl } = scriptedFetch([
      // first attempt — landing fails
      {
        urlMatch: /\/$/,
        method: "GET",
        respond: () => makeFetchResponse("upstream", { status: 522 }),
      },
      // retry attempt — landing succeeds
      {
        urlMatch: /\/$/,
        method: "GET",
        respond: () =>
          makeFetchResponse(LANDING_HTML, { setCookie: SAMPLE_COOKIE }),
      },
      { urlMatch: "/create", method: "POST", respond: () => makeFetchResponse("{}") },
      {
        urlMatch: "/messages",
        method: "POST",
        respond: () =>
          makeFetchResponse(
            JSON.stringify({
              mailbox: "lesreh@tmailgg.site",
              messages: [igMessage({ ageMs: 10_000, now, content: "Code: 246810" })],
            }),
          ),
      },
    ]);

    const code = await fetchLatestIgCode("lesreh@tmailgg.site", {
      fetchImpl,
      now: () => now,
      maxAgeMs: 240_000,
      totalTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    expect(code).toBe("246810");
  });
});
