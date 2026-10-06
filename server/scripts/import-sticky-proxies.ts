// ─── Import dedicated fixed-IP proxy lanes for the prepared reserve pool ───
//
// This intentionally accepts a local, permission-restricted file instead of
// command-line proxy values: shell history, process lists, and CI output must
// never contain proxy credentials. It performs a one-to-one assignment to
// inactive, Python-migrated reserve bots only. Active workers and retired bots
// are never changed.
//
// Accepted one-proxy-per-line formats:
//   http://username:password@host:port   (recommended)
//   username:password@host:port
//   host:port:username:password
// Blank lines and lines starting with # are ignored. Percent-encode special
// characters in URL-form credentials (for example %40 for @).
//
// Usage:
//   chmod 600 /secure/sticky-proxies.txt
//   npx tsx server/scripts/import-sticky-proxies.ts --dry-run --file=/secure/sticky-proxies.txt
//   npx tsx server/scripts/import-sticky-proxies.ts --apply --file=/secure/sticky-proxies.txt
//   npx tsx server/scripts/import-sticky-proxies.ts --apply --replace --file=/secure/sticky-proxies.txt
//
// `--replace` is deliberately explicit. Without it, the script only fills
// reserve bots that do not already have an ops-assigned fixed proxy. Known
// rotating/sticky provider gateways are rejected even when each port differs.

import "dotenv/config";

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";

import { db, pool } from "../db.js";
import { assertDurableAccountProxyAddress } from "../services/proxy-durability.js";

interface StickyProxy {
  /** Canonical endpoint understood by proxyAgentUriForEndpoint. */
  endpoint: string;
  /** URL form used by the explicit per-bot proxy override. */
  url: string;
  /** Non-secret identifier retained for operational correlation. */
  assignmentId: string;
}

interface ReserveBotRow {
  id: string;
}

const DEDICATED_PROXY_EXPIRY = new Date("2099-01-01T00:00:00.000Z");

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function readValue(name: string): string | null {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function requireFilePath(): string {
  const supplied = readValue("--file");
  if (!supplied?.trim()) {
    throw new Error("--file=/absolute/path/to/sticky-proxies.txt is required");
  }
  const absolute = resolve(supplied);
  if (absolute !== supplied) {
    throw new Error("--file must be an absolute path");
  }
  return absolute;
}

function parseLimit(): number | null {
  const raw = readValue("--limit");
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return value;
}

function parseCreatedAfter(): Date | null {
  const raw = readValue("--created-after");
  if (raw === null) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("--created-after must be an ISO-8601 timestamp");
  }
  return parsed;
}

/** Parse and normalize one credential-bearing proxy line without logging it. */
export function parseStickyProxy(line: string): StickyProxy {
  const source = line.trim();
  let rawUrl: string;

  if (/^https?:\/\//i.test(source)) {
    rawUrl = source;
  } else if (source.includes("@")) {
    rawUrl = `http://${source}`;
  } else {
    // Conventional host:port:username:password form. Split only the first
    // three delimiters so a password that itself contains ':' is preserved.
    const first = source.indexOf(":");
    const second = first < 0 ? -1 : source.indexOf(":", first + 1);
    const third = second < 0 ? -1 : source.indexOf(":", second + 1);
    if (first < 1 || second < first + 2 || third < second + 2) {
      throw new Error("proxy must be URL form or host:port:username:password");
    }
    const host = source.slice(0, first);
    const port = source.slice(first + 1, second);
    const username = source.slice(second + 1, third);
    const password = source.slice(third + 1);
    rawUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("invalid proxy URL");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.port ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("proxy must be http(s)://username:password@host:port");
  }

  const port = Number(parsed.port);
  const username = parsed.username ? decodeURIComponent(parsed.username) : "";
  const password = parsed.password ? decodeURIComponent(parsed.password) : "";
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !username ||
    !password ||
    username.includes(":")
  ) {
    throw new Error("proxy requires host, port, username, and password");
  }

  assertDurableAccountProxyAddress(parsed.hostname, port);

  const endpoint = `${parsed.hostname}:${port}:${username}:${password}`;
  return {
    endpoint,
    url: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parsed.hostname}:${port}`,
    assignmentId: `static-${createHash("sha256").update(endpoint).digest("hex").slice(0, 20)}`,
  };
}

async function loadProxyFile(filePath: string): Promise<StickyProxy[]> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("--file must point to a regular file");
  // Group/world-readable proxy lists are easy to leak accidentally. Refuse
  // them rather than merely warning, since the file contains credentials.
  if ((info.mode & 0o077) !== 0) {
    throw new Error("proxy file must not be readable by group or others; run chmod 600 <file>");
  }

  const raw = await readFile(filePath, "utf8");
  const proxies: StickyProxy[] = [];
  const seen = new Set<string>();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let proxy: StickyProxy;
    try {
      proxy = parseStickyProxy(trimmed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid proxy at file line ${index + 1}: ${reason}`);
    }
    if (seen.has(proxy.endpoint)) {
      throw new Error(`duplicate proxy at file line ${index + 1}`);
    }
    seen.add(proxy.endpoint);
    proxies.push(proxy);
  }
  if (proxies.length === 0) throw new Error("proxy file has no usable entries");
  return proxies;
}

async function listEligibleReserveBots(
  limit: number | null,
  replace: boolean,
  createdAfter: Date | null,
): Promise<readonly ReserveBotRow[]> {
  const assignmentGuard = replace ? sql`` : sql`AND proxy_url IS NULL`;
  const cohortGuard = createdAfter === null
    ? sql``
    : sql`AND created_at >= ${createdAfter.toISOString()}`;
  const limitClause = limit === null ? sql`` : sql`LIMIT ${limit}`;
  const result = (await db.execute(sql`
    SELECT id
    FROM bot_accounts
    WHERE tier = 'reserve'
      AND status = 'session_expired'
      AND automation_identity IS NOT NULL
      ${assignmentGuard}
      ${cohortGuard}
    ORDER BY created_at ASC, ig_username ASC
    ${limitClause}
  `)) as unknown as { rows: ReserveBotRow[] };
  return result.rows;
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run");
  if (apply === dryRun) throw new Error("choose exactly one of --dry-run or --apply");

  const filePath = requireFilePath();
  const replace = hasFlag("--replace");
  const createdAfter = parseCreatedAfter();
  const [proxies, bots] = await Promise.all([
    loadProxyFile(filePath),
    listEligibleReserveBots(parseLimit(), replace, createdAfter),
  ]);

  if (bots.length === 0) throw new Error("no eligible prepared reserve bots found");
  // Never assign a lane already owned by a bot outside this selected cohort.
  // With --replace, the cohort's current lanes are intentionally reusable so
  // a deterministic rerun can repair collisions without exhausting the file.
  const selectedIds = new Set(bots.map((bot) => bot.id));
  const assignedResult = (await db.execute(sql`
    SELECT id, proxy_url
    FROM bot_accounts
    WHERE proxy_url IS NOT NULL
  `)) as unknown as { rows: Array<{ id: string; proxy_url: string }> };
  const usedOutsideCohort = new Set(
    assignedResult.rows
      .filter((row) => !selectedIds.has(row.id))
      .map((row) => row.proxy_url),
  );
  const assignableProxies = proxies.filter(
    (proxy) => !usedOutsideCohort.has(proxy.url),
  );
  if (assignableProxies.length < bots.length) {
    throw new Error(
      `proxy file has ${assignableProxies.length} unassigned entries but ${bots.length} reserve bots need a lane`,
    );
  }

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      eligibleReserveBots: bots.length,
      proxyEntries: proxies.length,
      unassignedProxyEntries: assignableProxies.length,
      assigned: bots.length,
      unusedProxyEntries: assignableProxies.length - bots.length,
      replace,
      createdAfter: createdAfter?.toISOString() ?? null,
    }));
    return;
  }

  for (let index = 0; index < bots.length; index += 1) {
    const bot = bots[index];
    const proxy = assignableProxies[index];
    const result = await db.execute(sql`
      UPDATE bot_accounts SET
        proxy_url = ${proxy.url},
        proxy_endpoint = ${proxy.endpoint},
        proxy_session_id = ${proxy.assignmentId},
        proxy_expires_at = ${DEDICATED_PROXY_EXPIRY.toISOString()},
        updated_at = NOW()
      WHERE id = ${bot.id}
        AND tier = 'reserve'
        AND status = 'session_expired'
    `) as unknown as { rowCount?: number };
    if ((result.rowCount ?? 1) !== 1) {
      throw new Error("reserve bot changed while proxy import was running; no further rows were modified");
    }
  }

  console.log(JSON.stringify({
    ok: true,
    assigned: bots.length,
    unusedProxyEntries: assignableProxies.length - bots.length,
    replace,
    createdAfter: createdAfter?.toISOString() ?? null,
  }));
}

void main()
  .catch((error: unknown) => {
    console.error(`[import-sticky-proxies] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
