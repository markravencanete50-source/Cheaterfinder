// Login a deliberately bounded part of the prepared reserve pool and promote
// only successful FastAPI Firefox sessions into the worker tier.
//
// Candidates run with bounded concurrency. The real login, made by the
// invisible-playwright Firefox service, validates the assigned proxy lane.
// Failed rows remain session_expired / reserve, so they cannot be leased by
// the application.
//
// Usage:
//   npx tsx server/scripts/activate-reserve-automation-bots.ts --dry-run --limit=3
//   npx tsx server/scripts/activate-reserve-automation-bots.ts --apply --limit=3
//   npx tsx server/scripts/activate-reserve-automation-bots.ts --apply --retry-failed --limit=1
//   npx tsx server/scripts/activate-reserve-automation-bots.ts --apply --limit=40 --delay-ms=300000
//   npx tsx server/scripts/activate-reserve-automation-bots.ts --apply --stage-only --limit=40
//   npx tsx server/scripts/activate-reserve-automation-bots.ts --apply --stage-only --allow-short-lived-proxy --limit=1
//   npx tsx server/scripts/activate-reserve-automation-bots.ts --apply --stage-only --allow-short-lived-proxy --limit=84 --concurrency=2 --delay-ms=45000
//   npx tsx server/scripts/activate-reserve-automation-bots.ts --apply --stage-only --allow-short-lived-proxy --retry-failed --error-class=login-page --limit=1
//   npx tsx server/scripts/activate-reserve-automation-bots.ts --apply --stage-only --created-after=2026-08-15T17:00:00Z --limit=1
//
// `--stage-only` validates and persists the Firefox session but deliberately
// leaves the bot in the reserve tier. The production lease query excludes
// reserves, so operators can authenticate a batch without exposing each bot
// to collection traffic before the whole batch is ready for controlled
// promotion.
//
// Required environment: DATABASE_URL, AUTOMATION_API_TOKEN, BOT_CRED_KEY,
// and the configured proxy provider variables.

import "dotenv/config";

import { sql } from "drizzle-orm";

import { db, pool } from "../db.js";
import { parseAutomationIdentity } from "../services/automation-identity.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import {
  LoginCaptchaRequiredError,
  LoginRateLimitedError,
} from "../services/bot-login.js";
import {
  DURABLE_ACCOUNT_PROXY_MIN_VALIDITY_DAYS,
  isDurableAccountProxyUrl,
  isKnownEphemeralDataImpulseProxyUrl,
  KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX,
} from "../services/proxy-durability.js";

interface ReserveBotRow {
  id: string;
  automation_identity: unknown;
  proxy_url: string;
}

type LoginErrorClass = "any" | "login-page" | "navigation" | "form";

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function requireLimit(): number {
  const flag = process.argv.slice(2).find((value) => value.startsWith("--limit="));
  const parsed = flag ? Number(flag.slice("--limit=".length)) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit=<positive integer> is required");
  }
  return parsed;
}

function readDelayMs(): number {
  const flag = process.argv.slice(2).find((value) => value.startsWith("--delay-ms="));
  if (!flag) return 300_000;
  const parsed = Number(flag.slice("--delay-ms=".length));
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--delay-ms must be a non-negative integer");
  }
  return parsed;
}

function readConcurrency(): number {
  const flag = process.argv.slice(2).find((value) => value.startsWith("--concurrency="));
  if (!flag) return 1;
  const parsed = Number(flag.slice("--concurrency=".length));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new Error("--concurrency must be an integer from 1 to 3");
  }
  return parsed;
}

function readCreatedAfter(): Date | null {
  const flag = process.argv.slice(2).find((value) => value.startsWith("--created-after="));
  if (!flag) return null;
  const value = flag.slice("--created-after=".length);
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new Error("--created-after must be an ISO-8601 timestamp");
  }
  return parsed;
}

function readErrorClass(): LoginErrorClass {
  const flag = process.argv.slice(2).find((value) => value.startsWith("--error-class="));
  if (!flag) return "any";
  const value = flag.slice("--error-class=".length);
  if (value === "login-page" || value === "navigation" || value === "form") {
    return value;
  }
  throw new Error("--error-class must be one of: login-page, navigation, form");
}

async function listReserveBots(
  limit: number,
  retryFailed: boolean,
  createdAfter: Date | null,
  allowShortLivedProxy: boolean,
  errorClass: LoginErrorClass,
): Promise<readonly ReserveBotRow[]> {
  const attemptGuard = retryFailed ? sql`` : sql`AND login_attempt_count = 0`;
  const createdAfterGuard = createdAfter
    ? sql`AND created_at >= ${createdAfter}`
    : sql``;
  const proxyGuard = allowShortLivedProxy
    ? sql``
    : sql`
      AND proxy_expires_at > NOW()
        + (${DURABLE_ACCOUNT_PROXY_MIN_VALIDITY_DAYS} * INTERVAL '1 day')
      AND NOT (proxy_url ~* ${KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX})
    `;
  const errorGuard = errorClass === "login-page"
    ? sql`AND last_login_error LIKE '%path=/accounts/login/%'`
    : errorClass === "navigation"
      ? sql`AND last_login_error LIKE '%failed at login_navigation:%'`
      : errorClass === "form"
        ? sql`AND last_login_error LIKE '%failed at login_form:%'`
        : sql``;
  const result = (await db.execute(sql`
    SELECT id, automation_identity, proxy_url
    FROM bot_accounts
    WHERE tier = 'reserve'
      AND status = 'session_expired'
      AND ig_password_encrypted IS NOT NULL
      AND NULLIF(BTRIM(proxy_url), '') IS NOT NULL
      ${proxyGuard}
      ${attemptGuard}
      ${createdAfterGuard}
      ${errorGuard}
    ORDER BY created_at ASC, ig_username ASC
    LIMIT ${limit}
  `)) as unknown as { rows: ReserveBotRow[] };
  return result.rows;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run");
  if (apply === dryRun) {
    throw new Error("choose exactly one of --dry-run or --apply");
  }

  const limit = requireLimit();
  const delayMs = readDelayMs();
  const concurrency = readConcurrency();
  const retryFailed = hasFlag("--retry-failed");
  const errorClass = readErrorClass();
  if (errorClass !== "any" && !retryFailed) {
    throw new Error("--error-class requires --retry-failed");
  }
  const stageOnly = hasFlag("--stage-only");
  const allowShortLivedProxy = hasFlag("--allow-short-lived-proxy");
  if (allowShortLivedProxy && !stageOnly) {
    throw new Error("--allow-short-lived-proxy requires --stage-only");
  }
  if (concurrency > 1 && !stageOnly) {
    throw new Error("--concurrency greater than 1 requires --stage-only");
  }
  if (allowShortLivedProxy) {
    process.env.BOT_ALLOW_SHORT_LIVED_ACCOUNT_PROXY = "true";
  }
  const createdAfter = readCreatedAfter();
  const candidates = await listReserveBots(
    limit,
    retryFailed,
    createdAfter,
    allowShortLivedProxy,
    errorClass,
  );
  const eligible = candidates.filter((bot) =>
    parseAutomationIdentity(bot.automation_identity, bot.id)
    && (
      isDurableAccountProxyUrl(bot.proxy_url)
      || (allowShortLivedProxy
        && isKnownEphemeralDataImpulseProxyUrl(bot.proxy_url))
    ));

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      selected: candidates.length,
      eligible: eligible.length,
      skippedMissingIdentity: candidates.length - eligible.length,
      delayMs,
      concurrency,
      retryFailed,
      errorClass,
      allowShortLivedProxy,
      createdAfter: createdAfter?.toISOString() ?? null,
      mode: stageOnly ? "stage-only" : "promote",
      promoteTo: stageOnly ? "reserve" : "worker",
    }));
    return;
  }
  if (eligible.length === 0) {
    throw new Error("no prepared reserve bots are eligible for activation");
  }

  let authenticated = 0;
  let activated = 0;
  let failed = 0;
  let nextIndex = 0;
  let nextStartAt = Date.now();
  let stoppedEarly: string | null = null;

  async function processNext(): Promise<void> {
    while (!stoppedEarly) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= eligible.length) return;

      const scheduledAt = nextStartAt;
      nextStartAt += delayMs;
      const startDelayMs = scheduledAt - Date.now();
      if (startDelayMs > 0) await wait(startDelayMs);

      const bot = eligible[index];
      if (stoppedEarly) return;
      try {
        const ready = await ensureBotReady(bot.id);
        if (!ready.automationIdentity) {
          throw new Error("automation identity missing from ready runtime context");
        }
        authenticated += 1;
        if (!stageOnly) {
          const result = await db.execute(sql`
            UPDATE bot_accounts SET
              tier = 'worker'::bot_tier,
              updated_at = NOW()
            WHERE id = ${bot.id}
              AND tier = 'reserve'
              AND status = 'available'
              AND proxy_url = ${bot.proxy_url}
              AND proxy_expires_at > NOW()
                + (${DURABLE_ACCOUNT_PROXY_MIN_VALIDITY_DAYS} * INTERVAL '1 day')
              AND NOT (proxy_url ~* ${KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX})
          `);
          const promoted = (result as unknown as { rowCount?: number }).rowCount ?? 0;
          if (promoted !== 1) {
            throw new Error("session completed but reserve row could not be promoted");
          }
          activated += 1;
        }
      } catch (error) {
        // ensureBotReady persists the safe classification on the row. Leave it
        // in reserve so production workers cannot lease a failed login.
        failed += 1;
        if (
          error instanceof LoginRateLimitedError
          || error instanceof LoginCaptchaRequiredError
        ) {
          stoppedEarly = error.name;
        }
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, eligible.length) },
      () => processNext(),
    ),
  );

  console.log(JSON.stringify({
    ok: failed === 0,
    selected: candidates.length,
    eligible: eligible.length,
    skippedMissingIdentity: candidates.length - eligible.length,
    authenticated,
    staged: stageOnly ? authenticated : 0,
    activated,
    failed,
    mode: stageOnly ? "stage-only" : "promote",
    promotedTo: stageOnly ? "reserve" : "worker",
    concurrency,
    stoppedEarly,
    retryFailed,
    errorClass,
    allowShortLivedProxy,
    createdAfter: createdAfter?.toISOString() ?? null,
  }));
  if (failed > 0) process.exitCode = 1;
}

void main()
  .catch((error: unknown) => {
    console.error(`[activate-reserve-bots] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
