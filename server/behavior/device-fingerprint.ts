// ─── Per-bot device fingerprint (Wave 3) ─────────────────────────────────────
//
// IG's anti-bot heuristics cross-reference session cookies with device-looking
// headers (user-agent, x-ig-app-id, accept-language, sec-ch-ua-*). A bot that
// shows up from the same sessionid but a different UA/locale every restart is
// a near-instant signal. This module gives every bot a single deterministic
// fingerprint derived from its username, so the same bot always looks like the
// same machine. Fingerprints are generated once and persisted on bot_accounts;
// this file only produces them — persistence happens in bot-manager.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { personalityFor } from "./diversification.js";

export interface DeviceFingerprint {
  deviceId: string;
  userAgent: string;
  appId: string;
  timezone: string;
  locale: string;
  awakeHourStart: number;
  awakeHourEnd: number;
}

// Realistic Chrome desktop user agents currently seen in the wild. Kept
// small and recent so we don't emit versions that stand out as synthetic.
const USER_AGENT_POOL: readonly string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
];

// Timezones chosen to cluster around typical IG growth markets — US,
// Europe, Middle East, South Asia. Keeps the bot fleet plausibly distributed.
const TIMEZONE_POOL: readonly string[] = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
];

const LOCALE_POOL: readonly string[] = [
  "en-US",
  "en-GB",
  "en-CA",
  "en-AU",
  "es-ES",
  "es-MX",
  "de-DE",
  "fr-FR",
  "hi-IN",
  "ur-PK",
];

const IG_APP_ID = "936619743392459";

// Deterministic 32-bit integer derived from a seed string. Same seed → same
// integer forever, which is exactly what we want for per-bot stability.
function seedHashU32(seed: string, salt: string): number {
  const h = createHash("sha256")
    .update(salt)
    .update("|")
    .update(seed)
    .digest();
  return (
    ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0 // eslint-disable-line no-bitwise
  );
}

function pickFromPool<T>(
  pool: readonly T[],
  seed: string,
  salt: string,
): T {
  const idx = seedHashU32(seed, salt) % pool.length;
  return pool[idx]!;
}

// IG's own Android/Web clients stamp a UUIDv4-looking device_id. We emit a
// stable one per bot — reproducible from the username, never rotated.
function deriveDeviceId(username: string): string {
  const h = createHash("sha256").update("device-id").update(username).digest();
  const hex = h.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    // version nibble pinned to 4 so it passes lazy UUID regexes
    "4" + hex.slice(13, 16),
    // variant nibble pinned to 8
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Generate a deterministic fingerprint for the given bot username. Two calls
 * with the same username return byte-identical values, so restarts never
 * mutate a bot's apparent device. Awake window is picked from a small set
 * of plausible social-media-usage windows (morning through evening).
 */
export function generateDeviceFingerprint(username: string): DeviceFingerprint {
  const userAgent = pickFromPool(USER_AGENT_POOL, username, "ua");
  const timezone = pickFromPool(TIMEZONE_POOL, username, "tz");
  const locale = pickFromPool(LOCALE_POOL, username, "locale");

  // Awake window choices: keep ≥10 hours awake to leave enough daily budget.
  // Indices map to (start, end) pairs in the bot's own timezone.
  const awakePairs: ReadonlyArray<readonly [number, number]> = [
    [8, 23],
    [9, 23],
    [10, 23],
    [9, 24],
    [10, 24],
    [11, 24],
    [7, 22],
  ];
  const pair = pickFromPool(awakePairs, username, "awake");

  return {
    deviceId: deriveDeviceId(username),
    userAgent,
    appId: IG_APP_ID,
    timezone,
    locale,
    awakeHourStart: pair[0],
    awakeHourEnd: pair[1],
  };
}

/**
 * Resolve the fingerprint for a bot row. If any of the persisted fields is
 * missing (legacy row, pre-wave3 insert), fall back to the deterministic
 * generator so the bot still gets consistent headers. Persistence of the
 * generated values back into the row is the caller's responsibility —
 * bot-manager does this on next touch to keep this module pure.
 */
export function resolveFingerprint(bot: {
  igUsername: string;
  deviceId?: string | null;
  deviceUserAgent?: string | null;
  igAppId?: string | null;
  timezone?: string | null;
  locale?: string | null;
  awakeHourStart?: number | null;
  awakeHourEnd?: number | null;
}): DeviceFingerprint {
  const generated = generateDeviceFingerprint(bot.igUsername);
  return {
    deviceId: bot.deviceId ?? generated.deviceId,
    userAgent: bot.deviceUserAgent ?? generated.userAgent,
    appId: bot.igAppId ?? generated.appId,
    timezone: bot.timezone ?? generated.timezone,
    locale: bot.locale ?? generated.locale,
    awakeHourStart: bot.awakeHourStart ?? generated.awakeHourStart,
    awakeHourEnd: bot.awakeHourEnd ?? generated.awakeHourEnd,
  };
}

/**
 * Build the sec-ch-ua client-hint header value from a user-agent string.
 * IG rejects requests whose sec-ch-ua doesn't match the UA major version —
 * keeping these aligned is the difference between "looks like Chrome" and
 * "looks like a scraper that forgot to fake client hints".
 */
export function buildSecChUa(userAgent: string): string {
  const match = userAgent.match(/Chrome\/(\d+)/);
  const major = match ? match[1] : "124";
  return `"Chromium";v="${major}", "Not(A:Brand";v="24", "Google Chrome";v="${major}"`;
}

export function platformFromUserAgent(userAgent: string): string {
  if (userAgent.includes("Macintosh")) return '"macOS"';
  if (userAgent.includes("Linux")) return '"Linux"';
  return '"Windows"';
}

// ─── Wave 6: diversified-personality fallback ────────────────────────────────
//
// Wave 3's fingerprint generator picks from a desktop browser UA pool. That's
// fine for raw HTTP scraping, but it pairs every bot with the same flat set of
// devices/timezones/awake windows. Wave 6 introduces personalityFor(): a
// richer, per-bot stable identity. When a caller has a username but no
// persisted fingerprint row, this helper bridges the two — we keep the
// desktop UA path for IG's web endpoints (which expect `Chrome/N` to match
// `sec-ch-ua`) but adopt the personality's timezone and awake window so the
// per-bot diversity flows through to scheduling and pacing.
//
// We deliberately do NOT swap the desktop UA for the personality's mobile
// IG-app UA here: ig-http-client builds sec-ch-ua / sec-ch-ua-platform off
// the UA string, and a mobile IG UA would emit nonsensical client hints.
// The mobile UA lives on the personality and is consumed separately by code
// that talks to IG's mobile/app endpoints.
export function fingerprintFromPersonality(botUsername: string): DeviceFingerprint {
  const personality = personalityFor(botUsername);
  const generated = generateDeviceFingerprint(botUsername);
  return {
    deviceId: generated.deviceId,
    userAgent: generated.userAgent,
    appId: generated.appId,
    timezone: personality.timezone,
    locale: generated.locale,
    awakeHourStart: personality.awakeHourStart,
    // Personality awake windows can wrap past 24; the existing
    // DeviceFingerprint contract expects 0-24, so clamp here.
    awakeHourEnd: Math.min(personality.awakeHourEnd, 24),
  };
}
