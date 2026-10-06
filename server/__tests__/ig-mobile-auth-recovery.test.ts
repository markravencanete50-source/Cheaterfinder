import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectInstagramAuthResponse } from "../services/instagram-auth-diagnostics.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("undici", () => ({ fetch: fetchMock, Agent: class {}, ProxyAgent: class {} }));
vi.mock("../services/proxy-provider.js", () => ({ proxyAgentUriForEndpoint: vi.fn() }));
vi.mock("../services/bandwidth-meter.js", () => ({ recordBytes: vi.fn() }));
vi.mock("../ig-http-client.js", () => ({
  IGAuthExpiredError: class extends Error {
    constructor(message: string, options: object) { super(message); this.name = "IGAuthExpiredError"; Object.assign(this, options); }
  },
  IGRateLimitedError: class extends Error {
    constructor(_retry: number, message: string) { super(message); this.name = "IGRateLimitedError"; }
  },
  IGHttpError: class extends Error {
    constructor(readonly status: number, message: string, options: object) { super(message); this.name = "IGHttpError"; Object.assign(this, options); }
  },
  formatNetworkErrorMessage: () => "network error",
}));
import { createMobileReadClient } from "../ig-mobile-read-client.js";

const read = () => createMobileReadClient({
  session: {
    __marker: "instagram-mobile-bearer", version: 1, dsUserId: "123", sessionid: "123:test",
    mid: "test", bearer: "test-only", wwwClaim: "0", rur: null,
    userAgent: "test-agent", androidId: "android-test", deviceUuid: "test-device", extraUuids: [],
  }, proxyEndpoint: null, botId: "test", botUsername: "test",
}).fetchRaw!("/api/v1/accounts/current_user/?edit=true");

beforeEach(() => fetchMock.mockReset());

describe("mobile session recovery classification", () => {
  it.each([200, 400, 401, 403])("preserves challenge evidence at HTTP %i", async status => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      padding: "x".repeat(600), status: "fail", message: "challenge_required",
      challenge: { native_flow: true, url: "https://i.instagram.com/challenge/PRIVATE_TOKEN/" },
    }), { status }));
    await expect(read()).rejects.toMatchObject({
      name: "IGHttpError", status, igErrorCode: "challenge_required",
      authDiagnostics: { reason: "challenge_required", challengeKind: "native", codeMethod: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([200, 400, 401, 403])("recognizes explicit login_required at HTTP %i", async status => {
    fetchMock.mockResolvedValue(new Response('{"status":"fail","message":"login_required"}', { status }));
    await expect(read()).rejects.toMatchObject({ name: "IGAuthExpiredError", status });
  });

  it.each([401, 403])("does not invent session expiry from HTTP %i alone", async status => {
    fetchMock.mockResolvedValue(new Response('<html>Policy denied; login_required appears in an unrelated script</html>', { status }));
    await expect(read()).rejects.toMatchObject({ name: "IGHttpError", status, authDiagnostics: { reason: "request_rejected" } });
  });

  it("does not accept a failed HTTP 200 envelope as an authenticated result", async () => {
    fetchMock.mockResolvedValue(new Response('{"status":"fail","message":"unknown error"}'));
    await expect(read()).rejects.toMatchObject({ name: "IGHttpError", authDiagnostics: { reason: "response_error" } });
  });

  it("keeps feedback separate from expired credentials", async () => {
    fetchMock.mockResolvedValue(new Response('{"status":"fail","message":"feedback_required"}', { status: 403 }));
    await expect(read()).rejects.toMatchObject({ name: "IGHttpError", igErrorCode: "feedback_required" });
  });

  it("stops on a rate limit even when the body mentions a challenge", async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"challenge_required"}', { status: 429 }));
    await expect(read()).rejects.toMatchObject({ name: "IGRateLimitedError" });
  });

  it("preserves a valid authenticated response", async () => {
    fetchMock.mockResolvedValue(new Response('{"status":"ok","user":{"pk":"123","username":"test"}}'));
    await expect(read()).resolves.toMatchObject({ status: "ok", user: { pk: "123", username: "test" } });
  });
});

describe("safe challenge metadata", () => {
  it.each([
    ["verify_email", "email"], ["verify_sms", "sms"], ["verify_totp", "totp"],
  ])("recognizes an explicit %s code step", (step_name, codeMethod) => {
    expect(inspectInstagramAuthResponse(400, JSON.stringify({ message: "challenge_required", step_name })))
      .toEqual({ reason: "challenge_required", challengeKind: "legacy", codeMethod });
  });

  it("does not mistake a native checkpoint for an available email challenge", () => {
    const result = inspectInstagramAuthResponse(400, JSON.stringify({
      message: "challenge_required", step_name: "verify_email",
      challenge: { native_flow: true, api_path: "/challenge/do-not-report/", challenge_context: "secret-context" },
      email: "private@example.com", phone_number: "+15551234567", sessionid: "secret-session",
    }));
    expect(result).toEqual({ reason: "challenge_required", challengeKind: "native", codeMethod: null });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|do-not-report|15551234567/);
  });

  it("recognizes a manual Bloks redirect without retaining its payload", () => {
    expect(inspectInstagramAuthResponse(400, JSON.stringify({
      message: "challenge_required", bloks_action: "com.bloks.www.ig.challenge.redirect.async",
    }))?.challengeKind).toBe("bloks");
  });

  it("does not classify words in unrelated profile fields as authentication failures", () => {
    expect(inspectInstagramAuthResponse(200, JSON.stringify({ status: "ok", user: { biography: "challenge_required login_required" } }))).toBeNull();
  });
});
