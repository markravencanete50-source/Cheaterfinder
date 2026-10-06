// Unit tests for the LRU size-bounded sweep of the /api/img-proxy flat-file
// disk cache. These tests are fully self-contained: they operate on a fresh
// temp directory per test and touch no database or network.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  sweepImgCache,
  maybeSweepImgCache,
  imgCacheMaxTotalBytes,
  __resetImgCacheSweepThrottle,
} from "../img-cache-sweep.js";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "img-cache-sweep-"));
  __resetImgCacheSweepThrottle();
  delete process.env.IMAGE_CACHE_MAX_TOTAL_BYTES;
});

afterEach(async () => {
  await fsp.rm(cacheDir, { recursive: true, force: true });
});

/**
 * Write one `<key>.body` (filled to `size` bytes) plus a matching `.json`
 * sidecar, and stamp both with the given mtime so LRU ordering is deterministic.
 */
async function writeEntry(
  key: string,
  size: number,
  mtimeMs: number,
): Promise<void> {
  const bodyPath = path.join(cacheDir, `${key}.body`);
  const metaPath = path.join(cacheDir, `${key}.json`);
  await fsp.writeFile(bodyPath, Buffer.alloc(size, 1));
  await fsp.writeFile(metaPath, JSON.stringify({ contentType: "image/jpeg" }));
  const when = new Date(mtimeMs);
  await fsp.utimes(bodyPath, when, when);
  await fsp.utimes(metaPath, when, when);
}

async function listKeys(): Promise<string[]> {
  const names = await fsp.readdir(cacheDir);
  return names
    .filter((n) => n.endsWith(".body"))
    .map((n) => n.slice(0, -".body".length))
    .sort();
}

describe("sweepImgCache", () => {
  it("returns a zeroed result for a missing directory", async () => {
    const missing = path.join(cacheDir, "does-not-exist");
    const result = await sweepImgCache(missing, 1024);
    expect(result).toEqual({
      totalBytes: 0,
      evictedEntries: 0,
      evictedBytes: 0,
      remainingBytes: 0,
    });
  });

  it("evicts nothing when total is within budget", async () => {
    await writeEntry("a", 100, 1000);
    await writeEntry("b", 100, 2000);

    const result = await sweepImgCache(cacheDir, 10_000);

    expect(result.evictedEntries).toBe(0);
    expect(result.evictedBytes).toBe(0);
    expect(await listKeys()).toEqual(["a", "b"]);
  });

  it("evicts least-recently-used entries (oldest mtime first) until within budget", async () => {
    // Three 1000-byte bodies. Sidecars are tiny but counted too; budget chosen
    // so exactly the two oldest must go.
    await writeEntry("old", 1000, 1000);
    await writeEntry("mid", 1000, 2000);
    await writeEntry("new", 1000, 3000);

    // Keep roughly one entry's worth (~1000 + sidecar). Force eviction of the
    // two oldest.
    const result = await sweepImgCache(cacheDir, 1100);

    expect(result.evictedEntries).toBe(2);
    expect(result.remainingBytes).toBeLessThanOrEqual(1100);
    // Only the newest survives.
    expect(await listKeys()).toEqual(["new"]);
  });

  it("removes both the body and its json sidecar on eviction", async () => {
    await writeEntry("victim", 5000, 1000);

    await sweepImgCache(cacheDir, 1); // tiny budget → evict everything

    const remaining = await fsp.readdir(cacheDir);
    expect(remaining).toEqual([]);
  });

  it("treats maxBytes <= 0 as 'no bound' and evicts nothing", async () => {
    await writeEntry("a", 5000, 1000);
    await writeEntry("b", 5000, 2000);

    const result = await sweepImgCache(cacheDir, 0);

    expect(result.evictedEntries).toBe(0);
    expect(await listKeys()).toEqual(["a", "b"]);
  });

  it("counts a body even when its sidecar is missing", async () => {
    // Orphan body with no .json — should still be sized and evictable.
    const bodyPath = path.join(cacheDir, "orphan.body");
    await fsp.writeFile(bodyPath, Buffer.alloc(4000, 1));
    const when = new Date(1000);
    await fsp.utimes(bodyPath, when, when);

    const result = await sweepImgCache(cacheDir, 1);

    expect(result.evictedEntries).toBe(1);
    expect(await listKeys()).toEqual([]);
  });
});

describe("imgCacheMaxTotalBytes", () => {
  it("defaults to 2 GB when unset", () => {
    delete process.env.IMAGE_CACHE_MAX_TOTAL_BYTES;
    expect(imgCacheMaxTotalBytes()).toBe(2 * 1024 * 1024 * 1024);
  });

  it("honors a valid env override", () => {
    process.env.IMAGE_CACHE_MAX_TOTAL_BYTES = "12345";
    expect(imgCacheMaxTotalBytes()).toBe(12345);
  });

  it("falls back to default on a non-numeric env value", () => {
    process.env.IMAGE_CACHE_MAX_TOTAL_BYTES = "not-a-number";
    expect(imgCacheMaxTotalBytes()).toBe(2 * 1024 * 1024 * 1024);
  });
});

describe("maybeSweepImgCache throttling", () => {
  it("runs at most once within the throttle window", () => {
    __resetImgCacheSweepThrottle();
    const base = 1_000_000;

    // First call at t=base starts a sweep.
    expect(maybeSweepImgCache(cacheDir, 1024, base)).toBe(true);
    // Second call 1 minute later is throttled.
    expect(maybeSweepImgCache(cacheDir, 1024, base + 60_000)).toBe(false);
    // A call past the 5-minute window is allowed again (in-flight guard may
    // still suppress it, but the throttle window itself has elapsed).
    const afterWindow = maybeSweepImgCache(cacheDir, 1024, base + 5 * 60_000 + 1);
    expect(typeof afterWindow).toBe("boolean");
  });

  it("never throws even when the directory is missing", () => {
    __resetImgCacheSweepThrottle();
    const missing = path.join(cacheDir, "nope");
    expect(() => maybeSweepImgCache(missing, 1024, 2_000_000)).not.toThrow();
  });
});
