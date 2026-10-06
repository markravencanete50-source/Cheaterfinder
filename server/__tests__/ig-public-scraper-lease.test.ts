// Unit tests for ig-public-scraper bot-pinned reliability fixes:
//
//   B3  — leaseSpecificBot: FOR UPDATE SKIP LOCKED on a FIXED bot id used to
//         throw "not found or already locked" the instant the row was held
//         by a concurrent lease's millisecond-scale lastUsedAt-touch
//         transaction. It now retries (bounded, jittered) before failing,
//         and distinguishes "row missing" (fail fast, no retries) from
//         "row locked" (retry, then a clear 'locked' error).
//
//   B13 — scrapeFollowListWithBot: the pinned multi-page follow walk used to
//         reserve ONE daily-budget unit for the whole walk while the LRU
//         paginator path burns one unit per page. It now reserves one unit
//         per page (page 1 at lease time via reserveOrThrow, pages 2+ via
//         checkAndIncrementBudget inside the walk) and, when the budget runs
//         out mid-walk, stops and throws so public-data-service surfaces
//         { ok: false } — the existing incomplete-capture handling — instead
//         of an ok-"complete" partial roster.
//
// Approach: mock every side-effecting dependency of ig-public-scraper.ts
// (db, bot-runtime, transports, strikes, budget, metrics, logger) following
// the established pattern in server/services/__tests__/. The drizzle query
// builders run for real but every produced clause lands in a hand-written
// db mock that is driven per-test via `dbState`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
vi.stubEnv("BOT_READ_WARMUP_ENABLED", "true");
const { trackedAccountHasAccess } = vi.hoisted(() => ({ trackedAccountHasAccess: vi.fn(async () => true) }));
vi.mock("../services/subscription-access.js", () => ({ trackedAccountHasAccess }));
const leaseState = vi.hoisted(() => ({ key: null as string | null }));
vi.mock("../services/operation-lease.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/operation-lease.js")>(),
  withOperationLease: vi.fn(async (key: string, work: (signal: AbortSignal) => Promise<unknown>) => {
    const previous = leaseState.key;
    leaseState.key = key;
    try { return await work(new AbortController().signal); }
    finally { leaseState.key = previous; }
  }),
}));
vi.mock("../services/scrape-capacity.js", () => ({ recordLeaseUnavailable: vi.fn() }));
const { persistRefreshedWebSession } = vi.hoisted(() => ({ persistRefreshedWebSession: vi.fn(async () => true) }));
vi.mock('../services/web-session-refresh.js', () => ({ persistRefreshedWebSession }));

// ── Logger ──────────────────────────────────────────────────────────────────

vi.mock("../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ── In-memory db state (driven per-test) ────────────────────────────────────

const dbState = vi.hoisted(() => ({
  /** Sequential results for db.transaction(); the LAST entry repeats. */
  txResults: [] as Array<Record<string, unknown> | null>,
  txCalls: 0,
  /** Rows returned by the lock-free existence probe select(...).limit(). */
  existsRows: [] as Array<{ id: string }>,
  /** Every `.set(values)` handed to db.update(), in call order. */
  updateSets: [] as Array<Record<string, unknown>>,
  reset(): void {
    dbState.txResults = [];
    dbState.txCalls = 0;
    dbState.existsRows = [];
    dbState.updateSets = [];
  },
}));

vi.mock("../db.js", () => {
  function makeSelectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = async () => dbState.existsRows;
    return chain;
  }
  function makeUpdateChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.set = (values: Record<string, unknown>) => {
      dbState.updateSets.push(values);
      return chain;
    };
    chain.where = () => Promise.resolve([]);
    return chain;
  }
  return {
    db: {
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        const idx = dbState.txCalls++;
        const row = dbState.txResults[Math.min(idx, dbState.txResults.length - 1)] ?? null;
        const query: Record<string, unknown> = {};
        for (const method of ["from", "where", "orderBy", "limit"]) query[method] = () => query;
        query.for = async () => row ? [row] : [];
        return work({ select: () => query, update: () => makeUpdateChain() });
      },
      select: () => makeSelectChain(),
      update: () => makeUpdateChain(),
    },
  };
});

// ── Crypto / fingerprint / proxy label ──────────────────────────────────────

vi.mock("../crypto/session-envelope.js", () => ({
  decryptSessionData: vi.fn(() => "decrypted-session"),
}));

vi.mock("../behavior/device-fingerprint.js", () => ({
  resolveFingerprint: vi.fn(() => ({ deviceId: "test-device" })),
}));

vi.mock("../services/proxy-provider.js", () => ({
  proxyEndpointLabel: vi.fn((x: string | null) => x ?? "none"),
}));

// ── Bot runtime (lease post-step; dynamic import in the source) ─────────────

const { ensureBotReady, invalidateObservedBotSession } = vi.hoisted(() => ({
  ensureBotReady: vi.fn(async (_botId: string) => ({
    sessionData: "ready-session",
    proxyEndpoint: "gw.example:10000",
    automationIdentity: null,
    transport: "web" as const,
  })),
  invalidateObservedBotSession: vi.fn(async (_botId: string, _observedSession: string) => true),
}));

vi.mock("../services/bot-runtime.js", () => ({
  isBotAutoLoginEnabled: vi.fn(() => false),
  ensureBotReady,
  invalidateObservedBotSession,
}));

// ── Transports ──────────────────────────────────────────────────────────────

const { fakeClient, createHttpBotClientWithFingerprint } = vi.hoisted(() => {
  const fakeClient = {
    fetchProfile: vi.fn(),
    fetchProfileById: vi.fn(),
    fetchFriendshipStatus: vi.fn(),
    fetchUserFeed: vi.fn(),
    fetchRaw: vi.fn(),
    fetchUserClips: vi.fn(),
    fetchUserTagged: vi.fn(),
    fetchFollowing: vi.fn(),
    fetchFollowers: vi.fn(),
    sendFollow: vi.fn(),
    fetchStoriesTray: vi.fn(),
    fetchHighlightsTray: vi.fn(),
    fetchHighlightReels: vi.fn(),
    fetchMediaComments: vi.fn(),
    fetchMediaLikers: vi.fn(),
    close: vi.fn(async () => {}),
  };
  return {
    fakeClient,
    createHttpBotClientWithFingerprint: vi.fn(() => fakeClient),
  };
});

vi.mock("../ig-http-client.js", () => ({
  createHttpBotClientWithFingerprint,
  IGAuthExpiredError: class IGAuthExpiredError extends Error {
    status = 0;
    body?: string;
  },
  IGHttpError: class IGHttpError extends Error {
    status = 0;
    igErrorCode?: string;
    body?: string;
    url?: string;
  },
  IGRateLimitedError: class IGRateLimitedError extends Error {
    retryAfterMs = 0;
  },
}));

vi.mock("../services/native-browser-read-client.js", () => ({ createNativeBrowserReadClient: vi.fn() }));
import { createNativeBrowserReadClient } from "../services/native-browser-read-client.js";
vi.mock("../ig-browser-read-client.js", () => ({
  createBrowserReadClient: vi.fn(),
}));
vi.mock('../ig-mobile-read-client.js',()=>({createMobileReadClient:vi.fn(()=>fakeClient)}));

vi.mock("../services/scraper-transport-config.js", () => ({
  // "http" → plain HTTP client (the mocked fakeClient above), no browser.
  getScraperReadTransport: vi.fn(async () => ({ value: "http" })),
}));

// ── Cooldown / metrics / strikes / budget ───────────────────────────────────

const cooldownMocks = vi.hoisted(() => ({
  cooldownBotForCheckpoint: vi.fn(async () => {}),
  cooldownBotForRateLimit: vi.fn(async () => {}),
  recordHardFailure: vi.fn(async () => 1),
  resetHardFailureStreak: vi.fn(async () => {}),
  applyHardFailureEscalation: vi.fn(async () => ({
    cooldownHours: null,
    markSessionExpired: false,
  })),
}));

vi.mock("../services/bot-cooldown.js", () => ({
  ...cooldownMocks,
  formatCooldownReason: (reason: string) =>
    reason.startsWith("cooldown: ") ? reason : `cooldown: ${reason}`,
  BAN_REASON_SQL_REGEX: "auth rejected|checkpoint|required|suspended",
  COOLDOWN_REASON_PREFIX: "cooldown: ",
}));

vi.mock("../services/scrape-metrics.js", () => ({
  recordOutcome: vi.fn(),
}));

const { getActiveDisabled, recordStrike, recordSuccess } = vi.hoisted(() => ({
  getActiveDisabled: vi.fn(async () => null),
  recordStrike: vi.fn(async () => {}),
  recordSuccess: vi.fn(async () => {}),
}));

vi.mock("../services/endpoint-strikes.js", () => ({
  EndpointDisabledError: class EndpointDisabledError extends Error {
    constructor(endpoint: string, until: Date, reason: string | null) {
      super(`endpoint "${endpoint}" disabled until ${until.toISOString()}${reason ? ` (${reason})` : ""}`);
      this.name = "EndpointDisabledError";
    }
  },
  getActiveDisabled,
  recordStrike,
  recordSuccess,
}));

const { reserveOrThrow, checkAndIncrementBudget } = vi.hoisted(() => ({
  reserveOrThrow: vi.fn(async () => ({
    allowed: true,
    used: 1,
    cap: 100,
    endpoint: "followers",
  })),
  checkAndIncrementBudget: vi.fn(async () => ({
    allowed: true,
    used: 2,
    cap: 100,
    endpoint: "followers",
  })),
}));

// The pure schedule helpers (endpointDailyCap / normalizeEndpoint / BUDGET_TABLE)
// run for real: the lease-query builder derives its SQL budget bound from them.
vi.mock("../behavior/daily-budget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../behavior/daily-budget.js")>()),
  reserveOrThrow,
  checkAndIncrementBudget,
}));

// ── Module under test (after all mocks) ─────────────────────────────────────

import { drizzle } from "drizzle-orm/node-postgres";
import { BUDGET_TABLE, READ_DAILY_CAPS, endpointDailyCap } from "../behavior/daily-budget.js";
import { createBrowserReadClient } from "../ig-browser-read-client.js";
import { createMobileReadClient } from '../ig-mobile-read-client.js';
import { getScraperReadTransport } from "../services/scraper-transport-config.js";
import { withScrapeContext } from "../services/bandwidth-meter.js";
import { withOperationSignal } from "../services/operation-context.js";
import { currentScrapeOperation, withScrapeOperation } from '../services/scrape-operation.js';
import {
  IGLoginWallError,
  PRODUCTION_LEASE_LABELS,
  buildLeaseCandidateQuery,
  maxEndpointDailyCap,
  scrapeMediaLikersWithBot,
  scrapeMediaCommentsWithBot,
  scrapeUserFollowersWithBot,
  scrapeUserFollowersCaptureWithBot,
  scrapeProfileWithBot,
  scrapeFriendshipStatusWithBot,
  probePinnedBotCooldown,
  selectCooldownProbeCandidate,
  scrapeUserPostsPageWithBot,
  scrapeUserPosts,
  scrapeUserClips,
  scrapeUserTagged,
  scrapeUserStoriesWithBot,
  scrapeUserHighlightsWithBot,
  getFreshMediaThumbnailWithBot,
  getFreshMediaDetailsWithBot,
  isIgWebThrottleBody, isBrowserLaneFault } from "../ig-public-scraper.js";

// IG's transient web-session throttle arrives as HTTP 401 with a LOCALIZED
// message. Classifying it as a permanent "auth rejected" auth-death locked 65
// bots out of the lease pool for good and collapsed the pool to zero, so the
// detector must key off the language-independent JSON shape.
describe("isIgWebThrottleBody — transient IG web throttle detection", () => {
  const shape = (message: string) =>
    `{"message":"${message}","require_login":true,"igweb_rollout":true,"status":"fail"}`;

  it("detects the throttle across every locale our bots run under", () => {
    // Real bodies observed in production (en/de/es/fr/ur).
    const bodies = [
      shape("Please wait a few minutes before you try again."),
      shape("Bitte warte einige Minuten und versuche es dann noch einmal."),
      shape("Espera unos minutos antes de volver a intentarlo."),
      shape("Veuillez patienter quelques minutes avant de réessayer."),
      shape("براہ کرم دوبارہ کوشش کرنے سے قبل چند منٹ انتظار کریں۔"),
    ];
    for (const body of bodies) {
      expect(isIgWebThrottleBody(body)).toBe(true);
    }
  });

  it("does NOT match a genuine auth death or unrelated bodies", () => {
    expect(isIgWebThrottleBody("")).toBe(false);
    expect(
      isIgWebThrottleBody('{"message":"checkpoint_required","status":"fail"}'),
    ).toBe(false);
    // require_login alone (no igweb_rollout) is not the throttle shape.
    expect(
      isIgWebThrottleBody('{"message":"login_required","require_login":true}'),
    ).toBe(false);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const BOT_ID = "bot-1";

const botRow = {
  id: BOT_ID,
  igUsername: "pinned_bot",
  sessionData: "enc",
  proxyEndpoint: "gw.example:10000",
  tier: "worker",
  status: "available",
  transport: "web",
  role: "scraper",
  automationIdentity: {
    identity_version: 1, client: "instagram-firefox-web", browser_family: "firefox",
    platform: "Windows", browser_seed: 123, bot_id: BOT_ID, browser_version: "128",
    user_agent: "test-agent", http_impersonate: "firefox", ja3: "test-ja3",
    h2_fingerprint: "test-h2", locale: "en-US", timezone: "UTC",
  },
  proxyUrl: null,
  proxyExpiresAt: new Date("2099-01-01T00:00:00Z"),
  cooldownUntil: null,
  lastLoginError: null,
  lastLoginAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

interface RawFollowUser {
  pk: string;
  username: string;
  fullName: string;
  profilePicUrl: string;
  isPrivate: boolean;
  isVerified: boolean;
}

function buildRawUsers(count: number, prefix: string): RawFollowUser[] {
  return Array.from({ length: count }, (_, i) => ({
    pk: `${prefix}-${i}`,
    username: `${prefix}_user_${i}`,
    fullName: `User ${prefix} ${i}`,
    profilePicUrl: "",
    isPrivate: false,
    isVerified: false,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  trackedAccountHasAccess.mockResolvedValue(true);
  vi.stubEnv('PINNED_WEB_MOBILE_READS_ENABLED','false');
  vi.stubEnv('IG_MEDIA_BROWSER_FALLBACK_ENABLED','false');
  dbState.reset();
  // Default: lease succeeds on the first attempt.
  dbState.txResults = [botRow];
  dbState.existsRows = [{ id: BOT_ID }];
  fakeClient.fetchMediaLikers.mockResolvedValue({
    users: buildRawUsers(3, "liker"),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('successful read session persistence', () => {
  beforeEach(() => {
    vi.mocked(getScraperReadTransport).mockResolvedValue({ value: 'http' } as never);
    fakeClient.fetchStoriesTray.mockReset();
    createHttpBotClientWithFingerprint.mockReturnValueOnce({ ...fakeClient,
      exportSessionData: () => 'refreshed-state',
    } as never);
  });
  it('saves a refreshed web session while the operation lease is still held', async () => {
    fakeClient.fetchStoriesTray.mockResolvedValue({ items: [] });
    persistRefreshedWebSession.mockImplementationOnce(async () => {
      expect(leaseState.key).toBe(`bot:${BOT_ID}`);
      expect(fakeClient.close).not.toHaveBeenCalled();
      return true;
    });
    await expect(scrapeUserStoriesWithBot(BOT_ID, '123')).resolves.toEqual([]);
    expect(persistRefreshedWebSession).toHaveBeenCalledExactlyOnceWith(BOT_ID, 'ready-session', 'refreshed-state');
  });
  it('never persists a failed provider response as a refreshed session', async () => {
    const error = new MockHttpError('upstream outage'); error.status = 500;
    fakeClient.fetchStoriesTray.mockRejectedValue(error);
    await expect(scrapeUserStoriesWithBot(BOT_ID, '123')).rejects.toThrow();
    expect(persistRefreshedWebSession).not.toHaveBeenCalled();
  });
  it('keeps a valid read usable when storing its cookie refresh fails', async () => {
    fakeClient.fetchStoriesTray.mockResolvedValue({ items: [] });
    persistRefreshedWebSession.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(scrapeUserStoriesWithBot(BOT_ID, '123')).resolves.toEqual([]);
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });
  it('keeps cookie continuity through the HTTP-first browser composite too', async () => {
    vi.mocked(getScraperReadTransport).mockResolvedValue({ value: 'http-first' } as never);
    vi.mocked(createBrowserReadClient).mockResolvedValueOnce({ ...fakeClient,
      exportSessionData: () => 'browser-refreshed-state',
      fetchStoriesTray: vi.fn().mockResolvedValue({ items: [] }),
    } as never);
    await expect(scrapeUserStoriesWithBot(BOT_ID, '123')).resolves.toEqual([]);
    expect(createBrowserReadClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionData: 'refreshed-state' }));
    expect(persistRefreshedWebSession).toHaveBeenCalledExactlyOnceWith(BOT_ID, 'ready-session', 'browser-refreshed-state');
  });
});

describe('HTTP-first highlights homepage recovery', () => {
  const homepageError = (changes: Record<string, unknown> = {}) => {
    const error = new MockHttpError('response not JSON for GET highlights');
    Object.assign(error, { status: 200, responseDiagnostics: {
      responseUrlClass: 'instagram_home', responseRedirected: true,
      contentType: 'html', titleClass: 'instagram', responseBytes: 2048,
    }, ...changes });
    return error;
  };
  beforeEach(() => {
    vi.mocked(getScraperReadTransport).mockResolvedValue({ value: 'http-first' } as never);
    vi.stubEnv('IG_MEDIA_BROWSER_FALLBACK_ENABLED', 'false');
    fakeClient.fetchHighlightsTray.mockReset();
    fakeClient.fetchHighlightReels.mockReset();
  });

  it('uses the active HTTP-first path with one viewer, lease and additional native-read budget', async () => {
    fakeClient.fetchHighlightsTray.mockRejectedValue(homepageError());
    createHttpBotClientWithFingerprint.mockReturnValueOnce({ ...fakeClient,
      exportSessionData: () => 'same-viewer-current-cookies',
    } as never);
    const read = vi.fn(async () => {
      expect(leaseState.key).toBe(`bot:${BOT_ID}`);
      expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, 'highlights'], [BOT_ID, 'highlights']]);
      return { items: [{ id: 'highlight:1', title: 'Fixture', coverUrl: null, mediaCount: 1 }] };
    });
    vi.mocked(createNativeBrowserReadClient).mockReturnValueOnce({ ...fakeClient,
      fetchHighlightsTray: read, exportSessionData: () => 'native-current-cookies',
    } as never);
    await expect(scrapeUserHighlightsWithBot(BOT_ID, '123')).resolves.toMatchObject([{ highlightId: 'highlight:1' }]);
    expect(fakeClient.fetchHighlightsTray).toHaveBeenCalledExactlyOnceWith('123');
    expect(read).toHaveBeenCalledExactlyOnceWith('123');
    expect(createNativeBrowserReadClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      viewer: expect.objectContaining({ id: BOT_ID, sessionData: 'same-viewer-current-cookies', proxyEndpoint: 'gw.example:10000' }),
    }));
    expect(createBrowserReadClient).not.toHaveBeenCalled();
    expect(dbState.txCalls).toBe(1);
    expect(invalidateObservedBotSession).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401 }, { status: 429 }, { status: 0 },
    { igErrorCode: 'challenge_required' },
    { responseDiagnostics: { responseUrlClass: 'login', responseRedirected: true, contentType: 'html', titleClass: 'instagram' } },
    { responseDiagnostics: { responseUrlClass: 'external', responseRedirected: true, contentType: 'html', titleClass: 'instagram' } },
    { responseDiagnostics: { responseUrlClass: 'unknown', responseRedirected: true, contentType: 'html', titleClass: 'instagram' } },
  ])('keeps refused or unverified responses out of native fallback: %j', async change => {
    fakeClient.fetchHighlightsTray.mockRejectedValue(homepageError(change));
    await expect(scrapeUserHighlightsWithBot(BOT_ID, '123')).rejects.toThrow();
    expect(createNativeBrowserReadClient).not.toHaveBeenCalled();
    expect(createBrowserReadClient).not.toHaveBeenCalled();
    expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, 'highlights']]);
  });

  it('respects the operation attempt limit before a homepage fallback launches', async () => {
    fakeClient.fetchHighlightsTray.mockRejectedValue(homepageError());
    await expect(withScrapeOperation(async () => {
      currentScrapeOperation()!.maxAttempts = 1;
      return scrapeUserHighlightsWithBot(BOT_ID, '123');
    })).rejects.toThrow();
    expect(fakeClient.fetchHighlightsTray).toHaveBeenCalledOnce();
    expect(createNativeBrowserReadClient).not.toHaveBeenCalled();
    expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, 'highlights']]);
  });
});

describe('HTTP media 5xx browser fallback under the same operation lease', () => {
  beforeEach(() => {
    vi.stubEnv('IG_MEDIA_BROWSER_FALLBACK_ENABLED', 'true');
    vi.mocked(getScraperReadTransport).mockResolvedValue({ value: 'http' } as never);
    fakeClient.fetchStoriesTray.mockReset();
    fakeClient.fetchHighlightsTray.mockReset();
    fakeClient.fetchHighlightReels.mockReset();
  });

  it('uses the same bot/session/proxy and reserves the second story request before the browser read', async () => {
    const error = new MockHttpError('upstream outage'); error.status = 500;
    fakeClient.fetchStoriesTray.mockRejectedValue(error);
    const browserStories = vi.fn(async () => {
      expect(leaseState.key).toBe(`bot:${BOT_ID}`);
      expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, 'stories'], [BOT_ID, 'stories']]);
      return { items: [{ id: 'story-1', mediaType: 1, imageUrl: 'https://example.test/story.jpg', takenAt: 1, expiringAt: 2 }] };
    });
    const browserClose = vi.fn(async () => {});
    vi.mocked(createNativeBrowserReadClient).mockReturnValueOnce({ ...fakeClient, fetchStoriesTray: browserStories, close: browserClose } as never);
    await expect(scrapeUserStoriesWithBot(BOT_ID, '123')).resolves.toMatchObject([{ storyId: 'story-1', mediaUrl: 'https://example.test/story.jpg' }]);
    expect(createNativeBrowserReadClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      viewer: expect.objectContaining({ id: BOT_ID, sessionData: 'ready-session', proxyEndpoint: 'gw.example:10000' }),
    }));
    expect(browserStories).toHaveBeenCalledExactlyOnceWith('123');
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(dbState.txCalls).toBe(1);
    expect(invalidateObservedBotSession).not.toHaveBeenCalled();
  });

  it('hands the refreshed cookie jar to the browser instead of the original database snapshot', async () => {
    const error = new MockHttpError('upstream outage'); error.status = 500;
    fakeClient.fetchStoriesTray.mockRejectedValue(error);
    createHttpBotClientWithFingerprint.mockReturnValueOnce({ ...fakeClient,
      exportSessionData: () => 'same-viewer-refreshed-cookies',
    } as never);
    vi.mocked(createNativeBrowserReadClient).mockReturnValueOnce({ ...fakeClient,
      fetchStoriesTray: vi.fn().mockResolvedValue({ items: [] }),
    });
    await expect(scrapeUserStoriesWithBot(BOT_ID, '123')).resolves.toEqual([]);
    expect(createNativeBrowserReadClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      viewer: expect.objectContaining({ id: BOT_ID, sessionData: 'same-viewer-refreshed-cookies', proxyEndpoint: 'gw.example:10000' }),
    }));
  });

  it('falls back for the highlight tray and media while retaining one browser client', async () => {
    const error = new MockHttpError('upstream outage'); error.status = 503;
    fakeClient.fetchHighlightsTray.mockRejectedValue(error);
    fakeClient.fetchHighlightReels.mockRejectedValue(error);
    const browser = {
      ...fakeClient,
      fetchHighlightsTray: vi.fn().mockResolvedValue({ items: [{ id: 'highlight:1', title: 'Saved', coverUrl: null, mediaCount: 1 }] }),
      fetchHighlightReels: vi.fn().mockResolvedValue([{ id: 'highlight:1', items: [{ id: 'story-1', mediaType: 1, imageUrl: 'https://example.test/story.jpg', takenAt: 1, expiringAt: 2 }] }]),
      close: vi.fn(async () => {}),
    };
    vi.mocked(createNativeBrowserReadClient).mockReturnValueOnce(browser as never);
    await expect(scrapeUserHighlightsWithBot(BOT_ID, '123', { withItems: true })).resolves.toMatchObject([
      { highlightId: 'highlight:1', items: [{ storyId: 'story-1' }] },
    ]);
    expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, 'highlights'], [BOT_ID, 'highlights'], [BOT_ID, 'highlights']]);
    expect(createNativeBrowserReadClient).toHaveBeenCalledTimes(1);
    expect(browser.fetchHighlightReels).toHaveBeenCalledExactlyOnceWith(['highlight:1']);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(dbState.txCalls).toBe(1);
  });

  it('surfaces native UI cursor rejection without dropping the requested page or switching viewer', async () => {
    const error = new MockHttpError('upstream outage'); error.status = 500;
    fakeClient.fetchUserFeed.mockRejectedValueOnce(error);
    const feed = vi.fn().mockRejectedValue(new Error('Native browser UI does not support API pagination cursors'));
    vi.mocked(createNativeBrowserReadClient).mockReturnValueOnce({ ...fakeClient, fetchUserFeed: feed } as never);
    await expect(scrapeUserPostsPageWithBot(BOT_ID, '123', { count: 3, maxId: 'requested-page' })).rejects.toThrow('API pagination cursors');
    expect(feed).toHaveBeenCalledExactlyOnceWith('123', { count: 3, maxId: 'requested-page' });
    expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, 'posts'], [BOT_ID, 'posts']]);
    expect(dbState.txCalls).toBe(1);
  });

  it('respects the shared operation attempt limit before allocating a browser', async () => {
    const error = new MockHttpError('upstream outage'); error.status = 500;
    fakeClient.fetchStoriesTray.mockRejectedValue(error);
    await expect(withScrapeOperation(async () => {
      currentScrapeOperation()!.maxAttempts = 1;
      return scrapeUserStoriesWithBot(BOT_ID, '123');
    })).rejects.toThrow();
    expect(fakeClient.fetchStoriesTray).toHaveBeenCalledTimes(1);
    expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, 'stories']]);
    expect(createNativeBrowserReadClient).not.toHaveBeenCalled();
    expect(invalidateObservedBotSession).not.toHaveBeenCalled();
  });

  it('leaves the original error in place when the feature is disabled', async () => {
    vi.stubEnv('IG_MEDIA_BROWSER_FALLBACK_ENABLED', 'false');
    const error = new MockHttpError('upstream outage'); error.status = 500;
    fakeClient.fetchStoriesTray.mockRejectedValue(error);
    await expect(scrapeUserStoriesWithBot(BOT_ID, '123')).rejects.toThrow();
    expect(createNativeBrowserReadClient).not.toHaveBeenCalled();
    expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, 'stories']]);
  });
});

describe("approved viewer profile and paginated media", () => {
  const profile = { pk: "123", username: "privateuser", isPrivate: true, followerCount: 10, followingCount: 5, mediaCount: 1 };

  it('reads private profile and posts with the approved web account credential on the mobile endpoint',async()=>{
    vi.stubEnv('PINNED_WEB_MOBILE_READS_ENABLED','true');
    const ready={sessionData:JSON.stringify({cookies:[{name:'ds_user_id',value:'99',domain:'.instagram.com'},{name:'sessionid',value:'99%3Asaved',domain:'.instagram.com'}]}),proxyEndpoint:'gw.example:10000',automationIdentity:null,transport:'web' as const};
    ensureBotReady.mockResolvedValueOnce(ready).mockResolvedValueOnce(ready);
    fakeClient.fetchProfileById.mockResolvedValue(profile);
    fakeClient.fetchUserFeed.mockResolvedValue({items:[],nextMaxId:null,moreAvailable:false});
    await expect(scrapeProfileWithBot(BOT_ID,profile.username,profile.pk)).resolves.toMatchObject({igUserId:'123'});
    await expect(scrapeUserPostsPageWithBot(BOT_ID,'123',{count:1})).resolves.toMatchObject({posts:[]});
    expect(createMobileReadClient).toHaveBeenCalledTimes(2);
    expect(createMobileReadClient).toHaveBeenCalledWith(expect.objectContaining({botId:BOT_ID,proxyEndpoint:'gw.example:10000',session:expect.objectContaining({dsUserId:'99',sessionid:'99%3Asaved'})}));
    expect(createHttpBotClientWithFingerprint).not.toHaveBeenCalled();
  });

  it("reads a numeric profile through only the specified saved session", async () => {
    fakeClient.fetchProfileById.mockResolvedValue(profile);
    await expect(scrapeProfileWithBot(BOT_ID, profile.username, profile.pk)).resolves.toMatchObject({ igUserId: "123", isPrivate: true });
    expect(fakeClient.fetchProfileById).toHaveBeenCalledExactlyOnceWith("123");
    expect(fakeClient.fetchProfile).not.toHaveBeenCalled();
    expect(ensureBotReady).toHaveBeenCalledExactlyOnceWith(BOT_ID, { allowLogin: false });
    expect(dbState.txCalls).toBe(1);
  });

  it("does not switch viewers or retry a username endpoint after the pinned profile fails", async () => {
    fakeClient.fetchProfileById.mockRejectedValueOnce(new Error("profile unavailable"));
    await expect(scrapeProfileWithBot(BOT_ID, profile.username, profile.pk)).rejects.toThrow();
    expect(fakeClient.fetchProfile).not.toHaveBeenCalled();
    expect(ensureBotReady).toHaveBeenCalledExactlyOnceWith(BOT_ID, { allowLogin: false });
    expect(dbState.txCalls).toBe(1);
  });

  it("rejects a profile response for a different target ID", async () => {
    fakeClient.fetchProfileById.mockResolvedValueOnce({ ...profile, pk: "456" });
    await expect(scrapeProfileWithBot(BOT_ID, profile.username, profile.pk)).rejects.toThrow("mismatched identity");
    expect(fakeClient.fetchProfile).not.toHaveBeenCalled();
  });

  it("uses a username only when no numeric ID is available, on the same viewer", async () => {
    fakeClient.fetchProfile.mockResolvedValueOnce(profile);
    await expect(scrapeProfileWithBot(BOT_ID, profile.username)).resolves.toMatchObject({ igUserId: "123" });
    expect(fakeClient.fetchProfile).toHaveBeenCalledExactlyOnceWith(profile.username);
    expect(fakeClient.fetchProfileById).not.toHaveBeenCalled();
    expect(ensureBotReady).toHaveBeenCalledExactlyOnceWith(BOT_ID, { allowLogin: false });
  });

  it("keeps post pagination and reel mapping on the approved viewer", async () => {
    fakeClient.fetchUserFeed.mockResolvedValueOnce({ items: [{ id: "100_123", code: "PRIVATE1", mediaType: 2, productType: "clips", pinnedUserIds: [123], carouselMedia: null }], nextMaxId: "next-page", moreAvailable: true });
    const page = await scrapeUserPostsPageWithBot(BOT_ID, "123", { maxId: "prior-page", count: 100 });
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledExactlyOnceWith("123", { maxId: "prior-page", count: 24 });
    expect(page).toMatchObject({ posts: [{ shortcode: "PRIVATE1", postType: "reel", isPinned: true }], nextMaxId: "next-page", moreAvailable: true });
    expect(ensureBotReady).toHaveBeenCalledExactlyOnceWith(BOT_ID, { allowLogin: false });
  });

  it("renews a private carousel thumbnail through the approved viewer", async () => {
    fakeClient.fetchRaw.mockResolvedValueOnce({ items: [{ carousel_media: [{ image_versions2: { candidates: [{ url: "https://cdn.invalid/fresh" }] } }] }] });
    await expect(getFreshMediaThumbnailWithBot(BOT_ID, "100_123")).resolves.toBe("https://cdn.invalid/fresh");
    expect(fakeClient.fetchRaw).toHaveBeenCalledExactlyOnceWith("/api/v1/media/100_123/info/");
    expect(ensureBotReady).toHaveBeenCalledExactlyOnceWith(BOT_ID, { allowLogin: false });
  });

  it("renews media details with stable child IDs after dropping unreadable children", async () => {
    fakeClient.fetchRaw.mockResolvedValueOnce({ items: [{ id: "100_123", code: "PRIVATE1", media_type: 8, user: { pk: "123" }, timeline_pinned_user_ids: [123], carousel_media: [
      { id: "unreadable", media_type: 1 },
      { id: "101_123", media_type: 2, image_versions2: { candidates: [{ url: "https://cdn.invalid/child" }] }, video_versions: [{ url: "https://cdn.invalid/video" }] },
      { pk: 102, media_type: 1, image_versions2: { candidates: [{ url: "https://cdn.invalid/photo" }] } },
    ] }] });
    const details = await getFreshMediaDetailsWithBot(BOT_ID, "100_123");
    expect(details).toMatchObject({ mediaId: "100_123", postType: "carousel", isPinned: true, carouselMedia: [
      { mediaId: "101_123", type: "video", displayUrl: "https://cdn.invalid/child", videoUrl: "https://cdn.invalid/video" },
      { mediaId: "102", type: "photo", displayUrl: "https://cdn.invalid/photo", videoUrl: null },
    ] });
    expect(fakeClient.fetchRaw).toHaveBeenCalledExactlyOnceWith("/api/v1/media/100_123/info/");
    expect(ensureBotReady).toHaveBeenCalledExactlyOnceWith(BOT_ID, { allowLogin: false });
  });

  it("keeps renewed reel video details and refuses media for a different post", async () => {
    const raw = { id: "100_123", code: "PRIVATE1", media_type: 2, product_type: "clips", video_versions: [{ url: "https://cdn.invalid/reel-video" }] };
    fakeClient.fetchRaw.mockResolvedValueOnce({ items: [raw] });
    await expect(getFreshMediaDetailsWithBot(BOT_ID, "100")).resolves.toMatchObject({ mediaId: "100_123", postType: "reel", videoUrl: "https://cdn.invalid/reel-video" });
    fakeClient.fetchRaw.mockResolvedValueOnce({ items: [{ ...raw, id: "200_123" }] });
    await expect(getFreshMediaDetailsWithBot(BOT_ID, "100")).resolves.toBeNull();
  });
});

// ── B3: leaseSpecificBot locked-row retry ───────────────────────────────────

describe("pinned viewer health and friendship reads", () => {
  beforeEach(() => {
    vi.mocked(getScraperReadTransport).mockResolvedValue({ value: "http" } as never);
    fakeClient.fetchFriendshipStatus.mockResolvedValue({
      following: true, outgoingRequest: false, incomingRequest: false,
      followedBy: false, isPrivate: true,
    });
  });

  it.each([
    ["disabled", { status: "disabled" }],
    ["banned", { status: "banned" }],
    ["expired session", { status: "session_expired" }],
    ["reserve", { tier: "reserve" }],
    ["retired", { tier: "retired" }],
    ["active cooldown", { cooldownUntil: new Date("2099-01-01T00:00:00Z") }],
    ["terminal session error", { lastLoginError: "checkpoint_required" }],
    ["missing session", { sessionData: null }],
    ["missing identity", { automationIdentity: null }],
    ["wrong identity", { automationIdentity: { ...botRow.automationIdentity, bot_id: "another-bot" } }],
    ["invalid proxy", { proxyUrl: "not a proxy" }],
    ["rotating proxy", { proxyUrl: "http://gateway.dataimpulse.com:823" }],
    ["expired proxy", { proxyExpiresAt: new Date(0) }],
    ["missing proxy", { proxyEndpoint: null }],
  ])("blocks %s before readiness, quota, or transport", async (_label, changes) => {
    dbState.txResults = [{ ...botRow, ...changes }];
    await expect(scrapeFriendshipStatusWithBot(BOT_ID, "123")).rejects.toThrow(/pinned read unavailable/);
    expect(dbState.txCalls).toBe(1);
    expect(dbState.updateSets).toEqual([]);
    expect(ensureBotReady).not.toHaveBeenCalled();
    expect(reserveOrThrow).not.toHaveBeenCalled();
    expect(createHttpBotClientWithFingerprint).not.toHaveBeenCalled();
  });

  it("allows an in-use watcher once its explicitly timed cooldown expires", async () => {
    dbState.txResults = [{ ...botRow, status: "in_use", role: "feed_watcher",
      cooldownUntil: new Date(0), lastLoginError: "cooldown: checkpoint_required" }];
    await expect(scrapeFriendshipStatusWithBot(BOT_ID, "123")).resolves.toMatchObject({ following: true });
    expect(reserveOrThrow).toHaveBeenCalledWith(BOT_ID, "profile");
    expect(fakeClient.fetchFriendshipStatus).toHaveBeenCalledWith("123");
  });

  it("honors a cooldown written between consecutive pinned reads", async () => {
    dbState.txResults = [botRow, { ...botRow, cooldownUntil: new Date("2099-01-01T00:00:00Z") }];
    await scrapeFriendshipStatusWithBot(BOT_ID, "123");
    await expect(scrapeFriendshipStatusWithBot(BOT_ID, "123")).rejects.toThrow(/cooldown/);
    expect(fakeClient.fetchFriendshipStatus).toHaveBeenCalledTimes(1);
    expect(reserveOrThrow).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved web requester and checks authorization inside its operation lease", async () => {
    vi.stubEnv("PINNED_WEB_MOBILE_READS_ENABLED", "true");
    vi.mocked(getScraperReadTransport).mockResolvedValue({ value: "browser" } as never);
    const beforeRead = vi.fn(async () => {
      expect(leaseState.key).toBe(`bot:${BOT_ID}`);
      expect(reserveOrThrow).toHaveBeenCalledWith(BOT_ID, "profile");
      expect(fakeClient.fetchFriendshipStatus).not.toHaveBeenCalled();
    });
    await scrapeFriendshipStatusWithBot(BOT_ID, "123", beforeRead);
    expect(beforeRead).toHaveBeenCalledTimes(1);
    expect(createMobileReadClient).not.toHaveBeenCalled();
    expect(createBrowserReadClient).not.toHaveBeenCalled();
    expect(fakeClient.close).toHaveBeenCalled();
  });

  it("stops before upstream when the final authorization check fails", async () => {
    await expect(scrapeFriendshipStatusWithBot(BOT_ID, "123", async () => {
      throw new Error("request no longer eligible");
    })).rejects.toThrow();
    expect(fakeClient.fetchFriendshipStatus).not.toHaveBeenCalled();
    expect(fakeClient.close).toHaveBeenCalled();
  });

  it("refuses an unreadable saved session without requesting login", async () => {
    ensureBotReady.mockRejectedValueOnce(new Error("saved session unavailable"));
    await expect(scrapeFriendshipStatusWithBot(BOT_ID, "123")).rejects.toThrow(/saved session unavailable/);
    expect(ensureBotReady).toHaveBeenCalledWith(BOT_ID, { allowLogin: false });
    expect(reserveOrThrow).not.toHaveBeenCalled();
    expect(fakeClient.fetchFriendshipStatus).not.toHaveBeenCalled();
  });

  it("allows only a single controlled feed read for the observed aged cooldown", async () => {
    const until = new Date("2099-01-01T00:00:00Z");
    dbState.txResults = [{ ...botRow, cooldownUntil: until, lastLoginError: "cooldown: checkpoint_required" }];
    fakeClient.fetchUserFeed.mockResolvedValueOnce({ items: [], moreAvailable: true, nextMaxId: "next" });
    await probePinnedBotCooldown(BOT_ID, "123", until);
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledExactlyOnceWith("123", { count: 1 });
    expect(reserveOrThrow).toHaveBeenCalledExactlyOnceWith(BOT_ID, "posts");
    expect(dbState.updateSets.some(values => "cooldownUntil" in values)).toBe(false);
    await expect(scrapeFriendshipStatusWithBot(BOT_ID, "123")).rejects.toThrow(/cooldown/);
  });

  it("skips unusable older cooled rows without starving the next eligible recovery probe", () => {
    const now = new Date("2026-09-25T10:00:00Z");
    const eligible = { ...botRow, cooldownUntil: new Date(now.getTime() + 60 * 60_000),
      lastLoginError: "cooldown: rate limited; retry-after=3600000ms" };
    const candidates = [
      { ...eligible, status: "session_expired" },
      { ...eligible, status: "banned" },
      { ...eligible, tier: "reserve" },
      { ...eligible, sessionData: null },
      { ...eligible, automationIdentity: null },
      { ...eligible, proxyEndpoint: null },
      { ...eligible, proxyUrl: "http://gateway.dataimpulse.com:823" },
      { ...eligible, lastLoginError: "account suspended" },
      eligible,
    ] as Parameters<typeof selectCooldownProbeCandidate>[0];

    expect(selectCooldownProbeCandidate(candidates, now)).toBe(eligible);
    expect(selectCooldownProbeCandidate(candidates.slice(0, -1), now)).toBeUndefined();
    expect(dbState.txCalls).toBe(0);
    expect(dbState.updateSets).toEqual([]);
    expect(ensureBotReady).not.toHaveBeenCalled();
    expect(reserveOrThrow).not.toHaveBeenCalled();
    expect(fakeClient.fetchUserFeed).not.toHaveBeenCalled();
  });

  it("keeps recent, elapsed, and never-authenticated holds out of probe selection", () => {
    const now = new Date("2026-09-25T10:00:00Z");
    const eligible = { ...botRow, cooldownUntil: new Date(now.getTime() + 60 * 60_000),
      lastLoginError: "cooldown: checkpoint_required" };
    const candidates = [
      { ...eligible, updatedAt: now },
      { ...eligible, cooldownUntil: new Date(now.getTime() - 1) },
      { ...eligible, lastLoginAt: null },
    ] as Parameters<typeof selectCooldownProbeCandidate>[0];
    expect(selectCooldownProbeCandidate(candidates, now)).toBeUndefined();
    expect(dbState.updateSets).toEqual([]);
  });

  it.each(["changed", "recent", "no login"])("blocks a cooldown probe with %s observation", async (reason) => {
    const until = new Date("2099-01-01T00:00:00Z");
    dbState.txResults = [{ ...botRow, cooldownUntil: until,
      ...(reason === "recent" ? { updatedAt: new Date() } : {}),
      ...(reason === "no login" ? { lastLoginAt: null } : {}),
    }];
    await expect(probePinnedBotCooldown(BOT_ID, "123", reason === "changed" ? new Date(until.getTime() - 1) : until))
      .rejects.toThrow(/observation/);
    expect(reserveOrThrow).not.toHaveBeenCalled();
    expect(fakeClient.fetchUserFeed).not.toHaveBeenCalled();
  });
});

describe("leaseSpecificBot retry (B3)", () => {
  it("leases on the first attempt when the row is free", async () => {
    const users = await scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1");
    expect(users).toHaveLength(3);
    expect(dbState.txCalls).toBe(1);
    expect(ensureBotReady).toHaveBeenCalledWith(BOT_ID, { allowLogin: false });
  });

  it("retries through a transient row lock and then succeeds", async () => {
    // Two locked attempts (SKIP LOCKED → zero rows while the row exists),
    // third attempt wins.
    dbState.txResults = [null, null, botRow];
    dbState.existsRows = [{ id: BOT_ID }];

    const users = await scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1");
    expect(users).toHaveLength(3);
    expect(dbState.txCalls).toBe(3);
  });

  it("fails FAST with 'not found' when the bot row is genuinely missing (no retries)", async () => {
    dbState.txResults = [null];
    dbState.existsRows = []; // lock-free probe sees nothing → truly missing

    await expect(
      scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1"),
    ).rejects.toThrow(/bot bot-1 not found/);
    expect(dbState.txCalls).toBe(1);
    // Never reached the budget / client stages.
    expect(reserveOrThrow).not.toHaveBeenCalled();
    expect(fakeClient.fetchMediaLikers).not.toHaveBeenCalled();
  });

  it("gives up with a 'locked' error after exhausting all attempts", async () => {
    dbState.txResults = [null]; // locked on every attempt
    dbState.existsRows = [{ id: BOT_ID }]; // …but the row exists

    await expect(
      scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1"),
    ).rejects.toThrow(/locked by a concurrent lease/);
    expect(dbState.txCalls).toBe(3);
    expect(fakeClient.fetchMediaLikers).not.toHaveBeenCalled();
  });

  it("rejects an empty bot id without touching the db", async () => {
    await expect(
      scrapeMediaLikersWithBot("", "SC1", "media-1"),
    ).rejects.toThrow(/requires a bot id/);
    expect(dbState.txCalls).toBe(0);
  });
});

// ── B13: per-page budget accounting on the pinned follow walk ───────────────

describe("pinned follow walk budget accounting (B13)", () => {
  function mockFollowerPages(
    pages: Array<{ users: RawFollowUser[]; nextMaxId: string | null }>,
  ): void {
    fakeClient.fetchFollowers.mockImplementation(
      async (_pk: string, opts?: { maxId?: string }) => {
        if (!opts?.maxId) return pages[0];
        const idx = Number(opts.maxId.replace("cursor-", ""));
        return pages[idx];
      },
    );
  }

  it("checks the current grant before the first provider page", async () => {
    const beforePage = vi.fn(async () => { throw new Error("grant revoked"); });
    await expect(scrapeUserFollowersCaptureWithBot(BOT_ID, "999", { beforePage })).rejects.toThrow("grant revoked");
    expect(beforePage).toHaveBeenCalledOnce();
    expect(fakeClient.fetchFollowers).not.toHaveBeenCalled();
  });
  it("stops between roster pages when the current grant is revoked", async () => {
    mockFollowerPages([{ users: buildRawUsers(3, "p0"), nextMaxId: "cursor-1" }]);
    const beforePage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("grant revoked"));
    vi.useFakeTimers();
    const outcome = scrapeUserFollowersCaptureWithBot(BOT_ID, "999", { beforePage }).then(() => null, error => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ message: expect.stringContaining("grant revoked") });
    expect(beforePage).toHaveBeenCalledTimes(2);
    expect(fakeClient.fetchFollowers).toHaveBeenCalledOnce();
    expect(checkAndIncrementBudget).not.toHaveBeenCalled();
  });
  it("reports a page cap as resumable, not a complete roster", async () => {
    mockFollowerPages([{ users: buildRawUsers(3, "p0"), nextMaxId: "cursor-1" }]);
    const result = await scrapeUserFollowersCaptureWithBot(BOT_ID, "999", { maxPages: 1 });
    expect(result).toMatchObject({ complete: false, stopReason: "page_cap", nextCursor: "cursor-1", pagesFetched: 1, startedFromTop: true, viewerBotId: BOT_ID });
    expect(result.users).toHaveLength(3);
  });

  it("replays a partly consumed page when the item cap cuts through it", async () => {
    mockFollowerPages([{ users: buildRawUsers(3, "p0"), nextMaxId: null }]);
    const result = await scrapeUserFollowersCaptureWithBot(BOT_ID, "999", { maxItems: 2 });
    expect(result).toMatchObject({ complete: false, stopReason: "item_cap", nextCursor: null });
    expect(result.users).toHaveLength(2);
  });

  it("reports exhaustion when an exact item cap coincides with the last page", async () => {
    mockFollowerPages([{ users: buildRawUsers(2, "p0"), nextMaxId: null }]);
    const result = await scrapeUserFollowersCaptureWithBot(BOT_ID, "999", { maxItems: 2, maxPages: 1 });
    expect(result).toMatchObject({ complete: true, stopReason: "exhausted", nextCursor: null });
  });

  it("preserves a resumed walk's cursor and epoch identity", async () => {
    mockFollowerPages([
      { users: buildRawUsers(2, "p0"), nextMaxId: "cursor-1" },
      { users: buildRawUsers(3, "p1"), nextMaxId: "cursor-2" },
    ]);
    const result = await scrapeUserFollowersCaptureWithBot(BOT_ID, "999", { startCursor: "cursor-1", maxPages: 1 });
    expect(result).toMatchObject({ complete: false, startedFromTop: false, nextCursor: "cursor-2" });
    expect(fakeClient.fetchFollowers).toHaveBeenCalledWith("999", { count: 50, maxId: "cursor-1" });
    expect(result.users).toHaveLength(3);
  });

  it("deduplicates usernames before applying the item cap", async () => {
    const users = buildRawUsers(2, "p0");
    mockFollowerPages([{ users: [users[0], users[0], users[1]], nextMaxId: null }]);
    const result = await scrapeUserFollowersCaptureWithBot(BOT_ID, "999", { maxItems: 2 });
    expect(result.complete).toBe(true);
    expect(result.users).toHaveLength(2);
  });

  it("returns partial resume metadata on shutdown between pages", async () => {
    mockFollowerPages([{ users: buildRawUsers(2, "p0"), nextMaxId: "cursor-1" }]);
    vi.useFakeTimers();
    const promise = scrapeUserFollowersCaptureWithBot(BOT_ID, "999", { shouldStop: () => true });
    await vi.runAllTimersAsync();
    expect(await promise).toMatchObject({ complete: false, stopReason: "shutdown", nextCursor: "cursor-1", pagesFetched: 1 });
    expect(fakeClient.fetchFollowers).toHaveBeenCalledTimes(1);
    expect(fakeClient.close).toHaveBeenCalled();
  });

  it("reserves one budget unit per page: lease covers page 1, checkAndIncrementBudget covers pages 2+", async () => {
    mockFollowerPages([
      { users: buildRawUsers(50, "p0"), nextMaxId: "cursor-1" },
      { users: buildRawUsers(50, "p1"), nextMaxId: "cursor-2" },
      { users: buildRawUsers(30, "p2"), nextMaxId: null },
    ]);

    vi.useFakeTimers();
    const promise = scrapeUserFollowersWithBot(BOT_ID, "999", {
      maxPages: 10,
      maxItems: 1000,
    });
    await vi.runAllTimersAsync(); // flush inter-page jitter delays
    const users = await promise;

    expect(users).toHaveLength(130);
    expect(fakeClient.fetchFollowers).toHaveBeenCalledTimes(3);
    // Page 1: lease-time reservation.
    expect(reserveOrThrow).toHaveBeenCalledTimes(1);
    expect(reserveOrThrow).toHaveBeenCalledWith(BOT_ID, "followers");
    // Pages 2 and 3: one in-walk reservation each.
    expect(checkAndIncrementBudget).toHaveBeenCalledTimes(2);
    expect(checkAndIncrementBudget).toHaveBeenNthCalledWith(
      1,
      BOT_ID,
      "followers",
    );
  });

  it("does not double-charge a single-page walk", async () => {
    mockFollowerPages([
      { users: buildRawUsers(20, "p0"), nextMaxId: null },
    ]);

    const users = await scrapeUserFollowersWithBot(BOT_ID, "999");
    expect(users).toHaveLength(20);
    expect(reserveOrThrow).toHaveBeenCalledTimes(1);
    expect(checkAndIncrementBudget).not.toHaveBeenCalled();
  });

  it("stops the walk and THROWS when the budget runs out mid-walk (maps to ok:false upstream, not ok-complete)", async () => {
    mockFollowerPages([
      { users: buildRawUsers(50, "p0"), nextMaxId: "cursor-1" },
      { users: buildRawUsers(50, "p1"), nextMaxId: "cursor-2" },
      { users: buildRawUsers(50, "p2"), nextMaxId: "cursor-3" },
    ]);
    // Page 2 allowed, page 3 denied.
    checkAndIncrementBudget
      .mockResolvedValueOnce({
        allowed: true,
        used: 5,
        cap: 5,
        endpoint: "followers",
      })
      .mockResolvedValueOnce({
        allowed: false,
        used: 5,
        cap: 5,
        endpoint: "followers",
      });

    vi.useFakeTimers();
    const promise = scrapeUserFollowersWithBot(BOT_ID, "999", {
      maxPages: 10,
      maxItems: 1000,
    });
    const settled = promise.catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const err = (await settled) as Error & { name: string };

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IGPublicScraperError");
    expect(err.message).toMatch(/truncated by daily budget/);
    expect(err.message).toMatch(/2 page\(s\)/);
    // The denied page was never fetched.
    expect(fakeClient.fetchFollowers).toHaveBeenCalledTimes(2);
    // The bot lease was still released cleanly (client closed).
    expect(fakeClient.close).toHaveBeenCalled();
  });

  it("budget denial on page 2 surfaces the page-1 progress in the error", async () => {
    mockFollowerPages([
      { users: buildRawUsers(50, "p0"), nextMaxId: "cursor-1" },
      { users: buildRawUsers(50, "p1"), nextMaxId: null },
    ]);
    checkAndIncrementBudget.mockResolvedValueOnce({
      allowed: false,
      used: 2,
      cap: 2,
      endpoint: "followers",
    });

    vi.useFakeTimers();
    const promise = scrapeUserFollowersWithBot(BOT_ID, "999", {
      maxPages: 10,
    });
    const settled = promise.catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const err = (await settled) as Error;

    expect(err.message).toMatch(/after 1 page\(s\) \/ 50 users \(cap=2\)/);
    expect(fakeClient.fetchFollowers).toHaveBeenCalledTimes(1);
  });
});

// ── Dead-session escalation + budget ordering (2026-09-02) ──────────────────
//
// Every hard failure (auth-class refusal of the SESSION) must bump the streak
// and run the escalation; rate limits, IG's "please wait" 401 throttle and
// client-build faults must not. A login wall (2xx + HTML on likers) becomes a
// typed IGLoginWallError whose message scrape-retry treats as rotate-now, and
// the daily-budget unit is reserved only once a client exists.

import {
  IGAuthExpiredError as MockAuthExpired,
  IGHttpError as MockHttpError,
  IGRateLimitedError as MockRateLimited,
} from "../ig-http-client.js";

type MutableHttpError = InstanceType<typeof MockHttpError> & {
  status: number;
  url?: string;
  body?: string;
};
type MutableAuthError = InstanceType<typeof MockAuthExpired> & {
  status: number;
  body?: string;
};

async function captureRejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected rejection");
}

describe("hard-failure streak (dead-session escalation)", () => {
  it("preserves a session refused by a policy check without escalating its death streak", async () => {
    const err = Object.assign(new MockHttpError("[ig-mobile] HTTP 403"), {
      status: 403,
      authDiagnostics: { reason: "request_rejected", challengeKind: null, codeMethod: null },
    });
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);
    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();
    expect(cooldownMocks.recordHardFailure).not.toHaveBeenCalled();
    expect(invalidateObservedBotSession).not.toHaveBeenCalled();
    expect(cooldownMocks.cooldownBotForCheckpoint).toHaveBeenCalledWith(BOT_ID, expect.stringContaining("request held for review"), 1);
    expect(dbState.updateSets.some(values => values.sessionData === null)).toBe(false);
    expect(classifyError(err)).toBe("failure");
  });

  it("keeps an HTTP 403 challenge distinct from a generic forbidden response", async () => {
    const err = Object.assign(new MockHttpError("[ig-mobile] HTTP 403"), {
      status: 403, igErrorCode: "challenge_required",
      authDiagnostics: { reason: "challenge_required", challengeKind: "native", codeMethod: null },
    });
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);
    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();
    expect(cooldownMocks.cooldownBotForCheckpoint).toHaveBeenCalledWith(BOT_ID, expect.stringContaining("challenge_required (HTTP 403)"), 24);
    expect(classifyError(err)).toBe("checkpoint");
  });

  const loginRedirect = () => Object.assign(new MockAuthExpired("Instagram login redirect"), {
    status: 200,
    responseDiagnostics: { responseUrlClass: "login" as const },
  });

  it("parks the exact session rejected by a confirmed login redirect while holding its bot lease", async () => {
    const err = loginRedirect();
    fakeClient.fetchFollowers.mockRejectedValueOnce(err);
    invalidateObservedBotSession.mockImplementationOnce(async (id, observed) => {
      expect(leaseState.key).toBe(`bot:${id}`);
      expect(observed).toBe("ready-session");
      expect(fakeClient.close).not.toHaveBeenCalled();
      return true;
    });

    const thrown = await captureRejection(scrapeUserFollowersWithBot(BOT_ID, "999", { maxPages: 1 }));
    expect(thrown).toMatchObject({ cause: err });
    expect(invalidateObservedBotSession).toHaveBeenCalledExactlyOnceWith(BOT_ID, "ready-session");
    expect(cooldownMocks.recordHardFailure).not.toHaveBeenCalled();
    expect(cooldownMocks.cooldownBotForCheckpoint).not.toHaveBeenCalled();
    expect(recordStrike).not.toHaveBeenCalled();
    expect(createBrowserReadClient).not.toHaveBeenCalled();
    expect(fakeClient.close).toHaveBeenCalledOnce();
    expect(leaseState.key).toBeNull();
  });

  it("does not cool or escalate a concurrently renewed session when guarded invalidation loses", async () => {
    const err = loginRedirect();
    fakeClient.fetchFollowers.mockRejectedValueOnce(err);
    invalidateObservedBotSession.mockImplementationOnce(async (id) => {
      expect(leaseState.key).toBe(`bot:${id}`);
      return false;
    });

    const thrown = await captureRejection(scrapeUserFollowersWithBot(BOT_ID, "999", { maxPages: 1 }));
    expect(thrown).toMatchObject({ cause: err });
    expect(invalidateObservedBotSession).toHaveBeenCalledExactlyOnceWith(BOT_ID, "ready-session");
    expect(cooldownMocks.recordHardFailure).not.toHaveBeenCalled();
    expect(cooldownMocks.applyHardFailureEscalation).not.toHaveBeenCalled();
    expect(cooldownMocks.cooldownBotForCheckpoint).not.toHaveBeenCalled();
    expect(cooldownMocks.cooldownBotForRateLimit).not.toHaveBeenCalled();
    for (const values of dbState.updateSets) {
      expect(Object.keys(values).every(key => ["lastUsedAt", "updatedAt"].includes(key))).toBe(true);
    }
    expect(fakeClient.close).toHaveBeenCalledOnce();
  });

  it("a successful call clears the streak", async () => {
    await scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1");
    expect(cooldownMocks.resetHardFailureStreak).toHaveBeenCalledWith(BOT_ID);
    expect(cooldownMocks.recordHardFailure).not.toHaveBeenCalled();
  });

  it("HTTP 403 on likers: legacy 12h cooldown PLUS a streak increment and escalation", async () => {
    const err = new MockHttpError("[ig-http] GET likers failed with status 403") as MutableHttpError;
    err.status = 403;
    err.url = "https://www.instagram.com/api/v1/media/1/likers/";
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);

    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();

    expect(cooldownMocks.cooldownBotForCheckpoint).toHaveBeenCalledWith(
      BOT_ID,
      expect.stringContaining("forbidden (HTTP 403)"),
      12,
    );
    expect(cooldownMocks.recordHardFailure).toHaveBeenCalledWith(BOT_ID);
    expect(cooldownMocks.applyHardFailureEscalation).toHaveBeenCalledWith(
      BOT_ID,
      "web",
      1,
      expect.stringContaining("forbidden"),
    );
    expect(cooldownMocks.resetHardFailureStreak).not.toHaveBeenCalled();
  });

  it("HTTP 400 challenge_required: 24h prefixed cooldown (new branch) and a streak increment", async () => {
    const err = new MockHttpError("[ig-mobile] HTTP 400 for GET profile") as MutableHttpError;
    err.status = 400;
    err.igErrorCode = "challenge_required";
    err.body = '{"message":"challenge_required","status":"fail"}';
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);

    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();

    expect(cooldownMocks.cooldownBotForCheckpoint).toHaveBeenCalledWith(
      BOT_ID,
      expect.stringContaining("challenge_required (HTTP 400)"),
      24,
    );
    expect(cooldownMocks.recordHardFailure).toHaveBeenCalledWith(BOT_ID);
    expect(invalidateObservedBotSession).not.toHaveBeenCalled();
  });

  it("login wall (2xx non-JSON on likers): 12h cooldown, streak, and a rotate-now error for scrape-retry", async () => {
    const err = new MockHttpError("[ig-http] response not JSON for GET likers") as MutableHttpError;
    err.status = 200;
    err.url = "https://www.instagram.com/api/v1/media/1/likers/";
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);

    const thrown = await captureRejection(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1"));
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("IGLoginWallError");
    // isPermanentPerBot (scrape-retry.ts) matches the ROOT error's message on
    // "login_required" — so the wall must carry it and must NOT chain `cause`
    // to the status-200 IGHttpError, which would be classified as retryable.
    expect((thrown as Error).message).toContain("login_required");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    expect((thrown as { original?: unknown }).original).toBe(err);

    expect(cooldownMocks.cooldownBotForCheckpoint).toHaveBeenCalledWith(
      BOT_ID,
      expect.stringContaining("login wall"),
      12,
    );
    expect(cooldownMocks.recordHardFailure).toHaveBeenCalledWith(BOT_ID);
    expect(invalidateObservedBotSession).not.toHaveBeenCalled();
  });

  it("a 429 is NOT a hard failure: rate-limit cooldown only, streak untouched", async () => {
    const err = new MockRateLimited("[ig-http] rate limited for GET likers");
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);

    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();

    expect(cooldownMocks.cooldownBotForRateLimit).toHaveBeenCalledWith(BOT_ID, 0);
    expect(cooldownMocks.recordHardFailure).not.toHaveBeenCalled();
  });

  it("IG's 'please wait' 401 throttle is NOT a hard failure", async () => {
    const err = new MockAuthExpired("[ig-http] auth rejected (status 401)") as MutableAuthError;
    err.status = 401;
    err.body = '{"message":"Bitte warte einige Minuten.","require_login":true,"igweb_rollout":true,"status":"fail"}';
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);

    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();

    expect(cooldownMocks.recordHardFailure).not.toHaveBeenCalled();
    expect(cooldownMocks.cooldownBotForCheckpoint).not.toHaveBeenCalled();
    expect(invalidateObservedBotSession).not.toHaveBeenCalled();
  });

  it("a network sentinel (status 0) is NOT a hard failure", async () => {
    const err = new MockHttpError("[ig-http] network error for GET likers") as MutableHttpError;
    err.status = 0;
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);

    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();

    expect(cooldownMocks.recordHardFailure).not.toHaveBeenCalled();
  });
});

describe("budget is reserved only once a client exists (L5)", () => {
  it("a client-build failure spends no daily-budget unit and no streak", async () => {
    createHttpBotClientWithFingerprint.mockImplementationOnce(() => {
      throw new Error("browser launch failed: net::ERR_TUNNEL_CONNECTION_FAILED");
    });

    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow(
      /failed to build IG client/,
    );

    expect(reserveOrThrow).not.toHaveBeenCalled();
    expect(cooldownMocks.recordHardFailure).not.toHaveBeenCalled();
    expect(fakeClient.fetchMediaLikers).not.toHaveBeenCalled();
  });

  it("the normal path still reserves exactly one unit before the request", async () => {
    await scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1");
    expect(reserveOrThrow).toHaveBeenCalledTimes(1);
    expect(reserveOrThrow).toHaveBeenCalledWith(BOT_ID, "likers");
    // Client was built before the reservation ran.
    const buildOrder = createHttpBotClientWithFingerprint.mock.invocationCallOrder[0]!;
    const reserveOrder = reserveOrThrow.mock.invocationCallOrder[0]!;
    expect(buildOrder).toBeLessThan(reserveOrder);
  });
});

// ── Lease candidate query builder (A6 budget gate, B2 scraper role, lesson 22) ──
//
// The builder is exercised through a real drizzle dialect (drizzle.mock(): no
// connection, `.toSQL()` only) so these assertions see the SQL Postgres sees.
// Executing it against the live DB is still mandatory before a deploy
// (server/scripts/smoke-lease.ts) — unit tests never replace that step.

const qb = drizzle.mock();
const FIXED_NOW = new Date("2026-09-02T23:40:00.000Z");

function leaseSql(label?: (typeof PRODUCTION_LEASE_LABELS)[number]) {
  return buildLeaseCandidateQuery(qb, { label, now: FIXED_NOW }).toSQL();
}

/** Top-level ORDER BY terms; commas inside parens / CASE…END do not split. */
function topLevelOrderByTerms(sqlText: string): string[] {
  const start = sqlText.toLowerCase().indexOf(" order by ");
  expect(start).toBeGreaterThan(-1);
  const tail = sqlText.slice(start + " order by ".length);
  const tokens = tail.match(/\(|\)|,|\bcase\b|\bend\b|[^(),\s]+|\s+/gi) ?? [];
  const terms: string[] = [];
  let depth = 0;
  let caseDepth = 0;
  let current = "";
  for (const tok of tokens) {
    // The mobile health preference contains its own ORDER BY / LIMIT.
    // Only the outer LIMIT terminates the list being checked.
    if (/^limit$/i.test(tok) && depth === 0 && caseDepth === 0) break;
    if (tok === "(") depth += 1;
    else if (tok === ")") depth -= 1;
    else if (/^case$/i.test(tok)) caseDepth += 1;
    else if (/^end$/i.test(tok)) caseDepth -= 1;
    if (tok === "," && depth === 0 && caseDepth === 0) {
      terms.push(current.trim());
      current = "";
      continue;
    }
    current += tok;
  }
  terms.push(current.trim());
  return terms;
}

describe("buildLeaseCandidateQuery — the one lease SELECT (A6 / B2 / lesson 22)", () => {
  it("explicit GraphQL excludes mobile readers and requires the saved session without weakening budget gates", () => {
    const query=buildLeaseCandidateQuery(qb,{label:"followers",now:FIXED_NOW,viewer:{pin:true,rosterSource:"graphql",savedSessionOnly:true}}).toSQL();
    expect(query.sql).toContain('"bot_accounts"."transport" <> \'mobile\'');
    expect(query.sql).toMatch(/"bot_accounts"\."session_data" is not null/i);
    expect(query.sql).toContain('"bot_daily_calls"');
    expect(query.sql).toContain("backend_operation_leases");
    expect(()=>buildLeaseCandidateQuery(qb,{label:"posts",viewer:{pin:true,rosterSource:"graphql"}})).toThrow("requires a roster endpoint");
  });
  it("uses endpoint-specific evidence as posts/profile ordering, never as an eligibility gate", () => {
    const posts = leaseSql("posts");
    expect(posts.sql).toContain("FROM scrape_outcome_log recent");
    expect(posts.sql.indexOf("FROM scrape_outcome_log recent")).toBeGreaterThan(posts.sql.indexOf(" order by "));
    expect(posts.params).toContainEqual(new Date(FIXED_NOW.getTime() - 3600_000));
    const profile = leaseSql("profile");
    expect(profile.sql).toContain("recent.endpoint = 'profile'");
    expect(profile.sql.indexOf("FROM scrape_outcome_log recent")).toBeGreaterThan(profile.sql.indexOf(" order by "));
    expect(profile.params).toContainEqual(new Date(FIXED_NOW.getTime() - 6 * 3600_000));
    expect(profile.sql).not.toContain("recent.endpoint = 'posts'");
    for (const label of PRODUCTION_LEASE_LABELS.filter(label => label !== "posts" && label !== "profile")) {
      expect(leaseSql(label).sql).not.toContain("FROM scrape_outcome_log recent");
    }
  });
  it("only ever leases role='scraper' bots, for every production label", () => {
    for (const label of PRODUCTION_LEASE_LABELS) {
      const { sql, params } = leaseSql(label);
      expect(sql).toMatch(/"bot_accounts"\."role" = \$\d+/);
      expect(params).toContain("scraper");
    }
  });

  it("gates on today's bot_daily_calls row with the per-transport max cap (posts: mobile 60, web unlimited)", () => {
    const { sql, params } = leaseSql("posts");
    expect(sql).toMatch(/not exists \(\s*select 1 from "bot_daily_calls"/i);
    expect(sql).toMatch(/"bot_daily_calls"\."bot_id" = "bot_accounts"\."id"/);
    expect(sql).toMatch(/"bot_daily_calls"\."day" = \$\d+::date/);
    expect(sql).toMatch(
      /case\s+when "bot_accounts"\."transport" = 'mobile'\s+then \$\d+::int\s+else \$\d+::int\s+end/i,
    );
    expect(params).toContain("2026-09-02"); // UTC day key — the key daily-budget writes
    expect(params).toContain("posts");
    expect(params).toContain(60); // MOBILE_DAILY_CAP default: exact cap for mobile bots
    expect(params).toContain(1_000_000); // web posts is unlimited: gate is a no-op for web
  });

  it("normalizes the label the way the budget does (following → followers)", () => {
    const { params } = leaseSql("following");
    expect(params).toContain("followers");
    expect(params).not.toContain("following");
  });

  it("uses the matured-tier cap as the web bound for finite endpoints", () => {
    for (const label of ["likers", "stories", "highlights", "comments"] as const) {
      expect(leaseSql(label).params).toEqual(expect.arrayContaining([30, 0]));
    }
  });

  it("emits no budget gate when there is no label to budget", () => {
    expect(leaseSql(undefined).sql).not.toMatch(/bot_daily_calls/);
  });

  it("keeps web-only labels off mobile bots and lets profile/posts use them", () => {
    for (const label of ["likers", "stories", "highlights", "comments"] as const) {
      expect(leaseSql(label).sql).toMatch(/"bot_accounts"\."transport" <> 'mobile'/);
    }
    for (const label of ["profile", "posts"] as const) {
      expect(leaseSql(label).sql).not.toMatch(/"bot_accounts"\."transport" <> 'mobile'/);
    }
  });

  it("ORDER BY carries no bare literal (lesson 22: a bare 0 is a positional reference)", () => {
    for (const label of [...PRODUCTION_LEASE_LABELS, undefined]) {
      const terms = topLevelOrderByTerms(leaseSql(label).sql);
      expect(terms.length).toBeGreaterThanOrEqual(5);
      for (const term of terms) {
        expect(term).not.toMatch(/^\$?\d+(\s+(asc|desc))?(\s+nulls\s+(first|last))?$/i);
        expect(term).toMatch(/^(case\b|\(|")/i);
      }
    }
  });

  it("locks exactly one candidate with SKIP LOCKED, like the runtime transaction", () => {
    expect(leaseSql("profile").sql).toMatch(/limit \$\d+ for update skip locked$/i);
  });
});

// ── MOBILE_ONLY_ENDPOINTS: the mirror gate (2026-09-05 login wall) ──────────
//
// IG answers the web/pyhttpz lane on /api/v1/feed/user/ with HTTP 200 + an
// HTML login page: 8/4,718 web `posts` successes on 2026-09-04, 0/37 the next
// day, against 88-92% on mobile. `posts` is therefore routed to mobile only,
// and — the invariant that keeps this from taking an endpoint offline — a
// label can be mobile-ONLY only when it is also mobile-CAPABLE.

const MOBILE_ONLY_RE = /"bot_accounts"\."transport" = 'mobile'/;
const WEB_ONLY_RE = /"bot_accounts"\."transport" <> 'mobile'/;

/**
 * The WHERE conjuncts with every CASE…END blanked out. The daily-budget gate
 * contains `CASE WHEN "bot_accounts"."transport" = 'mobile' THEN …`, so a bare
 * match for the transport comparison would fire on every label and prove
 * nothing about the lane gate itself.
 */
function transportGatesOf(sqlText: string): string {
  return whereBodyOf(sqlText).replace(/\bcase\b[\s\S]*?\bend\b/gi, "<case>");
}

/**
 * Rebuild the lease SQL for a given MOBILE_ONLY_ENDPOINTS value. The set is
 * parsed once at module scope, so the module must be re-evaluated per case;
 * the drizzle mock is taken from the same fresh graph so the query is built
 * entirely out of one copy of drizzle-orm.
 */
async function leaseSqlWithMobileOnly(
  value: string | undefined,
  label: (typeof PRODUCTION_LEASE_LABELS)[number],
  mobileRosterEnabled?: string,
) {
  vi.stubEnv("MOBILE_ONLY_ENDPOINTS", value);
  if (mobileRosterEnabled !== undefined) {
    vi.stubEnv("MOBILE_ROSTER_ENABLED", mobileRosterEnabled);
  }
  vi.resetModules();
  try {
    const { drizzle: freshDrizzle } = await import("drizzle-orm/node-postgres");
    const fresh = await import("../ig-public-scraper.js");
    return fresh
      .buildLeaseCandidateQuery(freshDrizzle.mock(), { label, now: FIXED_NOW })
      .toSQL();
  } finally {
    // Restore the unset defaults for every other test.
    vi.stubEnv("MOBILE_ONLY_ENDPOINTS", undefined);
    vi.stubEnv("MOBILE_ROSTER_ENABLED", undefined);
    vi.resetModules();
  }
}

describe("MOBILE_ONLY_ENDPOINTS — posts is routed to the mobile lane only", () => {
  it("emits transport = 'mobile' for posts under the default config", () => {
    const { sql } = leaseSql("posts");
    expect(transportGatesOf(sql)).toMatch(MOBILE_ONLY_RE);
    expect(transportGatesOf(sql)).not.toMatch(WEB_ONLY_RE);
  });

  it("leaves web-only labels on the web lane (likers keeps <> 'mobile', never = 'mobile')", () => {
    const { sql } = leaseSql("likers");
    expect(transportGatesOf(sql)).toMatch(WEB_ONLY_RE);
    expect(transportGatesOf(sql)).not.toMatch(MOBILE_ONLY_RE);
  });

  it("does not gate the labels outside the set (profile stays open to both lanes)", () => {
    const { sql } = leaseSql("profile");
    expect(transportGatesOf(sql)).not.toMatch(MOBILE_ONLY_RE);
    expect(transportGatesOf(sql)).not.toMatch(WEB_ONLY_RE);
  });

  it("MOBILE_ONLY_ENDPOINTS=none removes the gate (the documented revert)", async () => {
    const { sql } = await leaseSqlWithMobileOnly("none", "posts");
    expect(transportGatesOf(sql)).not.toMatch(MOBILE_ONLY_RE);
    expect(transportGatesOf(sql)).not.toMatch(WEB_ONLY_RE);
  });

  it("an empty value disables the gate the same way", async () => {
    const { sql } = await leaseSqlWithMobileOnly("", "posts");
    expect(transportGatesOf(sql)).not.toMatch(MOBILE_ONLY_RE);
  });

  it("drops a label that is not mobile-capable — likers would strand the endpoint", async () => {
    // likers is web-only (mobile answers 403). Admitting it here would AND
    // `= 'mobile'` with `<> 'mobile'` and no bot could ever be leased.
    const { sql } = await leaseSqlWithMobileOnly("likers", "likers");
    expect(transportGatesOf(sql)).not.toMatch(MOBILE_ONLY_RE);
    expect(transportGatesOf(sql)).toMatch(WEB_ONLY_RE);
  });

  it("keeps the mobile-capable entries of a mixed list and drops the rest", async () => {
    expect(
      transportGatesOf((await leaseSqlWithMobileOnly("likers, posts", "posts")).sql),
    ).toMatch(MOBILE_ONLY_RE);
    expect(
      transportGatesOf((await leaseSqlWithMobileOnly("likers, posts", "likers")).sql),
    ).not.toMatch(MOBILE_ONLY_RE);
  });

  it("trims, lowercases, and ignores unknown labels", async () => {
    expect(
      transportGatesOf((await leaseSqlWithMobileOnly("  POSTS  ", "posts")).sql),
    ).toMatch(MOBILE_ONLY_RE);
    expect(
      transportGatesOf((await leaseSqlWithMobileOnly("not-an-endpoint", "posts")).sql),
    ).not.toMatch(MOBILE_ONLY_RE);
  });

  // The live ecosystem.config.cjs sets MOBILE_ROSTER_ENABLED=false, which
  // shrinks MOBILE_CAPABLE_ENDPOINTS to {profile, posts}. `posts` survives —
  // that is the whole point — while followers/following are dropped rather
  // than stranded with no leasable transport.
  it("holds under the production MOBILE_ROSTER_ENABLED=false config", async () => {
    expect(
      transportGatesOf(
        (await leaseSqlWithMobileOnly("posts", "posts", "false")).sql,
      ),
    ).toMatch(MOBILE_ONLY_RE);

    const followers = transportGatesOf(
      (await leaseSqlWithMobileOnly("posts,followers", "followers", "false")).sql,
    );
    expect(followers).not.toMatch(MOBILE_ONLY_RE);
    expect(followers).toMatch(WEB_ONLY_RE);
  });

  it("still carries no bare literal in the ORDER BY (lesson 22 holds under the gate)", () => {
    for (const term of topLevelOrderByTerms(leaseSql("posts").sql)) {
      expect(term).not.toMatch(/^\$?\d+(\s+(asc|desc))?(\s+nulls\s+(first|last))?$/i);
      expect(term).toMatch(/^(case\b|\(|")/i);
    }
  });
});

describe("maxEndpointDailyCap — the SQL bound is never below any tier's cap", () => {
  it("dominates every BUDGET_TABLE tier for every endpoint (web)", () => {
    for (const tier of BUDGET_TABLE) {
      for (const [endpoint, cap] of Object.entries(tier.caps)) {
        expect(maxEndpointDailyCap(endpoint, FIXED_NOW, "web")).toBeGreaterThanOrEqual(cap);
      }
    }
  });

  it("is the flat mobile cap for profile/posts and 0 for mobile-gated endpoints", () => {
    expect(maxEndpointDailyCap("posts", FIXED_NOW, "mobile")).toBe(60);
    expect(maxEndpointDailyCap("profile", FIXED_NOW, "mobile")).toBe(60);
    expect(maxEndpointDailyCap("likers", FIXED_NOW, "mobile")).toBe(0);
    expect(maxEndpointDailyCap("stories", FIXED_NOW, "mobile")).toBe(0);
  });

  it("uses the same finite budget in SQL and reservations when waiting is disabled", () => {
    const previous = process.env.BOT_READ_WARMUP_ENABLED;
    process.env.BOT_READ_WARMUP_ENABLED = "false";
    try {
      for (const [endpoint, cap] of Object.entries(READ_DAILY_CAPS)) {
        expect(maxEndpointDailyCap(endpoint, FIXED_NOW, "web")).toBe(cap);
        expect(endpointDailyCap(FIXED_NOW, endpoint, FIXED_NOW, "web")).toBe(cap);
      }
      expect(leaseSql("stories").params).toContain(30);
      expect(leaseSql("posts").params).toContain(50);
      expect(maxEndpointDailyCap("stories", FIXED_NOW, "mobile")).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.BOT_READ_WARMUP_ENABLED;
      else process.env.BOT_READ_WARMUP_ENABLED = previous;
    }
  });
});

// ── C5: httpFirst escalates to Chromium only for 2xx parse anomalies ─────────
//
// The browser shares the bot's identity and proxy lane. A status-0 network
// fault, a login wall, a 429 or a definitive IG status fail identically in
// Chromium — escalating them produced 1,865 launches for 151 stories/highlights
// outcomes in one day. Only an unclassified error (2xx body that did not map)
// may still launch the browser.

type WalkResult = { ok: true; users: unknown[] } | { ok: false; err: unknown };

describe("browser-dependent engagement never silently becomes HTTP", () => {
  const browserClient = {
    fetchMediaLikers: vi.fn(), fetchMediaComments: vi.fn(), close: vi.fn(async () => {}),
  };
  beforeEach(() => {
    vi.mocked(getScraperReadTransport).mockResolvedValue({ value: "http-first" } as never);
    vi.mocked(createBrowserReadClient).mockResolvedValue(browserClient as never);
    browserClient.fetchMediaLikers.mockResolvedValue({ users: buildRawUsers(2, "visible") });
    browserClient.fetchMediaComments.mockResolvedValue({ comments: [], hasMore: false, nextMaxId: null });
  });
  afterEach(() => {
    vi.mocked(getScraperReadTransport).mockResolvedValue({ value: "http" } as never);
  });
  it("uses browser likers directly, with HTTP fallback disabled", async () => {
    expect(await scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).toHaveLength(2);
    expect(browserClient.fetchMediaLikers).toHaveBeenCalledWith("media-1");
    expect(fakeClient.fetchMediaLikers).not.toHaveBeenCalled();
    expect(createBrowserReadClient).toHaveBeenCalledWith(expect.objectContaining({ fallbackToHttp: false }));
  });
  it("keeps empty browser comments as a fresh result, not an excuse to retry HTTP", async () => {
    expect(await scrapeMediaCommentsWithBot(BOT_ID, "SC1", "media-1")).toEqual([]);
    expect(browserClient.fetchMediaComments).toHaveBeenCalledTimes(1);
    expect(fakeClient.fetchMediaComments).not.toHaveBeenCalled();
  });
  it("rejects incomplete comments instead of reporting a complete empty list", async () => {
    browserClient.fetchMediaComments.mockResolvedValueOnce({ comments: [], hasMore: true, nextMaxId: null });
    await expect(scrapeMediaCommentsWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow("pagination is incomplete");
  });
  it("checks access before each comment page and stops before another reservation", async () => {
    browserClient.fetchMediaComments.mockResolvedValueOnce({ comments: [], hasMore: true, nextMaxId: "next" });
    const beforePage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("grant revoked"));
    vi.useFakeTimers();
    const outcome = scrapeMediaCommentsWithBot(BOT_ID, "SC1", "media-1", { beforePage }).then(() => null, error => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ message: expect.stringContaining("grant revoked") });
    expect(browserClient.fetchMediaComments).toHaveBeenCalledOnce();
    expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, "comments"]]);
  });
  it("does not hide a browser failure behind an unverified HTTP response", async () => {
    browserClient.fetchMediaLikers.mockRejectedValueOnce(new Error("browser failed"));
    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();
    expect(fakeClient.fetchMediaLikers).not.toHaveBeenCalled();
  });
});

describe("httpFirst browser escalation (C5)", () => {
  const browserClient = {
    fetchFollowers: vi.fn(),
    close: vi.fn(async () => {}),
  };

  beforeEach(() => {
    vi.mocked(getScraperReadTransport).mockResolvedValue({
      value: "http-first",
      source: "env",
      loadedAt: 0,
    } as never);
    vi.mocked(createBrowserReadClient).mockResolvedValue(browserClient as never);
    browserClient.fetchFollowers.mockResolvedValue({
      users: buildRawUsers(2, "browser"),
      nextMaxId: null,
    });
  });

  afterEach(() => {
    vi.mocked(getScraperReadTransport).mockResolvedValue({ value: "http" } as never);
  });

  async function walkOnePage(): Promise<WalkResult> {
    vi.useFakeTimers();
    const settled: Promise<WalkResult> = scrapeUserFollowersWithBot(BOT_ID, "999", {
      maxPages: 1,
      maxItems: 100,
    }).then(
      (users) => ({ ok: true as const, users: [...users] }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await vi.runAllTimersAsync();
    return settled;
  }

  it("does NOT launch Chromium for a status-0 network fault (same dead lane)", async () => {
    const err = new MockHttpError("[ig-http] network error for GET followers") as MutableHttpError;
    err.status = 0;
    fakeClient.fetchFollowers.mockRejectedValueOnce(err);

    expect((await walkOnePage()).ok).toBe(false);
    expect(createBrowserReadClient).not.toHaveBeenCalled();
  });

  it("does NOT launch Chromium for a login wall", async () => {
    fakeClient.fetchFollowers.mockRejectedValueOnce(
      new IGLoginWallError("followers", undefined, new Error("html body")),
    );

    expect((await walkOnePage()).ok).toBe(false);
    expect(createBrowserReadClient).not.toHaveBeenCalled();
  });

  it("does NOT launch Chromium for a 429 or a definitive IG status", async () => {
    fakeClient.fetchFollowers.mockRejectedValueOnce(new MockRateLimited("[ig-http] rate limited"));
    expect((await walkOnePage()).ok).toBe(false);

    const err = new MockHttpError("[ig-http] GET followers failed with status 404") as MutableHttpError;
    err.status = 404;
    fakeClient.fetchFollowers.mockRejectedValueOnce(err);
    expect((await walkOnePage()).ok).toBe(false);

    expect(createBrowserReadClient).not.toHaveBeenCalled();
  });

  it("does not replay an unsupported follower UI fallback through browser APIs", async () => {
    fakeClient.fetchFollowers.mockRejectedValueOnce(
      new Error("[ig-http] unexpected shape for GET followers: users missing"),
    );

    const result = await walkOnePage();
    expect(createBrowserReadClient).not.toHaveBeenCalled();
    expect(createNativeBrowserReadClient).not.toHaveBeenCalled();
    expect(browserClient.fetchFollowers).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

// ── B6/D8: every timed cooldown reason is prefixed (lesson 16) ───────────────

describe("timed cooldown reasons written by the scraper are prefixed (B6/D8)", () => {
  function reasonsWritten(): string[] {
    return dbState.updateSets
      .map((s) => s.lastLoginError)
      .filter((r): r is string => typeof r === "string");
  }

  it("useragent mismatch → 'cooldown: useragent mismatch …' (5-min bench, session wiped)", async () => {
    const err = new MockHttpError("[ig-http] GET likers failed with status 400") as MutableHttpError;
    err.status = 400;
    err.url = "https://www.instagram.com/api/v1/media/1/likers/";
    err.body = '{"message":"useragent mismatch","status":"fail"}';
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);

    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();

    const reasons = reasonsWritten();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^cooldown: useragent mismatch on https:\/\/.*; session invalidated$/);
  });

  it("IG's 401 'please wait' throttle → 'cooldown: ig web throttle (HTTP 401): …'", async () => {
    const err = new MockAuthExpired("[ig-http] auth rejected (status 401)") as MutableAuthError;
    err.status = 401;
    err.body =
      '{"message":"Please wait a few minutes before you try again.","require_login":true,"igweb_rollout":true,"status":"fail"}';
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(err);

    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();

    const reasons = reasonsWritten();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^cooldown: ig web throttle \(HTTP 401\): /);
    // admin-routes' rateLimitedBots counter greps this phrase unanchored — still matches.
    expect(reasons[0]).toMatch(/please wait a few minutes/i);
  });

  it("browser proxy transport failure → 'cooldown: browser proxy transport failure: …' (lane wiped)", async () => {
    fakeClient.fetchMediaLikers.mockRejectedValueOnce(
      new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://www.instagram.com/"),
    );

    await expect(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1")).rejects.toThrow();

    const set = dbState.updateSets.find((s) =>
      String(s.lastLoginError ?? "").includes("browser proxy transport failure"),
    );
    expect(set).toBeDefined();
    expect(String(set!.lastLoginError)).toMatch(/^cooldown: browser proxy transport failure: /);
    expect(set).toMatchObject({ proxyEndpoint: null, proxySessionId: null });
  });

  it("nothing written above escaped the prefix", () => {
    for (const reason of reasonsWritten()) expect(reason.startsWith("cooldown: ")).toBe(true);
  });
});

// ── Audit 2026-09-03 (lane B/D) ─────────────────────────────────────────────
//
//   B4 — the first-touch guard is a WHERE predicate for the sensitive
//        endpoints (likers / followers / following / comments), not only an
//        ORDER BY demotion: 6 of 105 fresh imports were suspended on their
//        FIRST request, all on these endpoints.
//   D5 — classifyError classifies by class/status first (IGAuthExpiredError →
//        `auth`, throttle-body 401 → `rate_limit`, IGCircuitOpenError → `skip`)
//        and only then by word-bounded message text.
//   D6 — an OPEN breaker for (bot, family) is checked BEFORE the client build
//        and the daily-budget reservation; the bot is skipped with a rotate-now
//        cause and no unit is burned (80 units on 2026-09-02).
//   D7 — leasableBotSqlPredicate() is the ONE bot-level leasable definition;
//        the lease WHERE is literally that fragment plus endpoint parts.

import { botAccounts } from "../../shared/schema.js";
import {
  getBreakerSnapshot,
  recordFailure as breakerRecordFailure,
  resetBreaker,
} from "../domain/ig-circuit-breaker.js";
import { IGCircuitOpenError } from "../domain/ig-client-port.js";
import { recordOutcome } from "../services/scrape-metrics.js";
import {
  FIRST_TOUCH_SENSITIVE_ENDPOINTS,
  IGPublicScraperError,
  breakerKeyForLease,
  classifyError,
  leasableBotSqlPredicate,
} from "../ig-public-scraper.js";

const FIRST_TOUCH_GUARD_RE =
  /\("bot_accounts"\."last_used_at" is not null or "bot_accounts"\."last_warming_at" is not null\)/;

function whereBodyOf(sqlText: string): string {
  const start = sqlText.indexOf(" where ");
  const end = sqlText.lastIndexOf(" order by ");
  expect(start).toBeGreaterThan(-1);
  return sqlText.slice(start + " where ".length, end === -1 ? undefined : end);
}

describe("first-touch guard is a predicate for sensitive endpoints (B4)", () => {
  it("requires prior use OR warming for likers / followers / following / comments", () => {
    for (const label of ["likers", "followers", "following", "comments"] as const) {
      expect(FIRST_TOUCH_SENSITIVE_ENDPOINTS.has(label)).toBe(true);
      expect(whereBodyOf(leaseSql(label).sql)).toMatch(FIRST_TOUCH_GUARD_RE);
    }
  });

  it("lets a fresh bot take profile / posts / stories / highlights and unlabelled leases", () => {
    for (const label of ["profile", "posts", "stories", "highlights", undefined] as const) {
      expect(FIRST_TOUCH_SENSITIVE_ENDPOINTS.has(label as never)).toBe(false);
      expect(whereBodyOf(leaseSql(label).sql)).not.toMatch(FIRST_TOUCH_GUARD_RE);
    }
  });

  it("keeps the ORDER BY demotion for likers (a proven session still goes first)", () => {
    const terms = topLevelOrderByTerms(leaseSql("likers").sql);
    expect(terms.some((t) => /"last_used_at" is null then 1 else 0 end/i.test(t))).toBe(true);
  });

  it("is two-valued (lesson 23): both columns are tested with IS NOT NULL, never compared", () => {
    const { sql } = leaseSql("likers");
    expect(sql).not.toMatch(/"last_warming_at" (<|>|=|<>)/);
    expect(sql).not.toMatch(/"last_used_at" (<|>|=|<>)/);
  });
});

describe("leasableBotSqlPredicate — the ONE leasable definition (D7)", () => {
  function predicateSql() {
    return qb
      .select()
      .from(botAccounts)
      .where(leasableBotSqlPredicate({ now: FIXED_NOW }))
      .toSQL();
  }

  it("carries status, role, tier, cooldown timing, the `cooldown:` carve-out, the mobile identity OR and the lane rules", () => {
    const { sql, params } = predicateSql();
    expect(sql).toMatch(/"bot_accounts"\."status" = \$\d+/);
    expect(params).toContain("available");
    expect(sql).toMatch(/"bot_accounts"\."role" = \$\d+/);
    expect(params).toContain("scraper");
    expect(params).toEqual(expect.arrayContaining(["worker", "canary"]));
    expect(sql).toMatch(
      /"bot_accounts"\."cooldown_until" is null or "bot_accounts"\."cooldown_until" < \$\d+/,
    );
    // drizzle maps the Date to the driver value (ISO string) in toSQL().
    expect(
      params.some(
        (p) =>
          p === FIXED_NOW.toISOString() ||
          (p instanceof Date && p.getTime() === FIXED_NOW.getTime()),
      ),
    ).toBe(true);
    expect(sql).toMatch(/COALESCE\("bot_accounts"\."last_login_error", ''\) LIKE \$\d+/);
    expect(params).toContain("cooldown: %");
    expect(sql).toMatch(/COALESCE\("bot_accounts"\."last_login_error", ''\) !~\* \$\d+/);
    expect(sql).toMatch(
      /"bot_accounts"\."automation_identity" is not null or "bot_accounts"\."transport" = \$\d+/,
    );
    expect(params).toContain("mobile");
    expect(sql).toMatch(/"bot_accounts"\."proxy_expires_at" > NOW\(\) \+ INTERVAL '2 minutes'/);
  });

  it("has no endpoint-specific part: no budget gate, no transport exclusion, no first-touch guard", () => {
    const { sql } = predicateSql();
    expect(sql).not.toMatch(/bot_daily_calls/);
    expect(sql).not.toMatch(/<> 'mobile'/);
    expect(sql).not.toMatch(FIRST_TOUCH_GUARD_RE);
  });

  it("is the literal prefix of every production lease WHERE (lease = predicate + endpoint parts)", () => {
    const fragment = whereBodyOf(predicateSql().sql);
    expect(fragment.startsWith("(")).toBe(true);
    for (const label of [...PRODUCTION_LEASE_LABELS, undefined]) {
      const body = whereBodyOf(leaseSql(label).sql);
      // The lease is `and(predicate, …)`, so its WHERE opens with the fragment.
      expect(body.startsWith(`(${fragment}`)).toBe(true);
    }
  });
});

describe("classifyError — class and status before message text (D5)", () => {
  const throttleBody =
    '{"message":"Espera unos minutos antes de volver a intentarlo.","require_login":true,"igweb_rollout":true,"status":"fail"}';

  function httpError(status: number, message: string, igErrorCode?: string) {
    const err = new MockHttpError(message) as MutableHttpError & { igErrorCode?: string };
    err.status = status;
    if (igErrorCode) err.igErrorCode = igErrorCode;
    return err;
  }

  it("IGAuthExpiredError is `auth`, not a generic failure", () => {
    const rejected = new MockAuthExpired("Instagram session cookies rejected (401/403)") as MutableAuthError;
    rejected.status = 401;
    rejected.body = '{"message":"login_required","status":"fail"}';
    expect(classifyError(rejected)).toBe("auth");

    const forbidden = new MockAuthExpired("auth rejected (status 403)") as MutableAuthError;
    forbidden.status = 403;
    expect(classifyError(forbidden)).toBe("auth");

    // No status: the client refused to send (missing sessionid / csrftoken).
    expect(classifyError(new MockAuthExpired("sessionid cookie missing"))).toBe("auth");
  });

  it("IG's 'please wait' 401 throttle is a rate limit on a still-valid session", () => {
    const viaAuth = new MockAuthExpired("auth rejected (status 401)") as MutableAuthError;
    viaAuth.status = 401;
    viaAuth.body = throttleBody;
    expect(classifyError(viaAuth)).toBe("rate_limit");

    const viaHttp = httpError(401, "[ig-http] GET likers failed with status 401");
    viaHttp.body = throttleBody;
    expect(classifyError(viaHttp)).toBe("rate_limit");
  });

  it("an open breaker is a skip — no IG call was made", () => {
    const open = new IGCircuitOpenError(Date.now() + 60_000);
    expect(classifyError(open)).toBe("skip");
    expect(classifyError(new IGPublicScraperError("[ig-public-scraper] wrapped", open))).toBe("skip");
  });

  it("unwraps the IGPublicScraperError wrapper to the root cause", () => {
    const auth = new MockAuthExpired("auth rejected (status 403)") as MutableAuthError;
    auth.status = 403;
    const wrapped = new IGPublicScraperError(
      "[ig-public-scraper] failed to build IG client for bot x",
      new IGPublicScraperError("[ig-public-scraper] inner", auth),
    );
    expect(classifyError(wrapped)).toBe("auth");
  });

  it("IGHttpError: 429 → rate_limit, status 0 → network, checkpoint/challenge → checkpoint, 401/403 → auth, 404 → failure", () => {
    expect(classifyError(httpError(429, "[ig-http] GET likers failed with status 429"))).toBe("rate_limit");
    expect(classifyError(httpError(0, "[ig-http] network error for GET likers"))).toBe("network");
    expect(classifyError(httpError(400, "[ig-http] HTTP 400", "checkpoint_required"))).toBe("checkpoint");
    expect(classifyError(httpError(400, "[ig-mobile] HTTP 400", "challenge_required"))).toBe("checkpoint");
    expect(classifyError(httpError(403, "[ig-http] GET likers failed with status 403"))).toBe("auth");
    expect(classifyError(httpError(401, "[ig-http] GET likers failed with status 401"))).toBe("auth");
    expect(classifyError(httpError(404, "[ig-http] GET followers failed with status 404"))).toBe("failure");
  });

  it("IGRateLimitedError is a rate limit regardless of its message", () => {
    expect(classifyError(new MockRateLimited("slow down"))).toBe("rate_limit");
  });

  it("message fallbacks are word-bounded: 'generate' / 'separate' are not rate limits", () => {
    expect(classifyError(new Error("failed to generate report"))).toBe("failure");
    expect(classifyError(new Error("separate row missing"))).toBe("failure");
    expect(classifyError(new Error("Failed query: select 1"))).toBe("failure");
    expect(classifyError(new Error("rate limited by upstream"))).toBe("rate_limit");
    expect(classifyError(new Error("request throttled"))).toBe("rate_limit");
    expect(classifyError(new Error("socket hang up"))).toBe("network");
    expect(classifyError(new Error("browser proxy transport failure: lane 10925"))).toBe("network");
    expect(classifyError("checkpoint_required")).toBe("checkpoint");
  });
});

describe("breaker pre-check before the budget reservation (D6)", () => {
  const LIKERS_KEY = breakerKeyForLease(BOT_ID, "likers", "web");

  // 10 samples at 100% failure trips it (MIN_SAMPLES / threshold in ig-circuit-breaker.ts).
  function tripBreaker(key: string): void {
    for (let i = 0; i < 10; i += 1) breakerRecordFailure(key);
    expect(getBreakerSnapshot(key).state).toBe("OPEN");
  }

  afterEach(() => {
    resetBreaker();
  });

  it("maps a lease label to the family each transport actually keys the breaker on", () => {
    expect(breakerKeyForLease("b", "likers", "web")).toBe("b:likers");
    expect(breakerKeyForLease("b", "followers", "web")).toBe("b:followers");
    expect(breakerKeyForLease("b", "following", "web")).toBe("b:following");
    expect(breakerKeyForLease("b", "comments", "web")).toBe("b:comments");
    expect(breakerKeyForLease("b", "profile", "web")).toBe("b:profile");
    expect(breakerKeyForLease("b", "posts", "web")).toBe("b:posts");
    expect(breakerKeyForLease("b", "highlights", "web")).toBe("b:highlights");
    // The web client reads stories through /feed/reels_media/ — the highlights family.
    expect(breakerKeyForLease("b", "stories", "web")).toBe("b:highlights");
    expect(breakerKeyForLease("b", "posts", "mobile")).toBe("b:feed");
    expect(breakerKeyForLease("b", "profile", "mobile")).toBe("b:profile");
  });

  it("an OPEN breaker skips the bot BEFORE the client is built or a budget unit is reserved", async () => {
    tripBreaker(LIKERS_KEY);

    const thrown = await captureRejection(scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1"));
    expect(thrown).toBeInstanceOf(IGPublicScraperError);
    expect((thrown as IGPublicScraperError).cause).toBeInstanceOf(IGCircuitOpenError);

    expect(reserveOrThrow).not.toHaveBeenCalled();
    expect(createHttpBotClientWithFingerprint).not.toHaveBeenCalled();
    expect(fakeClient.fetchMediaLikers).not.toHaveBeenCalled();
    // A skip, never a persisted failure.
    expect(recordOutcome).toHaveBeenCalledWith("likers", "skip", BOT_ID);
    expect(recordOutcome).not.toHaveBeenCalledWith("likers", "failure", expect.anything());
    // The bot was released (lastUsedAt touched) so LRU rotation moves on.
    expect(dbState.updateSets.some((s) => "lastUsedAt" in s)).toBe(true);
    // Nothing happened to the session: no cooldown, no streak.
    expect(cooldownMocks.recordHardFailure).not.toHaveBeenCalled();
    expect(cooldownMocks.cooldownBotForCheckpoint).not.toHaveBeenCalled();
  });

  it("a breaker open on ANOTHER family does not block this lease", async () => {
    tripBreaker(breakerKeyForLease(BOT_ID, "followers", "web"));
    await scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1");
    expect(reserveOrThrow).toHaveBeenCalledTimes(1);
    expect(fakeClient.fetchMediaLikers).toHaveBeenCalledTimes(1);
  });

  it("once the open timer has lapsed the lease proceeds (the HALF_OPEN probe must happen)", async () => {
    tripBreaker(LIKERS_KEY);
    const openUntil = getBreakerSnapshot(LIKERS_KEY).openUntil;
    expect(openUntil).not.toBeNull();
    vi.useFakeTimers();
    vi.setSystemTime((openUntil as number) + 1);

    await scrapeMediaLikersWithBot(BOT_ID, "SC1", "media-1");
    expect(reserveOrThrow).toHaveBeenCalledTimes(1);
    expect(fakeClient.fetchMediaLikers).toHaveBeenCalledTimes(1);
  });
});

describe("isBrowserLaneFault (stories retry on another bot)", () => {
  it("treats the status-0 sentinel, FastAPI 502s and Firefox navigation errors as lane faults", () => {
    expect(isBrowserLaneFault(new MockHttpError(0, "[ig-http] network error (UND_ERR_SOCKET) GET highlights"))).toBe(true);
    expect(isBrowserLaneFault(new Error("wrapped", { cause: new Error("automation request failed: 502 Bad Gateway") }))).toBe(true);
    expect(isBrowserLaneFault(new Error("Page.goto: NS_ERROR_PROXY_BAD_GATEWAY"))).toBe(true);
    expect(isBrowserLaneFault(new Error("Page.goto: Timeout 30000ms exceeded."))).toBe(true);
  });
  it("never retries account-level refusals or ordinary HTTP statuses", () => {
    expect(isBrowserLaneFault(Object.assign(new MockHttpError(401, "auth rejected"), { status: 401 }))).toBe(false);
    expect(isBrowserLaneFault(Object.assign(new MockHttpError(429, "rate limited"), { status: 429 }))).toBe(false);
    expect(isBrowserLaneFault(new Error("checkpoint_required"))).toBe(false);
  });
});


describe("bounded public post windows", () => {
  const post = (id: string) => ({ id, code: `CODE${id}`, mediaType: 1, productType: null,
    caption: null, pinnedUserIds: [], carouselMedia: null });
  const page = (ids: string[], nextMaxId: string | null, moreAvailable = !!nextMaxId) => ({
    items: ids.map(post), nextMaxId, moreAvailable,
  });
  beforeEach(() => fakeClient.fetchUserFeed.mockReset());
  it("reserves every actual page before its provider call and deduplicates overlapping posts", async () => {
    fakeClient.fetchUserFeed.mockResolvedValueOnce(page(["1", "2"], "cursor-a"))
      .mockResolvedValueOnce(page(["2", "3"], null));
    const result = await scrapeUserPosts("123", 4);
    expect(result.map(post => post.mediaId)).toEqual(["1", "2", "3"]);
    expect(fakeClient.fetchUserFeed.mock.calls).toEqual([["123", { count: 4, maxId: undefined }], ["123", { count: 2, maxId: "cursor-a" }]]);
    expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, "posts"], [BOT_ID, "posts"]]);
    expect(reserveOrThrow.mock.invocationCallOrder[1]).toBeLessThan(fakeClient.fetchUserFeed.mock.invocationCallOrder[1]);
    expect(dbState.txCalls).toBe(1);
  });
  it("rejects an empty continuation instead of looping on its cursor", async () => {
    fakeClient.fetchUserFeed.mockResolvedValue(page([], "same", true));
    await expect(scrapeUserPosts("123", 12)).rejects.toThrow("did not advance");
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledOnce();
    expect(reserveOrThrow).toHaveBeenCalledOnce();
    expect(fakeClient.close).toHaveBeenCalled();
  });
  it("rejects a repeated cursor even when each response supplies another post", async () => {
    fakeClient.fetchUserFeed.mockResolvedValueOnce(page(["1"], "same"))
      .mockResolvedValueOnce(page(["2"], "same"));
    await expect(scrapeUserPosts("123", 3)).rejects.toThrow("repeats a cursor");
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledTimes(2);
  });
  it("rejects a missing continuation cursor instead of reporting an incomplete window as success", async () => {
    fakeClient.fetchUserFeed.mockResolvedValueOnce(page(["1"], null, true));
    await expect(scrapeUserPosts("123", 3)).rejects.toThrow("pagination is incomplete");
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledOnce();
  });
  it("rejects duplicate-only pages even when their cursors keep changing", async () => {
    fakeClient.fetchUserFeed.mockResolvedValueOnce(page(["1"], "first"))
      .mockResolvedValueOnce(page(["1"], "second"));
    await expect(scrapeUserPosts("123", 3)).rejects.toThrow("did not advance");
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledTimes(2);
  });
  it("enforces a finite page cap without returning its incomplete partial result", async () => {
    fakeClient.fetchUserFeed.mockImplementation(async () => {
      const number = fakeClient.fetchUserFeed.mock.calls.length;
      return page([String(number)], `cursor-${number}`);
    });
    await expect(scrapeUserPosts("123", 24)).rejects.toThrow("page limit reached");
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledTimes(20);
    expect(reserveOrThrow).toHaveBeenCalledTimes(20);
  });
  it("keeps an explicitly empty final feed valid", async () => {
    fakeClient.fetchUserFeed.mockResolvedValueOnce(page([], null));
    await expect(scrapeUserPosts("123", 12)).resolves.toEqual([]);
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledOnce();
  });
  it("returns a satisfied window without following its remaining cursor", async () => {
    fakeClient.fetchUserFeed.mockResolvedValueOnce(page(["1", "2"], "later"));
    expect(await scrapeUserPosts("123", 2)).toHaveLength(2);
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledOnce();
  });
  it("stops before another provider read when its next daily reservation fails", async () => {
    fakeClient.fetchUserFeed.mockResolvedValueOnce(page(["1"], "next"));
    reserveOrThrow.mockResolvedValueOnce({ allowed: true, used: 1, cap: 1, endpoint: "posts" })
      .mockRejectedValueOnce(new Error("daily budget exhausted"));
    await expect(scrapeUserPosts("123", 2)).rejects.toThrow("daily budget exhausted");
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledOnce();
  });
  it("rechecks entitlement between pages before another reservation", async () => {
    trackedAccountHasAccess.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    fakeClient.fetchUserFeed.mockResolvedValueOnce(page(["1"], "next"));
    await expect(withScrapeContext({ userId: "customer", trackedAccountId: "account", username: "fixture" }, () => scrapeUserPosts("123", 2)))
      .rejects.toThrow("access ended");
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledOnce();
    expect(reserveOrThrow).toHaveBeenCalledOnce();
  });
  it("honors a lost operation lease before fetching another page", async () => {
    const controller = new AbortController();
    fakeClient.fetchUserFeed.mockImplementationOnce(async () => {
      controller.abort(new Error("lease lost")); return page(["1"], "next");
    });
    await expect(withOperationSignal(controller.signal, () => scrapeUserPosts("123", 2))).rejects.toThrow("lease lost");
    expect(fakeClient.fetchUserFeed).toHaveBeenCalledOnce();
    expect(reserveOrThrow).toHaveBeenCalledOnce();
  });
  it.each([NaN, Infinity, 0, 481])("rejects an unbounded or invalid requested window before leasing: %s", async limit => {
    await expect(scrapeUserPosts("123", limit)).rejects.toThrow("Posts window must be");
    expect(fakeClient.fetchUserFeed).not.toHaveBeenCalled();expect(dbState.txCalls).toBe(0);
  });
});


describe.each([
  ["clips", scrapeUserClips, "fetchUserClips", "reel"],
  ["tagged", scrapeUserTagged, "fetchUserTagged", "tagged_post"],
] as const)("%s windows use the same quota and progress guards", (label, read, method, postType) => {
  const item = (id: string) => ({ id, code: `CODE${id}`, mediaType: 1, productType: null, caption: null, pinnedUserIds: [123], carouselMedia: null });
  beforeEach(() => fakeClient[method].mockReset());
  it("reserves each page and preserves the tab-specific post type", async () => {
    fakeClient[method].mockResolvedValueOnce({ items: [item("1")], moreAvailable: true, nextMaxId: "next" })
      .mockResolvedValueOnce({ items: [item("2")], moreAvailable: false, nextMaxId: null });
    const result = await read("123", 2);
    expect(result).toHaveLength(2);
    expect(result.every(row => row.postType === postType && row.isPinned === false)).toBe(true);
    expect(reserveOrThrow.mock.calls).toEqual([[BOT_ID, label], [BOT_ID, label]]);
  });
  it("stops an empty continuing page after one call", async () => {
    fakeClient[method].mockResolvedValue({ items: [], moreAvailable: true, nextMaxId: "same" });
    await expect(read("123", 2)).rejects.toThrow("did not advance");
    expect(fakeClient[method]).toHaveBeenCalledOnce();
  });
  it("stops a repeated cursor after two calls", async () => {
    fakeClient[method].mockResolvedValueOnce({ items: [item("1")], moreAvailable: true, nextMaxId: "same" })
      .mockResolvedValueOnce({ items: [item("2")], moreAvailable: true, nextMaxId: "same" });
    await expect(read("123", 3)).rejects.toThrow("repeats a cursor");
    expect(fakeClient[method]).toHaveBeenCalledTimes(2);
  });
});
