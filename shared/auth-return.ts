const APP_ORIGIN = "https://cheaterfinder.com";
const CUSTOMER_PATH = /^\/(?:settings|reports|members|notifications|payment|dashboard(?:\/[A-Za-z0-9_-]+)?)$/;

/** Accept only known customer pages, never an external URL or an auth/API route. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > 2048 || value !== value.trim() || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    if (/[\\\u0000-\u001f\u007f]/.test(decodeURIComponent(value))) return null;
    const url = new URL(value, APP_ORIGIN);
    if (url.origin !== APP_ORIGIN || !CUSTOMER_PATH.test(url.pathname)) return null;
    // Reject encoded separators and dot-segment normalization as well.
    if (value.split(/[?#]/, 1)[0] !== url.pathname) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

export function authPath(returnTo: string | null | undefined, page: "/auth" | "/forgot-password" = "/auth"): string {
  const destination = safeReturnTo(returnTo);
  return destination ? `${page}?returnTo=${encodeURIComponent(destination)}` : page;
}

export function signedInDestination(role: unknown, returnTo: string | null | undefined): string {
  return role === "admin" ? "/admin" : safeReturnTo(returnTo) ?? "/members";
}
