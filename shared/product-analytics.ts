/** Public ingestion host only. Never put a PostHog personal API key here. */
export const POSTHOG_API_HOST = "https://us.i.posthog.com";
export const ANALYTICS_CONSENT_KEY = "cheaterfinder.analytics-consent.v1";
export type AnalyticsConsent = "undecided" | "accepted" | "rejected";

const PAGES: Record<string, string> = {
  "/": "home", "/auth": "auth", "/members": "members", "/dashboard": "dashboard",
  "/settings": "settings", "/notifications": "notifications", "/reports": "reports",
  "/payment": "payment", "/forgot-password": "forgot_password",
  "/reset-password": "reset_password", "/privacy": "privacy", "/terms": "terms",
};

/** Never send query strings, fragments, tracked-account IDs or unknown paths. */
export function analyticsPage(path: string): { path: string; name: string } | null {
  const pathname = path.split(/[?#]/, 1)[0];
  if (/^\/dashboard\/[^/]+\/?$/.test(pathname)) return { path: "/dashboard/:id", name: "dashboard" };
  const name = Object.hasOwn(PAGES, pathname) ? PAGES[pathname] : null;
  return name ? { path: pathname, name } : null;
}

export const PRODUCT_EVENTS = {
  auth_succeeded: { method: ["login", "register"], entry: ["auth", "payment"] },
  tracking_account_added: {},
  dashboard_tab_viewed: { tab: ["recent", "all", "following"] },
  checkout_started: { plan: ["starter", "standard", "pro"] },
  report_requested: { period: ["weekly", "monthly"] },
} as const;
export type ProductEvent = keyof typeof PRODUCT_EVENTS;

/** Only finite enums belong in product events, never response/request bodies. */
export function productEventProperties(event: string, input: Record<string, unknown> = {}): Record<string, string> | null {
  if (!Object.hasOwn(PRODUCT_EVENTS, event)) return null;
  const schema = PRODUCT_EVENTS[event as ProductEvent] as Record<string, readonly string[]>;
  const properties: Record<string, string> = {};
  for (const [key, values] of Object.entries(schema)) {
    const value = input[key];
    if (typeof value === "string" && values.includes(value)) properties[key] = value;
  }
  return properties;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type AnalyticsUser = { id: string } | "admin" | null;
export function analyticsUser(value: unknown): AnalyticsUser {
  if (!value || typeof value !== "object") return null;
  const user = value as Record<string, unknown>;
  if (user.role === "admin" || user.isAdmin === true) return "admin";
  return typeof user.id === "string" && UUID_PATTERN.test(user.id) ? { id: user.id } : null;
}
