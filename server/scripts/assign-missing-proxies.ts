// Assign a durable per-bot DataImpulse sticky lane to any bot that has a session
// but no usable proxy_url (missing, or malformed). Ports are picked from a free
// range so no two bots share a lane. Reads credentials from env — never from
// shell interpolation.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

const VALID = /^http:\/\/[^:@]+:[^@]+@[^:]+:\d+$/;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const account = (process.env.STATIC_PROXY_USERNAME ?? "").split("__")[0];
  const password = process.env.STATIC_PROXY_PASSWORD ?? "";
  const host = process.env.STATIC_PROXY_HOST ?? "gw.dataimpulse.com";
  if (!account || !password) throw new Error("STATIC_PROXY_USERNAME/PASSWORD not configured");

  // Ports already in use, so we never double-assign a sticky lane.
  const { rows: used } = (await db.execute(sql`
    SELECT DISTINCT (regexp_match(proxy_url, ':([0-9]+)$'))[1]::int AS port
    FROM bot_accounts WHERE proxy_url ~ ':[0-9]+$'`)) as any;
  const taken = new Set<number>(used.map((r: any) => Number(r.port)).filter(Boolean));

  const { rows: broken } = (await db.execute(sql`
    SELECT id, ig_username, proxy_url FROM bot_accounts
    WHERE session_data IS NOT NULL AND status='available'
    ORDER BY ig_username`)) as any;

  const targets = broken.filter((b: any) => !b.proxy_url || !VALID.test(b.proxy_url));
  console.log(`[proxy] ${targets.length} bots need a valid sticky lane (of ${broken.length} with sessions)`);
  if (!apply) { console.log("[proxy] dry-run; pass --apply"); return; }

  let port = 10900, fixed = 0;
  for (const b of targets) {
    while (taken.has(port)) port++;
    taken.add(port);
    const url = `http://${account}__sessttl.120:${password}@${host}:${port}`;
    await db.execute(sql`
      UPDATE bot_accounts SET proxy_url=${url}, proxy_endpoint=NULL, proxy_expires_at=NULL, updated_at=NOW()
      WHERE id=${b.id}`);
    fixed++; port++;
  }
  console.log(`[proxy] assigned ${fixed} durable lanes (ports from 10900)`);
}
main().catch(e => { console.error("[proxy] ERR", e instanceof Error ? e.message : String(e)); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); });
