// ─── IG Circuit Breaker ─────────────────────────────────────────────────────
//
// Wave 2: protects the bot pool from a broken IG. If IG starts returning
// 5xx / schema errors in bulk at 3 AM, workers MUST stop hammering the same
// API with every live session — we burn rate limits and (worse) get whole
// bots banned.
//
// Wave 6: KEYED PER (botId, endpointFamily). The previous incarnation kept
// a single global sample window — a 24h IG-side checkpoint on one bot's
// /followers/ endpoint would saturate the global window with failures, trip
// the breaker, and block every unrelated profile/posts/stories scrape across
// every other bot. The fix: each `${botId}:${endpoint}` pair owns its own
// independent sample window, OPEN/HALF_OPEN/CLOSED state, and openUntil
// timer. Cascading global outages from one bad bot/endpoint pair are no
// longer possible.
//
// Sliding window of last 30 result samples per key; OPEN when failure rate
// > 50% with at least 10 samples. Once OPEN, block for `OPEN_DURATION_MS`
// (60s — was 5 min historically, lowered for self-healing), then a single
// probe is allowed (HALF_OPEN). Success → CLOSED; failure → OPEN again for
// another 60s timer.
//
// In-memory only: each process instance has its own state. For our single-
// server deployment this is correct. If we ever shard workers across boxes
// we'll move state to Redis.
// ─────────────────────────────────────────────────────────────────────────────

import { IGCircuitOpenError } from "./ig-client-port.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
export type BreakerKey = string; // `${botId}:${endpointFamily}`

interface Sample {
  ts: number;
  failed: boolean;
}

interface BreakerState {
  samples: Sample[];
  state: CircuitState;
  openUntil: number;
  halfOpenProbeInFlight: boolean;
}

const WINDOW_SIZE = 30;
const MIN_SAMPLES = 10;
const FAILURE_RATE_THRESHOLD = 0.5;
// Self-healing fix: drop OPEN duration from 5min → 60s. The half-open
// probe is a single call, so a transient IG hiccup recovers within ~60s
// without manual intervention. If IG is truly broken, the failed probe
// re-OPENs the circuit for another 60s — bounded retry until recovery.
const HALF_OPEN_AFTER_MS = 60 * 1000;
const OPEN_DURATION_MS = HALF_OPEN_AFTER_MS;

// Per-key breaker state. Lazily created on first reference.
const breakers: Map<BreakerKey, BreakerState> = new Map();

function ensureKey(key: BreakerKey | undefined): BreakerKey {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(
      "[ig-breaker] breaker key required (`${botId}:${endpointFamily}`); pass a key from every caller",
    );
  }
  return key;
}

function getOrCreate(key: BreakerKey): BreakerState {
  let s = breakers.get(key);
  if (!s) {
    s = {
      samples: [],
      state: "CLOSED",
      openUntil: 0,
      halfOpenProbeInFlight: false,
    };
    breakers.set(key, s);
  }
  return s;
}

function pushSample(s: BreakerState, failed: boolean): void {
  s.samples.push({ ts: Date.now(), failed });
  if (s.samples.length > WINDOW_SIZE) s.samples.shift();
}

function failureRate(s: BreakerState): number {
  if (s.samples.length === 0) return 0;
  const failed = s.samples.reduce((n, x) => n + (x.failed ? 1 : 0), 0);
  return failed / s.samples.length;
}

function maybeTrip(key: BreakerKey, s: BreakerState): void {
  if (s.state !== "CLOSED") return;
  if (s.samples.length < MIN_SAMPLES) return;
  if (failureRate(s) > FAILURE_RATE_THRESHOLD) {
    s.state = "OPEN";
    s.openUntil = Date.now() + OPEN_DURATION_MS;
    console.error(
      `[ig-breaker] OPEN [${key}] — failure rate ${(failureRate(s) * 100).toFixed(1)}% in last ${s.samples.length} samples; blocking until ${new Date(s.openUntil).toISOString()}`,
    );
  }
}

/**
 * Check breaker state for the given key before calling IG. Throws
 * `IGCircuitOpenError` if the breaker for this `(bot, endpoint)` pair is
 * open; returns a `probe` flag when in HALF_OPEN so the caller knows this
 * call is the single probe that decides recovery.
 */
export function assertCanCall(key: BreakerKey): { probe: boolean } {
  const k = ensureKey(key);
  const s = getOrCreate(k);
  const now = Date.now();
  if (s.state === "OPEN") {
    if (now >= s.openUntil) {
      s.state = "HALF_OPEN";
      s.halfOpenProbeInFlight = false;
      console.warn(`[ig-breaker] HALF_OPEN [${k}] — allowing one probe request`);
    } else {
      throw new IGCircuitOpenError(s.openUntil);
    }
  }
  if (s.state === "HALF_OPEN") {
    if (s.halfOpenProbeInFlight) {
      throw new IGCircuitOpenError(s.openUntil);
    }
    s.halfOpenProbeInFlight = true;
    return { probe: true };
  }
  return { probe: false };
}

export function recordSuccess(key: BreakerKey, probe = false): void {
  const k = ensureKey(key);
  const s = getOrCreate(k);
  pushSample(s, false);
  if (s.state === "HALF_OPEN") {
    s.halfOpenProbeInFlight = false;
    if (probe) {
      s.state = "CLOSED";
      s.openUntil = 0;
      s.samples.length = 0;
      console.log(`[ig-breaker] CLOSED [${k}] — probe succeeded, circuit restored`);
    }
  }
}

export function recordFailure(key: BreakerKey, probe = false): void {
  const k = ensureKey(key);
  const s = getOrCreate(k);
  pushSample(s, true);
  if (s.state === "HALF_OPEN") {
    s.halfOpenProbeInFlight = false;
    if (probe) {
      s.state = "OPEN";
      s.openUntil = Date.now() + OPEN_DURATION_MS;
      console.warn(
        `[ig-breaker] OPEN [${k}] — probe failed, blocking until ${new Date(s.openUntil).toISOString()}`,
      );
    }
    return;
  }
  maybeTrip(k, s);
}

/**
 * Decide whether an error counts as a failure for the circuit. Auth errors
 * (per-bot, not IG-wide) and explicit rate-limit errors are NOT IG-wide
 * failures — they're per-session signals the collectors already handle.
 */
export function isBreakerFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "IGAuthExpiredError") return false;
  if (name === "IGRateLimitedError") return false;
  if (name === "IGCircuitOpenError") return false;
  // Bot-side session expiry surfaces as 200+HTML (login wall) or non-JSON parse failure; never global-breaker-trip on it.
  if (name === "IGHttpError") {
    const httpErr = err as { status?: number; message?: string };
    if (httpErr.status === 200) return false;
    if (typeof httpErr.message === "string" && /not JSON|HTML/i.test(httpErr.message)) {
      return false;
    }
  }
  return true; // IGHttpError (non-auth/429), IGSchemaError, network errors, etc.
}

// ─── Endpoint family normalization ─────────────────────────────────────────

const ENDPOINT_FAMILY_PATTERNS: ReadonlyArray<{
  re: RegExp;
  family: string;
}> = [
  { re: /\/api\/v1\/users\/web_profile_info\b/, family: "profile" },
  { re: /\/api\/v1\/feed\/user\/[^/]+\/reel_media\b/, family: "stories" },
  { re: /\/api\/v1\/feed\/user\/[^/]+\/?/, family: "posts" },
  { re: /\/api\/v1\/clips\/user\/?/, family: "posts" },
  { re: /\/api\/v1\/usertags\/[^/]+\/feed\b/, family: "posts" },
  { re: /\/api\/v1\/highlights\/[^/]+\/highlights_tray\b/, family: "highlights" },
  { re: /\/api\/v1\/feed\/reels_media\b/, family: "highlights" },
  { re: /\/api\/v1\/friendships\/[^/]+\/followers\b/, family: "followers" },
  { re: /\/api\/v1\/friendships\/[^/]+\/following\b/, family: "following" },
  { re: /\/api\/v1\/friendships\/show\/[^/]+\/?/, family: "friendship_status" },
  { re: /\/api\/v1\/friendships\/create\/[^/]+\/?/, family: "follow_action" },
  { re: /\/api\/v1\/media\/[^/]+\/comments\b/, family: "comments" },
  { re: /\/api\/v1\/media\/[^/]+\/likers\b/, family: "likers" },
];

/**
 * Map a full IG URL to a normalized endpoint family. Keeps the breaker key
 * cardinality bounded — without normalization, every distinct profile-PK or
 * media-id would create its own key and the per-(bot,endpoint) sample window
 * would never accumulate enough samples to trip.
 *
 * Unrecognised URLs fall back to `"other"`.
 */
import { GRAPHQL_FRIENDSHIP_QUERY_HASH } from "./ig-graphql-queries.js";

export function endpointFamilyFromUrl(url: string): string {
  if (typeof url !== "string" || url.length === 0) return "other";
  try {
    const parsed = new URL(url, "https://www.instagram.com");
    if (parsed.pathname === "/graphql/query" || parsed.pathname === "/graphql/query/") {
      const hash = parsed.searchParams.get("query_hash");
      if (hash === GRAPHQL_FRIENDSHIP_QUERY_HASH.followers) return "followers";
      if (hash === GRAPHQL_FRIENDSHIP_QUERY_HASH.following) return "following";
      return "other";
    }
  } catch { return "other"; }
  // Strip query string before matching so `?count=24` etc. don't interfere.
  const path = url.split("?", 1)[0] ?? url;
  for (const { re, family } of ENDPOINT_FAMILY_PATTERNS) {
    if (re.test(path)) return family;
  }
  return "other";
}

// ── Diagnostics endpoint helpers ───────────────────────────────────────────

export interface BreakerSnapshot {
  state: CircuitState;
  samples: number;
  failureRate: number;
  openUntil: number | null;
}

export interface AggregateBreakerSnapshot {
  // Aggregated rollup across every keyed breaker. `state` is "OPEN" if ANY
  // key is open, else "HALF_OPEN" if any is half-open, else "CLOSED" — this
  // keeps the legacy admin-routes shape working.
  state: CircuitState;
  samples: number;
  failureRate: number;
  openUntil: number | null;
  // Per-key breakdown for ops debugging.
  keys: ReadonlyArray<{ key: BreakerKey } & BreakerSnapshot>;
}

function snapshotOne(s: BreakerState): BreakerSnapshot {
  return {
    state: s.state,
    samples: s.samples.length,
    failureRate: Number(failureRate(s).toFixed(3)),
    openUntil: s.state === "OPEN" ? s.openUntil : null,
  };
}

/**
 * Snapshot a single breaker, or aggregate across all when no key is given.
 * The aggregate shape is backward-compatible with the previous global
 * snapshot for the admin diagnostics route, with an extra `keys` array for
 * per-(bot,endpoint) inspection.
 */
export function getBreakerSnapshot(): AggregateBreakerSnapshot;
export function getBreakerSnapshot(key: BreakerKey): BreakerSnapshot;
export function getBreakerSnapshot(
  key?: BreakerKey,
): BreakerSnapshot | AggregateBreakerSnapshot {
  if (typeof key === "string" && key.length > 0) {
    const s = breakers.get(key);
    if (!s) {
      return { state: "CLOSED", samples: 0, failureRate: 0, openUntil: null };
    }
    return snapshotOne(s);
  }

  const keys: Array<{ key: BreakerKey } & BreakerSnapshot> = [];
  let totalSamples = 0;
  let totalFailures = 0;
  let anyOpenUntil: number | null = null;
  let aggregate: CircuitState = "CLOSED" as CircuitState;

  breakers.forEach((s, k) => {
    const snap = snapshotOne(s);
    keys.push({ key: k, ...snap });
    totalSamples += s.samples.length;
    totalFailures += s.samples.reduce(
      (n: number, x: Sample) => n + (x.failed ? 1 : 0),
      0,
    );
    if (s.state === "OPEN") {
      aggregate = "OPEN";
      if (anyOpenUntil === null || s.openUntil > anyOpenUntil) {
        anyOpenUntil = s.openUntil;
      }
    } else if (s.state === "HALF_OPEN" && aggregate !== "OPEN") {
      aggregate = "HALF_OPEN";
    }
  });

  const aggFailureRate =
    totalSamples === 0 ? 0 : Number((totalFailures / totalSamples).toFixed(3));

  return {
    state: aggregate,
    samples: totalSamples,
    failureRate: aggFailureRate,
    openUntil: aggregate === "OPEN" ? anyOpenUntil : null,
    keys,
  };
}

/**
 * Test / ops hook — let admins force-reset after fixing an incident. With a
 * key, only that breaker is reset. Without a key, every keyed breaker is
 * cleared.
 */
export function resetBreaker(key?: BreakerKey): void {
  if (typeof key === "string" && key.length > 0) {
    breakers.delete(key);
    console.log(`[ig-breaker] manually reset [${key}] to CLOSED`);
    return;
  }
  breakers.clear();
  console.log("[ig-breaker] manually reset ALL keys to CLOSED");
}
