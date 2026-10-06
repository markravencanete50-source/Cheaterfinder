// ─── Bot runtime helpers — proxy + session readiness ─────────────────────────
//
// Wave 4 glue layer between bot_accounts row state and the IG client. Every
// collector entry point calls `ensureBotReady(botId)` once at the top of its
// flow. The helper:
//
//   1. ensures the bot has a valid proxy endpoint without moving an existing
//      authenticated session to a different exit IP
//   2. ensures the bot has a non-expired session_data (auto-relogin if not)
//   3. returns { sessionData, proxyUrl, fingerprint } the existing client APIs
//      expect, without leaking encrypted column values
//
// Auto-relogin replaces the Wave 2/3 "session_expired → admin must re-auth"
// pattern: as long as the row still has ig_password_encrypted +
// email_password_encrypted, we can recover the bot ourselves.
// ─────────────────────────────────────────────────────────────────────────────

import { eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { botAccounts } from "../../shared/schema.js";
import { decryptCredential } from "../crypto/credentials.js";
import {
  decryptSessionData,
  encryptSessionData,
  isEncryptedEnvelope,
} from "../crypto/session-envelope.js";
import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import {
  fetchHealthyEndpoints,
  isEndpointFresh,
  proxyAgentUriForEndpoint,
  proxyEndpointLabel,
  scrubProxyCredential,
} from "./proxy-provider.js";
import {
  LoginAccountSuspendedError,
  LoginBadCredentialsError,
  LoginCaptchaRequiredError,
  Login2FARequiredButNoSecretError,
  LoginRateLimitedError,
  loginBotWithRetry,
} from "./bot-login.js";
import {
  createAutomationClient,
  type AutomationIdentity,
  type AutomationProxy,
  type AutomationInstagramLoginResponse,
} from "./automation-client.js";
import { requireAutomationIdentity } from "./automation-identity.js";
import {
  assertDurableAccountProxyUrl,
  isKnownEphemeralDataImpulseProxyUrl,
} from "./proxy-durability.js";
import { fetchVerificationCode } from "./email-code-fetcher.js";
import { generateTotp } from "./totp.js";
import { formatCooldownReason, reloginBackoffMs } from "./bot-cooldown.js";
import { OperationBusyError, withOperationLease } from "./operation-lease.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "bot-runtime" });

export function isBotAutoLoginEnabled(): boolean {
  return process.env.BOT_AUTO_LOGIN_ENABLED !== "false";
}

function automationLoginTimeoutMs(): number {
  const configured = Number(process.env.AUTOMATION_LOGIN_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(configured)) return 120_000;
  return Math.min(120_000, Math.max(10_000, Math.trunc(configured)));
}

function allowShortLivedAccountProxy(): boolean {
  return process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY === "true";
}

export interface BotRuntimeContext {
  botId: string;
  igUsername: string;
  sessionData: string;
  proxyUrl: string;
  proxyEndpoint: string;
  /** Present only after this bot has been explicitly migrated to FastAPI. */
  automationIdentity: AutomationIdentity | null;
  /** Read transport: 'web' (default) or 'mobile' (Bearer IGT:2 session). */
  transport: "web" | "mobile";
}

interface BotRow {
  id: string;
  ig_username: string;
  session_data: string | null;
  ig_password_encrypted: string | null;
  email_address: string | null;
  email_password_encrypted: string | null;
  imap_host: string | null;
  imap_port: number | null;
  // Wave 7: Base32-encoded TOTP secret for Google Authenticator-style 2FA.
  // Null for legacy bots that use the email-OTP path.
  totp_secret: string | null;
  device_id: string | null;
  device_user_agent: string | null;
  ig_app_id: string | null;
  timezone: string | null;
  locale: string | null;
  awake_hour_start: number | null;
  awake_hour_end: number | null;
  // An explicit per-bot proxy URI takes precedence over provider allocation.
  proxy_url: string | null;
  proxy_endpoint: string | null;
  proxy_session_id: string | null;
  proxy_expires_at: Date | null;
  automation_identity: unknown;
  // Migration 0038: 'web' (default) or 'mobile' (Bearer IGT:2 session).
  transport: string | null;
  // Read by the relogin sweep (only session_expired rows are re-driven) and by
  // the login back-off (geometric on the attempt count). Both nullable so a
  // partial row from an older SELECT still type-checks.
  status?: string | null;
  tier?: string | null;
  login_attempt_count?: number | string | null;
  cooldown_until?: Date | string | null;
  last_login_error?: string | null;
  recovery_version?: string;
}

type BotExecutor = Pick<typeof db, "execute">;
type PersistBotWrite = (write: (executor: BotExecutor) => Promise<void>) => Promise<void>;
const persistBotWrite: PersistBotWrite = (write) => write(db);

async function loadBot(botId: string, executor: BotExecutor = db, forUpdate = false): Promise<BotRow> {
  const result = (await executor.execute(sql`
    SELECT id, ig_username, session_data,
           ig_password_encrypted, email_address, email_password_encrypted,
           imap_host, imap_port, totp_secret,
           device_id, device_user_agent, ig_app_id, timezone, locale,
           awake_hour_start, awake_hour_end,
           proxy_url, proxy_endpoint, proxy_session_id, proxy_expires_at,
           automation_identity, transport, status, tier, login_attempt_count,
           cooldown_until, last_login_error, updated_at::text AS recovery_version
    FROM bot_accounts
    WHERE id = ${botId}
    ${forUpdate ? sql`FOR UPDATE` : sql``}
  `)) as unknown as { rows: BotRow[] };
  const bot = result.rows[0];
  if (!bot) throw new Error(`[bot-runtime] bot ${botId} not found`);
  return bot;
}

/**
 * Derive a proxy country from the bot's persona locale (e.g. "de-DE" → "de",
 * "en-US" → "us") so its exit IP matches the account's home country. Returns
 * undefined when the locale has no region subtag, letting the proxy provider
 * keep the account default geo. proxy-provider also filters this against the
 * set of DataImpulse-supported pools, so an unsupported region (e.g. PK, AU)
 * safely falls back to the default ch,gb,us rotation.
 */
function localeToProxyCountry(locale: string | null): string | undefined {
  if (!locale) return undefined;
  const region = locale.replace("_", "-").split("-")[1];
  if (!region) return undefined;
  const cc = region.trim().toLowerCase();
  return /^[a-z]{2}$/.test(cc) ? cc : undefined;
}

// When a sticky window has lapsed, migrated bots without a usable session
// validate candidates with the
// exact invisible-Firefox login surface before any credentials are submitted.
// This cannot prove that Instagram will accept the account, but it prevents a
// broken or already-throttled proxy from consuming an authentication attempt.
// The fast path (a fresh persisted endpoint) makes no network call at all.
async function ensureProxy(
  bot: BotRow,
  options: {
    hasUsableSession: boolean;
    automationIdentity: AutomationIdentity | null;
    persist?: PersistBotWrite;
  },
): Promise<{
  endpoint: string;
  refreshed: boolean;
  allowProviderRotation: boolean;
}> {
  // An ops-assigned proxy URL is intentionally sticky. Convert it to the
  // endpoint format consumed by the existing Playwright/Undici adapters, but
  // do not persist or refresh a provider endpoint around it.
  if (bot.proxy_url?.trim()) {
    // Defense in depth: a manually populated proxy_url must not bypass the
    // import/promotion guards and bind an account to a rotating provider lane.
    const isKnownShortLived = isKnownEphemeralDataImpulseProxyUrl(bot.proxy_url);
    if (!isKnownShortLived || !allowShortLivedAccountProxy()) {
      assertDurableAccountProxyUrl(bot.proxy_url);
    } else {
      // This escape hatch exists only for an explicit, supervised bootstrap in
      // a non-production environment. A persisted Instagram session is tied to
      // its exit IP; reusing it through DataImpulse's rotating/sticky port is a
      // strong takeover signal and has produced real account suspensions.
      if (process.env.NODE_ENV === "production" || options.hasUsableSession) {
        throw new Error(
          "[bot-runtime] short-lived account proxy override is bootstrap-only; refusing authenticated or production use",
        );
      }
      logger.warn(
        { botId: bot.id },
        "[bot-runtime] short-lived account proxy bootstrap override active",
      );
    }
    return {
      endpoint: endpointFromProxyUrl(bot.proxy_url),
      refreshed: false,
      allowProviderRotation: false,
    };
  }

  const expiresAt = bot.proxy_expires_at ? new Date(bot.proxy_expires_at) : null;
  if (bot.proxy_endpoint && isEndpointFresh(expiresAt)) {
    return { endpoint: bot.proxy_endpoint, refreshed: false, allowProviderRotation: true };
  }

  // A browser session is bound to much more than its cookies. Reusing it from
  // a newly allocated exit IP is a high-risk account-takeover signal. Provider
  // lanes may only be allocated before login (or after an unreadable/missing
  // session forces a deliberate re-login).
  if (options.hasUsableSession) {
    throw new Error(
      "[bot-runtime] authenticated session has no fresh proxy lane; refusing IP rotation",
    );
  }

  // Migrated Firefox bots own their canonical locale in automation_identity.
  // Legacy bot columns can be backfilled independently, so they must not steer
  // the proxy into a country that conflicts with the persisted browser.
  const proxyLocale = options.automationIdentity?.locale ?? bot.locale;
  const country = localeToProxyCountry(proxyLocale);
  logger.info(
    { botId: bot.id, locale: proxyLocale, country: country ?? "default" },
    "[bot-runtime] refreshing proxy endpoint",
  );
  const automationIdentity = options.automationIdentity;
  const [endpoint] = automationIdentity
      ? await fetchHealthyEndpoints(1, {
        country,
        purpose: "account-session",
        maxAttempts: 5,
        probe: async (candidate) => {
          const probeTimeoutMs = 45_000;
          const client = createAutomationClient({ timeoutMs: probeTimeoutMs * 2 + 15_000 });
          try {
            const result = await client.probeInstagramLogin({
              identity: automationIdentity,
              proxy: automationProxyFromEndpoint(candidate),
              timeout_ms: probeTimeoutMs,
            });
            if (result.status === "ready") return candidate;
            logger.warn(
              { botId: bot.id, outcome: result.status },
              "[bot-runtime] rejected proxy during credential-free login preflight",
            );
            return null;
          } catch (error) {
            logger.warn(
              {
                botId: bot.id,
                errorType: error instanceof Error ? error.name : "unknown",
              },
              "[bot-runtime] proxy login preflight failed",
            );
            return null;
          }
        },
      })
    : await fetchHealthyEndpoints(1, { country, purpose: "account-session" });
  if (!endpoint) {
    throw new Error("[bot-runtime] failed to obtain healthy proxy");
  }
  await (options.persist ?? persistBotWrite)(async (executor) => {
    await executor.execute(sql`
      UPDATE bot_accounts SET
        proxy_endpoint = ${endpoint.endpoint},
        proxy_session_id = ${endpoint.sessionId},
        proxy_expires_at = ${endpoint.expiresAt.toISOString()},
        updated_at = NOW()
      WHERE id = ${bot.id}
    `);
  });
  return { endpoint: endpoint.endpoint, refreshed: true, allowProviderRotation: true };
}

/**
 * Convert a standard proxy URI into the canonical endpoint shape understood by
 * proxy-provider (``host:port[:username:password]``). Credentials remain in
 * memory/DB only and every log path uses ``proxyEndpointLabel`` to redact them.
 */
function endpointFromProxyUrl(proxyUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(
      proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`,
    );
  } catch {
    throw new Error("[bot-runtime] proxy_url is not a valid proxy URI");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || !parsed.hostname
    || !parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("[bot-runtime] proxy_url must be http(s)://[user:pass@]host:port");
  }
  const username = parsed.username ? decodeURIComponent(parsed.username) : "";
  const password = parsed.password ? decodeURIComponent(parsed.password) : "";
  if (!username && password) {
    throw new Error("[bot-runtime] proxy_url has a password without a username");
  }
  return username
    ? `${parsed.hostname}:${parsed.port}:${username}:${password}`
    : `${parsed.hostname}:${parsed.port}`;
}

/**
 * Decrypt the row's session_data into Playwright-storage-state JSON, or
 * return null if it's missing/empty (caller will trigger login).
 */
function readSession(bot: BotRow): string | null {
  if (!bot.session_data) return null;
  try {
    return isEncryptedEnvelope(bot.session_data)
      ? decryptSessionData(bot.session_data)
      : bot.session_data;
  } catch (err) {
    logger.warn(
      { botId: bot.id, err: err instanceof Error ? err.message : String(err) },
      "[bot-runtime] session decrypt failed — will re-login",
    );
    return null;
  }
}

async function autoLogin(
  bot: BotRow,
  proxyEndpoint: string,
  allowProviderRotation: boolean,
): Promise<string> {
  if (!bot.ig_password_encrypted) {
    throw new Error(
      `[bot-runtime] bot ${bot.ig_username} has no ig_password_encrypted; cannot auto-login`,
    );
  }
  const igPassword = decryptCredential(bot.ig_password_encrypted);
  // Wave 7: hand a BotEmailContext to bot-login. The email-code-fetcher
  // facade routes IMAP-backed mailboxes (rambler/onet — need imap_host) and
  // web-inbox providers (tmailgg.site — no IMAP, just the address) in the
  // same shape. Build the context whenever the bot has an email_address;
  // the facade itself decides whether IMAP fields are required.
  const email = bot.email_address
    ? {
        email_address: bot.email_address,
        email_password: bot.email_password_encrypted
          ? decryptCredential(bot.email_password_encrypted)
          : null,
        imap_host: bot.imap_host ?? null,
        imap_port: bot.imap_port ?? null,
      }
    : undefined;

  logger.info(
    {
      botId: bot.id,
      username: bot.ig_username,
      proxyEndpoint: proxyEndpointLabel(proxyEndpoint),
    },
    "[bot-runtime] driving auto-login",
  );

  // New imports encrypt TOTP seeds with the bot credential key. generateTotp
  // decrypts only when a code is needed and also accepts legacy Base32 rows.
  const totpSecret = bot.totp_secret ?? undefined;
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

  try {
    const result = await loginBotWithRetry(
      {
        igUsername: bot.ig_username,
        igPassword,
        email,
        totpSecret,
        userAgent: fingerprint.userAgent,
        timezone: fingerprint.timezone,
        locale: fingerprint.locale,
      },
      { endpoint: proxyEndpoint },
      3,
      { allowProxyRotation: allowProviderRotation },
    );
    const encrypted = encryptSessionData(result.storageStateJson);
    await db.execute(sql`
      UPDATE bot_accounts SET
        session_data = ${encrypted},
        last_login_at = NOW(),
        last_login_error = NULL,
        consecutive_hard_failures = 0,
        last_hard_failure_at = NULL,
        warm_failure_streak = 0,
        cooldown_until = CASE WHEN cooldown_until <= NOW() THEN NULL ELSE cooldown_until END,
        login_attempt_count = login_attempt_count + 1,
        updated_at = NOW()
      WHERE id = ${bot.id}
    `);
    return result.storageStateJson;
  } catch (err) {
    // SECURITY (B5): lower layers (undici connect/timeout errors) can splice
    // the full user:pass@host proxy URI into the message. Scrub the known
    // endpoint's credentials before this string is persisted to
    // `last_login_error` or surfaced in a thrown error / log.
    const rawMsg = err instanceof Error ? err.message : String(err);
    const msg = scrubProxyCredential(rawMsg, proxyEndpoint);
    if (err instanceof LoginAccountSuspendedError) {
      await db.execute(sql`
        UPDATE bot_accounts SET
          status = 'banned',
          session_data = NULL,
          cooldown_until = NULL,
          last_login_error = ${msg.slice(0, 500)},
          login_attempt_count = login_attempt_count + 1,
          updated_at = NOW()
        WHERE id = ${bot.id}
      `);
      throw err;
    }
    if (
      err instanceof LoginBadCredentialsError ||
      err instanceof LoginCaptchaRequiredError ||
      err instanceof Login2FARequiredButNoSecretError
    ) {
      await db.execute(sql`
        UPDATE bot_accounts SET
          status = 'session_expired',
          session_data = NULL,
          cooldown_until = NULL,
          last_login_error = ${msg.slice(0, 500)},
          login_attempt_count = login_attempt_count + 1,
          updated_at = NOW()
        WHERE id = ${bot.id}
      `);
      throw err;
    }
    await db.execute(sql`
      UPDATE bot_accounts SET
        last_login_error = ${msg.slice(0, 500)},
        login_attempt_count = login_attempt_count + 1,
        updated_at = NOW()
      WHERE id = ${bot.id}
    `);
    // SECURITY (B5): the generic branch covers undici/transport errors whose
    // message may carry the proxy URI. If scrubbing changed the message, the
    // original error is unsafe to surface to downstream loggers — re-throw a
    // scrubbed Error (keeping the original as `cause` for local debugging).
    if (msg !== rawMsg) {
      throw new Error(msg, err instanceof Error ? { cause: err } : undefined);
    }
    throw err;
  }
}

function automationProxyFromEndpoint(proxyEndpoint: string): AutomationProxy {
  let parsed: URL;
  try {
    parsed = new URL(proxyAgentUriForEndpoint(proxyEndpoint));
  } catch {
    throw new Error("[bot-runtime] invalid proxy endpoint for automation login");
  }
  if (!parsed.hostname || !parsed.port) {
    throw new Error("[bot-runtime] proxy endpoint is missing host or port");
  }
  return {
    server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  };
}

function loginErrorFromAutomation(
  response: AutomationInstagramLoginResponse,
  username: string,
): Error {
  const message = response.message ?? "automation login failed";
  switch (response.status) {
    case "bad_credentials":
      return new LoginBadCredentialsError(
        `[bot-runtime] IG rejected username/password for ${username}`,
      );
    case "captcha_required":
      return new LoginCaptchaRequiredError(
        `[bot-runtime] IG requires CAPTCHA for ${username}`,
      );
    case "suspended":
      return new LoginAccountSuspendedError(
        `[bot-runtime] IG suspended ${username}`,
      );
    case "rate_limited":
      return new LoginRateLimitedError(
        `[bot-runtime] IG rate limited login for ${username}`,
      );
    default:
      return new Error(`[bot-runtime] ${message}`);
  }
}

async function autoLoginWithAutomation(
  bot: BotRow,
  proxyEndpoint: string,
  persist: PersistBotWrite = persistBotWrite,
): Promise<string> {
  if (!bot.ig_password_encrypted) {
    throw new Error(
      `[bot-runtime] bot ${bot.ig_username} has no ig_password_encrypted; cannot auto-login`,
    );
  }
  const identity = requireAutomationIdentity(bot.automation_identity, bot.id);
  const loginTimeoutMs = automationLoginTimeoutMs();
  // The FastAPI-side login timeout starts only *after* invisible-playwright
  // has launched Firefox and navigated to the form. Its HTTP caller therefore
  // needs room for that bounded setup work as well; otherwise Undici aborts a
  // healthy in-flight login before FastAPI can return its outcome.
  const client = createAutomationClient({ timeoutMs: loginTimeoutMs + 60_000 });
  const startedAt = new Date();
  let result = await client.startInstagramLogin({
    identity,
    credentials: {
      username: bot.ig_username,
      password: decryptCredential(bot.ig_password_encrypted),
    },
    proxy: automationProxyFromEndpoint(proxyEndpoint),
    timeout_ms: loginTimeoutMs,
  });

  // An email mailbox can surface a stale code first. The FastAPI service keeps
  // the same Firefox challenge page alive when IG still requests a code, so
  // fetch/submit at most one fresh retry without restarting the whole login.
  let codeAttempts = 0;
  while (result.status === "code_required" && codeAttempts < 2) {
    codeAttempts += 1;
    let code: string | null = null;
    if (result.code_kind === "totp") {
      if (!bot.totp_secret) {
        throw new Login2FARequiredButNoSecretError(
          `[bot-runtime] IG asked for authenticator-app 2FA code but no totpSecret was supplied for ${bot.ig_username}`,
        );
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
      if (!code) {
        throw new Error(
          `[bot-runtime] did not receive an Instagram verification code for ${bot.ig_username}`,
        );
      }
    }
    if (!result.login_id) {
      throw new Error("[bot-runtime] automation login omitted challenge id");
    }
    result = await client.completeInstagramLogin({
      login_id: result.login_id,
      code,
      timeout_ms: loginTimeoutMs,
    });
  }

  if (result.status !== "authenticated" || !result.storage_state) {
    throw loginErrorFromAutomation(result, bot.ig_username);
  }
  const storageStateJson = JSON.stringify(result.storage_state);
  const encrypted = encryptSessionData(storageStateJson);
  await persist(async (executor) => {
    await executor.execute(sql`
      UPDATE bot_accounts SET
        session_data = ${encrypted},
        status = 'available',
        last_login_at = NOW(),
        last_login_error = NULL,
        consecutive_hard_failures = 0,
        last_hard_failure_at = NULL,
        warm_failure_streak = 0,
        cooldown_until = CASE WHEN cooldown_until <= NOW() THEN NULL ELSE cooldown_until END,
        login_attempt_count = login_attempt_count + 1,
        updated_at = NOW()
      WHERE id = ${bot.id}
    `);
  });
  return storageStateJson;
}

/**
 * How a failed automation login lands on the row. Exported for tests.
 *
 *   - `banned`          IG said the account is suspended (typed error or the
 *                       word in the message) — matches the legacy `autoLogin`
 *                       branch; the row leaves every pool for good.
 *   - `session_expired` credentials rejected / 2FA asked but no secret: a
 *                       retry cannot succeed without operator input.
 *   - `captcha`         IG wants a human. Parked as session_expired like the
 *                       legacy path, with a 24h floor. Automatic recovery also
 *                       requires the intervention verdict to be cleared after
 *                       the account is resolved; elapsed time is not approval.
 *   - `retry_later`     everything else (proxy/transport, timeout, no
 *                       verification code, navigation). Not a verdict: the
 *                       status is left alone, the reason is a prefixed timed
 *                       cooldown, and the window backs off geometrically on
 *                       login_attempt_count (2h, 4h, 8h, 16h).
 *
 * Before this every failure was written as status='session_expired' with the
 * raw message, so one proxy timeout parked a healthy account forever (60 web
 * bots by 2026-09-02) and a real suspension was indistinguishable from it.
 */
export type AutomationLoginFailureRoute =
  | "banned"
  | "session_expired"
  | "captcha"
  | "retry_later";

export function routeAutomationLoginError(err: unknown): AutomationLoginFailureRoute {
  if (err instanceof LoginAccountSuspendedError) return "banned";
  if (
    err instanceof LoginBadCredentialsError ||
    err instanceof Login2FARequiredButNoSecretError
  ) {
    return "session_expired";
  }
  if (err instanceof LoginCaptchaRequiredError) return "captcha";
  const message = err instanceof Error ? err.message : String(err);
  if (/suspend/i.test(message)) return "banned";
  return "retry_later";
}

const CAPTCHA_RETRY_FLOOR_MS = 24 * 60 * 60 * 1000;

async function recordAutomationLoginError(
  bot: BotRow,
  proxyEndpoint: string,
  err: unknown,
  executor: BotExecutor = db,
): Promise<AutomationLoginFailureRoute> {
  const raw = err instanceof Error ? err.message : String(err);
  const message = scrubProxyCredential(raw, proxyEndpoint).slice(0, 500);
  const route = routeAutomationLoginError(err);
  const attempts = Number(bot.login_attempt_count ?? 0);

  if (route === "banned") {
    await executor.execute(sql`
      UPDATE bot_accounts SET
        status = 'banned',
        session_data = NULL,
        cooldown_until = NULL,
        last_login_error = ${message},
        login_attempt_count = login_attempt_count + 1,
        updated_at = NOW()
      WHERE id = ${bot.id}
    `);
    return route;
  }
  if (route === "session_expired") {
    await executor.execute(sql`
      UPDATE bot_accounts SET
        status = 'session_expired',
        last_login_error = ${message},
        login_attempt_count = login_attempt_count + 1,
        updated_at = NOW()
      WHERE id = ${bot.id}
    `);
    return route;
  }
  if (route === "captcha") {
    const holdMs = Math.max(CAPTCHA_RETRY_FLOOR_MS, reloginBackoffMs(attempts));
    const until = new Date(Date.now() + holdMs).toISOString();
    await executor.execute(sql`
      UPDATE bot_accounts SET
        status = 'session_expired',
        cooldown_until = ${until},
        last_login_error = ${message},
        login_attempt_count = login_attempt_count + 1,
        updated_at = NOW()
      WHERE id = ${bot.id}
    `);
    return route;
  }
  // retry_later: keep status, timed (prefixed) reason, geometric back-off.
  const until = new Date(Date.now() + reloginBackoffMs(attempts)).toISOString();
  const reason = formatCooldownReason(`login retry: ${message}`).slice(0, 500);
  await executor.execute(sql`
    UPDATE bot_accounts SET
      cooldown_until = ${until},
      last_login_error = ${reason},
      login_attempt_count = login_attempt_count + 1,
      updated_at = NOW()
    WHERE id = ${bot.id}
  `);
  return route;
}

export type ReloginOutcome = "recovered" | "failed" | "skipped";

/** Human/account intervention is required before these identities are retried. */
export const RELOGIN_TERMINAL_REASON_PATTERNS: ReadonlyArray<string> = [
  "%suspend%", "%incorrect%", "%rejected username%", "%bad_credentials%",
  "%bad credentials%", "%invalid password%", "%account disabled%",
  "%captcha%", "%checkpoint%", "%challenge%",
];

function parkedBotIneligibleReason(bot: BotRow): string | null {
  if (bot.status !== "session_expired") return "not parked";
  if (bot.tier !== "worker" && bot.tier !== "canary") return "not an active recovery tier";
  if (bot.transport !== "web") return "not a web session";
  if (!isBotAutoLoginEnabled()) return "auto-login disabled";
  if (!bot.automation_identity) return "no automation identity";
  if (!bot.ig_password_encrypted?.trim()) return "no login password";
  if (!bot.recovery_version) return "missing recovery version";
  if (bot.cooldown_until != null) {
    const until = new Date(bot.cooldown_until).getTime();
    if (!Number.isFinite(until) || until > Date.now()) return "cooldown active";
  }
  const reason = (bot.last_login_error ?? "").toLowerCase();
  if (RELOGIN_TERMINAL_REASON_PATTERNS.some((pattern) => reason.includes(pattern.slice(1, -1)))) {
    return "account intervention required";
  }
  return null;
}

class ParkedBotChangedError extends Error {
  constructor() { super("parked bot changed during recovery"); }
}

class ParkedBotPersistenceError extends Error {
  constructor(readonly cause: unknown) { super("parked bot recovery could not be persisted safely"); }
}

/**
 * Re-drive the automation login for ONE parked (`status='session_expired'`)
 * web bot, the way `ensureBotReady` would if the lease layer ever selected it
 * (it never does — `leaseBot` only picks 'available', which is why 60 web bots
 * sat parked forever). Reuses `ensureProxy` (fresh lane before a deliberate
 * re-login, exactly the case its rotation guard allows) and
 * `autoLoginWithAutomation`; failures route through `recordAutomationLoginError`.
 *
 *   recovered — new session persisted, status back to 'available'
 *   failed    — login attempted and refused (row updated per the route above)
 *   skipped   — not eligible, operation busy, local setup deferred, or the
 *               observed row changed while recovery was in flight
 */
export async function reloginParkedBot(botId: string): Promise<ReloginOutcome> {
  let loginStarted = false;
  const skip = (why: string): ReloginOutcome => {
    logger.info({ botId, why }, "[bot-runtime] relogin skipped");
    return "skipped";
  };
  try {
    return await withOperationLease(`bot:${botId}`, async (signal, guard) => {
      // Selection is not ownership: a worker or operator may have changed the
      // bot since the sweep selected it. Read only after acquiring the shared
      // bot lease, before proxy probes or credentials leave this process.
      let observed = await loadBot(botId);
      const ineligible = parkedBotIneligibleReason(observed);
      if (ineligible) return skip(ineligible);
      const sameObservedState = (current: BotRow) =>
        JSON.stringify(current) === JSON.stringify(observed);

      // Network work stays outside transactions. Fence each proxy/session/error
      // write with both lease ownership and the exact observed row under lock.
      const persist: PersistBotWrite = async (write) => {
        try {
          observed = await db.transaction(async (tx) => {
            await guard.assertOwned(tx);
            const current = await loadBot(botId, tx, true);
            if (parkedBotIneligibleReason(current) || !sameObservedState(current)) {
              throw new ParkedBotChangedError();
            }
            await write(tx);
            return loadBot(botId, tx);
          });
        } catch (err) {
          if (err instanceof ParkedBotChangedError) throw err;
          throw new ParkedBotPersistenceError(err);
        }
      };
      const deferLocalSetup = async (reason: string): Promise<ReloginOutcome> => {
        const until = new Date(Date.now() + reloginBackoffMs(Number(observed.login_attempt_count ?? 0))).toISOString();
        // No login attempt was spent. Move the failed local setup out of the
        // oldest-row window so it cannot monopolise every small sweep batch.
        await persist(async (executor) => {
          await executor.execute(sql`
            UPDATE bot_accounts SET cooldown_until = ${until},
              last_login_error = ${formatCooldownReason(reason)}, updated_at = NOW()
            WHERE id = ${botId}
          `);
        });
        return skip(reason);
      };

      let automationIdentity: AutomationIdentity;
      try {
        automationIdentity = requireAutomationIdentity(observed.automation_identity, botId);
      } catch {
        return await deferLocalSetup("login deferred: invalid automation identity");
      }
      let endpoint: string;
      try {
        signal.throwIfAborted();
        ({ endpoint } = await ensureProxy(observed, {
          hasUsableSession: false,
          automationIdentity,
          persist,
        }));
      } catch (err) {
        signal.throwIfAborted();
        if (err instanceof ParkedBotChangedError || err instanceof ParkedBotPersistenceError) throw err;
        return await deferLocalSetup("login deferred: proxy setup unavailable");
      }

      signal.throwIfAborted();
      const current = await loadBot(botId);
      if (parkedBotIneligibleReason(current) || !sameObservedState(current)) {
        return skip("bot changed before login");
      }

      try {
        loginStarted = true;
        await autoLoginWithAutomation(observed, endpoint, persist);
        logger.info({ botId }, "[bot-runtime] parked bot re-logged in");
        return "recovered";
      } catch (err) {
        signal.throwIfAborted();
        if (err instanceof ParkedBotChangedError || err instanceof ParkedBotPersistenceError) throw err;
        let route: AutomationLoginFailureRoute | undefined;
        await persist(async (executor) => {
          route = await recordAutomationLoginError(observed, endpoint, err, executor);
        });
        logger.warn({ botId, route }, "[bot-runtime] parked bot relogin failed");
        return "failed";
      }
    });
  } catch (err) {
    if (err instanceof OperationBusyError) return skip("bot operation busy");
    if (err instanceof ParkedBotChangedError) {
      // Credentials may already have reached Instagram. An unsaved outcome
      // must stop the sweep even though the newer local row is preserved.
      if (loginStarted) throw new ParkedBotPersistenceError(err);
      return skip("bot changed during recovery");
    }
    throw err;
  }
}

/**
 * Top-level: produce a context the IG HTTP client can use right now. Performs
 * the minimum work to bring the bot into a usable state — no-op when the
 * row is already healthy.
 */
export async function ensureBotReady(botId: string, options: { allowLogin?: boolean } = {}): Promise<BotRuntimeContext> {
  const bot = await loadBot(botId);
  const isMobile = bot.transport === "mobile";

  // Production Instagram automation is owned by the local Python service.
  // Fail before proxy resolution so stale legacy jobs cannot perform a direct
  // proxy probe or browser login on their way to being rejected.
  //
  // Mobile bots are exempt: they carry a pre-authenticated Bearer session and
  // never touch the Firefox/FastAPI login surface, so they legitimately have no
  // automation_identity. They are driven by ig-mobile-read-client.ts instead.
  if (
    process.env.NODE_ENV === "production" &&
    !bot.automation_identity &&
    !isMobile
  ) {
    throw new Error(
      `[bot-runtime] bot @${bot.ig_username} has no automation identity; refusing legacy direct Instagram automation`,
    );
  }

  let sessionData = readSession(bot);
  if (!sessionData && options.allowLogin === false) {
    throw new Error("[bot-runtime] saved session unavailable; this read cannot allocate a proxy or log in");
  }
  const automationIdentity =
    bot.automation_identity && !isMobile
      ? requireAutomationIdentity(bot.automation_identity, bot.id)
      : null;
  const { endpoint, allowProviderRotation } = await ensureProxy(bot, {
    hasUsableSession: sessionData !== null,
    automationIdentity,
  });

  if (!sessionData) {
    // Mobile bots cannot auto-relogin: they have no Firefox automation identity
    // and no password-login path here — their Bearer session is provisioned by
    // the mobile importer. A null session means the envelope failed to decrypt
    // or was invalidated; surface that plainly rather than falling through to
    // the legacy Playwright login (which would egress wrong and fail anyway).
    if (isMobile) {
      throw new Error(
        `[bot-runtime] mobile bot @${bot.ig_username} has no usable session; re-import its mobile session`,
      );
    }
    if (!isBotAutoLoginEnabled()) {
      throw new Error(
        `[bot-runtime] bot ${bot.ig_username} has no usable session_data; auto-login disabled`,
      );
    }
    if (bot.automation_identity) {
      try {
        sessionData = await autoLoginWithAutomation(bot, endpoint);
      } catch (err) {
        await recordAutomationLoginError(bot, endpoint, err).catch((writeErr) => {
          logger.warn(
            { botId: bot.id, err: writeErr },
            "[bot-runtime] failed to persist automation login error",
          );
        });
        throw err;
      }
    } else {
      sessionData = await autoLogin(bot, endpoint, allowProviderRotation);
    }
  }

  return {
    botId: bot.id,
    igUsername: bot.ig_username,
    sessionData,
    proxyUrl: proxyAgentUriForEndpoint(endpoint),
    proxyEndpoint: endpoint,
    automationIdentity,
    transport: isMobile ? "mobile" : "web",
  };
}

/**
 * Mark the row's session as invalid (e.g. caller observed an IGAuthExpired
 * during a real call). Next ensureBotReady() will auto-relogin.
 */
export async function invalidateBotSession(botId: string): Promise<void> {
  await db
    .update(botAccounts)
    .set({ sessionData: null, updatedAt: new Date() })
    .where(eq(botAccounts.id, botId));
  logger.info({ botId }, "[bot-runtime] session invalidated for relogin");
}

/** Park only the session that an authenticated read actually rejected.
 * A concurrent login may have replaced it while the request was in flight.
 * Compare the plaintext privately, then CAS against the persisted envelope so
 * that neither a renewed session nor a subsequent administrative state
 * can be overwritten by this old response. Proxy and identity stay unchanged.
 */
export async function invalidateObservedBotSession(
  botId: string,
  observedSessionData: string,
): Promise<boolean> {
  if (!observedSessionData) return false;
  const result = await db.execute(sql`
    SELECT session_data, status FROM bot_accounts WHERE id = ${botId}
  `) as unknown as { rows: { session_data: string | null; status: string }[] };
  const row = result.rows[0];
  if (!row || !["available", "in_use"].includes(row.status) || !row.session_data) return false;
  let persistedSession: string;
  try {
    persistedSession = isEncryptedEnvelope(row.session_data)
      ? decryptSessionData(row.session_data) : row.session_data;
  } catch {
    // An unreadable envelope is not proof that this response rejected it.
    return false;
  }
  if (persistedSession !== observedSessionData) return false;
  const updated = await db.execute(sql`
    UPDATE bot_accounts SET session_data = NULL, status = 'session_expired', updated_at = NOW()
    WHERE id = ${botId} AND status = ${row.status} AND session_data = ${row.session_data}
    RETURNING id
  `) as unknown as { rows: { id: string }[] };
  const invalidated = updated.rows.length === 1;
  if (invalidated) logger.info({ botId }, "[bot-runtime] rejected session parked for renewal");
  return invalidated;
}
