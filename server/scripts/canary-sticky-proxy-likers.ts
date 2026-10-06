// Supervised recovery canary for a DataImpulse sticky-port lane.
//
// This intentionally bypasses the normal account-proxy allocator: the normal
// runtime rejects short-lived DataImpulse lanes for authenticated sessions.
// We first establish a fresh Firefox session on a 120-minute sticky lane, prove
// the exit stayed stable through login, and make one authenticated likers read.
// Only after every check passes do we replace the old encrypted session. The
// selected bot must be a reserve, so a failed canary cannot enter live rotation.
// Both staged and session-expired reserves are accepted: an expired reserve has
// no cookie jar to preserve, but must pass the exact same login and liker gates.

import "dotenv/config";

import { sql } from "drizzle-orm";
import {
  ProxyAgent,
  fetch as undiciFetch,
} from "undici";

import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import { decryptCredential } from "../crypto/credentials.js";
import { encryptSessionData } from "../crypto/session-envelope.js";
import { db, pool } from "../db.js";
import { createBotClient, IGHttpError } from "../ig-http-client.js";
import {
  createAutomationClient,
  type AutomationInstagramLoginResponse,
  type AutomationProxy,
} from "../services/automation-client.js";
import { requireAutomationIdentity } from "../services/automation-identity.js";
import { fetchVerificationCode } from "../services/email-code-fetcher.js";
import { isKnownEphemeralDataImpulseProxyUrl } from "../services/proxy-durability.js";
import {
  proxyEndpointLabel,
  scrubProxyCredential,
} from "../services/proxy-provider.js";
import { generateTotp } from "../services/totp.js";

const SESSION_TTL_MINUTES = 120;
// Stop using the lane well before the provider's advertised rotation point.
const SAFE_RUNTIME_MINUTES = 90;
const LOGIN_TIMEOUT_MS = 120_000;

interface BotRow {
  id: string;
  ig_username: string;
  session_data: string | null;
  ig_password_encrypted: string;
  email_address: string | null;
  email_password_encrypted: string | null;
  imap_host: string | null;
  imap_port: number | null;
  totp_secret: string | null;
  automation_identity: unknown;
  proxy_url: string;
  tier: "reserve";
  status: "available" | "session_expired";
  device_id: string | null;
  device_user_agent: string | null;
  ig_app_id: string | null;
  timezone: string | null;
  locale: string | null;
  awake_hour_start: number | null;
  awake_hour_end: number | null;
}

interface MediaCandidate {
  shortcode: string;
  media_id: string;
}

class SuspendedCanaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuspendedCanaryError";
  }
}

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function requireArgs(): { botId: string; promote: boolean } {
  if (!process.argv.includes("--apply")) {
    throw new Error("refusing dry invocation; pass --apply");
  }
  const botId = argValue("bot-id");
  if (!botId || !/^[0-9a-f-]{36}$/i.test(botId)) {
    throw new Error("pass a valid --bot-id=<uuid>");
  }
  return { botId, promote: process.argv.includes("--promote") };
}

function proxyWithFullStickyTtl(rawProxyUrl: string): URL {
  const parsed = new URL(
    rawProxyUrl.includes("://") ? rawProxyUrl : `http://${rawProxyUrl}`,
  );
  if (!parsed.username || !parsed.password || !parsed.hostname || !parsed.port) {
    throw new Error("selected proxy URL is missing required fields");
  }

  const username = decodeURIComponent(parsed.username);
  const marker = username.indexOf("__");
  const base = marker >= 0 ? username.slice(0, marker) : username;
  const existing = marker >= 0 ? username.slice(marker + 2) : "";
  const params = existing
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !/^sessttl\.\d+$/i.test(value));
  params.push(`sessttl.${SESSION_TTL_MINUTES}`);
  parsed.username = `${base}__${params.join(";")}`;
  return parsed;
}

function endpointFromProxyUrl(proxyUrl: URL): string {
  const username = decodeURIComponent(proxyUrl.username);
  const password = decodeURIComponent(proxyUrl.password);
  return `${proxyUrl.hostname}:${proxyUrl.port}:${username}:${password}`;
}

function automationProxy(proxyUrl: URL): AutomationProxy {
  return {
    server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
    username: decodeURIComponent(proxyUrl.username),
    password: decodeURIComponent(proxyUrl.password),
  };
}

async function readExit(proxyUrl: URL): Promise<string> {
  const dispatcher = new ProxyAgent({
    uri: proxyUrl.toString(),
    allowH2: false,
  });
  try {
    const response = await undiciFetch("https://api.ipify.org?format=json", {
      dispatcher,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`exit probe returned ${response.status}`);
    const body = (await response.json()) as { ip?: unknown };
    if (typeof body.ip !== "string" || body.ip.length < 7) {
      throw new Error("exit probe returned an invalid response");
    }
    return body.ip;
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

async function loadBot(botId: string): Promise<BotRow> {
  const result = (await db.execute(sql`
    SELECT id, ig_username, session_data, ig_password_encrypted,
           email_address, email_password_encrypted, imap_host, imap_port,
           totp_secret, automation_identity, proxy_url, tier, status,
           device_id, device_user_agent, ig_app_id, timezone, locale,
           awake_hour_start, awake_hour_end
    FROM bot_accounts
    WHERE id = ${botId}
      AND tier = 'reserve'
      AND status IN ('available', 'session_expired')
      AND ig_password_encrypted IS NOT NULL
      AND automation_identity IS NOT NULL
      AND proxy_url IS NOT NULL
    LIMIT 1
  `)) as unknown as { rows: BotRow[] };
  const bot = result.rows[0];
  if (!bot) {
    throw new Error("bot is not an eligible staged or session-expired reserve");
  }
  if (!isKnownEphemeralDataImpulseProxyUrl(bot.proxy_url)) {
    throw new Error("bot is not assigned to the expected DataImpulse sticky range");
  }
  return bot;
}

async function completeLogin(
  bot: BotRow,
  proxy: AutomationProxy,
): Promise<Record<string, unknown>> {
  const identity = requireAutomationIdentity(bot.automation_identity, bot.id);
  const automation = createAutomationClient({
    timeoutMs: LOGIN_TIMEOUT_MS + 60_000,
  });

  const probe = await automation.probeInstagramLogin({
    identity,
    proxy,
    timeout_ms: 45_000,
  });
  if (probe.status !== "ready") {
    throw new Error(`Instagram login preflight was ${probe.status}`);
  }
  console.log("[sticky-canary] Firefox login preflight passed");

  const startedAt = new Date();
  let result: AutomationInstagramLoginResponse =
    await automation.startInstagramLogin({
      identity,
      credentials: {
        username: bot.ig_username,
        password: decryptCredential(bot.ig_password_encrypted),
      },
      proxy,
      timeout_ms: LOGIN_TIMEOUT_MS,
    });

  let codeAttempts = 0;
  while (result.status === "code_required" && codeAttempts < 2) {
    codeAttempts += 1;
    let code: string | null;
    if (result.code_kind === "totp") {
      if (!bot.totp_secret) {
        throw new Error("Instagram requested TOTP but the bot has no secret");
      }
      code = generateTotp(bot.totp_secret);
    } else {
      code = await fetchVerificationCode(
        {
          emailAddress: bot.email_address,
          emailPassword: bot.email_password_encrypted
            ? decryptCredential(bot.email_password_encrypted)
            : null,
          imapHost: bot.imap_host,
          imapPort: bot.imap_port,
        },
        {
          since: new Date(
            (codeAttempts === 1 ? startedAt.getTime() : Date.now()) - 60_000,
          ),
          timeoutMs: 120_000,
        },
      );
      if (!code) throw new Error("Instagram email verification code did not arrive");
    }
    if (!result.login_id) throw new Error("automation login omitted challenge id");
    result = await automation.completeInstagramLogin({
      login_id: result.login_id,
      code,
      timeout_ms: LOGIN_TIMEOUT_MS,
    });
  }

  if (result.status !== "authenticated" || !result.storage_state) {
    const detail = result.message ? ` (${result.message})` : "";
    if (result.status === "suspended") {
      throw new SuspendedCanaryError(`Instagram login outcome was suspended${detail}`);
    }
    throw new Error(`Instagram login outcome was ${result.status}${detail}`);
  }
  return result.storage_state;
}

async function loadMediaCandidates(): Promise<MediaCandidate[]> {
  const result = (await db.execute(sql`
    SELECT p.shortcode, p.media_id
    FROM posts_cache p
    JOIN tracked_accounts t ON t.id = p.tracked_account_id
    WHERE p.media_id IS NOT NULL
      AND p.media_id <> ''
      AND t.is_active = TRUE
      AND t.is_private = FALSE
      AND p.like_count > 0
    ORDER BY
      (SELECT MAX(l.cached_at)
       FROM likers_cache l
       WHERE l.post_shortcode = p.shortcode) DESC NULLS LAST,
      p.taken_at DESC NULLS LAST
    LIMIT 5
  `)) as unknown as { rows: MediaCandidate[] };
  if (result.rows.length === 0) throw new Error("no public media candidate exists");
  return result.rows;
}

async function proveLikersRead(
  bot: BotRow,
  storageState: Record<string, unknown>,
  endpoint: string,
): Promise<{ users: number; total: number }> {
  const identity = requireAutomationIdentity(bot.automation_identity, bot.id);
  const fingerprint = resolveFingerprint({
    igUsername: bot.ig_username,
    deviceId: bot.device_id,
    deviceUserAgent: bot.device_user_agent,
    igAppId: bot.ig_app_id,
    timezone: bot.timezone,
    locale: bot.locale,
    awakeHourStart: bot.awake_hour_start,
    awakeHourEnd: bot.awake_hour_end,
  });
  const client = createBotClient(JSON.stringify(storageState), {
    botId: bot.id,
    botUsername: bot.ig_username,
    proxyEndpoint: endpoint,
    fingerprint,
    automationIdentity: identity,
    automationTransport: "browser",
  });

  try {
    const candidates = await loadMediaCandidates();
    let lastStatus = "unknown";
    for (const [index, candidate] of candidates.entries()) {
      try {
        const page = await client.fetchMediaLikers(candidate.media_id);
        console.log(
          `[sticky-canary] liker endpoint passed on candidate ${index + 1}`,
        );
        return { users: page.users.length, total: page.totalCount };
      } catch (error) {
        if (
          error instanceof IGHttpError
          && error.status === 400
          && error.body?.toLowerCase().includes("checkpoint_required")
          && (
            error.body.toLowerCase().includes("/accounts/suspended")
            || error.body.toLowerCase().includes('"lock":true')
          )
        ) {
          throw new SuspendedCanaryError(
            "Instagram suspended/checkpointed the canary during liker read",
          );
        }
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? String((error as { status: unknown }).status)
            : error instanceof Error
              ? error.name
              : "error";
        lastStatus = status;
        console.log(
          `[sticky-canary] media candidate ${index + 1} failed (${status})`,
        );
      }
    }
    throw new Error(`all liker candidates failed (${lastStatus})`);
  } finally {
    await client.close();
  }
}

async function persistPassedCanary(
  bot: BotRow,
  storageState: Record<string, unknown>,
  endpoint: string,
  promote: boolean,
): Promise<void> {
  const encrypted = encryptSessionData(JSON.stringify(storageState));
  const expiresAt = new Date(Date.now() + SAFE_RUNTIME_MINUTES * 60 * 1000);
  const sessionLabel = `di-sticky-${Date.now()}`;
  const result = promote
    ? await db.execute(sql`
        UPDATE bot_accounts SET
          session_data = ${encrypted},
          proxy_url = NULL,
          proxy_endpoint = ${endpoint},
          proxy_session_id = ${sessionLabel},
          proxy_expires_at = ${expiresAt.toISOString()},
          status = 'available',
          tier = 'worker',
          cooldown_until = NULL,
          last_login_at = NOW(),
          last_login_error = NULL,
          login_attempt_count = login_attempt_count + 1,
          updated_at = NOW()
        WHERE id = ${bot.id}
          AND tier = 'reserve'
          AND status = ${bot.status}
          AND session_data IS NOT DISTINCT FROM ${bot.session_data}
        RETURNING id
      `)
    : await db.execute(sql`
        UPDATE bot_accounts SET
          session_data = ${encrypted},
          proxy_url = NULL,
          proxy_endpoint = ${endpoint},
          proxy_session_id = ${sessionLabel},
          proxy_expires_at = ${expiresAt.toISOString()},
          status = 'available',
          cooldown_until = NULL,
          last_login_at = NOW(),
          last_login_error = NULL,
          login_attempt_count = login_attempt_count + 1,
          updated_at = NOW()
        WHERE id = ${bot.id}
          AND tier = 'reserve'
          AND status = ${bot.status}
          AND session_data IS NOT DISTINCT FROM ${bot.session_data}
        RETURNING id
      `);
  const rows = (result as unknown as { rows: Array<{ id: string }> }).rows;
  if (rows.length !== 1) {
    throw new Error("bot changed concurrently; fresh session was not persisted");
  }
  console.log(
    `[sticky-canary] committed fresh session with ${SAFE_RUNTIME_MINUTES}m fail-closed lane${promote ? " and promoted one worker" : ""}`,
  );
}

let redactionEndpoint: string | null = null;

async function main(): Promise<void> {
  const { botId, promote } = requireArgs();
  const bot = await loadBot(botId);
  try {
  const ttlProxyUrl = proxyWithFullStickyTtl(bot.proxy_url);
  const endpoint = endpointFromProxyUrl(ttlProxyUrl);
  redactionEndpoint = endpoint;
  console.log(
    `[sticky-canary] selected reserve ${bot.id.slice(0, 8)} via ${proxyEndpointLabel(endpoint)}`,
  );

  const firstExit = await readExit(ttlProxyUrl);
  const secondExit = await readExit(ttlProxyUrl);
  if (firstExit !== secondExit) {
    throw new Error("sticky exit changed during pre-login probes");
  }
  console.log("[sticky-canary] pre-login exit stable across fresh connections");

  const storageState = await completeLogin(bot, automationProxy(ttlProxyUrl));
  console.log("[sticky-canary] fresh Firefox session authenticated");

  const afterLoginExit = await readExit(ttlProxyUrl);
  if (firstExit !== afterLoginExit) {
    throw new Error("sticky exit changed during login; refusing session commit");
  }
  console.log("[sticky-canary] exit remained stable through login");

  const likerProof = await proveLikersRead(bot, storageState, endpoint);
  const finalExit = await readExit(ttlProxyUrl);
  if (firstExit !== finalExit) {
    throw new Error("sticky exit changed during liker probe; refusing session commit");
  }
  console.log(
    `[sticky-canary] proof complete users=${likerProof.users} reported_total=${likerProof.total}`,
  );

  await persistPassedCanary(bot, storageState, endpoint, promote);
  } catch (error) {
    if (error instanceof SuspendedCanaryError) {
      await db.execute(sql`
        UPDATE bot_accounts SET
          status = 'banned',
          cooldown_until = NULL,
          last_login_error = 'checkpoint_required: suspended during supervised sticky canary',
          updated_at = NOW()
        WHERE id = ${bot.id}
          AND tier = 'reserve'
      `);
      console.log("[sticky-canary] suspended canary quarantined");
    }
    throw error;
  }
}

main()
  .catch((error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    const safe = redactionEndpoint
      ? scrubProxyCredential(raw, redactionEndpoint)
      : raw;
    console.error(`[sticky-canary] FAILED: ${safe}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
