// Execute the production SSE handler and its audience query orchestration.
// Only DB/entitlement/event-bus boundaries are in-memory; no live services.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { ownedRealtimeEvents } from "../services/realtime-events.js";
import { sanitizeTrialPreview } from "../services/trial-preview.js";

const source = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");
function extract(start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw Error("SSE extraction boundary missing");
  return source.slice(from, to);
}
const code = transformSync([
  extract("function privateContentUnavailable(", "// Private engagement uses"),
  extract("  // GET /api/realtime/events", "  // GET /api/config/refresh")
    .replace('await import("./services/realtime-events.js")', "({ subscribeRealtime: globalThis.subscribeRealtime, ownedRealtimeEvents: globalThis.ownedRealtimeEvents })")
    .replace('await import("./services/tracked-account-twins.js")', "({ twinTrackedAccountIdMap: globalThis.twinTrackedAccountIdMap })"),
].join("\n"), { loader: "ts", format: "cjs" }).code;

type Row = { id: string; userId: string; igUserId: string | null; igUsername: string;
  isPrivate: boolean; isActive: boolean; accessStatus: string; paid: boolean };
function fixture() {
  const rows: Row[] = [
    { id: "donor", userId: "alice", igUserId: "123", igUsername: "target", isPrivate: false, isActive: true, accessStatus: "public", paid: true },
    { id: "original", userId: "bob", igUserId: "123", igUsername: "target", isPrivate: false, isActive: true, accessStatus: "public", paid: true },
  ];
  const listeners: Array<(event: any) => Promise<void>> = [];
  let route: Function;
  const select = vi.fn((fields: Record<string, string>) => {
    let predicate = (_row: Row) => true;
    const chain: any = {
      from: () => chain, where: (value: typeof predicate) => { predicate = value; return chain; },
      limit: () => chain,
      then: (resolve: Function, reject: Function) => Promise.resolve(rows.filter(predicate)
        .map(row => Object.fromEntries(Object.entries(fields).map(([name, column]) => [name, row[column as keyof Row]]))))
        .then(resolve as any, reject as any),
    };
    return chain;
  });
  const ctx: any = {
    app: { get: (_path: string, ...handlers: Function[]) => { route = handlers.at(-1)!; } },
    db: { select }, trackedAccounts: new Proxy({}, { get: (_object, field) => String(field) }),
    eq: (field: keyof Row, value: unknown) => (row: Row) => row[field] === value,
    and: (...filters: Array<((row: Row) => boolean) | undefined>) => (row: Row) => filters.filter(Boolean).every(filter => filter!(row)),
    or: (...filters: Array<((row: Row) => boolean) | undefined>) => (row: Row) => filters.filter(Boolean).some(filter => filter!(row)),
    sql: () => (row: Row) => !row.igUserId?.trim(),
    customerAccessSql: () => (row: Row) => row.paid,
    customerHasAccess: vi.fn(async (userId: string) => rows.some(row => row.userId === userId && row.paid)),
    isTrialPreviewUser: vi.fn(async () => false), sanitizeTrialPreview,
    subscribeRealtime: (handler: typeof listeners[number]) => { listeners.push(handler); return vi.fn(); },
    ownedRealtimeEvents,
    twinTrackedAccountIdMap: async (ids: string[]) => new Map(ids.map(id => {
      const anchor = rows.find(row => row.id === id)!;
      return [id, anchor.isPrivate ? [id] : rows.filter(row => !row.isPrivate && row.isActive && row.paid &&
        (anchor.igUserId?.trim() ? row.igUserId === anchor.igUserId : row.igUsername === anchor.igUsername)).map(row => row.id)];
    })),
    isAuthenticated: () => {}, isShuttingDown: () => false, onShutdown: () => () => {},
    setInterval: () => 1, clearInterval: () => {}, logger: { warn: vi.fn() },
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  async function connect(userId = "bob") {
    const chunks: string[] = [];
    const res = { destroyed: false, setHeader() {}, flushHeaders() {}, write: (chunk: string) => chunks.push(chunk), end: vi.fn(), on() {} };
    await route!({ user: { id: userId }, on() {} }, res);
    chunks.length = 0;
    const events = () => chunks.flatMap(chunk => chunk.split("\n")).filter(chunk => chunk.startsWith("data: ")).map(chunk => JSON.parse(chunk.slice(6).trim()));
    return { events, res, clear: () => { chunks.length = 0; } };
  }
  async function emit(id = "donor") {
    const event = { trackedAccountId: id, kind: "posts.added", igUsername: "target", count: 2, at: new Date().toISOString() };
    await Promise.all(listeners.map(listener => listener(event)));
  }
  return { rows, ctx, connect, emit, select };
}

describe("current private SSE access", () => {
  it("preserves refresh routing but scrubs payloads during preview, and reveals after activation", async () => {
    vi.stubEnv("SESSION_SECRET", "fixture-preview-sse-secret");
    const f = fixture(), bob = await f.connect();
    f.ctx.isTrialPreviewUser.mockResolvedValue(true);
    await f.emit();
    expect(bob.events()).toEqual([expect.objectContaining({ trackedAccountId: "original", kind: "posts.added", count: null, trialPreview: true })]);
    expect(bob.events()[0].igUsername).toMatch(/^user_/);
    bob.clear(); f.ctx.isTrialPreviewUser.mockResolvedValue(false); await f.emit();
    expect(bob.events()[0]).toMatchObject({ count: 2, igUsername: "target" });
    vi.unstubAllEnvs();
  });

  it("closes instead of leaking a payload or rejecting when preview lookup fails", async () => {
    const f = fixture(), bob = await f.connect();
    f.ctx.isTrialPreviewUser.mockRejectedValue(new Error("billing unavailable"));
    await expect(f.emit()).resolves.toBeUndefined();
    expect(bob.events()).toEqual([]); expect(bob.res.end).toHaveBeenCalledOnce();
  });

  it("preserves public twin remapping to the recipient's original row", async () => {
    const f = fixture(), bob = await f.connect(); await f.emit();
    expect(bob.events()).toEqual([expect.objectContaining({ trackedAccountId: "original", count: 2 })]);
  });

  it("stops borrowing a donor immediately when that donor becomes private", async () => {
    const f = fixture(), bob = await f.connect(), alice = await f.connect("alice");
    await f.emit(); bob.clear(); alice.clear();
    Object.assign(f.rows[0], { isPrivate: true, accessStatus: "has_access" });
    await f.emit();
    expect(bob.events()).toEqual([]);
    expect(alice.events()).toEqual([expect.objectContaining({ trackedAccountId: "donor" })]);
  });

  it.each(["pending_access", "access_denied"])("suppresses an original private row's events after its grant becomes %s", async accessStatus => {
    const f = fixture(); Object.assign(f.rows[0], { isPrivate: true, accessStatus: "has_access" });
    const alice = await f.connect("alice"); await f.emit(); expect(alice.events()).toHaveLength(1); alice.clear();
    f.rows[0].accessStatus = accessStatus; await f.emit(); expect(alice.events()).toEqual([]);
  });

  it.each(["pending_access", "has_access"])("a recipient that becomes private cannot borrow a public donor even when %s", async accessStatus => {
    const f = fixture(), bob = await f.connect();
    Object.assign(f.rows[1], { isPrivate: true, accessStatus });
    await f.emit(); expect(bob.events()).toEqual([]);
  });

  it.each(["inactive", "ownership-transferred", "deleted"])("suppresses stale recipient mappings when the original is %s", async change => {
    const f = fixture(), bob = await f.connect();
    if (change === "inactive") f.rows[1].isActive = false;
    if (change === "ownership-transferred") f.rows[1].userId = "charlie";
    if (change === "deleted") f.rows.splice(1, 1);
    await f.emit(); expect(bob.events()).toEqual([]);
  });

  it("preserves the live paid gate and closes a revoked subscriber", async () => {
    const f = fixture(), bob = await f.connect(); f.rows[1].paid = false;
    await f.emit(); expect(bob.events()).toEqual([]); expect(bob.res.end).toHaveBeenCalledOnce();
  });

  it("does not reuse an unpaid public donor", async () => {
    const f = fixture(), bob = await f.connect(); f.rows[0].paid = false;
    await f.emit(); expect(bob.events()).toEqual([]);
  });

  it("shares one bounded audience lookup across many subscribers, but never across emissions", async () => {
    const f = fixture(); const subscribers = await Promise.all(Array.from({ length: 25 }, () => f.connect()));
    f.select.mockClear(); await f.emit();
    expect(f.select).toHaveBeenCalledTimes(2);
    for (const subscriber of subscribers) { expect(subscriber.events()).toHaveLength(1); subscriber.clear(); }
    f.rows[0].isPrivate = true; f.rows[0].accessStatus = "pending_access";
    await f.emit(); expect(f.select).toHaveBeenCalledTimes(3);
    for (const subscriber of subscribers) expect(subscriber.events()).toEqual([]);
  });

  it("avoids audience and paid-access database checks for unrelated events", async () => {
    const f = fixture(), bob = await f.connect(); f.select.mockClear(); f.ctx.customerHasAccess.mockClear();
    await f.emit("unrelated"); expect(bob.events()).toEqual([]);
    expect(f.select).not.toHaveBeenCalled(); expect(f.ctx.customerHasAccess).not.toHaveBeenCalled();
  });

  it("fails closed on lookup failure instead of trusting the connection snapshot", async () => {
    const f = fixture(), bob = await f.connect();
    f.select.mockImplementationOnce(() => { throw Error("fixture DB unavailable"); });
    await f.emit(); expect(bob.events()).toEqual([]); expect(f.ctx.logger.warn).toHaveBeenCalledOnce();
  });

  it("preserves username fallback only while the recipient has no resolved IG ID", async () => {
    const f = fixture(); f.rows[1].igUserId = null; const bob = await f.connect();
    await f.emit(); expect(bob.events()).toHaveLength(1); bob.clear();
    f.rows[1].igUserId = "different-account";
    await f.emit(); expect(bob.events()).toEqual([]);
  });
});
