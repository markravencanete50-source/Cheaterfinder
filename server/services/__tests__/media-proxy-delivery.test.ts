import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterAll, describe, expect, it, vi } from "vitest";

// Execute the production handlers without starting the app's queues, providers
// or database. Every upstream response below is local fixture data.
const source = readFileSync(new URL("../../routes.ts", import.meta.url), "utf8");
const gateSource = source.slice(source.indexOf('  app.use(["/api/tracking"'), source.indexOf('  app.get("/api/health"'));
const proxySource = source.slice(source.indexOf('  app.get(\n    "/api/img-proxy",'), source.indexOf('  // GET /api/viewer/:username'));
const cacheSource = source.slice(source.indexOf("function imageCacheKey("), source.indexOf("async function fetchMediaThroughGateway("));
const log = { warn: vi.fn(), error: vi.fn() };
function execute(code: string, context: any) {
  vm.createContext(context);
  vm.runInContext(transformSync(code, { loader: "ts", format: "cjs" }).code, context);
}
function response() {
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; });
  const res: any = { statusCode: 200, headersSent: false, destroyed: false, headers: {} };
  res.set = res.setHeader = (key: string, value: string) => { res.headers[key] = value; return res; };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.send = res.json = (body: any) => { res.body = body; res.headersSent = true; resolve(); return res; };
  res.end = () => { res.headersSent = true; resolve(); return res; };
  return { res, done };
}

describe("production media entitlement boundary", () => {
  const cases = [
    ["admin", "/api/img-proxy", "GET", true], ["admin", "/api/media", "HEAD", true],
    ["admin", "/api/tracking", "GET", false], ["admin", "/api/reports", "GET", false],
    ["admin", "/api/img-proxy", "POST", false], ["user", "/api/img-proxy", "GET", false],
    ["user", "/api/media", "GET", false],
  ] as const;
  it.each(cases)("%s %s %s bypasses only an admin media read: %s", async (role, baseUrl, method, allowed) => {
    let gate: any; const auth = vi.fn(); const access = vi.fn().mockResolvedValue(false);
    const ctx = { app: { use: (_paths: any, first: any, handler: any) => { expect(first).toBe(auth); gate = handler; } }, isAuthenticated: auth, customerHasAccess: access };
    execute(gateSource, ctx); const { res } = response(); const next = vi.fn();
    await gate({ user: { id: "fixture", role }, baseUrl, method }, res, next);
    expect(next).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(access).toHaveBeenCalledTimes(allowed ? 0 : 1);
    if (!allowed) expect(res.statusCode).toBe(402);
  });
});

function proxyFixture(mode = "complete", role = "user") {
  let handler: any; const resFixture = response();
  const upstream = new EventEmitter() as any;
  upstream.statusCode = mode === "expired" ? 403 : 200;
  upstream.headers = { "content-type": "image/png", "content-length": "4" };
  upstream.resume = vi.fn();
  const request = new EventEmitter() as any;
  request.setTimeout = vi.fn(); request.destroy = vi.fn();
  const ctx: any = {
    Buffer, URL, String, Number,
    app: { get: (_path: string, ...handlers: any[]) => { handler = handlers.at(-1); } },
    isAuthenticated: vi.fn(), videoProxyLimiter: vi.fn(), galleryProxyLimiter: vi.fn(),
    mediaCacheKey: vi.fn().mockReturnValue("fixture-key"),
    readCachedMediaAsset: vi.fn().mockResolvedValue(null), readCachedImage: vi.fn().mockResolvedValue(null),
    writeCachedImage: vi.fn().mockResolvedValue(undefined), maybeSweepImgCache: vi.fn(), imageCacheDir: "/unused",
    logger: log, fetchMediaThroughGateway: vi.fn().mockResolvedValue(null), isPrivateOrReservedIp: vi.fn().mockReturnValue(false),
    dns: { promises: { lookup: vi.fn().mockResolvedValue({ address: "8.8.8.8" }) } },
    https: { get: vi.fn((_url: string, _opts: any, callback: any) => {
      queueMicrotask(() => {
        callback(upstream);
        if (mode === "aborted") { upstream.emit("aborted"); upstream.emit("error", new Error("socket reset")); return; }
        if (mode !== "empty") upstream.emit("data", Buffer.from(mode === "truncated" ? "PN" : "PNGF"));
        upstream.emit("end");
      }); return request;
    }) },
    sendMediaProxyFallback: (res: any, status = 204) => { if (!res.headersSent && !res.destroyed) res.status(status).end(); },
  };
  execute(proxySource, ctx);
  return { ctx, request, ...resFixture, run: async (url = "https://scontent.cdninstagram.com/fixture.png?expired=1") => {
    await handler({ query: { url }, user: { id: "fixture", role } }, resFixture.res);
    await resFixture.done;
  } };
}
describe("production image proxy cache and response handling", () => {
  it("serves admin history from durable cache before expired CDN or DNS access", async () => {
    const t = proxyFixture("expired", "admin");
    t.ctx.readCachedMediaAsset.mockResolvedValue({ body: Buffer.from("PNGF"), contentType: "image/png", byteSize: 4 });
    await t.run(); expect(t.res.statusCode).toBe(200); expect(t.res.body).toEqual(Buffer.from("PNGF"));
    expect(t.ctx.readCachedMediaAsset).toHaveBeenCalledExactlyOnceWith("fixture-key", { repairMissing: false });
    expect(t.ctx.dns.promises.lookup).not.toHaveBeenCalled(); expect(t.ctx.https.get).not.toHaveBeenCalled();
    expect(t.res.headers["Cache-Control"]).toBe("private, no-store");
  });
  it("does not give customers unsigned durable-cache access from a remembered CDN URL", async () => {
    const t = proxyFixture(); await t.run(); expect(t.ctx.readCachedMediaAsset).not.toHaveBeenCalled();
    expect(t.res.body).toEqual(Buffer.from("PNGF"));
  });
  it.each(["empty", "truncated", "aborted", "expired"])("never caches a %s upstream response", async mode => {
    const t = proxyFixture(mode); await t.run(); expect(t.res.statusCode).toBe(204);
    expect(t.ctx.writeCachedImage).not.toHaveBeenCalled();
  });
  it("caches a complete media response", async () => {
    const t = proxyFixture(); await t.run(); expect(t.res.statusCode).toBe(200);
    expect(t.ctx.writeCachedImage).toHaveBeenCalledWith(expect.any(String), Buffer.from("PNGF"), "image/png");
  });
  it("keeps the host allowlist before admin durable-cache lookup", async () => {
    const t = proxyFixture("complete", "admin"); await t.run("https://example.invalid/fixture.png");
    expect(t.res.statusCode).toBe(400); expect(t.ctx.readCachedMediaAsset).not.toHaveBeenCalled();
    expect(t.ctx.https.get).not.toHaveBeenCalled();
  });
});

const dir = await fsp.mkdtemp("/tmp/media-proxy-integrity-");
afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });
function cacheFixture() {
  const ctx: any = { createHash, randomUUID, fsp, path, Date, JSON, Promise, imageCacheDir: dir, imageCacheMaxAgeMs: 30 * 86400000, logger: log };
  execute(cacheSource, ctx); return ctx;
}
describe("production flat image cache integrity", () => {
  it("writes complete files atomically with size metadata", async () => {
    const ctx = cacheFixture(), url = "https://scontent.cdninstagram.com/complete.png";
    await ctx.writeCachedImage(url, Buffer.from("PNGF"), "image/png");
    expect(await ctx.readCachedImage(url)).toEqual({ body: Buffer.from("PNGF"), contentType: "image/png" });
    expect(JSON.parse(await fsp.readFile(ctx.imageCachePaths(url).meta, "utf8")).byteSize).toBe(4);
    expect((await fsp.readdir(dir)).some(name => name.endsWith(".tmp"))).toBe(false);
  });
  it.each(["empty", "truncated", "html"])("ignores a %s cached file", async kind => {
    const ctx = cacheFixture(), url = "https://scontent.cdninstagram.com/" + kind + ".png";
    const files = ctx.imageCachePaths(url);
    await fsp.writeFile(files.body, kind === "empty" ? "" : "PN");
    await fsp.writeFile(files.meta, JSON.stringify({ contentType: kind === "html" ? "text/html" : "image/png", byteSize: 4 }));
    expect(await ctx.readCachedImage(url)).toBeNull();
  });
  it("continues reading intact legacy files that predate size metadata", async () => {
    const ctx = cacheFixture(), url = "https://scontent.cdninstagram.com/legacy.png";
    const files = ctx.imageCachePaths(url);
    await fsp.writeFile(files.body, "PNGF"); await fsp.writeFile(files.meta, JSON.stringify({ contentType: "image/png" }));
    expect((await ctx.readCachedImage(url)).body).toEqual(Buffer.from("PNGF"));
  });
});

describe("production video gateway integrity", () => {
  const start = source.indexOf("async function fetchMediaThroughGateway(");
  const end = source.indexOf("\nfunction ", start);
  const gatewaySource = source.slice(start, end).replace('await import("undici")', 'await loadUndici()');
  function gateway(body: string, expectedSize = "4", encoding: string | null = null) {
    const fetch = vi.fn().mockResolvedValue({ ok: true, headers: { get: (name: string) => name === "content-type" ? "video/mp4" : name === "content-length" ? expectedSize : encoding },
      arrayBuffer: async () => Buffer.from(body) });
    const ctx: any = { process: { env: { PROXY_GATEWAY_HOST: "fixture.invalid" } }, Buffer, String, Number, AbortSignal,
      fetchEndpoints: vi.fn().mockResolvedValue([{ endpoint: "fixture-endpoint" }]), proxyAgentUriForEndpoint: () => "fixture-proxy", logger: log,
      loadUndici: async () => ({ ProxyAgent: class {}, fetch }) };
    execute(gatewaySource, ctx); return { fetch, run: () => ctx.fetchMediaThroughGateway("https://scontent.cdninstagram.com/fixture.mp4", 25) };
  }
  it("does not follow CDN redirects away from the validated host", async () => {
    const t = gateway("MP4F"); expect(await t.run()).toEqual({ body: Buffer.from("MP4F"), contentType: "video/mp4" });
    expect(t.fetch.mock.calls[0][1].redirect).toBe("error");
  });
  it.each(["", "MP"])("rejects an empty/truncated gateway response (%s)", async body => {
    expect(await gateway(body).run()).toBeNull();
  });
  it("does not compare compressed wire length with Undici-decoded media bytes", async () => {
    expect(await gateway("MP4F", "20", "gzip").run()).toMatchObject({ body: Buffer.from("MP4F") });
  });
});
