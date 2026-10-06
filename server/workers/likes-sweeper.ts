import { and } from "drizzle-orm";
import { customerAccessSql } from "../services/subscription-access.js";
// ─── Dedicated liked-post detection cadence ────────────────────────────────
//
// Liked-post detection used to run ONLY as a tail of the profile refresh
// (`enqueueLikesAfterProfile`, called from the profile worker). That coupled
// the flagship feature to the admin-controlled profile cadence, which is sized
// for bandwidth cost, not for like freshness. At a 6h profile interval with 9
// accounts whose schedulers clustered (five firing in the same minute), the
// observed result was a 4.7-hour window with zero liker reads and no new
// events — while 38 web bots sat idle and every bot was under its daily cap
// (avg 33 of 60 used).
//
// This sweep gives likes their own interval. It deliberately reuses
// `enqueueLikesAfterProfile` rather than adding a second enqueue path, so the
// existing per-account dedupe (LIKES_DEDUPE_WINDOW_MIN, default 30 min) still
// decides whether a run actually happens. A sweep tick is therefore a no-op
// for any account that ran recently — profile-triggered or sweep-triggered —
// and the two paths can never double-spend liker budget on one account.
//
// Ban exposure is NOT raised by sweeping more often: LIKERS_DAILY_CAP bounds
// per-bot daily liker reads regardless of scheduling. A tighter sweep spends
// budget that is already provisioned and was previously left idle; the cap
// remains the ceiling.
// ───────────────────────────────────────────────────────────────────────────

import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { trackedAccounts } from "../../shared/schema.js";
import { logger } from "../observability/logger.js";
import { canonicalTwinId } from "../services/tracked-account-twins.js";

/**
 * Default sweep cadence: 1h — deliberately INDEPENDENT of, and tighter than,
 * the profile refresh interval. Like freshness is the flagship product signal
 * and is cheap relative to a full profile pass (liker reads only, no profile /
 * posts / followers traffic), so it should not inherit a cadence sized for
 * bandwidth cost. Still well above the 30-min dedupe window, so a sweep tick
 * never fights the throttle.
 */
export const DEFAULT_LIKES_SWEEP_SEC = 3_600;

const MIN_LIKES_SWEEP_SEC = 900; // 15 min — below this the dedupe window dominates
const MAX_LIKES_SWEEP_SEC = 86_400; // 24h

/**
 * Sweep cadence in ms, from LIKES_SWEEP_SEC, clamped to sane bounds.
 * An unparseable or out-of-range value falls back to the default rather than
 * disabling the sweep — a typo must not silently stop liked-post detection.
 */
export function readLikesSweepMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.LIKES_SWEEP_SEC ?? DEFAULT_LIKES_SWEEP_SEC);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIKES_SWEEP_SEC * 1000;
  const clamped = Math.min(
    MAX_LIKES_SWEEP_SEC,
    Math.max(MIN_LIKES_SWEEP_SEC, Math.floor(raw)),
  );
  return clamped * 1000;
}

/** Minimal queue shape needed by the injected enqueue function. */
export interface LikesSweepQueue {
  getJob(jobId: string): Promise<unknown>;
  add(name: string, data: unknown, opts: unknown): Promise<unknown>;
}

/**
 * Injected so this module does not import from `workers.ts` (which imports
 * the sweep) — keeps the dependency one-directional.
 */
export type EnqueueLikesFn = (
  queue: never,
  trackedAccountId: string,
) => Promise<"scheduled" | "throttled">;

export interface LikesSweepResult {
  active: number;
  /** Active rows folded into a twin's scan (lesson 13): active − distinct canonicals. */
  collapsed: number;
  scheduled: number;
  throttled: number;
  failed: number;
}

/**
 * Twin leader election, pure: map every active row to its canonical twin and
 * keep each canonical once, in first-seen order. Ids missing from the map are
 * their own canonical (matches canonicalTwinId's fail-open contract).
 */
export function collapseToCanonical(
  ids: readonly string[],
  canonicalOf: ReadonlyMap<string, string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const canonical = canonicalOf.get(id) ?? id;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * Resolve each row's canonical twin; a lookup failure keeps the row itself so
 * one bad lookup can never drop an account from the sweep.
 */
async function resolveCanonicalMap(
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    ids.map(async (id): Promise<readonly [string, string]> => {
      try {
        return [id, await canonicalTwinId(id)];
      } catch (err) {
        logger.warn(
          {
            module: "likes-sweeper",
            trackedAccountId: id,
            err: err instanceof Error ? err.message : String(err),
          },
          "canonical twin lookup failed; sweeping the row itself",
        );
        return [id, id];
      }
    }),
  );
  return new Map(entries);
}

/**
 * Enqueue a liked-post scan for every active tracked account, letting the
 * shared dedupe throttle accounts that ran recently.
 *
 * Twin rows (same IG user) are collapsed to their canonical twin first, so one
 * IG user is scanned once per sweep. `enqueueLikesAfterProfile` re-keys onto
 * the canonical twin as well; doing it here too keeps the sweep honest about
 * how many scans it actually asks for (`collapsed` in the summary log).
 *
 * Never throws: one account's failure must not abort the sweep for the rest.
 */
export async function sweepLikes(
  queue: LikesSweepQueue,
  enqueueLikes: EnqueueLikesFn,
): Promise<LikesSweepResult> {
  const active = await db
    .select({ id: trackedAccounts.id })
    .from(trackedAccounts)
    .where(and(eq(trackedAccounts.isActive, true), customerAccessSql(trackedAccounts.userId)));

  const activeIds = active.map((row) => row.id);
  const canonicalOf = await resolveCanonicalMap(activeIds);
  const targets = collapseToCanonical(activeIds, canonicalOf);
  const collapsed = activeIds.length - targets.length;

  let scheduled = 0;
  let throttled = 0;
  let failed = 0;

  for (const trackedAccountId of targets) {
    try {
      const outcome = await enqueueLikes(queue as never, trackedAccountId);
      if (outcome === "scheduled") scheduled += 1;
      else throttled += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        {
          module: "likes-sweeper",
          trackedAccountId,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to enqueue likes scan for account",
      );
    }
  }

  logger.info(
    {
      module: "likes-sweeper",
      active: active.length,
      collapsed,
      scheduled,
      throttled,
      failed,
    },
    "likes sweep complete",
  );

  return { active: active.length, collapsed, scheduled, throttled, failed };
}


/**
 * Delay before the FIRST sweep after a boot. Restarting used to fire a sweep
 * immediately and restart the hourly timer from boot time, so every deploy more
 * than 30 min after the last sweep re-scanned all accounts (20 scans in 97 min
 * on 2026-09-02 against ~9/h steady) and shifted the cadence. With the last run
 * persisted, a boot only sweeps at once when a full interval has elapsed;
 * otherwise the first tick lands where the old cadence would have put it.
 */
export function computeSweepBootDelayMs(
  lastRunMs: number | null,
  nowMs: number,
  sweepMs: number,
): number {
  if (!lastRunMs || !Number.isFinite(lastRunMs) || lastRunMs > nowMs) return 0;
  const elapsed = nowMs - lastRunMs;
  return elapsed >= sweepMs ? 0 : sweepMs - elapsed;
}
