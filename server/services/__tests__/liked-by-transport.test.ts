// Exercise real transport/follow functions with closed provider and DB seams.
// No Instagram reads, follows, browser launches, logins or live writes occur.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../liked-by-harvester.ts", import.meta.url), "utf8");
function extract(start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Missing harvester function: ${start}`);
  return source.slice(from, to).replaceAll("export function", "function");
}
const code = transformSync([
  extract("export function isRotateSignal(", "export interface HarvestMatch"),
  extract("async function closeQuietly(", "// ── Bot preparation"),
  extract("async function fetchFeedViaBrowser(", "// ── Matching + persistence"),
  extract("async function publicFollowTargetStillEligible(", "/**\n * Ensure a watcher"),
].join("\n"), { loader: "ts", format: "cjs" }).code;

class IGRateLimitedError extends Error { name = "IGRateLimitedError"; }
class IGAuthExpiredError extends Error { name = "IGAuthExpiredError"; }
class IGCircuitOpenError extends Error { name = "IGCircuitOpenError"; }

function fixture() {
  const target = { igUserId: "123", igUsername: "target" };
  const row = { id: "original-public", userId: "owner", ...target, isPrivate: false, isActive: true, paid: true };
  const ctx = {
    botId: "watcher", igUsername: "watcher-name", sessionData: "saved-fixture-state",
    proxyEndpoint: "fixed.example:9000", fingerprint: { userAgent: "fixture" },
    automationIdentity: { bot_id: "watcher", browser_family: "firefox" }, transport: "web",
  };
  const http = { fetchRaw: vi.fn(async () => ({ items: [] })), close: vi.fn(async () => {}) };
  const browser = { fetchRaw: vi.fn(async () => ({ feed_items: [] })), close: vi.fn(async () => {}) };
  const mobile = { fetchRaw: vi.fn(async () => ({ items: [] })), close: vi.fn(async () => {}) };
  let shuttingDown = false;
  const api: any = {
    Error, Set, Number, Boolean, String,
    IGRateLimitedError, IGAuthExpiredError, IGCircuitOpenError,
    isCheckpointError: (error: { igErrorCode?: string }) => ["checkpoint_required", "challenge_required"].includes(error?.igErrorCode ?? ""),
    logger: { info: vi.fn(), warn: vi.fn() },
    trackedAccounts: Object.fromEntries(Object.keys(row).map(key => [key, key])),
    and: (...predicates: Array<(candidate: typeof row) => boolean>) => (candidate: typeof row) => predicates.every(p => p(candidate)),
    eq: (column: keyof typeof row, value: unknown) => (candidate: typeof row) => candidate[column] === value,
    customerAccessSql: () => (candidate: typeof row) => candidate.paid,
    db: { select: () => ({ from: () => ({ where: (predicate: (candidate: typeof row) => boolean) => ({ limit: async () => predicate(row) ? [row] : [] }) }) }) },
    isShuttingDown: () => shuttingDown,
    proxyAgentUriForEndpoint: (endpoint: string) => `http://${endpoint}`,
    sendBrowserFollow: vi.fn(async () => ({ following: true, outgoingRequest: false })),
    playwrightSendFollowByUsername: vi.fn(async () => ({ following: true, requested: false })),
    buildHttpClient: vi.fn(() => http),
    createBrowserReadClient: vi.fn(async () => browser),
    parseMobileEnvelope: vi.fn(() => ({ authorization: "fixture" })),
    createMobileReadClient: vi.fn(() => mobile),
    feedTransportKey: vi.fn(() => "session-and-endpoint-key"),
    shouldSkipWalledHttp: vi.fn(() => false),
    markHttpFeedWalled: vi.fn(),
  };
  vm.createContext(api); vm.runInContext(code, api);
  return { api, row, ctx, target, http, browser, mobile, setShutdown: (value: boolean) => { shuttingDown = value; } };
}

describe("watcher follow uses the assigned browser identity", () => {
  it("passes the canonical saved runtime and numeric target to the migrated helper", async () => {
    const f = fixture();
    expect(await f.api.sendWatcherFollow(f.ctx, f.target)).toBe("following");
    expect(f.api.sendBrowserFollow).toHaveBeenCalledExactlyOnceWith(
      { ...f.ctx, proxyUrl: "http://fixed.example:9000" }, "target", "123",
    );
    expect(f.api.playwrightSendFollowByUsername).not.toHaveBeenCalled();
  });

  it("records a verified outgoing request without claiming acceptance", async () => {
    const f = fixture(); f.api.sendBrowserFollow.mockResolvedValue({ following: false, outgoingRequest: true });
    expect(await f.api.sendWatcherFollow(f.ctx, f.target)).toBe("requested");
  });

  it.each([null, undefined, {}, { following: false, outgoingRequest: false }, { following: "true", outgoingRequest: false }, { following: true }])(
    "rejects an unconfirmed or malformed result without legacy fallback: %j", async result => {
      const f = fixture(); f.api.sendBrowserFollow.mockResolvedValue(result);
      await expect(f.api.sendWatcherFollow(f.ctx, f.target)).rejects.toThrow("unconfirmed");
      expect(f.api.playwrightSendFollowByUsername).not.toHaveBeenCalled();
      expect(f.api.logger.info).not.toHaveBeenCalled();
    },
  );

  it("propagates browser failure without sending a second follow", async () => {
    const f = fixture(), error = new Error("Browser follow was not sent (follow_control_unavailable)");
    f.api.sendBrowserFollow.mockRejectedValue(error);
    await expect(f.api.sendWatcherFollow(f.ctx, f.target)).rejects.toBe(error);
    expect(f.api.playwrightSendFollowByUsername).not.toHaveBeenCalled();
  });

  it.each(["paid", "isActive", "isPrivate", "igUserId", "igUsername"])(
    "rechecks current %s at the write boundary", async field => {
      const f = fixture();
      if (field === "isPrivate") f.row.isPrivate = true;
      else if (field === "paid" || field === "isActive") f.row[field] = false;
      else f.row[field as "igUserId" | "igUsername"] = "changed";
      await expect(f.api.sendWatcherFollow(f.ctx, f.target)).rejects.toThrow("no longer eligible");
      expect(f.api.sendBrowserFollow).not.toHaveBeenCalled();
      expect(f.api.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    },
  );

  it("does not start a browser action during shutdown", async () => {
    const f = fixture(); f.setShutdown(true);
    await expect(f.api.sendWatcherFollow(f.ctx, f.target)).rejects.toThrow("no longer eligible");
    expect(f.api.sendBrowserFollow).not.toHaveBeenCalled();
  });

  it("passes a live eligibility callback into the supported legacy path", async () => {
    const f = fixture();
    f.api.playwrightSendFollowByUsername.mockImplementation(async ({ canFollow }: { canFollow: () => Promise<boolean> }) => {
      f.row.paid = false;
      expect(await canFollow()).toBe(false);
      return null;
    });
    await expect(f.api.sendWatcherFollow({ ...f.ctx, automationIdentity: null }, f.target)).rejects.toThrow("did not land");
    expect(f.api.sendBrowserFollow).not.toHaveBeenCalled();
  });
});

describe("liked-by feed transport errors remain failures", () => {
  const endpoint = { path: "/api/v1/feed/timeline/", method: "POST", body: "reason=cold_start_fetch" };

  it("keeps HTTP success without opening a browser", async () => {
    const f = fixture();
    expect(await f.api.fetchFeedRaw(f.ctx, endpoint)).toEqual({ items: [] });
    expect(f.http.close).toHaveBeenCalledOnce();
    expect(f.api.createBrowserReadClient).not.toHaveBeenCalled();
  });

  it("falls back with the same identity/session/proxy after a non-JSON response", async () => {
    const f = fixture(); f.http.fetchRaw.mockRejectedValue(new Error("response not JSON"));
    expect(await f.api.fetchFeedRaw(f.ctx, endpoint)).toEqual({ feed_items: [] });
    expect(f.api.createBrowserReadClient).toHaveBeenCalledExactlyOnceWith({
      sessionData: f.ctx.sessionData, fingerprint: f.ctx.fingerprint, botUsername: f.ctx.igUsername,
      proxyEndpoint: f.ctx.proxyEndpoint, botId: f.ctx.botId, fallbackToHttp: false, automationIdentity: f.ctx.automationIdentity,
    });
    expect(f.api.markHttpFeedWalled).toHaveBeenCalledOnce();
    expect(f.http.close).toHaveBeenCalledOnce(); expect(f.browser.close).toHaveBeenCalledOnce();
  });

  it.each([IGRateLimitedError, IGAuthExpiredError, IGCircuitOpenError])("does not browser-escalate %s", async ErrorType => {
    const f = fixture(), error = new ErrorType(); f.http.fetchRaw.mockRejectedValue(error);
    await expect(f.api.fetchFeedRaw(f.ctx, endpoint)).rejects.toBe(error);
    expect(f.api.createBrowserReadClient).not.toHaveBeenCalled(); expect(f.http.close).toHaveBeenCalledOnce();
  });

  it("never repeats a verified checkpoint through the browser transport", async () => {
    const f = fixture(), error = Object.assign(new Error("checkpoint_required"), { igErrorCode: "checkpoint_required" });
    f.http.fetchRaw.mockRejectedValue(error);
    await expect(f.api.fetchFeedRaw(f.ctx, endpoint)).rejects.toBe(error);
    expect(f.api.createBrowserReadClient).not.toHaveBeenCalled();
    expect(f.api.markHttpFeedWalled).not.toHaveBeenCalled();
  });

  it("retains only allowlisted response diagnostics across safe logging", () => {
    const f = fixture();
    expect(f.api.harvestErrorDetails({ name: "IGAuthExpiredError", status: 200,
      responseDiagnostics: { responseUrlClass: "login", responseRedirected: true, contentType: "html",
        titleClass: "instagram", responseBytes: 629705, finalUrl: "secret", body: "private" } }))
      .toEqual({ errorKind: "IGAuthExpiredError", errorStatus: 200, responseUrlClass: "login",
        responseRedirected: true, contentType: "html", titleClass: "instagram", responseBytes: 629705 });
    expect(f.api.harvestErrorDetails({ responseDiagnostics: { responseUrlClass: "private", contentType: "secret",
      titleClass: "secret", responseBytes: -1, responseRedirected: "secret" } })).toEqual({ errorKind: "unknown" });
  });

  it("preserves the browser read error and emits safe useful classification", async () => {
    const f = fixture(), error = Object.assign(new Error("private upstream body"), { name: "IGHttpError", status: 400, igErrorCode: "challenge_required" });
    f.http.fetchRaw.mockRejectedValue(new Error("response not JSON")); f.browser.fetchRaw.mockRejectedValue(error);
    await expect(f.api.fetchFeedRaw(f.ctx, endpoint)).rejects.toBe(error);
    expect(f.api.logger.warn).toHaveBeenCalledWith({ botId: "watcher", stage: "browser-read", errorKind: "IGHttpError", errorStatus: 400, igErrorCode: "challenge_required" }, "[liked-by] browser feed fetch failed");
    expect(f.browser.close).toHaveBeenCalledOnce(); expect(f.http.close).toHaveBeenCalledOnce();
  });

  it("surfaces the HTTP error if browser initialization fails", async () => {
    const f = fixture(), error = new Error("HTTP feed unavailable");
    f.http.fetchRaw.mockRejectedValue(error); f.api.createBrowserReadClient.mockRejectedValue(Object.assign(new Error("unavailable"), { name: "AutomationServiceError", status: 503 }));
    await expect(f.api.fetchFeedRaw(f.ctx, endpoint)).rejects.toBe(error);
    expect(f.api.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ stage: "browser-init", errorKind: "AutomationServiceError", errorStatus: 503 }), expect.any(String));
  });

  it("skips a known HTTP wall while keeping the browser failure visible", async () => {
    const f = fixture(), error = new Error("browser unavailable");
    f.api.shouldSkipWalledHttp.mockReturnValue(true); f.browser.fetchRaw.mockRejectedValue(error);
    await expect(f.api.fetchFeedRaw(f.ctx, endpoint)).rejects.toBe(error);
    expect(f.http.fetchRaw).not.toHaveBeenCalled(); expect(f.http.close).toHaveBeenCalledOnce();
  });

  it("keeps mobile reads on their saved mobile transport", async () => {
    const f = fixture();
    expect(await f.api.fetchFeedRaw({ ...f.ctx, transport: "mobile", automationIdentity: null }, endpoint)).toEqual({ items: [] });
    expect(f.api.buildHttpClient).not.toHaveBeenCalled(); expect(f.api.createBrowserReadClient).not.toHaveBeenCalled();
    expect(f.mobile.close).toHaveBeenCalledOnce();
  });

  it("never includes raw messages, bodies, arbitrary codes or identifiers in diagnostic fields", () => {
    const f = fixture();
    const result = f.api.harvestErrorDetails({ name: "secret-name", status: 999, code: "private-code", igErrorCode: "private-code", body: "sessionid=private", message: "private-user (follow_control_unavailable) https://proxy:secret@example.invalid" });
    expect(result).toEqual({ errorKind: "unknown", errorReason: "follow_control_unavailable" });
  });

  it("retains the safe automation cause hidden inside a network wrapper", () => {
    const f = fixture();
    const result = f.api.harvestErrorDetails({ name: "IGHttpError", status: 0,
      cause: { name: "AutomationServiceError", status: 503, message: "private session data" } });
    expect(result).toEqual({ errorKind: "IGHttpError", errorStatus: 0,
      errorCauseKind: "AutomationServiceError", errorCauseStatus: 503 });
  });
});
