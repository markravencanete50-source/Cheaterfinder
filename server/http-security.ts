import { randomBytes } from "node:crypto";
import pinoHttp from "pino-http";
import type { Logger } from "pino";
import type { ErrorRequestHandler, Express } from "express";
import { logger } from "./observability/logger.js";

/** nginx connects locally and overwrites forwarding headers. Never trust a hop count. */
export function configureTrustedProxy(app: Express) {
  app.set("trust proxy", "loopback");
}

export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.NODE_ENV === "production" ? "127.0.0.1" : (env.LISTEN_HOST || "127.0.0.1");
}

/** Query values can contain reset, OAuth, checkout and other bearer credentials. */
export function redactSensitiveUrl(value: string): string {
  try {
    const url = new URL(value, "http://localhost");
    return url.pathname + (url.search ? "?[REDACTED]" : "");
  } catch {
    return "[invalid URL]";
  }
}

const publicErrors: Record<number, string> = {
  400: "Invalid request", 401: "Authentication required", 403: "Forbidden",
  404: "Not found", 409: "Request conflicts with current state",
  413: "Request body too large", 415: "Unsupported media type",
  422: "Invalid request", 429: "Too many requests",
};

export const safeHttpErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const raw = err?.status ?? err?.statusCode;
  const status = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
  logger.error({ module: "express", err, reqId: req.id, status }, "Request failed");
  if (res.headersSent) { res.destroy(); return; }
  res.status(status).json({ message: publicErrors[status] ?? "Internal Server Error", requestId: req.id });
};

export function createHttpLogger(destination: Logger = logger) {
  return pinoHttp({
    logger: destination,
    genReqId: (_req, res) => {
      const id = randomBytes(16).toString("hex");
      res.setHeader("x-request-id", id);
      return id;
    },
    customLogLevel: (_req, res, err) => err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: redactSensitiveUrl(req.url ?? "") }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}
