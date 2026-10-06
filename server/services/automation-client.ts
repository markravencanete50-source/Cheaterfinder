// ─── Local FastAPI automation client ────────────────────────────────────────
//
// The TypeScript process owns users, billing, PostgreSQL, and BullMQ. The
// localhost-only Python service owns Instagram browser sessions and
// fingerprinted HTTP transport. Keep all cross-process traffic here so the
// migration has one explicit, testable boundary.

import { fetch as undiciFetch } from "undici";
import { operationSignal } from "./operation-context.js";

const DEFAULT_AUTOMATION_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface AutomationRuntimeStatus {
  browser: "invisible_playwright";
  browser_available: boolean;
  browser_engine_available: boolean;
  http: "pyhttpz";
  http_available: boolean;
}

export interface AutomationHealth {
  status: "ok" | "degraded";
  loopback_only: true;
  runtime: AutomationRuntimeStatus;
}

export interface AutomationIdentity {
  identity_version: 1;
  client: "instagram-firefox-web";
  bot_id: string;
  browser_seed: number;
  browser_family: "firefox";
  browser_version: string;
  platform: "Windows";
  /** Derived by the Python browser engine; never selected from a TS pool. */
  user_agent: string;
  http_impersonate: string;
  ja3: string;
  h2_fingerprint: string;
  locale: string;
  timezone: string;
}

export interface AutomationProxy {
  server: string;
  username?: string;
  password?: string;
}

export interface AutomationInstagramRequest {
  operation_id?: string;
  deadline_ms?: number;
  identity: AutomationIdentity;
  storage_state: Record<string, unknown>;
  proxy?: AutomationProxy;
  request: {
    method?: "GET" | "POST";
    path: string;
    headers?: Record<string, string>;
    referer?: string;
    body?: string;
    timeout_ms?: number;
  };
}

export interface AutomationInstagramResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Final URL reduced to a fixed class inside Python; never a raw redirect URL. */
  response_url_class?: import("./ig-response-diagnostics.js").ResponseUrlClass | null;
  response_redirected?: boolean | null;
  cookies: Record<string, string>;
  storage_state: Record<string, unknown> | null;
  /**
   * Encoded bytes the automation service actually read from the network while
   * serving this call. On the BROWSER lane that is the whole Firefox launch —
   * the full instagram.com page load plus the API fetch — which is what the
   * proxy provider bills and what Node could never observe on its own.
   *
   * Optional on purpose: the Python service adds these fields independently, so
   * every consumer must tolerate them being absent or null (older service, or a
   * lane that cannot measure the wire) and fall back to payload-size counting.
   */
  wire_bytes_in?: number | null;
  wire_bytes_out?: number | null;
  /** Per-resource-kind split of the wire bytes, when the service reports it. */
  wire_breakdown?: Record<string, number> | null;
  transport_error?: string | null;
  browser_reused?: boolean;
  operation_id?: string | null;
}

export interface AutomationInstagramFollowRequest {
  identity: AutomationIdentity;
  storage_state: Record<string, unknown>;
  proxy: AutomationProxy;
  target_username: string;
  target_user_id: string;
  deadline_ms?: number;
  operation_id?: string;
}

export interface AutomationInstagramFollowResponse {
  status: "accepted" | "pending" | "not_sent" | "unknown";
  following: boolean;
  outgoing_request: boolean;
  confirmed: boolean;
  clicked: boolean;
  reason: string | null;
  storage_state: Record<string, unknown> | null;
  wire_bytes_in: number;
  wire_bytes_out: number;
  operation_id: string | null;
}

export interface AutomationNativePublicRead extends Omit<AutomationInstagramFollowRequest, "target_user_id"> {
  target_user_id?: string;
  kind: "profile" | "posts" | "stories" | "highlights";
  max_items?: number;
  with_items?: boolean;
}

export interface AutomationInstagramLoginStart {
  identity: AutomationIdentity;
  credentials: {
    username: string;
    password: string;
  };
  proxy?: AutomationProxy;
  timeout_ms?: number;
}

export interface AutomationInstagramLoginProbe {
  identity: AutomationIdentity;
  proxy?: AutomationProxy;
  timeout_ms?: number;
}

export interface AutomationInstagramLoginProbeResponse {
  status: "ready" | "rate_limited" | "blocked" | "error";
  message: string | null;
}

export interface AutomationInstagramLoginComplete {
  login_id: string;
  code: string;
  timeout_ms?: number;
}

export interface AutomationInstagramLoginResponse {
  status:
    | "authenticated"
    | "code_required"
    | "bad_credentials"
    | "captcha_required"
    | "rate_limited"
    | "suspended"
    | "error";
  message: string | null;
  login_id: string | null;
  code_kind: "email" | "totp" | null;
  storage_state: Record<string, unknown> | null;
}

export class AutomationServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AutomationServiceError";
  }
}

type FetchImplementation = typeof undiciFetch;

export interface AutomationClientOptions {
  /** Defaults to the local-only FastAPI endpoint. */
  baseUrl?: string;
  /** Defaults to AUTOMATION_API_TOKEN, evaluated when the client is created. */
  token?: string;
  timeoutMs?: number;
  /** Dependency-injection seam for tests. Production always uses Undici. */
  fetchImpl?: FetchImplementation;
}

function resolveBaseUrl(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? process.env.AUTOMATION_API_URL ?? DEFAULT_AUTOMATION_URL);
  } catch {
    throw new AutomationServiceError("AUTOMATION_API_URL must be a valid URL", 0);
  }

  // This service handles bot credentials and sessions. Its endpoint must never
  // be accidentally pointed at a LAN or public host.
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new AutomationServiceError(
      "automation service must use an http://127.0.0.1 URL",
      0,
    );
  }
  return url;
}

export function createAutomationClient(
  options: AutomationClientOptions = {},
) {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const token = options.token ?? process.env.AUTOMATION_API_TOKEN ?? "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? undiciFetch;

  async function request<T>(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<T> {
    if (!token) {
      throw new AutomationServiceError("AUTOMATION_API_TOKEN is not configured", 0);
    }
    const url = new URL(path, baseUrl);
    const ownerSignal = operationSignal();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = ownerSignal ? AbortSignal.any([ownerSignal, deadline]) : deadline;
    let response: Awaited<ReturnType<FetchImplementation>>;
    try {
      response = await fetchImpl(url, {
        method: init.method ?? "GET",
        headers: {
          "X-Automation-Token": token,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      });
    } catch (error) {
      throw new AutomationServiceError(
        `automation service request failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new AutomationServiceError(
        `automation service returned ${response.status}: ${raw.slice(0, 500)}`,
        response.status,
      );
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new AutomationServiceError("automation service returned invalid JSON", response.status);
    }
  }

  return {
    health: (): Promise<AutomationHealth> => request<AutomationHealth>("/v1/health"),
    createIdentity: (input: {
      bot_id: string;
      locale?: string;
      timezone?: string;
    }): Promise<AutomationIdentity> =>
      request<AutomationIdentity>("/v1/identities", { method: "POST", body: input }),
    requestInstagramHttp: (
      input: AutomationInstagramRequest,
    ): Promise<AutomationInstagramResponse> =>
      request<AutomationInstagramResponse>("/v1/instagram/http", {
        method: "POST",
        body: input,
      }),
    requestInstagramBrowser: (
      input: AutomationInstagramRequest,
    ): Promise<AutomationInstagramResponse> =>
      request<AutomationInstagramResponse>("/v1/instagram/browser", {
        method: "POST",
        body: input,
      }),
    followInstagramBrowser: (
      input: AutomationInstagramFollowRequest,
    ): Promise<AutomationInstagramFollowResponse> =>
      request<AutomationInstagramFollowResponse>("/v1/instagram/follow", {
        method: "POST",
        body: input,
      }),
    readNativePublicPage: (input: AutomationNativePublicRead): Promise<AutomationInstagramResponse> =>
      request<AutomationInstagramResponse>("/v1/instagram/public-page", { method: "POST", body: input }),
    startInstagramLogin: (
      input: AutomationInstagramLoginStart,
    ): Promise<AutomationInstagramLoginResponse> =>
      request<AutomationInstagramLoginResponse>("/v1/instagram/login/start", {
        method: "POST",
        body: input,
      }),
    probeInstagramLogin: (
      input: AutomationInstagramLoginProbe,
    ): Promise<AutomationInstagramLoginProbeResponse> =>
      request<AutomationInstagramLoginProbeResponse>("/v1/instagram/login/probe", {
        method: "POST",
        body: input,
      }),
    completeInstagramLogin: (
      input: AutomationInstagramLoginComplete,
    ): Promise<AutomationInstagramLoginResponse> =>
      request<AutomationInstagramLoginResponse>("/v1/instagram/login/complete", {
        method: "POST",
        body: input,
      }),
  };
}
