// ─── Smartproxy.org sticky-port provider ────────────────────────────────────
//
// Wave 4: bots login + scrape from a residential pool. The provider returns
// an "endpoint generator" URL that yields N sticky host:port pairs that are
// pinned to the same upstream IP for ~30 minutes (`life=30`). Authentication
// is by IP whitelist on the provider side, so requests carry no creds.
//
// We treat the API as an *opaque endpoint dispenser*: we ask for fresh
// endpoints when a bot has no proxy yet, when its current proxy is past its
// 30-min sticky window, or when login has failed and we suspect the upstream
// IP is rate-limited. Endpoints are cheap to ask for (the provider just
// rotates a pre-allocated pool) so we don't keep a persistent cache; the
// bot row owns the endpoint and its expiry.
//
// SMARTPROXY_API_URL env var holds the full configured URL — we don't hard
// code keys here so they can be rotated without a deploy.
// ─────────────────────────────────────────────────────────────────────────────

import { logger as baseLogger } from "../observability/logger.js";
import {
  isDataImpulseGatewayHost,
  isKnownEphemeralDataImpulseEndpoint,
} from "./proxy-durability.js";

const logger = baseLogger.child({ module: "proxy-provider" });

const STICKY_DURATION_MIN = 30;
// Refresh slightly *before* the upstream window closes so we never carry an
// expired endpoint into a long Playwright login.
const REFRESH_GUARD_MS = 2 * 60 * 1000;
const DIRECT_GATEWAY_STICKY_HOURS = 24;
const DEDICATED_RANGE_VALIDITY_HOURS = 24;

// ─── Hot-path probe latency budget (B10) ────────────────────────────────────
//
// `fetchHealthyEndpoints` runs *inside* the awaited scrape/login path. The
// old loop probed up to 20 endpoints sequentially with a 1.5s sleep on every
// miss → tens of seconds of in-path stall, multiplied by refresh storms on
// the concurrency-1 profile loop. We bound the worst case sharply:
//
//   * probe at most PROXY_PROBE_MAX_ATTEMPTS endpoints (default 5),
//   * probe PROXY_PROBE_CONCURRENCY candidates at once (default 3) and take
//     the first healthy one, aborting the losers,
//   * no inter-probe sleep — the concurrency already spreads the load and the
//     per-probe timeout caps each attempt.
//
// Worst-case in-path latency therefore collapses from
//   ~20 × (10s probe + 1.5s sleep) ≈ 230s
// to roughly
//   ceil(5 / 3) × 10s ≈ 20s,
// and the common case (a healthy endpoint in the first wave) is ~one probe
// timeout. If nothing is healthy inside the budget we fail fast with a
// retryable error instead of grinding the whole batch.
const DEFAULT_PROBE_MAX_ATTEMPTS = 5;
const DEFAULT_PROBE_CONCURRENCY = 3;
const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
let providerUnavailableUntil = 0;

function providerCooldownMs(): number {
  return Math.max(
    30_000,
    Number(
      process.env.PROXY_PROVIDER_UNAVAILABLE_COOLDOWN_MS ??
        String(DEFAULT_PROVIDER_COOLDOWN_MS),
    ) || DEFAULT_PROVIDER_COOLDOWN_MS,
  );
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function probeMaxAttempts(): number {
  return readPositiveIntEnv("PROXY_PROBE_MAX_ATTEMPTS", DEFAULT_PROBE_MAX_ATTEMPTS);
}

function probeConcurrency(): number {
  return readPositiveIntEnv("PROXY_PROBE_CONCURRENCY", DEFAULT_PROBE_CONCURRENCY);
}

export interface ProxyEndpoint {
  /** Canonical endpoint. May be "host:port" or "host:port:username:password". */
  endpoint: string;
  /** Identifier used for logs and DB persistence. The port is unique per IP. */
  sessionId: string;
  /** Wall-clock expiry of the upstream sticky window. */
  expiresAt: Date;
}

interface FetchOptions {
  /** How many endpoints to request. Default: pool of 5 to absorb dead ports. */
  count?: number;
  /** ISO-3166 country code, e.g. "US". Default: provider random. */
  country?: string;
  /** Override the API URL (for tests / staging). */
  apiUrl?: string;
  /** Fail-closed default is account-session; public callers opt in explicitly. */
  purpose?: "account-session" | "public-read";
  /** Endpoints already tried by this flow; skipped before probing. */
  excludeEndpoints?: readonly string[];
  /** Optional per-flow cap; browser preflight keeps this deliberately small. */
  maxAttempts?: number;
  /**
   * Optional caller-owned probe. Migrated bot activation supplies a pyhttpz
   * probe through the local automation service, so Instagram never sees the
   * legacy Node/Undici transport while a proxy lane is being selected.
   */
  probe?: (
    endpoint: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<string | null>;
}

function getApiUrl(override?: string): string {
  const url = override ?? process.env.SMARTPROXY_API_URL;
  if (!url) {
    throw new Error(
      "[proxy-provider] SMARTPROXY_API_URL is not configured",
    );
  }
  return url;
}

function getDirectGatewayConfig(): {
  host: string;
  port: string;
  username: string;
  password: string;
} | null {
  const host = process.env.PROXY_GATEWAY_HOST;
  const port = process.env.PROXY_GATEWAY_PORT;
  const username = process.env.PROXY_GATEWAY_USERNAME;
  const password = process.env.PROXY_GATEWAY_PASSWORD;
  if (!host && !port && !username && !password) return null;
  if (!host || !port || !username || !password) {
    throw new Error(
      "[proxy-provider] PROXY_GATEWAY_HOST/PORT/USERNAME/PASSWORD must all be configured",
    );
  }
  return { host, port, username, password };
}

function getStaticRangeConfig(): {
  host: string;
  portStart: number;
  portEnd: number;
  username: string;
  password: string;
  source: "dataimpulse-url" | "static-range";
} | null {
  // A single rotating DataImpulse gateway can be supplied as one credential
  // URL (`user:pass@host:port`). It intentionally takes precedence over the
  // legacy five-field STATIC_PROXY_* configuration so credentials can be
  // rotated atomically without leaving a half-updated provider config.
  const dataImpulseUrl = process.env.DATAIMPULSE_PROXY_URL?.trim();
  if (dataImpulseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(
        dataImpulseUrl.includes("://")
          ? dataImpulseUrl
          : `http://${dataImpulseUrl}`,
      );
    } catch {
      throw new Error("[proxy-provider] invalid DATAIMPULSE_PROXY_URL");
    }
    const configuredPort = Number(parsed.port);
    const rangeStartRaw = process.env.DATAIMPULSE_PROXY_PORT_START?.trim();
    const rangeEndRaw = process.env.DATAIMPULSE_PROXY_PORT_END?.trim();
    if (Boolean(rangeStartRaw) !== Boolean(rangeEndRaw)) {
      throw new Error(
        "[proxy-provider] DATAIMPULSE_PROXY_PORT_START and DATAIMPULSE_PROXY_PORT_END must be configured together",
      );
    }
    const rangeStart = rangeStartRaw ? Number(rangeStartRaw) : configuredPort;
    const rangeEnd = rangeEndRaw ? Number(rangeEndRaw) : configuredPort;
    if (
      !parsed.hostname ||
      !parsed.username ||
      !parsed.password ||
      !Number.isInteger(configuredPort) ||
      configuredPort < 1 ||
      configuredPort > 65535 ||
      !Number.isInteger(rangeStart) ||
      !Number.isInteger(rangeEnd) ||
      rangeStart > rangeEnd ||
      (rangeStartRaw
        && (rangeStart < 10_000 || rangeEnd > 20_000))
    ) {
      throw new Error("[proxy-provider] invalid DATAIMPULSE_PROXY_URL");
    }
    return {
      host: parsed.hostname,
      portStart: rangeStart,
      portEnd: rangeEnd,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      source: "dataimpulse-url",
    };
  }

  const host = process.env.STATIC_PROXY_HOST;
  const portStart = process.env.STATIC_PROXY_PORT_START;
  const portEnd = process.env.STATIC_PROXY_PORT_END;
  const username = process.env.STATIC_PROXY_USERNAME;
  const password = process.env.STATIC_PROXY_PASSWORD;
  if (!host && !portStart && !portEnd && !username && !password) return null;
  if (!host || !portStart || !portEnd || !username || !password) {
    throw new Error(
      "[proxy-provider] STATIC_PROXY_HOST/PORT_START/PORT_END/USERNAME/PASSWORD must all be configured",
    );
  }
  const parsedStart = Number(portStart);
  const parsedEnd = Number(portEnd);
  if (
    !Number.isInteger(parsedStart) ||
    !Number.isInteger(parsedEnd) ||
    parsedStart < 1 ||
    parsedEnd > 65535 ||
    parsedStart > parsedEnd
  ) {
    throw new Error("[proxy-provider] invalid STATIC_PROXY port range");
  }
  return {
    host,
    portStart: parsedStart,
    portEnd: parsedEnd,
    username,
    password,
    source: "static-range",
  };
}

function sanitizeSessionPart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned.slice(0, 24) || Math.random().toString(36).slice(2, 14);
}

function buildGatewayUsername(
  baseUsername: string,
  sessionId: string,
  country: string,
): string {
  const hasCountry = /(?:^|-)cc-[a-z]{2}(?:-|$)/i.test(baseUsername);
  const withCountry = hasCountry
    ? baseUsername
    : `${baseUsername}-cc-${country.toUpperCase()}`;
  const hasSession = /(?:^|-)(?:sessid|session|sid)-/i.test(withCountry);
  return hasSession ? withCountry : `${withCountry}-sessid-${sessionId}`;
}

// DataImpulse residential pools verified (2026-07-09) to serve real, geo-correct
// exit IPs for the current account. A persona whose country is NOT in this set
// keeps the account default baked into STATIC_PROXY_USERNAME: DataImpulse
// silently routes an unsupported `__cr.<cc>` to an arbitrary pool (e.g. `pk`→FR,
// `au`→US), which MIS-matches the persona worse than the default rotation.
// Extend this set only after confirming a pool with a live probe.
const SUPPORTED_STATIC_COUNTRIES = new Set([
  "us",
  "gb",
  "de",
  "fr",
  "es",
  "in",
  "ca",
  "mx",
  "ch",
]);

/**
 * Normalize a caller-supplied country to a DataImpulse-supported ISO-3166
 * alpha-2 code (lowercase), or `undefined` when unsupported/invalid so the
 * caller keeps the account default geo.
 */
export function normalizeStaticCountry(country?: string): string | undefined {
  if (!country) return undefined;
  const cc = country.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return undefined;
  return SUPPORTED_STATIC_COUNTRIES.has(cc) ? cc : undefined;
}

/**
 * DataImpulse country routing lives in the username as
 * `<accountKey>__cr.<cc>[,<cc>…]`. Rewrite that segment so a per-bot country
 * overrides the account default in STATIC_PROXY_USERNAME. Returns the username
 * unchanged when no (supported) country override is requested.
 */
function applyStaticCountry(baseUsername: string, country?: string): string {
  const cc = normalizeStaticCountry(country);
  if (!cc) return baseUsername;
  const marker = "__cr.";
  const idx = baseUsername.indexOf(marker);
  const accountKey = idx >= 0 ? baseUsername.slice(0, idx) : baseUsername;
  return `${accountKey}${marker}${cc}`;
}

/**
 * Pin a DataImpulse rotating-gateway candidate to the exact exit IP that was
 * health-checked. Port 823 otherwise chooses a new IP for every CONNECT, so a
 * successful probe says nothing about the Playwright request that follows.
 * DataImpulse's documented username parameter is `;sessid.<tag>` and keeps
 * that lane stable for roughly 30 minutes.
 */
function applyDataImpulseSession(baseUsername: string, sessionId: string): string {
  const withoutExisting = baseUsername.replace(/;sessid\.[a-z0-9_-]+/gi, "");
  return `${withoutExisting};sessid.${sanitizeSessionPart(sessionId)}`;
}

/**
 * Pull a batch of fresh sticky endpoints from the provider. The provider's
 * URL already encodes plan + auth + duration, so we only override count and
 * country at request time when needed.
 */
export async function fetchEndpoints(
  opts: FetchOptions = {},
): Promise<ProxyEndpoint[]> {
  const staticRange = getStaticRangeConfig();
  if (staticRange) {
    const allPorts = staticRange.portEnd - staticRange.portStart + 1;
    const dataImpulse = staticRange.source === "dataimpulse-url"
      || isDataImpulseGatewayHost(staticRange.host);
    const dataImpulseRotating = dataImpulse
      && allPorts === 1
      && staticRange.portStart === 823;
    const dataImpulsePortSticky = dataImpulse
      && isKnownEphemeralDataImpulseEndpoint(
        staticRange.host,
        staticRange.portStart,
      )
      && isKnownEphemeralDataImpulseEndpoint(
        staticRange.host,
        staticRange.portEnd,
      )
      && !dataImpulseRotating;

    if (
      (dataImpulseRotating || dataImpulsePortSticky)
      && (opts.purpose ?? "account-session") === "account-session"
    ) {
      throw new Error(
        "[proxy-provider] short-lived DataImpulse lanes are public-read-only and cannot bind an account session",
      );
    }

    // Port 823 chooses a new exit for every CONNECT, so duplicate candidates
    // deliberately probe distinct exits. Port-based sticky lanes (10000-20000)
    // are different: even a one-port configuration represents one short-lived
    // lane and must never be mistaken for the rotating gateway.
    const count = dataImpulseRotating
      ? Math.max(opts.count ?? 1, 1)
      : Math.max(Math.min(opts.count ?? 1, allPorts), 1);
    const issuedAt = Date.now();
    const expiresAt = new Date(
      issuedAt +
        (dataImpulseRotating || dataImpulsePortSticky
          ? STICKY_DURATION_MIN
          : DEDICATED_RANGE_VALIDITY_HOURS * 60) *
          60 *
          1000,
    );
    const offset = Math.floor(issuedAt / 1000) % allPorts;
    // Per-bot geo: rewrite the DataImpulse `__cr.<cc>` segment to the caller's
    // country when supported, else keep the account default (ch,gb,us rotation).
    const countryUsername = applyStaticCountry(
      staticRange.username,
      opts.country,
    );
    const endpoints: ProxyEndpoint[] = [];
    for (let i = 0; i < count; i += 1) {
      const port = staticRange.portStart + ((offset + i) % allPorts);
      const sessionId = dataImpulseRotating
        ? `di${sanitizeSessionPart(`${issuedAt}-${i}`)}`
        : `${staticRange.host}:${port}`;
      const username = dataImpulseRotating
        ? applyDataImpulseSession(countryUsername, sessionId)
        : countryUsername;
      endpoints.push({
        endpoint: `${staticRange.host}:${port}:${username}:${staticRange.password}`,
        sessionId,
        expiresAt,
      });
    }
    logger.info(
      {
        count: endpoints.length,
        provider: dataImpulsePortSticky
          ? "dataimpulse-port-sticky"
          : dataImpulseRotating
            ? "dataimpulse-rotating"
            : "dedicated-range",
        country: normalizeStaticCountry(opts.country) ?? "default",
        expiresAt,
      },
      "[proxy-provider] generated static authenticated proxy endpoints",
    );
    return endpoints;
  }

  const gateway = getDirectGatewayConfig();
  if (gateway) {
    const count = Math.max(opts.count ?? 1, 1);
    const country = opts.country ?? "US";
    const issuedAt = Date.now();
    const expiresAt = new Date(
      issuedAt + DIRECT_GATEWAY_STICKY_HOURS * 60 * 60 * 1000,
    );
    const endpoints: ProxyEndpoint[] = Array.from({ length: count }, (_, i) => {
      const sessionId = `bot${sanitizeSessionPart(`${issuedAt}${i}`)}`;
      const username = buildGatewayUsername(gateway.username, sessionId, country);
      return {
        endpoint: `${gateway.host}:${gateway.port}:${username}:${gateway.password}`,
        sessionId,
        expiresAt,
      };
    });
    logger.info(
      { count: endpoints.length, provider: "gateway", expiresAt },
      "[proxy-provider] generated direct gateway endpoints",
    );
    return endpoints;
  }

  const apiUrl = new URL(getApiUrl(opts.apiUrl));
  const isWebshareDownload = apiUrl.hostname.includes("webshare.io");
  if (!isWebshareDownload && opts.count !== undefined) {
    apiUrl.searchParams.set("num", String(opts.count));
  }
  if (!isWebshareDownload && opts.country !== undefined) {
    apiUrl.searchParams.set("cc", opts.country);
  }
  if (!isWebshareDownload) {
    // Force txt format with newline separator regardless of how the URL was
    // configured — we parse line-by-line below.
    apiUrl.searchParams.set("format", "txt");
    apiUrl.searchParams.set("lb", "\\n");
  }

  const res = await fetch(apiUrl.toString(), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `[proxy-provider] HTTP ${res.status} from provider`,
    );
  }
  const body = await res.text();
  const issuedAt = Date.now();
  const expiresAt = new Date(
    issuedAt + (isWebshareDownload ? 24 * 60 : STICKY_DURATION_MIN) * 60 * 1000,
  );

  const endpoints: ProxyEndpoint[] = body
    .split(/\r?\n|\\n/)
    .map((line) => line.trim())
    .map((line) => parseProxyLine(line, expiresAt))
    .filter((endpoint): endpoint is ProxyEndpoint => endpoint !== null);

  if (endpoints.length === 0) {
    // SECURITY (B5): never log the raw body — a provider response is
    // `host:port:user:pass` lines and would leak credentials verbatim into
    // the log sink. Emit only the redacted label form + a length marker so
    // the shape is still debuggable.
    logger.warn(
      { sample: redactProxyListSample(body), bodyLength: body.length },
      "[proxy-provider] no endpoints parsed from response",
    );
    throw new Error("[proxy-provider] empty endpoint list");
  }
  logger.info(
    { count: endpoints.length, expiresAt },
    "[proxy-provider] fetched sticky endpoints",
  );
  return endpoints;
}

// We must use undici.fetch (not global fetch). Node 22's global fetch is
// built on undici but silently *ignores* the `dispatcher` option, so the
// proxy would be bypassed — and every probe would falsely pass without
// actually transiting the proxy. We load undici once and cache the module
// promise: probes now run *concurrently* (B10 wave racing), and a fresh
// `await import("undici")` per probe both wastes work and, under concurrent
// dynamic imports, can contend. Caching the single import promise keeps the
// hot path tight.
let undiciModulePromise: Promise<typeof import("undici")> | null = null;
function loadUndici(): Promise<typeof import("undici")> {
  if (!undiciModulePromise) undiciModulePromise = import("undici");
  return undiciModulePromise;
}

/**
 * Probe a single endpoint by hitting instagram.com through it. Wave 8: we used
 * to probe api.ipify.org which only proves the proxy can reach *some* endpoint
 * — but Smartproxy.org IPs are routinely blocklisted by IG specifically while
 * still passing ipify, which made every "healthy" assignment burn a 30s
 * Chromium nav before failing. Probing instagram.com directly catches
 * IG-blocked IPs at filter time so we never assign them.
 *
 * We probe the same unauthenticated profile endpoint used by the scraper. A
 * proxy that can fetch `/favicon.ico` but gets 429/403 on profile traffic is
 * not useful for this app and should never be assigned to a bot.
 */
export async function probeEndpoint(
  endpoint: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<string | null> {
  // Bail before opening any socket if the race was already won by a sibling.
  if (externalSignal?.aborted) return null;
  const proxyUrl = proxyAgentUriForEndpoint(endpoint);
  // Combine the per-probe timeout with the caller's race-cancel signal so a
  // winning sibling can abort this probe immediately (frees the proxy socket
  // and stops us paying for a loser's full timeout).
  const signal = externalSignal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), externalSignal])
    : AbortSignal.timeout(timeoutMs);
  try {
    const { ProxyAgent, fetch: undiciFetch } = await loadUndici();
    const dispatcher = new ProxyAgent({ uri: proxyUrl });
    const res = await undiciFetch(
      "https://www.instagram.com/api/v1/users/web_profile_info/?username=instagram",
      {
        dispatcher,
        signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
          "Accept": "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.instagram.com/instagram/",
          "X-IG-App-ID": "936619743392459",
        },
      },
    );
    // Drain the body so undici can return the connection to the pool. We
    // don't care about the content — 2xx/3xx is the signal. 401/403/429
    // means Instagram already distrusts the lane for our traffic.
    await res.arrayBuffer().catch(() => undefined);
    if (res.status < 200 || res.status >= 400) return null;

    // Some providers pass the JSON endpoint but Instagram serves an empty
    // web login shell through the same IP. Those endpoints cannot recover
    // sessions, so reject them before Playwright burns a full login attempt.
    const loginRes = await undiciFetch("https://www.instagram.com/accounts/login/", {
      dispatcher,
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await loginRes.text().catch(() => "");
    if (loginRes.status < 200 || loginRes.status >= 400) return null;
    if (html.length < 500 || /<body>\s*<\/body>/i.test(html)) return null;
    return endpoint;
  } catch {
    // SECURITY (B5): swallow the error rather than rethrow — undici embeds the
    // full `user:pass@host` proxy URI in connect/timeout error messages and
    // stack traces, which must never escape into a caller's log or thrown
    // error. A failed probe is simply "not healthy".
    return null;
  }
}

/**
 * Fetch a batch and return only the endpoints that pass a live probe. The
 * caller normally only needs one, so we short-circuit as soon as we have
 * `wanted`.
 */
export async function fetchHealthyEndpoints(
  wanted: number,
  opts: FetchOptions = {},
): Promise<ProxyEndpoint[]> {
  if (providerUnavailableUntil > Date.now()) {
    throw new Error(
      `[proxy-provider] provider health cooldown active until ${new Date(
        providerUnavailableUntil,
      ).toISOString()}; retry later`,
    );
  }
  // Country defaults to US: IG flags Indonesian/SEA mobile IPs harder than
  // a US residential. Caller can override per bot if rotation is desired.
  const country = opts.country ?? "US";
  // Smartproxy.org's residential pool runs hot — typical batch has only
  // ~30-50% live ports (the rest are cold/rate-limited). Over-ask by 8x to
  // make sure we get `wanted` healthy endpoints in one round.
  const batch = await fetchEndpoints({
    count: Math.max(wanted * 8, 20),
    ...opts,
    country,
  });

  const excluded = new Set(opts.excludeEndpoints ?? []);
  const filtered = batch.filter((c) => !excluded.has(c.endpoint));
  // Rotating-gateway safety: a rotating gateway (DataImpulse :823) emits N
  // IDENTICAL endpoint strings (same host:port:user:pass) — each CONNECT still
  // gets a fresh exit IP. When a caller retries with excludeEndpoints=[that
  // string] to "rotate away", the filter drops ALL candidates → "no healthy
  // endpoint after 0 probe(s)" and the scrape/login truncates. Since a
  // reconnect through the same string yields a NEW IP, the exclusion is
  // meaningless here: fall back to the unfiltered batch rather than fail. For a
  // sticky multi-port range this only re-probes already-tried ports when
  // nothing else remains — a harmless extra probe, never a false failure.
  const candidates = filtered.length > 0 ? filtered : batch;

  // B10 latency budget: probe at most `maxAttempts` endpoints, in waves of
  // `concurrency`, racing each wave so a healthy endpoint short-circuits the
  // losers. This bounds in-path stall to roughly
  //   ceil(maxAttempts / concurrency) × PROBE_TIMEOUT_MS
  // instead of the old 20 × (probe + 1.5s sleep).
  const maxAttempts = opts.maxAttempts === undefined
    ? probeMaxAttempts()
    : Math.max(1, Math.trunc(opts.maxAttempts));
  // Browser-owned probes are deliberately sequential. Each candidate starts
  // a full Firefox instance, and parallel launches would amplify a throttled
  // proxy pool while consuming unnecessary host resources.
  const concurrency = opts.probe ? 1 : probeConcurrency();
  const probePool = candidates.slice(0, maxAttempts);

  const healthy: ProxyEndpoint[] = [];
  let probed = 0;
  for (
    let waveStart = 0;
    waveStart < probePool.length && healthy.length < wanted;
    waveStart += concurrency
  ) {
    const wave = probePool.slice(waveStart, waveStart + concurrency);
    probed += wave.length;
    // One controller per wave. Each probe collects into `healthy` as soon as
    // it resolves; the *moment* we reach `wanted` we abort the controller so
    // the still-in-flight siblings stop holding proxy sockets open for their
    // full timeout (race semantics — first healthy wins, losers cancelled).
    // We still await all probes so socket teardown completes before we move
    // on, but the wall-clock cost is the winner's latency, not the loser's.
    const controller = new AbortController();
    await Promise.all(
      wave.map(async (candidate) => {
        const ok = await (opts.probe ?? probeEndpoint)(
          candidate.endpoint,
          PROBE_TIMEOUT_MS,
          controller.signal,
        );
        if (ok && healthy.length < wanted) {
          healthy.push(candidate);
          if (healthy.length >= wanted) controller.abort();
        }
      }),
    );
  }

  if (healthy.length === 0) {
    providerUnavailableUntil = Date.now() + providerCooldownMs();
    // Fail fast and clearly: the caller (scrape/login path) treats this as a
    // transient/retryable condition and backs off, rather than us grinding
    // through the whole batch. Do NOT embed any endpoint string here (B5).
    throw new Error(
      `[proxy-provider] no healthy endpoint after ${probed} probe(s) ` +
        `(budget ${maxAttempts}) — provider may be exhausted; retry later`,
    );
  }
  providerUnavailableUntil = 0;
  logger.info(
    {
      wanted,
      healthy: healthy.length,
      probed,
      attemptBudget: maxAttempts,
      concurrency,
      country,
    },
    "[proxy-provider] resolved healthy endpoints",
  );
  return healthy;
}

/** Test/ops seam: clear the process-local provider outage circuit. */
export function resetProxyProviderHealth(): void {
  providerUnavailableUntil = 0;
}

/**
 * Decide whether a bot's currently-assigned endpoint is still inside its
 * sticky window with enough headroom for a login flow.
 */
export function isEndpointFresh(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - Date.now() > REFRESH_GUARD_MS;
}

/**
 * Convert a provider endpoint into the proxy URL string that Playwright's
 * launch arg expects (no auth — IP whitelisted upstream).
 */
export function toPlaywrightProxy(endpoint: ProxyEndpoint): {
  server: string;
  username?: string;
  password?: string;
} {
  const parsed = parseProxyEndpoint(endpoint.endpoint);
  const proxy: { server: string; username?: string; password?: string } = {
    server: `http://${parsed.host}:${parsed.port}`,
  };
  if (parsed.username) proxy.username = parsed.username;
  if (parsed.password) proxy.password = parsed.password;
  return proxy;
}

export function proxyAgentUriForEndpoint(endpoint: string): string {
  const parsed = parseProxyEndpoint(endpoint);
  if (!parsed.username) return `http://${parsed.host}:${parsed.port}`;
  return `http://${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password ?? "")}@${parsed.host}:${parsed.port}`;
}

export function proxyEndpointLabel(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  const parsed = parseProxyEndpointSafe(endpoint);
  if (!parsed) return "invalid-proxy";
  return parsed.username ? `${parsed.host}:${parsed.port}:auth` : `${parsed.host}:${parsed.port}`;
}

/**
 * Scrub a known proxy endpoint's credentials out of an arbitrary message
 * before it is logged or persisted. Lower layers (undici connect/timeout
 * errors, third-party stacks) can splice the full `user:pass@host` URI into a
 * message we don't control; when we already know which endpoint was in play
 * we replace every credential-bearing form of it with the safe label.
 *
 * We only have to scrub the secret parts (username + password). The
 * `host:port` itself is non-sensitive and is what the label preserves.
 */
export function scrubProxyCredential(
  message: string,
  endpoint: string | null | undefined,
): string {
  if (!endpoint) return message;
  const parsed = parseProxyEndpointSafe(endpoint);
  if (!parsed?.username) return message;
  const label = proxyEndpointLabel(endpoint) ?? `${parsed.host}:${parsed.port}`;
  let scrubbed = message;
  // Both the wire URI form (user:pass@host:port) and the colon-delimited form
  // (host:port:user:pass) can appear depending on which layer threw.
  const uriForm = proxyAgentUriForEndpoint(endpoint);
  const colonForm = `${parsed.host}:${parsed.port}:${parsed.username}:${parsed.password ?? ""}`;
  for (const secret of [uriForm, colonForm]) {
    if (secret) scrubbed = scrubbed.split(secret).join(label);
  }
  // Also mask the bare credentials in case only `user:pass@` survived.
  const creds = `${parsed.username}:${parsed.password ?? ""}`;
  scrubbed = scrubbed.split(`${creds}@`).join("");
  return scrubbed;
}

/**
 * Redact a raw provider-list response before it ever reaches a log sink.
 * A provider body is one `host:port` or `host:port:user:pass` endpoint per
 * line (newline or literal `\n` separated). We keep the label form
 * (`host:port` / `host:port:auth`) so the sample stays useful for debugging
 * the *shape* of a bad response, but every credential after the port is
 * dropped. Lines we can't parse are masked to a length-only placeholder so a
 * malformed-but-credential-bearing payload still can't leak verbatim.
 */
export function redactProxyListSample(
  body: string,
  maxLines = 5,
): string {
  return body
    .split(/\r?\n|\\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines)
    .map((line) => proxyEndpointLabel(line) ?? `<unparsable:${line.length}>`)
    .join(" | ");
}

function parseProxyLine(line: string, expiresAt: Date): ProxyEndpoint | null {
  const parsed = parseProxyEndpointSafe(line);
  if (!parsed) return null;
  return {
    endpoint: parsed.username
      ? `${parsed.host}:${parsed.port}:${parsed.username}:${parsed.password ?? ""}`
      : `${parsed.host}:${parsed.port}`,
    sessionId: `${parsed.host}:${parsed.port}`,
    expiresAt,
  };
}

function parseProxyEndpointSafe(endpoint: string): {
  host: string;
  port: string;
  username?: string;
  password?: string;
} | null {
  try {
    return parseProxyEndpoint(endpoint);
  } catch {
    return null;
  }
}

function parseProxyEndpoint(endpoint: string): {
  host: string;
  port: string;
  username?: string;
  password?: string;
} {
  if (/^https?:\/\//i.test(endpoint)) {
    const u = new URL(endpoint);
    return {
      host: u.hostname,
      port: u.port,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  }

  const parts = endpoint.split(":");
  if (parts.length === 2) {
    const [host, port] = parts;
    if (!host || !port) throw new Error("[proxy-provider] invalid proxy endpoint");
    return { host, port };
  }
  if (parts.length >= 4) {
    const [host, port, username, ...passwordParts] = parts;
    if (!host || !port || !username) {
      throw new Error("[proxy-provider] invalid authenticated proxy endpoint");
    }
    return {
      host,
      port,
      username,
      password: passwordParts.join(":"),
    };
  }

  throw new Error("[proxy-provider] invalid proxy endpoint");
}

// ─── Per-bot bounded sticky proxy assignment ────────────────────────────────
//
// `proxy_session_id` identifies one provider session only for its documented
// sticky window; it does not guarantee the same exit IP after expiration.
// Callers may allocate/replace this lane only before authentication or during
// an explicit re-login. Runtime and assignment callers fail closed when a
// usable authenticated session exists.
//
// Country diversity is stratified deterministically by bot index so the pool
// presents itself to IG as a believable mix of geographies rather than a
// single homogeneous block of US residentials.
// ────────────────────────────────────────────────────────────────────────────

/** Country distribution for the bot pool. Order matters for the schedule. */
export interface CountryAllocation {
  country: string;
  /** Inclusive lower bound (0..1) of cumulative population that maps here. */
  cumulative: number;
}

/**
 * Stratified country schedule:
 *   60% US, 25% GB (UK), 10% DE, 5% FR
 * Cumulative thresholds make `countryForBotIndex` a single-pass lookup.
 */
export const COUNTRY_SCHEDULE: readonly CountryAllocation[] = [
  { country: "US", cumulative: 0.6 },
  { country: "GB", cumulative: 0.85 },
  { country: "DE", cumulative: 0.95 },
  { country: "FR", cumulative: 1.0 },
];

/**
 * Deterministically map a bot's position in the pool to a country.
 * Stable across runs — same (index, total) always yields the same country.
 */
export function countryForBotIndex(index: number, total: number): string {
  if (total <= 0) return "US";
  const safeIndex = Math.max(0, Math.min(index, total - 1));
  // Use the *center* of the bot's slot so a pool of size 1 lands in the US
  // bucket and the boundaries don't bias toward the next country.
  const position = (safeIndex + 0.5) / total;
  for (const slot of COUNTRY_SCHEDULE) {
    if (position <= slot.cumulative) return slot.country;
  }
  return COUNTRY_SCHEDULE[COUNTRY_SCHEDULE.length - 1].country;
}

/** Persistent proxy state stored on a bot row. */
export interface BotProxyState {
  proxyEndpoint: string | null;
  proxySessionId: string | null;
  proxyExpiresAt: Date | null;
}

/** Result of `getOrAssignBotProxy` — caller persists fields when refreshed. */
export interface ResolvedBotProxy {
  endpoint: ProxyEndpoint;
  /** True when a fresh upstream lookup happened; false when cached state was reused. */
  refreshed: boolean;
}

interface GetOrAssignOptions {
  country?: string;
  /** Override the API URL (for tests / staging). */
  apiUrl?: string;
}

/**
 * Resolve the proxy a bot should use right now.
 *
 *   - If the bot already has a `proxy_session_id` and the sticky window has
 *     enough headroom, return the cached endpoint (no network call).
 *   - Otherwise pull one fresh healthy endpoint and return it. The caller is
 *     responsible both for proving that no authenticated session will be
 *     transplanted and for persisting the new proxy fields.
 *
 * This helper is intentionally storage-agnostic — it never touches the DB.
 * That keeps it pure, testable, and reusable by the assignment script and
 * the runtime alike.
 */
export async function getOrAssignBotProxy(
  state: Readonly<BotProxyState>,
  opts: GetOrAssignOptions = {},
): Promise<ResolvedBotProxy> {
  const country = opts.country ?? "US";

  // Reuse cached lane when it exists and hasn't passed the refresh guard.
  if (
    state.proxyEndpoint &&
    state.proxySessionId &&
    isEndpointFresh(state.proxyExpiresAt ?? null)
  ) {
    return {
      endpoint: {
        endpoint: state.proxyEndpoint,
        sessionId: state.proxySessionId,
        // Non-null per isEndpointFresh contract above.
        expiresAt: state.proxyExpiresAt as Date,
      },
      refreshed: false,
    };
  }

  const fetchOpts: FetchOptions = { country, purpose: "account-session" };
  if (opts.apiUrl !== undefined) {
    fetchOpts.apiUrl = opts.apiUrl;
  }
  const [fresh] = await fetchHealthyEndpoints(1, fetchOpts);
  if (!fresh) {
    throw new Error(
      "[proxy-provider] getOrAssignBotProxy: provider returned no healthy endpoint",
    );
  }
  return { endpoint: fresh, refreshed: true };
}
