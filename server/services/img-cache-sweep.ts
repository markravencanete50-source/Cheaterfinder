/**
 * LRU size-bounded sweep for the flat-file img-proxy disk cache.
 *
 * The /api/img-proxy endpoint persists fetched IG CDN media to a flat directory
 * (default /tmp/cheaterfinder-img-cache) as `<sha256>.body` + `<sha256>.json` pairs.
 * That directory previously grew unbounded — anonymous (now authenticated) load
 * could fill the disk. This module enforces a max total size, evicting the
 * least-recently-used entries (by file mtime) first.
 *
 * The sweep is intended to run opportunistically after a cache write, throttled
 * to at most once per `SWEEP_THROTTLE_MS` so no dedicated scheduler is needed.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { logger } from "../observability/logger.js";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const SWEEP_THROTTLE_MS = 5 * 60 * 1000; // at most once / 5 min

/**
 * Maximum total size of the img-proxy disk cache, in bytes. Env-tunable via
 * IMAGE_CACHE_MAX_TOTAL_BYTES; falls back to 2 GB. Values <= 0 disable the
 * size bound (sweep becomes a no-op).
 */
export function imgCacheMaxTotalBytes(): number {
  const raw = process.env.IMAGE_CACHE_MAX_TOTAL_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_BYTES;
  return parsed;
}

type SweepEntry = {
  /** sha256 cache key (filename stem) */
  key: string;
  /** absolute path to the `.body` file */
  bodyPath: string;
  /** absolute path to the `.json` sidecar, or null if absent */
  metaPath: string | null;
  /** size in bytes of body + sidecar */
  size: number;
  /** last-modified time in ms (LRU ordering key) */
  mtimeMs: number;
};

export type SweepResult = {
  /** total bytes present before eviction */
  totalBytes: number;
  /** number of `.body` entries evicted */
  evictedEntries: number;
  /** bytes reclaimed by eviction */
  evictedBytes: number;
  /** total bytes remaining after eviction */
  remainingBytes: number;
};

/**
 * Scan `cacheDir`, summing the size of every `<key>.body` (plus its `.json`
 * sidecar), and — if the total exceeds `maxBytes` — delete the
 * least-recently-used entries (oldest mtime first) until the total is within
 * budget. Pure-ish: only touches files under `cacheDir`. Safe to call when the
 * directory does not exist (returns a zeroed result).
 *
 * Immutability note: builds a fresh sorted copy rather than mutating the scan
 * array in place; never reuses caller-supplied state.
 */
export async function sweepImgCache(
  cacheDir: string,
  maxBytes: number,
): Promise<SweepResult> {
  const empty: SweepResult = {
    totalBytes: 0,
    evictedEntries: 0,
    evictedBytes: 0,
    remainingBytes: 0,
  };

  let dirents: string[];
  try {
    dirents = await fsp.readdir(cacheDir);
  } catch {
    // Directory missing / unreadable → nothing to sweep.
    return empty;
  }

  const entries = await collectEntries(cacheDir, dirents);
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);

  // No bound (<=0) or already within budget → report only, evict nothing.
  if (maxBytes <= 0 || totalBytes <= maxBytes) {
    return {
      totalBytes,
      evictedEntries: 0,
      evictedBytes: 0,
      remainingBytes: totalBytes,
    };
  }

  // LRU: oldest mtime first. Sort an immutable copy.
  const lruOrdered = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);

  let remainingBytes = totalBytes;
  let evictedBytes = 0;
  let evictedEntries = 0;

  for (const entry of lruOrdered) {
    if (remainingBytes <= maxBytes) break;
    const removed = await removeEntry(entry);
    if (removed) {
      remainingBytes -= entry.size;
      evictedBytes += entry.size;
      evictedEntries += 1;
    }
  }

  return { totalBytes, evictedEntries, evictedBytes, remainingBytes };
}

async function collectEntries(
  cacheDir: string,
  dirents: ReadonlyArray<string>,
): Promise<SweepEntry[]> {
  const bodyFiles = dirents.filter((name) => name.endsWith(".body"));
  const metaSet = new Set(dirents.filter((name) => name.endsWith(".json")));

  const settled = await Promise.all(
    bodyFiles.map((name) =>
      describeEntry(cacheDir, name, metaSet).catch(() => null),
    ),
  );

  return settled.filter((e): e is SweepEntry => e !== null);
}

async function describeEntry(
  cacheDir: string,
  bodyName: string,
  metaSet: ReadonlySet<string>,
): Promise<SweepEntry | null> {
  const key = bodyName.slice(0, -".body".length);
  const bodyPath = path.join(cacheDir, bodyName);
  const metaName = `${key}.json`;
  const hasMeta = metaSet.has(metaName);
  const metaPath = hasMeta ? path.join(cacheDir, metaName) : null;

  const bodyStat = await fsp.stat(bodyPath);
  let size = bodyStat.size;
  if (metaPath) {
    try {
      const metaStat = await fsp.stat(metaPath);
      size += metaStat.size;
    } catch {
      // Sidecar vanished between readdir and stat — count body only.
    }
  }

  return { key, bodyPath, metaPath, size, mtimeMs: bodyStat.mtimeMs };
}

async function removeEntry(entry: SweepEntry): Promise<boolean> {
  try {
    await fsp.rm(entry.bodyPath, { force: true });
    if (entry.metaPath) {
      await fsp.rm(entry.metaPath, { force: true });
    }
    return true;
  } catch (err) {
    logger.warn(
      {
        module: "img-cache-sweep",
        key: entry.key,
        err: err instanceof Error ? err.message : String(err),
      },
      "img cache eviction failed",
    );
    return false;
  }
}

// ─── Throttled opportunistic trigger ────────────────────────────────────────

let lastSweepAt = 0;
let sweepInFlight = false;

/**
 * Fire-and-forget sweep, throttled to at most once per SWEEP_THROTTLE_MS and
 * de-duplicated while a sweep is already running. Call this after a cache write
 * — it never throws and never blocks the response path. Returns true if a sweep
 * was actually started, false if it was throttled / already running.
 */
export function maybeSweepImgCache(
  cacheDir: string,
  maxBytes: number = imgCacheMaxTotalBytes(),
  now: number = Date.now(),
): boolean {
  if (sweepInFlight) return false;
  if (now - lastSweepAt < SWEEP_THROTTLE_MS) return false;

  lastSweepAt = now;
  sweepInFlight = true;

  void sweepImgCache(cacheDir, maxBytes)
    .then((result) => {
      if (result.evictedEntries > 0) {
        logger.info(
          {
            module: "img-cache-sweep",
            evictedEntries: result.evictedEntries,
            evictedBytes: result.evictedBytes,
            remainingBytes: result.remainingBytes,
            maxBytes,
          },
          "swept img cache",
        );
      }
    })
    .catch((err) => {
      logger.warn(
        {
          module: "img-cache-sweep",
          err: err instanceof Error ? err.message : String(err),
        },
        "img cache sweep failed",
      );
    })
    .finally(() => {
      sweepInFlight = false;
    });

  return true;
}

/**
 * Test-only: reset the throttle/in-flight state so unit tests are isolated.
 */
export function __resetImgCacheSweepThrottle(): void {
  lastSweepAt = 0;
  sweepInFlight = false;
}
