// Double-submit CSRF token helper.
//
// Server issues a non-HttpOnly `csrf_token` cookie on login/register so that
// browser JS can read it and echo it back via the `X-CSRF-Token` header on
// every unsafe admin request. See server/auth.ts (requireCsrfToken).

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function isUnsafeMethod(method: string | undefined): boolean {
  return UNSAFE_METHODS.has((method ?? "GET").toUpperCase());
}

export function csrfHeaders(
  init?: HeadersInit,
  method: string = "POST",
): Headers {
  const headers = new Headers(init);
  if (!headers.has("X-Requested-With")) {
    headers.set("X-Requested-With", "XMLHttpRequest");
  }
  if (isUnsafeMethod(method) && !headers.has(CSRF_HEADER_NAME)) {
    const token = getCsrfToken();
    if (token) headers.set(CSRF_HEADER_NAME, token);
  }
  return headers;
}

/**
 * Shape of CSRF-specific 403 error from the server.
 * See server/auth.ts: `res.status(403).json({ message: "CSRF token missing or invalid" })`.
 */
export function isCsrfErrorBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const msg = (body as { message?: unknown }).message;
  if (typeof msg !== "string") return false;
  return /csrf/i.test(msg);
}

/**
 * Handle a 403 response that may be CSRF-related.
 * Returns true if caller should retry the original request after the cookie
 * was (presumably) refreshed by re-auth. Returns false if the session is dead
 * or the error wasn't CSRF at all — caller should surface the error to the UI.
 *
 * The actual re-auth + redirect is done by the caller so this helper can stay
 * framework-agnostic (no wouter / toast dependency baked in).
 */
export async function probeSessionAfterCsrfFailure(): Promise<
  "session-alive" | "session-dead" | "network-error"
> {
  try {
    const res = await fetch("/api/auth/me", {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (res.status === 401) return "session-dead";
    if (!res.ok) return "session-dead";
    return "session-alive";
  } catch {
    return "network-error";
  }
}
