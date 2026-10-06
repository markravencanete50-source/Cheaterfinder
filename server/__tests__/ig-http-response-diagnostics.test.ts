import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationIdentity } from "../services/automation-client.js";

const { requestInstagramHttp, requestInstagramBrowser } = vi.hoisted(() => ({
  requestInstagramHttp: vi.fn(), requestInstagramBrowser: vi.fn(),
}));
vi.mock("../services/bandwidth-meter.js", () => ({ recordBytes: vi.fn() }));
vi.mock("../services/automation-client.js", () => ({
  createAutomationClient: () => ({ requestInstagramHttp, requestInstagramBrowser }),
}));
vi.mock("undici", () => ({
  Agent: class { constructor() { throw new Error("Unexpected direct transport"); } },
  ProxyAgent: class { constructor() { throw new Error("Unexpected direct transport"); } },
  fetch: () => { throw new Error("Unexpected network request"); },
}));

import { createHttpBotClientWithFingerprint, IGAuthExpiredError, IGHttpError, IGRateLimitedError } from "../ig-http-client.js";
import { classifyInstagramResponse } from "../services/ig-response-diagnostics.js";

const session = JSON.stringify({ cookies: [
  { name: "sessionid", value: "fixture-session", domain: ".instagram.com", expires: 4102444800 },
  { name: "csrftoken", value: "fixture-csrf", domain: ".instagram.com", expires: 4102444800 },
] });
let number = 0;
async function readFeed(response: Record<string, unknown>, lane: "http" | "browser" = "http") {
  const botId = `response-fixture-${++number}`;
  const identity: AutomationIdentity = {
    identity_version: 1, client: "instagram-firefox-web", bot_id: botId,
    browser_seed: 1, browser_family: "firefox", browser_version: "fixture", platform: "Windows",
    user_agent: "fixture Firefox", http_impersonate: "fixture", ja3: "fixture", h2_fingerprint: "fixture",
    locale: "en-US", timezone: "UTC",
  };
  const mock = lane === "browser" ? requestInstagramBrowser : requestInstagramHttp;
  mock.mockResolvedValue({ status: 200, headers: { "content-type": "text/html; charset=utf-8" },
    body: "<!doctype html><title>Instagram</title>private bootstrap value", ...response });
  const client = createHttpBotClientWithFingerprint(session, null, "fixture_bot", "127.0.0.1:19090", botId, identity, lane);
  try { return await client.fetchRaw!("/api/v1/feed/timeline/", { method: "POST", body: "reason=cold_start_fetch" }); }
  finally { await client.close(); }
}

describe("verified Instagram redirect handling", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each(["http", "browser"] as const)("treats a %s login redirect ending in 200 as rejected auth", async lane => {
    const error = await readFeed({ response_url_class: "login", response_redirected: true }, lane).catch(error => error);
    expect(error).toBeInstanceOf(IGAuthExpiredError);
    expect(error.status).toBe(200);
    expect(error.responseDiagnostics).toMatchObject({ responseUrlClass: "login", responseRedirected: true,
      contentType: "html", titleClass: "instagram" });
    expect(error.body).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("private bootstrap");
    expect(requestInstagramHttp).toHaveBeenCalledTimes(lane === "http" ? 1 : 0);
    expect(requestInstagramBrowser).toHaveBeenCalledTimes(lane === "browser" ? 1 : 0);
  });

  it("does not call a session expired just because generic HTML contains login copy", async () => {
    const error = await readFeed({ body: '<title>Login • Instagram</title><a href="/accounts/login/?next=secret">login</a>' }).catch(error => error);
    expect(error).toBeInstanceOf(IGHttpError);
    expect(error).not.toBeInstanceOf(IGAuthExpiredError);
    expect(error.responseDiagnostics).toMatchObject({ responseUrlClass: "unknown", titleClass: "login" });
    expect(JSON.stringify(error.responseDiagnostics)).not.toContain("secret");
  });

  it.each(["challenge", "suspended"])("keeps a confirmed %s surface distinct from expired auth", async response_url_class => {
    const error = await readFeed({ response_url_class }).catch(error => error);
    expect(error).toBeInstanceOf(IGHttpError);
    expect(error.igErrorCode).toBe("checkpoint_required");
    expect(error).not.toBeInstanceOf(IGAuthExpiredError);
  });

  it("preserves 429 throttling even if the response route is login", async () => {
    const error = await readFeed({ status: 429, response_url_class: "login", headers: { "retry-after": "90" } }).catch(error => error);
    expect(error).toBeInstanceOf(IGRateLimitedError);
    expect(error.retryAfterMs).toBe(90_000);
  });

  it("supports a successful older automation envelope without diagnostics", async () => {
    expect(await readFeed({ body: JSON.stringify({ feed_items: [], status: "ok" }), headers: { "content-type": "application/json" } }))
      .toEqual({ feed_items: [], status: "ok" });
  });

  it("reduces untrusted metadata, title and content-type to constants", () => {
    const result = classifyInstagramResponse("<title>private-user secret</title>", { "Content-Type": "private-value" },
      "https://www.instagram.com/accounts/login/?sessionid=secret", "secret");
    expect(result).toEqual({ responseUrlClass: "unknown", contentType: "other", responseBytes: 34, titleClass: "other" });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|instagram.com/);
  });
});
