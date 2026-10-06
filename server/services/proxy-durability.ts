// Legacy account-assignment admission and observed proxy lifetime live here.
// Admission currently permits sticky gateways used by existing sessions; it
// does not establish that their exit IP remains fixed for the session lifetime.
// Health reporting separately exposes those short-lived assignments.

export const DATAIMPULSE_STICKY_PORT_MIN = 10_000;
export const DATAIMPULSE_STICKY_PORT_MAX = 20_000;

/**
 * A durable assignment must remain valid well beyond a single collection
 * cycle. Ops-imported fixed endpoints use a far-future expiry; this threshold
 * prevents an ordinary provider lease from being promoted by mistake.
 */
export const DURABLE_ACCOUNT_PROXY_MIN_VALIDITY_DAYS = 30;

/** PostgreSQL case-insensitive regex for known DataImpulse rotating lanes. */
// Compatibility predicate used by live bot selection. Keep it aligned with
// isKnownEphemeralDataImpulseEndpoint; widening it without replacing assigned
// proxies would stop the existing pool. Do not use it for lifetime reporting.
export const KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX = String.raw`(^|@|//)([a-z0-9-]+\.)*dataimpulse\.com:823/?$`;

/** Health reporting includes sticky gateways: their IPs rotate after 1–120
 * minutes, even while the configured host/port stays unchanged. This is an
 * observation, separate from the legacy admission predicate above; changing
 * admission requires a planned replacement of existing account assignments.
 * https://docs.dataimpulse.com/proxies/types-of-connections
 */
export const SHORT_LIVED_ACCOUNT_PROXY_SQL_REGEX = String.raw`(^|@|//)([a-z0-9-]+\.)*dataimpulse\.com:(823|1[0-9]{4}|20000)/?$`;

export function isDataImpulseGatewayHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return normalized === "dataimpulse.com"
    || normalized.endsWith(".dataimpulse.com");
}

export function isKnownEphemeralDataImpulseEndpoint(
  hostname: string,
  port: number,
): boolean {
  // Existing-session admission; sticky lifetime is reported separately above.
  return isDataImpulseGatewayHost(hostname) && port === 823;
}

export function isKnownEphemeralDataImpulseProxyUrl(proxyUrl: string): boolean {
  const source = proxyUrl.trim();
  if (!source) return false;

  try {
    const parsed = new URL(
      source.includes("://") ? source : `http://${source}`,
    );
    const port = Number(parsed.port);
    return ["http:", "https:"].includes(parsed.protocol)
      && Boolean(parsed.hostname)
      && Number.isInteger(port)
      && isKnownEphemeralDataImpulseEndpoint(parsed.hostname, port)
      && (parsed.pathname === "" || parsed.pathname === "/")
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

export function accountProxyDurabilityIssue(proxyUrl: string): string | null {
  const source = proxyUrl.trim();
  if (!source) return "proxy URL is empty";

  let parsed: URL;
  try {
    parsed = new URL(source.includes("://") ? source : `http://${source}`);
  } catch {
    return "proxy URL is invalid";
  }

  const port = Number(parsed.port);
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || !parsed.hostname
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) {
    return "proxy URL is invalid";
  }

  if (isKnownEphemeralDataImpulseEndpoint(parsed.hostname, port)) {
    return "DataImpulse gateway/sticky ports rotate within a short provider window and are not durable account proxies";
  }

  return null;
}

export function isDurableAccountProxyUrl(proxyUrl: string): boolean {
  return accountProxyDurabilityIssue(proxyUrl) === null;
}

export function assertDurableAccountProxyUrl(proxyUrl: string): void {
  const issue = accountProxyDurabilityIssue(proxyUrl);
  if (issue) throw new Error(`[proxy-durability] ${issue}`);
}

export function assertDurableAccountProxyAddress(
  hostname: string,
  port: number,
): void {
  if (isKnownEphemeralDataImpulseEndpoint(hostname, port)) {
    throw new Error(
      "DataImpulse gateway/sticky ports cannot be imported as fixed account proxies",
    );
  }
}
