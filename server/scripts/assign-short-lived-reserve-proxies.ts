// Assign one explicit DataImpulse sticky port to each prepared reserve bot.
// This is an operator-only recovery path for accounts that must be staged
// before fixed-IP proxies are available. It never promotes accounts and the
// runtime remains fail-closed unless the explicit short-lived override is set.
//
// Usage:
//   npx tsx server/scripts/assign-short-lived-reserve-proxies.ts \
//     --dry-run --created-after=2026-08-15T17:00:00Z --limit=85
//   npx tsx server/scripts/assign-short-lived-reserve-proxies.ts \
//     --apply --created-after=2026-08-15T17:00:00Z --limit=85

import "dotenv/config";

import { sql } from "drizzle-orm";

import { db, pool } from "../db.js";
import {
  DATAIMPULSE_STICKY_PORT_MAX,
  DATAIMPULSE_STICKY_PORT_MIN,
  isDataImpulseGatewayHost,
} from "../services/proxy-durability.js";

interface CandidateRow {
  id: string;
}

interface ExistingProxyRow {
  proxy_url: string;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function requireIntegerFlag(name: string): number {
  const prefix = `--${name}=`;
  const flag = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const parsed = flag ? Number(flag.slice(prefix.length)) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name}=<positive integer> is required`);
  }
  return parsed;
}

function requireCreatedAfter(): Date {
  const prefix = "--created-after=";
  const flag = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const parsed = new Date(flag?.slice(prefix.length) ?? "");
  if (!flag || Number.isNaN(parsed.getTime())) {
    throw new Error("--created-after=<ISO-8601 timestamp> is required");
  }
  return parsed;
}

function readStickyTtlMinutes(): number {
  const configured = Number(
    process.env.DATAIMPULSE_ACCOUNT_STICKY_TTL_MINUTES ?? "120",
  );
  if (!Number.isInteger(configured) || configured < 1 || configured > 120) {
    throw new Error(
      "DATAIMPULSE_ACCOUNT_STICKY_TTL_MINUTES must be an integer from 1 to 120",
    );
  }
  return configured;
}

function readProxyConfig(): {
  host: string;
  username: string;
  password: string;
  portStart: number;
  portEnd: number;
} {
  const source = (
    process.env.DATAIMPULSE_ACCOUNT_PROXY_URL
    ?? process.env.DATAIMPULSE_PROXY_URL
  )?.trim();
  if (!source) {
    throw new Error(
      "DATAIMPULSE_ACCOUNT_PROXY_URL or DATAIMPULSE_PROXY_URL is required",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(source.includes("://") ? source : `http://${source}`);
  } catch {
    throw new Error("DATAIMPULSE_PROXY_URL is invalid");
  }

  const portStart = Number(process.env.DATAIMPULSE_PROXY_PORT_START);
  const portEnd = Number(process.env.DATAIMPULSE_PROXY_PORT_END);
  if (
    !isDataImpulseGatewayHost(parsed.hostname)
    || !parsed.username
    || !parsed.password
    || !Number.isInteger(portStart)
    || !Number.isInteger(portEnd)
    || portStart < DATAIMPULSE_STICKY_PORT_MIN
    || portEnd > DATAIMPULSE_STICKY_PORT_MAX
    || portStart > portEnd
  ) {
    throw new Error("configured DataImpulse sticky range is invalid");
  }

  return {
    host: parsed.hostname,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    portStart,
    portEnd,
  };
}

function withStickyTtl(username: string, ttlMinutes: number): string {
  const markerIndex = username.indexOf("__");
  const account = markerIndex >= 0 ? username.slice(0, markerIndex) : username;
  const existing = markerIndex >= 0 ? username.slice(markerIndex + 2) : "";
  const parameters = existing
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !/^sessttl\./i.test(value));
  parameters.push(`sessttl.${ttlMinutes}`);
  return `${account}__${parameters.join(";")}`;
}

function proxyUrlFor(
  config: ReturnType<typeof readProxyConfig>,
  port: number,
  ttlMinutes: number,
): string {
  const url = new URL(`http://${config.host}:${port}`);
  url.username = withStickyTtl(config.username, ttlMinutes);
  url.password = config.password;
  return url.toString().replace(/\/$/, "");
}

function portFromProxyUrl(proxyUrl: string, expectedHost: string): number | null {
  try {
    const parsed = new URL(
      proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`,
    );
    if (parsed.hostname.toLowerCase() !== expectedHost.toLowerCase()) return null;
    const port = Number(parsed.port);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run");
  if (apply === dryRun) {
    throw new Error("choose exactly one of --dry-run or --apply");
  }

  const limit = requireIntegerFlag("limit");
  const createdAfter = requireCreatedAfter();
  const ttlMinutes = readStickyTtlMinutes();
  const config = readProxyConfig();

  const candidatesResult = (await db.execute(sql`
    SELECT id
    FROM bot_accounts
    WHERE tier = 'reserve'
      AND status = 'session_expired'
      AND created_at >= ${createdAfter}
      AND ig_password_encrypted IS NOT NULL
      AND totp_secret IS NOT NULL
      AND automation_identity IS NOT NULL
      AND NULLIF(BTRIM(proxy_url), '') IS NULL
    ORDER BY created_at ASC, ig_username ASC
    LIMIT ${limit}
  `)) as unknown as { rows: CandidateRow[] };

  const existingResult = (await db.execute(sql`
    SELECT proxy_url
    FROM bot_accounts
    WHERE NULLIF(BTRIM(proxy_url), '') IS NOT NULL
  `)) as unknown as { rows: ExistingProxyRow[] };

  const usedPorts = new Set(
    existingResult.rows
      .map((row) => portFromProxyUrl(row.proxy_url, config.host))
      .filter((port): port is number => port !== null),
  );
  const availablePorts: number[] = [];
  for (let port = config.portStart; port <= config.portEnd; port += 1) {
    if (!usedPorts.has(port)) availablePorts.push(port);
    if (availablePorts.length >= candidatesResult.rows.length) break;
  }

  if (availablePorts.length < candidatesResult.rows.length) {
    throw new Error("not enough unused DataImpulse sticky ports for candidates");
  }

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      candidates: candidatesResult.rows.length,
      assignable: availablePorts.length,
      ttlMinutes,
      createdAfter: createdAfter.toISOString(),
    }));
    return;
  }

  let assigned = 0;
  for (let index = 0; index < candidatesResult.rows.length; index += 1) {
    const bot = candidatesResult.rows[index];
    const port = availablePorts[index];
    const proxyUrl = proxyUrlFor(config, port, ttlMinutes);
    const result = await db.execute(sql`
      UPDATE bot_accounts SET
        proxy_url = ${proxyUrl},
        proxy_endpoint = NULL,
        proxy_session_id = ${`dataimpulse-port-${port}`},
        proxy_expires_at = NULL,
        updated_at = NOW()
      WHERE id = ${bot.id}
        AND tier = 'reserve'
        AND status = 'session_expired'
        AND NULLIF(BTRIM(proxy_url), '') IS NULL
    `);
    assigned += (result as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  console.log(JSON.stringify({
    ok: assigned === candidatesResult.rows.length,
    candidates: candidatesResult.rows.length,
    assigned,
    ttlMinutes,
    createdAfter: createdAfter.toISOString(),
  }));
  if (assigned !== candidatesResult.rows.length) process.exitCode = 1;
}

void main()
  .catch((error: unknown) => {
    console.error(
      `[assign-short-lived-reserve-proxies] ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
