// Synthetic rows in the designated scratch database only. No provider requests.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitMobileRevalidation, readMobileRevalidationBot } from "../mobile-session-revalidation.js";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  if (new URL(url).pathname !== "/cheaterfinder_backend_fix_test_20260907") throw new Error("Refusing recovery tests outside the designated scratch database");
  process.env.DATABASE_URL = url;
}

(url ? describe : describe.skip)("mobile revalidation persistence against real PostgreSQL", () => {
  let db: typeof import("../../db.js").db;
  let pool: typeof import("../../db.js").pool;
  let leases: typeof import("../operation-lease.js");
  const ids: string[] = [];
  const proxy = "http://fixture:fixture@proxy.example.invalid:10000";
  const past = new Date(Date.now() - 3_600_000);

  beforeAll(async () => {
    ({ db, pool } = await import("../../db.js"));
    leases = await import("../operation-lease.js");
  });
  afterAll(async () => {
    if (!db) return;
    for (const id of ids) {
      await db.execute(sql`DELETE FROM backend_operation_leases WHERE key = ${`bot:${id}`}`);
      await db.execute(sql`DELETE FROM bot_accounts WHERE id = ${id}`);
    }
    await pool.end();
  });

  async function seed() {
    const id = randomUUID();
    ids.push(id);
    await db.execute(sql`
      INSERT INTO bot_accounts (id, ig_username, ig_user_id, session_data, proxy_url, transport,
        tier, role, status, cooldown_until, last_login_error, consecutive_hard_failures,
        last_hard_failure_at, login_attempt_count, last_login_at, daily_profile_views_used)
      VALUES (${id}, ${`revalidation_fixture_${id}`}, '123456789', 'v1:synthetic-encrypted-session', ${proxy},
        'mobile', 'worker', 'scraper', 'session_expired', ${past}, ' ', 4, ${past}, 7, ${past}, 9)
    `);
    const snapshot = await readMobileRevalidationBot(db, id);
    expect(snapshot).not.toBeNull();
    return snapshot!;
  }

  async function state(id: string) {
    return leases.resultRows<Record<string, unknown>>(await db.execute(sql`
      SELECT status, consecutive_hard_failures, last_hard_failure_at, session_data, proxy_url,
        ig_user_id, cooldown_until, last_login_error, login_attempt_count, last_login_at, daily_profile_views_used
      FROM bot_accounts WHERE id = ${id}
    `))[0];
  }

  it("only changes availability and the hard-failure streak after a fenced proof", async () => {
    const snapshot = await seed();
    expect(snapshot).toMatchObject({ proxyUrl: proxy, cooldownUntil: past, hasAutomationIdentity: false });
    const before = await state(snapshot.id);
    const changed = await leases.withOperationLease(`bot:${snapshot.id}`, async (_signal, guard) => commitMobileRevalidation(db, snapshot, guard));
    expect(changed).toBe(true);
    expect(await state(snapshot.id)).toEqual({ ...before, status: "available", consecutive_hard_failures: 0, last_hard_failure_at: null });
  });

  it("does not overwrite a new cooldown or challenge while the request is in flight", async () => {
    const snapshot = await seed();
    const until = new Date(Date.now() + 3_600_000);
    const changed = await leases.withOperationLease(`bot:${snapshot.id}`, async (_signal, guard) => {
      await db.execute(sql`UPDATE bot_accounts SET cooldown_until = ${until}, last_login_error = 'challenge_required' WHERE id = ${snapshot.id}`);
      return commitMobileRevalidation(db, snapshot, guard);
    });
    expect(changed).toBe(false);
    const after = await state(snapshot.id);
    expect(after).toMatchObject({ status: "session_expired", consecutive_hard_failures: 4, last_login_error: "challenge_required" });
    expect(new Date(String(after.cooldown_until))).toEqual(until);
  });

  it("fences an unrelated edit even when identity and eligibility remain unchanged", async () => {
    const snapshot = await seed();
    const changed = await leases.withOperationLease(`bot:${snapshot.id}`, async (_signal, guard) => {
      await db.execute(sql`UPDATE bot_accounts SET login_attempt_count = login_attempt_count + 1 WHERE id = ${snapshot.id}`);
      return commitMobileRevalidation(db, snapshot, guard);
    });
    expect(changed).toBe(false);
    expect(await state(snapshot.id)).toMatchObject({ status: "session_expired", consecutive_hard_failures: 4, login_attempt_count: 8 });
  });

  it("fences a concurrent saved-session replacement", async () => {
    const snapshot = await seed();
    const changed = await leases.withOperationLease(`bot:${snapshot.id}`, async (_signal, guard) => {
      await db.execute(sql`UPDATE bot_accounts SET session_data = 'v1:new-fixture-session' WHERE id = ${snapshot.id}`);
      return commitMobileRevalidation(db, snapshot, guard);
    });
    expect(changed).toBe(false);
    expect(await state(snapshot.id)).toMatchObject({ status: "session_expired", consecutive_hard_failures: 4, session_data: "v1:new-fixture-session" });
  });

  it.each(["banned", "disabled", "available"])("never reactivates a %s snapshot even if passed directly to persistence", async status => {
    const original = await seed();
    await db.execute(sql`UPDATE bot_accounts SET status = ${status}::bot_status WHERE id = ${original.id}`);
    const snapshot = (await readMobileRevalidationBot(db, original.id))!;
    const changed = await leases.withOperationLease(`bot:${snapshot.id}`, async (_signal, guard) => commitMobileRevalidation(db, snapshot, guard));
    expect(changed).toBe(false);
    expect(await state(snapshot.id)).toMatchObject({ status, consecutive_hard_failures: 4 });
  });

  it("cannot write after another owner takes over the lease", async () => {
    const snapshot = await seed();
    const before = await state(snapshot.id);
    await expect(leases.withOperationLease(`bot:${snapshot.id}`, async (_signal, guard) => {
      await db.execute(sql`UPDATE backend_operation_leases SET token = 'fixture-successor' WHERE key = ${`bot:${snapshot.id}`}`);
      return commitMobileRevalidation(db, snapshot, guard);
    })).rejects.toThrow("lease_lost");
    expect(await state(snapshot.id)).toEqual(before);
  });

  it("cannot write after the ownership lease expires", async () => {
    const snapshot = await seed();
    const before = await state(snapshot.id);
    await expect(leases.withOperationLease(`bot:${snapshot.id}`, async (_signal, guard) => {
      await db.execute(sql`UPDATE backend_operation_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE key = ${`bot:${snapshot.id}`}`);
      return commitMobileRevalidation(db, snapshot, guard);
    })).rejects.toThrow("lease_lost");
    expect(await state(snapshot.id)).toEqual(before);
  });
});
