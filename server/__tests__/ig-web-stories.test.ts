import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationIdentity } from "../services/automation-client.js";

const { http, browser } = vi.hoisted(() => ({ http: vi.fn(), browser: vi.fn() }));
vi.mock("../services/bandwidth-meter.js", () => ({ recordBytes: vi.fn() }));
vi.mock("../services/automation-client.js", () => ({
  createAutomationClient: () => ({ requestInstagramHttp: http, requestInstagramBrowser: browser }),
}));
vi.mock("undici", () => ({
  Agent: class { constructor() { throw new Error("Unexpected direct transport"); } },
  ProxyAgent: class { constructor() { throw new Error("Unexpected direct transport"); } },
  fetch: () => { throw new Error("Unexpected network request"); },
}));

import { createHttpBotClientWithFingerprint, IGAuthExpiredError, IGHttpError, IGRateLimitedError } from "../ig-http-client.js";

const session = JSON.stringify({ cookies: [
  { name: "sessionid", value: "fixture-session", domain: ".instagram.com", expires: 4102444800 },
  { name: "csrftoken", value: "fixture-csrf", domain: ".instagram.com", expires: 4102444800 },
] });
let number = 0;
async function readStories(lane: "http" | "browser", response: object) {
  const botId = `story-fixture-${++number}`;
  const identity: AutomationIdentity = {
    identity_version: 1, client: "instagram-firefox-web", bot_id: botId,
    browser_seed: 1, browser_family: "firefox", browser_version: "fixture", platform: "Windows",
    user_agent: "fixture Firefox", http_impersonate: "fixture", ja3: "fixture", h2_fingerprint: "fixture",
    locale: "en-US", timezone: "UTC",
  };
  (lane === "http" ? http : browser).mockResolvedValue({
    status: 200, headers: { "content-type": "application/json" }, ...response,
  });
  const client = createHttpBotClientWithFingerprint(session, null, "fixture_bot", "127.0.0.1:19090", botId, identity, lane);
  try { return await client.fetchStoriesTray("123"); }
  finally { await client.close(); }
}

describe("web-session stories", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each(["http", "browser"] as const)("uses the web reel route for the %s lane", async lane => {
    const response = await readStories(lane, { body: JSON.stringify({ status: "ok", reels_media: [
      { id: "456", items: [{ id: "another-target-story" }] },
      { id: "123", items: [{ id: "own-story", media_type: 1,
        image_versions2: { candidates: [{ url: "https://example.test/story.jpg" }] } }] },
    ] }) });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({ id: "own-story", imageUrl: "https://example.test/story.jpg" });
    const request = (lane === "http" ? http : browser).mock.calls[0][0];
    expect(request.request.path).toBe("https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=123");
    expect(request.identity.user_agent).toBe("fixture Firefox");
    expect((lane === "http" ? browser : http)).not.toHaveBeenCalled();
  });

  it("returns no stories for an explicitly empty successful tray", async () => {
    expect(await readStories("http", { body: JSON.stringify({ status: "ok", reels_media: [] }) }))
      .toEqual({ items: [] });
  });

  it.each([
    [200, "Temporary error", IGHttpError],
    [200, "login_required", IGAuthExpiredError],
    [200, "checkpoint_required", IGHttpError],
    [400, "useragent mismatch", IGHttpError],
    [403, "login_required", IGAuthExpiredError],
    [429, "Please wait", IGRateLimitedError],
  ] as const)("preserves upstream %s failures instead of claiming an empty story tray", async (status, message, errorType) => {
    await expect(readStories("http", { status, body: JSON.stringify({ status: "fail", message }) }))
      .rejects.toBeInstanceOf(errorType);
    expect(http).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });
});
