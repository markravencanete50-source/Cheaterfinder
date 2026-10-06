// ─── Refresh interval config ────────────────────────────────────────────────
//
// Admin-controllable scraping refresh cadence. The per-account refresh
// registrar reads this to decide how often each tracked_account is re-scraped.
//
// Resolution order: system_settings (DB) → REFRESH_SWEEP_SEC env → default.
//
// A synchronous cached getter (`getCachedRefreshIntervalSec`) exists because
// the BullMQ registrar builds scheduler `every` values in hot, sync code paths.
// Call `initRefreshConfig()` once at boot to warm the cache from the DB; admin
// writes update the cache immediately so a follow-up reconcile picks up the new
// value without a round-trip.
// ────────────────────────────────────────────────────────────────────────────

import { sql } from "drizzle-orm";

import { db } from "../db.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "refresh-config" });

const SETTING_KEY = "scraper.refreshIntervalSec";

// Floor protects IG from a too-aggressive cadence that invites bans / quota
// burn; ceiling keeps tracked data from going stale for days.
export const MIN_REFRESH_SEC = 60; // 1 minute
export const MAX_REFRESH_SEC = 86_400; // 24 hours
export const DEFAULT_REFRESH_SEC = 1800; // 30 minutes

export type RefreshSource = "db" | "env" | "default";

let cachedSec = DEFAULT_REFRESH_SEC;
let cachedSource: RefreshSource = "default";

export function clampRefreshSec(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_REFRESH_SEC;
  return Math.min(Math.max(Math.round(sec), MIN_REFRESH_SEC), MAX_REFRESH_SEC);
}

function envDefault(): { sec: number; source: RefreshSource } {
  const raw = Number(process.env.REFRESH_SWEEP_SEC);
  if (Number.isFinite(raw) && raw > 0) {
    return { sec: clampRefreshSec(raw), source: "env" };
  }
  return { sec: DEFAULT_REFRESH_SEC, source: "default" };
}

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export interface RefreshIntervalConfig {
  intervalSec: number;
  source: RefreshSource;
  updatedAt: string | null;
  min: number;
  max: number;
}

/** Synchronous cached value for hot paths (BullMQ scheduler registration). */
export function getCachedRefreshIntervalSec(): number {
  return cachedSec;
}

/**
 * Read the current interval, refreshing the cache from the DB. Falls back to
 * env / default when no row exists.
 */
export async function getRefreshInterval(): Promise<RefreshIntervalConfig> {
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
  const [row] = rowsFrom<{ value: unknown; updated_at: Date | string | null }>(
    result,
  );

  const dbValue =
    row && typeof row.value === "object" && row.value !== null
      ? (row.value as { intervalSec?: unknown }).intervalSec
      : undefined;

  if (typeof dbValue === "number" && Number.isFinite(dbValue)) {
    cachedSec = clampRefreshSec(dbValue);
    cachedSource = "db";
    return {
      intervalSec: cachedSec,
      source: "db",
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      min: MIN_REFRESH_SEC,
      max: MAX_REFRESH_SEC,
    };
  }

  const fallback = envDefault();
  cachedSec = fallback.sec;
  cachedSource = fallback.source;
  return {
    intervalSec: cachedSec,
    source: cachedSource,
    updatedAt: null,
    min: MIN_REFRESH_SEC,
    max: MAX_REFRESH_SEC,
  };
}

/** Warm the sync cache at boot. Never throws — falls back to env/default. */
export async function initRefreshConfig(): Promise<void> {
  try {
    await getRefreshInterval();
    logger.info(
      { intervalSec: cachedSec, source: cachedSource },
      "refresh interval config loaded",
    );
  } catch (err) {
    const fallback = envDefault();
    cachedSec = fallback.sec;
    cachedSource = fallback.source;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), intervalSec: cachedSec },
      "refresh interval load failed; using env/default",
    );
  }
}

export async function setRefreshInterval(
  intervalSec: number,
  updatedBy?: string | null,
): Promise<RefreshIntervalConfig> {
  const clamped = clampRefreshSec(intervalSec);
  const result = await db.execute<{ updated_at: Date | string }>(sql`
    INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (
      ${SETTING_KEY},
      ${JSON.stringify({ intervalSec: clamped })}::jsonb,
      ${updatedBy ?? null},
      NOW()
    )
    ON CONFLICT (key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING updated_at
  `);
  const [row] = rowsFrom<{ updated_at: Date | string }>(result);
  cachedSec = clamped;
  cachedSource = "db";
  logger.info(
    { intervalSec: clamped, updatedBy: updatedBy ?? null },
    "refresh interval updated",
  );
  return {
    intervalSec: clamped,
    source: "db",
    updatedAt: row?.updated_at
      ? new Date(row.updated_at).toISOString()
      : new Date().toISOString(),
    min: MIN_REFRESH_SEC,
    max: MAX_REFRESH_SEC,
  };
}
