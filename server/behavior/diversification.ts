// ─── Per-bot personality diversification (Wave 6) ────────────────────────────
//
// Wave 3 gave every bot a stable device fingerprint, but the pool overlap was
// tight enough that a small fleet (7 bots) ended up with near-identical
// device/user-agent/timezone profiles. From IG's side, 7 accounts that all
// look like the same device, post on the same hours, and target the same
// decoy interest set is a much stronger pattern signal than 7 random users.
//
// This module assigns each bot a richer "personality" — a stable, deterministic
// bundle of (device, app version, timezone, awake window, decoy interests) —
// so the fleet looks like a heterogeneous group of real humans instead of a
// cluster of clones. Stability is critical: changing a bot's fingerprint
// across restarts is itself a bot signal, so the mapping is purely a function
// of the botId. Same bot → same personality forever.
//
// This file is pure: no I/O, no DB, no env. The fingerprint module consumes
// it as a fallback when no explicit fingerprint is provided.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BotPersonality {
  readonly deviceModel: string;
  readonly igAppVersion: string;
  readonly userAgent: string;
  readonly timezone: string;
  readonly awakeHourStart: number;
  readonly awakeHourEnd: number;
  readonly decoyInterests: readonly string[];
}

export interface InterestProfile {
  readonly name: string;
  readonly targets: readonly string[];
}

interface DeviceModelSpec {
  readonly model: string;
  readonly platform: "android" | "ios";
  // Template for building the IG-app user-agent string. {{APP}} is replaced
  // with the IG app version. Keep these realistic — IG fingerprints UAs.
  readonly userAgentTemplate: string;
}

// ─── Pools ───────────────────────────────────────────────────────────────────

// Eight realistic flagship-ish devices, mixed Android + iOS. UA templates
// follow the canonical Instagram mobile shape so they don't stand out
// against real-user telemetry.
export const DEVICE_MODELS: readonly DeviceModelSpec[] = [
  {
    model: "Samsung Galaxy S23",
    platform: "android",
    userAgentTemplate:
      "Instagram {{APP}} Android (33/13; 480dpi; 1080x2208; samsung; SM-S911B; dm3q; qcom; en_US; 540910264)",
  },
  {
    model: "Samsung Galaxy S22",
    platform: "android",
    userAgentTemplate:
      "Instagram {{APP}} Android (32/12; 420dpi; 1080x2280; samsung; SM-S901B; r0q; exynos2200; en_US; 528731377)",
  },
  {
    model: "Google Pixel 7",
    platform: "android",
    userAgentTemplate:
      "Instagram {{APP}} Android (33/13; 420dpi; 1080x2337; Google; Pixel 7; panther; google; en_US; 540910264)",
  },
  {
    model: "Google Pixel 8",
    platform: "android",
    userAgentTemplate:
      "Instagram {{APP}} Android (34/14; 420dpi; 1080x2400; Google; Pixel 8; shiba; google; en_US; 540910264)",
  },
  {
    model: "OnePlus 11",
    platform: "android",
    userAgentTemplate:
      "Instagram {{APP}} Android (33/13; 480dpi; 1440x3168; OnePlus; CPH2449; OP595DL1; qcom; en_US; 540910264)",
  },
  {
    model: "iPhone 14",
    platform: "ios",
    userAgentTemplate:
      "Instagram {{APP}} (iPhone14,7; iOS 17_3_1; en_US; en-US; scale=3.00; 1170x2532; 540910264) AppleWebKit/420+",
  },
  {
    model: "iPhone 14 Pro",
    platform: "ios",
    userAgentTemplate:
      "Instagram {{APP}} (iPhone15,2; iOS 17_3_1; en_US; en-US; scale=3.00; 1179x2556; 540910264) AppleWebKit/420+",
  },
  {
    model: "iPhone 13",
    platform: "ios",
    userAgentTemplate:
      "Instagram {{APP}} (iPhone14,5; iOS 16_7_2; en_US; en-US; scale=3.00; 1170x2532; 528731377) AppleWebKit/420+",
  },
];

// Recent-ish IG mobile app versions. We avoid bleeding-edge betas (rare in
// the wild) and avoid anything older than ~6 months (also rare and often
// force-upgraded). Five spread choices give us breathing room.
export const IG_APP_VERSIONS: readonly string[] = [
  "310.0.0.36.111",
  "312.0.0.34.111",
  "314.1.0.29.105",
  "316.0.0.30.110",
  "318.0.0.27.106",
];

// Six timezones spanning the regions our bot fleet plausibly operates in.
// The fingerprint module uses its own larger pool for desktop UA paths;
// this set is intentionally narrower so personality assignment biases
// toward markets where mobile IG usage is dense.
export const TIMEZONES: readonly string[] = [
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Karachi",
  "Asia/Dubai",
  "Asia/Manila",
  "Europe/London",
];

// Awake window options. Each entry is [startHour, endHour) in the bot's own
// timezone. Mix of early-bird, normal, and night-owl patterns gives the
// fleet temporal diversity instead of all 7 bots posting in the same window.
const AWAKE_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9, 23],
  [7, 21],
  [11, 25], // night owl, wraps past midnight
  [8, 22],
  [10, 24],
  [6, 20],
];

// Decoy interest profiles. Each profile is a thematic bundle of public
// accounts the bot could plausibly browse without raising suspicion.
// Targets are intentionally well-known, high-follower public profiles —
// real users actually look at these, so the requests blend in.
export const INTEREST_PROFILES: readonly InterestProfile[] = [
  {
    name: "sports",
    targets: ["cristiano", "leomessi", "nba", "espn", "neymarjr"],
  },
  {
    name: "fashion",
    targets: ["zara", "nike", "gucci", "voguemagazine", "chiaraferragni"],
  },
  {
    name: "tech",
    targets: ["nasa", "spacex", "apple", "wired", "marquesbrownlee"],
  },
  {
    name: "crypto",
    targets: ["binance", "coinbase", "ethereum", "vitalik.buterin"],
  },
  {
    name: "lifestyle",
    targets: ["natgeo", "humansofny", "tasty", "buzzfeed", "9gag"],
  },
];

// ─── Seeding ─────────────────────────────────────────────────────────────────

// Deterministic 32-bit unsigned integer derived from `(salt, botId)`. Using a
// salt per axis (device, app, tz, …) means picks across axes are uncorrelated
// — without it, a bot whose hash bucket collides for one axis would tend to
// collide for all of them, defeating diversification.
function seededIndex(botId: string, salt: string, modulo: number): number {
  if (modulo <= 0) {
    throw new Error("seededIndex modulo must be positive");
  }
  const digest = createHash("sha256")
    .update(salt)
    .update("|")
    .update(botId)
    .digest();
  const u32 =
    ((digest[0]! << 24) |
      (digest[1]! << 16) |
      (digest[2]! << 8) |
      digest[3]!) >>>
    0;
  return u32 % modulo;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the stable personality for a given bot id. The mapping is a pure
 * function of `botId`: same id → same personality across restarts, deploys,
 * and DB resets. Two different bot ids should generally land on different
 * device/timezone/interest combinations — the per-axis salts in `seededIndex`
 * keep the picks uncorrelated.
 *
 * Throws on empty botId so we never silently emit a default personality
 * (which would defeat the whole point of diversification).
 */
export function personalityFor(botId: string): BotPersonality {
  if (!botId || botId.length === 0) {
    throw new Error("personalityFor requires a non-empty botId");
  }

  const device = DEVICE_MODELS[seededIndex(botId, "device", DEVICE_MODELS.length)]!;
  const igAppVersion = IG_APP_VERSIONS[seededIndex(botId, "app", IG_APP_VERSIONS.length)]!;
  const timezone = TIMEZONES[seededIndex(botId, "tz", TIMEZONES.length)]!;
  const awake = AWAKE_WINDOWS[seededIndex(botId, "awake", AWAKE_WINDOWS.length)]!;
  const interest =
    INTEREST_PROFILES[seededIndex(botId, "interest", INTEREST_PROFILES.length)]!;

  const userAgent = device.userAgentTemplate.replace("{{APP}}", igAppVersion);

  // Awake-end above 24 wraps to next day; downstream consumers compare against
  // (hour + 24) to detect overnight windows. Keep it numeric, not modulo-d.
  const [startRaw, endRaw] = awake;
  const awakeHourStart = startRaw;
  const awakeHourEnd = endRaw;

  return {
    deviceModel: device.model,
    igAppVersion,
    userAgent,
    timezone,
    awakeHourStart,
    awakeHourEnd,
    decoyInterests: interest.targets,
  };
}
