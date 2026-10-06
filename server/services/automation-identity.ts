// ─── Persisted Python automation identity ───────────────────────────────────
//
// Keep validation at the database boundary.  A malformed JSONB value must
// never fall back to the old Chrome-shaped fingerprint path for a bot that has
// been explicitly migrated to the Firefox automation service.

import type { AutomationIdentity } from "./automation-client.js";

export function parseAutomationIdentity(
  value: unknown,
  expectedBotId?: string,
): AutomationIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const requiredStrings = [
    "bot_id",
    "browser_version",
    "user_agent",
    "http_impersonate",
    "ja3",
    "h2_fingerprint",
    "locale",
    "timezone",
  ] as const;
  if (
    candidate.identity_version !== 1 ||
    candidate.client !== "instagram-firefox-web" ||
    candidate.browser_family !== "firefox" ||
    candidate.platform !== "Windows" ||
    !Number.isInteger(candidate.browser_seed) ||
    (typeof expectedBotId === "string" && candidate.bot_id !== expectedBotId) ||
    requiredStrings.some((field) =>
      typeof candidate[field] !== "string" || candidate[field].length === 0,
    )
  ) {
    return null;
  }
  return candidate as unknown as AutomationIdentity;
}

export function requireAutomationIdentity(
  value: unknown,
  expectedBotId: string,
): AutomationIdentity {
  const identity = parseAutomationIdentity(value, expectedBotId);
  if (!identity) {
    throw new Error(
      `[automation] bot ${expectedBotId} has an invalid automation_identity`,
    );
  }
  return identity;
}
