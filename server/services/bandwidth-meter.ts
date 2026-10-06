// ─── Bandwidth meter ────────────────────────────────────────────────────────
//
// Attributes every outbound IG request's transferred bytes to (user, tracked
// profile, endpoint) so the admin panel can answer: "which profile and which
// user is consuming how much scraping bandwidth?".
//
// Design:
//   - An AsyncLocalStorage carries the active scrape context (whose account is
//     being refreshed) down through the collector → ig-http-client call stack.
//     The HTTP layer never needs to know about users; it just calls
//     recordBytes() and the current context is picked up implicitly.
//   - Requests fired outside any scrape context (bot login, warm-up, cooldown
//     probes) attribute to a synthetic "system" bucket (userId = null).
//   - Counters accumulate in-memory keyed by (userId|trackedAccountId|endpoint)
//     and flush to `bandwidth_log` on a timer. We aggregate per flush window
//     instead of inserting per-request to keep write volume low even under a
//     heavy refresh sweep.
//
// Accuracy note — this table is ATTRIBUTION, not a bill. Two different units
// live in it, and the UI says so:
//   - Browser-lane rows carry TRUE WIRE BYTES when the automation service
//     reports them: the encoded transfer of the ENTIRE Firefox launch (the full
//     instagram.com page load plus the API fetch), which is what a browser read
//     actually costs. Node never sees that page load, so before this it counted
//     as zero — the single largest reason the panel under-reported.
//   - HTTP/mobile rows stay DECODED payload: `bytesIn` is the post-gzip/br body
//     and `bytesOut` is request URL + body + a fixed header overhead estimate.
//     IG gzips ~5-8x, so those rows over-state their own transfer.
// A per-endpoint or per-profile total is therefore a mix of the two and is only
// meaningful as a RELATIVE "who is heaviest" signal.
//
// The absolute, billable number is measured outside Node entirely: kernel
// iptables byte counters on the proxy gateway, sampled into `proxy_wire_samples`
// by services/proxy-wire-sampler.ts and surfaced as `report.wire`. When the two
// disagree, the wire figure is the one the provider invoices.
// ────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { currentScrapeOperation } from "./scrape-operation.js";

import { sql } from "drizzle-orm";

import { db } from "../db.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "bandwidth-meter" });

export interface ScrapeContext {
  /** Owner of the tracked account, or null for system traffic. */
  readonly userId: string | null;
  /** Tracked account being refreshed, or null for system traffic. */
  readonly trackedAccountId: string | null;
  /** IG username of the profile being scraped (denormalized for reports). */
  readonly username: string | null;
}

const SYSTEM_CONTEXT: ScrapeContext = {
  userId: null,
  trackedAccountId: null,
  username: null,
};

const als = new AsyncLocalStorage<ScrapeContext>();

/**
 * Run `fn` with the given scrape context bound. Every IG request fired inside
 * (including nested awaits) is attributed to this user + profile.
 */
export function withScrapeContext<T>(
  ctx: ScrapeContext,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run(ctx, fn);
}

export function getScrapeContext(): ScrapeContext {
  return als.getStore() ?? SYSTEM_CONTEXT;
}

// ─── In-memory accumulator ────────────────────────────────────────────────────

interface BucketKey {
  readonly userId: string | null;
  readonly trackedAccountId: string | null;
  readonly username: string | null;
  readonly endpoint: string;
  readonly byteSource?: string;
  readonly botId?: string | null;
  readonly transport?: string | null;
}

interface BucketTotals {
  bytesIn: number;
  bytesOut: number;
  requests: number;
  failures?: number;
  resourceBytes?: Record<string, number>;
}

function keyString(k: BucketKey): string {
  return `${k.userId ?? "-"}|${k.trackedAccountId ?? "-"}|${k.username ?? "-"}|${k.endpoint}|${k.byteSource ?? "decoded_payload"}|${k.botId ?? "-"}|${k.transport ?? "-"}`;
}

const pending = new Map<string, BucketKey & BucketTotals>();
type Delivery = BucketKey & BucketTotals & { deliveryId: string; occurredAt: Date };
let retryBatch: Delivery[] = [];
let activeFlush: Promise<number> | null = null;
let lastFlushErrorAt: string | null = null;
let lastFlushSuccessAt: string | null = null;

/** Fixed estimate for IG request header weight (UA, cookies, sec-ch-ua, ...). */
const REQUEST_HEADER_OVERHEAD_BYTES = 1500;

// ── Overflow protection ──────────────────────────────────────────────────────
//
// `pending` is drained on a timer (flushBandwidth). If a flush stalls — DB
// outage, a hung pool connection — distinct (user|profile|endpoint) keys keep
// accumulating and the map grows without bound, which is a memory-exhaustion
// vector. We cap the number of DISTINCT keys; once at the cap, further new keys
// fold into a single synthetic "overflow" bucket. Byte totals are NEVER lost —
// only per-key granularity is — so the admin panel's grand totals stay correct
// even while the breakdown degrades. We log a single WARN per overflow episode
// (reset once the map drains back under the cap) to avoid log spam.
const MAX_PENDING_KEYS = Math.max(
  100,
  Number(process.env.BANDWIDTH_MAX_PENDING_KEYS ?? "5000") || 5000,
);

const OVERFLOW_KEY: BucketKey = {
  userId: null,
  trackedAccountId: null,
  username: null,
  endpoint: "__overflow__",
};
const OVERFLOW_KS = keyString(OVERFLOW_KEY);

let overflowWarned = false;

/**
 * Fold a request's bytes into the shared overflow bucket. Preserves byte and
 * request totals; discards only the per-key dimension. Emits one WARN the first
 * time an episode overflows.
 */
function recordOverflow(bytesIn: number, bytesOut: number, failed: boolean, resourceBytes: Record<string, number>): void {
  const existing = pending.get(OVERFLOW_KS);
  if (existing) {
    existing.bytesIn += bytesIn;
    existing.bytesOut += bytesOut;
    existing.requests += 1;
    existing.failures = (existing.failures ?? 0) + Number(failed);
    existing.resourceBytes ??= {};
    for (const [kind, bytes] of Object.entries(resourceBytes)) existing.resourceBytes[kind] = (existing.resourceBytes[kind] ?? 0) + bytes;
  } else {
    pending.set(OVERFLOW_KS, {
      ...OVERFLOW_KEY,
      bytesIn,
      bytesOut,
      requests: 1,
      failures: Number(failed),
      resourceBytes: { ...resourceBytes },
    });
  }
  if (!overflowWarned) {
    overflowWarned = true;
    logger.warn(
      { maxPendingKeys: MAX_PENDING_KEYS },
      "bandwidth meter overflow: pending key cap hit (likely a stalled flush); " +
        "new keys folding into a single overflow bucket — byte totals preserved, " +
        "per-key granularity degraded until the accumulator drains",
    );
  }
}

export interface RecordBytesInput {
  readonly endpoint: string;
  /** Decoded response payload byte length. */
  readonly bytesIn: number;
  /** Request URL + body byte length (header overhead added internally). */
  readonly bytesOut: number;
  readonly byteSource?: "browser_wire" | "decoded_payload";
  readonly botId?: string | null;
  readonly transport?: string | null;
  readonly resourceBytes?: Record<string, number>;
  readonly failed?: boolean;
}

/**
 * Record one request's transfer against the current scrape context. Cheap and
 * synchronous — never blocks the scrape path.
 */
export function recordBytes(input: RecordBytesInput): void {
  const ctx = getScrapeContext();
  const k: BucketKey = {
    userId: ctx.userId,
    trackedAccountId: ctx.trackedAccountId,
    username: ctx.username,
    endpoint: input.endpoint || "other",
    byteSource: input.byteSource ?? "decoded_payload",
    botId: input.botId ?? null,
    transport: input.transport ?? null,
  };
  const ks = keyString(k);
  const existing = pending.get(ks);
  const bytesIn = Number.isFinite(input.bytesIn) ? Math.max(0, input.bytesIn) : 0;
  const bytesOut =
    (Number.isFinite(input.bytesOut) ? Math.max(0, input.bytesOut) : 0) +
    (input.byteSource === "browser_wire" ? 0 : REQUEST_HEADER_OVERHEAD_BYTES);
  const resourceBytes = Object.fromEntries(Object.entries(input.resourceBytes ?? {})
    .filter(([key, value]) => /^[a-z_]{1,32}$/.test(key) && Number.isFinite(value) && value >= 0));
  logger.info({ operationId: currentScrapeOperation()?.id, botId: k.botId,
    trackedAccountId: ctx.trackedAccountId, endpoint: k.endpoint, transport: k.transport,
    byteSource: k.byteSource, bytesIn, bytesOut, failed: input.failed ?? false, resourceBytes },
    "[bandwidth] request attribution");
  if (existing) {
    existing.bytesIn += bytesIn;
    existing.bytesOut += bytesOut;
    existing.requests += 1;
    existing.failures = (existing.failures ?? 0) + Number(input.failed ?? false);
    existing.resourceBytes ??= {};
    for (const [kind, bytes] of Object.entries(resourceBytes)) existing.resourceBytes[kind] = (existing.resourceBytes[kind] ?? 0) + bytes;
    return;
  }
  // New key. If we're already at the distinct-key cap, fold into the overflow
  // bucket instead of growing the map unbounded. (A flush would normally keep
  // this well under the cap; hitting it means flushes are stalled.)
  if (pending.size >= MAX_PENDING_KEYS) {
    recordOverflow(bytesIn, bytesOut, input.failed ?? false, resourceBytes);
    return;
  }
  pending.set(ks, { ...k, bytesIn, bytesOut, requests: 1, failures: Number(input.failed ?? false), resourceBytes });
}

// ─── Persistence ──────────────────────────────────────────────────────────────

let ensured = false;
const RETENTION_DAYS = Math.max(
  1,
  Number(process.env.BANDWIDTH_RETENTION_DAYS ?? "30") || 30,
);

async function ensureTable(): Promise<void> {
  if (ensured) return;
  // Production/test app roles may have DML without ownership. Even CREATE
  // INDEX IF NOT EXISTS requires ownership, so do not run bootstrap DDL for an
  // already-migrated table. Schema/index upgrades belong in migrations.
  const existing = await db.execute(sql`SELECT to_regclass('public.bandwidth_log') IS NOT NULL AS present`);
  if (rowsFrom<{ present: boolean }>(existing)[0]?.present) { ensured = true; return; }
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bandwidth_log (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(36),
      tracked_account_id VARCHAR(36),
      ig_username TEXT,
      endpoint TEXT NOT NULL,
      bytes_in BIGINT NOT NULL DEFAULT 0,
      bytes_out BIGINT NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      byte_source TEXT NOT NULL DEFAULT 'legacy_mixed',
      bot_id VARCHAR(36), transport TEXT,
      failures INTEGER NOT NULL DEFAULT 0,
      resource_bytes JSONB NOT NULL DEFAULT '{}'::jsonb,
      delivery_id UUID UNIQUE,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_bandwidth_log_occurred_at
      ON bandwidth_log (occurred_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_bandwidth_log_user
      ON bandwidth_log (user_id, occurred_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_bandwidth_log_account
      ON bandwidth_log (tracked_account_id, occurred_at)
  `);
  ensured = true;
}

/**
 * Drain the in-memory accumulator into `bandwidth_log`. One row per active
 * (user, profile, endpoint) bucket, stamped with the flush time so the data is
 * naturally time-bucketed for windowed queries. A bounded in-memory retry batch
 * retains failed writes. Stable row identities make ambiguous commit retries
 * idempotent. This is still attribution, NOT a provider invoice or durable WAL.
 */
export function flushBandwidth(): Promise<number> {
  if (activeFlush) return activeFlush;
  activeFlush = drainBandwidth().finally(() => { activeFlush = null; });
  return activeFlush;
}

async function drainBandwidth(): Promise<number> {
  let written = 0;
  try {
    if (retryBatch.length === 0 && pending.size === 0) return 0;
    await ensureTable();
    // At most the previous retry batch and one fresh snapshot per invocation.
    // New traffic never extends this flush indefinitely during shutdown.
    for (let pass = 0; pass < 2; pass += 1) {
      if (!retryBatch.length) {
        if (!pending.size) break;
        const occurredAt = new Date();
        retryBatch = [...pending.values()].map(bucket => ({ ...bucket, deliveryId: randomUUID(), occurredAt }));
        pending.clear();overflowWarned = false;
      }
      while (retryBatch.length) {
        // Below PG's parameter ceiling even with every optional dimension.
        const chunk = retryBatch.slice(0, 1_000);
        const values = chunk.map(b => sql`(${b.userId}, ${b.trackedAccountId}, ${b.username}, ${b.endpoint}, ${b.bytesIn}, ${b.bytesOut}, ${b.requests}, ${b.occurredAt}, ${b.byteSource ?? "mixed_overflow"}, ${b.botId ?? null}, ${b.transport ?? null}, ${b.failures ?? 0}, ${JSON.stringify(b.resourceBytes ?? {})}::jsonb, ${b.deliveryId}::uuid)`);
        await db.execute(sql`INSERT INTO bandwidth_log
          (user_id,tracked_account_id,ig_username,endpoint,bytes_in,bytes_out,requests,occurred_at,byte_source,bot_id,transport,failures,resource_bytes,delivery_id)
          VALUES ${sql.join(values,sql`, `)} ON CONFLICT(delivery_id) DO NOTHING`);
        retryBatch.splice(0,chunk.length);written += chunk.length;
      }
    }
    lastFlushSuccessAt = new Date().toISOString();lastFlushErrorAt = null;
    return written;
  } catch (err) {
    lastFlushErrorAt = new Date().toISOString();
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), retryRows: retryBatch.length, pendingRows: pending.size },
      "bandwidth flush failed; counters retained for idempotent retry",
    );
    return written;
  }
}

async function pruneOld(): Promise<void> {
  try {
    await ensureTable();
    await db.execute(sql`
      DELETE FROM bandwidth_log
      WHERE occurred_at < NOW() - (${RETENTION_DAYS} || ' days')::interval
    `);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "bandwidth prune failed",
    );
  }
}

let flushTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let initialPruneTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.BANDWIDTH_FLUSH_SEC ?? "30") * 1000,
);

/** Delay before the boot-time prune so it stays out of the boot-storm window. */
const INITIAL_PRUNE_DELAY_MS = 5 * 60 * 1000;

/**
 * Start the background flush + prune timers. Idempotent. Call once at
 * server boot (both web and worker processes record bytes).
 *
 * The prune runs once shortly after boot AND on a daily interval: under PM2,
 * restarts more frequent than daily would otherwise mean the 24h interval
 * never fires and the bandwidth_log retention silently stops being enforced.
 */
export function startBandwidthMeter(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushBandwidth();
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === "function") flushTimer.unref();

  // One-shot boot prune. pruneOld() catches and logs its own errors, so a
  // failed prune can never crash the process.
  initialPruneTimer = setTimeout(() => {
    initialPruneTimer = null;
    void pruneOld();
  }, INITIAL_PRUNE_DELAY_MS);
  if (typeof initialPruneTimer.unref === "function") initialPruneTimer.unref();

  pruneTimer = setInterval(
    () => {
      void pruneOld();
    },
    24 * 60 * 60 * 1000,
  );
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();

  logger.info(
    { flushIntervalMs: FLUSH_INTERVAL_MS, retentionDays: RETENTION_DAYS },
    "bandwidth meter started",
  );
}

export async function stopBandwidthMeter(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (initialPruneTimer) {
    clearTimeout(initialPruneTimer);
    initialPruneTimer = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  await flushBandwidth();
  if (retryBatch.length || pending.size) throw new Error("Bandwidth counters remain unflushed; attribution may be incomplete after restart");
}

// ─── Reporting ────────────────────────────────────────────────────────────────

export type BandwidthWindow = "1h" | "24h" | "7d" | "30d";

const WINDOW_INTERVAL: Record<BandwidthWindow, string> = {
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

function intervalFor(window: BandwidthWindow): string {
  return WINDOW_INTERVAL[window] ?? WINDOW_INTERVAL["24h"];
}

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export interface ProfileBandwidthRow {
  trackedAccountId: string | null;
  igUsername: string | null;
  userId: string | null;
  userEmail: string | null;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  requests: number;
}

export interface UserBandwidthRow {
  userId: string | null;
  userEmail: string | null;
  profileCount: number;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  requests: number;
}

export interface EndpointBandwidthRow {
  endpoint: string;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  requests: number;
}

export interface BandwidthTotals {
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  requests: number;
}

/**
 * Kernel-measured gateway transfer for the window — what the proxy provider
 * bills. Independent of `totals`, which is per-request attribution measured
 * inside Node; see the accuracy note at the top of this file.
 */
export interface WireBandwidthTotals {
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  /** Sample rows in the window. 0 = the sampler has not produced a delta yet. */
  samples: number;
  /**
   * Wall seconds those samples cover. Less than the window length means the
   * figure is a FLOOR (sampler installed mid-window, or restarted), not a total.
   */
  coverageSeconds: number;
  /** Oldest sample in the window, or null when there are none. */
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  available: boolean;
}

const EMPTY_WIRE: WireBandwidthTotals = {
  bytesIn: 0,
  bytesOut: 0,
  totalBytes: 0,
  samples: 0,
  coverageSeconds: 0,
  firstSampleAt: null,
  lastSampleAt: null,
  available: true,
};

export interface BandwidthReport {
  window: BandwidthWindow;
  generatedAt: string;
  totals: BandwidthTotals;
  wire: WireBandwidthTotals;
  byProfile: ProfileBandwidthRow[];
  byUser: UserBandwidthRow[];
  byEndpoint: EndpointBandwidthRow[];
  meter: { pendingBuckets: number; retryBuckets: number; lastErrorAt: string | null; lastSuccessAt: string | null };
  counts: { profilesWithTraffic: number; customersWithTraffic: number };
  /** Bounded top-N detail must never masquerade as the entire window. */
  breakdownCoverage: {
    profiles: { shownGroups: number; totalGroups: number; omittedBytes: number; omittedRequests: number };
    customers: { shownGroups: number; totalGroups: number; omittedBytes: number; omittedRequests: number };
  };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isoOrNull(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string" && v.length > 0) {
    const parsed = new Date(v);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * Sum the kernel wire samples covering the window. Deliberately failure-tolerant:
 * `proxy_wire_samples` is written by an optional root-only sampler, so on a host
 * where it never ran (or before migration 0047 is applied) the table may not
 * exist. That must degrade the panel to "measuring…", never 500 the whole
 * bandwidth report.
 */
async function readWireTotals(interval: string): Promise<WireBandwidthTotals> {
  try {
    const raw = await db.execute(sql`
      SELECT
        COALESCE(SUM(bytes_in), 0)::bigint AS bytes_in,
        COALESCE(SUM(bytes_out), 0)::bigint AS bytes_out,
        COUNT(*)::bigint AS samples,
        COALESCE(SUM(span_seconds), 0)::bigint AS coverage_seconds,
        MIN(sampled_at) AS first_sample_at,
        MAX(sampled_at) AS last_sample_at
      FROM proxy_wire_samples
      WHERE sampled_at > NOW() - ${interval}::interval
    `);
    const row = rowsFrom<Record<string, unknown>>(raw)[0];
    if (!row) return EMPTY_WIRE;
    const bytesIn = num(row.bytes_in);
    const bytesOut = num(row.bytes_out);
    return {
      bytesIn,
      bytesOut,
      totalBytes: bytesIn + bytesOut,
      samples: num(row.samples),
      coverageSeconds: num(row.coverage_seconds),
      firstSampleAt: isoOrNull(row.first_sample_at),
      lastSampleAt: isoOrNull(row.last_sample_at),
      available: true,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "proxy wire sample read failed; reporting unavailable measurement",
    );
    return { ...EMPTY_WIRE, available: false };
  }
}

/**
 * Build the full bandwidth report for a window. Flushes pending counters first
 * so the freshly-finished refresh shows up immediately.
 */
export async function getBandwidthReport(
  window: BandwidthWindow = "24h",
): Promise<BandwidthReport> {
  await flushBandwidth();
  await ensureTable();
  const interval = intervalFor(window);

  // A timer flush between these queries must not make profile/user/endpoint
  // sums disagree. All attribution reads share one short read-only snapshot.
  const [byProfileRaw, byUserRaw, byEndpointRaw, countsRaw] = await db.transaction(async tx => {
  const byProfileRaw = await tx.execute(sql`
    SELECT
      b.tracked_account_id AS tracked_account_id,
      MAX(b.ig_username) AS ig_username,
      b.user_id AS user_id,
      MAX(u.email) AS user_email,
      SUM(b.bytes_in)::bigint AS bytes_in,
      SUM(b.bytes_out)::bigint AS bytes_out,
      SUM(b.requests)::bigint AS requests,
      COUNT(*) OVER()::int AS total_groups
    FROM bandwidth_log b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.occurred_at >= NOW() - ${interval}::interval
    GROUP BY b.tracked_account_id, b.user_id
    ORDER BY (SUM(b.bytes_in) + SUM(b.bytes_out)) DESC
    LIMIT 200
  `);

  const byUserRaw = await tx.execute(sql`
    SELECT
      b.user_id AS user_id,
      MAX(u.email) AS user_email,
      COUNT(DISTINCT b.tracked_account_id) AS profile_count,
      SUM(b.bytes_in)::bigint AS bytes_in,
      SUM(b.bytes_out)::bigint AS bytes_out,
      SUM(b.requests)::bigint AS requests,
      COUNT(*) OVER()::int AS total_groups
    FROM bandwidth_log b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.occurred_at >= NOW() - ${interval}::interval
    GROUP BY b.user_id
    ORDER BY (SUM(b.bytes_in) + SUM(b.bytes_out)) DESC
    LIMIT 200
  `);

  const byEndpointRaw = await tx.execute(sql`
    SELECT
      b.endpoint AS endpoint,
      SUM(b.bytes_in)::bigint AS bytes_in,
      SUM(b.bytes_out)::bigint AS bytes_out,
      SUM(b.requests)::bigint AS requests
    FROM bandwidth_log b
    WHERE b.occurred_at >= NOW() - ${interval}::interval
    GROUP BY b.endpoint
    ORDER BY (SUM(b.bytes_in) + SUM(b.bytes_out)) DESC
  `);

  const countsRaw = await tx.execute(sql`SELECT
    COUNT(DISTINCT COALESCE(NULLIF(LOWER(ig_username),''),tracked_account_id)) FILTER (WHERE tracked_account_id IS NOT NULL)::int AS profiles,
    COUNT(DISTINCT user_id)::int AS customers
    FROM bandwidth_log WHERE occurred_at >= NOW() - ${interval}::interval`);
  return [byProfileRaw,byUserRaw,byEndpointRaw,countsRaw] as const;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  const byProfile: ProfileBandwidthRow[] = rowsFrom<Record<string, unknown>>(
    byProfileRaw,
  ).map((r) => {
    const bytesIn = num(r.bytes_in);
    const bytesOut = num(r.bytes_out);
    return {
      trackedAccountId: (r.tracked_account_id as string | null) ?? null,
      igUsername: (r.ig_username as string | null) ?? null,
      userId: (r.user_id as string | null) ?? null,
      userEmail: (r.user_email as string | null) ?? null,
      bytesIn,
      bytesOut,
      totalBytes: bytesIn + bytesOut,
      requests: num(r.requests),
    };
  });

  const byUser: UserBandwidthRow[] = rowsFrom<Record<string, unknown>>(
    byUserRaw,
  ).map((r) => {
    const bytesIn = num(r.bytes_in);
    const bytesOut = num(r.bytes_out);
    return {
      userId: (r.user_id as string | null) ?? null,
      userEmail: (r.user_email as string | null) ?? null,
      profileCount: num(r.profile_count),
      bytesIn,
      bytesOut,
      totalBytes: bytesIn + bytesOut,
      requests: num(r.requests),
    };
  });

  const byEndpoint: EndpointBandwidthRow[] = rowsFrom<Record<string, unknown>>(
    byEndpointRaw,
  ).map((r) => {
    const bytesIn = num(r.bytes_in);
    const bytesOut = num(r.bytes_out);
    return {
      endpoint: (r.endpoint as string | null) ?? "other",
      bytesIn,
      bytesOut,
      totalBytes: bytesIn + bytesOut,
      requests: num(r.requests),
    };
  });

  const wire = await readWireTotals(interval);

  const totals: BandwidthTotals = byEndpoint.reduce(
    (acc, e) => ({
      bytesIn: acc.bytesIn + e.bytesIn,
      bytesOut: acc.bytesOut + e.bytesOut,
      totalBytes: acc.totalBytes + e.totalBytes,
      requests: acc.requests + e.requests,
    }),
    { bytesIn: 0, bytesOut: 0, totalBytes: 0, requests: 0 },
  );

  const coverage = (rows: Array<{ totalBytes: number; requests: number }>, raw: unknown) => ({
    shownGroups: rows.length,
    totalGroups: num(rowsFrom<Record<string,unknown>>(raw)[0]?.total_groups ?? rows.length),
    omittedBytes: Math.max(0, totals.totalBytes - rows.reduce((sum,row) => sum + row.totalBytes, 0)),
    omittedRequests: Math.max(0, totals.requests - rows.reduce((sum,row) => sum + row.requests, 0)),
  });

  return {
    window,
    generatedAt: new Date().toISOString(),
    totals,
    wire,
    byProfile,
    byUser,
    byEndpoint,
    meter: { pendingBuckets: pending.size, retryBuckets: retryBatch.length, lastErrorAt: lastFlushErrorAt, lastSuccessAt: lastFlushSuccessAt },
    counts: { profilesWithTraffic: num(rowsFrom<Record<string,unknown>>(countsRaw)[0]?.profiles), customersWithTraffic: num(rowsFrom<Record<string,unknown>>(countsRaw)[0]?.customers) },
    breakdownCoverage: { profiles: coverage(byProfile,byProfileRaw), customers: coverage(byUser,byUserRaw) },
  };
}

/** Test-only reset. */
export function __resetForTests(): void {
  pending.clear();
  overflowWarned = false;
  retryBatch = [];activeFlush = null;lastFlushErrorAt = null;lastFlushSuccessAt = null;
}

/** Test-only inspection of the live distinct-key count. */
export function __pendingSizeForTests(): number {
  return pending.size;
}
