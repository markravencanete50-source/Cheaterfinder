import { describe, it, expect, vi } from "vitest";

vi.mock("../db.js", () => ({ db: { update: () => ({ set: () => ({ where: async () => undefined }) }) } }));
vi.mock("../observability/logger.js", () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { warn: noop, info: noop, debug: noop, error: noop, trace: noop, fatal: noop };
  logger.child = () => logger;
  return { logger, default: logger };
});

import {
  BAN_REASON_SQL_REGEX,
  COOLDOWN_REASON_PREFIX,
  formatCooldownReason,
} from "../services/bot-cooldown.js";

const banRegex = new RegExp(BAN_REASON_SQL_REGEX, "i");
/** Mirror of the SQL predicate: prefixed reasons are never verdicts. */
const isLeaseExcluded = (reason: string | null) => {
  const r = reason ?? "";
  return !r.startsWith(COOLDOWN_REASON_PREFIX) && banRegex.test(r);
};

describe("cooldown reasons vs the lease ban list", () => {
  const rawReasons = [
    "checkpoint_required (HTTP 400) on /api/v1/friendships/show/",
    "[ig-http] auth rejected (status 401) for GET profile",
    "auth rejected (HTTP 403) on https://www.instagram.com/api/v1/…",
    "challenge_required on friendship_status",
  ];

  it("every raw IG reason above WOULD be read as a permanent ban (the bug)", () => {
    for (const r of rawReasons) expect(isLeaseExcluded(r)).toBe(true);
  });

  it("the same reasons, written by a timed cooldown, are NOT lease-excluded", () => {
    for (const r of rawReasons) expect(isLeaseExcluded(formatCooldownReason(r))).toBe(false);
  });

  it("formatCooldownReason is idempotent", () => {
    const once = formatCooldownReason("x");
    expect(formatCooldownReason(once)).toBe(once);
    expect(once.startsWith(COOLDOWN_REASON_PREFIX)).toBe(true);
  });

  it("genuine verdicts (no prefix) stay excluded", () => {
    expect(isLeaseExcluded("account suspended/checkpointed on https://www.instagram.com/accounts/suspended/")).toBe(true);
    expect(isLeaseExcluded("login information was incorrect")).toBe(true);
    expect(isLeaseExcluded(null)).toBe(false);
    expect(isLeaseExcluded("mobile transient throttle (HTTP 403)")).toBe(false);
  });

  it("rate-limit cooldown reasons are not read as permanent by the warmer exclusion", () => {
    const warmerRegex = /rate limited|retry-after|auth rejected|csrf token/i;
    const raw = "rate limited; retry-after=600000ms (rotation)";
    expect(warmerRegex.test(raw)).toBe(true);
    const stored = formatCooldownReason(raw);
    const warmerExcluded = (r: string) => !r.startsWith(COOLDOWN_REASON_PREFIX) && warmerRegex.test(r);
    expect(warmerExcluded(stored)).toBe(false);
  });
});
