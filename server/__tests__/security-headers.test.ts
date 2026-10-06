import { describe, expect, it } from "vitest";
import helmet from "helmet";
import type { IncomingMessage, ServerResponse } from "node:http";
import { productionHstsOptions } from "../security-headers.js";

describe("production HTTPS hardening", () => {
  it("sets a host-only one-day HSTS header without preload", () => {
    const options = productionHstsOptions({ NODE_ENV: "production", HTTPS_ENABLED: "true" });
    expect(options).toEqual({ maxAge: 86_400, includeSubDomains: false, preload: false });
    const headers = new Map<string, string>();
    const response = { setHeader(name: string, value: string) { headers.set(name, value); } } as ServerResponse;
    if (!options) throw new Error("Expected production HTTPS options");
    helmet.hsts(options)({} as IncomingMessage, response, () => {});
    expect(headers.get("Strict-Transport-Security")).toBe("max-age=86400");
  });

  it.each([
    { NODE_ENV: "development", HTTPS_ENABLED: "true" },
    { NODE_ENV: "test", HTTPS_ENABLED: "true" },
    { NODE_ENV: "production", HTTPS_ENABLED: "false" },
    { NODE_ENV: "production" },
    {},
  ])("does not force HTTPS in an unconfigured or local environment: %j", env => {
    expect(productionHstsOptions(env)).toBe(false);
  });
});
