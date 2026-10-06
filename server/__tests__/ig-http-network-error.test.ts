// D1: a failed fetch is wrapped as IGHttpError(0, …). Status 0 stays the
// network sentinel that scrape-retry / the scraper key on, but the message now
// names the root cause (undici / Node error code, else the error name) and the
// proxy lane, so a lane failing 31% of its attempts is diagnosable from the
// log. These exercise the pure helpers only — no sockets, no undici.

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

// bandwidth-meter is the only transitive import of ig-http-client that pulls
// in the real db chain at module load. Stub it so the module loads cleanly.
vi.mock("../services/bandwidth-meter.js", () => ({
  recordBytes: vi.fn(),
}));

vi.mock("../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import {
  IGHttpError,
  formatNetworkErrorMessage,
  proxyLaneLabel,
  transportErrorCode,
} from "../ig-http-client.js";

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("transportErrorCode", () => {
  it("walks the cause chain to undici's code", () => {
    const err = new TypeError("fetch failed", {
      cause: withCode("connect timeout", "UND_ERR_CONNECT_TIMEOUT"),
    });
    expect(transportErrorCode(err)).toBe("UND_ERR_CONNECT_TIMEOUT");
  });

  it("reaches a Node socket code nested two levels down", () => {
    const socket = withCode("read ECONNRESET", "ECONNRESET");
    const err = new TypeError("fetch failed", {
      cause: new Error("other side closed", { cause: socket }),
    });
    expect(transportErrorCode(err)).toBe("ECONNRESET");
  });

  it("falls back to the error name when there is no string code (AbortError)", () => {
    // DOMException.code is numeric (20 for AbortError) — never surface that.
    const abort = new DOMException("This operation was aborted", "AbortError");
    expect(transportErrorCode(abort)).toBe("AbortError");
  });

  it("names a plain error by its class and non-errors as unknown", () => {
    expect(transportErrorCode(new Error("boom"))).toBe("Error");
    expect(transportErrorCode("socket hang up")).toBe("unknown");
    expect(transportErrorCode(undefined)).toBe("unknown");
    expect(transportErrorCode(null)).toBe("unknown");
  });

  it("terminates on a self-referential cause chain", () => {
    const loop: { cause?: unknown; code: string } = { code: "ELOOP" };
    loop.cause = loop;
    expect(transportErrorCode(loop)).toBe("ELOOP");
  });
});

describe("proxyLaneLabel", () => {
  it("keeps host:port and drops credentials", () => {
    expect(proxyLaneLabel("gw.dataimpulse.com:10925:user:secret")).toBe(
      "gw.dataimpulse.com:10925",
    );
    expect(proxyLaneLabel("10.0.0.1:9000")).toBe("10.0.0.1:9000");
  });

  it("is null when the client has no proxy or the endpoint is malformed", () => {
    expect(proxyLaneLabel(null)).toBeNull();
    expect(proxyLaneLabel(undefined)).toBeNull();
    expect(proxyLaneLabel("")).toBeNull();
    expect(proxyLaneLabel("justahost")).toBeNull();
  });
});

describe("formatNetworkErrorMessage", () => {
  it("puts the root cause code and the lane in the message", () => {
    const err = new TypeError("fetch failed", {
      cause: withCode("socket", "UND_ERR_SOCKET"),
    });
    expect(
      formatNetworkErrorMessage("[ig-http]", "GET", "profile", err, "gw.dataimpulse.com:10925:u:p"),
    ).toBe("[ig-http] network error (UND_ERR_SOCKET) GET profile lane=gw.dataimpulse.com:10925");
  });

  it("omits the lane when the client has none and keeps the 'network error' phrase the classifiers match on", () => {
    const msg = formatNetworkErrorMessage("[ig-mobile]", "POST", "likers", new Error("boom"), null);
    expect(msg).toBe("[ig-mobile] network error (Error) POST likers");
    expect(msg).toContain("network error");
  });

  it("wrapped as IGHttpError keeps status 0 and the cause attached", () => {
    const cause = withCode("read ECONNRESET", "ECONNRESET");
    const wrapped = new IGHttpError(
      0,
      formatNetworkErrorMessage("[ig-http]", "GET", "posts", cause, null),
      { cause, url: "https://www.instagram.com/api/v1/feed/user/1/", method: "GET" },
    );
    expect(wrapped.status).toBe(0);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.message).toBe("[ig-http] network error (ECONNRESET) GET posts");
  });
});
