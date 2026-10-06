// ─── Behavioral pacing engine (Wave 3) ───────────────────────────────────────
//
// Humans do not burst-send 10 follow requests in 3 seconds then sit idle.
// They open the app, scroll, tap a profile, read it, get distracted, come
// back, and so on — with inter-action gaps distributed as a long-tailed
// log-normal around ~8s. This module provides the sleep primitives that
// shape our bot traffic into that distribution, plus a simple circadian
// "awake window" check per bot timezone.
//
// All delays are short-circuitable via BEHAVIOR_DISABLE_DELAYS=1 so tests
// and debugging don't wait minutes.
// ─────────────────────────────────────────────────────────────────────────────

import { randomInt, randomBytes } from "node:crypto";

const DISABLED = process.env.BEHAVIOR_DISABLE_DELAYS === "1";

/**
 * Box-Muller transform producing a standard-normal sample in (-inf, +inf).
 * We use the crypto RNG rather than Math.random so timing is not predictable
 * to an observer who can measure our outbound request intervals.
 */
function gaussian(): number {
  const buf = randomBytes(8);
  // Two uniforms in (0, 1]. Avoid exactly 0 or we hit log(0).
  const u1 = (buf.readUInt32BE(0) + 1) / (0xffffffff + 2);
  const u2 = (buf.readUInt32BE(4) + 1) / (0xffffffff + 2);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample a delay from a log-normal-ish distribution clamped to [min, max].
 * Defaults model the gap between two consecutive human tap-actions on IG:
 * mode near ~5-8s, fat right tail into the "got distracted" zone.
 *
 * @param min    minimum sleep in ms
 * @param max    maximum sleep in ms (hard clamp for worst-case latency)
 * @param mu     centre of the distribution in ms
 * @param sigma  width of the distribution in ms
 */
export function humanDelayMs(
  min = 2_000,
  max = 90_000,
  mu = 8_000,
  sigma = 6_000,
): number {
  // Build a log-normal-style positive skew: draw from |Normal(mu, sigma)| and
  // clamp. Cheap, good enough, and the absolute value gives the asymmetry.
  const raw = Math.abs(gaussian() * sigma + mu);
  return Math.max(min, Math.min(max, Math.round(raw)));
}

export async function humanDelay(
  min?: number,
  max?: number,
  mu?: number,
  sigma?: number,
): Promise<void> {
  if (DISABLED) return;
  const delay = humanDelayMs(min, max, mu, sigma);
  await sleep(delay);
}

export function sleep(ms: number): Promise<void> {
  if (DISABLED) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ─── Circadian schedule ──────────────────────────────────────────────────────
//
// Each bot has a start/end hour in its own timezone. Workers check before
// running a job and, if the bot is "asleep", requeue with enough delay to
// cover the remaining sleep span.

export interface AwakeBot {
  readonly awakeHourStart: number;
  readonly awakeHourEnd: number;
  readonly timezone: string;
}

/**
 * Returns the current hour-of-day (0..23) in the given IANA timezone using
 * Intl.DateTimeFormat — no heavy deps like luxon required.
 */
export function currentHourInTz(
  timezone: string,
  now: Date = new Date(),
): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    const h = hourPart ? parseInt(hourPart.value, 10) : now.getUTCHours();
    // "24" can come back from en-US hour12:false after midnight; normalize.
    return h === 24 ? 0 : h;
  } catch {
    return now.getUTCHours();
  }
}

/**
 * True if the bot is currently in its awake window. Handles the common case
 * (start < end) and the wrap-around case (e.g. 22..6 covering midnight).
 */
export function isAwake(bot: AwakeBot, now: Date = new Date()): boolean {
  const h = currentHourInTz(bot.timezone, now);
  const start = bot.awakeHourStart;
  const end = bot.awakeHourEnd;
  if (start === end) return true; // degenerate "always awake" config
  if (start < end) return h >= start && h < end;
  // wrap-around window (e.g. 22..6)
  return h >= start || h < end;
}

/**
 * Milliseconds from `now` until the next awake-window start for this bot.
 * Returns 0 if the bot is already awake. Useful for BullMQ requeue delay
 * when we skip a job because the bot is sleeping.
 */
export function msUntilAwake(bot: AwakeBot, now: Date = new Date()): number {
  if (isAwake(bot, now)) return 0;
  const nowHour = currentHourInTz(bot.timezone, now);

  // How many hours until nowHour == bot.awakeHourStart?
  let diff = bot.awakeHourStart - nowHour;
  if (diff <= 0) diff += 24;
  // Add 0..10 random minutes of jitter so we don't stampede on the hour.
  const jitterMinutes = DISABLED ? 0 : randomInt(0, 10);
  return diff * 60 * 60 * 1000 + jitterMinutes * 60 * 1000;
}

// ─── Global IG throttle ──────────────────────────────────────────────────────
//
// Even if each bot is polite individually, 60 bots all sending a follow in the
// same minute is a detectable traffic signature. Redis is the natural place
// to coordinate across workers, but we also keep a fallback in-process counter
// so tests and single-node dev still get a sane bound.

const GLOBAL_MAX_FOLLOWS_PER_MIN = parseInt(
  process.env.GLOBAL_IG_FOLLOWS_PER_MIN ?? "10",
  10,
);

interface GlobalBucket {
  windowStart: number;
  count: number;
}
const inProcessBucket: GlobalBucket = { windowStart: 0, count: 0 };

/**
 * Check the in-process fleet-wide follow counter. Returns true if we are
 * below the per-minute cap and records one more call; false if exhausted.
 * Callers should back off (enqueue with delay) on false.
 *
 * This is a lightweight check — for multi-node deployments, wire through
 * incrementRedisBucket() (Redis IORedis) from workers.ts instead.
 */
export function reserveGlobalFollow(now: number = Date.now()): boolean {
  const minuteBucket = Math.floor(now / 60_000);
  if (inProcessBucket.windowStart !== minuteBucket) {
    inProcessBucket.windowStart = minuteBucket;
    inProcessBucket.count = 0;
  }
  if (inProcessBucket.count >= GLOBAL_MAX_FOLLOWS_PER_MIN) return false;
  inProcessBucket.count += 1;
  return true;
}

export function globalFollowBucketSnapshot(): {
  readonly max: number;
  readonly count: number;
  readonly windowStart: number;
} {
  return {
    max: GLOBAL_MAX_FOLLOWS_PER_MIN,
    count: inProcessBucket.count,
    windowStart: inProcessBucket.windowStart,
  };
}

// Exposed for tests — reset the in-process counter.
export function _resetGlobalBucketForTesting(): void {
  inProcessBucket.windowStart = 0;
  inProcessBucket.count = 0;
}
