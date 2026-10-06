// ─── Unified verification-code fetcher facade ──────────────────────────────
//
// Wave 6: bots come from two distinct mailbox families:
//
//   • IMAP-backed (rambler.ru, onet.pl, …)   — see imap-code-fetcher.ts
//   • Web inbox (tmailgg.site / tmail.gg)    — see tmailgg-fetcher.ts
//
// The auto-login worker (server/services/bot-login.ts) shouldn't have to know
// which family a given bot belongs to. This module is a one-line drop-in:
//
//     import { fetchVerificationCode } from "./email-code-fetcher.js";
//     const code = await fetchVerificationCode(bot, { since: loginStartedAt });
//
// Provider selection:
//   1. Explicit `bot.email_provider` (or `emailProvider`) wins.
//   2. Otherwise, infer from the email domain — anything ending in
//      `tmailgg.site` / `tmail.gg` routes to the web fetcher.
//   3. Anything else falls back to IMAP.
//
// We DO NOT touch bot-login.ts, bot-runtime.ts, imap-code-fetcher.ts, the
// schema, or migrations from this module. The schema doesn't yet have an
// `email_provider` column — domain inference handles the current bot pool
// correctly, and a future migration can add the explicit field without
// breaking this facade.
// ─────────────────────────────────────────────────────────────────────────────

import {
  fetchInstagramCode,
  type ImapCredentials,
  type FetchCodeOptions as ImapFetchCodeOptions,
} from "./imap-code-fetcher.js";
import { fetchLatestIgCode } from "./tmailgg-fetcher.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "email-code-fetcher" });

// Domains that are known web-inbox providers handled by tmailgg-fetcher.
const TMAILGG_DOMAINS = ["tmailgg.site", "tmail.gg"];

export type EmailProvider = "imap" | "tmailgg_web";

/**
 * Subset of the `bots` row needed to fetch a verification code. Kept loose so
 * callers can pass either a Drizzle row or any plain object that has the
 * relevant fields.
 */
export interface BotEmailContext {
  emailAddress?: string | null;
  email_address?: string | null;
  emailPassword?: string | null;
  email_password?: string | null;
  imapHost?: string | null;
  imap_host?: string | null;
  imapPort?: number | null;
  imap_port?: number | null;
  /** Optional explicit override. */
  emailProvider?: EmailProvider | string | null;
  email_provider?: EmailProvider | string | null;
}

export interface FetchVerificationCodeOptions {
  /** Only consider mail received at or after this instant. Default: now. */
  since?: Date;
  /** Total wall-clock budget in ms. Default: 90s for IMAP, 30s for web. */
  timeoutMs?: number;
  /** Web-inbox freshness window in ms. Default: 4 minutes. */
  webMaxAgeMs?: number;
  /** Override fetch (web fetcher only) — for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Returns the 6-digit IG verification code or null if none arrives in time.
 * Never throws — failures are logged and surface as `null` so the caller can
 * fall back cleanly to a TOTP path.
 */
export async function fetchVerificationCode(
  bot: BotEmailContext,
  opts: FetchVerificationCodeOptions = {},
): Promise<string | null> {
  const provider = resolveProvider(bot);
  const emailAddress = pick(bot.emailAddress, bot.email_address);

  if (!emailAddress) {
    logger.warn("[email-code-fetcher] bot has no email address — skipping");
    return null;
  }

  if (provider === "tmailgg_web") {
    return fetchViaWeb(emailAddress, opts);
  }

  return fetchViaImap(bot, emailAddress, opts);
}

/**
 * Public for callers that want to know which path a given bot would use
 * (e.g., metrics labelling).
 */
export function resolveProvider(bot: BotEmailContext): EmailProvider {
  const explicit = pick(bot.emailProvider, bot.email_provider);
  if (explicit === "tmailgg_web" || explicit === "imap") return explicit;

  const emailAddress = pick(bot.emailAddress, bot.email_address);
  if (emailAddress) {
    const domain = emailAddress.split("@")[1]?.toLowerCase();
    if (domain && TMAILGG_DOMAINS.some((d) => domain.endsWith(d))) {
      return "tmailgg_web";
    }
  }
  return "imap";
}

// ─── internals ──────────────────────────────────────────────────────────────

async function fetchViaWeb(
  emailAddress: string,
  opts: FetchVerificationCodeOptions,
): Promise<string | null> {
  try {
    return await fetchLatestIgCode(emailAddress, {
      maxAgeMs: opts.webMaxAgeMs,
      totalTimeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    logger.warn(
      { emailAddress, err: errMessage(err) },
      "[email-code-fetcher] web fetcher threw — returning null",
    );
    return null;
  }
}

async function fetchViaImap(
  bot: BotEmailContext,
  emailAddress: string,
  opts: FetchVerificationCodeOptions,
): Promise<string | null> {
  const password = pick(bot.emailPassword, bot.email_password);
  const host = pick(bot.imapHost, bot.imap_host);
  const port = pickNumber(bot.imapPort, bot.imap_port);

  if (!password || !host || !port) {
    logger.warn(
      { emailAddress, hasPassword: !!password, hasHost: !!host, hasPort: !!port },
      "[email-code-fetcher] IMAP credentials incomplete — skipping",
    );
    return null;
  }

  const creds: ImapCredentials = {
    host,
    port,
    user: emailAddress,
    password,
  };

  const fetchOpts: ImapFetchCodeOptions = {
    since: opts.since ?? new Date(),
    timeoutMs: opts.timeoutMs ?? 90_000,
  };

  try {
    return await fetchInstagramCode(creds, fetchOpts);
  } catch (err) {
    logger.warn(
      { emailAddress, host, err: errMessage(err) },
      "[email-code-fetcher] IMAP fetcher threw — returning null",
    );
    return null;
  }
}

function pick<T>(a: T | null | undefined, b: T | null | undefined): T | null {
  if (a !== undefined && a !== null) return a;
  if (b !== undefined && b !== null) return b;
  return null;
}

function pickNumber(
  a: number | null | undefined,
  b: number | null | undefined,
): number | null {
  const v = pick(a, b);
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "<unprintable error>";
  }
}
