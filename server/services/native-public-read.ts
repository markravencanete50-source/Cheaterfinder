import { createAutomationClient, type AutomationIdentity } from "./automation-client.js";
import { proxyAgentUriForEndpoint } from "./proxy-provider.js";
import { persistRefreshedWebSession } from "./web-session-refresh.js";
import { recordBytes } from "./bandwidth-meter.js";
import { IGAuthExpiredError, IGHttpError, IGRateLimitedError, type IGErrorCode } from "../ig-http-client.js";
import { inspectInstagramAuthResponse } from './instagram-auth-diagnostics.js';
import { currentScrapeOperation } from './scrape-operation.js';
import { logger } from '../observability/logger.js';

// These are fixed codes emitted by the local native reader, never upstream
// messages. Unknown future responses keep a generic reason until reviewed.
const NATIVE_FAILURE_REASONS = new Set([
  'rate_limited', 'login_required', 'challenge_required', 'checkpoint_required',
  'feedback_required', 'request_rejected', 'profile_not_found', 'profile_identity_mismatch',
  'native_navigation_origin_mismatch', 'native_page_response_failed', 'native_page_query_failed',
  'native_page_schema_changed', 'native_relationship_conflict', 'native_highlights_incomplete',
  'highlight_owner_mismatch', 'native_post_schema_changed', 'native_post_metrics_missing',
  'post_owner_mismatch', 'native_profile_response_missing', 'private_profile_not_supported',
  'native_posts_response_missing', 'native_posts_incomplete', 'native_posts_empty_despite_profile',
  'native_reels_incomplete', 'reel_owner_mismatch', 'native_reel_schema_changed',
  'native_reel_navigation_failed', 'native_reel_navigation_mismatch',
  'native_stories_empty_despite_profile', 'native_reel_response_missing',
  'native_response_unreadable', 'native_navigation_failed', 'native_navigation_mismatch',
  'native_authentication_unverified', 'native_highlights_response_missing',
  'native_highlights_window_exceeded', 'native_read_failed', 'native_read_deadline', 'native_browser_failed',
]);

export interface NativeViewer {
  id: string;
  transport: "web" | "mobile";
  automationIdentity: AutomationIdentity | null;
  proxyEndpoint: string | null;
  sessionData: string;
}

/** One existing viewer and one normal UI read. Caller owns lease and budget. */
export async function readNativePublic(
  bot: NativeViewer, kind: "profile" | "posts" | "stories" | "highlights", username: string, userId?: string, limit = 24, withItems = false, onSessionRefresh?: (sessionData: string) => void,
): Promise<unknown> {
  if (bot.transport !== "web" || !bot.automationIdentity || bot.automationIdentity.bot_id !== bot.id || !bot.proxyEndpoint) throw Error("Native public read requires an existing web identity and proxy");
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(username) || (userId !== undefined && !/^[1-9][0-9]*$/.test(userId))) throw Error('Native public read requires an exact target identity');
  const operation = currentScrapeOperation();
  if (operation) { operation.transport = 'browser-ui'; operation.viewerBotId = bot.id; }
  const proxy = new URL(proxyAgentUriForEndpoint(bot.proxyEndpoint));
  const result = await createAutomationClient({ timeoutMs: 95_000 }).readNativePublicPage({
    identity: bot.automationIdentity, storage_state: JSON.parse(bot.sessionData),
    proxy: { server: `${proxy.protocol}//${proxy.hostname}:${proxy.port}`, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) },
    kind, target_username: username, ...(userId ? { target_user_id: userId } : {}), max_items: limit, with_items: withItems, deadline_ms: 90_000,
    ...(operation ? { operation_id: operation.id } : {}),
  });
  const status = Number.isInteger(result.status) && result.status >= 0 && result.status <= 599 ? result.status : 502;
  const reportFailure = (reason: string) => logger.warn({ endpoint: kind, status, nativeReason: reason },
    'Native UI read did not complete');
  recordBytes({ endpoint: kind, botId: bot.id, transport: "browser", byteSource: "browser_wire",
    bytesIn: Math.max(0, result.wire_bytes_in ?? 0), bytesOut: Math.max(0, result.wire_bytes_out ?? 0), failed: status !== 200 });
  if (status === 429) { reportFailure('rate_limited'); throw new IGRateLimitedError(60_000); }
  let body: { status?: string; message?: string };
  try { body = JSON.parse(result.body); }
  catch {
    reportFailure('native_non_json_response');
    throw new IGHttpError(status || 502, 'Native browser returned a non-JSON response', {
      authDiagnostics: inspectInstagramAuthResponse(status, result.body) ?? undefined,
    });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    reportFailure('native_invalid_envelope');
    throw new IGHttpError(502, 'Native browser returned an invalid envelope');
  }
  const reason = typeof body.message === 'string' && NATIVE_FAILURE_REASONS.has(body.message) ? body.message : 'native_read_failed';
  if (status !== 200 || body.status !== 'ok') reportFailure(reason);
  if (body.message === "private_profile_not_supported") throw Error("Private profile requires its separately authorized collection flow");
  if (body.message === "rate_limited") throw new IGRateLimitedError(60_000);
  const code = ["checkpoint_required", "challenge_required", "feedback_required", "login_required"].includes(body.message ?? "") ? body.message as IGErrorCode : undefined;
  if (body.message === "login_required") throw new IGAuthExpiredError("Native browser requires login", { status, body: result.body });
  if (status !== 200 || body.status !== "ok") throw new IGHttpError(status === 200 ? 502 : status, `Native ${kind} read failed (${reason})`, {
    igErrorCode: code, authDiagnostics: inspectInstagramAuthResponse(status, result.body) ?? undefined,
  });
  if (result.storage_state) {
    const refreshedSession = JSON.stringify(result.storage_state);
    onSessionRefresh?.(refreshedSession);
    try { await persistRefreshedWebSession(bot.id, bot.sessionData, refreshedSession); }
    catch { logger.warn({ botId: bot.id }, 'Native browser session refresh could not be saved'); }
  }
  return body;
}
