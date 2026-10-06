import { createProductAnalytics, ANALYTICS_CONSENT_KEY } from "./analytics-client";
import { POSTHOG_API_HOST } from "@shared/product-analytics";

const isBrowser = typeof window !== "undefined";
export const productAnalytics = createProductAnalytics({
  key: import.meta.env.VITE_POSTHOG_KEY ?? "",
  enabled: isBrowser && import.meta.env.PROD,
  path: () => isBrowser ? window.location.pathname : "",
  readConsent: () => isBrowser ? window.localStorage.getItem(ANALYTICS_CONSENT_KEY) : null,
  writeConsent: value => window.localStorage.setItem(ANALYTICS_CONSENT_KEY, value),
  privacySignal: () => !isBrowser || navigator.doNotTrack === "1" ||
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true,
  loadSdk: () => import("posthog-js").then(module => module.default),
  sendNavigationEvent: event => {
    // Cold-SDK checkout fallback uses the documented public capture endpoint,
    // not a proxy/backend job. Preserve bot exclusion and never include cookies.
    if (navigator.webdriver || /headless|bot|crawler|spider/i.test(navigator.userAgent)) return;
    const body = JSON.stringify({ api_key: event.properties.token, distinct_id: event.properties.distinct_id, ...event });
    const url = `${POSTHOG_API_HOST}/i/v0/e/`;
    // A small keepalive request survives navigation without delaying checkout;
    // text/plain avoids a preflight racing unload. The API parses JSON.
    void fetch(url, { method: "POST", body, keepalive: true, credentials: "omit", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "text/plain" } }).catch(() => undefined);
  },
  fetchUser: async () => {
    const response = await fetch("/api/auth/me", { credentials: "include", signal: AbortSignal.timeout(5_000) });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error("Analytics identity unavailable");
    return response.json();
  },
});

if (isBrowser) window.addEventListener("storage", event => {
  if (event.key === ANALYTICS_CONSENT_KEY || event.key === null) productAnalytics.refreshConsent();
});
