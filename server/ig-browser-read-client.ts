// ─── Browser-backed IG read client ──────────────────────────────────────────
//
// Explicit browser API transport for public-data collection. This adapter
// replays endpoint requests inside the page; it does not extract the normal UI.
// Genuine UI fallbacks use the native public-page reader instead. It keeps the
// IGClientPort contract but runs reads from a real Chromium context with the
// bot's Playwright storage-state cookies, stable user agent, locale, timezone,
// and assigned proxy. The browser still requests Instagram's web endpoints;
// the difference is that network/TLS/cookie behavior now comes from Chrome
// instead of Node's HTTP runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { currentScrapeOperation } from "./services/scrape-operation.js";
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  Page,
} from "playwright";

import type {
  IGClientPort,
  IGFeedPage,
  IGFriendshipPage,
  IGHighlightsTray,
  IGHighlightReel,
  IGStoriesTray,
  IGCommentsPage,
  IGLikersPage,
  IGProfile,
} from "./domain/ig-client-port.js";
import {
  parseClipsResponse,
  parseCommentsResponse,
  parseFeedResponse,
  parseFriendshipPageResponse,
  parseLikersResponse,
  parseProfileResponse,
} from "./domain/ig-schemas.js";
import {
  parseHighlightReelsResponse,
  parseHighlightsTrayResponse,
} from "./domain/ig-stories-schemas.js";
import type { DeviceFingerprint } from "./behavior/device-fingerprint.js";
import { createHttpBotClientWithFingerprint, IGAuthExpiredError, IGHttpError, IGRateLimitedError } from "./ig-http-client.js";
import type { AutomationIdentity } from "./services/automation-client.js";
import { proxyAgentUriForEndpoint } from "./services/proxy-provider.js";
import { logger as baseLogger } from "./observability/logger.js";
import { recordBytes } from "./services/bandwidth-meter.js";
import { endpointFamilyFromUrl } from "./domain/ig-circuit-breaker.js";
import { inspectInstagramAuthResponse } from "./services/instagram-auth-diagnostics.js";
import { classifyInstagramResponse } from "./services/ig-response-diagnostics.js";
import { sendBrowserFollow } from "./services/bot-follow-browser.js";
import { playwrightSendFollowByUsername } from "./ig-playwright-client.js";

const logger = baseLogger.child({ module: "ig-browser-read-client" });

const IG_WEB_ORIGIN = "https://www.instagram.com";
const NAV_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 35_000;

type PlaywrightModule = typeof import("playwright");

interface BrowserJsonResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  text: string;
}

interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None" | string;
  }>;
  origins?: unknown[];
}

export interface BrowserReadClientOptions {
  readonly sessionData: string;
  readonly fingerprint: DeviceFingerprint;
  readonly botUsername: string;
  readonly proxyEndpoint?: string | null;
  readonly botId?: string | null;
  readonly fallbackToHttp?: boolean;
  /** An explicit FastAPI identity replaces this module's legacy Chromium path. */
  readonly automationIdentity?: AutomationIdentity | null;
}

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return await import("playwright");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[ig-browser-read] playwright unavailable",
    );
    return null;
  }
}

function parseStorageState(sessionData: string): StorageState {
  const parsed = JSON.parse(sessionData);
  if (!parsed || !Array.isArray(parsed.cookies)) {
    throw new Error("[ig-browser-read] sessionData missing cookies[]");
  }
  return parsed as StorageState;
}

function csrfFromStorage(storage: StorageState): string {
  return (
    storage.cookies.find((cookie) => cookie.name === "csrftoken")?.value ?? ""
  );
}

function toPlaywrightProxyFromEndpoint(
  endpoint: string | null | undefined,
): LaunchOptions["proxy"] {
  if (!endpoint) return undefined;
  try {
    const url = new URL(proxyAgentUriForEndpoint(endpoint));
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
    };
  } catch (err) {
    throw new Error("[ig-browser-read] invalid assigned proxy; refusing direct connection");
  }
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new IGHttpError(0, "[ig-browser-read] non-JSON response from IG", {
      body: text.slice(0, 500),
      cause: err,
    });
  }
}

function parseIgErrorCodeFromText(
  text: string,
): "checkpoint_required" | "challenge_required" | "feedback_required" | "login_required" | undefined {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (
      parsed.message === "checkpoint_required" ||
      parsed.message === "challenge_required" ||
      parsed.message === "feedback_required" ||
      parsed.message === "login_required"
    ) {
      return parsed.message;
    }
  } catch {
    // Fall through to substring scan for IG HTML / text blocks.
  }
  if (text.includes("checkpoint_required")) return "checkpoint_required";
  if (text.includes("challenge_required")) return "challenge_required";
  if (text.includes("feedback_required")) return "feedback_required";
  if (text.includes("login_required")) return "login_required";
  return undefined;
}

function throwForStatus(response: BrowserJsonResponse, path: string): void {
  const retryAfterMs = 4 * 60 * 60 * 1000;
  const endpoint = endpointFamilyFromUrl(path);
  const diagnostics = inspectInstagramAuthResponse(response.status, response.text);
  const responseDiagnostics = classifyInstagramResponse(response.text, {},
    /\/accounts\/login/.test(response.url) ? 'login' : /\/(challenge|checkpoint)/.test(response.url) ? 'challenge' : undefined);
  if (response.status === 429) {
    throw new IGRateLimitedError(
      retryAfterMs,
      `[ig-browser-read] Instagram rate limited browser transport for ${endpoint}`,
    );
  }
  if (diagnostics?.reason === 'login_required' || responseDiagnostics.responseUrlClass === 'login'
      || responseDiagnostics.titleClass === 'login') {
    throw new IGAuthExpiredError(
      `[ig-browser-read] Instagram rejected browser session for ${endpoint} (${response.status})`,
      { status: response.status, body: response.text.slice(0, 500), authDiagnostics: diagnostics ?? undefined, responseDiagnostics },
    );
  }
  if (!response.ok || diagnostics || responseDiagnostics.responseUrlClass === 'challenge'
      || responseDiagnostics.titleClass === 'challenge') {
    throw new IGHttpError(
      response.status,
      `[ig-browser-read] IG browser request failed ${response.status} ${response.statusText} endpoint=${endpoint}`,
      {
        url: response.url,
        method: "GET",
        body: response.text.slice(0, 500),
        igErrorCode: parseIgErrorCodeFromText(response.text),
        authDiagnostics: diagnostics ?? undefined,
        responseDiagnostics,
      },
    );
  }
}

export async function createBrowserReadClient(
  opts: BrowserReadClientOptions,
): Promise<IGClientPort> {
  const targets = new Map<string, string>();
  let latestSession = () => opts.sessionData;
  const rememberProfile = (profile: IGProfile) => {
    if (profile.pk && profile.username) targets.set(profile.pk, profile.username);
    return profile;
  };
  async function followInBrowser(targetPk: string) {
    const username = targets.get(targetPk);
    if (!username) throw new Error('[ig-browser-read] browser follow requires a previously verified target profile');
    if (!opts.proxyEndpoint) throw new Error('[ig-browser-read] browser follow requires the assigned proxy');
    if (opts.automationIdentity && opts.botId) {
      return sendBrowserFollow({ botId: opts.botId, igUsername: opts.botUsername,
        automationIdentity: opts.automationIdentity, sessionData: latestSession(),
        proxyEndpoint: opts.proxyEndpoint, proxyUrl: proxyAgentUriForEndpoint(opts.proxyEndpoint), transport: 'web',
      }, username, targetPk);
    }
    const result = await playwrightSendFollowByUsername({ sessionData: latestSession(),
      fingerprint: opts.fingerprint, botUsername: opts.botUsername,
      proxyUrl: proxyAgentUriForEndpoint(opts.proxyEndpoint), targetUsername: username,
    });
    if (!result || (!result.following && !result.requested)) {
      throw new Error('[ig-browser-read] browser follow unconfirmed; refusing another write');
    }
    return { following: result.following, outgoingRequest: result.requested,
      incomingRequest: false, followedBy: false, isPrivate: true };
  }
  // Migrated bots must never bounce back into a TS-owned Chromium context.
  // The same domain port is served by FastAPI's invisible-playwright endpoint,
  // while endpoint parsing/error semantics stay identical to the HTTP client.
  if (opts.automationIdentity) {
    const client = createHttpBotClientWithFingerprint(
      opts.sessionData,
      opts.fingerprint,
      opts.botUsername,
      opts.proxyEndpoint,
      opts.botId ?? undefined,
      opts.automationIdentity,
      "browser",
    );
    latestSession = () => client.exportSessionData?.() ?? opts.sessionData;
    return { ...client,
      fetchProfile: async username => {
        const profile = await client.fetchProfile(username);
        if (profile.username.toLowerCase() !== username.toLowerCase()) throw new Error("[ig-browser-read] profile identity mismatch");
        return rememberProfile(profile);
      },
      ...(client.fetchProfileById ? { fetchProfileById: async (id: string) => {
        const profile = await client.fetchProfileById!(id);
        if (profile.pk !== id) throw new Error("[ig-browser-read] profile identity mismatch");
        return rememberProfile(profile);
      } } : {}),
      sendFollow: followInBrowser,
    };
  }
  const http = createHttpBotClientWithFingerprint(
    opts.sessionData,
    opts.fingerprint,
    opts.botUsername,
    opts.proxyEndpoint,
    opts.botId ?? undefined,
  );

  const storageState = parseStorageState(opts.sessionData);
  let currentSession = opts.sessionData;
  latestSession = () => currentSession;
  const csrfToken = csrfFromStorage(storageState);
  const proxy = toPlaywrightProxyFromEndpoint(opts.proxyEndpoint);
  const pw = await loadPlaywright();
  if (!pw) {
    if (opts.fallbackToHttp) return http;
    throw new Error("[ig-browser-read] Playwright is not installed");
  }
  const playwright = pw;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  async function ensurePage(): Promise<Page> {
    if (page && !page.isClosed()) return page;
    try {
      browser = await playwright.chromium.launch({
        headless: true,
        proxy,
      });
      const contextOptions: BrowserContextOptions = {
        storageState:
          storageState as unknown as BrowserContextOptions["storageState"],
        userAgent: opts.fingerprint.userAgent,
        locale: opts.fingerprint.locale,
        timezoneId: opts.fingerprint.timezone,
        extraHTTPHeaders: {
          "Accept-Language": opts.fingerprint.locale,
          "X-IG-App-ID": opts.fingerprint.appId,
          "X-Requested-With": "XMLHttpRequest",
        },
      };
      context = await browser.newContext(contextOptions);
      context.setDefaultTimeout(REQUEST_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      page = await context.newPage();
      await page.goto(IG_WEB_ORIGIN, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      return page;
    } catch (err) {
      await closeBrowserOnly();
      throw err;
    }
  }

  async function browserJson(
    path: string,
    init?: { method?: "GET" | "POST"; body?: string },
  ): Promise<unknown> {
    const operation = currentScrapeOperation();
    if (operation) operation.transport = "browser-api";
    let requested: URL;
    try { requested = new URL(path, IG_WEB_ORIGIN); }
    catch { throw new Error('[ig-browser-read] invalid Instagram read URL'); }
    if (requested.origin !== IG_WEB_ORIGIN || requested.username || requested.password || requested.hash) {
      throw new Error('[ig-browser-read] refusing a read outside the Instagram origin');
    }
    const p = await ensurePage();
    if (new URL(p.url()).origin !== IG_WEB_ORIGIN) throw new Error('[ig-browser-read] navigation left the Instagram origin');
    const response = await p.evaluate(
      async ({ path: requestPath, method, body, csrf, timeoutMs }) => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
        // Read the csrftoken from the LIVE page cookie so the X-CSRFToken header
        // always matches the cookie IG actually receives. The stored-session csrf
        // can be empty/stale (fresh migrations), which makes IG reject GET reads
        // like /media/<id>/likers/ with "CSRF token missing or incorrect".
        const liveCsrf =
          (typeof document !== "undefined" &&
            (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] ?? "")) ||
          csrf;
        try {
          const res = await fetch(requestPath, {
            method,
            credentials: "include",
            headers: {
              Accept: "application/json, text/plain, */*",
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              "X-CSRFToken": liveCsrf,
              "X-IG-App-ID": "936619743392459",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: method === "POST" ? body ?? "" : undefined,
            signal: controller.signal,
            redirect: 'error',
          });
          return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            url: res.url,
            text: await res.text(),
          };
        } finally {
          window.clearTimeout(timeout);
        }
      },
      {
        path: requested.href,
        method: init?.method ?? "GET",
        body: init?.body ?? "",
        csrf: csrfToken,
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );

    // Attribute browser-transport bytes to the active scrape context, same as
    // the HTTP client does. Without this the admin bandwidth panel reported ~0
    // whenever readTransport=browser, since none of this traffic goes through
    // ig-http-client. Note: this counts the in-page API fetch payload only; the
    // one-time page.goto(instagram.com) navigation per session is not metered
    // (it is shared overhead, not per-endpoint), so browser-mode totals still
    // under-state true wire cost — a further reason to prefer http transport.
    const metered = response as BrowserJsonResponse;
    if (new URL(metered.url, IG_WEB_ORIGIN).origin !== IG_WEB_ORIGIN) {
      throw new Error('[ig-browser-read] response left the Instagram origin');
    }
    recordBytes({
      endpoint: endpointFamilyFromUrl(path),
      bytesIn: Buffer.byteLength(metered.text ?? "", "utf8"),
      bytesOut:
        Buffer.byteLength(path, "utf8") +
        Buffer.byteLength(init?.body ?? "", "utf8"),
    });

    throwForStatus(metered, path);
    let exportTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = await Promise.race([context!.storageState(), new Promise<never>((_, reject) => {
        exportTimer = setTimeout(() => reject(new Error('storage export timeout')), 2000);
      })]);
      currentSession = JSON.stringify(state);
    } catch { /* A completed read must not be retried for session export failure. */ }
    finally { if (exportTimer) clearTimeout(exportTimer); }
    return parseJsonText(metered.text);
  }

  async function withBrowserFallback<T>(
    endpoint: string,
    browserCall: () => Promise<T>,
    httpCall: () => Promise<T>,
  ): Promise<T> {
    try {
      return await browserCall();
    } catch (err) {
      if (
        !opts.fallbackToHttp ||
        err instanceof IGRateLimitedError ||
        err instanceof IGAuthExpiredError ||
        err instanceof IGHttpError
      ) {
        throw err;
      }
      logger.warn(
        {
          endpoint,
          botId: opts.botId ?? null,
          err: err instanceof Error ? err.message : String(err),
        },
        "[ig-browser-read] browser transport failed; falling back to HTTP",
      );
      return httpCall();
    }
  }

  async function closeBrowserOnly(): Promise<void> {
    const currentContext = context;
    const currentBrowser = browser;
    page = null;
    context = null;
    browser = null;
    try {
      await currentContext?.close();
    } catch {
      /* ignore */
    }
    try {
      await currentBrowser?.close();
    } catch {
      /* ignore */
    }
  }

  return {
    exportSessionData: () => currentSession,
    // Wave 9: raw in-page fetch for the liked-by harvester's home/reels feed
    // polling when the HTTP transport hits a non-rate-limit anomaly. No HTTP
    // fallback here — the caller already tried HTTP first. Runs the request in
    // the real browser context (shared cookies / proxy / CSRF), so it looks
    // like the SPA's own XHR.
    fetchRaw: (
      path: string,
      init?: { method?: "GET" | "POST"; body?: string },
    ): Promise<unknown> => browserJson(path, init),
    fetchProfile: (username: string): Promise<IGProfile> =>
      withBrowserFallback(
        "profile",
        async () => {
          const raw = await browserJson(
            `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
          );
          const profile = parseProfileResponse(raw);
          if (profile.username.toLowerCase() !== username.toLowerCase()) throw new Error('[ig-browser-read] profile identity mismatch');
          return rememberProfile(profile);
        },
        () => http.fetchProfile(username),
      ),
    fetchUserFeed: (pk: string, optsArg = {}): Promise<IGFeedPage> =>
      withBrowserFallback(
        "posts",
        async () => {
          const params = new URLSearchParams({
            count: String(optsArg.count ?? 24),
          });
          if (optsArg.maxId) params.set("max_id", optsArg.maxId);
          return parseFeedResponse(
            await browserJson(`/api/v1/feed/user/${encodeURIComponent(pk)}/?${params}`),
          );
        },
        () => http.fetchUserFeed(pk, optsArg),
      ),
    fetchUserClips: (pk: string, optsArg = {}): Promise<IGFeedPage> =>
      withBrowserFallback(
        "clips",
        async () => {
          const params = new URLSearchParams({
            target_user_id: pk,
            page_size: String(optsArg.count ?? 12),
            include_feed_video: "true",
          });
          if (optsArg.maxId) params.set("max_id", optsArg.maxId);
          return parseClipsResponse(
            await browserJson("/api/v1/clips/user/", {
              method: "POST",
              body: params.toString(),
            }),
          );
        },
        () => http.fetchUserClips(pk, optsArg),
      ),
    fetchUserTagged: (pk: string, optsArg = {}): Promise<IGFeedPage> =>
      withBrowserFallback(
        "tagged",
        async () => {
          const params = new URLSearchParams({
            count: String(optsArg.count ?? 12),
          });
          if (optsArg.maxId) params.set("max_id", optsArg.maxId);
          return parseFeedResponse(
            await browserJson(`/api/v1/usertags/${encodeURIComponent(pk)}/feed/?${params}`),
          );
        },
        () => http.fetchUserTagged(pk, optsArg),
      ),
    fetchFollowing: (pk: string, optsArg = {}): Promise<IGFriendshipPage> =>
      withBrowserFallback(
        "following",
        async () => {
          const params = new URLSearchParams({
            count: String(optsArg.count ?? 50),
          });
          if (optsArg.maxId) params.set("max_id", optsArg.maxId);
          const page = parseFriendshipPageResponse(
            await browserJson(
              `/api/v1/friendships/${encodeURIComponent(pk)}/following/?${params}`,
            ),
          );
          return page;
        },
        () => http.fetchFollowing(pk, optsArg),
      ),
    fetchFollowers: (pk: string, optsArg = {}): Promise<IGFriendshipPage> =>
      withBrowserFallback(
        "followers",
        async () => {
          const params = new URLSearchParams({
            count: String(optsArg.count ?? 50),
          });
          if (optsArg.maxId) params.set("max_id", optsArg.maxId);
          const page = parseFriendshipPageResponse(
            await browserJson(
              `/api/v1/friendships/${encodeURIComponent(pk)}/followers/?${params}`,
            ),
          );
          return page;
        },
        () => http.fetchFollowers(pk, optsArg),
      ),
    sendFollow: followInBrowser,
    fetchStoriesTray: (pk: string): Promise<IGStoriesTray> =>
      withBrowserFallback(
        "stories",
        async () => {
          const params = new URLSearchParams();
          params.append("reel_ids", pk);
          const reels = parseHighlightReelsResponse(
            await browserJson(`/api/v1/feed/reels_media/?${params}`),
          );
          const reel = reels.find(item => item.id === pk);
          if (reels.length && !reel) throw new Error('[ig-browser-read] stories response belongs to another account');
          return { items: reel?.items ?? [] };
        },
        () => http.fetchStoriesTray(pk),
      ),
    fetchHighlightsTray: (pk: string): Promise<IGHighlightsTray> =>
      withBrowserFallback(
        "highlights",
        async () =>
          parseHighlightsTrayResponse(
            await browserJson(
              `/api/v1/highlights/${encodeURIComponent(pk)}/highlights_tray/`,
            ),
          ),
        () => http.fetchHighlightsTray(pk),
      ),
    fetchHighlightReels: (
      highlightIds: ReadonlyArray<string>,
    ): Promise<ReadonlyArray<IGHighlightReel>> =>
      withBrowserFallback(
        "highlight-reels",
        async () => {
          if (highlightIds.length === 0) return [];
          const params = new URLSearchParams();
          for (const id of highlightIds) params.append("reel_ids", id);
          return parseHighlightReelsResponse(
            await browserJson(`/api/v1/feed/reels_media/?${params}`),
          );
        },
        () => http.fetchHighlightReels(highlightIds),
      ),
    fetchMediaComments: (
      mediaId: string,
      maxId?: string,
    ): Promise<IGCommentsPage> =>
      withBrowserFallback(
        "comments",
        async () => {
          const params = new URLSearchParams({
            can_support_threading: "true",
            permalink_enabled: "false",
          });
          if (maxId) params.set("max_id", maxId);
          return parseCommentsResponse(
            await browserJson(
              `/api/v1/media/${encodeURIComponent(mediaId)}/comments/?${params}`,
            ),
          );
        },
        () => http.fetchMediaComments(mediaId, maxId),
      ),
    fetchMediaLikers: (mediaId: string): Promise<IGLikersPage> =>
      withBrowserFallback(
        "likers",
        async () =>
          parseLikersResponse(
            await browserJson(`/api/v1/media/${encodeURIComponent(mediaId)}/likers/`),
          ),
        () => http.fetchMediaLikers(mediaId),
      ),
    close: async () => {
      await closeBrowserOnly();
      await http.close();
    },
  };
}
