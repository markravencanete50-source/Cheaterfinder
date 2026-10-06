// Real PostgreSQL queries against a new, synthetic, socket-only cluster.
// No app DATABASE_URL, provider credential, source schema or live DB is used.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const boundary = vi.hoisted(() => ({ db: null as any }));
vi.mock("../db.js", () => ({ db: {
  select: (...args: any[]) => boundary.db.select(...args),
  execute: (...args: any[]) => boundary.db.execute(...args),
} }));

import {
  canonicalTwinId, countVisibleLikedPostsByAccount, resetCanonicalTwinCache,
  siblingTrackedAccountIds, twinTrackedAccountIdMap, twinTrackedAccountIds,
} from "../services/tracked-account-twins.js";

const pgBin = "/usr/lib/postgresql/16/bin";
let directory: string;
let dataDirectory: string;
let pool: Pool;
let started = false;
const root = process.getuid?.() === 0;
function pg(command: string, args: string[]) {
  const binary = join(pgBin, command);
  const result = spawnSync(root ? "/usr/sbin/runuser" : binary,
    root ? ["-u", "postgres", "--", binary, ...args] : args,
    { env: { PATH: process.env.PATH, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, encoding: "utf8", timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error(`Isolated ${command} failed: ${result.error ?? result.stderr}`);
}

describe.skipIf(!existsSync(join(pgBin, "initdb")))("private twin isolation with real PostgreSQL", () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "cheaterfinder-private-twins-"));
    chmodSync(directory, 0o755);
    dataDirectory = join(directory, "pgdata");
    const socket = join(directory, "socket");
    mkdirSync(dataDirectory, { mode: 0o700 }); mkdirSync(socket, { mode: 0o700 });
    if (root) {
      const uidResult = spawnSync("/usr/bin/id", ["-u", "postgres"], { encoding: "utf8" });
      const gidResult = spawnSync("/usr/bin/id", ["-g", "postgres"], { encoding: "utf8" });
      if (uidResult.status !== 0 || gidResult.status !== 0) throw new Error(`Local postgres OS user required: ${uidResult.error ?? uidResult.stderr}; ${gidResult.error ?? gidResult.stderr}`);
      const uid = Number(uidResult.stdout.trim()), gid = Number(gidResult.stdout.trim());
      if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error(`Invalid postgres uid/gid: ${JSON.stringify([uidResult.stdout, gidResult.stdout])}`);
      chownSync(dataDirectory, uid, gid); chownSync(socket, uid, gid);
    }
    pg("initdb", ["-D", dataDirectory, "--username=postgres", "--auth-local=trust", "--no-locale", "--encoding=UTF8"]);
    pg("pg_ctl", ["-D", dataDirectory, "-l", join(dataDirectory, "server.log"), "-o",
      `-k ${socket} -p 25432 -c listen_addresses='' -c max_connections=10 -c shared_buffers=8MB`, "-w", "start"]);
    started = true;
    pool = new Pool({ host: socket, port: 25432, user: "postgres", database: "postgres", max: 2,
      connectionTimeoutMillis: 3000, options: "-c statement_timeout=5000 -c TimeZone=UTC" });
    expect((await pool.query("SHOW data_directory")).rows[0].data_directory).toBe(dataDirectory);
    expect((await pool.query("SHOW listen_addresses")).rows[0].listen_addresses).toBe("");
    boundary.db = drizzle(pool);
    await pool.query(`
      CREATE TABLE tracked_accounts (
        id text PRIMARY KEY, ig_user_id text, ig_username text NOT NULL,
        is_private boolean NOT NULL, is_active boolean NOT NULL,
        user_id text NOT NULL, tracking_started timestamp NOT NULL
      );
      CREATE TABLE subscriptions (
        user_id text PRIMARY KEY, stripe_customer_id text, stripe_subscription_id text,
        status text, current_period_end timestamp, trial_ends_at timestamp
      );
      CREATE TABLE like_events (
        tracked_account_id text NOT NULL, post_id text NOT NULL,
        post_taken_at timestamp, detected_at timestamp NOT NULL
      );
    `);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (started) pg("pg_ctl", ["-D", dataDirectory, "-m", "immediate", "-w", "stop"]);
    if (directory?.startsWith(join(tmpdir(), "cheaterfinder-private-twins-"))) rmSync(directory, { recursive: true, force: true });
  }, 30_000);

  beforeEach(async () => {
    resetCanonicalTwinCache();
    vi.stubEnv("LIKE_EVENT_WINDOW", "observed");
    await pool.query(`
      TRUNCATE tracked_accounts, subscriptions, like_events;
      INSERT INTO tracked_accounts VALUES
        ('public-a','123','sameuser',false,true,'customer-a','2026-01-10'),
        ('public-b','123','sameuser',false,true,'customer-b','2026-01-20'),
        ('private-a','123','sameuser',true,true,'customer-c','2026-01-01'),
        ('private-b','123','sameuser',true,true,'customer-d','2026-01-02'),
        ('unpaid','123','sameuser',false,true,'customer-e','2025-01-01'),
        ('inactive','123','sameuser',false,false,'customer-f','2025-01-02');
      INSERT INTO subscriptions
        SELECT user_id, 'cus_fixture', 'sub_fixture',
          CASE WHEN id='unpaid' THEN 'canceled' ELSE 'active' END,
          now() + interval '1 day', NULL FROM tracked_accounts;
      INSERT INTO like_events VALUES
        ('public-a','common','2026-02-01','2026-02-01'),
        ('public-a','public-a-only','2026-02-01','2026-02-01'),
        ('public-b','common','2026-02-01','2026-02-01'),
        ('public-b','public-b-only','2026-02-01','2026-02-01'),
        ('private-a','private-a-secret','2026-02-01','2026-02-01'),
        ('private-b','private-b-secret','2026-02-01','2026-02-01'),
        ('unpaid','unpaid-only','2026-02-01','2026-02-01'),
        ('inactive','inactive-only','2026-02-01','2026-02-01');
    `);
  });

  it("keeps each private customer's canonical roster and liked-post union on its own original row", async () => {
    for (const id of ["private-a", "private-b"]) {
      expect(await canonicalTwinId(id)).toBe(id);
      expect(await twinTrackedAccountIds(id)).toEqual([id]);
      expect(await siblingTrackedAccountIds(id)).toEqual([]);
    }
  });

  it("preserves public same-IG reuse while excluding private donors", async () => {
    expect(await canonicalTwinId("public-b")).toBe("public-a");
    expect(new Set(await twinTrackedAccountIds("public-b"))).toEqual(new Set(["public-a", "public-b", "unpaid"]));
    // Inactive public rows can donate an old roster during promotion.
    expect(new Set(await siblingTrackedAccountIds("public-b"))).toEqual(new Set(["public-a", "inactive", "unpaid"]));
  });

  it("isolates private entries in a mixed batched dashboard lookup", async () => {
    const map = await twinTrackedAccountIdMap(["private-a", "public-b", "private-b", "missing", "private-a"]);
    expect(map.get("private-a")).toEqual(["private-a"]);
    expect(map.get("private-b")).toEqual(["private-b"]);
    expect(new Set(map.get("public-b"))).toEqual(new Set(["public-a", "public-b"]));
    expect(map.get("missing")).toEqual(["missing"]);
    expect(map.size).toBe(4);
  });

  it("counts only each private original's evidence and still deduplicates public posts", async () => {
    const counts = await countVisibleLikedPostsByAccount(["private-a", "private-b", "public-a", "public-b"]);
    expect(Object.fromEntries(counts)).toEqual({ "private-a": 1, "private-b": 1, "public-a": 3, "public-b": 3 });
  });

  it("invalidates a cached twin immediately when its requesting anchor becomes private", async () => {
    expect(await canonicalTwinId("public-b")).toBe("public-a");
    await pool.query("UPDATE tracked_accounts SET is_private=true WHERE id='public-b'");
    expect(await canonicalTwinId("public-b")).toBe("public-b");
    expect(await twinTrackedAccountIds("public-b")).toEqual(["public-b"]);
    expect((await twinTrackedAccountIdMap(["public-b"])).get("public-b")).toEqual(["public-b"]);
  });

  it("invalidates a cached donor immediately when that donor becomes private", async () => {
    expect(await canonicalTwinId("public-b")).toBe("public-a");
    await pool.query("UPDATE tracked_accounts SET is_private=true WHERE id='public-a'");
    expect(await canonicalTwinId("public-b")).toBe("public-b");
    expect(await twinTrackedAccountIds("public-b")).toEqual(["public-b", "unpaid"]);
    expect((await countVisibleLikedPostsByAccount(["public-b"])).get("public-b")).toBe(2);
  });

  it.each(["deactivated", "unpaid", "changed-identity"])("rejects a cached donor that becomes %s", async change => {
    expect(await canonicalTwinId("public-b")).toBe("public-a");
    if (change === "deactivated") await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id='public-a'");
    if (change === "unpaid") await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id='customer-a'");
    if (change === "changed-identity") await pool.query("UPDATE tracked_accounts SET ig_user_id='999' WHERE id='public-a'");
    expect(await canonicalTwinId("public-b")).toBe("public-b");
  });

  it("applies the same private boundary to username fallback before an IG ID is known", async () => {
    await pool.query("UPDATE tracked_accounts SET ig_user_id=NULL");
    expect(await canonicalTwinId("public-b")).toBe("public-a");
    expect(await canonicalTwinId("private-b")).toBe("private-b");
    expect(new Set(await twinTrackedAccountIds("public-b"))).toEqual(new Set(["public-a", "public-b", "unpaid"]));
    const map = await twinTrackedAccountIdMap(["private-b", "public-b"]);
    expect(map.get("private-b")).toEqual(["private-b"]);
    expect(new Set(map.get("public-b"))).toEqual(new Set(["public-a", "public-b"]));
  });

  it("never borrows a private row when no public donor exists", async () => {
    await pool.query("DELETE FROM tracked_accounts WHERE id='public-a'");
    expect(await canonicalTwinId("public-b")).toBe("public-b");
    expect(await twinTrackedAccountIds("public-b")).toEqual(["public-b", "unpaid"]);
  });
});
