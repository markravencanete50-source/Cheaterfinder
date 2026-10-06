// ─── Instagram HTTP client ────────────────────────────────────────────────────
//
// Client that makes authenticated HTTP requests to Instagram's private web API
// using cookies stored in a Playwright storage-state JSON blob (the format
// produced by playwright's `context.storageState()`). This is the "pure
// native runtime, no Playwright at runtime" path — we only read the cookies
// Playwright previously stored.
//
// Transport: every call goes through undici. With a proxy endpoint we route
// through a ProxyAgent (CONNECT tunnel, HTTP/1.1 upstream — Smartproxy mangles
// HTTP/2 framing on large responses); without one we use a plain undici Agent
// with HTTP/2 enabled. The legacy node:http2 direct path was removed (B15):
// production always egresses through the residential proxy pool, so the H2
// session machinery had no reachable callers and only leaked CONNECT tunnels.
//
// Endpoints supported (all verified working against a real IG session):
//   - GET  /api/v1/users/web_profile_info/?username=<user>
//   - GET  /api/v1/feed/user/<pk>/?count=<n>[&max_id=<cursor>]
//   - GET  /api/v1/friendships/<pk>/following/?count=<n>[&max_id=<cursor>]
//   - GET  /api/v1/friendships/<pk>/followers/?count=<n>[&max_id=<cursor>]
//   - POST /api/v1/friendships/create/<target_pk>/
// ─────────────────────────────────────────────────────────────────────────────

import {
  Agent as UndiciAgent,
  ProxyAgent as UndiciProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";
import { z } from "zod";
import { operationSignal } from "./services/operation-context.js";
import { currentScrapeOperation } from "./services/scrape-operation.js";
import { proxyAgentUriForEndpoint } from "./services/proxy-provider.js";
import {
  IGSchemaError,
  type IGClientPort,
  type IGFeedPage,
  type IGFriendshipPage,
  type IGFriendshipStatus,
  type IGLikersPage,
  type IGProfile,
  type IGFriendshipUser as IGFriendshipUserDomain,
  type IGStoriesTray,
  type IGHighlightsTray,
  type IGHighlightReel,
} from "./domain/ig-client-port.js";
import {
  parseClipsResponse,
  parseCommentsResponse,
  parseFeedResponse,
  parseFriendshipPageResponse,
  parseGraphqlFriendshipPageResponse,
  parseFriendshipStatusResponse,
  parseLikersResponse,
  parseProfileResponse,
  parseProfileInfoResponse,
  type IGCommentsPage,
} from "./domain/ig-schemas.js";
import {
  parseHighlightReelsResponse,
  parseHighlightsTrayResponse,
} from "./domain/ig-stories-schemas.js";
import {
  assertCanCall,
  endpointFamilyFromUrl,
  isBreakerFailure,
  recordFailure,
  recordSuccess,
} from "./domain/ig-circuit-breaker.js";
import { recordBytes } from "./services/bandwidth-meter.js";
import {
  generateDeviceFingerprint,
  buildSecChUa,
  platformFromUserAgent,
  fingerprintFromPersonality,
  type DeviceFingerprint,
} from "./behavior/device-fingerprint.js";
import {
  createAutomationClient,
  type AutomationIdentity,
  type AutomationProxy,
} from "./services/automation-client.js";
import { classifyInstagramResponse, type IGResponseDiagnostics } from "./services/ig-response-diagnostics.js";
import { inspectInstagramAuthResponse, type InstagramAuthDiagnostics } from "./services/instagram-auth-diagnostics.js";

const IG_APP_ID = "936619743392459";
const IG_WEB_ORIGIN = "https://www.instagram.com";
const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;
const GRAPHQL_CURSOR_PREFIX = "gql:";
import { GRAPHQL_FRIENDSHIP_QUERY_HASH, graphqlRosterPageSize } from "./domain/ig-graphql-queries.js";
// B15: dispatcher.close() can hang if an in-flight CONNECT tunnel never drains.
// Bound the wait so client teardown / proxy rotation can never block a worker.
const DISPATCHER_CLOSE_TIMEOUT_MS = 5_000;

// ─── Error types ─────────────────────────────────────────────────────────────

export class IGAuthExpiredError extends Error {
  /** Upstream status: a confirmed login redirect can finish with HTTP 200. */
  readonly status?: number;
  /** Raw response body (truncated) for callers that need to branch on body content. */
  readonly body?: string;
  readonly responseDiagnostics?: IGResponseDiagnostics;
  readonly authDiagnostics?: InstagramAuthDiagnostics;
  constructor(
    message = "Instagram session cookies rejected (401/403)",
    options?: ErrorOptions & { status?: number; body?: string; responseDiagnostics?: IGResponseDiagnostics; authDiagnostics?: InstagramAuthDiagnostics },
  ) {
    super(message, options);
    this.name = "IGAuthExpiredError";
    this.status = options?.status;
    this.body = options?.body;
    this.responseDiagnostics = options?.responseDiagnostics;
    this.authDiagnostics = options?.authDiagnostics;
  }
}

export class IGRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(
    retryAfterMs: number,
    message = "Instagram rate limited (429)",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IGRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Known IG-side semantic error codes parsed from response bodies. Carried on
 * IGHttpError so retry/cooldown layers can branch without re-parsing the body.
 */
export type IGErrorCode =
  | "checkpoint_required"
  | "challenge_required"
  | "feedback_required"
  | "login_required";

export class IGHttpError extends Error {
  readonly status: number;
  readonly url?: string;
  readonly method?: string;
  /** Raw response body (truncated to 500 chars) — kept for programmatic parsing. */
  readonly body?: string;
  /** Parsed IG-side error code, if the body had a recognisable `message`. */
  readonly igErrorCode?: IGErrorCode;
  readonly responseDiagnostics?: IGResponseDiagnostics;
  readonly authDiagnostics?: InstagramAuthDiagnostics;
  constructor(
    status: number,
    message: string,
    options?: ErrorOptions & {
      url?: string;
      method?: string;
      body?: string;
      igErrorCode?: IGErrorCode;
      responseDiagnostics?: IGResponseDiagnostics;
      authDiagnostics?: InstagramAuthDiagnostics;
    },
  ) {
    super(message, options);
    this.name = "IGHttpError";
    this.status = status;
    this.url = options?.url;
    this.method = options?.method;
    this.body = options?.body;
    this.authDiagnostics = options?.authDiagnostics;
    this.igErrorCode = options?.igErrorCode;
    this.responseDiagnostics = options?.responseDiagnostics;
  }
}

// ─── Transport-error naming ─────────────────────────────────────────────────
// A failed fetch is wrapped as IGHttpError(0, …). Status 0 is the network
// sentinel that scrape-retry, the scraper and scrape-metrics key on, and it
// stays exactly that. What the wrapper used to hide was WHY: 619 "network"
// outcomes on 2026-09-02 carried no reason, one proxy lane failed 31% of its
// attempts, and nothing in the log said whether that was a CONNECT timeout, a
// reset socket or our own abort. The root cause's code now rides in the
// message (undici: UND_ERR_CONNECT_TIMEOUT, UND_ERR_SOCKET; Node: ECONNRESET,
// ETIMEDOUT; AbortError, …) together with the proxy lane; `cause` stays
// attached for anyone who needs the object itself.

const MAX_CAUSE_CHAIN_DEPTH = 8;

function rootCauseOf(err: unknown): unknown {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH; depth += 1) {
    const next = (current as { cause?: unknown } | null | undefined)?.cause;
    if (next === undefined || next === null || next === current) break;
    current = next;
  }
  return current;
}

/** Root-cause code of a transport failure: `code`, else `name`, else "unknown". */
export function transportErrorCode(err: unknown): string {
  const root = rootCauseOf(err);
  if (typeof root !== "object" || root === null) return "unknown";
  const { code, name } = root as { code?: unknown; name?: unknown };
  if (typeof code === "string" && code.length > 0) return code;
  if (typeof name === "string" && name.length > 0) return name;
  return "unknown";
}

/** `host:port` of a proxy endpoint ("host:port" or "host:port:user:pass"). */
export function proxyLaneLabel(
  endpoint: string | null | undefined,
): string | null {
  if (!endpoint) return null;
  const [host, port] = endpoint.split(":");
  if (!host || !port) return null;
  return `${host}:${port}`;
}

/** `<prefix> network error (<code>) <METHOD> <family>[ lane=<host:port>]` */
export function formatNetworkErrorMessage(
  prefix: string,
  method: string,
  endpoint: string,
  err: unknown,
  proxyEndpoint: string | null | undefined,
): string {
  const lane = proxyLaneLabel(proxyEndpoint);
  const laneSuffix = lane ? ` lane=${lane}` : "";
  const code = transportErrorCode(err);
  // The automation service wraps the real transport failure (e.g. pyhttpz
  // "local error: tls: protocol version not supported") in its own error class;
  // surface that detail or every such fault reads as a bare "AutomationServiceError".
  const root = rootCauseOf(err) as { message?: unknown } | null;
  const detail =
    code === "AutomationServiceError" && root && typeof root.message === "string"
      ? ` detail="${root.message.replace(/\s+/g, " ").slice(0, 90)}"`
      : "";
  return `${prefix} network error (${code}) ${method} ${endpoint}${laneSuffix}${detail}`;
}

const IG_ERROR_CODES: ReadonlyArray<IGErrorCode> = [
  "checkpoint_required",
  "challenge_required",
  "feedback_required",
  "login_required",
];

function isIgErrorCode(value: string): value is IGErrorCode {
  return (IG_ERROR_CODES as ReadonlyArray<string>).includes(value);
}

/**
 * Best-effort extraction of IG's `message` field from a response body. IG
 * returns these as JSON like `{"message":"checkpoint_required",...}` with
 * occasional non-JSON HTML for hard blocks; we tolerate both.
 */
function parseIgErrorCode(body: string): IGErrorCode | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "message" in parsed) {
      const msg = (parsed as { message: unknown }).message;
      if (typeof msg === "string" && isIgErrorCode(msg)) {
        return msg;
      }
    }
  } catch {
    // Fall through to substring scan for non-JSON bodies.
  }
  for (const code of IG_ERROR_CODES) {
    if (body.includes(code)) return code;
  }
  return undefined;
}

function shouldTryGraphqlFriendshipFallback(error: unknown): boolean {
  // Instagram sometimes answers the REST friendship surface with a synthetic
  // auth rejection or even a logged-out 404 while the same authenticated
  // session can still read the public GraphQL connection. A truly expired
  // session will fail GraphQL too and propagate normally, so trying the second
  // read surface is safe and avoids rotating through the entire bot pool first.
  return (
    (error instanceof IGAuthExpiredError &&
      (error.status === 401 || error.status === 403)) ||
    (error instanceof IGHttpError && error.status === 404)
  );
}

// ─── Cookie / storage state schemas (Fix #20) ───────────────────────────────

const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().optional(),
});

const StorageStateSchema = z.object({
  cookies: z.array(CookieSchema),
  origins: z.array(z.unknown()).optional(),
});

type PlaywrightCookie = z.infer<typeof CookieSchema>;
type PlaywrightStorageState = z.infer<typeof StorageStateSchema>;

// Bug-fix: parser for /api/v1/friendships/show/<pk>/. This response puts the
// edge fields at the TOP LEVEL (no `friendship_status` envelope), unlike
// the `friendships/create` shape parsed in domain/ig-schemas.ts. Both edge
// flags must be explicit: unknown state must never authorize another follow.
// Extra fields remain allowed so additions do not break valid responses.
const FriendshipShowSchema = z
  .object({
    following: z.boolean(),
    outgoing_request: z.boolean(),
    incoming_request: z.boolean().optional(),
    followed_by: z.boolean().optional(),
    is_private: z.boolean().optional(),
  })
  .passthrough();

// ─── Public response types ─────────────────────────────────────────────────
//
// Wave 2: these are re-exported from the domain port so legacy callers that
// still import from ig-http-client keep working. New code should import
// directly from server/domain/ig-client-port.ts.

export type {
  IGProfile as IGProfileInfo,
  IGProfilePostPreview,
  IGFeedItem,
  IGFeedPage,
  IGFriendshipPage,
  IGFriendshipStatus,
} from "./domain/ig-client-port.js";

// Keep the old name exported for backward compat.
export type IGFriendshipUser = IGFriendshipUserDomain;

export interface IGSendFollowResult {
  status: IGFriendshipStatus;
  raw: Record<string, unknown>;
}

// Legacy synchronous client shape. createBotClient still returns this for
// any caller that hasn't migrated to the IGClientPort factory yet.
export interface IGClient {
  exportSessionData(): string;
  readonly csrfToken: string;
  // Authenticated raw request to any IG path, returning parsed JSON. Reuses
  // this client's cookies / proxy / fingerprint / circuit-breaker so it is
  // indistinguishable from a normal scrape. Used by the liked-by-inference
  // harvester for the two feeds IG only exposes as raw endpoints
  // (POST /api/v1/feed/timeline/, POST /api/v1/clips/discover/).
  fetchRaw(
    path: string,
    opts?: {
      method?: "GET" | "POST";
      body?: string;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<unknown>;
  fetchProfile(username: string): Promise<IGProfile>;
  // Mobile-API profile fallback: GET /api/v1/users/<id>/info/ (a different
  // rate-limit bucket than web_profile_info). Returns the same IGProfile shape.
  fetchProfileById(userId: string): Promise<IGProfile>;
  fetchUserFeed(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFeedPage>;
  // Wave 4: dedicated Reels-tab + Tagged-tab readers.
  fetchUserClips(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFeedPage>;
  fetchUserTagged(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFeedPage>;
  fetchFollowing(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFriendshipPage>;
  fetchFollowers(
    pk: string,
    opts?: { count?: number; maxId?: string },
  ): Promise<IGFriendshipPage>;
  sendFollow(targetPk: string): Promise<IGSendFollowResult>;
  // Bug-fix: probe whether THIS bot's session has been accepted by `targetPk`.
  // Hits /api/v1/friendships/show/<pk>/ which returns the bot↔target edge
  // ("following", "outgoing_request", ...) — the only authoritative signal
  // for accepted FRs against a private account.
  fetchFriendshipStatus(targetPk: string): Promise<IGFriendshipStatus>;
  // Wave 3b (Agent B): stories + highlights for public-data scraper
  fetchStoriesTray(pk: string): Promise<IGStoriesTray>;
  fetchHighlightsTray(pk: string): Promise<IGHighlightsTray>;
  fetchHighlightReels(
    highlightIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<IGHighlightReel>>;
  // Wave 5: media comments
  fetchMediaComments(
    mediaId: string,
    maxId?: string,
  ): Promise<IGCommentsPage>;
  // Wave 5: media likers (single-page, IG-capped at ~100 users)
  fetchMediaLikers(mediaId: string): Promise<IGLikersPage>;
  close(): void;
}

// ─── Cookie utilities ────────────────────────────────────────────────────────

function parseStorageState(sessionData: string): PlaywrightStorageState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionData);
  } catch (err) {
    throw new IGAuthExpiredError(
      `[ig-http] sessionData is not valid JSON: ${err instanceof Error ? err.message : "parse error"}`,
      { cause: err },
    );
  }
  const result = StorageStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new IGAuthExpiredError(
      `[ig-http] sessionData shape invalid: ${result.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return result.data;
}

// Filter out expired cookies (unix seconds). Playwright uses expires=-1 for
// session cookies (never expires from our POV). Positive expires in the past
// means the cookie is gone. (Fix #4)
function filterLiveCookies(
  cookies: readonly PlaywrightCookie[],
): PlaywrightCookie[] {
  const nowSec = Math.floor(Date.now() / 1000);
  return cookies.filter((c) => {
    if (typeof c.expires !== "number") return true;
    if (c.expires <= 0) return true; // session cookie
    return c.expires > nowSec;
  });
}

function buildCookieHeader(cookies: readonly PlaywrightCookie[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of cookies) {
    if (!c?.name) continue;
    if (seen.has(c.name)) continue;
    if (c.value === undefined) continue;
    parts.push(`${c.name}=${c.value}`);
    seen.add(c.name);
  }
  return parts.join("; ");
}

function findCookie(
  cookies: readonly PlaywrightCookie[],
  name: string,
): string | null {
  for (const c of cookies) {
    if (c.name === name) return c.value ?? null;
  }
  return null;
}

// ─── Core request helper ─────────────────────────────────────────────────────

interface RequestOptions {
  method?: "GET" | "POST";
  body?: string;
  extraHeaders?: Record<string, string>;
}

interface IGResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  // True encoded transfer for this call, when the transport can measure it.
  // Only the browser lane reports these today, and there they cover the ENTIRE
  // Firefox launch (instagram.com page load + the API fetch) — the several
  // megabytes Node never sees but the proxy provider always bills. Absent on
  // the HTTP/mobile lanes, where the caller falls back to payload size.
  wireBytesIn?: number;
  wireBytesOut?: number;
  wireBreakdown?: Record<string, number>;
  transportError?: string;
  responseUrlClass?: unknown;
  responseRedirected?: unknown;
}

// Per-bot-client transport state. All IG calls share one cached undici
// dispatcher (a hot CONNECT tunnel when a proxy is configured) plus the
// session-continuity tokens IG expects every request to mirror.
interface ClientState {
  // Wave 3: IG echoes back an x-ig-www-claim header that the next request is
  // expected to mirror — it's a session-continuity token. We track the most
  // recent value so every subsequent request looks like a continuation of
  // the same browser tab rather than a fresh connection.
  wwwClaim: string;
  // Referrer persistence: real browsers send the URL of the page they came
  // from. We start at the IG home feed and update to the last-fetched
  // profile so our navigation trail looks like a human clicking around.
  lastReferer: string;
  // Wave 4: when a proxy endpoint is supplied, we route every IG call through
  // it via undici (CONNECT tunnel + HTTP/1.1 upstream). proxyEndpoint is
  // "host:port" or "host:port:username:password". dispatcher caches the
  // per-bot ProxyAgent so we keep the CONNECT tunnel hot across calls and
  // don't pay TCP+TLS handshake on every request.
  proxyEndpoint: string | null;
  dispatcher: Dispatcher | null;
  // Explicit per-bot FastAPI identity. When present, this client never emits
  // the legacy TypeScript fingerprint/Undici request shape.
  automationIdentity: AutomationIdentity | null;
  automationTransport: "http" | "browser";
  storageState: PlaywrightStorageState;
  // Wave 6: stable bot identifier used as the bot half of every per-key
  // circuit breaker (`${botId}:${endpointFamily}`). Prefer the bot row's
  // immutable id (UUID); fall back to the bot username when only the
  // username is available; fall back to "unknown" only when neither is
  // supplied (legacy anonymous test clients).
  botId: string;
}

function automationProxyFromEndpoint(
  endpoint: string | null,
): AutomationProxy | undefined {
  if (!endpoint) return undefined;
  const parsed = new URL(proxyAgentUriForEndpoint(endpoint));
  return {
    server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  };
}

function automationRequestHeaders(
  state: ClientState,
  method: "GET" | "POST",
  csrfToken: string,
  extraHeaders: Record<string, string> | undefined,
): Record<string, string> {
  // Only carry continuity/API values across the boundary. Identity, cookie,
  // navigation, and content headers are minted inside Python from the stored
  // Firefox identity so legacy Chromium fields cannot leak back in.
  const headers: Record<string, string> = {
    "x-ig-www-claim": state.wwwClaim,
    // Send x-csrftoken on EVERY request, not just POST. A real browser XHR sends
    // it on GET too, and IG gates certain GET reads (notably
    // /media/<id>/likers/) with 403 "CSRF token missing or incorrect" when it's
    // absent. Endpoints that don't require it simply ignore the header.
    "x-csrftoken": csrfToken,
  };
  if (method === "POST") {
    headers["x-instagram-ajax"] = "1";
  }
  for (const [rawName, value] of Object.entries(extraHeaders ?? {})) {
    const name = rawName.toLowerCase();
    if (
      name === "x-ig-www-claim" ||
      name === "x-csrftoken" ||
      name === "x-instagram-ajax"
    ) {
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * Accept a wire measurement only when it is a real, positive, finite count.
 * The automation service sends these fields optionally (null on lanes that
 * cannot measure), and a 0 is indistinguishable from "not measured" — treating
 * either as a measurement would silently zero out a browser launch that really
 * did transfer megabytes.
 */
function measuredWireBytes(value: number | null | undefined): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function automationFetch(
  state: ClientState,
  url: string,
  csrfToken: string,
  opts: RequestOptions,
): Promise<IGResponse> {
  const identity = state.automationIdentity;
  if (!identity) throw new Error("automation identity is required");
  const operation = currentScrapeOperation();
  if (operation) operation.transport = state.automationTransport === "browser" ? "browser-api" : state.automationTransport;
  const method = opts.method ?? "GET";
  const request = {
    operation_id: currentScrapeOperation()?.id,
    deadline_ms: 60_000,
    identity,
    storage_state: state.storageState as unknown as Record<string, unknown>,
    proxy: automationProxyFromEndpoint(state.proxyEndpoint),
    request: {
      method,
      path: url,
      headers: automationRequestHeaders(state, method,
        findCookie(filterLiveCookies(state.storageState.cookies), "csrftoken") ?? csrfToken, opts.extraHeaders),
      referer: state.lastReferer,
      ...(method === "POST" ? { body: opts.body ?? "" } : {}),
      timeout_ms: REQUEST_TIMEOUT_MS,
    },
  };
  const client = createAutomationClient({ timeoutMs: state.automationTransport === "browser" ? 65_000 : REQUEST_TIMEOUT_MS + 5_000 });
  const response = state.automationTransport === "browser"
    ? await client.requestInstagramBrowser(request)
    : await client.requestInstagramHttp(request);
  const claim = response.headers["x-ig-set-www-claim"] ?? response.headers["x-ig-www-claim"];
  if (claim && claim !== "0") state.wwwClaim = claim;
  if (response.storage_state) {
    const parsed = StorageStateSchema.safeParse(response.storage_state);
    if (parsed.success) state.storageState = parsed.data;
  }
  const wireBytesIn = measuredWireBytes(response.wire_bytes_in);
  const wireBytesOut = measuredWireBytes(response.wire_bytes_out);
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
    ...(wireBytesIn !== null ? { wireBytesIn } : {}),
    ...(wireBytesOut !== null ? { wireBytesOut } : {}),
    ...(response.wire_breakdown ? { wireBreakdown: response.wire_breakdown } : {}),
    ...(response.transport_error ? { transportError: response.transport_error } : {}),
    responseUrlClass: response.response_url_class,
    responseRedirected: response.response_redirected,
  };
}

function buildDispatcher(proxyEndpoint: string | null): Dispatcher {
  if (!proxyEndpoint) {
    // Direct path — kept for tests / dev environments that don't have a
    // proxy configured. Production should always run through ProxyAgent.
    return new UndiciAgent({ allowH2: true });
  }
  // Smartproxy CONNECT tunnel mangles HTTP/2 framing on large responses
  // ("Missing expected CR after response line"). Force HTTP/1.1 through
  // proxy — curl (which uses HTTP/1.1 by default) confirms the same
  // endpoints work fine. Native fetch keeps HTTP/2 only on direct path.
  return new UndiciProxyAgent({
    uri: proxyAgentUriForEndpoint(proxyEndpoint),
    allowH2: false,
    requestTls: { rejectUnauthorized: true },
  });
}

// B15: close one undici dispatcher with a hard timeout guard so teardown can
// never hang on an in-flight CONNECT tunnel that won't drain. Resolves on
// clean close, on timeout, and on close-error alike — callers only ever
// `await` it for best-effort cleanup, never for correctness. Close failures
// are logged (not swallowed) so leaked tunnels are observable.
//
// Exported for unit testing the await + timeout-guard + error-logging
// invariants without opening real sockets.
export async function closeDispatcher(dispatcher: Dispatcher): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[ig-http] dispatcher close exceeded ${DISPATCHER_CLOSE_TIMEOUT_MS}ms; abandoning (tunnel may leak)`,
      );
      resolve();
    }, DISPATCHER_CLOSE_TIMEOUT_MS);
    // Don't keep the event loop alive solely for this guard timer.
    (timer as { unref?: () => void }).unref?.();
  });
  const close = Promise.resolve()
    .then(() => dispatcher.close())
    .catch((err: unknown) => {
      console.warn(
        `[ig-http] dispatcher close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  try {
    await Promise.race([close, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// B15: minimal shape carrying the one mutable dispatcher slot — exported so
// the dispatcher-lifecycle helpers can be unit tested against a plain object
// without standing up a full client.
export interface DispatcherSlot {
  dispatcher: Dispatcher | null;
}

// B15: every code path that assigns a dispatcher to a client MUST close the
// one it replaces, otherwise open CONNECT tunnels accumulate under high proxy
// rotation. Funnelling all assignment through this helper makes that an
// enforced invariant rather than a per-call-site convention. The close of the
// previous dispatcher is fired with its own timeout guard and not awaited here
// (the hot path stays synchronous); teardown that needs confirmation awaits
// via closeClientDispatcher().
export function setDispatcher(
  state: DispatcherSlot,
  next: Dispatcher | null,
): void {
  const previous = state.dispatcher;
  state.dispatcher = next;
  if (previous && previous !== next) {
    void closeDispatcher(previous);
  }
}

function ensureDispatcher(state: ClientState): Dispatcher {
  if (state.dispatcher) return state.dispatcher;
  const dispatcher = buildDispatcher(state.proxyEndpoint);
  setDispatcher(state, dispatcher);
  return dispatcher;
}

// B15: awaited teardown of a client's dispatcher. Closes (with timeout guard)
// and clears the reference so the same dispatcher can't be closed twice.
// Exported for unit testing the await-on-close invariant.
export async function closeClientDispatcher(
  state: DispatcherSlot,
): Promise<void> {
  const dispatcher = state.dispatcher;
  state.dispatcher = null;
  if (dispatcher) await closeDispatcher(dispatcher);
}

// Wave 4: proxy-aware request transport. Every call goes through undici. With
// a proxy endpoint we use a ProxyAgent (CONNECT tunnel, HTTP/1.1 upstream —
// Smartproxy mangles HTTP/2 framing); without one we use a plain undici Agent.
// Same TLS to instagram.com, same wire format, just an extra hop through the
// residential IP when proxied.
async function proxyFetch(
  state: ClientState,
  url: string,
  cookieHeader: string,
  csrfToken: string,
  fingerprint: DeviceFingerprint,
  opts: RequestOptions,
): Promise<IGResponse> {
  if (state.automationIdentity) {
    return automationFetch(state, url, csrfToken, opts);
  }
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    "user-agent": fingerprint.userAgent,
    "x-ig-app-id": fingerprint.appId,
    "x-asbd-id": "129477",
    "x-ig-www-claim": state.wwwClaim,
    "x-requested-with": "XMLHttpRequest",
    accept: "application/json, text/plain, */*",
    "accept-language": `${fingerprint.locale},${fingerprint.locale.split("-")[0]};q=0.9`,
    "accept-encoding": "gzip, deflate, br",
    "sec-ch-ua": buildSecChUa(fingerprint.userAgent),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": platformFromUserAgent(fingerprint.userAgent),
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    referer: state.lastReferer,
    origin: IG_WEB_ORIGIN,
    cookie: cookieHeader,
    // Always send x-csrftoken (browsers send it on GET too). IG 403s some GET
    // reads — e.g. /media/<id>/likers/ — with "CSRF token missing" otherwise.
    "x-csrftoken": csrfToken,
  };
  if (method === "POST") {
    headers["x-instagram-ajax"] = "1";
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) {
    headers[k.toLowerCase()] = v;
  }

  const dispatcher = ensureDispatcher(state);
  const ownerSignal = operationSignal();
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = ownerSignal ? AbortSignal.any([ownerSignal, deadline]) : deadline;
  let res: Awaited<ReturnType<typeof undiciFetch>>;
    res = await undiciFetch(url, {
      method,
      headers,
      body: method === "POST" ? opts.body ?? "" : undefined,
      dispatcher,
      signal,
    });

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    responseHeaders[k.toLowerCase()] = v;
  });
  const claim =
    responseHeaders["x-ig-set-www-claim"] ?? responseHeaders["x-ig-www-claim"];
  if (claim && claim !== "0") state.wwwClaim = claim;

  const body = await res.text();
  return { status: res.status, headers: responseHeaders, body };
}

async function igRequest(
  state: ClientState,
  url: string,
  cookieHeader: string,
  csrfToken: string,
  fingerprint: DeviceFingerprint,
  opts: RequestOptions = {},
): Promise<unknown> {
  const method = opts.method ?? "GET";
  const endpoint = endpointFamilyFromUrl(url);
  let res: IGResponse;
  try {
    // Always go through undici. The dispatcher is built on first use; if no
    // proxyEndpoint is set on the state we still use undici (as a normal
    // Agent) so the transport is consistent.
    res = await proxyFetch(state, url, cookieHeader, csrfToken, fingerprint, opts);
  } catch (err) {
    if (err instanceof IGHttpError) throw err;
    throw new IGHttpError(
      0,
      formatNetworkErrorMessage(
        "[ig-http]",
        method,
        endpoint,
        err,
        state.proxyEndpoint,
      ),
      { cause: err, url, method },
    );
  }

  // Attribute transferred bytes to the active scrape context (user + profile)
  // for the admin bandwidth panel. Counts every response — including errors —
  // since those consume bandwidth too. Never throws.
  //
  // Units differ by lane, and the panel says so. When the automation service
  // reports a measurement (browser lane), these are TRUE WIRE BYTES for the
  // whole Firefox launch: the full instagram.com page load plus this API fetch,
  // i.e. the several megabytes that used to be counted as zero because Node
  // never saw them. Otherwise (HTTP/mobile) we fall back to decoded payload
  // size, which over-states those rows because IG gzips ~5-8x. The absolute
  // billable figure comes from the kernel counters in `proxy_wire_samples`.
  recordBytes({
    endpoint,
    botId: state.botId ?? state.automationIdentity?.bot_id ?? null,
    transport: state.automationTransport ?? "http",
    byteSource: res.wireBytesIn !== undefined || res.wireBytesOut !== undefined ? "browser_wire" : "decoded_payload",
    resourceBytes: res.wireBreakdown,
    failed: Boolean(res.transportError) || res.status >= 400,
    bytesIn: res.wireBytesIn ?? Buffer.byteLength(res.body, "utf8"),
    bytesOut:
      res.wireBytesOut ??
      Buffer.byteLength(url, "utf8") + Buffer.byteLength(opts.body ?? "", "utf8"),
  });

  if (res.transportError) {
    throw new IGHttpError(0, `[ig-http] browser transport failed: ${res.transportError}`, { url, method });
  }

  const responseDiagnostics = classifyInstagramResponse(res.body, res.headers, res.responseUrlClass, res.responseRedirected);
  // Instagram may redirect an authenticated API request to a logged-out page
  // and finish with 200. Treat the verified URL as auth evidence; a generic
  // HTML parse failure alone is not proof that a saved session has expired.
  if (res.status >= 200 && res.status < 300 && responseDiagnostics.responseUrlClass === "login") {
    throw new IGAuthExpiredError("[ig-http] auth rejected: Instagram login redirect", {
      status: res.status, responseDiagnostics,
    });
  }
  if (res.status >= 200 && res.status < 300
      && (responseDiagnostics.responseUrlClass === "challenge" || responseDiagnostics.responseUrlClass === "suspended")) {
    throw new IGHttpError(res.status, "[ig-http] Instagram checkpoint_required", {
      url, method, igErrorCode: "checkpoint_required", responseDiagnostics,
    });
  }

  // Wave 4 retry layer: we keep a truncated copy of every error body on the
  // thrown error so callers (cooldown layer, retry layer) can branch on
  // semantic IG codes like `checkpoint_required` without re-fetching.
  const truncatedBody = res.body.slice(0, 500);
  const authDiagnostics = inspectInstagramAuthResponse(res.status, res.body) ?? undefined;

  if (res.status === 401 || res.status === 403) {
    console.warn(
      `[ig-http] auth rejected ${res.status} ${method} ${endpoint}`,
    );
    throw new IGAuthExpiredError(
      `[ig-http] auth rejected (status ${res.status}) for ${method} ${endpoint}`,
      { status: res.status, body: truncatedBody, responseDiagnostics, authDiagnostics },
    );
  }
  if (res.status === 429) {
    const retryHeader = res.headers["retry-after"];
    const parsed = retryHeader ? Number(retryHeader) : NaN;
    const retryAfterMs =
      Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : 60_000;
    console.warn(
      `[ig-http] rate limited ${method} ${endpoint} retry-after=${retryAfterMs}ms`,
    );
    throw new IGRateLimitedError(
      retryAfterMs,
      `[ig-http] rate limited for ${method} ${endpoint}`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    const igErrorCode = parseIgErrorCode(res.body);
    console.warn(
      `[ig-http] error ${res.status} ${method} ${endpoint} ig-code=${igErrorCode ?? "unknown"}`,
    );
    throw new IGHttpError(
      res.status,
      `[ig-http] ${method} ${endpoint} failed with status ${res.status}`,
      { url, method, body: truncatedBody, igErrorCode, responseDiagnostics, authDiagnostics },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch (err) {
    console.warn(
      `[ig-http] non-JSON response ${method} ${endpoint} bytes=${Buffer.byteLength(res.body, "utf8")}`,
      responseDiagnostics,
    );
    throw new IGHttpError(
      res.status,
      `[ig-http] response not JSON for ${method} ${endpoint}`,
      { cause: err, url, method, responseDiagnostics },
    );
  }
  // A 200 envelope can still reject the read. Passing it to permissive media
  // schemas would incorrectly turn a failure into "no stories/highlights".
  if (parsed && typeof parsed === "object" && (parsed as { status?: unknown }).status === "fail") {
    const igErrorCode = parseIgErrorCode(res.body);
    if (igErrorCode === "login_required") {
      throw new IGAuthExpiredError("[ig-http] auth rejected: login_required", {
        status: res.status, body: truncatedBody, responseDiagnostics, authDiagnostics,
      });
    }
    throw new IGHttpError(res.status, `[ig-http] ${method} ${endpoint} returned a failed envelope`, {
      url, method, body: truncatedBody, igErrorCode, responseDiagnostics, authDiagnostics,
    });
  }
  return parsed;
}

// ─── Response parsing ────────────────────────────────────────────────────────
// Wave 2: hand-rolled asRecord/asString/... defenders removed. Each endpoint
// is now validated via a zod schema in server/domain/ig-schemas.ts and
// failures throw IGSchemaError which counts against the circuit breaker.

// Circuit-breaker wrapper: one call site for every outbound IG request so
// network errors, non-200 status, and schema errors all feed the breaker.
//
// Wave 6: keyed per `(botId, endpointFamily)` so a 24h IG-side checkpoint on
// one bot's followers endpoint cannot cascade into a global outage that
// blocks unrelated profile/posts/stories scrapes for every other bot.
function breakerKeyFor(holder: ClientState, url: string): string {
  const lane = holder.automationTransport === "browser" ? ":browser" : "";
  return `${holder.botId}${lane}:${endpointFamilyFromUrl(url)}`;
}

async function breakerCall<T>(
  holder: ClientState,
  url: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = breakerKeyFor(holder, url);
  const { probe } = assertCanCall(key);
  try {
    const result = await fn();
    recordSuccess(key, probe);
    return result;
  } catch (err) {
    if (isBreakerFailure(err)) {
      recordFailure(key, probe);
    }
    throw err;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface CreateBotClientOptions {
  userAgent?: string;
  // Wave 3: callers (ig-http-client factory) can pass a per-bot fingerprint.
  // When omitted we synthesise one from a random seed to keep backwards
  // compatibility for existing tests that create an anonymous client.
  fingerprint?: DeviceFingerprint;
  botUsername?: string;
  // Wave 4: bot's currently-assigned sticky proxy ("host:port"). When set,
  // every IG call routes through this endpoint via undici's ProxyAgent
  // (CONNECT tunnel + HTTP/2 upstream). When null we use a direct dispatcher.
  proxyEndpoint?: string | null;
  // Wave 6: stable bot id for per-(bot,endpoint) circuit-breaker keys. When
  // omitted we fall back to `botUsername` then `"unknown"` so the keyspace
  // never collapses into a single global breaker.
  botId?: string;
  /** Stored FastAPI Firefox identity for an explicitly migrated bot. */
  automationIdentity?: AutomationIdentity | null;
  /** Browser endpoints use invisible-playwright instead of pyhttpz. */
  automationTransport?: "http" | "browser";
}

export function createBotClient(
  sessionData: string,
  opts: CreateBotClientOptions = {},
): IGClient {
  // Every authenticated production request must cross the local automation
  // boundary. Keeping this guard in the lowest-level public factory catches
  // forgotten call sites before they can emit legacy Undici/Chromium-shaped
  // traffic with a Firefox-created session.
  if (process.env.NODE_ENV === "production" && !opts.automationIdentity) {
    throw new Error(
      `[ig-http] bot @${opts.botUsername ?? "unknown"} has no automation identity; refusing legacy direct Instagram transport`,
    );
  }
  const state = parseStorageState(sessionData);

  const liveCookies = filterLiveCookies(state.cookies).filter((c) => {
    const domain = c.domain ?? "";
    return domain.includes("instagram.com");
  });

  const sessionIdValue = findCookie(liveCookies, "sessionid");
  if (!sessionIdValue) {
    // Fix #4: expired/missing sessionid → IGAuthExpiredError, not a generic Error
    throw new IGAuthExpiredError(
      "[ig-http] sessionid cookie missing or expired in bot session",
    );
  }
  const csrfTokenOrNull = findCookie(liveCookies, "csrftoken");
  if (!csrfTokenOrNull) {
    throw new IGAuthExpiredError(
      "[ig-http] csrftoken cookie missing or expired in bot session",
    );
  }
  const csrfToken: string = csrfTokenOrNull;

  const cookieHeader = buildCookieHeader(liveCookies);
  // Wave 3: prefer full fingerprint, fall back to best-effort generation.
  const fingerprint: DeviceFingerprint =
    opts.fingerprint ??
    (opts.botUsername
      ? generateDeviceFingerprint(opts.botUsername)
      : {
          deviceId: "00000000-0000-4000-8000-000000000000",
          userAgent: opts.userAgent ?? DEFAULT_UA,
          appId: IG_APP_ID,
          timezone: "America/New_York",
          locale: "en-US",
          awakeHourStart: 10,
          awakeHourEnd: 23,
        });

  // One undici dispatcher per client, built lazily on first request and kept
  // hot across calls; torn down (with a timeout guard) on close().
  const holder: ClientState = {
    wwwClaim: "0",
    lastReferer: `${IG_WEB_ORIGIN}/`,
    proxyEndpoint: opts.proxyEndpoint ?? null,
    dispatcher: null,
    automationIdentity: opts.automationIdentity ?? null,
    automationTransport: opts.automationTransport ?? "http",
    storageState: state,
    botId: opts.botId ?? opts.botUsername ?? "unknown",
  };

  async function fetchProfile(username: string): Promise<IGProfile> {
    const url = `${IG_WEB_ORIGIN}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(holder, url, cookieHeader, csrfToken, fingerprint);
      // Wave 3: refresh referer so follow-up XHRs look like they came from
      // the profile page we just "navigated to".
      holder.lastReferer = `${IG_WEB_ORIGIN}/${encodeURIComponent(username)}/`;
      return parseProfileResponse(body);
    });
  }

  // Mobile-API profile fallback: GET /api/v1/users/<user_id>/info/ returns the
  // flat mobile profile shape and lives in a different rate-limit bucket than
  // web_profile_info, so it backs the cheap HTTP fallback when the numeric user
  // id is already known. Returns the same IGProfile domain shape (posts=[] —
  // this endpoint carries no timeline media).
  async function fetchProfileById(userId: string): Promise<IGProfile> {
    const url = `${IG_WEB_ORIGIN}/api/v1/users/${encodeURIComponent(userId)}/info/`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(holder, url, cookieHeader, csrfToken, fingerprint);
      return parseProfileInfoResponse(body);
    });
  }

  async function fetchUserFeed(
    pk: string,
    { count = 24, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFeedPage> {
    const params = new URLSearchParams({ count: String(count) });
    if (maxId) params.set("max_id", maxId);
    const url = `${IG_WEB_ORIGIN}/api/v1/feed/user/${encodeURIComponent(pk)}/?${params.toString()}`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(holder, url, cookieHeader, csrfToken, fingerprint);
      return parseFeedResponse(body);
    });
  }

  async function fetchGraphqlFriendshipPage(
    dimension: "followers" | "following",
    pk: string,
    count: number,
    cursor?: string,
  ): Promise<IGFriendshipPage> {
    const variables: Record<string, unknown> = {
      id: pk,
      include_reel: true,
      fetch_mutual: false,
      first: graphqlRosterPageSize(count),
    };
    if (cursor) variables.after = cursor;
    const params = new URLSearchParams({
      query_hash: GRAPHQL_FRIENDSHIP_QUERY_HASH[dimension],
      variables: JSON.stringify(variables),
    });
    const url = `${IG_WEB_ORIGIN}/graphql/query/?${params.toString()}`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(
        holder,
        url,
        cookieHeader,
        csrfToken,
        fingerprint,
      );
      const page = parseGraphqlFriendshipPageResponse(body, dimension);
      return {
        ...page,
        nextMaxId: page.nextMaxId
          ? `${GRAPHQL_CURSOR_PREFIX}${page.nextMaxId}`
          : null,
      };
    });
  }

  async function fetchFollowing(
    pk: string,
    { count = 50, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFriendshipPage> {
    if (maxId?.startsWith(GRAPHQL_CURSOR_PREFIX)) {
      return fetchGraphqlFriendshipPage(
        "following",
        pk,
        count,
        maxId.slice(GRAPHQL_CURSOR_PREFIX.length),
      );
    }
    const params = new URLSearchParams({ count: String(count) });
    if (maxId) params.set("max_id", maxId);
    const url = `${IG_WEB_ORIGIN}/api/v1/friendships/${encodeURIComponent(pk)}/following/?${params.toString()}`;
    try {
      return await breakerCall(holder, url, async () => {
        const body = await igRequest(holder, url, cookieHeader, csrfToken, fingerprint);
        const page = parseFriendshipPageResponse(body);
        // Preserve a usable limited preview as partial sightings. A verified
        // background source can request GraphQL explicitly; do not globally
        // change all readers or discard this data when an alternative fails.
        if (page.limitedPreview) return page;
        if (!page.restricted) return page;
        console.warn(
          `[ig-http] REST following list restricted for ${pk}; using authenticated GraphQL connection`,
        );
        return fetchGraphqlFriendshipPage("following", pk, count);
      });
    } catch (error) {
      if (!maxId && shouldTryGraphqlFriendshipFallback(error)) {
        console.warn(
          `[ig-http] REST following list unavailable for ${pk}; trying authenticated GraphQL connection`,
        );
        return fetchGraphqlFriendshipPage("following", pk, count);
      }
      throw error;
    }
  }

  async function fetchFollowers(
    pk: string,
    { count = 50, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFriendshipPage> {
    if (maxId?.startsWith(GRAPHQL_CURSOR_PREFIX)) {
      return fetchGraphqlFriendshipPage(
        "followers",
        pk,
        count,
        maxId.slice(GRAPHQL_CURSOR_PREFIX.length),
      );
    }
    const params = new URLSearchParams({ count: String(count) });
    if (maxId) params.set("max_id", maxId);
    const url = `${IG_WEB_ORIGIN}/api/v1/friendships/${encodeURIComponent(pk)}/followers/?${params.toString()}`;
    try {
      return await breakerCall(holder, url, async () => {
        const body = await igRequest(holder, url, cookieHeader, csrfToken, fingerprint);
        const page = parseFriendshipPageResponse(body);
        if (page.limitedPreview) return page;
        if (!page.restricted) return page;
        console.warn(
          `[ig-http] REST followers list restricted for ${pk}; using authenticated GraphQL connection`,
        );
        return fetchGraphqlFriendshipPage("followers", pk, count);
      });
    } catch (error) {
      if (!maxId && shouldTryGraphqlFriendshipFallback(error)) {
        console.warn(
          `[ig-http] REST followers list unavailable for ${pk}; trying authenticated GraphQL connection`,
        );
        return fetchGraphqlFriendshipPage("followers", pk, count);
      }
      throw error;
    }
  }

  async function sendFollow(targetPk: string): Promise<IGSendFollowResult> {
    const url = `${IG_WEB_ORIGIN}/api/v1/friendships/create/${encodeURIComponent(targetPk)}/`;
    return breakerCall(holder, url, async () => {
      const raw = await igRequest(holder, url, cookieHeader, csrfToken, fingerprint, {
        method: "POST",
        body: "",
      });
      const status = parseFriendshipStatusResponse(raw);
      return {
        status,
        raw: (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>,
      };
    });
  }

  // Bug-fix: GET /api/v1/friendships/show/<pk>/ — returns the bot↔target edge
  // for THIS bot's session. Used by the bot-follow-check worker to detect
  // accepted FRs against private accounts (where the public profile always
  // reports isPrivate=true regardless of FR state).
  async function fetchFriendshipStatus(
    targetPk: string,
  ): Promise<IGFriendshipStatus> {
    const url = `${IG_WEB_ORIGIN}/api/v1/friendships/show/${encodeURIComponent(targetPk)}/`;
    return breakerCall(holder, url, async () => {
      const raw = await igRequest(holder, url, cookieHeader, csrfToken, fingerprint);
      const parsed = FriendshipShowSchema.safeParse(raw);
      if (!parsed.success) {
        throw new IGSchemaError(
          "friendships/show",
          "[ig-schema] friendships/show response has invalid relationship fields",
        );
      }
      const data = parsed.data;
      return {
        following: data.following,
        outgoingRequest: data.outgoing_request,
        incomingRequest: data.incoming_request ?? false,
        followedBy: data.followed_by ?? false,
        isPrivate: data.is_private ?? true,
      };
    });
  }

  // Both HTTP and browser lanes here carry a WEB session and desktop identity.
  // Use the web reels endpoint for either lane. The feed/user/.../reel_media
  // route rejects these same valid sessions with "useragent mismatch" (400).
  // Native mobile sessions have a separate client and capability checks.
  async function fetchStoriesTray(pk: string): Promise<IGStoriesTray> {
    const params = new URLSearchParams({ reel_ids: pk });
    const url = `${IG_WEB_ORIGIN}/api/v1/feed/reels_media/?${params.toString()}`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(
        holder,
        url,
        cookieHeader,
        csrfToken,
        fingerprint,
      );
      const reels = parseHighlightReelsResponse(body);
      const reel = reels.find(reel => reel.id === pk);
      if (reels.length && !reel) throw new IGSchemaError('feed/reels_media', '[ig-http] stories response belongs to another account');
      return { items: reel?.items ?? [] };
    });
  }

  // Wave 4: dedicated Reels-tab feed. The "user feed" endpoint mostly returns
  // grid posts with reel-clips folded in inconsistently — IG's Reels tab uses
  // a separate clips-on-logged-in-user-reels-page query that returns only
  // reels (media_type=2 with product_type="clips"). Pagination via max_id is
  // POST-form-encoded for this one (web app idiosyncrasy).
  async function fetchUserClips(
    pk: string,
    { count = 12, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFeedPage> {
    const url = `${IG_WEB_ORIGIN}/api/v1/clips/user/`;
    return breakerCall(holder, url, async () => {
      const params = new URLSearchParams({
        target_user_id: pk,
        page_size: String(count),
        include_feed_video: "true",
      });
      if (maxId) params.set("max_id", maxId);
      const body = await igRequest(
        holder,
        url,
        cookieHeader,
        csrfToken,
        fingerprint,
        { method: "POST", body: params.toString() },
      );
      return parseClipsResponse(body);
    });
  }

  // Wave 4: posts where the user has been *tagged* by other accounts — covers
  // the "Tagged" tab on the profile. Useful for surfacing third-party content
  // featuring the tracked user that wouldn't otherwise appear in their grid.
  async function fetchUserTagged(
    pk: string,
    { count = 12, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFeedPage> {
    const params = new URLSearchParams({ count: String(count) });
    if (maxId) params.set("max_id", maxId);
    const url = `${IG_WEB_ORIGIN}/api/v1/usertags/${encodeURIComponent(
      pk,
    )}/feed/?${params.toString()}`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(
        holder,
        url,
        cookieHeader,
        csrfToken,
        fingerprint,
      );
      return parseFeedResponse(body);
    });
  }

  // Wave 3b (Agent B): the list of a user's highlight collections. Items here
  // are tray entries (cover, title, count) — not the media inside each reel.
  async function fetchHighlightsTray(pk: string): Promise<IGHighlightsTray> {
    const url = `${IG_WEB_ORIGIN}/api/v1/highlights/${encodeURIComponent(pk)}/highlights_tray/`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(
        holder,
        url,
        cookieHeader,
        csrfToken,
        fingerprint,
      );
      return parseHighlightsTrayResponse(body);
    });
  }

  // Wave 3b (Agent B): fetch the media inside one or more highlight reels.
  // `highlightIds` must be prefixed `highlight:<id>` (IG's native format); the
  // scraper passes through whatever the tray endpoint returned. Empty input
  // short-circuits with no network call.
  async function fetchHighlightReels(
    highlightIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<IGHighlightReel>> {
    if (highlightIds.length === 0) return [];
    const params = new URLSearchParams();
    for (const hid of highlightIds) params.append("reel_ids", hid);
    const url = `${IG_WEB_ORIGIN}/api/v1/feed/reels_media/?${params.toString()}`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(
        holder,
        url,
        cookieHeader,
        csrfToken,
        fingerprint,
      );
      return parseHighlightReelsResponse(body);
    });
  }

  // Wave 5: media comments. The mobile API endpoint accepts:
  //   - permalink_enabled=false  → IG returns the JSON envelope (not HTML)
  //   - can_support_threading=true → include nested-thread metadata fields
  //   - max_id=<cursor> → pagination cursor returned as next_max_id
  // We send a desktop UA / fingerprint (same as feed/user) — the comments
  // endpoint accepts both desktop and mobile. Pagination, jitter sleeps, and
  // ceiling caps are enforced by the scraper layer; this function returns one
  // page exactly as IG sent it.
  async function fetchMediaComments(
    mediaId: string,
    maxId?: string,
  ): Promise<IGCommentsPage> {
    const params = new URLSearchParams({
      can_support_threading: "true",
      permalink_enabled: "false",
    });
    if (maxId) params.set("max_id", maxId);
    const url = `${IG_WEB_ORIGIN}/api/v1/media/${encodeURIComponent(
      mediaId,
    )}/comments/?${params.toString()}`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(
        holder,
        url,
        cookieHeader,
        csrfToken,
        fingerprint,
      );
      return parseCommentsResponse(body);
    });
  }

  // Wave 5: media likers. The endpoint is single-page — IG returns up to ~100
  // users plus a `user_count`, with no max_id cursor. We send the same
  // desktop UA / fingerprint as feed/user; this endpoint accepts both
  // desktop and mobile contexts.
  async function fetchMediaLikers(mediaId: string): Promise<IGLikersPage> {
    const url = `${IG_WEB_ORIGIN}/api/v1/media/${encodeURIComponent(
      mediaId,
    )}/likers/`;
    return breakerCall(holder, url, async () => {
      const body = await igRequest(
        holder,
        url,
        cookieHeader,
        csrfToken,
        fingerprint,
      );
      return parseLikersResponse(body);
    });
  }

  // B15: tear down the undici dispatcher (closes pooled CONNECT tunnels).
  // closeClientDispatcher closes with a 5s timeout guard and logs failures, so
  // a stuck tunnel can never hang teardown. Returns the teardown promise:
  // callers that need confirmation (the async port wrapper, proxy rotation)
  // can await it; the legacy sync `IGClient.close(): void` contract still holds
  // because a `() => Promise<void>` is assignable to `() => void`.
  async function close(): Promise<void> {
    await closeClientDispatcher(holder);
  }

  // Formalized (Wave 9): raw authenticated request to any IG path, returns
  // parsed JSON. Reuses this client's cookies/proxy/fingerprint/breaker so it
  // is indistinguishable from a normal scrape. Backs the liked-by-inference
  // harvester's home-feed + reels-feed polling (see server/services/
  // liked-by-harvester.ts). Declared on the IGClient interface above.
  async function fetchRaw(
    path: string,
    opts: RequestOptions = {},
  ): Promise<unknown> {
    const url = path.startsWith("http") ? path : `${IG_WEB_ORIGIN}${path}`;
    return breakerCall(holder, url, async () =>
      igRequest(holder, url, cookieHeader, csrfToken, fingerprint, opts),
    );
  }

  return {
    csrfToken,
    exportSessionData: () => JSON.stringify(holder.storageState),
    fetchRaw,
    fetchProfile,
    fetchProfileById,
    fetchUserFeed,
    fetchUserClips,
    fetchUserTagged,
    fetchFollowing,
    fetchFollowers,
    sendFollow,
    fetchFriendshipStatus,
    fetchStoriesTray,
    fetchHighlightsTray,
    fetchHighlightReels,
    fetchMediaComments,
    fetchMediaLikers,
    close,
  };
}

// ─── Port factory ────────────────────────────────────────────────────────────
//
// Wave 2: the domain port speaks a narrower interface — no csrfToken, no raw
// body, async close(). Business logic (bot-collectors) now depends only on
// this factory, which makes the HTTP layer swappable.
//
// Audit B1: the factory now REQUIRES the full bot identity. The old
// single-arg form built a client with no proxy endpoint and no fingerprint,
// so the follow path (decorateBeforeFollow / fetchProfile / sendFollow)
// egressed directly from the datacenter IP wearing the shared DEFAULT_UA and
// an all-zero deviceId — the exact homogeneous signature IG flags. Every
// client must present the same residential exit and per-bot device identity
// its session was created with, so a missing proxy endpoint is a hard error
// rather than a silent direct connection.

export interface BotClientIdentity {
  readonly botId: string;
  readonly botUsername: string;
  readonly fingerprint: DeviceFingerprint;
  /**
   * Sticky residential proxy ("host:port" or "host:port:user:pass") from
   * bot_accounts.proxy_endpoint. Required — never empty.
   */
  readonly proxyEndpoint: string;
  readonly automationIdentity?: AutomationIdentity | null;
}

export type IGBotClientFactory = (
  sessionData: string,
  identity: BotClientIdentity,
) => Promise<IGClientPort>;

export const createHttpBotClient: IGBotClientFactory = async (
  sessionData: string,
  identity: BotClientIdentity,
): Promise<IGClientPort> => {
  if (!identity.proxyEndpoint) {
    throw new Error(
      `[ig-http] createHttpBotClient: bot @${identity.botUsername} has no proxy_endpoint — refusing direct (datacenter-IP) IG egress`,
    );
  }
  return createHttpBotClientWithFingerprint(
    sessionData,
    identity.fingerprint,
    identity.botUsername,
    identity.proxyEndpoint,
    identity.botId,
    identity.automationIdentity,
  );
};

// Wave 3: factory variant that takes a fingerprint. Used by bot-collectors
// when a caller has the full bot row (including persistent device identity).
// Kept separate so existing call sites that only have raw sessionData keep
// working via createHttpBotClient.
//
// Wave 4: optional `proxyEndpoint` arg routes every IG call through the
// supplied "host:port" via undici ProxyAgent (CONNECT + HTTP/2). Required
// for production scraping so traffic exits the residential pool, not our
// datacenter IP.
export function createHttpBotClientWithFingerprint(
  sessionData: string,
  fingerprint: DeviceFingerprint | null | undefined,
  botUsername?: string,
  proxyEndpoint?: string | null,
  botId?: string,
  automationIdentity?: AutomationIdentity | null,
  automationTransport: "http" | "browser" = "http",
): IGClientPort {
  // Production Instagram traffic is owned by the loopback FastAPI service.
  // A missing identity means this caller has not crossed that boundary yet;
  // fail before constructing the legacy Undici transport so a stale queue or
  // forgotten call site can never bypass pyhttpz/invisible-playwright.
  // Non-production keeps the compatibility path for isolated unit tests.
  if (process.env.NODE_ENV === "production" && !automationIdentity) {
    throw new Error(
      `[ig-http] bot @${botUsername ?? "unknown"} has no automation identity; refusing legacy direct Instagram transport`,
    );
  }

  // Wave 6: if no explicit fingerprint is provided, derive a stable per-bot
  // one from the diversified personality so the bot still gets a unique,
  // reproducible identity instead of falling back to the shared default UA.
  // Requires a username to seed the personality — without one we have no
  // stable identity to derive, so we fail loudly rather than silently
  // emitting a homogeneous fingerprint.
  let resolvedFingerprint: DeviceFingerprint;
  if (fingerprint) {
    resolvedFingerprint = fingerprint;
  } else if (botUsername && botUsername.length > 0) {
    resolvedFingerprint = fingerprintFromPersonality(botUsername);
  } else {
    throw new Error(
      "createHttpBotClientWithFingerprint requires either a fingerprint or botUsername",
    );
  }

  const legacy = createBotClient(sessionData, {
    fingerprint: resolvedFingerprint,
    botUsername,
    proxyEndpoint: proxyEndpoint ?? null,
    botId,
    automationIdentity,
    automationTransport,
  });
  return {
    fetchProfile: (username) => legacy.fetchProfile(username),
    exportSessionData: () => legacy.exportSessionData(),
    fetchProfileById: (userId) => legacy.fetchProfileById(userId),
    // Raw authenticated GET passthrough. This adapter is an explicit allow-list
    // of port methods, so omitting fetchRaw silently DROPPED it even though the
    // legacy client implements it. Callers guard with
    // `typeof client.fetchRaw !== "function"` and then no-op, which is why
    // getFreshMediaThumbnail() always returned null and expired IG thumbnails
    // could never be re-signed.
    fetchRaw: (path, opts) => legacy.fetchRaw(path, opts),
    fetchUserFeed: (pk, opts) => legacy.fetchUserFeed(pk, opts),
    fetchUserClips: (pk, opts) => legacy.fetchUserClips(pk, opts),
    fetchUserTagged: (pk, opts) => legacy.fetchUserTagged(pk, opts),
    fetchFollowing: (pk, opts) => legacy.fetchFollowing(pk, opts),
    fetchFollowers: (pk, opts) => legacy.fetchFollowers(pk, opts),
    sendFollow: async (targetPk) => (await legacy.sendFollow(targetPk)).status,
    fetchFriendshipStatus: (targetPk) => legacy.fetchFriendshipStatus(targetPk),
    fetchStoriesTray: (pk) => legacy.fetchStoriesTray(pk),
    fetchHighlightsTray: (pk) => legacy.fetchHighlightsTray(pk),
    fetchHighlightReels: (ids) => legacy.fetchHighlightReels(ids),
    fetchMediaComments: (mediaId, maxId) =>
      legacy.fetchMediaComments(mediaId, maxId),
    fetchMediaLikers: (mediaId) => legacy.fetchMediaLikers(mediaId),
    // B15: await the dispatcher teardown so the port's async close() actually
    // confirms CONNECT tunnels are released (with the 5s timeout guard inside).
    close: async () => {
      await legacy.close();
    },
  };
}
