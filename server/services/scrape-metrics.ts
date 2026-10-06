// ─── Scrape outcome metrics (in-memory, rolling 24h window) ─────────────────
//
// Lightweight ephemeral counters that the admin /health endpoint reads to
// surface per-endpoint success rates without paying a DB scan. We also fire
// a non-blocking insert into `scrape_outcome_log` so persistent history is
// available for v2 dashboards / SLO calculations.
//
// Design notes:
//   - One bucket per (endpoint, outcome). Counters reset on a rolling 24h
//     window via a Map of windowed entries — we keep totals plus a list of
//     "events" tagged with timestamps so prune() can drop expired ones.
//   - "kind" mirrors the upstream IG signal: success / failure (general) /
//     checkpoint (IG security challenge) / rate_limit (HTTP 429-ish). Only
//     the latter two count as failures for the success-rate calculation but
//     they're surfaced as the `lastErrorKind` so ops can tell ban from glitch.
//   - DB insert is fire-and-forget. If the insert throws, we log and move on
//     so a flaky DB never blocks the scrape path itself.
// ────────────────────────────────────────────────────────────────────────────

import { sql } from "drizzle-orm";

import { db } from "../db.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "scrape-metrics" });

export type ScrapeEndpoint =
  | "profile"
  | "posts"
  | "clips"
  | "tagged"
  | "stories"
  | "highlights"
  | "followers"
  | "following"
  | "comments"
  | "likers"
  | "login";

export type ScrapeOutcomeKind =
  | "success"
  | "failure"
  | "checkpoint"
  | "rate_limit"
  // A transport-level fault reaching Instagram at all: proxy exit died, socket
  // reset, DNS failure, timeout. It counts as a failure exactly like before —
  // only the stored error_kind changes — but it separates "our proxy lane is
  // flaky" from "Instagram is refusing us", which the dashboard could not tell
  // apart while every failure was logged as the generic "failure".
  | "network"
  // The session itself was refused: IGAuthExpiredError (401/403 "auth
  // rejected", missing sessionid/csrftoken) or an IGHttpError 401/403 that is
  // not IG's "please wait" throttle. Counted as a failure like the others; it
  // was previously logged as the generic "failure" and could not be told
  // apart from a parse fault or a target-side 404 (audit D5, 2026-09-03).
  | "auth"
  // A local decision NOT to call Instagram (per-bot daily cap exhausted, or the
  // endpoint temporarily disabled by strikes). This is not a scrape outcome: no
  // IG request was made, so it must never inflate the failure rate or the
  // scrape_outcome_log 'failure' count. Tracked as an informational counter and
  // never persisted.
  | "skip";

export interface EndpointSnapshot {
  readonly endpoint: ScrapeEndpoint;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  /** Local skips (daily-cap / disabled). Not counted in attempts. */
  readonly skips: number;
  readonly lastErrorKind: ScrapeOutcomeKind | null;
}

export interface MetricsSnapshot {
  readonly windowMs: number;
  readonly endpoints: ReadonlyArray<EndpointSnapshot>;
}

interface OutcomeEvent {
  readonly endpoint: ScrapeEndpoint;
  readonly kind: ScrapeOutcomeKind;
  readonly at: number;
}

const ENDPOINTS: ReadonlyArray<ScrapeEndpoint> = [
  "profile",
  "posts",
  "clips",
  "tagged",
  "stories",
  "highlights",
  "followers",
  "following",
  "comments",
  "likers",
  "login",
];

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Bounded ring of recent events. Even at 100 calls/sec, 24h = ~8.6M which
// would balloon memory. We cap at 200k events (~50 RPS sustained) and drop
// the oldest. Rolled aggregates stay correct because we also maintain the
// per-endpoint totals (which only get decremented on prune).
const MAX_EVENTS = 200_000;

interface EndpointBucket {
  attempts: number;
  successes: number;
  failures: number;
  skips: number;
  lastErrorKind: ScrapeOutcomeKind | null;
}

function emptyBucket(): EndpointBucket {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    skips: 0,
    lastErrorKind: null,
  };
}

// INVARIANT: `events` is ascending by `at`. recordOutcome appends with
// Date.now(); hydrateFromOutcomeLog MERGES replayed rows into position instead
// of appending them after live events (D9). pruneOldEvents relies on this and
// stops at the first event still inside the window.
let events: OutcomeEvent[] = [];
const buckets: Map<ScrapeEndpoint, EndpointBucket> = new Map(
  ENDPOINTS.map((e) => [e, emptyBucket()] as const),
);

function isFailure(kind: ScrapeOutcomeKind): boolean {
  return kind !== "success";
}

/** Add one ring event's contribution to its endpoint bucket. */
function admitEvent(ev: OutcomeEvent): void {
  const bucket = buckets.get(ev.endpoint) ?? emptyBucket();
  if (!buckets.has(ev.endpoint)) buckets.set(ev.endpoint, bucket);
  bucket.attempts += 1;
  if (isFailure(ev.kind)) {
    bucket.failures += 1;
    bucket.lastErrorKind = ev.kind;
  } else {
    bucket.successes += 1;
  }
}

/** Remove one ring event's contribution from its endpoint bucket (prune / ring drop). */
function releaseEvent(ev: OutcomeEvent): void {
  const bucket = buckets.get(ev.endpoint);
  if (!bucket) return;
  bucket.attempts = Math.max(0, bucket.attempts - 1);
  if (isFailure(ev.kind)) {
    bucket.failures = Math.max(0, bucket.failures - 1);
  } else {
    bucket.successes = Math.max(0, bucket.successes - 1);
  }
}

/**
 * Recompute every bucket's ring-derived counters from `events`. `skips` are
 * untouched: they never enter the ring. Used once after hydration so the
 * buckets are exact for the merged ring (including `lastErrorKind`, which
 * must be the newest failure by `at`, not the last one admitted).
 */
function rebuildBucketsFromEvents(): void {
  for (const bucket of buckets.values()) {
    bucket.attempts = 0;
    bucket.successes = 0;
    bucket.failures = 0;
    bucket.lastErrorKind = null;
  }
  for (const ev of events) admitEvent(ev);
}

/** Merge two `at`-ascending arrays into a new `at`-ascending array (stable: `a` first on ties). */
function mergeAscendingByAt(
  a: ReadonlyArray<OutcomeEvent>,
  b: ReadonlyArray<OutcomeEvent>,
): OutcomeEvent[] {
  const out: OutcomeEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    out.push(a[i].at <= b[j].at ? a[i++] : b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

function pruneOldEvents(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (events.length > 0 && events[0].at < cutoff) {
    const ev = events.shift();
    if (!ev) break;
    releaseEvent(ev);
  }
}

function persistOutcome(
  endpoint: ScrapeEndpoint,
  kind: ScrapeOutcomeKind,
  botId: string | null,
): void {
  // Fire-and-forget — never block the scrape on this insert.
  void db
    .execute(
      sql`
        INSERT INTO scrape_outcome_log (bot_id, endpoint, outcome, error_kind, occurred_at)
        VALUES (${botId}, ${endpoint}, ${kind === "success" ? "success" : "failure"}, ${
          kind === "success" ? null : kind
        }, NOW())
      `,
    )
    .catch((err: unknown) => {
      logger.warn(
        { endpoint, kind, err: err instanceof Error ? err.message : String(err) },
        "scrape_outcome_log insert failed",
      );
    });
}

/**
 * Record a scrape outcome. Updates rolling counters synchronously and fires
 * a non-blocking persistent insert.
 */
export function recordOutcome(
  endpoint: ScrapeEndpoint,
  kind: ScrapeOutcomeKind,
  botId: string | null = null,
): void {
  const now = Date.now();
  pruneOldEvents(now);

  // A skip is not a scrape attempt — no IG request was made. Count it for
  // observability only: it never enters the rolling event ring, never touches
  // attempts/successes/failures, and is never persisted to scrape_outcome_log.
  if (kind === "skip") {
    const bucket = buckets.get(endpoint) ?? emptyBucket();
    if (!buckets.has(endpoint)) buckets.set(endpoint, bucket);
    bucket.skips += 1;
    return;
  }

  if (events.length >= MAX_EVENTS) {
    // Drop oldest to keep memory bounded.
    const dropped = events.shift();
    if (dropped) releaseEvent(dropped);
  }

  const ev: OutcomeEvent = { endpoint, kind, at: now };
  events.push(ev);
  admitEvent(ev);

  persistOutcome(endpoint, kind, botId);
}

/**
 * Read the current rolling-24h snapshot. Always returns one row per known
 * endpoint, even if nothing has been recorded for it yet — keeps the UI
 * stable across cold starts.
 */
export function getSnapshot(): MetricsSnapshot {
  pruneOldEvents(Date.now());
  const out: EndpointSnapshot[] = ENDPOINTS.map((endpoint) => {
    const bucket = buckets.get(endpoint) ?? emptyBucket();
    return {
      endpoint,
      attempts: bucket.attempts,
      successes: bucket.successes,
      failures: bucket.failures,
      skips: bucket.skips,
      lastErrorKind: bucket.lastErrorKind,
    };
  });
  return { windowMs: WINDOW_MS, endpoints: out };
}

/** Test-only reset (kept simple — not exported via index). */
/** Map a persisted scrape_outcome_log row back to the in-memory outcome kind. */
export function outcomeRowToKind(outcome: string, errorKind: string | null): ScrapeOutcomeKind {
  if (outcome === "success") return "success";
  if (
    errorKind === "checkpoint" ||
    errorKind === "rate_limit" ||
    errorKind === "network" ||
    errorKind === "auth"
  ) {
    return errorKind;
  }
  return "failure";
}

let hydrated = false;

/**
 * Rebuild the 24h window from `scrape_outcome_log` at boot.
 *
 * The buckets above live in process memory, so every restart emptied the
 * "Endpoint Success Rate (24h)" panel — on 2026-09-02 eleven deploys left it
 * reading 0/0 for most of the day while the log held 12k outcomes. Rows are
 * replayed oldest-first into the same ring (newest MAX_EVENTS kept) without
 * re-persisting them. Local skips are not persisted and start at zero.
 *
 * D9: outcomes recorded live while the SELECT is in flight are already in
 * `events` (all `at >= now`). Replayed rows (all `at <= now`) are merged into
 * position by `at`, never appended after them — otherwise the oldest replayed
 * row sat behind a newer live one, `pruneOldEvents` stopped at the live row,
 * and 24 h-old rows overstayed until the live row itself expired. The query
 * is bounded above by `now` so a live outcome's own insert is never replayed
 * on top of its in-memory record.
 */
export async function hydrateFromOutcomeLog(now: number = Date.now()): Promise<number> {
  if (hydrated || events.length > 0) return 0;
  hydrated = true;
  const since = new Date(now - WINDOW_MS);
  const until = new Date(now);
  const result = (await db.execute(sql`
    SELECT endpoint, outcome, error_kind, occurred_at
      FROM scrape_outcome_log
     WHERE occurred_at > ${since}
       AND occurred_at <= ${until}
     ORDER BY occurred_at DESC
     LIMIT ${MAX_EVENTS}
  `)) as unknown as {
    rows: Array<{ endpoint: string; outcome: string; error_kind: string | null; occurred_at: string | Date }>;
  };
  // Query order is newest-first; walk it backwards so `replayed` is ascending.
  const replayed: OutcomeEvent[] = [];
  for (let i = result.rows.length - 1; i >= 0; i--) {
    const row = result.rows[i];
    if (!(ENDPOINTS as readonly string[]).includes(row.endpoint)) continue;
    const at = new Date(row.occurred_at).getTime();
    if (!Number.isFinite(at)) continue;
    replayed.push({
      endpoint: row.endpoint as ScrapeEndpoint,
      kind: outcomeRowToKind(row.outcome, row.error_kind),
      at,
    });
  }
  const live = events;
  const merged = mergeAscendingByAt(replayed, live);
  // Ring cap: keep the newest MAX_EVENTS, exactly as recordOutcome would.
  events = merged.length > MAX_EVENTS ? merged.slice(merged.length - MAX_EVENTS) : merged;
  rebuildBucketsFromEvents();
  return replayed.length;
}

export function __resetForTests(): void {
  hydrated = false;
  events.length = 0;
  for (const endpoint of ENDPOINTS) {
    buckets.set(endpoint, emptyBucket());
  }
}
