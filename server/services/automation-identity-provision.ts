import { createAutomationClient } from "./automation-client.js";
import { parseAutomationIdentity } from "./automation-identity.js";
import type { AutomationIdentity } from "./automation-client.js";

/**
 * Create and validate an automation identity (browser/device fingerprint,
 * locale, timezone) for a bot through the local automation service. This is a
 * local call — no Instagram traffic and no login — so it is safe to run for a
 * bot whose imported cookie session is already valid.
 *
 * Why it exists: `leaseBot` requires `automation_identity IS NOT NULL`, and the
 * web client is built from it, so a bot without one is never leased. Cookie
 * imports used to leave the column NULL; two bots from the 2026-08-28 batch sat
 * "available" for five days without a single lease because of that.
 */
export async function provisionAutomationIdentity(
  bot: { id: string; locale?: string | null; timezone?: string | null },
  automation = createAutomationClient({ timeoutMs: 10_000 }),
): Promise<AutomationIdentity> {
  const raw = await automation.createIdentity({
    bot_id: bot.id,
    locale: bot.locale ?? undefined,
    timezone: bot.timezone ?? undefined,
  });
  const identity = parseAutomationIdentity(raw, bot.id);
  if (!identity) {
    throw new Error(`[automation-identity] service returned an invalid identity for bot ${bot.id}`);
  }
  return identity;
}
