/**
 * Single source of truth for how each URL is treated by search engines.
 *
 * Consumed by:
 *   - script/prerender.ts → what to prerender, and what goes in sitemap.xml
 *   - server/static.ts    → which prerendered file to serve, which routes get
 *                           a noindex header, and which paths are a real 404
 *
 * Keep the route tables below in sync with the <Route> list in
 * client/src/App.tsx. A route missing here still works for users — it only
 * loses its prerendered HTML and starts answering 404 to crawlers.
 */

/** Canonical origin. Every canonical/og:url/sitemap URL is built from this. */
export const SITE_ORIGIN = "https://cheaterfinder.com";

export interface PublicRoute {
  /** URL path as the router sees it. */
  readonly path: string;
  /** Prerender output, relative to dist/public. */
  readonly file: string;
  /** sitemap.xml <changefreq> */
  readonly changefreq: "daily" | "weekly" | "monthly" | "yearly";
  /** sitemap.xml <priority> */
  readonly priority: string;
}

/**
 * Public marketing pages: prerendered to real HTML at build time and listed in
 * the sitemap. These are the only routes a crawler should ever index.
 */
export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  { path: "/", file: "index.html", changefreq: "weekly", priority: "1.0" },
  { path: "/privacy", file: "privacy/index.html", changefreq: "yearly", priority: "0.3" },
  { path: "/terms", file: "terms/index.html", changefreq: "yearly", priority: "0.3" },
];

/**
 * Real pages that must never be indexed — either behind auth, user-specific,
 * admin-only, or carrying a token in the URL.
 *
 * These are deliberately NOT disallowed in robots.txt: a crawler blocked by
 * robots.txt never fetches the page, so it never sees the noindex header, and
 * the bare URL can still surface in results from an external link. Letting it
 * crawl and read `X-Robots-Tag: noindex` is what actually removes the URL.
 */
export const NOINDEX_PREFIXES: readonly string[] = [
  "/admin",
  "/auth",
  "/dashboard",
  "/forgot-password",
  "/members",
  "/notifications",
  "/payment",
  "/reports",
  "/reset-password",
  "/settings",
];

/** Routes the SPA router resolves exactly. Mirrors App.tsx. */
const EXACT_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/admin",
  "/admin/health",
  "/auth",
  "/dashboard",
  "/forgot-password",
  "/members",
  "/notifications",
  "/payment",
  "/privacy",
  "/reports",
  "/reset-password",
  "/settings",
  "/terms",
]);

/** Routes with a path parameter, e.g. <Route path="/dashboard/:id" />. */
const PARAM_ROUTE_PREFIXES: readonly string[] = ["/dashboard/"];

/**
 * Strip a single trailing slash so "/privacy/" and "/privacy" are judged the
 * same. Root stays "/".
 */
export function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * True when the SPA router has a component for this path. Anything else is a
 * genuine 404 and should be answered with a 404 status rather than a 200 shell,
 * which search engines read as a "soft 404".
 */
export function isKnownRoute(pathname: string): boolean {
  const path = normalizePath(pathname);
  if (EXACT_ROUTES.has(path)) {
    return true;
  }
  return PARAM_ROUTE_PREFIXES.some(
    (prefix) => path.startsWith(prefix) && path.length > prefix.length,
  );
}

/** True when this path must carry `X-Robots-Tag: noindex`. */
export function isNoindexRoute(pathname: string): boolean {
  const path = normalizePath(pathname);
  return NOINDEX_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** The prerendered file for a path, or undefined if the path is not public. */
export function prerenderedFileFor(pathname: string): string | undefined {
  const path = normalizePath(pathname);
  return PUBLIC_ROUTES.find((route) => route.path === path)?.file;
}

/** Absolute canonical URL for a route path. */
export function canonicalUrlFor(pathname: string): string {
  const path = normalizePath(pathname);
  return path === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${path}`;
}
