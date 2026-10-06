// ─── Proxy wire sampler ──────────────────────────────────────────────────────
//
// Measures EXACTLY what the proxy provider bills us for: every TCP byte that
// crosses the wire to/from the proxy gateway host.
//
// Why this exists: `bandwidth-meter` attributes bytes per REQUEST, and it can
// only see what the Node process itself decodes — a decoded JSON body. Two
// blind spots make that number wrong as a bill estimate:
//   1. A browser-lane read launches a real Firefox that loads a full
//      instagram.com page (megabytes of HTML/JS/CSS/media) before it ever
//      issues the API fetch. None of that page load passes through Node.
//   2. HTTP/mobile JSON is counted DECODED; IG gzips ~5-8x on the wire.
// The provider counted ~57 GB over 5 days while the meter reported 7.4 GB.
//
// How: pure-counter iptables rules. A rule with NO `-j` target only increments
// its packet/byte counters and falls through to the next rule — it filters
// nothing and changes no packet's fate. We install one such rule per gateway
// IP in INPUT (-s ip) and OUTPUT (-d ip), then read the counters on a timer and
// persist the DELTA between samples into `proxy_wire_samples`.
//
// This is the headline "billable" number in the admin bandwidth panel;
// `bandwidth_log` remains the per-(user, profile, endpoint) ATTRIBUTION view.
// The two answer different questions and are not expected to match.
//
// Run one instance only: production uses the dedicated wire-metrics entrypoint.
// Disable the sampler in the non-root web process. Kernel counters are host-global;
// two samplers would double-count every byte.
// ────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promises as dnsPromises } from "node:dns";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "../db.js";
import { logger as baseLogger } from "../observability/logger.js";

const execFileAsync = promisify(execFile);
const logger = baseLogger.child({ module: "proxy-wire-sampler" });

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Comment stamped on every rule we own. It is BOTH how we find our rules when
 * reading counters and how we avoid installing a duplicate on restart, so it
 * must stay byte-for-byte stable across deploys.
 */
const RULE_COMMENT = "cheaterfinder-proxy-wire";

/** Seconds iptables waits for the xtables lock before failing. */
const IPTABLES_WAIT_SEC = "5";

const DEFAULT_SAMPLE_SEC = 60;
const MIN_SAMPLE_SEC = 15;

/** Gateway DNS is re-resolved this often; new IPs get rules, old ones stay. */
const RESOLVE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;

/** One warn per failure kind per this window — a broken timer must not spam. */
const WARN_DEDUPE_MS = 10 * 60 * 1000;

/** iptables invocations are bounded so a wedged binary cannot stall the timer. */
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

type Chain = "INPUT" | "OUTPUT";

/** INPUT matches on source (bytes FROM the gateway), OUTPUT on destination. */
const CHAIN_MATCH_FLAG: Record<Chain, "-s" | "-d"> = {
  INPUT: "-s",
  OUTPUT: "-d",
};

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

export interface WireCounters {
  readonly in: number;
  readonly out: number;
}

/**
 * Sum the byte counters of OUR rules in an `iptables -L <chain> -v -x -n` dump.
 *
 * Columns are `pkts bytes target prot opt in out source destination [extra]`.
 * Our rules have NO target, so the third column is the protocol rather than a
 * target name — which is exactly why this parses positionally from the LEFT
 * (bytes is always the 2nd whitespace-separated token) instead of trying to
 * identify columns by content. Lines that do not carry our comment, and lines
 * whose first token is not a number (headers), are ignored.
 */
export function parseIptablesCounters(text: string): number {
  let total = 0;
  for (const rawLine of text.split("\n")) {
    if (!rawLine.includes(RULE_COMMENT)) continue;
    const tokens = rawLine.trim().split(/\s+/);
    if (tokens.length < 2) continue;
    const packets = Number(tokens[0]);
    const bytes = Number(tokens[1]);
    if (!Number.isFinite(packets) || !Number.isFinite(bytes)) continue;
    if (bytes < 0) continue;
    total += bytes;
  }
  return total;
}

/**
 * Delta between two counter readings.
 *
 * Contract:
 *   - `prev === null` (first reading after boot) → `{ in: 0, out: 0 }`. The
 *     caller treats this as a BASELINE and persists no row: the absolute
 *     counter at boot covers an unknown span (it may have been accumulating
 *     since the last reboot) and attributing it to one sample window would
 *     spike the report.
 *   - A counter that went DOWN means the kernel counters were reset (reboot,
 *     `iptables -Z`, rules re-created). The current total IS the traffic since
 *     that reset, so it is returned as-is rather than clamped to 0 — losing a
 *     little precision on the reset window beats losing the window entirely.
 *   - Otherwise the ordinary `cur - prev`.
 * Each direction is judged independently; a reset affects both in practice but
 * nothing guarantees it.
 */
export function computeSampleDelta(
  prev: WireCounters | null,
  cur: WireCounters,
): WireCounters {
  if (!prev) return { in: 0, out: 0 };
  return {
    in: cur.in < prev.in ? cur.in : cur.in - prev.in,
    out: cur.out < prev.out ? cur.out : cur.out - prev.out,
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

function samplerEnabled(): boolean {
  const raw = (process.env.PROXY_WIRE_SAMPLER_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

function sampleIntervalMs(): number {
  const raw = Number(process.env.PROXY_WIRE_SAMPLE_SEC ?? String(DEFAULT_SAMPLE_SEC));
  const sec = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SAMPLE_SEC;
  return Math.max(MIN_SAMPLE_SEC, Math.round(sec)) * 1000;
}

function gatewayHost(): string {
  return (process.env.PROXY_GATEWAY_HOST ?? "").trim();
}

function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// ─── Mutable sampler state ────────────────────────────────────────────────────

let started = false;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let resolveTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let previous: WireCounters | null = null;
let lastSampleAtMs: number | null = null;
let activeSample: Promise<void> | null = null;
let bootstrapWork: Promise<void> | null = null;
let retrySample: { key: string; delta: WireCounters; counters: WireCounters; at: number; span: number } | null = null;
const maintenance = new Set<Promise<unknown>>();
let ensured = false;
/** Gateway host the running sampler is bound to; null until bootstrap passes. */
let gatewayHostInUse: string | null = null;

const installedIps = new Set<string>();
const lastWarnAtMs = new Map<string, number>();

function warnThrottled(code: string, fields: Record<string, unknown>, msg: string): void {
  const now = Date.now();
  const last = lastWarnAtMs.get(code) ?? 0;
  if (now - last < WARN_DEDUPE_MS) return;
  lastWarnAtMs.set(code, now);
  logger.warn(fields, msg);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Storage ──────────────────────────────────────────────────────────────────

/**
 * Create the sample table if it is missing. Mirrors migration
 * 0047_proxy_wire_samples.sql exactly, so a boot on a database where the
 * migration has not been applied yet still records samples instead of throwing
 * every minute. Keep the two definitions in sync.
 */
async function ensureTable(): Promise<void> {
  if (ensured) return;
  const existing = await db.execute(sql`SELECT to_regclass('public.proxy_wire_samples') IS NOT NULL AS present`);
  const existingRows = Array.isArray(existing) ? existing : existing.rows;
  if (existingRows[0]?.present) { ensured = true; return; }
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS proxy_wire_samples (
      id BIGSERIAL PRIMARY KEY,
      sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bytes_in BIGINT NOT NULL DEFAULT 0,
      bytes_out BIGINT NOT NULL DEFAULT 0,
      span_seconds INTEGER NOT NULL DEFAULT 0
      , sample_key UUID UNIQUE
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS proxy_wire_samples_sampled_at_idx
      ON proxy_wire_samples (sampled_at)
  `);
  ensured = true;
}

async function insertSample(sample: NonNullable<typeof retrySample>): Promise<void> {
  await ensureTable();
  await db.execute(sql`
    INSERT INTO proxy_wire_samples (sampled_at, bytes_in, bytes_out, span_seconds, sample_key)
    VALUES (${new Date(sample.at)}, ${sample.delta.in}, ${sample.delta.out}, ${sample.span}, ${sample.key}::uuid)
    ON CONFLICT(sample_key) DO NOTHING
  `);
}

async function pruneOld(): Promise<void> {
  try {
    await ensureTable();
    await db.execute(sql`
      DELETE FROM proxy_wire_samples
      WHERE sampled_at < NOW() - (${RETENTION_DAYS} || ' days')::interval
    `);
  } catch (err) {
    warnThrottled("prune", { err: errText(err) }, "proxy wire sample prune failed");
  }
}

// ─── iptables plumbing ────────────────────────────────────────────────────────

async function hasIptables(): Promise<boolean> {
  try {
    await execFileAsync("iptables", ["-V"], { timeout: EXEC_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function checkArgs(chain: Chain, ip: string): string[] {
  return [
    "-w",
    IPTABLES_WAIT_SEC,
    "-C",
    chain,
    CHAIN_MATCH_FLAG[chain],
    ip,
    "-p",
    "tcp",
    "-m",
    "comment",
    "--comment",
    RULE_COMMENT,
  ];
}

function insertArgs(chain: Chain, ip: string): string[] {
  return [
    "-w",
    IPTABLES_WAIT_SEC,
    "-I",
    chain,
    "1",
    CHAIN_MATCH_FLAG[chain],
    ip,
    "-p",
    "tcp",
    "-m",
    "comment",
    "--comment",
    RULE_COMMENT,
  ];
}

/**
 * Install the counting rule for one (chain, ip) if it is not already there.
 * Check-then-insert rather than insert-blindly: pm2 restarts would otherwise
 * stack a duplicate rule per boot and double-count every byte.
 */
async function ensureRule(chain: Chain, ip: string): Promise<boolean> {
  try {
    await execFileAsync("iptables", checkArgs(chain, ip), { timeout: EXEC_TIMEOUT_MS });
    return false; // already present
  } catch {
    // -C exits non-zero when the rule is absent. Fall through and install it.
  }
  await execFileAsync("iptables", insertArgs(chain, ip), { timeout: EXEC_TIMEOUT_MS });
  return true;
}

async function readChainBytes(chain: Chain): Promise<number> {
  const { stdout } = await execFileAsync(
    "iptables",
    ["-w", IPTABLES_WAIT_SEC, "-L", chain, "-v", "-x", "-n"],
    { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
  );
  return parseIptablesCounters(stdout);
}

async function readCounters(): Promise<WireCounters> {
  const [bytesIn, bytesOut] = await Promise.all([
    readChainBytes("INPUT"),
    readChainBytes("OUTPUT"),
  ]);
  return { in: bytesIn, out: bytesOut };
}

/**
 * Resolve the gateway host and make sure both rules exist for every IPv4 it
 * currently points at. Rules for IPs that dropped out of DNS are intentionally
 * LEFT in place: they cost nothing, and removing one would discard the bytes it
 * had counted since the last sample.
 */
async function refreshRules(host: string): Promise<void> {
  const resolved = await dnsPromises.lookup(host, { all: true, family: 4 });
  const ips = resolved.map((entry) => entry.address);
  if (ips.length === 0) {
    warnThrottled("resolve-empty", { host }, "proxy gateway resolved to no IPv4 address");
    return;
  }
  let added = 0;
  for (const ip of ips) {
    const inAdded = await ensureRule("INPUT", ip);
    const outAdded = await ensureRule("OUTPUT", ip);
    if (inAdded || outAdded) added += 1;
    installedIps.add(ip);
  }
  if (added > 0) {
    logger.info(
      { host, ips, newlyRuled: added, totalIps: installedIps.size },
      "proxy wire counter rules installed",
    );
  }
}

// ─── Sampling ─────────────────────────────────────────────────────────────────

function sampleOnce(): Promise<void> {
  if (activeSample) return activeSample;
  activeSample = sampleOwned().finally(() => { activeSample = null; });
  return activeSample;
}

async function commitPendingSample(): Promise<void> {
  if (!retrySample) return;
  await insertSample(retrySample);
  // Commit the baseline only AFTER durable success, including idempotent replay
  // when the first INSERT committed but its response was lost.
  previous = retrySample.counters;lastSampleAtMs = retrySample.at;retrySample = null;
}

async function sampleOwned(): Promise<void> {
  await commitPendingSample();
  // No rules installed means every chain reads 0, and persisting that would
  // render as a confident "0 B billed" in the panel — the exact wrong answer.
  // Retry the install instead (a boot-time DNS blip must not disable the
  // sampler until the 6h refresh) and record nothing this tick.
  if (installedIps.size === 0) {
    if (!gatewayHostInUse) return;
    await refreshRules(gatewayHostInUse);
    if (installedIps.size === 0) return;
  }
  const now = Date.now();
  const cur = await readCounters();
  const isBaseline = previous === null;
  const delta = computeSampleDelta(previous, cur);
  const spanSeconds =
    lastSampleAtMs === null ? 0 : Math.max(0, Math.round((now - lastSampleAtMs) / 1000));
  if (isBaseline) {
    previous = cur;lastSampleAtMs = now;
    logger.info(
      { bytesIn: cur.in, bytesOut: cur.out },
      "proxy wire baseline captured (no row; deltas start next sample)",
    );
    return;
  }
  retrySample = { key: randomUUID(), delta, counters: cur, at: now, span: spanSeconds };
  await commitPendingSample();
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  if (!samplerEnabled()) {
    logger.info("proxy wire sampler disabled via PROXY_WIRE_SAMPLER_ENABLED");
    return;
  }
  const host = gatewayHost();
  if (!host) {
    logger.warn("proxy wire sampler skipped: PROXY_GATEWAY_HOST is not set");
    return;
  }
  if (!isRoot()) {
    logger.warn(
      { uid: process.getuid?.() ?? null },
      "proxy wire sampler skipped: iptables counters require root",
    );
    return;
  }
  if (!(await hasIptables())) {
    logger.warn("proxy wire sampler skipped: iptables binary not available");
    return;
  }

  gatewayHostInUse = host;
  await ensureTable();
  // A failure here (DNS blip, xtables lock contention) must not abort the whole
  // bootstrap: the timers below retry the install, and sampleOnce() refuses to
  // record anything while no rule exists.
  await refreshRules(host).catch((err) =>
    warnThrottled("resolve", { err: errText(err), host }, "initial proxy gateway rule install failed; will retry"),
  );

  const intervalMs = sampleIntervalMs();
  sampleTimer = setInterval(() => {
    void sampleOnce().catch((err) =>
      warnThrottled("sample", { err: errText(err) }, "proxy wire sample failed"),
    );
  }, intervalMs);
  if (typeof sampleTimer.unref === "function") sampleTimer.unref();

  resolveTimer = setInterval(() => {
    const task = refreshRules(host).catch((err) =>
      warnThrottled("resolve", { err: errText(err) }, "proxy gateway rule refresh failed"),
    );
    maintenance.add(task);void task.finally(() => maintenance.delete(task));
  }, RESOLVE_INTERVAL_MS);
  if (typeof resolveTimer.unref === "function") resolveTimer.unref();

  pruneTimer = setInterval(() => {
    const task = pruneOld();maintenance.add(task);void task.finally(() => maintenance.delete(task));
  }, PRUNE_INTERVAL_MS);
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();

  // Take the baseline immediately so the first persisted delta covers one clean
  // interval instead of "boot until the first tick".
  await sampleOnce().catch((err) =>
    warnThrottled("sample", { err: errText(err) }, "proxy wire baseline failed"),
  );

  logger.info(
    { host, intervalMs, ips: Array.from(installedIps) },
    "proxy wire sampler started",
  );
}

/**
 * Start the kernel wire sampler. Idempotent, non-throwing, and safe to call
 * before the database is reachable — every failure path degrades to a warn and
 * leaves the rest of the server untouched.
 */
export function startProxyWireSampler(): void {
  if (started) return;
  started = true;
  bootstrapWork = bootstrap().catch((err) => {
    warnThrottled("bootstrap", { err: errText(err) }, "proxy wire sampler failed to start");
  });
}

/**
 * Stop the timers. The iptables rules are deliberately LEFT INSTALLED: they are
 * inert counters, and keeping them across a restart preserves counter
 * continuity (the next boot re-baselines against the running totals).
 */
function clearSamplerTimers(): void {
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }
  if (resolveTimer) {
    clearInterval(resolveTimer);
    resolveTimer = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

export async function stopProxyWireSampler(): Promise<void> {
  clearSamplerTimers();
  await bootstrapWork;
  clearSamplerTimers(); // bootstrap may have been between await and timer setup
  await Promise.allSettled([...maintenance]);
  await activeSample?.catch(() => {});
  // Called only AFTER HTTP/worker drains: captures the final gateway transfers.
  await sampleOnce();
  gatewayHostInUse = null;started = false;
}

/** Test-only reset of the module's sampling state. */
export function __resetForTests(): void {
  previous = null;
  lastSampleAtMs = null;
  activeSample = null;bootstrapWork = null;retrySample = null;maintenance.clear();
  ensured = false;
  started = false;
  gatewayHostInUse = null;
  installedIps.clear();
  lastWarnAtMs.clear();
}

// Inject counter reads in tests; never shell out to or change host firewall rules.
export const __testing = { sampleOnce, getPending: () => retrySample,
  seedCounters(counters: WireCounters, at: number) { previous = counters;lastSampleAtMs = at;installedIps.add("fixture-only"); } };
