// HTTP-level tests for the /api/img-proxy security guards: the auth gate
// (401 for unauthenticated requests) and the per-user rate limiters
// (429 with standard RateLimit headers). These run against a minimal Express
// app that mounts the REAL isAuthenticated guard and the REAL limiters — no
// database, no network, no IG CDN.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { RequestHandler } from "express";

// server/auth.ts → server/db.ts requires DATABASE_URL to be *present* at import
// time (the pg Pool connects lazily, so no real database is contacted). Set a
// throwaway value before dynamically importing the real guard, keeping this
// suite hermetic — no DB, no network.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

let isAuthenticated: RequestHandler;
let galleryProxyLimiter: RequestHandler;
let videoProxyLimiter: RequestHandler;

beforeAll(async () => {
  ({ isAuthenticated } = await import("../../auth.js"));
  ({ galleryProxyLimiter, videoProxyLimiter } = await import(
    "../img-proxy-guards.js"
  ));
});

type FakeUser = { id: string } | null;

/**
 * Build a throwaway server that mirrors the production middleware chain:
 *   auth → video limiter (skips non-mp4) → gallery limiter (counts all).
 * `user` controls whether the request is treated as authenticated and which
 * user id keys the rate limiter.
 */
function makeServer(user: FakeUser): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.set("trust proxy", 1);

  // Stand in for passport: populate req.user and req.isAuthenticated().
  app.use((req: Request, res: Response, next: NextFunction) => {
    // The guarded runner reuses one loopback port across fixtures. Do not let
    // fetch pool an idle socket from a server that the previous test closed.
    res.setHeader("Connection", "close");
    (req as unknown as { user: FakeUser }).user = user;
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated =
      () => user !== null;
    next();
  });

  app.get(
    "/api/img-proxy",
    isAuthenticated,
    videoProxyLimiter,
    galleryProxyLimiter,
    (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    },
  );

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(Number(process.env.STRESS_FAULT_PORT ?? 0), "127.0.0.1", (error?: Error) => {
      if (error) { reject(error); return; }
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

let teardown: (() => Promise<void>) | null = null;

beforeEach(() => {
  // Fresh env each test; high limits unless a test lowers them.
  delete process.env.IMG_PROXY_RATE_MAX;
  delete process.env.IMG_PROXY_VIDEO_RATE_MAX;
});

afterEach(async () => {
  if (teardown) {
    await teardown();
    teardown = null;
  }
});

describe("img-proxy auth gate", () => {
  it("returns 401 for an unauthenticated request", async () => {
    const srv = await makeServer(null);
    teardown = srv.close;

    const res = await fetch(
      `${srv.url}/api/img-proxy?url=${encodeURIComponent(
        "https://scontent.cdninstagram.com/x.jpg",
      )}`,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ message: "Unauthorized" });
  });

  it("allows an authenticated request through to the handler", async () => {
    const srv = await makeServer({ id: "user-allow" });
    teardown = srv.close;

    const res = await fetch(
      `${srv.url}/api/img-proxy?url=${encodeURIComponent(
        "https://scontent.cdninstagram.com/x.jpg",
      )}`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("img-proxy rate limiting", () => {
  it("returns 429 with RateLimit headers once the gallery bucket is exhausted", async () => {
    process.env.IMG_PROXY_RATE_MAX = "3";
    // Unique user id so this test's bucket is isolated from other tests.
    const srv = await makeServer({ id: `gallery-${Date.now()}` });
    teardown = srv.close;

    const imageUrl = `${srv.url}/api/img-proxy?url=${encodeURIComponent(
      "https://scontent.cdninstagram.com/x.jpg",
    )}`;

    // First 3 succeed.
    for (let i = 0; i < 3; i++) {
      const ok = await fetch(imageUrl);
      expect(ok.status).toBe(200);
    }

    // 4th is rate-limited.
    const limited = await fetch(imageUrl);
    expect(limited.status).toBe(429);

    // Standard draft headers must be present (standardHeaders: true).
    expect(limited.headers.get("ratelimit-limit")).toBe("3");
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    expect(limited.headers.has("ratelimit-reset")).toBe(true);
    // Legacy headers must be absent (legacyHeaders: false).
    expect(limited.headers.has("x-ratelimit-limit")).toBe(false);

    const body = await limited.json();
    expect(body).toEqual({ message: "Too many media requests, please slow down" });
  });

  it("applies the stricter video bucket only to .mp4 requests", async () => {
    process.env.IMG_PROXY_VIDEO_RATE_MAX = "2";
    process.env.IMG_PROXY_RATE_MAX = "1000"; // keep gallery bucket out of the way
    const srv = await makeServer({ id: `video-${Date.now()}` });
    teardown = srv.close;

    const videoUrl = `${srv.url}/api/img-proxy?url=${encodeURIComponent(
      "https://scontent.cdninstagram.com/reel.mp4",
    )}`;

    const a = await fetch(videoUrl);
    const b = await fetch(videoUrl);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // 3rd .mp4 trips the video bucket.
    const c = await fetch(videoUrl);
    expect(c.status).toBe(429);
    expect(c.headers.get("ratelimit-limit")).toBe("2");
    const body = await c.json();
    expect(body).toEqual({ message: "Too many video requests, please slow down" });
  });

  it("does not charge the video bucket for image (non-mp4) requests", async () => {
    process.env.IMG_PROXY_VIDEO_RATE_MAX = "2";
    process.env.IMG_PROXY_RATE_MAX = "1000";
    const srv = await makeServer({ id: `image-skip-${Date.now()}` });
    teardown = srv.close;

    const imageUrl = `${srv.url}/api/img-proxy?url=${encodeURIComponent(
      "https://scontent.cdninstagram.com/photo.jpg",
    )}`;

    // Many image requests must never trip the (max=2) video bucket because the
    // video limiter skips non-mp4 URLs.
    for (let i = 0; i < 5; i++) {
      const res = await fetch(imageUrl);
      expect(res.status).toBe(200);
    }
  });
});
