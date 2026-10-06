import { describe, expect, it, vi } from "vitest";

import {
  AutomationServiceError,
  createAutomationClient,
  type AutomationInstagramFollowRequest,
  type AutomationInstagramFollowResponse,
} from "./automation-client.js";

function followInput(): AutomationInstagramFollowRequest {
  return {
    identity: {
      identity_version: 1,
      client: "instagram-firefox-web",
      bot_id: "bot-1",
      browser_seed: 1,
      browser_family: "firefox",
      browser_version: "151.0",
      platform: "Windows",
      user_agent: "Mozilla/5.0",
      http_impersonate: "firefox151",
      ja3: "ja3",
      h2_fingerprint: "h2",
      locale: "en-US",
      timezone: "America/New_York",
    },
    storage_state: { cookies: [{ name: "sessionid", value: "test-session" }] },
    proxy: { server: "http://proxy.example:823", username: "u", password: "p" },
    target_username: "target.account",
    target_user_id: "1234567890123456789",
    deadline_ms: 12_000,
    operation_id: "follow-operation-1",
  };
}

describe("createAutomationClient", () => {
  it("uses Undici-compatible fetch semantics and sends the internal token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          loopback_only: true,
          runtime: {
            browser: "invisible_playwright",
            browser_available: true,
            browser_engine_available: true,
            http: "pyhttpz",
            http_available: true,
          },
        }),
        { status: 200 },
      ),
    );
    const client = createAutomationClient({ token: "internal-test-token", fetchImpl });

    await expect(client.health()).resolves.toMatchObject({ status: "ok" });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8787/v1/health"),
      expect.objectContaining({
        headers: { "X-Automation-Token": "internal-test-token" },
      }),
    );
  });

  it("refuses non-loopback automation URLs", () => {
    expect(() => createAutomationClient({ baseUrl: "http://10.0.0.12:8787", token: "x" }))
      .toThrow(AutomationServiceError);
  });

  it("fails closed when no internal token is configured", async () => {
    const client = createAutomationClient({ token: "" });
    await expect(client.health()).rejects.toMatchObject({
      name: "AutomationServiceError",
      status: 0,
    });
  });

  it("posts the exact browser follow input to the authenticated follow endpoint", async () => {
    const response: AutomationInstagramFollowResponse = {
      status: "accepted",
      following: true,
      outgoing_request: false,
      confirmed: true,
      clicked: true,
      reason: null,
      storage_state: { cookies: [{ name: "sessionid", value: "updated-session" }] },
      wire_bytes_in: 1234,
      wire_bytes_out: 456,
      operation_id: "follow-operation-1",
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );
    const client = createAutomationClient({ token: "internal-test-token", fetchImpl });
    const input = followInput();

    await expect(client.followInstagramBrowser(input)).resolves.toEqual(response);

    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      new URL("http://127.0.0.1:8787/v1/instagram/follow"),
      {
        method: "POST",
        headers: {
          "X-Automation-Token": "internal-test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("preserves an unknown follow outcome after a click without retrying", async () => {
    const response: AutomationInstagramFollowResponse = {
      status: "unknown",
      following: false,
      outgoing_request: false,
      confirmed: false,
      clicked: true,
      reason: "confirmation_timeout",
      storage_state: null,
      wire_bytes_in: 42,
      wire_bytes_out: 17,
      operation_id: "follow-operation-1",
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );
    const client = createAutomationClient({ token: "internal-test-token", fetchImpl });

    await expect(client.followInstagramBrowser(followInput())).resolves.toEqual(response);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors the configured follow timeout and does not retry an aborted request", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchImpl = vi.fn().mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    );
    const client = createAutomationClient({
      token: "internal-test-token",
      timeoutMs: 3_456,
      fetchImpl,
    });

    try {
      const request = client.followInstagramBrowser(followInput());
      const rejection = expect(request).rejects.toMatchObject({
        name: "AutomationServiceError",
        status: 0,
        message: "automation service request failed: follow deadline reached",
      });
      controller.abort(new DOMException("follow deadline reached", "TimeoutError"));

      await rejection;
      expect(timeout).toHaveBeenCalledExactlyOnceWith(3_456);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("keeps browser login and code completion on the local authenticated boundary", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: "authenticated",
            message: null,
            login_id: null,
            code_kind: null,
            storage_state: { cookies: [] },
          }),
          { status: 200 },
        ),
      ),
    );
    const client = createAutomationClient({ token: "internal-test-token", fetchImpl });
    const identity = {
      identity_version: 1 as const,
      client: "instagram-firefox-web" as const,
      bot_id: "bot-1",
      browser_seed: 1,
      browser_family: "firefox" as const,
      browser_version: "151.0",
      platform: "Windows" as const,
      user_agent: "Mozilla/5.0",
      http_impersonate: "firefox151",
      ja3: "ja3",
      h2_fingerprint: "h2",
      locale: "en-US",
      timezone: "America/New_York",
    };

    await expect(
      client.startInstagramLogin({
        identity,
        credentials: { username: "bot", password: "secret" },
      }),
    ).resolves.toMatchObject({ status: "authenticated" });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8787/v1/instagram/login/start"),
      expect.objectContaining({ method: "POST" }),
    );

    await client.completeInstagramLogin({ login_id: "login-123456789012", code: "123456" });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      new URL("http://127.0.0.1:8787/v1/instagram/login/complete"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("preflights the Instagram login surface without sending credentials", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ready", message: null }), { status: 200 }),
    );
    const client = createAutomationClient({ token: "internal-test-token", fetchImpl });
    const identity = {
      identity_version: 1 as const,
      client: "instagram-firefox-web" as const,
      bot_id: "bot-1",
      browser_seed: 1,
      browser_family: "firefox" as const,
      browser_version: "151.0",
      platform: "Windows" as const,
      user_agent: "Mozilla/5.0",
      http_impersonate: "firefox151",
      ja3: "ja3",
      h2_fingerprint: "h2",
      locale: "en-US",
      timezone: "America/New_York",
    };

    await expect(
      client.probeInstagramLogin({
        identity,
        proxy: { server: "http://proxy.example:823", username: "u", password: "p" },
      }),
    ).resolves.toEqual({ status: "ready", message: null });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toEqual(new URL("http://127.0.0.1:8787/v1/instagram/login/probe"));
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("credentials");
    expect(body).not.toHaveProperty("username");
    expect(body).not.toHaveProperty("password");
  });
});
