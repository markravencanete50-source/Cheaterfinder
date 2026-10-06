// Execute the production collector entry points with DB, pacing and transport
// boundaries replaced. Nothing in these tests opens a browser or connection.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { BotAccount, TrackedAccount } from "../../shared/schema.js";
import type { BotCollectors } from "../bot-collectors.js";
import type { IGFriendshipStatus } from "../domain/ig-client-port.js";
import type { BotRuntimeContext } from "../services/bot-runtime.js";
import { requireAutomationIdentity } from "../services/automation-identity.js";
import { assertDurableAccountProxyUrl, isKnownEphemeralDataImpulseProxyUrl } from "../services/proxy-durability.js";
import { isIgWebThrottleBody } from "../services/ig-throttle.js";

const source = readFileSync(new URL("../bot-collectors.ts", import.meta.url), "utf8");

function extract(start: string, end?: string, sourceText = source): string {
  const startIndex = sourceText.indexOf(start);
  const endIndex = end ? sourceText.indexOf(end, startIndex) : sourceText.length;
  if (startIndex < 0 || endIndex <= startIndex) throw new Error(`Missing collector boundary: ${start}`);
  return sourceText.slice(startIndex, endIndex);
}

const collectorCode = transformSync([
  extract("async function getAcceptedBotForTrackedAccount(", "// Map IG media_type"),
  extract("async function openClient(", "// ─── Private-roster pagination"),
  extract("export function createBotCollectors(").replace("export function", "function"),
].join("\n"), { loader: "ts", format: "cjs" }).code;

function fixture() {
  const bot = {
    id: "bot-1",
    igUsername: "botuser",
    sessionData: "stale-encrypted-row-session",
    proxyEndpoint: null,
  } as unknown as BotAccount;
  const tracked = { id: "tracked-1", userId: "user-1", igUsername: "privateuser", isPrivate: true } as TrackedAccount;
  const runtime: BotRuntimeContext = {
    botId: bot.id,
    igUsername: bot.igUsername,
    sessionData: "current-runtime-session",
    proxyEndpoint: "fixed.example:9000:fixture-user:fixture-password",
    proxyUrl: "http://fixture-user:fixture-password@fixed.example:9000",
    automationIdentity: {
      identity_version: 1,
      bot_id: bot.id,
      client: "instagram-firefox-web",
      browser_family: "firefox",
      browser_version: "135",
      browser_seed: 123,
      platform: "Windows",
      user_agent: "fixture-firefox",
      http_impersonate: "firefox135",
      ja3: "fixture-ja3",
      h2_fingerprint: "fixture-h2",
      locale: "en-US",
      timezone: "America/New_York",
    },
    transport: "web",
  };
  const fingerprint = { userAgent: "legacy-chromium-ua", timezone: "UTC", locale: "en-US" };
  const client = {
    fetchProfile: vi.fn(async () => ({ pk: "target-pk", isPrivate: true })),
    fetchFriendshipStatus: vi.fn(async (_pk: string) => ({
      following: false,
      outgoingRequest: false,
      incomingRequest: false,
      followedBy: false,
      isPrivate: true,
    })),
    fetchUserFeed: vi.fn(async () => ({ items: [] })),
    sendFollow: vi.fn(async () => ({ following: false, outgoingRequest: true })),
    close: vi.fn(async () => {}),
  };
  const createClient = vi.fn(async () => client);
  const ctx = {
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    process: { env: { FOLLOW_TRANSPORT: "playwright" } },
    botAccounts: {}, botFollowRequests: {}, followEvents: {}, unfollowEvents: {}, likeEvents: {},
    and: () => true, eq: () => true,
    db: {
      select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [bot] }) }) }) }),
      transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
        select: () => ({ from: () => ({ where: async () => [] }) }),
      }),
    },
    ensureBotReady: vi.fn(async (_botId: string, _options?: { allowLogin?: boolean }) => runtime),
    trackedAccountHasAccess: vi.fn(async (_trackedId: string) => true),
    ensureBotFingerprint: vi.fn(async () => fingerprint),
    resolveFingerprint: () => fingerprint,
    decryptSessionData: vi.fn((session: string) => `decrypted(${session})`),
    isAwake: () => true,
    effectiveFollowCap: () => 5,
    isInWarmup: () => false,
    reserveGlobalFollow: vi.fn(() => true),
    reserveDailyBudget: vi.fn(async (_botId: string, _action: string) => {}),
    decorateBeforeFollow: vi.fn(async () => {}),
    humanDelay: vi.fn(async () => {}),
    markFollowRequestFailed: vi.fn(async () => {}),
    markFollowRequestSent: vi.fn(async () => {}),
    markFollowRequestAccepted: vi.fn(async () => {}),
    suspendBot: vi.fn(async () => {}),
    markBotSessionExpired: vi.fn(async () => {}),
    cooldownBot: vi.fn(async (_botId: string, _untilMs: number) => {}),
    cooldownBotForRateLimit: vi.fn(async (_botId: string, _retryAfterMs: number) => {}),
    sendBrowserFollow: vi.fn(async (_runtime: BotRuntimeContext, _username: string, _targetPk: string): Promise<IGFriendshipStatus> => ({
      following: false, outgoingRequest: true, incomingRequest: false, followedBy: false, isPrivate: true,
    })),
    playwrightSendFollowByUsername: vi.fn(async () => ({ following: false, requested: true })),
    proxyAgentUriForEndpoint: vi.fn(() => runtime.proxyUrl),
    withBotErrorHandling: async (_id: string, _username: string, run: () => Promise<unknown>) => run(),
    isIgWebThrottleBody,
    WEB_THROTTLE_COOLDOWN_MS: 10 * 60_000,
    fetchAllFollowing: vi.fn(async () => ({ users: [], pagesFetched: 1, complete: true })),
    resolvePrivateFollowsMaxPages: () => 10,
    decideUnfollowGate: () => ({ allow: true }),
    IGAuthExpiredError: class extends Error {},
    IGRateLimitedError: class extends Error {
      constructor(message = "rate limited", readonly retryAfterMs = 60_000) { super(message); }
    },
    IGDailyCapExceededError: class extends Error {
      constructor(readonly resetAt: Date) { super("daily cap exhausted"); }
    },
  };
  const context = vm.createContext(ctx);
  vm.runInContext(collectorCode, context);
  const collectors = context.createBotCollectors({ createClient }) as BotCollectors;
  return { bot, tracked, runtime, fingerprint, client, createClient, ctx, collectors };
}

describe("private follow canonical runtime", () => {
  it("does not let a shorter collector throttle shorten an existing hold", async () => {
    const code = transformSync(extract("export async function cooldownBot(", "// Audit B1:")
      .replace("export async function", "async function"), { loader: "ts", format: "cjs" }).code;
    const longHold = new Date(Date.now() + 24 * 60 * 60_000);
    const row = { id: "bot-1", cooldownUntil: longHold };
    const context = vm.createContext({
      console: { warn: vi.fn(), error: vi.fn() },
      botAccounts: row,
      and: (...values: boolean[]) => values.every(Boolean),
      or: (...values: boolean[]) => values.some(Boolean),
      isNull: (value: unknown) => value === null,
      eq: (left: unknown, right: unknown) => left === right,
      lt: (left: Date, right: Date) => left < right,
      db: { update: () => ({ set: (values: Partial<typeof row>) => ({ where: async (allowed: boolean) => {
        if (allowed) Object.assign(row, values);
      } }) }) },
    });
    vm.runInContext(code, context);
    await context.cooldownBot("bot-1", Date.now() + 600_000);
    expect(row.cooldownUntil).toBe(longHold);
    const later = longHold.getTime() + 60_000;
    await context.cooldownBot("bot-1", later);
    expect(row.cooldownUntil.getTime()).toBe(later);
  });

  it("defers a localized authentication-shaped throttle without expiring the session or failing its request", async () => {
    const f = fixture();
    f.tracked.igUserId = "123";
    const err = Object.assign(new f.ctx.IGAuthExpiredError("auth rejected"), {
      status: 401,
      body: JSON.stringify({ message: "Bitte warte einige Minuten", require_login: true, igweb_rollout: true, status: "fail" }),
    });
    f.client.fetchFriendshipStatus.mockRejectedValueOnce(err);
    const before = Date.now();
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: "deferred", reason: "cooldown", retryAfterMs: 600_000 });
    expect(f.ctx.cooldownBot).toHaveBeenCalledExactlyOnceWith(f.bot.id, expect.any(Number));
    expect(f.ctx.cooldownBot.mock.calls[0][1]).toBeGreaterThanOrEqual(before + 600_000);
    expect(f.ctx.markBotSessionExpired).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestFailed).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestSent).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledExactlyOnceWith();
  });

  it("still parks a genuine upstream authentication rejection and fails its follow request", async () => {
    const f = fixture();
    f.tracked.igUserId = "123";
    f.client.fetchFriendshipStatus.mockRejectedValueOnce(Object.assign(new f.ctx.IGAuthExpiredError("login_required"), {
      status: 401, body: '{"message":"login_required","require_login":true}',
    }));
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime)).resolves.toEqual({ kind: "failed" });
    expect(f.ctx.markBotSessionExpired).toHaveBeenCalledExactlyOnceWith(f.bot.id, "auth expired");
    expect(f.ctx.markFollowRequestFailed).toHaveBeenCalledExactlyOnceWith("request-1", "bot auth expired");
    expect(f.ctx.cooldownBot).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
  });

  it.each(["likes", "follows", "send"] as const)("preserves bot and request state on a local %s client failure", async lane => {
    const f = fixture();
    const failure = new Error("automation identity unavailable");
    f.createClient.mockRejectedValueOnce(failure);
    const attempt = lane === "send"
      ? f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime)
      : lane === "likes"
        ? f.collectors.collectLikesViaBotSession(f.tracked.id, f.tracked.igUsername, f.runtime.sessionData)
        : f.collectors.collectFollowsViaBotSession(f.tracked.id, f.tracked.igUsername, f.runtime.sessionData);
    await expect(attempt).rejects.toBe(failure);
    expect(f.ctx.suspendBot).not.toHaveBeenCalled();
    expect(f.ctx.markBotSessionExpired).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestFailed).not.toHaveBeenCalled();
    expect(f.client.fetchProfile).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
  });

  it.each(["likes", "follows", "send"] as const)("parks a structurally expired %s session without declaring the account banned", async lane => {
    const f = fixture();
    const failure = new f.ctx.IGAuthExpiredError("sessionid cookie missing or expired");
    f.createClient.mockRejectedValueOnce(failure);
    const attempt = lane === "send"
      ? f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime)
      : lane === "likes"
        ? f.collectors.collectLikesViaBotSession(f.tracked.id, f.tracked.igUsername, f.runtime.sessionData)
        : f.collectors.collectFollowsViaBotSession(f.tracked.id, f.tracked.igUsername, f.runtime.sessionData);
    if (lane === "send") {
      await expect(attempt).resolves.toEqual({ kind: "failed" });
      expect(f.ctx.markFollowRequestFailed).toHaveBeenCalledExactlyOnceWith("request-1", "bot session missing or expired");
    } else {
      await expect(attempt).rejects.toBe(failure);
    }
    expect(f.ctx.markBotSessionExpired).toHaveBeenCalledExactlyOnceWith(f.bot.id,
      "stored session missing or expired during client initialization");
    expect(f.ctx.suspendBot).not.toHaveBeenCalled();
    expect(f.client.fetchProfile).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
  });

  it("does not invalidate an account when local session decryption is unavailable", async () => {
    const f = fixture();
    const failure = new Error("session decryption unavailable");
    f.ctx.decryptSessionData.mockImplementationOnce(() => { throw failure; });
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime)).rejects.toBe(failure);
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.ctx.suspendBot).not.toHaveBeenCalled();
    expect(f.ctx.markBotSessionExpired).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestFailed).not.toHaveBeenCalled();
  });

  it.each([
    { isPrivate: true, action: "privateRequests" },
    { isPrivate: null, action: "privateRequests" },
    { isPrivate: false, action: "follows" },
  ])("reserves one $action unit for visibility $isPrivate", async ({ isPrivate, action }) => {
    const f = fixture();
    f.tracked.isPrivate = isPrivate;
    await f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime);
    expect(f.ctx.reserveDailyBudget).toHaveBeenCalledExactlyOnceWith(f.bot.id, action);
  });

  it("stops before any client traffic when the atomic ramp reservation rejects", async () => {
    const f = fixture();
    const resetAt = new Date(Date.now() + 60_000);
    f.ctx.reserveDailyBudget.mockRejectedValue(new f.ctx.IGDailyCapExceededError(resetAt));
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: "deferred", reason: "asleep", retryAfterMs: expect.any(Number) });
    expect(f.ctx.cooldownBot).toHaveBeenCalledExactlyOnceWith(f.bot.id, resetAt.getTime());
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
    expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestFailed).not.toHaveBeenCalled();
  });

  it("resolves a real fixed-proxy runtime without proxy_endpoint and carries it into follow traffic", async () => {
    const f = fixture();
    const runtimeSource = readFileSync(new URL("../services/bot-runtime.ts", import.meta.url), "utf8");
    const runtimeCode = transformSync([
      // Keep the production load, proxy URL normalization and session handling.
      extract("async function loadBot(", "async function autoLogin(", runtimeSource),
      extract("export async function ensureBotReady(", "/**\n * Mark the row's session", runtimeSource)
        .replace("export async function", "async function"),
    ].join("\n"), { loader: "ts", format: "cjs" }).code;
    const row = {
      id: f.bot.id,
      ig_username: f.bot.igUsername,
      proxy_url: f.runtime.proxyUrl,
      proxy_endpoint: null,
      session_data: f.runtime.sessionData,
      automation_identity: f.runtime.automationIdentity,
      transport: "web",
    };
    const runtimeCtx = vm.createContext({
      URL,
      process: { env: { NODE_ENV: "production" } },
      db: { execute: vi.fn(async () => ({ rows: [row] })) },
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
      logger: { info: vi.fn(), warn: vi.fn() },
      isEncryptedEnvelope: () => false,
      requireAutomationIdentity,
      assertDurableAccountProxyUrl,
      isKnownEphemeralDataImpulseProxyUrl,
      proxyAgentUriForEndpoint: vi.fn((endpoint: string) => {
        const [host, port, username, password] = endpoint.split(":");
        return `http://${username}:${password}@${host}:${port}`;
      }),
      fetchHealthyEndpoints: vi.fn(),
      autoLoginWithAutomation: vi.fn(),
      autoLogin: vi.fn(),
    });
    vm.runInContext(runtimeCode, runtimeCtx);

    const ready = await runtimeCtx.ensureBotReady(f.bot.id, { allowLogin: false }) as BotRuntimeContext;
    expect(ready).toEqual(f.runtime);
    expect(ready.automationIdentity).toBe(row.automation_identity);
    expect(row.proxy_endpoint).toBeNull();
    expect(runtimeCtx.db.execute).toHaveBeenCalledOnce();
    expect(runtimeCtx.fetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(runtimeCtx.autoLoginWithAutomation).not.toHaveBeenCalled();
    expect(runtimeCtx.autoLogin).not.toHaveBeenCalled();

    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, ready))
      .resolves.toEqual({ kind: "pending" });
    expect(f.createClient).toHaveBeenCalledWith("decrypted(current-runtime-session)", expect.objectContaining({
      proxyEndpoint: "fixed.example:9000:fixture-user:fixture-password",
      automationIdentity: row.automation_identity,
    }));
    expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).toHaveBeenCalledExactlyOnceWith(ready, f.tracked.igUsername, "target-pk");
    expect(f.client.sendFollow).not.toHaveBeenCalled();
  });

  it.each([null, "obsolete-row.example:8888"])(
    "uses runtime session, fixed proxy and Firefox identity when stored proxy is %s",
    async (storedProxy) => {
      const f = fixture();
      f.bot.proxyEndpoint = storedProxy;

      await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
        .resolves.toEqual({ kind: "pending" });

      expect(f.createClient).toHaveBeenCalledWith("decrypted(current-runtime-session)", {
        botId: f.bot.id,
        botUsername: f.bot.igUsername,
        fingerprint: f.fingerprint,
        proxyEndpoint: f.runtime.proxyEndpoint,
        automationIdentity: f.runtime.automationIdentity,
      });
      expect(f.ctx.decryptSessionData).toHaveBeenCalledWith(f.runtime.sessionData);
      expect(f.ctx.sendBrowserFollow).toHaveBeenCalledExactlyOnceWith(f.runtime, f.tracked.igUsername, "target-pk");
      expect(f.client.sendFollow).not.toHaveBeenCalled();
      expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
      expect(f.ctx.markFollowRequestSent).toHaveBeenCalledWith("request-1");
      expect(f.client.close).toHaveBeenCalledOnce();
    },
  );

  it("keeps the legacy browser path on the same runtime session and fixed proxy", async () => {
    const f = fixture();
    f.runtime.automationIdentity = null;

    await f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime);

    expect(f.ctx.playwrightSendFollowByUsername).toHaveBeenCalledWith(expect.objectContaining({
      sessionData: "decrypted(current-runtime-session)",
      proxyUrl: f.runtime.proxyUrl,
      targetUsername: f.tracked.igUsername,
    }));
    expect(f.ctx.proxyAgentUriForEndpoint).toHaveBeenCalledWith(f.runtime.proxyEndpoint);
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
  });

  it("does not repeat an unconfirmed legacy browser follow through HTTP", async () => {
    const f = fixture();
    f.runtime.automationIdentity = null;
    f.ctx.playwrightSendFollowByUsername.mockResolvedValue(null);
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .rejects.toThrow("refusing another write");
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestSent).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestAccepted).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("refuses a missing runtime proxy before budget reservation or client creation", async () => {
    const f = fixture();
    f.runtime.proxyEndpoint = "";
    f.bot.proxyEndpoint = "stale-row.example:8888";

    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: "failed" });

    expect(f.ctx.markFollowRequestFailed).toHaveBeenCalledWith("request-1", expect.stringContaining("no proxy_endpoint"));
    expect(f.ctx.reserveDailyBudget).not.toHaveBeenCalled();
    expect(f.ctx.reserveGlobalFollow).not.toHaveBeenCalled();
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
  });

  it("rejects another bot's runtime before opening a client", async () => {
    const f = fixture();
    f.runtime.botId = "other-bot";
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .rejects.toThrow("runtime does not match assigned bot");
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.ctx.reserveDailyBudget).not.toHaveBeenCalled();
  });

  it("rejects ended paid access before fingerprint or traffic work", async () => {
    const f = fixture();
    f.ctx.trackedAccountHasAccess.mockResolvedValue(false);
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: "failed" });
    expect(f.ctx.markFollowRequestFailed).toHaveBeenCalledWith("request-1", "Tracking access ended");
    expect(f.ctx.ensureBotFingerprint).not.toHaveBeenCalled();
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.ctx.reserveDailyBudget).not.toHaveBeenCalled();
  });

  it("does not follow after paid access ends during the profile-to-follow delay", async () => {
    const f = fixture();
    f.ctx.humanDelay.mockImplementation(async () => { f.ctx.trackedAccountHasAccess.mockResolvedValue(false); });
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: "failed" });
    expect(f.client.fetchProfile).toHaveBeenCalledOnce();
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestSent).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });
});

describe.each(["playwright", "http"])("migrated browser follow with FOLLOW_TRANSPORT=%s", (transport) => {
  const targetId = "9007199254740993";

  it.each([
    { following: false, outgoingRequest: true, outcome: "pending" },
    { following: true, outgoingRequest: false, outcome: "accepted" },
    { following: true, outgoingRequest: true, outcome: "pending" },
  ])("records only the verified $outcome result ($following/$outgoingRequest)", async ({ following, outgoingRequest, outcome }) => {
    const f = fixture();
    f.ctx.process.env.FOLLOW_TRANSPORT = transport;
    f.tracked.igUserId = targetId;
    f.ctx.sendBrowserFollow.mockResolvedValue({ following, outgoingRequest, incomingRequest: false, followedBy: false, isPrivate: true });

    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: outcome });

    expect(f.ctx.sendBrowserFollow).toHaveBeenCalledExactlyOnceWith(f.runtime, f.tracked.igUsername, targetId);
    expect(f.ctx.sendBrowserFollow.mock.calls[0][0]).toBe(f.runtime);
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestSent).toHaveBeenCalledExactlyOnceWith("request-1");
    if (outcome === "accepted") {
      expect(f.ctx.markFollowRequestAccepted).toHaveBeenCalledExactlyOnceWith("request-1", f.tracked.userId);
    } else {
      expect(f.ctx.markFollowRequestAccepted).not.toHaveBeenCalled();
    }
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("propagates an unconfirmed browser failure without another transport or a sent transition", async () => {
    const f = fixture();
    f.ctx.process.env.FOLLOW_TRANSPORT = transport;
    f.tracked.igUserId = targetId;
    const failure = new Error("Browser follow did not confirm the relationship");
    f.ctx.sendBrowserFollow.mockRejectedValue(failure);

    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime)).rejects.toBe(failure);

    expect(f.ctx.sendBrowserFollow).toHaveBeenCalledExactlyOnceWith(f.runtime, f.tracked.igUsername, targetId);
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestSent).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestAccepted).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it.each([
    { following: false, outgoingRequest: false, incomingRequest: false, followedBy: false, isPrivate: true },
    null,
    undefined,
  ])("never falls back or marks sent for an unconfirmed helper result %j", async (result) => {
    const f = fixture();
    f.ctx.process.env.FOLLOW_TRANSPORT = transport;
    f.tracked.igUserId = targetId;
    // Defense at the collector boundary, including accidental helper contract violations.
    f.ctx.sendBrowserFollow.mockResolvedValue(result as IGFriendshipStatus);

    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime)).rejects.toThrow();

    expect(f.ctx.sendBrowserFollow).toHaveBeenCalledOnce();
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestSent).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestAccepted).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });
});

describe("private follow target friendship preflight", () => {
  const targetId = "9007199254740993";

  it("uses the saved numeric ID without unrelated profile visits or decoration", async () => {
    const f = fixture();
    f.tracked.igUserId = targetId;
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: "pending" });
    expect(f.client.fetchFriendshipStatus).toHaveBeenCalledExactlyOnceWith(targetId);
    expect(f.ctx.sendBrowserFollow).toHaveBeenCalledExactlyOnceWith(f.runtime, f.tracked.igUsername, targetId);
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.client.fetchProfile).not.toHaveBeenCalled();
    expect(f.ctx.decorateBeforeFollow).not.toHaveBeenCalled();
    expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    expect(f.ctx.ensureBotReady).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it.each([
    { following: false, outgoingRequest: true, trackedPrivate: true, outcome: "pending" },
    { following: true, outgoingRequest: false, trackedPrivate: true, outcome: "accepted" },
    { following: false, outgoingRequest: true, trackedPrivate: false, outcome: "pending" },
    { following: true, outgoingRequest: true, trackedPrivate: false, outcome: "pending" },
  ])("does not repeat a $outcome follow request ($following/$outgoingRequest, private=$trackedPrivate)", async ({ following, outgoingRequest, trackedPrivate, outcome }) => {
    const f = fixture();
    f.tracked.igUserId = targetId;
    f.tracked.isPrivate = trackedPrivate;
    f.client.fetchFriendshipStatus.mockResolvedValue({
      following, outgoingRequest, incomingRequest: false, followedBy: false, isPrivate: true,
    });
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: outcome });
    expect(f.ctx.markFollowRequestSent).toHaveBeenCalledWith("request-1");
    if (outcome === "accepted") {
      expect(f.ctx.markFollowRequestAccepted).toHaveBeenCalledWith("request-1", f.tracked.userId);
    } else {
      expect(f.ctx.markFollowRequestAccepted).not.toHaveBeenCalled();
    }
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
    expect(f.client.fetchProfile).not.toHaveBeenCalled();
    expect(f.ctx.decorateBeforeFollow).not.toHaveBeenCalled();
    expect(f.ctx.playwrightSendFollowByUsername).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it.each([null, "", "not-a-numeric-id"])("falls back to the target profile for unknown ID %s", async (igUserId) => {
    const f = fixture();
    f.tracked.igUserId = igUserId;
    await f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime);
    expect(f.client.fetchProfile).toHaveBeenCalledExactlyOnceWith(f.tracked.igUsername);
    expect(f.client.fetchFriendshipStatus).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).toHaveBeenCalledExactlyOnceWith(f.runtime, f.tracked.igUsername, "target-pk");
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.decorateBeforeFollow).not.toHaveBeenCalled();
  });

  it("supports older ports without friendship-status reads", async () => {
    const f = fixture();
    f.tracked.igUserId = targetId;
    delete (f.client as Partial<typeof f.client>).fetchFriendshipStatus;
    await f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime);
    expect(f.client.fetchProfile).toHaveBeenCalledExactlyOnceWith(f.tracked.igUsername);
    expect(f.ctx.sendBrowserFollow).toHaveBeenCalledExactlyOnceWith(f.runtime, f.tracked.igUsername, "target-pk");
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.decorateBeforeFollow).not.toHaveBeenCalled();
  });

  it("does not follow or publish acceptance if access ends during the friendship read", async () => {
    const f = fixture();
    f.tracked.igUserId = targetId;
    f.client.fetchFriendshipStatus.mockImplementation(async () => {
      f.ctx.trackedAccountHasAccess.mockResolvedValue(false);
      return { following: true, outgoingRequest: false, incomingRequest: false, followedBy: false, isPrivate: true };
    });
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: "failed" });
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.client.fetchProfile).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestSent).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestAccepted).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestFailed).toHaveBeenCalledWith("request-1", "Tracking access ended");
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it.each([0, 30_000, 90_000])("uses the shared cooldown policy and sends no more traffic after a friendship rate limit of %i ms", async retryAfterMs => {
    const f = fixture();
    f.tracked.igUserId = targetId;
    const error = new f.ctx.IGRateLimitedError("friendship preflight throttled", retryAfterMs);
    f.client.fetchFriendshipStatus.mockRejectedValue(error);
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime)).rejects.toBe(error);
    expect(f.ctx.cooldownBotForRateLimit).toHaveBeenCalledExactlyOnceWith(f.bot.id, retryAfterMs);
    expect(f.ctx.cooldownBot).not.toHaveBeenCalled();
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.client.fetchProfile).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestSent).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestFailed).not.toHaveBeenCalled();
    expect(f.ctx.sendBrowserFollow).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("defers an active cooldown before budget reservation or client traffic", async () => {
    const f = fixture();
    f.tracked.igUserId = targetId;
    f.bot.cooldownUntil = new Date(Date.now() + 60_000);
    const outcome = await f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime);
    expect(outcome).toEqual({ kind: "deferred", reason: "cooldown", retryAfterMs: expect.any(Number) });
    if (outcome.kind === "deferred") {
      expect(outcome.retryAfterMs).toBeGreaterThan(55_000);
      expect(outcome.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
    expect(f.ctx.reserveGlobalFollow).not.toHaveBeenCalled();
    expect(f.ctx.reserveDailyBudget).not.toHaveBeenCalled();
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.ctx.markFollowRequestFailed).not.toHaveBeenCalled();
  });

  it("allows the same bot to continue after its cooldown has elapsed", async () => {
    const f = fixture();
    f.tracked.igUserId = targetId;
    f.bot.cooldownUntil = new Date(Date.now() - 1_000);
    await expect(f.collectors.sendFollowForRequest("request-1", f.bot, f.tracked, f.runtime))
      .resolves.toEqual({ kind: "pending" });
    expect(f.client.fetchFriendshipStatus).toHaveBeenCalledWith(targetId);
    expect(f.ctx.sendBrowserFollow).toHaveBeenCalledExactlyOnceWith(f.runtime, f.tracked.igUsername, targetId);
    expect(f.client.sendFollow).not.toHaveBeenCalled();
    expect(f.ctx.ensureBotReady).not.toHaveBeenCalled();
  });
});

describe.each(["collectLikesViaBotSession", "collectFollowsViaBotSession"] as const)("%s runtime", (method) => {
  it("resolves the accepted bot with login disabled and ignores the caller's stale session", async () => {
    const f = fixture();
    await expect(f.collectors[method](f.tracked.id, f.tracked.igUsername, "stale-caller-session"))
      .resolves.toBe(0);
    expect(f.ctx.ensureBotReady).toHaveBeenCalledWith(f.bot.id, { allowLogin: false });
    expect(f.createClient).toHaveBeenCalledWith("decrypted(current-runtime-session)", {
      botId: f.bot.id,
      botUsername: f.bot.igUsername,
      fingerprint: f.fingerprint,
      proxyEndpoint: f.runtime.proxyEndpoint,
      automationIdentity: f.runtime.automationIdentity,
    });
    expect(f.client.fetchProfile).toHaveBeenCalledWith(f.tracked.igUsername);
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("skips readiness and all client traffic for ended paid access", async () => {
    const f = fixture();
    f.ctx.trackedAccountHasAccess.mockResolvedValue(false);
    await expect(f.collectors[method](f.tracked.id, f.tracked.igUsername, "stale-caller-session"))
      .resolves.toBe(0);
    expect(f.ctx.ensureBotReady).not.toHaveBeenCalled();
    expect(f.createClient).not.toHaveBeenCalled();
  });

  it.each([
    "saved session unavailable; this read cannot allocate a proxy or log in",
    "authenticated session has no fresh proxy lane; refusing IP rotation",
  ])("stops before client creation when readiness rejects: %s", async (message) => {
    const f = fixture();
    const failure = new Error(message);
    f.ctx.ensureBotReady.mockRejectedValue(failure);
    await expect(f.collectors[method](f.tracked.id, f.tracked.igUsername, "stale-caller-session"))
      .rejects.toBe(failure);
    expect(f.ctx.ensureBotReady).toHaveBeenCalledWith(f.bot.id, { allowLogin: false });
    expect(f.createClient).not.toHaveBeenCalled();
  });
});
