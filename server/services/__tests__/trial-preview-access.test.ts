import { createHash } from "node:crypto";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("../../db.js", () => ({ db: { select: f.select } }));
// Keep cache/network/background workers out of this focused authorization test.
vi.mock("../media-cache.js", async () => {
  const { createHash } = await import("node:crypto");
  return { mediaCacheKey: (url: string) => createHash("sha256").update(new URL(url).pathname).digest("hex") };
});
import { isPermittedPreviewAvatar, isTrialPreviewUser } from "../trial-preview-access.js";

const urls = {
  account: "https://cdninstagram.com/account-avatar.jpg?signature=current",
  latest: "https://cdninstagram.com/latest-avatar.jpg?signature=current",
  hd: "https://cdninstagram.com/latest-avatar-hd.jpg?signature=current",
  old: "https://cdninstagram.com/historical-avatar.jpg?signature=old",
  foreign: "https://cdninstagram.com/foreign-avatar.jpg",
  inactive: "https://cdninstagram.com/inactive-avatar.jpg",
  second: "https://cdninstagram.com/second-account-avatar.jpg",
  tool: "https://cdninstagram.com/post-image.jpg",
};
const cacheKey = (url: string) => createHash("sha256").update(new URL(url).pathname).digest("hex");
const proxy = (url: unknown, extra: Record<string, unknown> = {}, path = "/api/img-proxy") =>
  ({ path, query: { url, ...extra } } as unknown as Request);
const cached = (url: string, accountId: unknown = "account-a", pathPrefix = "/api/media/") =>
  ({ path: `${pathPrefix}${cacheKey(url)}`, query: { trackedAccountId: accountId, sig: "downstream-validates-this" } } as unknown as Request);

type Row = Record<string, any>;
let rows: Record<string, Row[]>;
let queries: Array<{ table: string; sql: string; params: unknown[] }>;
beforeEach(() => {
  vi.resetAllMocks();
  queries = [];
  rows = {
    subscriptions: [{ userId: "customer-b", status: "trialing" }, { userId: "customer-a", status: "active" }],
    tracked_accounts: [
      { id: "foreign-account", userId: "customer-b", isActive: true, profilePicUrl: urls.foreign },
      { id: "inactive-account", userId: "customer-a", isActive: false, profilePicUrl: urls.inactive },
      { id: "account-a", userId: "customer-a", isActive: true, profilePicUrl: urls.account, isPrivate: false },
      { id: "account-b", userId: "customer-a", isActive: true, profilePicUrl: urls.second },
    ],
    profile_snapshots: [
      { trackedAccountId: "account-a", profilePicUrl: urls.old, profilePicUrlHd: null, snapshotAt: new Date("2026-09-01") },
      { trackedAccountId: "foreign-account", profilePicUrl: urls.foreign, profilePicUrlHd: null, snapshotAt: new Date("2026-09-28") },
      { trackedAccountId: "account-a", profilePicUrl: urls.latest, profilePicUrlHd: urls.hd, snapshotAt: new Date("2026-09-27") },
    ],
  };
  const camel = (name: string) => name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
  const dialect = new PgDialect();
  f.select.mockImplementation((fields: Record<string, unknown>) => {
    let tableName = "", condition: any, order: any, limit = Infinity;
    const chain: any = {
      from(table: any) { tableName = getTableName(table); return chain; },
      where(sql: any) { condition = sql; return chain; },
      orderBy(sql: any) { order = sql; return chain; },
      limit(value: number) { limit = value; return chain; },
      then(resolve: Function, reject: Function) {
        // This small fixture evaluates equality predicates from the real
        // generated Drizzle SQL: removing ownership/active/account scope in
        // production also removes that filter here and exposes the fixture.
        const query = dialect.sqlToQuery(condition);
        queries.push({ table: tableName, sql: query.sql, params: query.params });
        const equalities = [...query.sql.matchAll(/"[^"]+"\."([^"]+)" = \$(\d+)/g)];
        let selected = rows[tableName].filter(row => equalities.every(([, column, parameter]) =>
          row[camel(column)] === query.params[Number(parameter) - 1]));
        if (order) {
          const ordering = dialect.sqlToQuery(order).sql;
          if (ordering.includes('"snapshot_at"') && /desc/i.test(ordering)) {
            selected = [...selected].sort((a, b) => b.snapshotAt.getTime() - a.snapshotAt.getTime());
          }
        }
        return Promise.resolve(selected.slice(0, limit).map(row =>
          Object.fromEntries(Object.keys(fields).map(field => [field, row[field]])))).then(resolve as any, reject as any);
      },
    };
    return chain;
  });
});

describe("current trial preview lookup", () => {
  it.each(["trialing", "active", "past_due", "canceled"])("reads only the requested customer's %s subscription", async status => {
    rows.subscriptions[1].status = status;
    expect(await isTrialPreviewUser("customer-a")).toBe(status === "trialing");
    expect(queries[0].sql).toContain('"subscriptions"."user_id"');
    expect(queries[0].params).toEqual(["customer-a"]);
  });

  it("does not mistake another customer's trial for missing local billing", async () => {
    rows.subscriptions = [rows.subscriptions[0]];
    expect(await isTrialPreviewUser("customer-a")).toBe(false);
  });

  it("propagates a failed billing read so callers can fail closed", async () => {
    f.select.mockImplementationOnce(() => { throw new Error("database offline"); });
    await expect(isTrialPreviewUser("customer-a")).rejects.toThrow("database offline");
  });
});

describe("owned current profile avatar preview exception", () => {
  it.each(["account", "latest", "hd"] as const)("permits the %s avatar from an owned active profile through the image proxy", async key => {
    expect(await isPermittedPreviewAvatar("customer-a", proxy(urls[key]))).toBe(true);
    expect(queries[0].sql).toContain('"tracked_accounts"."user_id"');
    expect(queries[0].sql).toContain('"tracked_accounts"."is_active"');
    expect(queries[0].params).toEqual(["customer-a", true]);
    expect(queries.filter(query => query.table === "profile_snapshots").every(query =>
      query.params[0] === "account-a" || query.params[0] === "account-b")).toBe(true);
  });

  it.each(["account", "latest", "hd"] as const)("recognizes the %s cached avatar only for its original account scope", async key => {
    expect(await isPermittedPreviewAvatar("customer-a", cached(urls[key]))).toBe(true);
    expect(queries[0].params).toEqual(["customer-a", true, "account-a"]);
    expect(await isPermittedPreviewAvatar("customer-a", cached(urls[key], "account-b"))).toBe(false);
  });

  it.each(["foreign", "inactive", "old", "tool"] as const)("rejects %s media even when the caller labels it as profile content", async key => {
    const request = proxy(urls[key], { profile: "true", isProfile: "1", purpose: "avatar", userId: "customer-b", trackedAccountId: "foreign-account" });
    expect(await isPermittedPreviewAvatar("customer-a", request)).toBe(false);
    expect(await isPermittedPreviewAvatar("customer-a", cached(urls[key], key === "foreign" ? "foreign-account" : "account-a"))).toBe(false);
  });

  it("accepts mixed-case static route segments without changing the account/key identity", async () => {
    expect(await isPermittedPreviewAvatar("customer-a", proxy(urls.latest, {}, "/API/IMG-Proxy"))).toBe(true);
    expect(await isPermittedPreviewAvatar("customer-a", cached(urls.latest, "account-a", "/API/MeDiA/"))).toBe(true);
    expect(await isPermittedPreviewAvatar("customer-a", cached(urls.latest, "ACCOUNT-A", "/API/MEDIA/"))).toBe(false);
  });

  it("requires an exact stored upstream URL rather than a matching path or a claimed avatar URL", async () => {
    expect(await isPermittedPreviewAvatar("customer-a", proxy(urls.account.replace("signature=current", "signature=changed")))).toBe(false);
    expect(await isPermittedPreviewAvatar("customer-a", proxy(urls.account.replace("cdninstagram.com", "attacker.example")))).toBe(false);
    expect(await isPermittedPreviewAvatar("customer-a", proxy(urls.tool, { profilePicUrl: urls.account }))).toBe(false);
  });

  it("uses only the most recent snapshot; historical avatars do not grant an exception", async () => {
    expect(await isPermittedPreviewAvatar("customer-a", proxy(urls.old))).toBe(false);
    expect(await isPermittedPreviewAvatar("customer-a", cached(urls.old))).toBe(false);
    expect(await isPermittedPreviewAvatar("customer-a", proxy(urls.latest))).toBe(true);
  });

  it("allows public avatar metadata while a private account awaits access", async () => {
    Object.assign(rows.tracked_accounts[2], { isPrivate: true, accessStatus: "pending_access" });
    expect(await isPermittedPreviewAvatar("customer-a", proxy(urls.account))).toBe(true);
    expect(await isPermittedPreviewAvatar("customer-a", proxy(urls.tool))).toBe(false);
    // Content permissions and signed-cache authorization remain downstream;
    // this predicate only classifies the public profile avatar exception.
  });

  it("rejects malformed cache keys and missing/multivalued query inputs without reading the database", async () => {
    const requests = [
      { path: "/api/media/not-a-key", query: { trackedAccountId: "account-a" } },
      { path: `/api/media/${cacheKey(urls.account)}`, query: {} },
      cached(urls.account, ["account-a"]), proxy(undefined), proxy([urls.account]),
    ];
    for (const request of requests) expect(await isPermittedPreviewAvatar("customer-a", request as Request)).toBe(false);
    expect(f.select).not.toHaveBeenCalled();
  });

  it("propagates lookup failure instead of classifying arbitrary media as an avatar", async () => {
    f.select.mockImplementationOnce(() => { throw new Error("database offline"); });
    await expect(isPermittedPreviewAvatar("customer-a", proxy(urls.tool))).rejects.toThrow("database offline");
  });
});
