import { and } from "drizzle-orm";
import { customerAccessSql } from "../services/subscription-access.js";
// ─── Per-account refresh registrar ─────────────────────────────────────────
//
// Replaces the old global `refresh-sweep` repeatable (which fanned out a
// profile job for every active tracked_account at once, causing load spikes
// and shared circuit-breaker pollution) with one repeatable per
// tracked_account.
//
// Each active tracked_accounts row owns a BullMQ job scheduler with id
// `account-refresh:<tracked_account_id>` on the `collection-profile` queue.
//
// Phase / staggering: BullMQ v5 does NOT stagger `every` schedulers on its
// own. A fresh scheduler's first tick is `startDate` if that is in the future,
// otherwise `now`, and its phase is then pinned as `firstTick % every` for all
// later iterations (bullmq commands/includes/getJobSchedulerEveryNextMillis.lua,
// re-read by updateJobScheduler on every completion). So N schedulers created
// in one synchronous loop (reconcile on boot) inherit ONE phase and fire within
// milliseconds of each other: a few long roster walks take every
// COLLECTION_PROFILE_CONCURRENCY slot, the rest queue 20-30 min behind them,
// and the burst lands on the same bots' daily caps. To spread them we pass an
// explicit `startDate` whose phase is a stable hash of the account id
// (computeRefreshStartDate), so each account owns a fixed slot inside the
// interval and a rebuild puts it back on the SAME slot.
//
// Lifecycle:
//   - registerAccountRefresh(id):   call after INSERT or reactivation.
//   - unregisterAccountRefresh(id): call after deactivation/delete.
//   - reconcileAccountRefreshes():  call on worker boot. Adds schedulers for
//                                   active rows that don't have one and
//                                   removes orphan schedulers whose row is
//                                   gone or inactive.
//
// All helpers are idempotent — `upsertJobScheduler` with a stable id will
// never create duplicates. `removeJobScheduler` on a missing id is safe.
// ───────────────────────────────────────────────────────────────────────────

import type { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { trackedAccounts } from "../../shared/schema.js";
import { logger } from "../observability/logger.js";
import {
  getCachedRefreshIntervalSec,
  clampRefreshSec,
  DEFAULT_REFRESH_SEC,
} from "../services/refresh-config.js";

/** Stable scheduler-id format. Also used as a prefix when reconciling. */
export const ACCOUNT_REFRESH_PREFIX = "account-refresh:" as const;

/** BullMQ job name for ticks fired by per-account schedulers. */
export const ACCOUNT_REFRESH_JOB_NAME = "account-refresh" as const;

export interface AccountRefreshJobData {
  trackedAccountId: string;
  /** marker so the profile worker can apply the staleness gate */
  source: "account-refresh";
}

export function buildSchedulerId(trackedAccountId: string): string {
  return `${ACCOUNT_REFRESH_PREFIX}${trackedAccountId}`;
}

function parseTrackedAccountId(schedulerId: string): string | null {
  if (!schedulerId.startsWith(ACCOUNT_REFRESH_PREFIX)) return null;
  return schedulerId.slice(ACCOUNT_REFRESH_PREFIX.length);
}

function readIntervalMs(): number {
  // Admin-controlled cadence (system_settings, warmed into a sync cache at
  // boot). Falls back to REFRESH_SWEEP_SEC env / default inside the config
  // service. Bounds are enforced via clampRefreshSec.
  const sec = getCachedRefreshIntervalSec();
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_REFRESH_SEC * 1000;
  return clampRefreshSec(sec) * 1000;
}

/** FNV-1a 32-bit offset basis / prime. */
const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

/**
 * FNV-1a 32-bit hash of a string. Pure and deterministic; used only to derive
 * a stable per-account phase, never for anything security-related. Returns an
 * unsigned 32-bit integer.
 */
export function stableHash(str: string): number {
  let hash = FNV_OFFSET_BASIS_32;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    // Math.imul keeps the multiply inside 32 bits (no float precision loss).
    hash = Math.imul(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

/**
 * Stable phase of an account inside one refresh interval, in milliseconds.
 * A function of (trackedAccountId, every) ONLY — never of the current time —
 * so a reconcile rebuild re-derives the identical slot instead of re-phasing.
 */
export function computeRefreshOffsetMs(
  trackedAccountId: string,
  every: number,
): number {
  if (!Number.isFinite(every) || every <= 0) return 0;
  return stableHash(trackedAccountId) % every;
}

/**
 * The next occurrence of the account's phase STRICTLY after `nowMs`.
 *
 * BullMQ clamps a `startDate` that is not in the future to `now` and then pins
 * the phase as `now % every` — which would silently collapse back to the
 * creation-time burst this exists to prevent. So when this interval's slot has
 * already passed we return the same slot in the next interval. The result is
 * always in (nowMs, nowMs + every] and satisfies `result % every === offsetMs`.
 */
export function computeRefreshStartDate(
  trackedAccountId: string,
  every: number,
  nowMs: number = Date.now(),
): Date {
  if (!Number.isFinite(every) || every <= 0) return new Date(nowMs);
  const offsetMs = computeRefreshOffsetMs(trackedAccountId, every);
  const alignedNow = Math.floor(nowMs / every) * every;
  const candidate = alignedNow + offsetMs;
  return new Date(candidate > nowMs ? candidate : candidate + every);
}

/**
 * Idempotently install the per-account repeatable. Calling twice for the
 * same id is a no-op because BullMQ keys the scheduler by `schedulerId`.
 *
 * `startDate` only sets the phase of a FRESH (or just-rebuilt) scheduler; when
 * the scheduler already exists with the same `every`, BullMQ keeps its current
 * `next` and ignores `startDate`, so re-registering never re-phases an account.
 * Returns false on a queue failure so reconciliation can report the failed
 * repair without undoing an already-saved account in the onboarding caller.
 */
export async function registerAccountRefresh(
  queue: Queue,
  trackedAccountId: string,
): Promise<boolean> {
  const schedulerId = buildSchedulerId(trackedAccountId);
  const every = readIntervalMs();
  const startDate = computeRefreshStartDate(trackedAccountId, every);
  try {
    await queue.upsertJobScheduler(
      schedulerId,
      { every, startDate },
      {
        name: ACCOUNT_REFRESH_JOB_NAME,
        data: {
          trackedAccountId,
          source: "account-refresh",
        } satisfies AccountRefreshJobData,
        opts: {
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 25 },
        },
      },
    );
    logger.debug(
      {
        module: "account-refresh-registrar",
        trackedAccountId,
        every,
        offsetMs: startDate.getTime() % every,
        startDate: startDate.toISOString(),
      },
      "registered per-account refresh scheduler",
    );
    return true;
  } catch (err) {
    logger.error(
      {
        module: "account-refresh-registrar",
        trackedAccountId,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to register per-account refresh scheduler",
    );
    return false;
  }
}

/**
 * Idempotently remove the per-account repeatable. Safe on a missing id.
 */
export async function unregisterAccountRefresh(
  queue: Queue,
  trackedAccountId: string,
): Promise<void> {
  const schedulerId = buildSchedulerId(trackedAccountId);
  try {
    await queue.removeJobScheduler(schedulerId);
    logger.debug(
      { module: "account-refresh-registrar", trackedAccountId },
      "unregistered per-account refresh scheduler",
    );
  } catch (err) {
    logger.error(
      {
        module: "account-refresh-registrar",
        trackedAccountId,
        err: err instanceof Error ? err.message : String(err),
      },
      "failed to unregister per-account refresh scheduler",
    );
  }
}

/**
 * On boot: ensure every active tracked_account has a per-account scheduler,
 * and remove any `account-refresh:*` scheduler whose tracked_account no
 * longer exists or is inactive.
 *
 * Idempotent — safe to run on every worker startup.
 */
export async function reconcileAccountRefreshes(queue: Queue): Promise<{
  added: number;
  removed: number;
  active: number;
}> {
  const active = await db
    .select({ id: trackedAccounts.id })
    .from(trackedAccounts)
    .where(and(eq(trackedAccounts.isActive, true), customerAccessSql(trackedAccounts.userId)));

  const activeIds = new Set(active.map((row) => row.id));

  // Fetch existing schedulers in pages — getJobSchedulers takes [start, end].
  const existingSchedulers = await queue.getJobSchedulers(0, -1, true);

  const existingAccountIds = new Set<string>();
  let removed = 0;
  let failed = 0;
  const desiredEvery = readIntervalMs();
  const now = Date.now();
  // A scheduler whose next-run (`next` = repeat zset score) is overdue by more
  // than this is treated as STALLED and rebuilt. Threshold is generous vs.
  // normal single-worker backlog (3 intervals or 60 min, whichever is larger);
  // a zombie scheduler is typically hours-to-days overdue. See the
  // stalled-scheduler note in the else-branch below.
  const schedulerStaleMs = Math.max(desiredEvery * 3, 60 * 60 * 1000);
  for (const sched of existingSchedulers) {
    const id = sched.key ?? sched.id ?? "";
    const accountId = parseTrackedAccountId(id);
    if (!accountId) continue;
    if (!activeIds.has(accountId)) {
      try {
        await queue.removeJobScheduler(id);
        removed += 1;
      } catch (err) {
        failed += 1;
        logger.error(
          {
            module: "account-refresh-registrar",
            schedulerId: id,
            err: err instanceof Error ? err.message : String(err),
          },
          "failed to remove orphan scheduler",
        );
      }
    } else {
      // Rebuild an existing scheduler when it is unhealthy for either reason:
      //   (1) interval-changed — its `every` no longer matches the configured
      //       cadence; or
      //   (2) STALLED — its next-run is pinned far in the past with no
      //       in-flight job to advance it. BullMQ produces the next iteration
      //       only when the current one is CONSUMED, so if the in-flight job is
      //       lost (worker crash / queue drain during an outage) the scheduler
      //       freezes forever: `ic` and `next` stop moving and no tick ever
      //       reaches the worker again. A healthy, worker-serviced scheduler
      //       keeps `next` within ~`every` of now. Detect the freeze via an
      //       overdue `next` and rebuild. Removing here (without marking the
      //       account as existing) makes the second loop re-register a fresh
      //       scheduler with a fresh delayed job.
      const nextMs = typeof sched.next === "number" ? sched.next : NaN;
      const stalled =
        !Number.isFinite(nextMs) || now - nextMs > schedulerStaleMs;
      const intervalChanged = sched.every !== desiredEvery;
      if (intervalChanged || stalled) {
        try {
          await queue.removeJobScheduler(id);
          removed += 1;
          logger.info(
            {
              module: "account-refresh-registrar",
              schedulerId: id,
              previousEvery: sched.every,
              desiredEvery,
              next: Number.isFinite(nextMs)
                ? new Date(nextMs).toISOString()
                : null,
              reason: intervalChanged ? "interval-changed" : "stalled",
            },
            "removed unhealthy per-account refresh scheduler (will re-register)",
          );
          continue;
        } catch (err) {
          failed += 1;
          logger.error(
            {
              module: "account-refresh-registrar",
              schedulerId: id,
              previousEvery: sched.every,
              desiredEvery,
              err: err instanceof Error ? err.message : String(err),
            },
            "failed to remove unhealthy scheduler",
          );
        }
      }
      existingAccountIds.add(accountId);
    }
  }

  let added = 0;
  for (const accountId of Array.from(activeIds)) {
    if (existingAccountIds.has(accountId)) continue;
    if (await registerAccountRefresh(queue, accountId)) added += 1;
    else failed += 1;
  }

  // Finish the other independent repairs before surfacing failures. Otherwise
  // the recovery watchdog records a successful sweep even when an account
  // still has no scheduler, or an inactive account's scheduler remains alive.
  if (failed > 0) {
    logger.error(
      { module: "account-refresh-registrar", active: activeIds.size, added, removed, failed },
      "per-account refresh reconciliation incomplete",
    );
    throw new Error(`Account refresh reconciliation failed for ${failed} scheduler operation(s)`);
  }

  logger.info(
    {
      module: "account-refresh-registrar",
      active: activeIds.size,
      added,
      removed,
    },
    "reconciled per-account refresh schedulers",
  );

  return { added, removed, active: activeIds.size };
}
