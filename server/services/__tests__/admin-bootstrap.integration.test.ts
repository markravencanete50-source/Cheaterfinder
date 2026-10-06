import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" ||
      !["127.0.0.1", "localhost"].includes(parsed.hostname) || (parsed.port !== "55439" && !(process.env.STRESS_NONCE && parsed.port !== "5432" && (process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(parsed.port)))) {
    throw new Error("Isolated admin audit database required");
  }
  process.env.DATABASE_URL = url;
}

// Run this settings-mutating suite without parallel test files. It refuses any
// pre-existing admin and restores the scratch database's prior marker afterward.
(url ? describe : describe.skip)("durable admin bootstrap — isolated PostgreSQL", () => {
  let pool: typeof import("../../db.js").pool;
  let bootstrap: typeof import("../../auth.js").bootstrapAdminRole;
  let ownsState = false;
  let prior: { value: unknown; updated_by: string | null; updated_at: Date } | undefined;
  const key = "auth.adminBootstrapCompleted";
  const ids = [randomUUID(), randomUUID()];
  const emails = ids.map(id => id + "@example.invalid");
  const marker = async () => (await pool.query("SELECT value FROM system_settings WHERE key=$1", [key])).rows[0]?.value;
  const role = async (id: string) => (await pool.query("SELECT role FROM users WHERE id=$1", [id])).rows[0]?.role;
  const addUser = async (index: number, userRole = "user") => {
    await pool.query("INSERT INTO users(id,email,name,role) VALUES($1,$2,'Bootstrap fixture',$3)", [ids[index], emails[index], userRole]);
  };

  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    expect((await pool.query("SELECT count(*)::int n FROM users WHERE role='admin'")).rows[0].n).toBe(0);
    prior = (await pool.query("SELECT value,updated_by,updated_at FROM system_settings WHERE key=$1", [key])).rows[0];
    ownsState = true;
    bootstrap = (await import("../../auth.js")).bootstrapAdminRole;
  });
  beforeEach(async () => {
    vi.stubEnv("ADMIN_EMAIL", "");
    await pool.query("DELETE FROM system_settings WHERE key=$1", [key]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [ids]);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!pool) return;
    if (!ownsState) { await pool.end(); return; }
    await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [ids]);
    await pool.query("DELETE FROM system_settings WHERE key=$1", [key]);
    if (prior) await pool.query("INSERT INTO system_settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,$4)",
      [key, JSON.stringify(prior.value), prior.updated_by, prior.updated_at]);
    await pool.end();
  });

  it("records an existing owner without ADMIN_EMAIL and never promotes a re-registered address", async () => {
    await addUser(0, "admin");
    await bootstrap();
    expect(await role(ids[0])).toBe("admin");
    expect(await marker()).toMatchObject({ completed: true, userId: ids[0] });
    // Simulate an explicit operator deletion, then a different person claiming
    // the freed email. A restart must not treat this as a fresh installation.
    await pool.query("DELETE FROM users WHERE id=$1", [ids[0]]);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Replacement fixture')", [ids[1], emails[0]]);
    vi.stubEnv("ADMIN_EMAIL", emails[0]);
    await bootstrap();
    expect(await role(ids[1])).toBe("user");
    expect(await marker()).toMatchObject({ userId: ids[0] });
  });

  it("preserves the existing owner when ADMIN_EMAIL points to another registered user", async () => {
    await addUser(0, "admin"); await addUser(1);
    vi.stubEnv("ADMIN_EMAIL", emails[1]);
    await bootstrap();
    expect(await role(ids[0])).toBe("admin"); expect(await role(ids[1])).toBe("user");
    expect(await marker()).toMatchObject({ userId: ids[0] });
  });

  it("atomically bootstraps once across concurrent server starts", async () => {
    await addUser(0);
    vi.stubEnv("ADMIN_EMAIL", emails[0].toUpperCase());
    await Promise.all(Array.from({ length: 6 }, () => bootstrap()));
    expect(await role(ids[0])).toBe("admin");
    expect(await marker()).toMatchObject({ completed: true, userId: ids[0] });
    await pool.query("UPDATE users SET role='user' WHERE id=$1", [ids[0]]);
    await bootstrap();
    expect(await role(ids[0])).toBe("user");
  });

  it("does not consume first bootstrap before an operator account exists", async () => {
    vi.stubEnv("ADMIN_EMAIL", emails[0]);
    await bootstrap(); expect(await marker()).toBeUndefined();
    await addUser(0); await bootstrap();
    expect(await role(ids[0])).toBe("admin");
    expect(await marker()).toMatchObject({ userId: ids[0] });
  });
});
