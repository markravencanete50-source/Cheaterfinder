import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import pino from "pino";
import { createServer, type Server } from "node:http";
import { DrizzleQueryError } from "drizzle-orm";
import { configureTrustedProxy, createHttpLogger, listenHost, redactSensitiveUrl, safeHttpErrorHandler } from "../http-security.js";
import { loggerOptions } from "../observability/logger.js";

let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
describe("production HTTP boundaries", () => {
  it("binds production only to loopback and does not trust a non-local direct peer", () => {
    expect(listenHost({ NODE_ENV: "production", LISTEN_HOST: "0.0.0.0" })).toBe("127.0.0.1");
    const app = express(); configureTrustedProxy(app);
    const req = Object.create(app.request);
    req.app = app; req.socket = { remoteAddress: "198.51.100.20" };
    req.headers = { "x-forwarded-for": "192.0.2.99" };
    expect(req.ip).toBe("198.51.100.20");
  });
  it("scrubs queries on web, mobile, encoded and unknown paths", () => {
    for (const path of ["/reset-password", "/app/reset-password", "/mobile/reset-password", "/reset%2Dpassword", "/anything"]) {
      expect(redactSensitiveUrl(path + "?token=reset-secret&other=private")).not.toMatch(/reset-secret|private/);
    }
  });
  it("handles actual HTTP failures without reflecting SQL, parameters, query tokens or forged request IDs", async () => {
    const logs: string[] = [];
    const log = pino({ ...loggerOptions, level: "info" }, { write: (s: string) => { logs.push(s); } });
    const err = new DrizzleQueryError("SELECT secret FROM users WHERE password = $1", ["private-password-hash"], new Error("database-credential"));
    log.error({ err }, "database operation failed");
    const app = express(); configureTrustedProxy(app); app.use(createHttpLogger(log));
    app.get("/app/reset-password", (_req, _res, next) => next(err));
    app.use(safeHttpErrorHandler);
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(Number(process.env.STRESS_FAULT_PORT ?? 0), "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/app/reset-password?token=reset-secret`, { headers: { "x-request-id": "forged-secret", referer: "https://example.invalid/?token=referrer-secret" } });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.message).toBe("Internal Server Error");
    expect(body.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    const output = JSON.stringify(body) + logs.join("");
    expect(output).not.toMatch(/SELECT secret|private-password-hash|database-credential|reset-secret|referrer-secret|forged-secret/);
    expect(logs.join("")).toContain("[REDACTED]");
  });
});
