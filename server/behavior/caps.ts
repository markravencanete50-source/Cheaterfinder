// ─── Daily cap enforcement (Wave 3) ──────────────────────────────────────────
//
// IG publishes no hard numbers, but community consensus is roughly:
//   - ~200 follows/day before soft shadowban kicks in
//   - ~500 profile views/hour before throttling
//   - ~30 follow requests to private accounts/day before "suspicious activity"
//
// We cap well below these. On every attempt:
//   1. If the bot's daily_counters_reset_at is before today (UTC), zero the
//      counters.
//   2. Check the relevant counter against its cap.
//   3. If still under, increment and let the call proceed.
//   4. If at cap, throw so the caller can cool down the bot until midnight.
//
// All steps run inside a single transaction with FOR UPDATE so two concurrent
// workers can't both increment from the same pre-cap value.
// ─────────────────────────────────────────────────────────────────────────────

import { eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { botAccounts } from "../../shared/schema.js";

export type CapAction = "follows" | "profileViews" | "privateRequests";

export const DAILY_CAPS: Record<CapAction, number> = {
  // ~150 is ~75% of the IG soft limit so we have headroom for retries.
  follows: parseInt(process.env.CAP_DAILY_FOLLOWS ?? "150", 10),
  profileViews: parseInt(process.env.CAP_DAILY_PROFILE_VIEWS ?? "500", 10),
  // Private-account requests are especially scrutinised.
  privateRequests: parseInt(process.env.CAP_DAILY_PRIVATE_REQUESTS ?? "30", 10),
};

export class IGDailyCapExceededError extends Error {
  readonly action: CapAction;
  readonly resetAt: Date;
  constructor(action: CapAction, resetAt: Date) {
    super(
      `[caps] bot exceeded daily cap for ${action} (resets ${resetAt.toISOString()})`,
    );
    this.name = "IGDailyCapExceededError";
    this.action = action;
    this.resetAt = resetAt;
  }
}

function isBeforeTodayUtc(d: Date | null | undefined, now: Date): boolean {
  if (!d) return true;
  // Compare YYYY-MM-DD in UTC. A reset stamp from yesterday → roll over.
  return d.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10);
}

/** Start of tomorrow UTC — the soonest the counter can free up. */
export function nextMidnightUtc(now: Date = new Date()): Date {
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
  return d;
}

interface CapRow {
  dailyFollowsUsed: number | null;
  dailyProfileViewsUsed: number | null;
  dailyCountersResetAt: Date | null;
}

function currentCount(row: CapRow, action: CapAction): number {
  switch (action) {
    case "follows":
      return row.dailyFollowsUsed ?? 0;
    case "profileViews":
      return row.dailyProfileViewsUsed ?? 0;
    case "privateRequests":
      // Private requests are a subset of follows; use the same counter so a
      // private follow consumes one follow unit, never a second reservation.
      // Public follows also reduce the remaining private-request allowance.
      return row.dailyFollowsUsed ?? 0;
  }
}


/**
 * Atomically reserve one unit of `action` budget for the bot. Returns the
 * post-increment remaining count on success; throws IGDailyCapExceededError
 * when the cap is already hit.
 *
 * This runs inside its own short transaction so the check-reset-increment is
 * serialized per-row. Contention is tolerable because bots are rarely the
 * hot path — worker concurrency is a handful, not thousands.
 */
export async function reserveDailyBudget(
  botId: string,
  action: CapAction,
): Promise<number> {
  // Use a transaction so reset-and-increment is atomic against concurrent workers.
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        createdAt: botAccounts.createdAt,
        maxFollows: botAccounts.maxFollows,
        dailyFollowsUsed: botAccounts.dailyFollowsUsed,
        dailyProfileViewsUsed: botAccounts.dailyProfileViewsUsed,
        dailyCountersResetAt: botAccounts.dailyCountersResetAt,
      })
      .from(botAccounts)
      .where(eq(botAccounts.id, botId))
      .for("update")
      .limit(1);

    if (!row) throw new Error(`[caps] bot ${botId} not found`);
    // Resolve the ramp from the locked row, not a caller's earlier bot snapshot.
    // This also enforces a zero maxFollows override and the day-3..6 cap under
    // concurrent workers. Private requests use the same counter once, with the
    // stricter of their own cap and the bot's effective follow cap.
    const now = new Date();
    const cap = action === "profileViews"
      ? DAILY_CAPS.profileViews
      : Math.min(DAILY_CAPS[action], effectiveFollowCap(row, now));

    // Daily rollover — zero both counters if we've crossed a UTC day.
    if (isBeforeTodayUtc(row.dailyCountersResetAt, now)) {
      await tx
        .update(botAccounts)
        .set({
          dailyFollowsUsed: 0,
          dailyProfileViewsUsed: 0,
          dailyCountersResetAt: now,
          updatedAt: now,
        })
        .where(eq(botAccounts.id, botId));
      row.dailyFollowsUsed = 0;
      row.dailyProfileViewsUsed = 0;
    }

    const used = currentCount(row, action);
    if (used >= cap) {
      throw new IGDailyCapExceededError(action, nextMidnightUtc(now));
    }

    // Atomic increment via sql template. COALESCE covers the null-column
    // case that can linger on legacy rows before the Wave 3 backfill lands.
    if (action === "follows" || action === "privateRequests") {
      await tx
        .update(botAccounts)
        .set({
          dailyFollowsUsed: sql`COALESCE(${botAccounts.dailyFollowsUsed}, 0) + 1`,
          updatedAt: now,
        })
        .where(eq(botAccounts.id, botId));
    } else {
      await tx
        .update(botAccounts)
        .set({
          dailyProfileViewsUsed: sql`COALESCE(${botAccounts.dailyProfileViewsUsed}, 0) + 1`,
          updatedAt: now,
        })
        .where(eq(botAccounts.id, botId));
    }

    return cap - used - 1;
  });
}

/**
 * Pure check-only version that does not increment. Used for display + admin
 * UI. Does not trigger the daily rollover so callers that want the "would
 * this be allowed right now" answer get it without side effects.
 */
export function wouldBeAllowed(
  row: CapRow,
  action: CapAction,
  now: Date = new Date(),
): boolean {
  if (isBeforeTodayUtc(row.dailyCountersResetAt, now)) return true;
  const used = currentCount(row, action);
  return used < DAILY_CAPS[action];
}

// ─── Warm-up ramp (Wave 3) ───────────────────────────────────────────────────
//
// Freshly-logged-in bots should not hit a 150/day cap on day 1. A new bot
// making 50+ actions immediately after a login from a datacenter IP is the
// classic checkpoint-required trigger. We ramp the effective cap based on
// age-since-creation.

export interface RampBot {
  readonly createdAt: Date;
  readonly maxFollows?: number | null;
}

/**
 * Returns the effective daily follow cap for a bot based on its account age.
 * Day 0..2: reads only, 0 follows. Day 3..6: 5 follows/day. Day 7+: full cap.
 * Always clamped to the row's own maxFollows override if set lower.
 */
export function effectiveFollowCap(
  bot: RampBot,
  now: Date = new Date(),
): number {
  const ageMs = now.getTime() - bot.createdAt.getTime();
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

  let cap: number;
  if (ageDays < 3) cap = 0;
  else if (ageDays < 7) cap = Math.min(5, DAILY_CAPS.follows);
  else cap = DAILY_CAPS.follows;

  if (typeof bot.maxFollows === "number" && bot.maxFollows >= 0) {
    cap = Math.min(cap, bot.maxFollows * 30); // per-day multiplier
  }
  return cap;
}

export function isInWarmup(bot: RampBot, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - bot.createdAt.getTime();
  return ageMs < 3 * 24 * 60 * 60 * 1000;
}
