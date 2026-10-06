// ─── Instagram MOBILE-API read transport ─────────────────────────────────────
//
// A third read transport alongside the web HTTP client (ig-http-client.ts) and
// the Firefox/FastAPI browser client (ig-browser-read-client.ts). This one
// drives pre-authenticated MOBILE app sessions: an `Authorization: Bearer
// IGT:2:<base64>` token plus an Android device fingerprint, replayed against
// i.instagram.com/api/v1 — the native mobile app's own API surface.
//
// Why a separate client rather than a flag on the web client:
//   - Different origin (i.instagram.com, not www.instagram.com).
//   - Different auth: Bearer header + sessionid cookie, NO csrftoken (the web
//     client HARD-THROWS when csrftoken is absent — mobile sessions never have
//     one).
//   - Different headers: X-IG-App-ID (Android app), X-IG-Android-ID,
//     X-IG-Device-ID, mobile User-Agent.
// The endpoint PATHS and JSON response shapes are identical to the web v1 API,
// so every domain parser in ig-schemas.ts is reused verbatim.
//
// All 12 IGClientPort read methods are implemented so a mobile bot is a
// drop-in pool member. sendFollow is included for parity but the collection
// path is read-only.

import {
  Agent as UndiciAgent,
  ProxyAgent as UndiciProxyAgent,
  fetch as undiciFetch,
} from "undici";

import { proxyAgentUriForEndpoint } from "./services/proxy-provider.js";
import { recordBytes } from "./services/bandwidth-meter.js";
import { operationSignal } from "./services/operation-context.js";
import {
  IGAuthExpiredError,
  IGRateLimitedError,
  IGHttpError,
  formatNetworkErrorMessage,
} from "./ig-http-client.js";
import type { MobileSession } from "./services/mobile-session.js";
import { inspectInstagramAuthResponse } from "./services/instagram-auth-diagnostics.js";
import type {
  IGClientPort,
  IGProfile,
  IGFeedPage,
  IGFriendshipPage,
  IGFriendshipStatus,
  IGStoriesTray,
  IGHighlightsTray,
  IGHighlightReel,
  IGCommentsPageDomain,
  IGLikersPage,
} from "./domain/ig-client-port.js";
import {
  parseProfileInfoResponse,
  parseFeedResponse,
  parseClipsResponse,
  parseFriendshipPageResponse,
  parseCommentsResponse,
  parseLikersResponse,
} from "./domain/ig-schemas.js";
import {
  parseHighlightsTrayResponse,
  parseHighlightReelsResponse,
  parseStoriesResponse,
} from "./domain/ig-stories-schemas.js";

const MOBILE_ORIGIN = "https://i.instagram.com";
// Instagram Android app id (distinct from the web app id 936619743392459).
const IG_ANDROID_APP_ID = "567067343352427";
const IG_CAPABILITIES = "3brTv10=";
// A recent Bloks layout hash the Android app pins. IG's sensitive endpoints
// check for its presence; the exact value is not validated per-request but a
// plausible current one avoids the "no bloks version" heuristic.
const IG_BLOKS_VERSION_ID =
  "ce555163c8b2ba26d4d1d54f8b8b0c3e5ca3a6c1e1a0a4d4e1a0a4d4e1a0a4d4";
const REQUEST_TIMEOUT_MS = 30_000;

export interface MobileReadClientOptions {
  readonly session: MobileSession;
  /** Sticky "host:port[:user:pass]" residential lane. Null → direct (tests only). */
  readonly proxyEndpoint: string | null;
  readonly botId: string;
  readonly botUsername: string;
}

interface MobileClientState {
  wwwClaim: string;
  // csrftoken minted by IG (Set-Cookie on responses). The web-rollout endpoints
  // (friendships/likers/stories/highlights/comments) 403 "login_required"
  // without a matching x-csrftoken double-submit; the profile/feed routes don't
  // need it. Captured from the first response that sets it, then replayed.
  csrfToken: string | null;
  dispatcher: UndiciAgent | UndiciProxyAgent | null;
}

interface MobileRequestOptions {
  method?: "GET" | "POST";
  body?: string;
}

function endpointFamily(path: string): string {
  if (path.includes("/friendships/") && path.includes("/followers")) return "followers";
  if (path.includes("/friendships/") && path.includes("/following")) return "following";
  if (path.includes("/friendships/")) return "friendships";
  if (path.includes("/usernameinfo") || path.includes("/info/")) return "profile";
  if (path.includes("/feed/user/") && path.includes("reel_media")) return "stories";
  if (path.includes("/feed/reels_media")) return "highlights";
  if (path.includes("/highlights/")) return "highlights_tray";
  if (path.includes("/feed/user/")) return "feed";
  if (path.includes("/clips/user")) return "clips";
  if (path.includes("/usertags/")) return "tagged";
  if (path.includes("/comments")) return "comments";
  if (path.includes("/likers")) return "likers";
  return "other";
}

function ensureDispatcher(
  state: MobileClientState,
  proxyEndpoint: string | null,
): UndiciAgent | UndiciProxyAgent {
  if (state.dispatcher) return state.dispatcher;
  if (proxyEndpoint) {
    // HTTP/1.1 upstream: the residential CONNECT tunnel mangles HTTP/2 framing
    // on large IG responses (see undici ProxyAgent notes in ig-http-client).
    state.dispatcher = new UndiciProxyAgent({
      uri: proxyAgentUriForEndpoint(proxyEndpoint),
      requestTls: { rejectUnauthorized: true },
    });
  } else {
    state.dispatcher = new UndiciAgent();
  }
  return state.dispatcher;
}

/**
 * Build a mobile read client for one pre-authenticated Bearer session. Returns
 * the same IGClientPort the web/browser transports return, so the scraper can
 * treat a mobile bot identically.
 */
export function createMobileReadClient(
  opts: MobileReadClientOptions,
): IGClientPort {
  const { session, proxyEndpoint, botUsername } = opts;
  const state: MobileClientState = {
    wwwClaim: session.wwwClaim || "0",
    csrfToken: null,
    dispatcher: null,
  };

  // Stable per-session device/pigeon ids derived from the export's device uuids
  // so every request from this bot presents a consistent app install — IG
  // cross-checks these on the sensitive endpoints (friendships/reel_media/
  // highlights/likers) and issues login_required when they are absent or churn.
  const familyDeviceId = session.extraUuids[0] ?? session.deviceUuid;
  const pigeonSessionId = session.extraUuids[1] ?? session.deviceUuid;

  function buildHeaders(method: "GET" | "POST"): Record<string, string> {
    const headers: Record<string, string> = {
      "user-agent": session.userAgent,
      authorization: session.bearer,
      "x-ig-app-id": IG_ANDROID_APP_ID,
      "x-ig-capabilities": IG_CAPABILITIES,
      "x-ig-android-id": session.androidId,
      "x-ig-device-id": session.deviceUuid,
      "x-ig-family-device-id": familyDeviceId,
      "x-pigeon-session-id": `UFS-${pigeonSessionId}-0`,
      "x-mid": session.mid,
      "x-ig-www-claim": state.wwwClaim,
      "ig-intended-user-id": session.dsUserId,
      // Double-submit csrf: the web-rollout endpoints reject without it. Sent
      // once IG has handed us a csrftoken (captured from Set-Cookie); harmless
      // on the routes that don't need it.
      ...(state.csrfToken ? { "x-csrftoken": state.csrfToken } : {}),
      "x-ig-connection-type": "WIFI",
      "x-ig-connection-speed": "-1kbps",
      "x-ig-bandwidth-speed-kbps": "-1.000",
      "x-ig-bandwidth-totalbytes-b": "0",
      "x-ig-bandwidth-totaltime-ms": "0",
      "x-ig-app-locale": "en_US",
      "x-ig-device-locale": "en_US",
      "x-ig-mapped-locale": "en_US",
      "x-bloks-version-id": IG_BLOKS_VERSION_ID,
      "x-bloks-is-layout-rtl": "false",
      "x-fb-http-engine": "Liger",
      "x-fb-client-ip": "True",
      "x-fb-server-cluster": "True",
      accept: "*/*",
      "accept-language": "en-US",
      "accept-encoding": "gzip, deflate",
      priority: "u=3",
      // IG's edge applies a fetch-metadata (Sec-Fetch) policy to the timeline
      // routes (feed/user, reel_media) and 400s "SecFetch Policy violation"
      // without them; the profile routes are exempt. Present same-origin/cors,
      // which the routes accept.
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      cookie: buildCookieHeader(session, state.csrfToken),
    };
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    }
    return headers;
  }

  async function mobileRequest(
    path: string,
    reqOpts: MobileRequestOptions = {},
  ): Promise<unknown> {
    const method = reqOpts.method ?? "GET";
    const url = `${MOBILE_ORIGIN}${path}`;
    const endpoint = endpointFamily(path);
    const dispatcher = ensureDispatcher(state, proxyEndpoint);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let status: number;
    let bodyText: string;
    let retryAfter: string | null = null;
    try {
      const res = await undiciFetch(url, {
        method,
        headers: buildHeaders(method),
        body: method === "POST" ? reqOpts.body ?? "" : undefined,
        dispatcher,
        signal: operationSignal() ? AbortSignal.any([ac.signal, operationSignal()!]) : ac.signal,
      });
      status = res.status;
      const claim =
        res.headers.get("x-ig-set-www-claim") ?? res.headers.get("x-ig-www-claim");
      if (claim && claim !== "0") state.wwwClaim = claim;
      // Capture a csrftoken the moment IG mints one (Set-Cookie), so the
      // web-rollout endpoints get a matching x-csrftoken on the next call.
      const setCookies =
        typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      for (const c of setCookies) {
        const m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(c);
        if (m && m[1] && m[1] !== "missing") state.csrfToken = m[1];
      }
      retryAfter = res.headers.get("retry-after");
      bodyText = await res.text();
    } catch (err) {
      throw new IGHttpError(
        0,
        `${formatNetworkErrorMessage("[ig-mobile]", method, endpoint, err, proxyEndpoint)} @${botUsername}`,
        { cause: err, url, method },
      );
    } finally {
      clearTimeout(timer);
    }

    recordBytes({
      endpoint,
      botId: opts.botId, transport: "mobile", byteSource: "decoded_payload", failed: status >= 400,
      bytesIn: Buffer.byteLength(bodyText, "utf8"),
      bytesOut: Buffer.byteLength(url, "utf8") + Buffer.byteLength(reqOpts.body ?? "", "utf8"),
    });

    const truncated = bodyText.slice(0, 500);
    const authDiagnostics = inspectInstagramAuthResponse(status, bodyText);
    if (authDiagnostics?.reason === "login_required") {
      throw new IGAuthExpiredError(
        `[ig-mobile] auth rejected (status ${status}) for ${method} ${endpoint} @${botUsername}`,
        { status, body: truncated, authDiagnostics },
      );
    }
    if (status === 429) {
      const retryMs = retryAfter ? Number(retryAfter) * 1000 : 60_000;
      throw new IGRateLimitedError(
        Number.isFinite(retryMs) ? retryMs : 60_000,
        `[ig-mobile] rate limited (429) for ${method} ${endpoint} @${botUsername}`,
      );
    }
    if (status < 200 || status >= 300 || authDiagnostics) {
      const reason = authDiagnostics?.reason;
      const igErrorCode = reason === "checkpoint_required" || reason === "challenge_required"
        || reason === "feedback_required" ? reason : undefined;
      throw new IGHttpError(
        status,
        `[ig-mobile] HTTP ${status} for ${method} ${endpoint} @${botUsername}`,
        { url, method, body: truncated, igErrorCode, authDiagnostics: authDiagnostics ?? undefined },
      );
    }

    try {
      return JSON.parse(bodyText);
    } catch {
      throw new IGHttpError(status, `[ig-mobile] non-JSON body for ${method} ${endpoint}`, {
        url,
        method,
        body: truncated,
      });
    }
  }

  // ── IGClientPort methods ──────────────────────────────────────────────────

  async function fetchProfile(username: string): Promise<IGProfile> {
    // Mobile profile-by-username. Returns the flat { user } shape (no timeline
    // media — posts come from fetchUserFeed, same as the web fallback path).
    const body = await mobileRequest(
      `/api/v1/users/${encodeURIComponent(username)}/usernameinfo/`,
    );
    return parseProfileInfoResponse(body);
  }

  async function fetchProfileById(userId: string): Promise<IGProfile> {
    const body = await mobileRequest(`/api/v1/users/${encodeURIComponent(userId)}/info/`);
    return parseProfileInfoResponse(body);
  }

  async function fetchUserFeed(
    pk: string,
    { count = 24, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFeedPage> {
    const params = new URLSearchParams({ count: String(count) });
    if (maxId) params.set("max_id", maxId);
    const body = await mobileRequest(
      `/api/v1/feed/user/${encodeURIComponent(pk)}/?${params.toString()}`,
    );
    // A 200 login/error envelope must never parse as an empty successful feed
    // and advance freshness. Explicit items:[] remains a valid empty result.
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        (body as { status?: unknown }).status === "fail" ||
        !Array.isArray((body as { items?: unknown }).items)) {
      throw new IGHttpError(200, "[ig-mobile] invalid feed response: expected successful items array", {
        method: "GET", url: `${MOBILE_ORIGIN}/api/v1/feed/user/${encodeURIComponent(pk)}/`,
      });
    }
    return parseFeedResponse(body);
  }

  async function fetchUserClips(
    pk: string,
    { count = 12, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFeedPage> {
    const params = new URLSearchParams({
      target_user_id: pk,
      page_size: String(count),
      include_feed_video: "true",
    });
    if (maxId) params.set("max_id", maxId);
    const body = await mobileRequest(`/api/v1/clips/user/`, {
      method: "POST",
      body: params.toString(),
    });
    return parseClipsResponse(body);
  }

  async function fetchUserTagged(
    pk: string,
    { count = 12, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFeedPage> {
    const params = new URLSearchParams({ count: String(count) });
    if (maxId) params.set("max_id", maxId);
    const body = await mobileRequest(
      `/api/v1/usertags/${encodeURIComponent(pk)}/feed/?${params.toString()}`,
    );
    return parseFeedResponse(body);
  }

  async function fetchFollowing(
    pk: string,
    { count = 50, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFriendshipPage> {
    const params = new URLSearchParams({ count: String(count) });
    if (maxId) params.set("max_id", maxId);
    const body = await mobileRequest(
      `/api/v1/friendships/${encodeURIComponent(pk)}/following/?${params.toString()}`,
    );
    return parseFriendshipPageResponse(body);
  }

  async function fetchFollowers(
    pk: string,
    { count = 50, maxId }: { count?: number; maxId?: string } = {},
  ): Promise<IGFriendshipPage> {
    const params = new URLSearchParams({ count: String(count) });
    if (maxId) params.set("max_id", maxId);
    const body = await mobileRequest(
      `/api/v1/friendships/${encodeURIComponent(pk)}/followers/?${params.toString()}`,
    );
    return parseFriendshipPageResponse(body);
  }

  async function sendFollow(targetPk: string): Promise<IGFriendshipStatus> {
    const body = await mobileRequest(
      `/api/v1/friendships/create/${encodeURIComponent(targetPk)}/`,
      { method: "POST", body: "" },
    );
    const fs = (body && typeof body === "object" ? (body as Record<string, unknown>).friendship_status : null) as
      | Record<string, unknown>
      | null;
    return {
      following: Boolean(fs?.following),
      outgoingRequest: Boolean(fs?.outgoing_request),
      incomingRequest: Boolean(fs?.incoming_request),
      followedBy: Boolean(fs?.followed_by),
      isPrivate: Boolean(fs?.is_private),
    };
  }

  async function fetchStoriesTray(pk: string): Promise<IGStoriesTray> {
    const body = await mobileRequest(
      `/api/v1/feed/user/${encodeURIComponent(pk)}/reel_media/`,
    );
    return parseStoriesResponse(body);
  }

  async function fetchHighlightsTray(pk: string): Promise<IGHighlightsTray> {
    const body = await mobileRequest(
      `/api/v1/highlights/${encodeURIComponent(pk)}/highlights_tray/`,
    );
    return parseHighlightsTrayResponse(body);
  }

  async function fetchHighlightReels(
    highlightIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<IGHighlightReel>> {
    if (highlightIds.length === 0) return [];
    const params = new URLSearchParams();
    for (const hid of highlightIds) params.append("reel_ids", hid);
    const body = await mobileRequest(`/api/v1/feed/reels_media/?${params.toString()}`);
    return parseHighlightReelsResponse(body);
  }

  async function fetchMediaComments(
    mediaId: string,
    maxId?: string,
  ): Promise<IGCommentsPageDomain> {
    const params = new URLSearchParams({
      can_support_threading: "true",
      permalink_enabled: "false",
    });
    if (maxId) params.set("max_id", maxId);
    const body = await mobileRequest(
      `/api/v1/media/${encodeURIComponent(mediaId)}/comments/?${params.toString()}`,
    );
    return parseCommentsResponse(body);
  }

  async function fetchMediaLikers(mediaId: string): Promise<IGLikersPage> {
    const body = await mobileRequest(
      `/api/v1/media/${encodeURIComponent(mediaId)}/likers/`,
    );
    return parseLikersResponse(body);
  }

  async function fetchRaw(
    path: string,
    init?: { method?: "GET" | "POST"; body?: string },
  ): Promise<unknown> {
    return mobileRequest(path, { method: init?.method, body: init?.body });
  }

  async function close(): Promise<void> {
    const d = state.dispatcher;
    state.dispatcher = null;
    if (!d) return;
    // undici's graceful close() can hang forever if an in-flight CONNECT tunnel
    // never drains (same B15 hazard the web client guards against). Race it
    // against a 5s timeout and force-destroy on expiry so a stuck tunnel can
    // never wedge the caller — this hung the liked-by squad harvest.
    await Promise.race([
      d.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
    try {
      await d.destroy();
    } catch {
      /* already closed / destroyed — best effort */
    }
  }

  return {
    fetchProfile,
    fetchProfileById,
    fetchUserFeed,
    fetchUserClips,
    fetchUserTagged,
    fetchFollowing,
    fetchFollowers,
    sendFollow,
    fetchStoriesTray,
    fetchHighlightsTray,
    fetchHighlightReels,
    fetchMediaComments,
    fetchMediaLikers,
    fetchRaw,
    close,
  };
}

function buildCookieHeader(session: MobileSession, csrfToken: string | null): string {
  const parts = [
    `sessionid=${session.sessionid}`,
    `ds_user_id=${session.dsUserId}`,
  ];
  if (session.mid) parts.push(`mid=${session.mid}`);
  if (session.rur) parts.push(`rur=${session.rur}`);
  if (csrfToken) parts.push(`csrftoken=${csrfToken}`);
  return parts.join("; ");
}
