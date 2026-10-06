// Unit tests for server/behavior/diversification.ts
//
// Pure functions, no I/O, no mocks needed. We assert:
//   - stability:    same botId → same personality every call
//   - variety:      different botIds → different personalities
//   - distribution: 25 distinct ids spread across enough buckets
//   - shape:        every personality references a real entry from the pools
//   - errors:       empty botId is rejected loudly

import { describe, it, expect } from "vitest";

import {
  personalityFor,
  DEVICE_MODELS,
  IG_APP_VERSIONS,
  TIMEZONES,
  INTEREST_PROFILES,
  type BotPersonality,
} from "../diversification.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// 25 distinct, realistic-looking bot usernames. Mix of regions and styles
// so any accidental clustering by username shape would surface.
const BOT_IDS_25: readonly string[] = [
  "amaliapaul37",
  "syahrininasyiahh",
  "tracked_user_8",
  "example_official",
  "sofia.ramos.21",
  "khaled_rt",
  "nadia.kx",
  "lina.beauty99",
  "rico_travels",
  "mark.theartist",
  "yuki_tokyo",
  "chiara_p",
  "luca.fitness",
  "diego_makes",
  "amaya.wrldd",
  "tariq_22",
  "naomi.styles",
  "kenji_runs",
  "fatima.code",
  "ines.painter",
  "carlos.dev",
  "mei_designs",
  "ahmed_lives",
  "priya.notes",
  "leo_climbs",
];

function distinctCount<T>(values: readonly T[]): number {
  return new Set(values).size;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("personalityFor", () => {
  it("rejects empty botId", () => {
    expect(() => personalityFor("")).toThrow();
  });

  it("returns the same personality for the same botId across many calls", () => {
    const id = "amaliapaul37";
    const first = personalityFor(id);

    for (let i = 0; i < 50; i += 1) {
      const next = personalityFor(id);
      expect(next).toEqual(first);
    }
  });

  it("returns distinct personalities for different botIds (sample)", () => {
    const a = personalityFor("amaliapaul37");
    const b = personalityFor("syahrininasyiahh");

    // They might share one or two axes by chance, but the full bundle
    // should not be byte-identical between two unrelated bots.
    expect(a).not.toEqual(b);
  });

  it("populates all required fields with values from the declared pools", () => {
    const personality: BotPersonality = personalityFor("amaliapaul37");

    expect(DEVICE_MODELS.map((d) => d.model)).toContain(personality.deviceModel);
    expect(IG_APP_VERSIONS).toContain(personality.igAppVersion);
    expect(TIMEZONES).toContain(personality.timezone);

    // Decoy interests must come from one of the declared profiles.
    const knownInterestSets = INTEREST_PROFILES.map((p) => p.targets.join("|"));
    expect(knownInterestSets).toContain(personality.decoyInterests.join("|"));

    // Awake window sanity: a positive window of at least a few hours.
    expect(personality.awakeHourEnd).toBeGreaterThan(personality.awakeHourStart);
    expect(personality.awakeHourEnd - personality.awakeHourStart).toBeGreaterThanOrEqual(
      8,
    );

    // The user-agent is built from the device template + app version, so
    // both substrings should appear in the final UA string.
    expect(personality.userAgent).toContain(personality.igAppVersion);
  });

  it("declared pool sizes match the spec", () => {
    expect(DEVICE_MODELS.length).toBe(8);
    expect(IG_APP_VERSIONS.length).toBe(5);
    expect(TIMEZONES.length).toBe(6);
    expect(INTEREST_PROFILES.length).toBe(5);

    // Every interest profile carries 3-5 decoy targets per the spec.
    for (const profile of INTEREST_PROFILES) {
      expect(profile.targets.length).toBeGreaterThanOrEqual(3);
      expect(profile.targets.length).toBeLessThanOrEqual(5);
    }
  });

  it("spreads 25 distinct bots across enough device/timezone buckets", () => {
    const personalities = BOT_IDS_25.map((id) => personalityFor(id));

    const distinctDevices = distinctCount(personalities.map((p) => p.deviceModel));
    const distinctTimezones = distinctCount(personalities.map((p) => p.timezone));
    const distinctInterests = distinctCount(
      personalities.map((p) => p.decoyInterests.join("|")),
    );
    const distinctAppVersions = distinctCount(
      personalities.map((p) => p.igAppVersion),
    );

    // Spec requires: ≥5 distinct deviceModels, ≥4 distinct timezones.
    expect(distinctDevices).toBeGreaterThanOrEqual(5);
    expect(distinctTimezones).toBeGreaterThanOrEqual(4);

    // Sanity: app versions and interests should also fan out, otherwise the
    // per-axis salts in seededIndex aren't doing their job.
    expect(distinctAppVersions).toBeGreaterThanOrEqual(3);
    expect(distinctInterests).toBeGreaterThanOrEqual(3);
  });

  it("is stable across repeated runs over the full 25-bot set", () => {
    const first = BOT_IDS_25.map((id) => personalityFor(id));
    const second = BOT_IDS_25.map((id) => personalityFor(id));
    expect(second).toEqual(first);
  });
});
