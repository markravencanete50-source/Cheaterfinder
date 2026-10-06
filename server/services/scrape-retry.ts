// ─── Scrape retry / backoff layer ────────────────────────────────────────────
//
// Wave 4: retry wrapper for outbound IG scrape calls. Splits transient errors
// (network blips, 5xx) — which we should retry with exponential backoff — from
// permanent-per-bot errors (checkpoint_required, 401, 403) — which the caller
// should bubble up so the bot can be cooled down and a different bot picked.
//
// Policy:
//   - max 3 attempts, exp backoff 2s / 4s / 8s
//   - 429 (IGRateLimitedError) / "rate limited" → throw IMMEDIATELY, no sleep.
//     Rate limits are per-bot-permanent here: the rotation layer (runBot) swaps
//     bots + applies a short cooldown. Sleeping in place would add up to
//     maxDelayMs of dead time to every profile rotation. See isPermanentPerBot.
//   - checkpoint_required / 401-403 (IGAuthExpiredError or IGHttpError with
//     igErrorCode='checkpoint_required') → throw immediately, no retry
//   - everything else considered transient
//
// Retry IS NOT bot-rotation — that lives one layer up in public-data-service.
// ─────────────────────────────────────────────────────────────────────────────

import {
  IGAuthExpiredError,
  IGHttpError,
  IGRateLimitedError,
} from "../ig-http-client.js";
import { logger as baseLogger } from "../observability/logger.js";
import { EndpointDisabledError } from "./endpoint-strikes.js";

const logger = baseLogger.child({ module: "scrape-retry" });

export interface ScrapeRetryOptions {
  /** Maximum total attempts including the first one. Default 3. */
  readonly maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default 2000. */
  readonly baseDelayMs?: number;
  /** Cap for any single backoff sleep in ms. Default 30_000. */
  readonly maxDelayMs?: number;
}

const DEFAULT_OPTS: Required<ScrapeRetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Errors that mark "this bot is unusable right now — pick a different one".
 * The retry layer never retries these; the caller is responsible for cooling
 * down the bot and (optionally) leasing a new one.
 *
 * NOTE ON RATE LIMITS (load-bearing — do not "fix"): IGRateLimitedError and any
 * "rate limited" message are INTENTIONALLY treated as per-bot-permanent here
 * (see isPermanentPerBot). The retry layer throws them immediately with NO
 * sleep so the rotation layer (runBot in public-data-service) can rotate to a
 * fresh bot + apply the short rotation cooldown. The profile-rotation feature
 * depends on this fast-throw: handling rate limits via in-place sleeps would
 * add up to maxDelayMs (30s) of dead time per rotation. The Retry-After window
 * is honoured by the cooldown layer, not by sleeping here.
 */
const PERMANENT_IG_ERROR_CODES: ReadonlyArray<string> = [
  "checkpoint_required",
  "challenge_required",
  "login_required",
];

function unwrapCause(err: unknown): unknown {
  let current = err;
  const seen = new Set<unknown>();
  while (
    current instanceof Error &&
    "cause" in current &&
    current.cause !== undefined &&
    !seen.has(current.cause)
  ) {
    if (current instanceof IGHttpError || current instanceof IGAuthExpiredError || current instanceof IGRateLimitedError) return current;
    seen.add(current);
    current = current.cause;
  }
  return current;
}

/**
 * "This bot is unusable for now — bubble up so the caller rotates." Returns
 * true for checkpoint/challenge/login, auth-expired, hard 4xx, transport
 * sentinels, AND rate limits.
 *
 * Rate limits are deliberately in this set (both the "rate limited" message and
 * `instanceof IGRateLimitedError`): the rotation layer handles a throttled bot
 * by switching bots + applying a short cooldown, which is far cheaper than
 * sleeping in place. Keeping rate limits here makes the fast-throw the single
 * source of truth — there is NO in-place 429 sleep in withScrapeRetry, by
 * design. Do not narrow this to make a 429-sleep branch reachable.
 */
function isPermanentPerBot(err: unknown): boolean {
  // Inspect typed outer errors BEFORE unwrapping their transport causes.
  // Otherwise status-0 IGHttpError -> generic AutomationServiceError retries
  // here as well as in both the lane and rotation wrappers.
  if (err instanceof Error && ["OperationBusyError", "ScrapeAttemptBudgetError", "AbortError"].includes(err.name)) return true;
  if (err instanceof IGHttpError && err.status === 0) return true;
  if (err instanceof IGRateLimitedError || err instanceof IGAuthExpiredError) return true;
  const root = unwrapCause(err);
  if (root !== err) return isPermanentPerBot(root);
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  // Defined in ig-public-scraper.ts, which already imports the retry/cooldown
  // stack. Match its stable error name/message here instead of importing the
  // class and introducing a module cycle. A restricted list is scoped to this
  // viewing bot and must rotate immediately; sleeping 2s/4s on the same bot
  // cannot change Instagram's decision.
  if (
    (err instanceof Error && err.name === "IGListRestrictedError") ||
    message.includes("special_empty_state") ||
    message.includes("list restricted by instagram")
  ) {
    return true;
  }
  if (
    message.includes("network error") ||
    message.includes("fetch failed") ||
    // The provider circuit breaker already proved every configured endpoint is
    // unavailable and carries its own multi-minute retry time. Sleeping 2s/4s
    // inside each scrape cannot recover it; fail fast so the caller can use an
    // independent fallback or preserve cached data immediately.
    message.includes("provider health cooldown active") ||
    // Pool capacity is scheduler state, not a network blip. Retrying the same
    // read after 2s and 4s cannot create a leaseable account; it only triples
    // every profile sub-request while the next scheduled cycle is already the
    // correct retry boundary.
    message.includes("no eligible bot") ||
    message.includes("no available bot") ||
    message.includes("no bot available") ||
    message.includes("no leaseable bot") ||
    // A daily endpoint allowance cannot recover on the same bot until the UTC
    // reset. Retrying it 2s/4s in place only burns time, and previously tripled
    // every exhausted liker request before the rotation layer could move on.
    message.includes("[daily-budget]") ||
    message.includes("daily cap") ||
    message.includes("rate limited") || // 429s rotate, never sleep here (see doc above)
    message.includes("checkpoint_required") ||
    message.includes("challenge_required") ||
    message.includes("login_required") ||
    message.includes("useragent mismatch")
  ) {
    return true;
  }
  if (err instanceof EndpointDisabledError) return true;
  if (err instanceof IGAuthExpiredError) return true;
  // Rate limits rotate at the caller, never sleep here (see PERMANENT_IG_ERROR_CODES doc).
  if (err instanceof IGRateLimitedError) return true;
  if (err instanceof IGHttpError) {
    // Status 0 is our transport/proxy failure sentinel. Retrying through the
    // same bot usually reuses the same bad proxy lane; rotate at caller level.
    if (err.status === 0) return true;
    const code: string | undefined = err.igErrorCode;
    const body = err.body?.toLowerCase() ?? "";
    if (body.includes("useragent mismatch")) return true;
    if (code !== undefined && PERMANENT_IG_ERROR_CODES.includes(code)) {
      return true;
    }
    if (err.status === 401 || err.status === 403) return true;
    // 400 with checkpoint_required is the canonical IG checkpoint trigger.
    if (err.status === 400 && code === "checkpoint_required") {
      return true;
    }
  }
  return false;
}

function isTransient(err: unknown): boolean {
  // runWithLease rethrows everything wrapped in IGPublicScraperError, so the
  // checks below must look at the ROOT cause or every wrapper is "an Error"
  // and therefore transient (lesson 5 again: 28 mobile 404s and a 37-minute DB
  // outage were each retried 3x on 2026-09-02).
  const root = unwrapCause(err);
  if (root instanceof Error) {
    // A failed SQL statement (drizzle prefixes "Failed query") or an open
    // circuit breaker is deterministic for this attempt: retrying only spends
    // another lease and, for the breaker, another budget unit.
    if (/^Failed query/i.test(root.message)) return false;
    if (root.name === "IGCircuitOpenError") return false;
  }
  return isTransientRoot(root);
}

function isTransientRoot(err: unknown): boolean {
  if (err instanceof IGHttpError) {
    // 5xx is server-side, 0 is our own "network error" sentinel.
    if (err.status >= 500 && err.status < 600) return true;
    return false;
  }
  // TypeError from undici fetch on connection drop, AbortError from timeout —
  // bare Error subclasses with no http envelope are treated as transient.
  if (err instanceof IGAuthExpiredError) return false;
  if (err instanceof IGRateLimitedError) return false;
  if (err instanceof Error) return true;
  return false;
}

function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  // attempt is 1-indexed; first retry waits baseDelayMs * 2^0 = baseDelayMs
  const exp = Math.pow(2, Math.max(0, attempt - 1));
  const delay = baseDelayMs * exp;
  return Math.min(delay, maxDelayMs);
}

/**
 * Run `fn` with retry/backoff on transient failures. Per-bot permanent errors
 * (checkpoint, auth-expired, hard 4xx, AND rate limits) bubble up immediately
 * so the caller can cooldown + rotate bot. There is intentionally NO in-place
 * 429 sleep — rate limits are classified as permanent-per-bot (see
 * isPermanentPerBot) precisely so the rotation layer, not this loop, decides
 * how to wait. Adding a 429-sleep branch here would re-introduce up to
 * maxDelayMs of dead time per rotation.
 */
export async function withScrapeRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: ScrapeRetryOptions = {},
): Promise<T> {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      // Permanent per-bot (includes rate limits) — caller picks a new bot.
      // Because isPermanentPerBot returns true for IGRateLimitedError and any
      // "rate limited" message, 429s throw here immediately with no sleep; the
      // rotation layer (runBot) handles them via bot rotation + cooldown.
      if (isPermanentPerBot(err)) {
        logger.warn(
          { label, attempt, err: err instanceof Error ? err.message : String(err) },
          "[scrape-retry] permanent per-bot error; not retrying",
        );
        throw err;
      }

      // Transient — retry with exponential backoff while attempts remain.
      if (isTransient(err) && attempt < cfg.maxAttempts) {
        const delay = backoffDelay(attempt, cfg.baseDelayMs, cfg.maxDelayMs);
        logger.warn(
          {
            label,
            attempt,
            nextDelayMs: delay,
            err: err instanceof Error ? err.message : String(err),
          },
          "[scrape-retry] transient failure; backing off",
        );
        await sleep(delay);
        continue;
      }

      // Out of attempts or non-transient: bubble.
      logger.error(
        {
          label,
          attempt,
          err: err instanceof Error ? err.message : String(err),
        },
        "[scrape-retry] giving up",
      );
      throw err;
    }
  }
}
