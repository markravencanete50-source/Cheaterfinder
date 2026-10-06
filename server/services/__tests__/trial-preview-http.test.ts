import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { createTrialPreviewMiddleware, trialPreviewRoute } from "../trial-preview-http.js";
import { PREVIEW_MEDIA_URL, unwrapPreviewCursor, wrapPreviewCursor } from "../trial-preview.js";

beforeEach(() => vi.stubEnv("SESSION_SECRET", "isolated-http-preview-secret"));
afterEach(() => vi.unstubAllEnvs());

function fixture(preview = true, avatar = false) {
  const deps = { isPreview: vi.fn(async () => preview), isAvatar: vi.fn(async () => avatar),
    sendPlaceholder: vi.fn((res: any) => res.send(PREVIEW_MEDIA_URL)) };
  const middleware = createTrialPreviewMiddleware(deps);
  async function call(path: string, options: { method?: string; query?: any; role?: string; payload?: any; status?: number; authenticated?: boolean } = {}) {
    const req: any = { path, method: options.method ?? "GET", query: options.query ?? {},
      user: options.authenticated === false ? undefined : { id: "customer", role: options.role ?? "user" } };
    const res: any = { locals: {}, statusCode: 200, headers: {}, body: undefined,
      setHeader(key: string, value: string) { this.headers[key] = value; },
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.body = body; return this; }, send(body: any) { this.body = body; return this; } };
    const next = vi.fn((error?: unknown) => {
      if (error) return;
      res.statusCode = options.status ?? 200;
      res.json(options.payload);
    });
    await middleware(req, res, next);
    return { req, res, next };
  }
  return { deps, call };
}

describe("preview HTTP delivery coverage", () => {
  const routes = [
    ["GET", "/api/viewer/target", "viewer"], ["GET", "/api/tracking/accounts", "accounts"],
    ["POST", "/api/tracking/accounts", "account"], ["GET", "/api/tracking/accounts/AccountA/report", "account"],
    ["GET", "/api/tracking/accounts/AccountA/feed", "feed"], ["GET", "/api/tracking/accounts/AccountA/posts", "posts"],
    ["GET", "/api/tracking/accounts/AccountA/followers/roster", "roster"],
    ["GET", "/api/tracking/accounts/AccountA/following/roster", "roster"],
    ["GET", "/api/tracking/posts/ShortCode/likers", "likers"], ["GET", "/api/tracking/posts/ShortCode/comments", "comments"],
    ["GET", "/api/reports", "reports"], ["GET", "/api/notifications", "notifications"],
  ];
  it.each(routes)("covers %s %s including Express case-insensitive routing", (method, path, kind) => {
    expect(trialPreviewRoute(method, path)).toMatchObject({ kind });
    expect(trialPreviewRoute(method, path.toUpperCase() + "/")).toMatchObject({ kind });
  });
  it("keeps captured account identity intact while matching static path case", () => {
    expect(trialPreviewRoute("GET", "/API/Tracking/Accounts/AccountA/Followers/Roster"))
      .toEqual({ kind: "roster", trackedAccountId: "AccountA", dimension: "followers" });
  });
  it.each(["/api/billing/subscription", "/api/admin/reports", "/api/notifications/unread-count", "/api/tracking/accounts/A/access-status"])
    ("does not alter operational/admin endpoint %s", async path => {
      const f = fixture(); const result = await f.call(path, { payload: { count: 7 } });
      expect(f.deps.isPreview).not.toHaveBeenCalled(); expect(result.res.body).toEqual({ count: 7 });
    });
  it("leaves active customer data untouched", async () => {
    const f = fixture(false), payload = { items: [{ username: "actual.person", pfpUrl: "https://real/avatar", count: 70 }] };
    const result = await f.call("/api/tracking/posts/ABC/likers", { payload });
    expect(result.res.body).toBe(payload); expect(result.res.locals.trialPreview).toBeUndefined();
  });
  it("scrubs existing and newly tracked account activity counts", async () => {
    const f = fixture(), account = { id: "A", igUsername: "tracked", displayName: "Tracked", followerCount: 10,
      biography: "private context", externalUrl: "https://context", likeCount: 120, followCount: 6 };
    for (const method of ["GET", "POST"]) {
      const r = await f.call("/api/tracking/accounts", { method, payload: method === "GET" ? [account] : account });
      const row = method === "GET" ? r.res.body[0] : r.res.body;
      expect(row).toMatchObject({ igUsername: "tracked", followerCount: 10, likeCount: null, followCount: null,
        biography: null, externalUrl: null, trialPreview: true });
      expect(r.res.headers["Cache-Control"]).toBe("private, no-store");
    }
  });
  it("preserves ownership/not-found errors", async () => {
    const r = await fixture().call("/api/viewer/other", { status: 404, payload: { message: "Tracked account not found" } });
    expect(r.res.body).toEqual({ message: "Tracked account not found" });
  });
  it("fails closed if current billing cannot be read", async () => {
    const f = fixture(); f.deps.isPreview.mockRejectedValueOnce(new Error("unavailable"));
    const r = await f.call("/api/viewer/target", { payload: { biography: "must not send" } });
    expect(r.res.body).toBeUndefined(); expect(r.next).toHaveBeenCalledWith(expect.any(Error));
  });
  it.each([
    ["POST", "/api/tracking/accounts/A/report/generate"], ["GET", "/api/reports/R/pdf"], ["GET", "/api/reports/R/csv"],
    ["POST", "/API/TRACKING/ACCOUNTS/A/REPORT/GENERATE"], ["HEAD", "/API/REPORTS/R/PDF"],
  ])("blocks report generation/export before any side effects: %s %s", async (method, path) => {
    const r = await fixture().call(path, { method });
    expect(r.next).not.toHaveBeenCalled(); expect(r.res.statusCode).toBe(402);
    expect(r.res.body).toEqual({ code: "trial_preview", message: "Activate subscription to generate reports" });
  });
  it.each(["/api/img-proxy", "/api/media/cache", "/API/IMG-PROXY", "/API/MEDIA/cache"])
    ("serves a placeholder unless the owned current avatar permits %s", async path => {
      const locked = fixture(), allowed = fixture(true, true);
      const blocked = await locked.call(path); const real = await allowed.call(path, { payload: "avatar bytes" });
      expect(blocked.res.body).toBe(PREVIEW_MEDIA_URL); expect(blocked.next).not.toHaveBeenCalled();
      expect(real.res.body).toBe("avatar bytes"); expect(allowed.deps.sendPlaceholder).not.toHaveBeenCalled();
    });
  it("preserves the existing admin media exception", async () => {
    const f = fixture(); const r = await f.call("/api/media/cache", { role: "admin", payload: "admin bytes" });
    expect(r.res.body).toBe("admin bytes"); expect(f.deps.isPreview).not.toHaveBeenCalled();
  });
  it("decrypts scoped roster cursors for querying, encrypts returned continuation, preserves cardinality", async () => {
    const scope = { userId: "customer", trackedAccountId: "A", dimension: "following" as const };
    const raw = "2026-09-20T10:00:00.000Z|actual.person", next = "2026-09-19T09:00:00.000Z|another.person";
    const r = await fixture().call("/api/tracking/accounts/A/following/roster", { query: { cursor: wrapPreviewCursor(raw, scope) },
      payload: { items: [{ username: "actual.person" }], total: 21, limit: 1, hasMore: true, nextCursor: next } });
    expect(r.res.locals.trialPreviewCursor).toBe(raw);
    expect(unwrapPreviewCursor(r.res.body.nextCursor, scope)).toBe(next);
    expect(r.res.body).toMatchObject({ total: 21, limit: 1, hasMore: true });
    expect(r.res.body.items[0].username).toMatch(/^user_/);
    expect(JSON.stringify(r.res.body)).not.toContain("actual.person");
  });
  it.each(["2026-09-20T10:00:00Z|actual.person", "tp1.invalid", ["tp1.invalid"]])("rejects plaintext/malformed/array cursors %j", async cursor => {
    const r = await fixture().call("/api/tracking/accounts/A/followers/roster", { query: { cursor } });
    expect(r.res.statusCode).toBe(400); expect(r.next).not.toHaveBeenCalled();
  });
});

describe("production account report auto-generation side effect", () => {
  const source = readFileSync(new URL("../../routes.ts", import.meta.url), "utf8");
  const start = source.indexOf("  // GET /api/tracking/accounts/:id/report");
  const end = source.indexOf("  // POST /api/tracking/accounts/:id/report/generate", start);
  const code = transformSync(source.slice(start, end), { loader: "ts", format: "cjs" }).code;
  it.each([true, false])("queues only for existing non-preview policy (preview=%s)", async preview => {
    let handler: Function;
    const table = new Proxy({}, { get: (_target, key) => String(key) });
    const rows = [[{ id: "A", igUsername: "tracked", profilePicUrl: null }], [], []];
    const select = vi.fn(() => {
      const data = rows.shift();
      const chain: any = { from: () => chain, where: () => chain, limit: () => chain, orderBy: () => chain,
        then: (resolve: Function) => Promise.resolve(data).then(resolve as any) };
      return chain;
    });
    const insert = vi.fn(() => ({ values: () => ({ returning: async () => [{ id: "new-report" }] }) }));
    const enqueue = vi.fn(async () => undefined), json = vi.fn();
    const ctx = { app: { get: (_path: string, ...handlers: Function[]) => { handler = handlers.at(-1)!; } },
      db: { select, insert }, trackedAccounts: table, profileSnapshots: table, reports: table,
      firstParam: (value: string) => value, isAuthenticated() {}, and() {}, eq() {}, desc() {},
      maybeRevalidateTier1() {}, privateContentUnavailable: () => false,
      reportGenerateQueue: { add: enqueue }, logger: { error: vi.fn() } };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    await handler!({ user: { id: "customer" }, params: { id: "A" } }, { locals: { trialPreview: preview }, json });
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ id: "A", igUsername: "tracked" }));
    expect(insert).toHaveBeenCalledTimes(preview ? 0 : 1);
    expect(enqueue).toHaveBeenCalledTimes(preview ? 0 : 1);
    if (!preview) expect(enqueue).toHaveBeenCalledWith("generate-report", { reportId: "new-report" });
  });
});
