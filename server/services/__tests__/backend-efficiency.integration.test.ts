// Schema-only scratch database, never the production database. No Instagram,
// Stripe, push, or Redis calls are made by these integration tests.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  if (new URL(url).pathname !== "/cheaterfinder_backend_fix_test_20260907") {
    throw new Error("Refusing integration tests outside the designated scratch database");
  }
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET = "backend-integration-test-only";
}
vi.mock("../push-notifications.js", () => ({ sendPushToUser: vi.fn(async () => {}) }));

(url ? describe : describe.skip)("backend safety against real Postgres", () => {
  let db: typeof import("../../db.js").db;
  let pool: typeof import("../../db.js").pool;
  let leases: typeof import("../operation-lease.js");
  let sessions: typeof import("../mobile-session-store.js");
  let auth: typeof import("../../mobile-auth.js").__testing;
  let refresh: typeof import("../interactive-refresh.js").refreshEngagementOnce;
  let stripe: typeof import("../stripe-webhook-safety.js");
  let user: typeof import("../../../shared/schema.js").User;
  const id = randomUUID();
  const prefix = `efficiency-test:${id}`;

  beforeAll(async () => {
    ({ db, pool } = await import("../../db.js"));
    leases = await import("../operation-lease.js");
    sessions = await import("../mobile-session-store.js");
    ({ __testing: auth } = await import("../../mobile-auth.js"));
    ({ refreshEngagementOnce: refresh } = await import("../interactive-refresh.js"));
    stripe = await import("../stripe-webhook-safety.js");
    const { users } = await import("../../../shared/schema.js");
    [user] = await db.insert(users).values({ id, email: `${id}@example.invalid`, name: "Safety test", hashedPassword: "test-hash" }).returning();
  });
  afterAll(async () => {
    if (!db) return;
    await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    await db.execute(sql`DELETE FROM interactive_refresh_state WHERE media_id LIKE ${prefix + "%"}`);
    await db.execute(sql`DELETE FROM stripe_webhook_events WHERE id LIKE ${prefix + "%"}`);
    await db.execute(sql`DELETE FROM backend_operation_leases WHERE key LIKE ${prefix + "%"}`);
    await pool.end();
  });

  it("executes and EXPLAINs every real lease query, including pinned/qualified viewers", async () => {
    const { buildLeaseCandidateQuery, PRODUCTION_LEASE_LABELS } = await import("../../ig-public-scraper.js");
    const options = PRODUCTION_LEASE_LABELS.map(label => ({ label }));
    for (const opts of [...options,
      { label: "likers" as const, viewer: { pin: true, botId: id } },
      { label: "likers" as const, viewer: { pin: true, roles: ["feed_watcher" as const], targetUsername: "test_target" } },
    ]) {
      const query = buildLeaseCandidateQuery(db, opts).toSQL();
      await pool.query(`EXPLAIN ${query.sql}`, query.params);
      const selected = (await pool.query(query.sql, query.params)).rows;
      // This reusable scratch DB may contain diagnostics' synthetic bot rows.
      // Query validity must not depend on the entire database being empty.
      expect(selected.length).toBeLessThanOrEqual(1);
      if ("viewer" in opts && "botId" in opts.viewer) expect(selected).toEqual([]);
    }
  });

  it("admits only one owner and releases ownership after work", async () => {
    const key = `${prefix}:concurrent`;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const first = leases.withOperationLease(key, async () => { entered(); await gate; return 1; });
    await ready;
    try {
      await expect(leases.withOperationLease(key, async () => 2)).rejects.toBeInstanceOf(leases.OperationBusyError);
    } finally { release(); }
    expect(await first).toBe(1);
    expect(await leases.withOperationLease(key, async () => 3)).toBe(3);
  });

  it("cannot release a newer owner's token", async () => {
    const key = `${prefix}:fencing`;
    await leases.withOperationLease(key, async () => {
      await db.execute(sql`UPDATE backend_operation_leases SET token = 'successor' WHERE key = ${key}`);
    });
    expect(leases.resultRows<{ token: string }>(await db.execute(sql`SELECT token FROM backend_operation_leases WHERE key = ${key}`))[0].token).toBe("successor");
  });

  it("treats successful empty/unchanged reads as fresh and leaves failures due", async () => {
    const success = vi.fn(async () => true);
    await refresh(`${prefix}:empty`, "likers", success);
    await refresh(`${prefix}:empty`, "likers", success);
    expect(success).toHaveBeenCalledTimes(1);
    const failed = vi.fn(async () => false);
    await refresh(`${prefix}:failed`, "comments", failed);
    await refresh(`${prefix}:failed`, "comments", failed);
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping interactive refreshes without another network callback", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { entered = r; });
    const callback = vi.fn(async () => { entered(); await gate; return true; });
    const first = refresh(`${prefix}:overlap`, "likers", callback);
    await ready;
    try { await refresh(`${prefix}:overlap`, "likers", callback); }
    finally { release(); }
    await first;
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("rotates refresh tokens once, and revokes newly issued access on replay", async () => {
    const initial = await auth.issueTokenPair(user);
    expect((await auth.resolveUser(initial.accessToken, "access"))?.id).toBe(id);
    const claims = auth.verifyToken(initial.refreshToken)!;
    const next = await auth.rotateTokenPair(user, claims);
    expect(next).not.toBeNull();
    expect((await auth.resolveUser(next!.accessToken, "access"))?.id).toBe(id);
    expect(await auth.rotateTokenPair(user, claims)).toBeNull();
    expect(await auth.resolveUser(next!.accessToken, "access")).toBeNull();
    expect(await auth.resolveUser(next!.refreshToken, "refresh")).toBeNull();
  });

  it("logout revocation invalidates access AND refresh, not other devices", async () => {
    const device = await auth.issueTokenPair(user);
    const other = await auth.issueTokenPair(user);
    const claims = auth.verifyToken(device.accessToken)!;
    await sessions.revokeMobileSession(claims.sid!, id);
    expect(await auth.resolveUser(device.accessToken, "access")).toBeNull();
    expect(await auth.resolveUser(device.refreshToken, "refresh")).toBeNull();
    expect((await auth.resolveUser(other.accessToken, "access"))?.id).toBe(id);
  });

  it("migrates old tokens without deployment logout; replay also revokes legacy access", async () => {
    const now = Math.floor(Date.now() / 1000);
    const base = { sub: id, pv: auth.passwordVersion(user.hashedPassword), iat: now, exp: now + 3600, jti: randomUUID() };
    const oldAccess = auth.signToken({ ...base, typ: "access" });
    const oldRefresh = auth.signToken({ ...base, typ: "refresh", jti: randomUUID() });
    expect((await auth.resolveUser(oldAccess, "access"))?.id).toBe(id);
    const claims = auth.verifyToken(oldRefresh)!;
    const next = await auth.rotateTokenPair(user, claims);
    expect(next).not.toBeNull();
    expect((await auth.resolveUser(next!.accessToken, "access"))?.id).toBe(id);
    expect(await auth.rotateTokenPair(user, claims)).toBeNull();
    expect(await auth.resolveUser(oldAccess, "access")).toBeNull();
    expect(await auth.resolveUser(next!.accessToken, "access")).toBeNull();
  });

  it("records completed Stripe events once and retries failed handlers", async () => {
    const event = { id: `${prefix}:stripe`, type: "invoice.paid" as const };
    const work = vi.fn(async () => {});
    await stripe.processStripeEventOnce(event, prefix, work);
    await stripe.processStripeEventOnce(event, prefix, work);
    expect(work).toHaveBeenCalledTimes(1);
    const retry = { ...event, id: `${prefix}:stripe-retry` };
    await expect(stripe.processStripeEventOnce(retry, prefix, async () => { throw new Error("retry me"); })).rejects.toThrow("retry me");
    await stripe.processStripeEventOnce(retry, prefix, work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("deduplicates notification rows even across concurrent event retries", async () => {
    const { createNotification } = await import("../notifications.js");
    const input = { userId: id, type: "payment_failed" as const, title: "Test", body: "Test", dedupeKey: `${prefix}:notification` };
    await Promise.all([createNotification(input), createNotification(input)]);
    expect(leases.resultRows(await db.execute(sql`SELECT id FROM notifications WHERE dedupe_key = ${input.dedupeKey}`))).toHaveLength(1);
  });
});
