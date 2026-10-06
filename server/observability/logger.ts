// ─── Structured logger + correlation IDs ─────────────────────────────────────
//
// Pino-based structured logger with an AsyncLocalStorage-backed correlation
// context. Any field placed on the ALS store (e.g. trackedAccountId, reqId)
// is automatically injected into every log line emitted within that async
// scope.
//
// Redact list covers known sensitive fields — IG session cookies, the CSRF
// token, user password hashes — so they never leak into logs.
// ─────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger, type LoggerOptions } from "pino";
import { safeError } from "./safe-error.js";

type CorrelationCtx = Record<string, string | number | undefined>;

const als = new AsyncLocalStorage<CorrelationCtx>();

export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  serializers: { err: safeError, error: safeError },
  redact: {
    paths: [
      "sessionid",
      "csrftoken",
      "*.sessionData",
      "*.session_data",
      "sessionData",
      "session_data",
      "password",
      "token",
      "resetToken",
      "accessToken",
      "refreshToken",
      "*.token",
      "*.password",
      "*.params",
      "*.query",
      "hashedPassword",
      "hashed_password",
      "ig_password",
      "igPassword",
      "ig_password_encrypted",
      "igPasswordEncrypted",
      "email_password",
      "emailPassword",
      "email_password_encrypted",
      "emailPasswordEncrypted",
      "*.ig_password",
      "*.igPassword",
      "*.email_password",
      "*.emailPassword",
      "req.headers.cookie",
      "req.headers.authorization",
      "headers.cookie",
      "headers.authorization",
    ],
    censor: "<redacted>",
  },
  mixin: () => {
    const store = als.getStore();
    return store ? { ...store } : {};
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const logger: Logger = pino(loggerOptions);

/**
 * Run `fn` inside an async-local correlation context. Any logger call made
 * anywhere inside the promise chain returned by `fn` automatically includes
 * the provided ctx fields (merged on top of any existing outer context).
 */
export function withCorrelation<T>(
  ctx: CorrelationCtx,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = als.getStore() ?? {};
  return als.run({ ...existing, ...ctx }, fn);
}

/** Read the current correlation context, if any. */
export function getCorrelation(): CorrelationCtx {
  return { ...(als.getStore() ?? {}) };
}

/** Set a single correlation field in the current context (if any). Mutating
 *  helper — use sparingly, only for late-arriving IDs like post-insert row IDs.
 */
export function setCorrelationField(key: string, value: string | number): void {
  const store = als.getStore();
  if (store) store[key] = value;
}
