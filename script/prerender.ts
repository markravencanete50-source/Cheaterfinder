/**
 * Build-time prerendering for the public marketing pages.
 *
 * Why: the app is a client-rendered SPA, so the raw HTML is an empty
 * <div id="root">. Googlebot does execute JavaScript, but social scrapers
 * (Facebook, WhatsApp, X, LinkedIn) and AI crawlers (GPTBot, ClaudeBot,
 * PerplexityBot) never do, and JS rendering costs Google render budget it
 * spends reluctantly on a new domain. This walks the built bundle with the
 * Chromium we already have for E2E work and writes the rendered HTML back to
 * disk, so crawlers get real markup with zero framework migration.
 *
 * The app itself is untouched: main.tsx still calls createRoot(), which clears
 * the container and renders from scratch. There is no hydration contract to
 * break, and no mismatch warnings to chase — the prerendered markup is a
 * crawler payload, not a hydration source.
 *
 * Set SKIP_PRERENDER=1 to build without it (e.g. an environment with no
 * Chromium). The build then ships the plain SPA shell, as it did before.
 */
import express from "express";
import { chromium } from "playwright";
import type { Server } from "http";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import {
  PUBLIC_ROUTES,
  canonicalUrlFor,
  type PublicRoute,
} from "../shared/seo-routes.js";

const DIST_PUBLIC = path.resolve(process.cwd(), "dist/public");
/**
 * The untouched SPA shell. Kept OUTSIDE dist/public so it is never web-served
 * as a duplicate of the homepage — server/static.ts reads it from disk to
 * answer routes that have no prerendered HTML of their own.
 */
const SHELL_OUTPUT = path.resolve(process.cwd(), "dist/app-shell.html");

const NAV_TIMEOUT_MS = 30_000;

interface StaticServer {
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * Serve dist/public exactly the way production does — assets from disk, SPA
 * shell for navigation requests — so the page we snapshot is the page users
 * get, not an approximation.
 */
function startStaticServer(shellHtml: string): Promise<StaticServer> {
  const app = express();

  app.use(express.static(DIST_PUBLIC, { index: false, redirect: false }));
  app.use((req, res) => {
    // Mirror production: an unmatched /api path is a 404, not the HTML shell.
    // Without this, Navigation's GET /api/auth/me sees a 200 (the shell) and
    // flips the header into its signed-in state, so the prerendered page shows
    // "Dashboard / Log Out" to every crawler instead of "Sign In".
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    if (path.extname(req.path) !== "") {
      res.status(404).end();
      return;
    }
    res.type("html").send(shellHtml);
  });

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("prerender: static server did not report a port"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) =>
            server.close((err) => (err ? fail(err) : done())),
          ),
      });
    });
    server.on("error", reject);
  });
}

/** Pull the generic defaults out of the shell so we can tell them apart from
 *  the route-specific tags React renders on top. */
function readShellDefaults(shellHtml: string): {
  title: string;
  description: string;
} {
  const title = /<title>([\s\S]*?)<\/title>/.exec(shellHtml)?.[1] ?? "";
  const description =
    /<meta\s+name="description"\s+content="([^"]*)"/.exec(shellHtml)?.[1] ?? "";
  return { title, description };
}

interface HeadNormalisation {
  readonly canonical: string;
  readonly defaultTitle: string;
  readonly defaultDescription: string;
}

/**
 * Runs inside the page. React 19 hoists <title> and <meta> from the route
 * component into <head> on top of the static defaults already in index.html,
 * so a rendered document can carry two of each. Collapse them to one, then
 * stamp the per-route canonical and mirror the final copy into the social tags.
 *
 * Written against the real DOM rather than regex over the serialised string:
 * the browser has already parsed this document, so there is no markup to
 * mis-tokenise.
 */
function normaliseHead(options: HeadNormalisation): string {
  const { canonical, defaultTitle, defaultDescription } = options;
  const head = document.head;

  // Of the duplicates, keep the one that is NOT the generic shell default —
  // that is the route-specific tag. Order-independent, so it does not depend
  // on where React chose to insert its hoisted tag.
  const collapse = (selector: string, read: (el: Element) => string, fallback: string) => {
    const nodes = Array.from(head.querySelectorAll(selector));
    if (nodes.length < 2) return;
    const specific = nodes.find((node) => read(node) !== fallback);
    const keep = specific ?? nodes[nodes.length - 1];
    nodes.filter((node) => node !== keep).forEach((node) => node.remove());
  };

  collapse("title", (el) => el.textContent ?? "", defaultTitle);
  collapse(
    'meta[name="description"]',
    (el) => el.getAttribute("content") ?? "",
    defaultDescription,
  );

  const upsert = (
    selector: string,
    create: () => HTMLElement,
    attribute: string,
    value: string,
  ) => {
    let element = head.querySelector(selector);
    if (element === null) {
      element = create();
      head.appendChild(element);
    }
    element.setAttribute(attribute, value);
  };

  upsert(
    'link[rel="canonical"]',
    () => {
      const link = document.createElement("link");
      link.setAttribute("rel", "canonical");
      return link;
    },
    "href",
    canonical,
  );

  upsert(
    'meta[property="og:url"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("property", "og:url");
      return meta;
    },
    "content",
    canonical,
  );

  // Keep the share card honest: without this, a share of /privacy advertises
  // the homepage headline.
  const finalTitle = head.querySelector("title")?.textContent ?? defaultTitle;
  const finalDescription =
    head.querySelector('meta[name="description"]')?.getAttribute("content") ??
    defaultDescription;

  head
    .querySelector('meta[property="og:title"]')
    ?.setAttribute("content", finalTitle);
  head
    .querySelector('meta[name="twitter:title"]')
    ?.setAttribute("content", finalTitle);
  head
    .querySelector('meta[property="og:description"]')
    ?.setAttribute("content", finalDescription);
  head
    .querySelector('meta[name="twitter:description"]')
    ?.setAttribute("content", finalDescription);

  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}\n`;
}

function buildSitemap(routes: readonly PublicRoute[], lastmod: string): string {
  const entries = routes
    .map((route) =>
      [
        "  <url>",
        `    <loc>${canonicalUrlFor(route.path)}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <changefreq>${route.changefreq}</changefreq>`,
        `    <priority>${route.priority}</priority>`,
        "  </url>",
      ].join("\n"),
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    "</urlset>",
    "",
  ].join("\n");
}

export async function prerender(): Promise<void> {
  if (process.env.SKIP_PRERENDER === "1") {
    console.log("prerender: SKIP_PRERENDER=1 set, shipping the plain SPA shell");
    return;
  }

  const indexPath = path.join(DIST_PUBLIC, "index.html");
  const shellHtml = await readFile(indexPath, "utf-8");
  const defaults = readShellDefaults(shellHtml);

  // Snapshot the shell before the homepage prerender overwrites index.html.
  await writeFile(SHELL_OUTPUT, shellHtml, "utf-8");

  const server = await startStaticServer(shellHtml);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // tsx compiles this file with esbuild's keepNames on, which wraps every
    // function in a __name(fn, "…") helper. page.evaluate ships the function
    // source to the browser, where that helper does not exist. Provide it as a
    // raw string (not a function literal, which would get the same treatment).
    // addInitScript runs in the page context without adding a <script> tag, so
    // it leaves no trace in the serialised HTML.
    await page.addInitScript({
      content: "globalThis.__name = globalThis.__name || ((fn) => fn);",
    });

    // Hermetic build: the page links Google Fonts, and a build machine may be
    // offline or behind a firewall. Fonts change no markup, so drop every
    // non-local request rather than let the build hang on one.
    await page.route("**/*", (route) => {
      const { hostname } = new URL(route.request().url());
      return hostname === "127.0.0.1" ? route.continue() : route.abort();
    });

    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));

    for (const route of PUBLIC_ROUTES) {
      failures.length = 0;

      await page.goto(`${server.origin}${route.path}`, {
        waitUntil: "load",
        timeout: NAV_TIMEOUT_MS,
      });

      // Every public page renders an <h1>; the lazy-route Suspense fallback
      // renders only a spinner. Waiting on the heading therefore waits past
      // the chunk fetch for /privacy and /terms.
      await page.waitForSelector("#root h1", { timeout: NAV_TIMEOUT_MS });

      // Let in-flight app requests (e.g. Navigation's GET /api/auth/me) settle
      // so the snapshot is the page's resolved state rather than whichever
      // half-loaded frame we happened to catch. Bounded and non-fatal: a page
      // that never goes idle still gets prerendered from what it has.
      await page
        .waitForLoadState("networkidle", { timeout: 5_000 })
        .catch(() => undefined);

      if (failures.length > 0) {
        throw new Error(
          `prerender: ${route.path} raised runtime errors: ${failures.join("; ")}`,
        );
      }

      const html = await page.evaluate(normaliseHead, {
        canonical: canonicalUrlFor(route.path),
        defaultTitle: defaults.title,
        defaultDescription: defaults.description,
      });

      const outputPath = path.join(DIST_PUBLIC, route.file);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, html, "utf-8");

      console.log(
        `prerender: ${route.path} -> dist/public/${route.file} (${(html.length / 1024).toFixed(1)}KB)`,
      );
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const lastmod = new Date().toISOString().slice(0, 10);
  await writeFile(
    path.join(DIST_PUBLIC, "sitemap.xml"),
    buildSitemap(PUBLIC_ROUTES, lastmod),
    "utf-8",
  );
  console.log(`prerender: sitemap.xml (${PUBLIC_ROUTES.length} urls, lastmod ${lastmod})`);
}
