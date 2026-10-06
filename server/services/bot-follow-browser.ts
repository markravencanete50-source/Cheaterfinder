import type { IGFriendshipStatus } from "../domain/ig-client-port.js";
import { decryptSessionData, encryptSessionData } from "../crypto/session-envelope.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.js";
import { botAccounts } from "../../shared/schema.js";
import { logger } from "../observability/logger.js";
import { createAutomationClient } from "./automation-client.js";
import type { BotRuntimeContext } from "./bot-runtime.js";
import { recordBytes } from "./bandwidth-meter.js";
import { proxyAgentUriForEndpoint } from "./proxy-provider.js";

const browserState = z.object({
  cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string() }).passthrough()),
  origins: z.array(z.unknown()).optional(),
});

async function saveRefreshedSession(runtime: BotRuntimeContext, value: unknown, requireKnownIdentity = false): Promise<void> {
  const parsed = browserState.safeParse(value);
  if (!parsed.success) return;
  const cookies = parsed.data.cookies.filter(c => /(^|\.)instagram\.com$/.test(c.domain));
  const cookie = (name: string) => cookies.find(c => c.name === name)?.value;
  if (!cookie("sessionid") || !cookie("csrftoken")) return;
  const previous = JSON.parse(decryptSessionData(runtime.sessionData));
  const previousUser = previous.cookies?.find((c: {name:string;value:string}) => c.name === "ds_user_id")?.value;
  if (requireKnownIdentity && !/^\d+$/.test(previousUser ?? "")) return;
  if (previousUser && cookie("ds_user_id") !== previousUser) return;
  const next = JSON.stringify(parsed.data);
  if (next.length > 1_000_000) return;
  const [stored] = await db.select({ sessionData: botAccounts.sessionData }).from(botAccounts)
    .where(eq(botAccounts.id, runtime.botId)).limit(1);
  // A concurrent login owns its newer session. Do not overwrite it with the
  // browser state from this older operation.
  if (!stored?.sessionData || decryptSessionData(stored.sessionData) !== decryptSessionData(runtime.sessionData)) return;
  await db.update(botAccounts).set({ sessionData: encryptSessionData(next), updatedAt: new Date() })
    .where(and(eq(botAccounts.id, runtime.botId), eq(botAccounts.sessionData, stored.sessionData)));
}

export class BrowserFollowUnconfirmedError extends Error {
  constructor(readonly clicked: boolean, readonly reason: string | null) {
    const detail = reason ? ` (${reason})` : "";
    super(clicked
      ? `Browser follow outcome unconfirmed; check relationship before another attempt${detail}`
      : `Browser follow was not sent; no confirmed relationship${detail}`);
    this.name = 'BrowserFollowUnconfirmedError';
  }
}

/** One browser action; an uncertain result never falls back to another write. */
export async function sendBrowserFollow(
  runtime: BotRuntimeContext,
  targetUsername: string,
  targetPk: string,
): Promise<IGFriendshipStatus> {
  if (!runtime.automationIdentity || runtime.automationIdentity.bot_id !== runtime.botId
      || runtime.transport !== "web" || !runtime.proxyEndpoint) {
    throw new Error("Browser follow requires the assigned web bot identity and proxy");
  }
  if (!/^[A-Za-z0-9._]{1,30}$/.test(targetUsername) || !/^\d+$/.test(targetPk)) {
    throw new Error("Browser follow requires a valid target username and numeric ID");
  }
  const proxyUrl = new URL(proxyAgentUriForEndpoint(runtime.proxyEndpoint));
  const response = await createAutomationClient({ timeoutMs: 95_000 }).followInstagramBrowser({
    identity: runtime.automationIdentity,
    storage_state: JSON.parse(decryptSessionData(runtime.sessionData)),
    proxy: {
      server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
      ...(proxyUrl.username ? { username: decodeURIComponent(proxyUrl.username) } : {}),
      ...(proxyUrl.password ? { password: decodeURIComponent(proxyUrl.password) } : {}),
    },
    target_username: targetUsername,
    target_user_id: targetPk,
    deadline_ms: 90_000,
  });
  const confirmed = response.confirmed === true
    && typeof response.following === "boolean" && typeof response.outgoing_request === "boolean"
    && (response.following || response.outgoing_request)
    && (response.status === "accepted" || response.status === "pending");
  const bytesIn = Number.isFinite(response.wire_bytes_in) && response.wire_bytes_in > 0 ? response.wire_bytes_in : 0;
  const bytesOut = Number.isFinite(response.wire_bytes_out) && response.wire_bytes_out > 0 ? response.wire_bytes_out : 0;
  if (bytesIn || bytesOut) recordBytes({
    endpoint: "follow_action", botId: runtime.botId, transport: "browser",
    byteSource: "browser_wire", bytesIn, bytesOut, failed: !confirmed,
  });
  // Browser cookie/consent renewal is independent of confirming a follow.
  // Retain a same-identity refresh after an interrupted read/write so the
  // next relationship check does not reuse the obsolete cookie. This never
  // marks the request successful or changes bot health. Login/challenge and
  // malformed responses cannot supply an unconfirmed refresh.
  const refreshAfterInterruption = ['not_sent', 'unknown'].includes(response.status)
    && ['target_navigation_mismatch', 'friendship_unavailable', 'follow_control_unavailable',
      'insufficient_confirmation_time', 'follow_not_confirmed', 'deadline_exceeded',
      'browser_operation_failed'].includes(response.reason ?? '');
  if (response.storage_state && (confirmed || refreshAfterInterruption)) {
    try { await saveRefreshedSession(runtime, response.storage_state, !confirmed); }
    catch { logger.warn({ botId: runtime.botId }, "Follow browser session refresh could not be persisted"); }
  }
  if (!confirmed) {
    const allowedReasons = new Set(["login_required", "challenge_required", "target_navigation_mismatch", "friendship_unavailable",
      "rate_limited", "follow_control_unavailable", "insufficient_confirmation_time", "follow_not_confirmed",
      "saved_session_unavailable", "deadline_exceeded", "browser_operation_failed"]);
    const reason = response.reason && allowedReasons.has(response.reason) ? response.reason : null;
    throw new BrowserFollowUnconfirmedError(response.clicked === true, reason);
  }
  return {
    following: response.following, outgoingRequest: response.outgoing_request,
    incomingRequest: false, followedBy: false, isPrivate: true,
  };
}
