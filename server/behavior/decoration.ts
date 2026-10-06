// ─── Action decoration (Wave 3) ──────────────────────────────────────────────
//
// A real human does not open the IG app and immediately tap Follow on a
// random private account. They scroll, they look at stories, they bounce
// around a few profiles, and only then commit to the action. This module
// "decorates" a sensitive action (follow) with a small amount of plausible
// preamble browsing so our outbound request pattern blends in.
//
// Every preamble call goes through the same IGClientPort, and every pause
// is drawn from the pacing module's log-normal distribution. The popular
// usernames pool is intentionally boring — massive public accounts whose
// profile is hit by millions of people a day, so scraping them is noise.
// ─────────────────────────────────────────────────────────────────────────────

import { randomInt } from "node:crypto";
import { humanDelay } from "./pacing.js";
import type { IGClientPort } from "../domain/ig-client-port.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "behavior:decoration" });

// Large, famous public accounts. Hitting these profiles is statistical noise.
// Keep a wide range of categories so a decorated session looks like a real
// browser distracted across topics rather than a themed scraper.
const POPULAR_USERNAMES: readonly string[] = [
  "instagram",
  "nasa",
  "natgeo",
  "bbcnews",
  "cnn",
  "nike",
  "adidas",
  "spotify",
  "netflix",
  "marvel",
  "disney",
  "nba",
  "fifaworldcup",
  "premierleague",
  "cristiano",
  "leomessi",
  "therock",
  "kyliejenner",
  "kimkardashian",
  "beyonce",
  "taylorswift",
  "zendaya",
  "billieeilish",
  "virat.kohli",
  "priyankachopra",
  "khaby00",
  "messi",
  "google",
  "apple",
  "microsoft",
  "amazon",
  "tesla",
  "nytimes",
  "vogue",
  "gucci",
];

function pickRandom<T>(pool: readonly T[], n: number): T[] {
  const count = Math.min(Math.max(n, 0), pool.length);
  const picked = new Set<number>();
  const out: T[] = [];
  while (out.length < count) {
    const idx = randomInt(0, pool.length);
    if (picked.has(idx)) continue;
    picked.add(idx);
    out.push(pool[idx]!);
  }
  return out;
}

export interface DecorationConfig {
  /** How many random popular profiles to visit before the real target. */
  readonly warmupProfiles: number;
  /** Whether to fetch the target's profile once as "reading before deciding". */
  readonly readTargetFirst: boolean;
  /** Completely disable decoration (test / performance benchmarks). */
  readonly disabled: boolean;
}

function resolveConfig(): DecorationConfig {
  return {
    warmupProfiles: parseInt(
      process.env.BEHAVIOR_DECORATION_PROFILES ?? "2",
      10,
    ),
    readTargetFirst: process.env.BEHAVIOR_DECORATION_READ_TARGET !== "0",
    disabled: process.env.BEHAVIOR_DECORATION_DISABLED === "1",
  };
}

/**
 * Run the preamble flow before a sensitive action. Never throws on a single
 * fetch failure — if IG 429's us on a decorative call we simply skip the
 * rest of the preamble and let the caller decide whether to proceed with
 * the real action. The whole function is best-effort cosmetic behavior.
 */
export async function decorateBeforeFollow(
  client: IGClientPort,
  target: { username: string },
): Promise<void> {
  const cfg = resolveConfig();
  if (cfg.disabled) return;

  const warmups = pickRandom(
    POPULAR_USERNAMES.filter((u) => u !== target.username),
    Math.max(0, Math.min(cfg.warmupProfiles, 3)),
  );

  for (const username of warmups) {
    try {
      await client.fetchProfile(username);
      // Reading a profile (3..12s) — matches the time a human spends scanning
      // bio + last two posts before backing out.
      await humanDelay(3_000, 12_000, 5_000, 3_000);
    } catch (err) {
      // Decoration is fire-and-forget; log at debug and stop preamble.
      logger.debug(
        {
          warmupUsername: username,
          err: err instanceof Error ? err.message : String(err),
        },
        "decoration warmup fetch failed, skipping remaining preamble",
      );
      return;
    }
  }

  if (cfg.readTargetFirst) {
    try {
      await client.fetchProfile(target.username);
      // "Reading" the target before tapping follow — plausible deliberation.
      await humanDelay(5_000, 20_000, 8_000, 5_000);
    } catch (err) {
      logger.debug(
        {
          target: target.username,
          err: err instanceof Error ? err.message : String(err),
        },
        "target pre-read failed, proceeding directly to action",
      );
    }
  }
}

export function __popularUsernamesForTesting(): readonly string[] {
  return POPULAR_USERNAMES;
}
