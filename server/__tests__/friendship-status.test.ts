import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationIdentity } from "../services/automation-client.js";

const { requestInstagramHttp } = vi.hoisted(() => ({ requestInstagramHttp: vi.fn() }));

vi.mock("../services/bandwidth-meter.js", () => ({ recordBytes: vi.fn() }));
vi.mock("../services/automation-client.js", () => ({
  createAutomationClient: () => ({ requestInstagramHttp }),
}));
vi.mock("undici", () => ({
  Agent: class { constructor() { throw new Error("Unexpected direct transport"); } },
  ProxyAgent: class { constructor() { throw new Error("Unexpected direct transport"); } },
  fetch: () => { throw new Error("Unexpected network request"); },
}));

import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";
import { IGSchemaError } from "../domain/ig-client-port.js";

const session = JSON.stringify({ cookies: [
  { name: "sessionid", value: "fixture-session", domain: ".instagram.com", expires: 4102444800 },
  { name: "csrftoken", value: "fixture-csrf", domain: ".instagram.com", expires: 4102444800 },
] });
let clientNumber = 0;

async function fetchStatus(body: unknown) {
  const botId = `friendship-fixture-${++clientNumber}`;
  const identity: AutomationIdentity = {
    identity_version: 1, client: "instagram-firefox-web", bot_id: botId,
    browser_seed: 1, browser_family: "firefox", browser_version: "fixture",
    platform: "Windows", user_agent: "fixture Firefox", http_impersonate: "fixture",
    ja3: "fixture", h2_fingerprint: "fixture", locale: "en-US", timezone: "UTC",
  };
  requestInstagramHttp.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify(body) });
  const client = createHttpBotClientWithFingerprint(
    session, null, "fixture_bot", "127.0.0.1:19090", botId, identity,
  );
  try {
    return await client.fetchFriendshipStatus!("123456789");
  } finally {
    await client.close();
  }
}

describe("friendship status through the HTTP port adapter", () => {
  beforeEach(() => { requestInstagramHttp.mockReset(); });

  it.each([
    { following: false, outgoing_request: false },
    { following: false, outgoing_request: true },
    { following: true, outgoing_request: false },
  ])("preserves explicit edge flags %j", async flags => {
    const result = await fetchStatus({ ...flags, is_private: true, extra_upstream_field: "ignored" });
    expect(result).toEqual({
      following: flags.following, outgoingRequest: flags.outgoing_request,
      incomingRequest: false, followedBy: false, isPrivate: true,
    });
    expect(requestInstagramHttp).toHaveBeenCalledTimes(1);
    expect(requestInstagramHttp).toHaveBeenCalledWith(expect.objectContaining({
      proxy: { server: "http://127.0.0.1:19090" },
      request: expect.objectContaining({ method: "GET", path: "https://www.instagram.com/api/v1/friendships/show/123456789/" }),
    }));
  });

  it("keeps a target private when privacy is omitted", async () => {
    expect(await fetchStatus({ following: false, outgoing_request: false })).toMatchObject({ isPrivate: true });
  });

  it("preserves explicitly public targets and the other relationship flags", async () => {
    expect(await fetchStatus({ following: false, outgoing_request: false, is_private: false, incoming_request: true, followed_by: true }))
      .toEqual({ following: false, outgoingRequest: false, isPrivate: false, incomingRequest: true, followedBy: true });
  });

  it.each([
    null,
    [],
    {},
    { following: false },
    { outgoing_request: false },
    { following: "false", outgoing_request: false },
    { following: false, outgoing_request: 0 },
    { following: null, outgoing_request: false },
    { friendship_status: { following: false, outgoing_request: false } },
    { following: false, outgoing_request: false, is_private: null },
  ])("rejects malformed or incomplete state %j", async body => {
    await expect(fetchStatus(body)).rejects.toBeInstanceOf(IGSchemaError);
    expect(requestInstagramHttp).toHaveBeenCalledTimes(1);
    expect(requestInstagramHttp.mock.calls[0][0].request.method).toBe("GET");
  });

  it("keeps upstream response contents out of validation errors", async () => {
    const error = await fetchStatus({ following: "sensitive-fixture-value", outgoing_request: false }).catch(error => error);
    expect(error).toBeInstanceOf(IGSchemaError);
    expect(error.message).toBe("[ig-schema] friendships/show response has invalid relationship fields");
    expect(error.message).not.toContain("sensitive-fixture-value");
  });
});
