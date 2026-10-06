// Unit tests for server/services/bot-runtime.ts
// All external I/O (DB, proxy, login, session crypto) is mocked.
// No real network, no real database.

import { describe, it, expect, beforeEach, vi, type MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// Mock: db — must stub env before db.ts is imported so it doesn't throw
// ---------------------------------------------------------------------------

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

const recoveryMocks = vi.hoisted(() => ({
  assertOwned: vi.fn(async () => undefined),
  activeKeys: new Set<string>(),
  transactionDepth: 0,
}));

vi.mock("../db.js", () => {
  const executeMock = vi.fn();
  const updateMock = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }));
  return {
    db: {
      execute: executeMock,
      update: updateMock,
      transaction: vi.fn(async (work: (tx: { execute: typeof executeMock }) => Promise<unknown>) => {
        recoveryMocks.transactionDepth += 1;
        try { return await work({ execute: executeMock }); }
        finally { recoveryMocks.transactionDepth -= 1; }
      }),
    },
  };
});

vi.mock("./operation-lease.js", () => {
  class OperationBusyError extends Error {}
  return {
    OperationBusyError,
    withOperationLease: vi.fn(async (key: string, work: (signal: AbortSignal, guard: unknown) => Promise<unknown>) => {
      if (recoveryMocks.activeKeys.has(key)) throw new OperationBusyError();
      recoveryMocks.activeKeys.add(key);
      try { return await work(new AbortController().signal, { assertOwned: recoveryMocks.assertOwned }); }
      finally { recoveryMocks.activeKeys.delete(key); }
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock: shared/schema.js (drizzle schema) — bot-runtime imports botAccounts
// ---------------------------------------------------------------------------

vi.mock("../../shared/schema.js", () => ({
  botAccounts: {},
}));

// ---------------------------------------------------------------------------
// Mock: proxy-provider
// ---------------------------------------------------------------------------

vi.mock("./proxy-provider.js", () => ({
  fetchEndpoints: vi.fn(),
  fetchHealthyEndpoints: vi.fn(),
  isEndpointFresh: vi.fn(),
  proxyAgentUriForEndpoint: vi.fn((endpoint: string) => `http://${endpoint}`),
  proxyEndpointLabel: vi.fn((endpoint: string | null | undefined) =>
    endpoint ? `${endpoint.split(":").slice(0, 2).join(":")}:auth` : null,
  ),
  // Realistic enough to verify the scrub actually removes credentials: strip
  // any `user:pass` tail of the known endpoint, and the `user:pass@` wire form,
  // from the message.
  scrubProxyCredential: vi.fn(
    (message: string, endpoint: string | null | undefined) => {
      if (!endpoint) return message;
      const [host, port, user, pass] = endpoint.split(":");
      if (!user) return message;
      const label = `${host}:${port}:auth`;
      let out = message.split(`${host}:${port}:${user}:${pass ?? ""}`).join(label);
      out = out.split(`http://${user}:${pass ?? ""}@${host}:${port}`).join(label);
      out = out.split(`${user}:${pass ?? ""}@`).join("");
      return out;
    },
  ),
}));

// ---------------------------------------------------------------------------
// Mock: bot-login — bot-runtime needs the typed error classes for its
// instanceof branches, so the mock must export real class values.
// ---------------------------------------------------------------------------

vi.mock("./bot-login.js", () => {
  class LoginAccountSuspendedError extends Error {
    override readonly name = "LoginAccountSuspendedError";
  }
  class LoginBadCredentialsError extends Error {
    override readonly name = "LoginBadCredentialsError";
  }
  class LoginRateLimitedError extends Error {
    override readonly name = "LoginRateLimitedError";
  }
  class LoginCaptchaRequiredError extends Error {
    override readonly name = "LoginCaptchaRequiredError";
  }
  class Login2FARequiredButNoSecretError extends Error {
    override readonly name = "Login2FARequiredButNoSecretError";
  }
  return {
    loginBotWithRetry: vi.fn(),
    LoginAccountSuspendedError,
    LoginBadCredentialsError,
    LoginRateLimitedError,
    LoginCaptchaRequiredError,
    Login2FARequiredButNoSecretError,
  };
});

const automationClientMocks = vi.hoisted(() => ({
  probeInstagramLogin: vi.fn(),
  startInstagramLogin: vi.fn(),
  completeInstagramLogin: vi.fn(),
}));

vi.mock("./automation-client.js", () => ({
  createAutomationClient: vi.fn(() => ({
    probeInstagramLogin: automationClientMocks.probeInstagramLogin,
    startInstagramLogin: automationClientMocks.startInstagramLogin,
    completeInstagramLogin: automationClientMocks.completeInstagramLogin,
  })),
}));

// ---------------------------------------------------------------------------
// Mock: crypto/credentials — decryptCredential returns the input unchanged
// ---------------------------------------------------------------------------

vi.mock("../crypto/credentials.js", () => ({
  decryptCredential: (v: string) => `decrypted(${v})`,
}));

// ---------------------------------------------------------------------------
// Mock: crypto/session-envelope
// ---------------------------------------------------------------------------

vi.mock("../crypto/session-envelope.js", () => ({
  isEncryptedEnvelope: (v: string) => v.startsWith("v1:"),
  decryptSessionData: (v: string) => `decrypted_session(${v})`,
  encryptSessionData: (v: string) => `v1:enc(${v})`,
}));

// ---------------------------------------------------------------------------
// Mock: logger
// ---------------------------------------------------------------------------

vi.mock("../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock: drizzle-orm — sql tagged template + eq
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  sql: new Proxy(
    Object.assign(
      (...args: unknown[]) => args,
      { raw: (...args: unknown[]) => args },
    ),
    {
      get(target, prop) {
        if (prop === "raw") return (...args: unknown[]) => args;
        return (target as Record<string | symbol, unknown>)[prop];
      },
      apply(target, thisArg, args) {
        return args;
      },
    },
  ),
  eq: vi.fn((_col: unknown, _val: unknown) => true),
}));

// ---------------------------------------------------------------------------
// Import mocks + module under test AFTER all vi.mock() calls
// ---------------------------------------------------------------------------

import { db } from "../db.js";
import { fetchHealthyEndpoints, isEndpointFresh } from "./proxy-provider.js";
import {
  loginBotWithRetry,
  LoginBadCredentialsError,
  LoginRateLimitedError,
} from "./bot-login.js";
import { ensureBotReady, invalidateObservedBotSession } from "./bot-runtime.js";
import { withOperationLease } from "./operation-lease.js";

// Typed helpers for cleaner assertions
const mockExecute = db.execute as MockInstance;
const mockIsEndpointFresh = isEndpointFresh as unknown as MockInstance;
const mockFetchHealthyEndpoints = fetchHealthyEndpoints as unknown as MockInstance;
const mockLoginBotWithRetry = loginBotWithRetry as unknown as MockInstance;

describe("invalidate only the observed rejected session", () => {
  beforeEach(() => mockExecute.mockReset());

  it.each(["available", "in_use"])("parks a matching %s session without changing identity or cooldown", async (status) => {
    mockExecute.mockResolvedValueOnce({ rows: [{ session_data: "v1:saved", status }] })
      .mockResolvedValueOnce({ rows: [{ id: "bot-001" }] });
    expect(await invalidateObservedBotSession("bot-001", "decrypted_session(v1:saved)")).toBe(true);
    const update = executedSqlText(1);
    expect(update).toContain("status = 'session_expired'");
    expect(update).toContain("AND status = ");
    expect(update).toContain("AND session_data =");
    expect(mockExecute.mock.calls[1][0].slice(1)).toEqual(["bot-001", status, "v1:saved"]);
    expect(update).not.toMatch(/proxy|identity|cooldown|login_attempt/);
  });

  it("also compares legacy plaintext sessions", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ session_data: "plain-session", status: "available" }] })
      .mockResolvedValueOnce({ rows: [{ id: "bot-001" }] });
    expect(await invalidateObservedBotSession("bot-001", "plain-session")).toBe(true);
  });

  it("preserves a session renewed before the comparison", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ session_data: "v1:renewed", status: "available" }] });
    expect(await invalidateObservedBotSession("bot-001", "decrypted_session(v1:saved)")).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("does not claim invalidation when renewal wins the CAS race", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ session_data: "v1:saved", status: "available" }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await invalidateObservedBotSession("bot-001", "decrypted_session(v1:saved)")).toBe(false);
  });

  it.each(["banned", "disabled", "session_expired"])("preserves the %s state", async (status) => {
    mockExecute.mockResolvedValueOnce({ rows: [{ session_data: "plain-session", status }] });
    expect(await invalidateObservedBotSession("bot-001", "plain-session")).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("does not mutate missing sessions or rows", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ session_data: null, status: "available" }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await invalidateObservedBotSession("bot-001", "old-session")).toBe(false);
    expect(await invalidateObservedBotSession("bot-002", "old-session")).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("rejects empty observations without reading or changing the database", async () => {
    expect(await invalidateObservedBotSession("bot-001", "")).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bot row builder
// ---------------------------------------------------------------------------

function makeBotRow(overrides: Partial<{
  id: string;
  ig_username: string;
  session_data: string | null;
  ig_password_encrypted: string | null;
  email_address: string | null;
  email_password_encrypted: string | null;
  imap_host: string | null;
  imap_port: number | null;
  proxy_url: string | null;
  proxy_endpoint: string | null;
  proxy_session_id: string | null;
  proxy_expires_at: Date | null;
  automation_identity: unknown;
}> = {}) {
  return {
    id: "bot-001",
    ig_username: "testbot",
    session_data: null,
    ig_password_encrypted: "enc-ig-pass",
    email_address: null,
    email_password_encrypted: null,
    imap_host: null,
    imap_port: null,
    proxy_url: null,
    proxy_endpoint: null,
    proxy_session_id: null,
    proxy_expires_at: null,
    automation_identity: null,
    ...overrides,
  };
}

const FRESH_PROXY_ENDPOINT = {
  endpoint: "10.0.0.1:9000",
  sessionId: "9000",
  expiresAt: new Date(Date.now() + 30 * 60 * 1000),
};

/**
 * The drizzle `sql` mock is a tagged-template stub that returns its raw
 * arguments, so db.execute receives `[TemplateStringsArray, ...values]`.
 * Joining the template strings reconstructs the static SQL text — enough to
 * assert which UPDATE shape ran (parked vs error-only).
 */
function executedSqlText(callIndex: number): string {
  const arg = mockExecute.mock.calls[callIndex]?.[0] as unknown;
  if (!Array.isArray(arg)) return String(arg);
  const strings = arg[0] as unknown;
  return Array.isArray(strings) ? strings.join(" ") : String(strings);
}

// ---------------------------------------------------------------------------
// Test: fresh proxy + valid session → no refresh, no login
// ---------------------------------------------------------------------------

describe("ensureBotReady — fresh proxy + valid session", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): also drops unconsumed
    // mockResolvedValueOnce queues so a failing test can't leak stale
    // db.execute results into the next one. Vitest restores the original
    // implementations passed to vi.fn(impl) in the mock factories.
    vi.resetAllMocks();
  });

  it("returns immediately with existing session data without calling fetch or login", async () => {
    const bot = makeBotRow({
      proxy_endpoint: "10.0.0.1:9000",
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      // plaintext session (no v1: prefix → readSession returns as-is)
      session_data: "plain-session-json",
    });

    // loadBot via db.execute
    mockExecute.mockResolvedValueOnce({ rows: [bot] });
    // isEndpointFresh → true (proxy is fresh)
    mockIsEndpointFresh.mockReturnValue(true);

    const ctx = await ensureBotReady("bot-001");

    expect(ctx.sessionData).toBe("plain-session-json");
    expect(ctx.proxyUrl).toBe("http://10.0.0.1:9000");
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(mockLoginBotWithRetry).not.toHaveBeenCalled();
  });

  it("saved-session-only reads cannot allocate a proxy or log in when the session is absent", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [makeBotRow({session_data:null,proxy_endpoint:null})] });
    await expect(ensureBotReady("bot-001",{allowLogin:false})).rejects.toThrow("this read cannot allocate a proxy or log in");
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(mockLoginBotWithRetry).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("decrypts a v1: session envelope", async () => {
    const bot = makeBotRow({
      proxy_endpoint: "10.0.0.1:9000",
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      session_data: "v1:encrypted-session-data",
    });

    mockExecute.mockResolvedValueOnce({ rows: [bot] });
    mockIsEndpointFresh.mockReturnValue(true);

    const ctx = await ensureBotReady("bot-001");

    // decryptSessionData mock prepends "decrypted_session("
    expect(ctx.sessionData).toBe("decrypted_session(v1:encrypted-session-data)");
    expect(mockLoginBotWithRetry).not.toHaveBeenCalled();
  });

  it("uses an explicit proxy_url instead of asking the provider", async () => {
    const bot = makeBotRow({
      proxy_url: "http://user:pass@gateway.example:823",
      session_data: "plain-session-json",
    });
    mockExecute.mockResolvedValueOnce({ rows: [bot] });

    const ctx = await ensureBotReady("bot-001");

    expect(ctx.proxyEndpoint).toBe("gateway.example:823:user:pass");
    expect(ctx.proxyUrl).toBe("http://gateway.example:823:user:pass");
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(mockLoginBotWithRetry).not.toHaveBeenCalled();
  });

  it("rejects the rotating DataImpulse gateway stored as an account proxy", async () => {
    const bot = makeBotRow({
      proxy_url: "http://example-user:example-pass@gw.dataimpulse.com:823",
      session_data: "plain-session-json",
    });
    mockExecute.mockResolvedValueOnce({ rows: [bot] });

    await expect(ensureBotReady("bot-001")).rejects.toThrow(
      /not durable account proxies/,
    );
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(mockLoginBotWithRetry).not.toHaveBeenCalled();
  });

  it("does not let the recovery override move an authenticated session onto the rotating gateway", async () => {
    const previous = process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY;
    process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY = "true";
    try {
      const bot = makeBotRow({
        proxy_url: "http://example-user:example-pass@gw.dataimpulse.com:823",
        session_data: "plain-session-json",
      });
      mockExecute.mockResolvedValueOnce({ rows: [bot] });

      await expect(ensureBotReady("bot-001")).rejects.toThrow(
        /bootstrap-only/,
      );
      expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
      expect(mockLoginBotWithRetry).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY;
      } else {
        process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY = previous;
      }
    }
  });

  it("allows an explicit short-lived bootstrap only outside production with no session", async () => {
    const previousOverride = process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY = "true";
    process.env.NODE_ENV = "test";
    try {
      const bot = makeBotRow({
        proxy_url: "http://example-user:example-pass@gw.dataimpulse.com:12000",
        session_data: null,
        ig_password_encrypted: "enc-ig-pass",
      });
      mockExecute.mockResolvedValueOnce({ rows: [bot] });
      mockLoginBotWithRetry.mockResolvedValueOnce({
        storageStateJson: "fresh-session-json",
      });

      const ctx = await ensureBotReady("bot-001");

      expect(ctx.sessionData).toBe("fresh-session-json");
      expect(ctx.proxyEndpoint).toBe(
        "gw.dataimpulse.com:12000:example-user:example-pass",
      );
      expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
      expect(mockLoginBotWithRetry).toHaveBeenCalledTimes(1);
      const saved = executedSqlText(1);
      expect(saved).toContain("consecutive_hard_failures = 0");
      expect(saved).toContain("last_hard_failure_at = NULL");
      expect(saved).toContain("warm_failure_streak = 0");
      expect(saved).toContain("CASE WHEN cooldown_until <= NOW() THEN NULL ELSE cooldown_until END");
      expect(saved).toContain("login_attempt_count = login_attempt_count + 1");
      expect(saved).not.toMatch(/daily_budget|requests_today|daily_limit/);
    } finally {
      if (previousOverride === undefined) {
        delete process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY;
      } else {
        process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY = previousOverride;
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test: expired proxy handling
// ---------------------------------------------------------------------------

describe("ensureBotReady — expired proxy", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): also drops unconsumed
    // mockResolvedValueOnce queues so a failing test can't leak stale
    // db.execute results into the next one. Vitest restores the original
    // implementations passed to vi.fn(impl) in the mock factories.
    vi.resetAllMocks();
  });

  it("fails closed instead of moving a valid session to a new exit IP", async () => {
    const bot = makeBotRow({
      proxy_endpoint: "old.host:1000",
      proxy_expires_at: new Date(Date.now() - 1000), // past
      session_data: "plain-session-json",
    });

    mockExecute.mockResolvedValueOnce({ rows: [bot] });
    mockIsEndpointFresh.mockReturnValue(false);

    await expect(ensureBotReady("bot-001")).rejects.toThrow(
      /authenticated session has no fresh proxy lane; refusing IP rotation/,
    );

    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(mockLoginBotWithRetry).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("may allocate a new proxy before a deliberate login when no session exists", async () => {
    const bot = makeBotRow({
      proxy_endpoint: "old.host:1000",
      proxy_expires_at: new Date(Date.now() - 1000),
      session_data: null,
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    mockIsEndpointFresh.mockReturnValue(false);
    mockFetchHealthyEndpoints.mockResolvedValue([FRESH_PROXY_ENDPOINT]);
    mockLoginBotWithRetry.mockResolvedValue({ storageStateJson: '{"cookies":[]}' });

    const ctx = await ensureBotReady("bot-001");

    expect(mockFetchHealthyEndpoints).toHaveBeenCalledOnce();
    expect(mockLoginBotWithRetry).toHaveBeenCalledOnce();
    expect(ctx.proxyEndpoint).toBe("10.0.0.1:9000");
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("uses a credential-free Firefox probe for a migrated bot", async () => {
    const identity = {
      identity_version: 1 as const,
      client: "instagram-firefox-web" as const,
      bot_id: "bot-001",
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
    const bot = makeBotRow({
      proxy_endpoint: null,
      proxy_expires_at: null,
      session_data: null,
      automation_identity: identity,
    });
    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    mockIsEndpointFresh.mockReturnValue(false);
    automationClientMocks.probeInstagramLogin.mockResolvedValue({
      status: "ready",
      message: null,
    });
    mockFetchHealthyEndpoints.mockImplementation(async (_wanted, options) => {
      const accepted = await options.probe(FRESH_PROXY_ENDPOINT.endpoint, 10_000);
      expect(accepted).toBe(FRESH_PROXY_ENDPOINT.endpoint);
      return [FRESH_PROXY_ENDPOINT];
    });
    automationClientMocks.startInstagramLogin.mockResolvedValue({
      status: "authenticated",
      message: null,
      storage_state: { cookies: [], origins: [] },
    });

    await ensureBotReady("bot-001");

    expect(automationClientMocks.probeInstagramLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        timeout_ms: 45_000,
      }),
    );
    const probePayload = automationClientMocks.probeInstagramLogin.mock.calls[0][0];
    expect(probePayload).not.toHaveProperty("credentials");
    expect(mockFetchHealthyEndpoints).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ country: "us", maxAttempts: 5 }),
    );
    expect(automationClientMocks.startInstagramLogin).toHaveBeenCalledOnce();
    expect(mockLoginBotWithRetry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test: null session_data → calls autoLogin, persists, returns
// ---------------------------------------------------------------------------

describe("ensureBotReady — null session → auto-login", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): also drops unconsumed
    // mockResolvedValueOnce queues so a failing test can't leak stale
    // db.execute results into the next one. Vitest restores the original
    // implementations passed to vi.fn(impl) in the mock factories.
    vi.resetAllMocks();
  });

  it("calls loginBotWithRetry and persists the new session when session_data is null", async () => {
    const bot = makeBotRow({
      proxy_endpoint: "10.0.0.1:9000",
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      session_data: null,
      ig_password_encrypted: "enc-ig-pass",
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })   // loadBot
      .mockResolvedValueOnce(undefined);          // UPDATE session

    mockIsEndpointFresh.mockReturnValue(true);
    mockLoginBotWithRetry.mockResolvedValue({ storageStateJson: '{"cookies":[]}' });

    const ctx = await ensureBotReady("bot-001");

    expect(mockLoginBotWithRetry).toHaveBeenCalledOnce();
    expect(ctx.sessionData).toBe('{"cookies":[]}');
    // The UPDATE with new session should have been executed
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("does not allow provider rotation when a static proxy_url needs a login", async () => {
    const bot = makeBotRow({
      proxy_url: "http://user:pass@gateway.example:823",
      session_data: null,
    });
    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })
      .mockResolvedValueOnce(undefined);
    mockLoginBotWithRetry.mockResolvedValue({ storageStateJson: '{"cookies":[]}' });

    await ensureBotReady("bot-001");

    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(mockLoginBotWithRetry).toHaveBeenCalledWith(
      expect.anything(),
      { endpoint: "gateway.example:823:user:pass" },
      3,
      { allowProxyRotation: false },
    );
  });
});

// ---------------------------------------------------------------------------
// Test: invalid session (decrypt fails) → auto-login path
// ---------------------------------------------------------------------------

describe("ensureBotReady — invalid session (decrypt failure) → auto-login", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): also drops unconsumed
    // mockResolvedValueOnce queues so a failing test can't leak stale
    // db.execute results into the next one. Vitest restores the original
    // implementations passed to vi.fn(impl) in the mock factories.
    vi.resetAllMocks();
  });

  it("falls back to auto-login when decryptSessionData throws", async () => {
    // Import the mocked module so we can temporarily override decryptSessionData
    const sessionEnvelope = await import("../crypto/session-envelope.js");
    const decryptSpy = vi
      .spyOn(sessionEnvelope, "decryptSessionData")
      .mockImplementationOnce(() => {
        throw new Error("bad tag");
      });

    const bot = makeBotRow({
      proxy_endpoint: "10.0.0.1:9000",
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      // v1: prefix causes isEncryptedEnvelope → true, so decryptSessionData is called
      session_data: "v1:corrupted-data",
      ig_password_encrypted: "enc-ig-pass",
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })   // loadBot
      .mockResolvedValueOnce(undefined);          // UPDATE session

    mockIsEndpointFresh.mockReturnValue(true);
    mockLoginBotWithRetry.mockResolvedValue({ storageStateJson: '{"cookies":[]}' });

    const ctx = await ensureBotReady("bot-001");

    expect(mockLoginBotWithRetry).toHaveBeenCalledOnce();
    expect(ctx.sessionData).toBe('{"cookies":[]}');
    decryptSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Test: autoLogin failure → persists last_login_error and re-throws
// ---------------------------------------------------------------------------

describe("ensureBotReady — autoLogin failure", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): also drops unconsumed
    // mockResolvedValueOnce queues so a failing test can't leak stale
    // db.execute results into the next one. Vitest restores the original
    // implementations passed to vi.fn(impl) in the mock factories.
    vi.resetAllMocks();
  });

  it("persists last_login_error and throws when loginBotWithRetry rejects", async () => {
    const bot = makeBotRow({
      proxy_endpoint: "10.0.0.1:9000",
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      session_data: null,
      ig_password_encrypted: "enc-ig-pass",
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })   // loadBot
      .mockResolvedValueOnce(undefined);          // UPDATE last_login_error

    mockIsEndpointFresh.mockReturnValue(true);
    mockLoginBotWithRetry.mockRejectedValue(new Error("IG login failed: challenge"));

    await expect(ensureBotReady("bot-001")).rejects.toThrow(
      "IG login failed: challenge",
    );

    // The error-update execute must have been called
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("throws when bot row is not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] }); // empty result
    mockIsEndpointFresh.mockReturnValue(false);

    await expect(ensureBotReady("nonexistent")).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Test: login failure classification — transient vs bad credentials
// ---------------------------------------------------------------------------

describe("ensureBotReady — login failure classification", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): also drops unconsumed
    // mockResolvedValueOnce queues so a failing test can't leak stale
    // db.execute results into the next one. Vitest restores the original
    // implementations passed to vi.fn(impl) in the mock factories.
    vi.resetAllMocks();
  });

  it("transient rate-limit alert → retryable error; bot is NOT parked", async () => {
    const bot = makeBotRow({
      proxy_endpoint: "10.0.0.1:9000",
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      session_data: null,
      ig_password_encrypted: "enc-ig-pass",
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })   // loadBot
      .mockResolvedValueOnce(undefined);          // UPDATE last_login_error

    mockIsEndpointFresh.mockReturnValue(true);
    mockLoginBotWithRetry.mockRejectedValue(
      new LoginRateLimitedError(
        "[bot-login] IG throttled login for testbot: Please wait a few minutes before you try again.",
      ),
    );

    await expect(ensureBotReady("bot-001")).rejects.toThrow(
      /wait a few minutes/i,
    );

    // Exactly two executes: loadBot + the error-recording UPDATE.
    expect(mockExecute).toHaveBeenCalledTimes(2);
    const updateSql = executedSqlText(1);
    // Error is recorded for observability…
    expect(updateSql).toContain("last_login_error");
    // …but the bot is NOT parked: no status flip, session_data untouched.
    expect(updateSql).not.toContain("status = 'session_expired'");
    expect(updateSql).not.toContain("status = 'banned'");
    expect(updateSql).not.toContain("session_data = NULL");
  });

  it("explicit bad-credentials error → LoginBadCredentialsError; bot IS parked", async () => {
    const bot = makeBotRow({
      proxy_endpoint: "10.0.0.1:9000",
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      session_data: null,
      ig_password_encrypted: "enc-ig-pass",
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })   // loadBot
      .mockResolvedValueOnce(undefined);          // UPDATE park bot

    mockIsEndpointFresh.mockReturnValue(true);
    mockLoginBotWithRetry.mockRejectedValue(
      new LoginBadCredentialsError(
        "[bot-login] IG rejected username/password for testbot (alert: The password you entered is incorrect.)",
      ),
    );

    await expect(ensureBotReady("bot-001")).rejects.toBeInstanceOf(
      LoginBadCredentialsError,
    );

    expect(mockExecute).toHaveBeenCalledTimes(2);
    const updateSql = executedSqlText(1);
    // Genuinely-bad credentials park the bot: session cleared, status
    // flipped so the lease layer skips it until an operator re-credentials.
    expect(updateSql).toContain("status = 'session_expired'");
    expect(updateSql).toContain("session_data = NULL");
    expect(updateSql).toContain("last_login_error");
  });

  it("generic unrecognized login error → recorded but bot NOT parked", async () => {
    const bot = makeBotRow({
      proxy_endpoint: "10.0.0.1:9000",
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      session_data: null,
      ig_password_encrypted: "enc-ig-pass",
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })   // loadBot
      .mockResolvedValueOnce(undefined);          // UPDATE last_login_error

    mockIsEndpointFresh.mockReturnValue(true);
    mockLoginBotWithRetry.mockRejectedValue(
      new Error("[bot-login] IG login alert for testbot: Something went wrong."),
    );

    await expect(ensureBotReady("bot-001")).rejects.toThrow(
      /Something went wrong/,
    );

    expect(mockExecute).toHaveBeenCalledTimes(2);
    const updateSql = executedSqlText(1);
    expect(updateSql).toContain("last_login_error");
    expect(updateSql).not.toContain("status = 'session_expired'");
    expect(updateSql).not.toContain("session_data = NULL");
  });
});

// ---------------------------------------------------------------------------
// Test: B5 — proxy credentials never leak via last_login_error or re-throw
// ---------------------------------------------------------------------------

/**
 * The drizzle `sql` mock returns `[TemplateStringsArray, ...interpolatedValues]`.
 * Join the interpolated values so a test can scan the *bound* parameters (e.g.
 * the `last_login_error` value) for leaked credential substrings.
 */
function executedSqlValues(callIndex: number): string {
  const arg = mockExecute.mock.calls[callIndex]?.[0] as unknown;
  if (!Array.isArray(arg)) return String(arg);
  return arg.slice(1).map((v) => String(v)).join(" || ");
}

describe("ensureBotReady — proxy credentials are redacted on login error (B5)", () => {
  const CRED_ENDPOINT = "gw.example.com:10000:secretuser:secretpass";
  const CRED_URI = "http://secretuser:secretpass@gw.example.com:10000";

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("scrubs the proxy URI from the persisted last_login_error", async () => {
    const bot = makeBotRow({
      proxy_endpoint: CRED_ENDPOINT,
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      session_data: null,
      ig_password_encrypted: "enc-ig-pass",
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] }) // loadBot
      .mockResolvedValueOnce(undefined); // UPDATE last_login_error

    mockIsEndpointFresh.mockReturnValue(true);
    // Simulate an undici connect error that spliced the full credentialed URI
    // into its message (the generic, non-typed error branch).
    mockLoginBotWithRetry.mockRejectedValue(
      new Error(`connect ECONNREFUSED via ${CRED_URI} (proxy tunnel failed)`),
    );

    await expect(ensureBotReady("bot-001")).rejects.toThrow();

    // The bound `last_login_error` value must NOT contain the credentials.
    const persisted = executedSqlValues(1);
    expect(persisted).not.toContain("secretuser");
    expect(persisted).not.toContain("secretpass");
    // The host:port label survives so the error is still diagnosable, and the
    // proxy-transport keyword survives for downstream error classification.
    expect(persisted).toContain("gw.example.com:10000");
    expect(persisted.toLowerCase()).toContain("proxy");
  });

  it("re-throws an error whose message carries no credentials", async () => {
    const bot = makeBotRow({
      proxy_endpoint: CRED_ENDPOINT,
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      session_data: null,
      ig_password_encrypted: "enc-ig-pass",
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })
      .mockResolvedValueOnce(undefined);

    mockIsEndpointFresh.mockReturnValue(true);
    mockLoginBotWithRetry.mockRejectedValue(
      new Error(`socket hang up while connected to ${CRED_URI}`),
    );

    let caught: unknown;
    try {
      await ensureBotReady("bot-001");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).not.toContain("secretuser");
    expect(msg).not.toContain("secretpass");
    expect(msg).toContain("gw.example.com:10000");
  });

  it("does not corrupt clean error messages (no proxy URI present)", async () => {
    const bot = makeBotRow({
      proxy_endpoint: CRED_ENDPOINT,
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      session_data: null,
      ig_password_encrypted: "enc-ig-pass",
    });

    mockExecute
      .mockResolvedValueOnce({ rows: [bot] })
      .mockResolvedValueOnce(undefined);

    mockIsEndpointFresh.mockReturnValue(true);
    mockLoginBotWithRetry.mockRejectedValue(
      new Error("[bot-login] IG login alert: Something went wrong."),
    );

    await expect(ensureBotReady("bot-001")).rejects.toThrow(
      /Something went wrong/,
    );
  });
});

// ---------------------------------------------------------------------------
// Test: invalidateBotSession
// ---------------------------------------------------------------------------

import { invalidateBotSession } from "./bot-runtime.js";

describe("invalidateBotSession", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): also drops unconsumed
    // mockResolvedValueOnce queues so a failing test can't leak stale
    // db.execute results into the next one. Vitest restores the original
    // implementations passed to vi.fn(impl) in the mock factories.
    vi.resetAllMocks();
  });

  it("calls db.update to null out session_data", async () => {
    const dbMod = await import("../db.js");
    const updateMock = dbMod.db.update as ReturnType<typeof vi.fn>;
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn(() => ({ where: whereMock }));
    updateMock.mockReturnValue({ set: setMock });

    await invalidateBotSession("bot-999");

    expect(updateMock).toHaveBeenCalledOnce();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionData: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// Test: automation login failure routing (L3) + relogin of parked bots (L4)
// ---------------------------------------------------------------------------

import {
  LoginAccountSuspendedError,
  LoginCaptchaRequiredError,
  Login2FARequiredButNoSecretError,
} from "./bot-login.js";
import { reloginParkedBot, routeAutomationLoginError } from "./bot-runtime.js";

const AUTOMATION_IDENTITY = {
  identity_version: 1 as const,
  client: "instagram-firefox-web" as const,
  bot_id: "bot-001",
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

/** Bound parameters of the Nth db.execute call (the drizzle sql mock returns [strings, ...values]). */
function executedValues(callIndex: number): unknown[] {
  const arg = mockExecute.mock.calls[callIndex]?.[0] as unknown;
  return Array.isArray(arg) ? arg.slice(1) : [];
}

function parkedWebBot(overrides: Record<string, unknown> = {}) {
  return {
    ...makeBotRow({
      session_data: "v1:stale",
      ig_password_encrypted: "enc-ig-pass",
      proxy_endpoint: "10.0.0.1:9000",
      proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
      automation_identity: AUTOMATION_IDENTITY,
    }),
    totp_secret: "JBSWY3DPEHPK3PXP",
    status: "session_expired",
    tier: "worker",
    transport: "web",
    login_attempt_count: 1,
    cooldown_until: null,
    last_login_error: null,
    recovery_version: "2026-09-25 08:00:00+00",
    ...overrides,
  };
}

describe("routeAutomationLoginError", () => {
  it("routes a suspension to banned (typed or by message)", () => {
    expect(routeAutomationLoginError(new LoginAccountSuspendedError("IG suspended x"))).toBe("banned");
    expect(routeAutomationLoginError(new Error("Your account has been suspended"))).toBe("banned");
  });
  it("routes bad credentials / 2FA-without-secret to session_expired", () => {
    expect(routeAutomationLoginError(new LoginBadCredentialsError("rejected username/password"))).toBe("session_expired");
    expect(routeAutomationLoginError(new Login2FARequiredButNoSecretError("no totp"))).toBe("session_expired");
  });
  it("routes captcha separately and everything else to retry_later", () => {
    expect(routeAutomationLoginError(new LoginCaptchaRequiredError("captcha"))).toBe("captcha");
    expect(routeAutomationLoginError(new Error("navigation: Page.goto: Timeout 60000ms exceeded"))).toBe("retry_later");
    expect(routeAutomationLoginError(new Error("did not receive an Instagram verification code"))).toBe("retry_later");
    expect(routeAutomationLoginError(new LoginRateLimitedError("rate limited"))).toBe("retry_later");
  });
});

describe("reloginParkedBot", () => {
  let row: ReturnType<typeof parkedWebBot>;
  const authenticated = { status: "authenticated", storage_state: { cookies: [], origins: [] } };
  const updateCalls = () => mockExecute.mock.calls
    .map((_call, index) => ({ text: executedSqlText(index), values: executedValues(index) }))
    .filter((call) => /UPDATE bot_accounts/.test(call.text));

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("BOT_AUTO_LOGIN_ENABLED", "true");
    recoveryMocks.activeKeys.clear();
    recoveryMocks.transactionDepth = 0;
    row = parkedWebBot();
    mockExecute.mockImplementation(async () => ({ rows: [structuredClone(row)] }));
    mockIsEndpointFresh.mockReturnValue(true);
    automationClientMocks.startInstagramLogin.mockImplementation(async () => {
      expect(recoveryMocks.activeKeys.has("bot:bot-001")).toBe(true);
      expect(recoveryMocks.transactionDepth).toBe(0);
      return authenticated;
    });
  });

  it.each(["available", "in_use", "banned", "disabled"])("preserves a %s bot without network calls", async (status) => {
    row.status = status;
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(updateCalls()).toEqual([]);
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
  });

  it.each(["mobile", null, "unknown"])("does not attempt password recovery for transport %s", async (transport) => {
    Object.assign(row, { transport });
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(updateCalls()).toEqual([]);
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
  });

  it.each(["reserve", "retired", "scraper", null])("skips a candidate moved to tier %s before the first owned read", async (tier) => {
    vi.mocked(withOperationLease).mockImplementationOnce(async (_key, work) => {
      Object.assign(row, { tier });
      return work(new AbortController().signal, { assertOwned: recoveryMocks.assertOwned });
    });
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(updateCalls()).toEqual([]);
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
  });

  it("continues to recover eligible canary bots under the shared lease", async () => {
    row.tier = "canary";
    await expect(reloginParkedBot("bot-001")).resolves.toBe("recovered");
    expect(automationClientMocks.startInstagramLogin).toHaveBeenCalledOnce();
    expect(recoveryMocks.assertOwned).toHaveBeenCalledOnce();
  });

  it.each([null, "", "   "])("skips missing or empty credentials before proxy allocation (%s)", async (password) => {
    row.ig_password_encrypted = password;
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(updateCalls()).toEqual([]);
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
  });

  it.each([
    "IG suspended this account", "incorrect password", "IG rejected username/password",
    "bad_credentials", "bad credentials", "invalid password", "account disabled",
    "requires CAPTCHA", "checkpoint_required", "interactive challenge required",
  ])("does not retry an intervention-required verdict: %s", async (reason) => {
    Object.assign(row, { last_login_error: reason, cooldown_until: new Date(0) });
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(updateCalls()).toEqual([]);
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
  });

  it.each([new Date(Date.now() + 3_600_000), "not-a-date"])("respects current or unreadable cooldown %s", async (cooldown) => {
    Object.assign(row, { cooldown_until: cooldown });
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(updateCalls()).toEqual([]);
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
  });

  it("reads current eligibility only after taking the shared bot lease", async () => {
    vi.mocked(withOperationLease).mockImplementationOnce(async (_key, work) => {
      row.status = "banned";
      return work(new AbortController().signal, { assertOwned: recoveryMocks.assertOwned });
    });
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(withOperationLease).toHaveBeenCalledWith("bot:bot-001", expect.any(Function));
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
    expect(updateCalls()).toEqual([]);
  });

  it("does no database or network work when another bot operation owns the lease", async () => {
    recoveryMocks.activeKeys.add("bot:bot-001");
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
  });

  it("defers an unavailable proxy without spending an authentication attempt", async () => {
    row.proxy_endpoint = null;
    row.proxy_expires_at = null;
    mockIsEndpointFresh.mockReturnValue(false);
    mockFetchHealthyEndpoints.mockResolvedValue([]);
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
    const [update] = updateCalls();
    expect(updateCalls()).toHaveLength(1);
    expect(update.text).toContain("cooldown_until");
    expect(update.text).toContain("updated_at = NOW()");
    expect(update.text).not.toMatch(/login_attempt_count|session_data|status =/);
    expect(recoveryMocks.assertOwned).toHaveBeenCalledOnce();
  });

  it("defers malformed automation identities so they cannot monopolise the oldest batch", async () => {
    row.automation_identity = { invalid: true };
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0].text).toContain("cooldown_until");
    expect(mockFetchHealthyEndpoints).not.toHaveBeenCalled();
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
  });

  it("recovers with ownership-fenced persistence and no transaction around login", async () => {
    await expect(reloginParkedBot("bot-001")).resolves.toBe("recovered");
    expect(automationClientMocks.startInstagramLogin).toHaveBeenCalledOnce();
    expect(mockLoginBotWithRetry).not.toHaveBeenCalled();
    expect(recoveryMocks.assertOwned).toHaveBeenCalledOnce();
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0].text).toContain("status = 'available'");
    expect(updateCalls()[0].text).toContain("last_login_error = NULL");
    expect(updateCalls()[0].text).toContain("consecutive_hard_failures = 0");
    expect(updateCalls()[0].text).toContain("last_hard_failure_at = NULL");
    expect(updateCalls()[0].text).toContain("warm_failure_streak = 0");
    expect(updateCalls()[0].text).toContain("CASE WHEN cooldown_until <= NOW() THEN NULL ELSE cooldown_until END");
    expect(updateCalls()[0].text).toContain("login_attempt_count = login_attempt_count + 1");
    expect(updateCalls()[0].text).not.toMatch(/daily_budget|requests_today|daily_limit/);
    expect(recoveryMocks.transactionDepth).toBe(0);
  });

  it("rechecks cooldown after proxy setup and before submitting credentials", async () => {
    mockIsEndpointFresh.mockImplementation(() => {
      Object.assign(row, { cooldown_until: new Date(Date.now() + 60_000) });
      return true;
    });
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
    expect(updateCalls()).toEqual([]);
  });

  it.each([
    { status: "available", session_data: "v1:replacement" },
    { status: "disabled" },
    { tier: "retired" },
    { cooldown_until: new Date(Date.now() + 60_000) },
    { ig_password_encrypted: "enc-replacement-password" },
    { recovery_version: "2026-09-25 08:01:00+00" },
  ])("never overwrites a concurrent row change after successful login: %j", async (change) => {
    automationClientMocks.startInstagramLogin.mockImplementation(async () => {
      Object.assign(row, change);
      return authenticated;
    });
    await expect(reloginParkedBot("bot-001")).rejects.toThrow("could not be persisted safely");
    expect(updateCalls()).toEqual([]);
  });

  it("does not persist a stale failure over an operator's replacement session", async () => {
    automationClientMocks.startInstagramLogin.mockImplementation(async () => {
      Object.assign(row, { status: "available", session_data: "v1:replacement" });
      return { status: "suspended" };
    });
    await expect(reloginParkedBot("bot-001")).rejects.toThrow("could not be persisted safely");
    expect(updateCalls()).toEqual([]);
  });

  it("does not overwrite a newer row with a proxy allocated during an operator change", async () => {
    row.proxy_endpoint = null;
    mockIsEndpointFresh.mockReturnValue(false);
    mockFetchHealthyEndpoints.mockImplementation(async () => {
      Object.assign(row, { status: "available", session_data: "v1:replacement" });
      return [FRESH_PROXY_ENDPOINT];
    });
    await expect(reloginParkedBot("bot-001")).resolves.toBe("skipped");
    expect(updateCalls()).toEqual([]);
    expect(automationClientMocks.startInstagramLogin).not.toHaveBeenCalled();
  });

  it("refuses all success/error writes when persistence ownership is lost", async () => {
    recoveryMocks.assertOwned.mockRejectedValueOnce(new Error("execution lease lost"));
    await expect(reloginParkedBot("bot-001")).rejects.toThrow("could not be persisted safely");
    expect(updateCalls()).toEqual([]);
    expect(recoveryMocks.assertOwned).toHaveBeenCalledOnce();
  });

  it("does not save a response after the bot lease is aborted", async () => {
    const controller = new AbortController();
    vi.mocked(withOperationLease).mockImplementationOnce(async (_key, work) =>
      work(controller.signal, { assertOwned: recoveryMocks.assertOwned }));
    automationClientMocks.startInstagramLogin.mockImplementation(async () => {
      controller.abort(new Error("execution lease renewal failed"));
      return authenticated;
    });
    recoveryMocks.assertOwned.mockImplementation(async () => controller.signal.throwIfAborted());
    await expect(reloginParkedBot("bot-001")).rejects.toThrow("execution lease renewal failed");
    expect(updateCalls()).toEqual([]);
  });

  it("records a newly observed suspension under the same row and lease ownership", async () => {
    automationClientMocks.startInstagramLogin.mockResolvedValue({ status: "suspended" });
    await expect(reloginParkedBot("bot-001")).resolves.toBe("failed");
    const [update] = updateCalls();
    expect(update.text).toContain("status = 'banned'");
    expect(update.text).toContain("session_data = NULL");
    expect(recoveryMocks.assertOwned).toHaveBeenCalledOnce();
  });

  it("parks newly rejected credentials without treating them as a timed retry", async () => {
    automationClientMocks.startInstagramLogin.mockResolvedValue({ status: "bad_credentials" });
    await expect(reloginParkedBot("bot-001")).resolves.toBe("failed");
    const [update] = updateCalls();
    expect(update.text).toContain("status = 'session_expired'");
    expect(update.text).not.toContain("cooldown_until = ");
  });

  it("preserves geometric backoff for a genuine transport failure", async () => {
    row.login_attempt_count = 2;
    automationClientMocks.startInstagramLogin.mockRejectedValue(new Error("navigation: Page.goto: Timeout"));
    const before = Date.now();
    await expect(reloginParkedBot("bot-001")).resolves.toBe("failed");
    const [update] = updateCalls();
    expect(update.text).not.toContain("status =");
    expect(update.values).toContainEqual(expect.stringContaining("cooldown: login retry:"));
    const until = update.values.find((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) as string;
    expect(new Date(until).getTime() - before).toBeGreaterThanOrEqual(8 * 60 * 60 * 1000 - 5_000);
    expect(new Date(until).getTime() - before).toBeLessThanOrEqual(8 * 60 * 60 * 1000 + 5_000);
  });

  it("retains the 24-hour hold when a first attempt encounters CAPTCHA", async () => {
    row.login_attempt_count = 0;
    automationClientMocks.startInstagramLogin.mockResolvedValue({ status: "captcha_required" });
    const before = Date.now();
    await expect(reloginParkedBot("bot-001")).resolves.toBe("failed");
    const [update] = updateCalls();
    expect(update.text).toContain("status = 'session_expired'");
    const until = update.values.find((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) as string;
    expect(new Date(until).getTime() - before).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5_000);
  });
});

describe("ensureBotReady — automation login failure routing (L3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsEndpointFresh.mockReturnValue(true);
  });

  it("a proxy/navigation failure no longer parks the bot as session_expired", async () => {
    const bot = {
      ...makeBotRow({
        session_data: null,
        proxy_endpoint: "10.0.0.1:9000",
        proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
        automation_identity: AUTOMATION_IDENTITY,
      }),
      status: "available",
      transport: "web",
      login_attempt_count: 0,
    };
    mockExecute.mockResolvedValueOnce({ rows: [bot] }).mockResolvedValueOnce(undefined);
    automationClientMocks.startInstagramLogin.mockRejectedValue(new Error("navigation: Page.goto: Timeout"));

    await expect(ensureBotReady("bot-001")).rejects.toThrow(/Timeout/);
    const updateSql = executedSqlText(1);
    expect(updateSql).not.toContain("status = 'session_expired'");
    expect(updateSql).toContain("cooldown_until = ");
  });

  it("a suspension during auto-login parks the bot as banned, like the legacy path", async () => {
    const bot = {
      ...makeBotRow({
        session_data: null,
        proxy_endpoint: "10.0.0.1:9000",
        proxy_expires_at: new Date(Date.now() + 20 * 60 * 1000),
        automation_identity: AUTOMATION_IDENTITY,
      }),
      status: "available",
      transport: "web",
    };
    mockExecute.mockResolvedValueOnce({ rows: [bot] }).mockResolvedValueOnce(undefined);
    automationClientMocks.startInstagramLogin.mockResolvedValue({ status: "suspended", message: "x" });

    await expect(ensureBotReady("bot-001")).rejects.toThrow();
    expect(executedSqlText(1)).toContain("status = 'banned'");
  });
});
