// ─── Per-endpoint 3-strikes auto-disable (Wave 6) ───────────────────────────
//
// Today: an endpoint that returns 401/403/checkpoint_required on bot A makes
// the dispatcher rotate to bot B, which often hits the SAME 401 — and then
// to bot C, also banned, until the entire pool is dead. This module breaks
// that cascade.
//
// Rule:
//   - Auth-class failure on endpoint X by bot A → strike recorded.
//   - Once endpoint X has strikes from 3 DISTINCT bots in the last hour →
//     endpoint X is disabled pool-wide for 24 hours.
//   - Successful call on endpoint X within the rolling window → strikes for
//     that endpoint cleared, and any active disabled row removed.
//
// B7: half-open probe recovery. Because getActiveDisabled() gates EVERY call
// before a bot is even leased, a disabled endpoint could never observe a
// success — one bad proxy/subnet wave used to halt the endpoint family for
// the full 24h until a manual admin re-enable. The disable now behaves like
// a circuit breaker with a half-open state:
//
//   CLOSED    no active endpoint_disabled row. Calls flow; auth-class
//             failures accrue strikes; 3 distinct bots in 1h → OPEN.
//   OPEN      active disabled row, younger than ENDPOINT_DISABLE_PROBE_AFTER_MS
//             (default 30 min). getActiveDisabled() blocks every caller.
//   HALF-OPEN active disabled row whose disabled_at has aged past the probe
//             window. getActiveDisabled() lets exactly ONE caller through —
//             the claim is an atomic conditional UPDATE stamping
//             disabled_at = now (so disabled_at doubles as the probe clock;
//             no schema change needed). Concurrent workers keep seeing the
//             endpoint as disabled.
//               probe success → recordSuccess() deletes the disabled row +
//                 strikes → CLOSED.
//               probe auth-failure → recordStrike() sees the still-active
//                 disabled row, extends it to now + 24h (the cap), and the
//                 next probe is only possible another probe-window later.
//               probe crash / non-auth failure → nothing recorded; the next
//                 probe re-arms after another probe window (self-healing).
//
//   Manual admin re-enable (manualEnableEndpoint) is unchanged: it deletes
//   the disabled row and recent strikes regardless of state.
//
// The wrapper layer (scrape-retry / withBot) is responsible for:
//   - Calling getActiveDisabled() BEFORE making the call. If non-null, throw
//     EndpointDisabledError immediately so callers fail fast — no bot is
//     leased, no budget is consumed, no further strike accrues. (This is the
//     ONLY place probes are claimed; isEndpointDisabled() stays a passive
//     read for admin/diagnostic use and never consumes the probe slot.)
//   - Calling recordSuccess() on 2xx.
//   - Calling recordStrike() on auth-class failures.
//
// All DB writes are best-effort: failures are logged and silently dropped so
// observability never blocks the scrape path itself.
// ─────────────────────────────────────────────────────────────────────────────

import { and, eq, gte, lt, lte, sql } from "drizzle-orm";

import { db } from "../db.js";
import {
  endpointDisabled,
  endpointStrikes,
} from "../../shared/schema.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "endpoint-strikes" });

// ── Tunables ────────────────────────────────────────────────────────────────

/** Rolling window across which strikes from distinct bots are counted. */
const STRIKE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
/** Distinct-bot strike count that flips an endpoint from "risky" to disabled. */
const STRIKE_THRESHOLD = 3;
/** How long an endpoint stays disabled once it crosses the threshold. This is
 *  also the CAP a failed half-open probe extends the disable to (from now). */
const DISABLE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
/** OPEN → HALF-OPEN: once a disable has aged this long, one probe call may
 *  pass. Env-tunable so ops can shorten/lengthen recovery without a deploy. */
const DEFAULT_PROBE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

/** Read at call time (not module load) so ops/tests can re-tune live. */
function probeAfterMs(): number {
  const raw = Number(process.env.ENDPOINT_DISABLE_PROBE_AFTER_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_PROBE_AFTER_MS;
}

// ── Public types ────────────────────────────────────────────────────────────

export class EndpointDisabledError extends Error {
  readonly endpoint: string;
  readonly until: Date;
  readonly reason: string | null;

  constructor(endpoint: string, until: Date, reason: string | null) {
    super(
      `[endpoint-strikes] endpoint "${endpoint}" disabled until ${until.toISOString()}${
        reason ? ` (${reason})` : ""
      }`,
    );
    this.name = "EndpointDisabledError";
    this.endpoint = endpoint;
    this.until = until;
    this.reason = reason;
  }
}

export interface DisabledEndpointInfo {
  readonly endpoint: string;
  readonly disabledAt: Date;
  readonly until: Date;
  readonly reason: string | null;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function normaliseEndpoint(endpoint: string): string {
  return endpoint.trim().toLowerCase();
}

// ── recordStrike ────────────────────────────────────────────────────────────

/**
 * Record a strike against `endpoint` triggered by `botId`. After the insert
 * we count how many DISTINCT bots have struck this endpoint in the last
 * STRIKE_WINDOW_MS — once it crosses STRIKE_THRESHOLD we upsert a row into
 * endpoint_disabled with enabled_again_at = now() + DISABLE_DURATION_MS.
 *
 * `errorReason` is purely informational (stored as the `reason` of the
 * endpoint_disabled row when the threshold flip happens).
 */
export async function recordStrike(
  endpoint: string,
  botId: string,
  errorReason?: string,
): Promise<void> {
  if (!endpoint || !botId) return;
  const normalised = normaliseEndpoint(endpoint);

  try {
    const now = new Date();

    await db
      .insert(endpointStrikes)
      .values({
        endpoint: normalised,
        botId,
        failedAt: now,
      })
      // Composite PK is (endpoint, bot_id, failed_at). failed_at is unique
      // enough at ms granularity that we won't collide, but if we do we just
      // keep the existing row.
      .onConflictDoNothing();

    // B7: half-open probe failure. A strike that lands while an ACTIVE
    // endpoint_disabled row exists can only come from the single half-open
    // probe call (getActiveDisabled gates all other traffic; the rare
    // in-flight call that leased before the disable landed is handled the
    // same way, conservatively). Extend the disable — capped at
    // DISABLE_DURATION_MS from now — and stamp disabledAt = now so the next
    // probe re-arms a full probe window later. The threshold logic below is
    // skipped: the endpoint is already disabled.
    const extended = await db
      .update(endpointDisabled)
      .set({
        disabledAt: now,
        enabledAgainAt: new Date(now.getTime() + DISABLE_DURATION_MS),
        reason:
          `half-open probe failed` +
          (errorReason ? ` (${errorReason})` : "") +
          `; disable extended`,
      })
      .where(
        and(
          eq(endpointDisabled.endpoint, normalised),
          gte(endpointDisabled.enabledAgainAt, now),
        ),
      )
      .returning({ endpoint: endpointDisabled.endpoint });

    if (extended.length > 0) {
      logger.error(
        {
          endpoint: normalised,
          botId,
          errorReason,
          enabledAgainAt: new Date(
            now.getTime() + DISABLE_DURATION_MS,
          ).toISOString(),
        },
        "[endpoint-strikes] half-open probe FAILED — disable extended",
      );
      return;
    }

    const cutoff = new Date(now.getTime() - STRIKE_WINDOW_MS);

    const [{ distinctBots }] = await db
      .select({
        distinctBots: sql<number>`COUNT(DISTINCT ${endpointStrikes.botId})::int`,
      })
      .from(endpointStrikes)
      .where(
        and(
          eq(endpointStrikes.endpoint, normalised),
          gte(endpointStrikes.failedAt, cutoff),
        ),
      );

    const distinct = Number(distinctBots ?? 0);

    logger.warn(
      { endpoint: normalised, botId, errorReason, distinctBots: distinct },
      "[endpoint-strikes] strike recorded",
    );

    if (distinct >= STRIKE_THRESHOLD) {
      const enabledAgainAt = new Date(now.getTime() + DISABLE_DURATION_MS);
      const reason =
        `${distinct} distinct bots failed in last hour` +
        (errorReason ? ` (last: ${errorReason})` : "");

      await db
        .insert(endpointDisabled)
        .values({
          endpoint: normalised,
          disabledAt: now,
          enabledAgainAt,
          reason,
        })
        .onConflictDoUpdate({
          target: endpointDisabled.endpoint,
          set: {
            disabledAt: now,
            enabledAgainAt,
            reason,
          },
        });

      logger.error(
        {
          endpoint: normalised,
          distinctBots: distinct,
          enabledAgainAt: enabledAgainAt.toISOString(),
        },
        "[endpoint-strikes] endpoint DISABLED pool-wide",
      );
    }
  } catch (err) {
    logger.warn(
      {
        endpoint: normalised,
        botId,
        err: err instanceof Error ? err.message : String(err),
      },
      "[endpoint-strikes] recordStrike failed",
    );
  }
}

// ── recordSuccess ───────────────────────────────────────────────────────────

/**
 * Successful call on `endpoint` resets its strike accounting:
 *   - Delete strikes inside the rolling window.
 *   - Delete any active endpoint_disabled row.
 *
 * We deliberately keep strikes that are OUTSIDE the rolling window — they
 * couldn't influence the threshold anyway, and leaving them lets ops query
 * historical strike rates if useful.
 */
export async function recordSuccess(endpoint: string): Promise<void> {
  if (!endpoint) return;
  const normalised = normaliseEndpoint(endpoint);

  try {
    const cutoff = new Date(Date.now() - STRIKE_WINDOW_MS);

    await db
      .delete(endpointStrikes)
      .where(
        and(
          eq(endpointStrikes.endpoint, normalised),
          gte(endpointStrikes.failedAt, cutoff),
        ),
      );

    await db
      .delete(endpointDisabled)
      .where(eq(endpointDisabled.endpoint, normalised));
  } catch (err) {
    logger.warn(
      {
        endpoint: normalised,
        err: err instanceof Error ? err.message : String(err),
      },
      "[endpoint-strikes] recordSuccess failed",
    );
  }
}

// ── isEndpointDisabled ──────────────────────────────────────────────────────

/**
 * Returns the active disabled row for `endpoint` if one exists with
 * enabled_again_at still in the future, otherwise null. Used by the gated
 * check in withBot()/runWithLease so the thrown EndpointDisabledError can
 * carry the correct `until`/`reason` payload.
 *
 * B7: this is also where half-open probes are claimed. Once the disable has
 * aged past probeAfterMs(), exactly ONE caller gets null back (its call
 * proceeds as the probe); everyone else keeps seeing the disable. The claim
 * is a conditional UPDATE stamping disabled_at = now — only one concurrent
 * statement can transition the row from "older than the probe window" to
 * "now" (the row lock serializes them and the losers' WHERE re-check fails),
 * so workers can't stampede the endpoint. After a claim, disabled_at being
 * fresh keeps further probes out for another full window, even if the probe
 * call crashes without recording an outcome.
 */
export async function getActiveDisabled(
  endpoint: string,
): Promise<DisabledEndpointInfo | null> {
  if (!endpoint) return null;
  const normalised = normaliseEndpoint(endpoint);

  try {
    const now = new Date();

    const [row] = await db
      .select()
      .from(endpointDisabled)
      .where(
        and(
          eq(endpointDisabled.endpoint, normalised),
          gte(endpointDisabled.enabledAgainAt, now),
        ),
      )
      .limit(1);

    if (row) {
      const probeCutoff = new Date(now.getTime() - probeAfterMs());
      if (row.disabledAt.getTime() <= probeCutoff.getTime()) {
        const claimed = await db
          .update(endpointDisabled)
          .set({ disabledAt: now })
          .where(
            and(
              eq(endpointDisabled.endpoint, normalised),
              lte(endpointDisabled.disabledAt, probeCutoff),
              gte(endpointDisabled.enabledAgainAt, now),
            ),
          )
          .returning({ endpoint: endpointDisabled.endpoint });

        if (claimed.length > 0) {
          logger.warn(
            {
              endpoint: normalised,
              disabledSince: row.disabledAt.toISOString(),
              until: row.enabledAgainAt.toISOString(),
            },
            "[endpoint-strikes] half-open probe claimed — allowing one call through",
          );
          return null;
        }
      }
      return {
        endpoint: row.endpoint,
        disabledAt: row.disabledAt,
        until: row.enabledAgainAt,
        reason: row.reason,
      };
    }

    // Lazy GC: drop expired rows for this endpoint so the table stays small.
    await db
      .delete(endpointDisabled)
      .where(
        and(
          eq(endpointDisabled.endpoint, normalised),
          lt(endpointDisabled.enabledAgainAt, now),
        ),
      );

    return null;
  } catch (err) {
    logger.warn(
      {
        endpoint: normalised,
        err: err instanceof Error ? err.message : String(err),
      },
      "[endpoint-strikes] getActiveDisabled query failed; failing open",
    );
    return null;
  }
}

/**
 * True iff `endpoint` has a row in endpoint_disabled with enabled_again_at
 * still in the future. As a side effect, expired disabled rows are removed
 * lazily so the next caller starts with a clean slate.
 */
export async function isEndpointDisabled(endpoint: string): Promise<boolean> {
  if (!endpoint) return false;
  const normalised = normaliseEndpoint(endpoint);

  try {
    const now = new Date();

    const [active] = await db
      .select({ endpoint: endpointDisabled.endpoint })
      .from(endpointDisabled)
      .where(
        and(
          eq(endpointDisabled.endpoint, normalised),
          gte(endpointDisabled.enabledAgainAt, now),
        ),
      )
      .limit(1);

    if (active) return true;

    // Lazy GC: drop expired rows for this endpoint so the table stays small.
    await db
      .delete(endpointDisabled)
      .where(
        and(
          eq(endpointDisabled.endpoint, normalised),
          lt(endpointDisabled.enabledAgainAt, now),
        ),
      );

    return false;
  } catch (err) {
    logger.warn(
      {
        endpoint: normalised,
        err: err instanceof Error ? err.message : String(err),
      },
      "[endpoint-strikes] isEndpointDisabled query failed; failing open",
    );
    // Fail open: if we can't read the table, do not block traffic.
    return false;
  }
}

// ── getDisabledEndpoints (admin) ────────────────────────────────────────────

/**
 * List endpoints currently disabled (enabled_again_at > now()). Used by the
 * admin UI to surface why traffic is paused on a given endpoint.
 */
export async function getDisabledEndpoints(): Promise<
  ReadonlyArray<DisabledEndpointInfo>
> {
  const now = new Date();

  const rows = await db
    .select()
    .from(endpointDisabled)
    .where(gte(endpointDisabled.enabledAgainAt, now));

  return rows.map((r) => ({
    endpoint: r.endpoint,
    disabledAt: r.disabledAt,
    until: r.enabledAgainAt,
    reason: r.reason,
  }));
}

// ── manualEnable (admin) ────────────────────────────────────────────────────

/**
 * Force-enable an endpoint by deleting its endpoint_disabled row AND clearing
 * recent strikes so it doesn't immediately re-disable on the next failure.
 * Returns true if a row was actually removed.
 */
export async function manualEnableEndpoint(endpoint: string): Promise<boolean> {
  if (!endpoint) return false;
  const normalised = normaliseEndpoint(endpoint);

  const removed = await db
    .delete(endpointDisabled)
    .where(eq(endpointDisabled.endpoint, normalised))
    .returning({ endpoint: endpointDisabled.endpoint });

  // Also wipe rolling-window strikes so the operator's intervention sticks.
  const cutoff = new Date(Date.now() - STRIKE_WINDOW_MS);
  await db
    .delete(endpointStrikes)
    .where(
      and(
        eq(endpointStrikes.endpoint, normalised),
        gte(endpointStrikes.failedAt, cutoff),
      ),
    );

  return removed.length > 0;
}

// ── Constants exposed for tests ─────────────────────────────────────────────

export const __TESTING__ = {
  STRIKE_WINDOW_MS,
  STRIKE_THRESHOLD,
  DISABLE_DURATION_MS,
  DEFAULT_PROBE_AFTER_MS,
  probeAfterMs,
  normaliseEndpoint,
};
