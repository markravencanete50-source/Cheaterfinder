import express, { type Express, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import {
  PUBLIC_ROUTES,
  canonicalUrlFor,
  isKnownRoute,
  isNoindexRoute,
  normalizePath,
  prerenderedFileFor,
} from "../shared/seo-routes.js";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // The SPA shell — the un-prerendered index.html — is written next to
  // dist/public by script/prerender.ts, deliberately outside the web root so it
  // is not fetchable as a thin duplicate of the homepage. A build made with
  // SKIP_PRERENDER=1 has no shell file; there index.html is still the shell.
  const shellPath = path.resolve(__dirname, "app-shell.html");
  const indexHtmlPath = path.resolve(distPath, "index.html");
  const appShellPath = fs.existsSync(shellPath) ? shellPath : indexHtmlPath;

  const sendHtml = (res: Response, filePath: string, status = 200) => {
    // HTML must always revalidate so returning clients pick up the current
    // asset hashes after a redeploy.
    res.status(status).sendFile(filePath, {
      headers: { "Cache-Control": "no-cache" },
    });
  };

  // ── Prerendered marketing pages ────────────────────────────────────────────
  // Registered ahead of express.static so a request for /privacy is answered
  // here rather than triggering express.static's directory-redirect to
  // /privacy/, and so / gets the prerendered homepage instead of the shell.
  app.get(Array.from(PUBLIC_ROUTES, (route) => route.path), (req, res, next) => {
    const target = normalizePath(req.path);
    const file = prerenderedFileFor(target);
    if (file === undefined) {
      next();
      return;
    }

    // Express routing is non-strict, so this handler also receives the
    // trailing-slash spelling. Collapse it onto the canonical URL rather than
    // serving one page at two indexable addresses.
    if (req.path !== target) {
      res.redirect(301, canonicalUrlFor(target));
      return;
    }

    const prerenderedPath = path.resolve(distPath, file);
    if (!fs.existsSync(prerenderedPath)) {
      // SKIP_PRERENDER build, or a route added to PUBLIC_ROUTES that has not
      // been built yet. The shell still renders the page client-side.
      sendHtml(res, appShellPath);
      return;
    }

    sendHtml(res, prerenderedPath);
  });

  // Serve hashed build assets. They are content-addressed (filename contains a
  // content hash), so they are safe to cache permanently. index.html is handled
  // by the SPA fallback below (index:false) so it can be sent with no-cache.
  // redirect:false keeps a request for /privacy from being 301'd to /privacy/
  // just because a prerendered directory of that name exists on disk.
  app.use(
    express.static(distPath, {
      index: false,
      redirect: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  // SPA fallback. Serve the shell ONLY for navigation requests (no file
  // extension). A request for a missing static asset — e.g. a stale chunk whose
  // hash changed in a redeploy while a tab was still open — must return 404, NOT
  // index.html. Otherwise the browser receives HTML where it expected a JS/CSS
  // module and fails with a MIME-type error, leaving the app stuck on a blank /
  // loading screen.
  app.use((req: Request, res: Response, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    // Missing asset-looking request (under /assets/ or with a file extension)
    // → genuine 404 instead of the HTML shell.
    if (req.path.startsWith("/assets/") || path.extname(req.path) !== "") {
      res.status(404).type("txt").send("Not found");
      return;
    }

    // An /api path that reached this far matched no route in registerRoutes,
    // so it is an unknown endpoint. Answer in the API's own currency rather
    // than handing an HTTP client a page of HTML with a 200 on it.
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      res.status(404).json({ message: "Not found" });
      return;
    }

    // Keep authenticated, user-specific and admin surfaces out of the index.
    // These are crawlable on purpose: a path blocked in robots.txt is never
    // fetched, so its noindex is never seen and the bare URL can still be
    // indexed from an external link. See shared/seo-routes.ts.
    if (isNoindexRoute(req.path)) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
    }

    // A path the client router has no component for is a real 404, and is
    // answered as one. The shell is still returned as the body so the SPA boots
    // and renders its own 404 page — the status code is what stops search
    // engines from treating scanner noise like /wp-json or /server-status as
    // indexable pages ("soft 404").
    const status = isKnownRoute(req.path) ? 200 : 404;
    if (status === 404) {
      res.setHeader("X-Robots-Tag", "noindex");
    }

    sendHtml(res, appShellPath, status);
  });
}
