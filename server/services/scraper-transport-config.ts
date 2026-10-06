import { sql } from "drizzle-orm";

import { db } from "../db.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "scraper-transport-config" });

export const SCRAPER_READ_TRANSPORTS = [
  "http",
  "browser",
  "browser-fallback",
  // HTTP where proven; browser remains mandatory for likers/comments and
  // stories/clips. Highlights already use HTTP first. Mobile-only endpoint gates are independent. HTTP 200
  // is not visibility parity: do not move browser reads without comparing the
  // same viewer, target, fields, pagination, and fresh updates.
  "http-first",
] as const;

export type ScraperReadTransport = (typeof SCRAPER_READ_TRANSPORTS)[number];

const SETTING_KEY = "scraper.readTransport";
const CACHE_TTL_MS = 15_000;

let cached:
  | { value: ScraperReadTransport; source: "db" | "env" | "default"; loadedAt: number }
  | null = null;

function isScraperReadTransport(value: unknown): value is ScraperReadTransport {
  return (
    typeof value === "string" &&
    SCRAPER_READ_TRANSPORTS.includes(value as ScraperReadTransport)
  );
}

function envDefault(): ScraperReadTransport {
  const raw =
    process.env.SCRAPER_READ_TRANSPORT ??
    process.env.IG_READ_TRANSPORT ??
    process.env.PUBLIC_SCRAPER_TRANSPORT;
  return isScraperReadTransport(raw) ? raw : "http";
}

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export async function getScraperReadTransport(options?: {
  forceRefresh?: boolean;
}): Promise<{
  value: ScraperReadTransport;
  source: "db" | "env" | "default";
  updatedAt: string | null;
}> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    cached &&
    now - cached.loadedAt < CACHE_TTL_MS
  ) {
    return { value: cached.value, source: cached.source, updatedAt: null };
  }

  // Deployment migrations provision this table; runtime needs only data access.
  const result = await db.execute<{
    value: unknown;
    updated_at: Date | string | null;
  }>(sql`
    SELECT value, updated_at
    FROM system_settings
    WHERE key = ${SETTING_KEY}
    LIMIT 1
  `);
  const [row] = rowsFrom<{
    value: unknown;
    updated_at: Date | string | null;
  }>(result);

  const dbValue =
    row && typeof row.value === "object" && row.value !== null
      ? (row.value as { transport?: unknown }).transport
      : row?.value;

  if (isScraperReadTransport(dbValue)) {
    cached = { value: dbValue, source: "db", loadedAt: now };
    return {
      value: dbValue,
      source: "db",
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  const fallback = envDefault();
  const source = fallback === "http" ? "default" : "env";
  cached = { value: fallback, source, loadedAt: now };
  return { value: fallback, source, updatedAt: null };
}

export async function setScraperReadTransport(
  transport: ScraperReadTransport,
  updatedBy?: string | null,
): Promise<{
  value: ScraperReadTransport;
  source: "db";
  updatedAt: string;
}> {
  const result = await db.execute<{
    value: unknown;
    updated_at: Date | string;
  }>(sql`
    INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (
      ${SETTING_KEY},
      ${JSON.stringify({ transport })}::jsonb,
      ${updatedBy ?? null},
      NOW()
    )
    ON CONFLICT (key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING value, updated_at
  `);
  const [row] = rowsFrom<{ value: unknown; updated_at: Date | string }>(result);
  cached = { value: transport, source: "db", loadedAt: Date.now() };
  logger.info(
    { transport, updatedBy: updatedBy ?? null },
    "[scraper-transport-config] scraper read transport updated",
  );
  return {
    value: transport,
    source: "db",
    updatedAt: row?.updated_at
      ? new Date(row.updated_at).toISOString()
      : new Date().toISOString(),
  };
}
