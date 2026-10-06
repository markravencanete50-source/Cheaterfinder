import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { productionHstsOptions } from "./security-headers.js";
import { configureTrustedProxy, listenHost, createHttpLogger, safeHttpErrorHandler } from "./http-security.js";
import { registerRoutes } from "./routes.js";
import { serveStatic } from "./static.js";
import { createServer } from "http";
import { requireCsrfToken, setupAuth } from "./auth.js";
import {
  startSafeBackgroundWorkers,
  startWorkers,
  stopWorkers,
} from "./workers.js";
import { startBandwidthMeter, stopBandwidthMeter } from "./services/bandwidth-meter.js";
import {
  startProxyWireSampler,
  stopProxyWireSampler,
} from "./services/proxy-wire-sampler.js";
import { initRefreshConfig } from "./services/refresh-config.js";
import { pool } from "./db.js";
import { POSTHOG_API_HOST } from "../shared/product-analytics.js";
import { logger } from "./observability/logger.js";
import { validateSessionDataKey } from "./crypto/session-envelope.js";
import { backfillBotFingerprints } from "./bot-manager.js";
import {
  formatIntegrationStatusLine,
  getIntegrationStatus,
} from "./integrations.js";
import {
  startBotPoolMonitor,
  stopBotPoolMonitor,
} from "./bot-pool-monitor.js";
import {
  startTier1RefreshMonitor,
  stopTier1RefreshMonitor,
} from "./services/tier1-refresh-monitor.js";
import { reconcileStaleCollectionJobs, reconcileStaleGeneratingReports } from "./services/collection-job-reconciler.js";
import { hydrateFromOutcomeLog } from "./services/scrape-metrics.js";
import { markShuttingDown, shutdownCleanupFailures } from "./services/shutdown-state.js";

// ─── Boot-time secret validation (Wave 2 task E) ────────────────────────────
// In production the key MUST be present; in dev we warn and continue so
// local contributors can run without touching secrets first.
try {
  validateSessionDataKey();
} catch (err) {
  if (process.env.NODE_ENV === "production") {
    logger.error(
      { err },
      "SESSION_DATA_KEY missing/invalid — refusing to start in production",
    );
    process.exit(1);
  } else {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "SESSION_DATA_KEY missing/invalid — bot session encryption disabled in development",
    );
  }
}

// ─── Boot-time integration status ──────────────────────────────────────────
// Wave 5 task A: surface placeholder/missing third-party keys at a glance so
// operators can immediately see which optional features are disabled. Does
// NOT exit on placeholder values — billing/email/proxy are all optional.
{
  const integrationSnapshot = getIntegrationStatus();
  logger.info(
    { module: "boot", ...integrationSnapshot },
    `[boot] ${formatIntegrationStatusLine(integrationSnapshot)}`,
  );
}

const app = express();
const httpServer = createServer(app);
const isDevelopment = process.env.NODE_ENV !== "production";

configureTrustedProxy(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Security headers via helmet - placed early in the middleware chain
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vite injects two inline module preambles for React Refresh in
        // development. Blocking them leaves the SPA with a blank page and
        // "@vitejs/plugin-react can't detect preamble" in the console. Keep
        // production strict; this relaxation only applies to the local dev
        // server.
        scriptSrc: isDevelopment ? ["'self'", "'unsafe-inline'"] : ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "https:"],
        mediaSrc: ["'self'", "blob:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'", POSTHOG_API_HOST],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: productionHstsOptions(),
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false,
    frameguard: { action: "deny" },
    noSniff: true,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

app.use(createHttpLogger());

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  logger.info({ module: source }, message);
}

// Legacy request-body capture removed in favor of pino-http structured logs.
// If we ever need captured JSON responses for specific debugging, prefer
// adding a targeted audit log rather than logging every response body.

(async () => {
  // Auth middleware must be registered before routes
  setupAuth(app);

  // ── CSRF protection (custom-header check) ──────────────────────────────────
  // For every state-changing request, require either:
  //   1. An Origin header that matches the server host, OR
  //   2. The custom header X-Requested-With (any value).
  // This blocks cross-origin form submissions (which cannot set custom headers)
  // while allowing our SPA fetch calls and trusted webhooks through.
  app.use((req, res, next) => {
    // Safe (read-only) methods are exempt
    const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
    if (safeMethods.has(req.method)) {
      return next();
    }

    // Stripe webhook uses its own signature-based auth, not browser cookies
    if (req.path === "/api/webhooks/stripe") {
      return next();
    }

    // Authenticated mutations must prove same-origin script access via the
    // double-submit token issued at login/register. This protects non-admin
    // account, tracking, billing, and notification routes too.
    if (req.isAuthenticated?.()) {
      return requireCsrfToken(req, res, next);
    }

    // Check 1: custom header present (browsers cannot set this cross-origin)
    if (req.headers["x-requested-with"]) {
      return next();
    }

    // Check 2: Origin header matches the server host
    const origin = req.headers["origin"];
    if (origin) {
      const host = req.headers["host"];
      try {
        const originHost = new URL(origin).host;
        if (host && originHost === host) {
          return next();
        }
      } catch {
        // malformed origin — fall through to rejection
      }
    }

    logger.warn(
      { module: "csrf", method: req.method, path: req.path, origin: origin ?? null },
      "CSRF check failed",
    );
    return res.status(403).json({ message: "Forbidden: CSRF validation failed" });
  });

  await registerRoutes(httpServer, app);

  app.use(safeHttpErrorHandler);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite.js");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Production listens only on loopback behind nginx.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: listenHost(),
      reusePort: true,
    },
    () => {
      logger.info({ module: "server", port }, `serving on port ${port}`);
      // Wave 8 safety switch: WORKERS_DISABLED=1 skips BullMQ workers and
      // bot-pool monitoring so the HTTP/UI stays usable without burning
      // proxy bandwidth or hammering banned bots. Used during recovery
      // periods where the dashboard needs to be viewable but no IG calls
      // should fire. Unset / "0" runs the full pipeline as before.
      // Bandwidth meter records IG transfer for ALL request paths (web
      // onboarding syncs included), so start it regardless of the worker
      // safety switch. Idempotent.
      startBandwidthMeter();
      // Kernel-counter sampler for the billable gateway figure. Started HERE
      // and nowhere else: iptables counters are host-global, so sampling them
      // from the worker process too would double-count every byte. Degrades to
      // a single warn when it cannot run (not root, no iptables, no gateway).
      startProxyWireSampler();
      void initRefreshConfig();
      // Rebuild the 24h endpoint-success window from the outcome log so a restart
      // does not blank the admin health panel (it read 0/0 after every deploy).
      void hydrateFromOutcomeLog()
        .then((n) => logger.info({ module: "scrape-metrics", loaded: n }, "scrape metrics hydrated from outcome log"))
        .catch((err) => logger.error({ module: "scrape-metrics", err }, "scrape metrics hydrate failed"));
      void reconcileStaleCollectionJobs().catch((err) =>
        logger.error(
          { module: "server", err },
          "stale collection-job reconciliation failed",
        ),
      );
      void reconcileStaleGeneratingReports().catch((err) =>
        logger.error(
          { module: "server", err },
          "stale generating-report reconciliation failed",
        ),
      );
      // Public profile metadata and recent post previews require no bot
      // cookies, so this bounded refresher remains safe while authenticated
      // BullMQ collection is paused.
      startTier1RefreshMonitor();
      // Identity repair is database-only and makes no Instagram requests, so
      // it must still run while collection is paused. Migrated Firefox bots
      // keep their legacy scheduling/header columns aligned with their
      // immutable automation_identity before workers can ever be re-enabled.
      void backfillBotFingerprints().catch((err) =>
        logger.error({ module: "server", err }, "fingerprint backfill failed"),
      );
      if (process.env.WORKERS_DISABLED === "1") {
        logger.warn(
          { module: "server" },
          "WORKERS_DISABLED=1 — authenticated Instagram workers and bot-pool monitor are paused",
        );
        startSafeBackgroundWorkers();
      } else {
        // Start BullMQ workers after server is ready
        startWorkers();
        // Wave 5 task B: periodic warning when active bot pool < 5.
        startBotPoolMonitor();
      }
    },
  );

  // Graceful shutdown
  // Shutdown budget. pm2's kill_timeout is 180 s (ecosystem.config.cjs); we
  // must exit before that or pm2 SIGKILLs us mid-job. Previously stopWorkers()
  // only ran inside httpServer.close()'s callback and the force-exit fired at
  // 10 s, while pm2 killed at 1.6 s — so no deploy ever let an active likes
  // scan or roster walk finish: the job stalled, re-ran from zero (double IG
  // spend) or, after a second restart, was failed for good. None of it logged.
  const SHUTDOWN_BUDGET_MS = 170_000;
  const shutdown = async (signal: string) => {
    // Flip the process-wide flag FIRST (C4): the like-evidence owner loop and
    // the follower/following page walk poll it and stop between units of work,
    // returning partial progress with a resume point, so worker.close() below
    // resolves inside the budget instead of racing pm2's SIGKILL.
    markShuttingDown();
    logger.info({ module: "server", signal }, "shutting down gracefully");
    const forceExit = setTimeout(() => {
      logger.error(
        { module: "server", budgetMs: SHUTDOWN_BUDGET_MS },
        "forced shutdown after timeout; an active job may re-run on next boot",
      );
      process.exit(1);
    }, SHUTDOWN_BUDGET_MS);
    forceExit.unref();
    try {
      stopBotPoolMonitor();
      // Stop accepting HTTP and drain workers CONCURRENTLY: worker.close()
      // waits for the active job, which is the long pole.
      await Promise.all([
        new Promise<void>((resolve) => httpServer.close(() => resolve())),
        stopTier1RefreshMonitor(),
        stopWorkers(),
      ]);
      if (shutdownCleanupFailures()) logger.warn({ failures: shutdownCleanupFailures() }, "some shutdown cleanup hooks failed");
      // Producers have stopped. Keep both meters alive through their final
      // requests, then await the final attribution flush and gateway sample.
      await Promise.all([stopBandwidthMeter(), stopProxyWireSampler()]);
      await pool.end();
      logger.info({ module: "server" }, "shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ module: "server", err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
