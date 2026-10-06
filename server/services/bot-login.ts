// ─── Auto-login orchestrator for bot accounts ────────────────────────────────
//
// Wave 4: drives an end-to-end Playwright login for a bot whose
// `session_data` is missing or expired. The flow:
//
//   1. ensure the bot has a fresh sticky proxy endpoint
//   2. launch Chromium with that proxy
//   3. fill username + password on instagram.com/accounts/login
//   4. if IG asks for a 6-digit "security code", poll the bot's mailbox
//      via IMAP and submit the code
//   5. if IG presents the "Save your login info?" / "Turn on notifications"
//      interstitials, dismiss them
//   6. assert that we land on a logged-in surface
//   7. dump cookies + origin storage to a Playwright storageState blob
//   8. return the blob (caller persists it as the bot's encrypted session_data)
//
// This module is *only* the in-memory flow. Persistence + envelope encryption
// live in storage helpers so this stays unit-testable with a fake browser.
// ─────────────────────────────────────────────────────────────────────────────

import { logger as baseLogger } from "../observability/logger.js";
import {
  fetchVerificationCode,
  type BotEmailContext,
} from "./email-code-fetcher.js";
import {
  fetchHealthyEndpoints,
  proxyEndpointLabel,
  toPlaywrightProxy,
} from "./proxy-provider.js";
import { generateTotp } from "./totp.js";

const logger = baseLogger.child({ module: "bot-login" });

const IG_LOGIN_URL = "https://www.instagram.com/accounts/login/";
const POST_LOGIN_PROBE_URL = "https://www.instagram.com/";

/** Conservative wait for IG-served pages — react app loads aren't fast. */
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const CODE_WAIT_TIMEOUT_MS = 120_000;

/**
 * Maximum age of an IMAP-fetched verification code before IG starts rejecting
 * it server-side. We re-fetch a fresh code if the form sat unsubmitted for
 * longer than this — typically caused by a slow challenge-page render.
 */
const CODE_FRESHNESS_BUDGET_MS = 240_000;

/** Delays applied between login retries (in ms). One per retry slot. */
const RETRY_BACKOFF_MS: readonly number[] = [5_000, 10_000];

/**
 * Raised when the login URL renders without the username input — usually a
 * symptom of a dead/throttled proxy IP. The retry layer rotates the proxy
 * when it sees this.
 */
export class LoginBlankPageError extends Error {
  override readonly name = "LoginBlankPageError" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Raised when the IG challenge / codeentry page never renders the code input.
 * Same retry semantics as {@link LoginBlankPageError} — rotate proxy and try
 * the whole flow again.
 */
export class LoginChallengePageStuckError extends Error {
  override readonly name = "LoginChallengePageStuckError" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Raised when IG presents a TOTP / authenticator-app 2FA challenge but the
 * caller did not supply a `totpSecret` for this bot. Non-retryable — no
 * amount of proxy rotation will conjure the secret. The provisioning side
 * needs to fix the bot row.
 */
export class Login2FARequiredButNoSecretError extends Error {
  override readonly name = "Login2FARequiredButNoSecretError" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Raised when Meta's reCAPTCHA checkbox escalates to an interactive image or
 * audio puzzle. The worker may click the ordinary checkbox, but it must not
 * pretend a session exists when a human-verification puzzle remains.
 */
export class LoginCaptchaRequiredError extends Error {
  override readonly name = "LoginCaptchaRequiredError" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Raised when IG accepts credentials but redirects the account to an
 * account-suspended surface. A session cookie may exist, but it is not a
 * usable scraper session and must not enter the bot pool.
 */
export class LoginAccountSuspendedError extends Error {
  override readonly name = "LoginAccountSuspendedError" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Raised when IG explicitly rejects the supplied username/password. This is
 * non-retryable: rotating proxies cannot fix stale or wrong credentials.
 */
export class LoginBadCredentialsError extends Error {
  override readonly name = "LoginBadCredentialsError" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Raised when IG shows a transient throttling alert ("Please wait a few
 * minutes before you try again." / "try again later"). Retryable: the retry
 * layer rotates the proxy and tries again — the bot must NEVER be parked
 * (status flipped / session nulled) for this.
 */
export class LoginRateLimitedError extends Error {
  override readonly name = "LoginRateLimitedError" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Phrases IG renders when the username/password pair is genuinely wrong.
 * Single regex alternation: matched both via `page.getByText()` (current IG
 * builds render the banner as plain text, not role="alert") and against the
 * textContent of role="alert" elements. Do NOT split these into multiple
 * `text=` selectors joined with "," — Playwright treats comma-joined selector
 * lists as CSS-only, so the join produces one text selector that never
 * matches (the original dead-code bug).
 */
export const BAD_CREDENTIALS_TEXT_RE =
  /login information you entered is incorrect|password was incorrect|incorrect password|password you entered is incorrect|find your account and log in/i;

/**
 * Phrases IG uses for transient throttling. These must stay retryable —
 * classifying them as bad credentials would permanently remove a healthy
 * bot from the pool.
 */
export const TRANSIENT_ALERT_TEXT_RE =
  /please wait a few minutes|try again later|too many attempts/i;

/**
 * Raised internally when a verification code goes stale before we can submit
 * it — caller refetches a fresh one and retries the form.
 */
class VerificationCodeStaleError extends Error {
  override readonly name = "VerificationCodeStaleError" as const;
  constructor(message: string) {
    super(message);
  }
}

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

export interface BotLoginCreds {
  igUsername: string;
  igPassword: string;
  /**
   * Optional: only required if IG triggers an email-code challenge. Pass the
   * full bot email context — the {@link fetchVerificationCode} facade routes
   * to IMAP or web-inbox automatically based on `email_provider` / domain.
   */
  email?: BotEmailContext;
  /**
   * Optional: Base32-encoded TOTP / Google Authenticator secret. Required
   * only if IG presents an authenticator-app 2FA prompt for this bot. If
   * IG asks for a TOTP code and this is missing, the login fails fast with
   * {@link Login2FARequiredButNoSecretError} rather than burning retries.
   */
  totpSecret?: string;
  /**
   * Optional stable browser fingerprint. Must match the later HTTP scraper
   * fingerprint, otherwise IG can reject API calls with "useragent mismatch".
   */
  userAgent?: string;
  timezone?: string;
  locale?: string;
}

export interface BotLoginProxy {
  /** "host:port" or "host:port:username:password". */
  endpoint: string;
}

export interface BotLoginResult {
  /** Playwright `storageState` JSON; persist as session_data. */
  storageStateJson: string;
  /** Whether IG triggered the email-code challenge during this login. */
  emailCodeUsed: boolean;
  /** Whether IG triggered a TOTP / authenticator-app challenge. */
  totpUsed: boolean;
}

export interface LoginRetryOptions {
  /**
   * Whether a retry may ask the provider for a replacement endpoint. Disable
   * this for an explicit per-bot ``proxy_url`` so an ops-pinned lane is never
   * silently replaced by the provider pool.
   */
  allowProxyRotation?: boolean;
}

/**
 * Run an end-to-end login. The Playwright import is lazy because the
 * dependency is optional in some build profiles.
 */
export async function loginBot(
  creds: BotLoginCreds,
  proxy: BotLoginProxy,
): Promise<BotLoginResult> {
  const { chromium } = await import("playwright");
  const playwrightProxy = toPlaywrightProxy({
    endpoint: proxy.endpoint,
    sessionId: proxy.endpoint,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  const browser = await chromium.launch({
    headless: true,
    proxy: playwrightProxy,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  let emailCodeUsed = false;
  let totpUsed = false;
  try {
    const context = await browser.newContext({
      userAgent: creds.userAgent ?? DESKTOP_UA,
      viewport: { width: 1366, height: 768 },
      locale: creds.locale ?? "en-US",
      timezoneId: creds.timezone ?? "America/New_York",
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    const page = await context.newPage();
    logger.info(
      { username: creds.igUsername, proxy: proxyEndpointLabel(proxy.endpoint) },
      "[bot-login] navigating to login page",
    );
    await page.goto(IG_LOGIN_URL, { waitUntil: "domcontentloaded" });
    // Wait for the login form to *actually* render — IG ships a JS-driven
    // form that's empty for a beat after domcontentloaded. We bound the
    // network-idle wait at 30s as a soft signal; the hard signal is the
    // username input becoming visible (asserted below).
    await page
      .waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS })
      .catch(() => undefined);

    // Cookie banner — both EU and US consent variants live behind this label.
    await dismissIfPresent(page, [
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept All")',
      'button:has-text("Only allow essential cookies")',
      'button:has-text("Decline optional cookies")',
    ]);

    // Diagnostic snapshot before we touch the form. If this fails, the
    // caller can see whether IG served a checkpoint, mobile-only, or block
    // page instead of the login.
    await snapshot(page, `/tmp/ig-bots/login-${creds.igUsername}-pre.png`);

    // Current IG login form uses name="email" + name="pass"; the older
    // name="username" + name="password" form is gone as of 2026. Try both
    // so we degrade gracefully if they roll yet another rev.
    const userSelector =
      'input[name="email"], input[name="username"], input[autocomplete~="username"]';
    const passSelector =
      'input[name="pass"], input[name="password"], input[type="password"]';

    // Cheap blank-page detector — if after 15s the document carries no
    // <input> elements at all, the proxy probably returned a stalled or
    // empty page and there's no point waiting another 15s for an input
    // that will never render. Surfacing a typed error here lets the retry
    // layer rotate to a fresh proxy.
    await page.waitForTimeout(15_000);
    const inputCount = await page
      .locator("input")
      .count()
      .catch(() => 0);
    if (inputCount === 0) {
      const html = await dumpHtml(page).catch(() => "");
      const trulyBlank = html.length < 500 || /<body>\s*<\/body>/i.test(html);
      if (trulyBlank) {
        await snapshot(page, `/tmp/ig-bots/login-${creds.igUsername}-blank.png`);
        logger.error(
          {
            url: page.url(),
            username: creds.igUsername,
            proxy: proxyEndpointLabel(proxy.endpoint),
            htmlExcerpt: html.slice(0, 1500),
          },
          "[bot-login] login page rendered empty (likely dead proxy)",
        );
        throw new LoginBlankPageError(
          `[bot-login] login page rendered blank (no inputs) for ${creds.igUsername}`,
        );
      }
      logger.warn(
        {
          url: page.url(),
          username: creds.igUsername,
          proxy: proxyEndpointLabel(proxy.endpoint),
          htmlLength: html.length,
        },
        "[bot-login] login shell loaded without inputs; waiting for app mount",
      );
    }

    try {
      await page
        .locator(userSelector)
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
    } catch (err) {
      await snapshot(page, `/tmp/ig-bots/login-${creds.igUsername}-fail.png`);
      const html = await dumpHtml(page).catch(() => "");
      logger.error(
        {
          url: page.url(),
          username: creds.igUsername,
          htmlExcerpt: html.slice(0, 1500),
        },
        "[bot-login] username input never appeared",
      );
      throw err;
    }

    await page.locator(userSelector).first().fill(creds.igUsername);
    await page.locator(passSelector).first().fill(creds.igPassword);

    const triggerLogin = Date.now();
    // The visible "Log in" trigger on the current IG form is a styled
    // <div role="button">; the underlying <input type="submit"> is hidden
    // and can't be clicked. Click the role=button div and fall back to
    // pressing Enter on the password field if it isn't found (older form).
    const loginButton = page
      .locator('div[role="button"]:has-text("Log in")')
      .first();
    if (await loginButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await loginButton.click();
    } else {
      await page.locator(passSelector).first().press("Enter");
    }

    // After submit IG branches in one of:
    //   a) lands on the home feed → done
    //   b) shows "We sent a security code" → we need the email code
    //   c) shows "Save your login info" / "Turn on notifications" → dismiss
    //   d) shows an inline error ("Sorry, your password was incorrect") → fail
    let { outcome, alertText } = await waitForLoginOutcome(page);

    if (outcome === "recaptcha") {
      await completeRecaptchaCheckbox(page, creds.igUsername);
      ({ outcome, alertText } = await waitForLoginOutcome(page));
    }

    if (outcome === "challenge") {
      // Branch on the *kind* of challenge IG served us. The selectors and
      // visible copy differ:
      //   - Authenticator-app (TOTP) prompt: page mentions "authentication
      //     app" / "two-factor" / "Get a login code from your authentication
      //     app". URL often /two_factor.
      //   - Email/SMS code prompt: page mentions "We sent your code" /
      //     "verification code we sent" / "security code". URL often
      //     /challenge/ or /codeentry/.
      // A bot configured with totpSecret + IG showing the TOTP prompt is
      // the new path. When the page is ambiguous, a bot that has no mailbox
      // cannot complete the email path, so use its provisioned TOTP secret.
      // The legacy email-OTP path remains preferred whenever an email address
      // is configured and IG did not positively identify the TOTP surface.
      const isTotpPrompt = await detectTotpPrompt(page);
      const emailAddress =
        creds.email?.emailAddress ?? creds.email?.email_address ?? null;
      const useTotp = shouldUseTotpForChallenge({
        isTotpPrompt,
        hasTotpSecret: Boolean(creds.totpSecret),
        hasEmailAddress: Boolean(emailAddress),
      });
      if (useTotp && creds.totpSecret) {
        const code = generateTotp(creds.totpSecret);
        await fillTotpCode(page, code, creds.igUsername);
        totpUsed = true;
        // IG validates server-side and JS-redirects after submit. Same
        // 12s settle-then-probe approach as the email-OTP path.
        await page.waitForTimeout(12_000);
      } else if (isTotpPrompt && !creds.totpSecret) {
        await snapshot(
          page,
          `/tmp/ig-bots/login-${creds.igUsername}-2fa-no-secret.png`,
        );
        throw new Login2FARequiredButNoSecretError(
          `[bot-login] IG asked for authenticator-app 2FA code but no totpSecret was supplied for ${creds.igUsername}`,
        );
      } else {
        // Email-OTP path — works for both IMAP-backed mailboxes (rambler,
        // onet) and web-inbox providers (tmailgg.site). The facade routes
        // by `email_provider` / domain.
        if (!creds.email || !emailAddress) {
          throw new Error(
            "[bot-login] IG asked for email code but bot has no email_address configured",
          );
        }
        // We may need to refetch a code if the first one expires before we
        // can submit it. Two attempts is plenty — if the second one also
        // ages out, the surrounding retry layer will rotate the proxy.
        let codeAttempts = 0;
        const maxCodeAttempts = 2;
        let codeSubmitted = false;
        while (!codeSubmitted && codeAttempts < maxCodeAttempts) {
          codeAttempts += 1;
          const sinceCutoff =
            codeAttempts === 1
              ? new Date(triggerLogin - 60_000)
              : new Date(Date.now() - 60_000);
          const code = await fetchVerificationCode(creds.email, {
            since: sinceCutoff,
            timeoutMs: CODE_WAIT_TIMEOUT_MS,
          });
          const codeFetchedAt = Date.now();
          if (!code) {
            logger.warn(
              {
                username: creds.igUsername,
                attempt: codeAttempts,
                emailAddress,
              },
              "[bot-login] verification code not received in time",
            );
            continue;
          }
          emailCodeUsed = true;
          try {
            await fillVerificationCode(
              page,
              code,
              codeFetchedAt,
              creds.igUsername,
            );
            codeSubmitted = true;
          } catch (err) {
            if (err instanceof VerificationCodeStaleError) {
              logger.warn(
                {
                  username: creds.igUsername,
                  attempt: codeAttempts,
                },
                "[bot-login] verification code aged out before submit; refetching",
              );
              continue;
            }
            throw err;
          }
        }
        if (!codeSubmitted) {
          throw new Error(
            "[bot-login] could not submit a fresh verification code in time",
          );
        }
        // After Continue, IG validates server-side and JS-redirects. We
        // don't poll the URL precisely — instead, give it 12s to settle then
        // fall through into the post-login navigation + assertion below,
        // which is the canonical "are we logged in?" check anyway. This
        // avoids the false-negative where /codeentry/ stays in the URL bar
        // for a beat after success.
        await page.waitForTimeout(12_000);
      }
    } else if (outcome === "bad_credentials") {
      // NOTE: keep the "rejected username/password" phrase intact — the
      // lease-exclusion regexes (workers.ts / ig-public-scraper.ts) match
      // last_login_error against it to keep parked bots out of rotation.
      throw new LoginBadCredentialsError(
        `[bot-login] IG rejected username/password for ${creds.igUsername}` +
          (alertText ? ` (alert: ${alertText})` : ""),
      );
    } else if (outcome === "rate_limited") {
      // Transient throttling ("Please wait a few minutes…"). Retryable —
      // the retry layer rotates the proxy; the bot is never parked.
      throw new LoginRateLimitedError(
        `[bot-login] IG throttled login for ${creds.igUsername}: ${
          alertText ?? "transient alert"
        }`,
      );
    } else if (outcome === "alert") {
      // Unrecognized inline alert. Deliberately a generic (retryable) Error:
      // proxy rotation continues and the bot is NOT parked. Log the text so
      // new IG copy can be added to the classifier regexes.
      logger.warn(
        { username: creds.igUsername, alertText, url: page.url() },
        "[bot-login] unrecognized inline login alert — treating as retryable",
      );
      throw new Error(
        `[bot-login] IG login alert for ${creds.igUsername}: ${
          alertText ?? "(no alert text captured)"
        }`,
      );
    } else if (outcome === "unknown") {
      // Capture page state so we can diagnose what new screen IG served and
      // teach waitForLoginOutcome to recognize it. Without this snapshot the
      // failure reason is invisible after the browser closes.
      await snapshot(
        page,
        `/tmp/ig-bots/login-${creds.igUsername}-unknown.png`,
      );
      const html = await dumpHtml(page).catch(() => "");
      logger.error(
        {
          url: page.url(),
          username: creds.igUsername,
          htmlExcerpt: html.slice(0, 1500),
        },
        "[bot-login] login flow stuck on unknown screen",
      );
      throw new Error("[bot-login] login flow stuck on unknown screen");
    }

    // Knock down post-login interstitials so the homepage is our anchor.
    await dismissIfPresent(page, [
      'button:has-text("Save info")',
      'button:has-text("Not Now")',
      'button:has-text("Not now")',
      'div[role="dialog"] button:has-text("Cancel")',
    ]);

    await page.goto(POST_LOGIN_PROBE_URL, {
      waitUntil: "domcontentloaded",
    });
    const postLoginUrl = page.url();
    // IG redirects credential-accepted-but-dead accounts to a terminal surface:
    //   /accounts/suspended                              → suspended (sometimes appealable)
    //   /accounts/disabled/?...__coig_permdisabled=1     → permanently disabled
    // Both set a `sessionid` cookie, so the cookie check below is NOT enough to
    // reject them — without this guard a dead account slips into the pool as a
    // "leasable" bot that fails every scrape. Treat both as terminal: throw the
    // suspended error, which is non-retryable and parks the bot to status=banned.
    if (
      /\/accounts\/(suspended|disabled)\b/.test(postLoginUrl) ||
      /__coig_permdisabled/.test(postLoginUrl)
    ) {
      const surface = /disabled|permdisabled/.test(postLoginUrl)
        ? "disabled"
        : "suspended";
      await snapshot(
        page,
        `/tmp/ig-bots/post-login-${creds.igUsername}-${surface}.png`,
      );
      throw new LoginAccountSuspendedError(
        `[bot-login] account ${creds.igUsername} is ${surface} (url=${postLoginUrl})`,
      );
    }
    // Logged-in pages keep us at instagram.com/; logged-out gets redirected
    // to /accounts/login/. The cookie set is the real signal — `sessionid`
    // is only set on a successful login — so verify that explicitly.
    const storageState = await context.storageState();
    const hasSessionCookie = storageState.cookies.some(
      (c) => c.name === "sessionid" && c.value.length > 0,
    );
    if (!hasSessionCookie) {
      await snapshot(
        page,
        `/tmp/ig-bots/post-login-${creds.igUsername}.png`,
      );
      throw new Error(
        `[bot-login] no sessionid cookie after login (url=${page.url()})`,
      );
    }
    if (!/instagram\.com\/?$/.test(postLoginUrl)) {
      logger.warn(
        { url: postLoginUrl },
        "[bot-login] sessionid present but URL unexpected — accepting login",
      );
    }
    return {
      storageStateJson: JSON.stringify(storageState),
      emailCodeUsed,
      totpUsed,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

type Outcome =
  | "logged_in"
  | "challenge"
  | "recaptcha"
  | "interstitial"
  | "bad_credentials"
  | "rate_limited"
  | "alert"
  | "unknown";

interface LoginOutcomeResult {
  outcome: Outcome;
  /**
   * Normalized textContent of the inline alert/banner that produced a
   * `bad_credentials` / `rate_limited` / `alert` outcome. Undefined for
   * the other outcomes or when extraction failed.
   */
  alertText?: string;
}

/**
 * Classify the text of an inline login alert. Exported for unit tests.
 *
 *   - bad-credential phrases  → "bad_credentials" (non-retryable; park bot)
 *   - transient throttling    → "rate_limited"    (retryable; rotate proxy)
 *   - anything else / no text → "alert"           (retryable; rotate proxy)
 *
 * Unrecognized alerts deliberately stay retryable: a generic role="alert"
 * fires for many transient conditions, and misclassifying one as bad
 * credentials permanently removes a healthy bot from the pool.
 */
export function classifyAlertText(
  text: string | undefined,
): "bad_credentials" | "rate_limited" | "alert" {
  if (!text) return "alert";
  if (BAD_CREDENTIALS_TEXT_RE.test(text)) return "bad_credentials";
  if (TRANSIENT_ALERT_TEXT_RE.test(text)) return "rate_limited";
  return "alert";
}

/** Collapse whitespace and bound length so alert text is log/DB-safe. */
function normalizeAlertText(
  text: string | null | undefined,
): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed.slice(0, 300) : undefined;
}

// Type-only import: Playwright is in dependencies but we still load it
// dynamically at runtime inside loginBot to keep startup cost low when
// scrapers don't need the browser. Type imports are erased at compile time.
type PwPage = import("playwright").Page;

async function snapshot(page: PwPage, path: string): Promise<void> {
  await page
    .screenshot({ path, fullPage: false })
    .catch(() => {
      /* screenshots are best-effort diagnostics */
    });
}

async function dumpHtml(page: PwPage): Promise<string> {
  return page.content().catch(() => "");
}

async function waitForLoginOutcome(
  page: PwPage,
): Promise<LoginOutcomeResult> {
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/\/auth_platform\/recaptcha\//.test(url)) {
      return { outcome: "recaptcha" };
    }
    if (/\/accounts\/onetap/.test(url)) return { outcome: "interstitial" };
    if (/instagram\.com\/?$/.test(url)) return { outcome: "logged_in" };
    if (
      /\/challenge\/|\/auth_platform\/codeentry|\/two_factor|\/two_step_verification/.test(url) ||
      /flow=two_factor_login/.test(url)
    ) {
      return { outcome: "challenge" };
    }
    // Current IG builds render the invalid-credentials banner as normal text
    // rather than role="alert" — check the specific phrases first via the
    // text engine (single regex alternation; see BAD_CREDENTIALS_TEXT_RE).
    const badCredentials = page.getByText(BAD_CREDENTIALS_TEXT_RE).first();
    if (await badCredentials.isVisible().catch(() => false)) {
      const text = normalizeAlertText(
        await badCredentials.textContent().catch(() => null),
      );
      return { outcome: "bad_credentials", alertText: text };
    }
    // Generic inline alerts live near the form. These fire for MANY
    // conditions (rate limiting, transient failures, bad credentials on
    // older builds) — extract the text and classify rather than assuming
    // bad credentials.
    const alert = page
      .locator('p[role="alert"], div[role="alert"], #slfErrorAlert')
      .first();
    if (await alert.isVisible().catch(() => false)) {
      const text = normalizeAlertText(
        await alert.textContent().catch(() => null),
      );
      return { outcome: classifyAlertText(text), alertText: text };
    }
    // Code-entry input also indicates a challenge even when the URL stayed put.
    if (
      await page
        .locator('input[name="verificationCode"], input[autocomplete="one-time-code"]')
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return { outcome: "challenge" };
    }
    await page.waitForTimeout(500);
  }
  return { outcome: "unknown" };
}

/**
 * Click Meta's ordinary reCAPTCHA checkbox and wait for its callback to move
 * the top-level login flow forward. If Google opens an interactive puzzle,
 * surface a typed/manual state instead of looping proxies or marking the bot
 * available without a real session.
 */
async function completeRecaptchaCheckbox(
  page: PwPage,
  username: string,
): Promise<void> {
  const anchorDeadline = Date.now() + 20_000;
  let anchorFrame: import("playwright").Frame | null = null;
  while (Date.now() < anchorDeadline && !anchorFrame) {
    anchorFrame =
      page
        .frames()
        .find(
          (frame) =>
            /recaptcha\/api2\/anchor|recaptcha\/enterprise\/anchor/.test(
              frame.url(),
            ),
        ) ?? null;
    if (!anchorFrame) await page.waitForTimeout(250);
  }
  if (!anchorFrame) {
    throw new LoginCaptchaRequiredError(
      `[bot-login] Meta reCAPTCHA checkbox did not render for ${username}`,
    );
  }

  const checkbox = anchorFrame.locator("#recaptcha-anchor");
  await checkbox.waitFor({ state: "visible", timeout: 10_000 });
  await checkbox.click();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (!/\/auth_platform\/recaptcha\//.test(page.url())) return;
    const checked =
      (await checkbox.getAttribute("aria-checked").catch(() => null)) === "true";
    if (checked) {
      // The callback can lag slightly behind the checkbox state.
      await page.waitForTimeout(1_000);
      if (!/\/auth_platform\/recaptcha\//.test(page.url())) return;
    }
    const puzzleVisible = page.frames().some(
      (frame) =>
        /recaptcha\/api2\/bframe|recaptcha\/enterprise\/bframe/.test(
          frame.url(),
        ),
    );
    if (puzzleVisible) {
      await snapshot(page, `/tmp/ig-bots/login-${username}-captcha.png`);
      throw new LoginCaptchaRequiredError(
        `[bot-login] Meta reCAPTCHA requires interactive verification for ${username}`,
      );
    }
    await page.waitForTimeout(500);
  }

  await snapshot(page, `/tmp/ig-bots/login-${username}-captcha.png`);
  throw new LoginCaptchaRequiredError(
    `[bot-login] Meta reCAPTCHA did not complete for ${username}`,
  );
}

async function fillVerificationCode(
  page: PwPage,
  code: string,
  codeFetchedAt: number,
  username: string,
): Promise<void> {
  // The codeentry page lazy-renders its only <input> ~3-5s after the URL
  // change. The input is reused across redesigns: name="email" today (yes,
  // really — IG names the code field "email"), name="verificationCode" in
  // older flows. Match by URL context (we know we're on /codeentry/) and
  // accept either name.
  const codeSelector = [
    'input[name="verificationCode"]',
    'input[autocomplete="one-time-code"]',
    'input[name="confirmationCode"]',
    'input[name="security_code"]',
    'input[name="email"]',
    'input[aria-label*="code" i]',
    'input[placeholder*="code" i]',
    'input[type="text"][maxlength="6"]',
    'input[type="tel"][maxlength="6"]',
  ].join(", ");
  const input = page.locator(codeSelector).first();
  try {
    await input.waitFor({ state: "visible", timeout: 30_000 });
  } catch (err) {
    await snapshot(page, `/tmp/ig-bots/challenge-fail-${username}.png`);
    const html = await dumpHtml(page).catch(() => "");
    logger.error(
      { url: page.url(), username, htmlExcerpt: html.slice(0, 1500) },
      "[bot-login] verification-code input never appeared",
    );
    // Surface a typed error so the retry layer can rotate proxy. The raw
    // Playwright timeout is preserved in the chain via cause.
    throw new LoginChallengePageStuckError(
      `[bot-login] codeentry page never rendered an input for ${username}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  await input.fill(code);

  // Code-expiry guard: IG invalidates verification codes ~5 minutes after
  // they're emitted. If the challenge page render + IMAP fetch + form fill
  // combined chewed through that budget, abort *before* clicking Continue
  // so we don't burn this attempt on a guaranteed-stale code. The caller
  // refetches a fresh code and retries the form.
  const elapsedMs = Date.now() - codeFetchedAt;
  if (elapsedMs > CODE_FRESHNESS_BUDGET_MS) {
    logger.warn(
      { username, elapsedMs, budgetMs: CODE_FRESHNESS_BUDGET_MS },
      "[bot-login] verification code aged past freshness budget — aborting submit",
    );
    // Best-effort: clear the input so the retry can refill cleanly.
    await input.fill("").catch(() => undefined);
    throw new VerificationCodeStaleError(
      `[bot-login] verification code aged ${elapsedMs}ms (>${CODE_FRESHNESS_BUDGET_MS}ms) before submit`,
    );
  }

  // Continue trigger is also a <div role="button">; fall back to Enter.
  const cont = page
    .locator('div[role="button"]:has-text("Continue")')
    .first();
  if (await cont.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await cont.click();
  } else {
    await input.press("Enter");
  }
}

/**
 * Best-effort detection of an authenticator-app (TOTP) 2FA prompt vs the
 * legacy email-code prompt. Both share the 6-digit input element, so we
 * branch on visible copy + URL.
 *
 * Returns `true` when the page strongly looks like a TOTP / authenticator
 * challenge. False on email-OTP, on no challenge, or when ambiguous.
 *
 * Heuristics, ordered cheapest first:
 *   1. URL contains `/two_factor`, `/two_step_verification`, or the
 *      `flow=two_factor_login` marker (TOTP paths on current IG builds)
 *   2. visible text mentions "authentication app", "authenticator app",
 *      "two-factor authentication", or "Get a login code"
 *   3. as a last resort: input present AND no email-OTP copy AND no
 *      `/challenge/`-style URL
 */
async function detectTotpPrompt(page: PwPage): Promise<boolean> {
  const url = page.url();
  if (
    /\/two_factor/.test(url) ||
    /\/two_step_verification/.test(url) ||
    /flow=two_factor_login/.test(url)
  ) {
    return true;
  }

  const totpCopyLocator = page.locator(
    [
      'text=/authentication app/i',
      'text=/authenticator app/i',
      'text=/two-?factor/i',
      'text=/get a login code/i',
    ].join(", "),
  );
  if (await totpCopyLocator.first().isVisible({ timeout: 1_500 }).catch(() => false)) {
    return true;
  }

  // If we hit the legacy "We sent your code" / "verification code we sent"
  // copy, this is unambiguously the email-OTP path.
  const emailOtpCopy = page.locator(
    [
      'text=/we sent your code/i',
      'text=/verification code we sent/i',
      'text=/security code we sent/i',
      'text=/check your email/i',
    ].join(", "),
  );
  if (await emailOtpCopy.first().isVisible({ timeout: 800 }).catch(() => false)) {
    return false;
  }

  // Soft fallback — generic "verification code" text without an explicit
  // email reference plus a code input is *probably* the TOTP variant on
  // the new IG flow, but we treat it as ambiguous-not-TOTP so existing
  // bots (no totpSecret) still hit the email-OTP path. Caller checks
  // creds.totpSecret to disambiguate.
  return false;
}

/**
 * Select the viable verification method for a challenge. Instagram sometimes
 * renders generic code-entry copy without enough context for
 * {@link detectTotpPrompt} to identify it. A TOTP-only account has no viable
 * email fallback, so its provisioned authenticator secret is authoritative in
 * that ambiguous case.
 */
export function shouldUseTotpForChallenge({
  isTotpPrompt,
  hasTotpSecret,
  hasEmailAddress,
}: {
  isTotpPrompt: boolean;
  hasTotpSecret: boolean;
  hasEmailAddress: boolean;
}): boolean {
  return hasTotpSecret && (isTotpPrompt || !hasEmailAddress);
}

/**
 * Fill the 6-digit TOTP code into the same input element the email-OTP
 * flow uses. Differences from {@link fillVerificationCode}:
 *   - no IMAP-staleness guard (TOTP is generated fresh, on the spot)
 *   - realistic per-digit typing speed (50-150ms) so the form submit looks
 *     human; IG fingerprints input timing on this surface
 */
async function fillTotpCode(
  page: PwPage,
  code: string,
  username: string,
): Promise<void> {
  const codeSelector = [
    'input[name="verificationCode"]',
    'input[autocomplete="one-time-code"]',
    'input[name="confirmationCode"]',
    'input[name="security_code"]',
    'input[aria-label="Code"]',
    'input[placeholder="Code"]',
    'input[aria-label*="code" i]',
    'input[placeholder*="code" i]',
    'input[type="text"][maxlength="6"]',
    'input[type="tel"][maxlength="6"]',
    'input[type="text"]',
  ].join(", ");
  const input = page.locator(codeSelector).first();
  try {
    await input.waitFor({ state: "visible", timeout: 30_000 });
  } catch (err) {
    await snapshot(page, `/tmp/ig-bots/totp-fail-${username}.png`);
    const html = await dumpHtml(page).catch(() => "");
    logger.error(
      { url: page.url(), username, htmlExcerpt: html.slice(0, 1500) },
      "[bot-login] TOTP code input never appeared",
    );
    throw new LoginChallengePageStuckError(
      `[bot-login] 2FA page never rendered an input for ${username}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Clear any prefill, then type one digit at a time with jitter. We focus
  // explicitly because some IG renders ignore .fill() on this surface.
  await input.click({ timeout: 5_000 }).catch(() => undefined);
  await input.fill("").catch(() => undefined);
  for (const digit of code) {
    await input.type(digit, { delay: randomTypingDelayMs() });
  }

  const cont = page
    .locator('div[role="button"]:has-text("Continue"), button:has-text("Continue"), button:has-text("Confirm")')
    .first();
  if (await cont.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await cont.click();
  } else {
    await input.press("Enter");
  }
}

/**
 * Uniform random delay between 50-150ms, used to humanize the TOTP digit
 * typing cadence.
 */
function randomTypingDelayMs(): number {
  const minMs = 50;
  const maxMs = 150;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function dismissIfPresent(
  page: PwPage,
  selectors: string[],
): Promise<void> {
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      await el.click({ timeout: 2_000 }).catch(() => undefined);
    }
  }
}

/** Errors that the retry layer treats as "rotate proxy and try again". */
function shouldRotateProxy(err: unknown): boolean {
  return (
    err instanceof LoginBlankPageError ||
    err instanceof LoginChallengePageStuckError ||
    err instanceof LoginRateLimitedError
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

/**
 * Extract the DataImpulse country (`__cr.<cc>`) from a proxy endpoint so a
 * login retry rotates to a fresh IP in the SAME country as the bot's persona,
 * instead of falling back to a hardcoded geo. Returns undefined when the
 * endpoint carries no country routing (then the provider keeps its default).
 */
function countryFromEndpoint(endpoint: string): string | undefined {
  const marker = "__cr.";
  const i = endpoint.indexOf(marker);
  if (i < 0) return undefined;
  const cc = endpoint.slice(i + marker.length, i + marker.length + 2).toLowerCase();
  return /^[a-z]{2}$/.test(cc) ? cc : undefined;
}

/**
 * Resilience wrapper around {@link loginBot}. Drives up to `maxAttempts`
 * separate Playwright sessions, rotating to a freshly-probed proxy on
 * every retry. Backoff between attempts is fixed (5s, 10s) — short enough
 * that a downstream caller can still complete inside its own deadline.
 *
 * The first attempt uses the supplied proxy. Subsequent attempts request a
 * new healthy US endpoint via {@link fetchHealthyEndpoints}. Non-retryable
 * errors (bad password, missing IMAP creds) are surfaced immediately so we
 * don't waste rotations on something that'll never succeed.
 */
export async function loginBotWithRetry(
  creds: BotLoginCreds,
  proxy: BotLoginProxy,
  maxAttempts = 3,
  options: LoginRetryOptions = {},
): Promise<BotLoginResult> {
  if (maxAttempts < 1) {
    throw new Error(
      `[bot-login] loginBotWithRetry requires maxAttempts >= 1 (got ${maxAttempts})`,
    );
  }

  let activeProxy: BotLoginProxy = proxy;
  let lastError: unknown = null;
  const triedProxyEndpoints = new Set<string>();
  const allowProxyRotation = options.allowProxyRotation ?? true;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    triedProxyEndpoints.add(activeProxy.endpoint);
    logger.info(
      {
        username: creds.igUsername,
        attempt,
        maxAttempts,
        proxy: proxyEndpointLabel(activeProxy.endpoint),
      },
      "[bot-login] login attempt starting",
    );
    try {
      const result = await loginBot(creds, activeProxy);
      if (attempt > 1) {
        logger.info(
          {
            username: creds.igUsername,
            attempt,
            proxy: proxyEndpointLabel(activeProxy.endpoint),
          },
          "[bot-login] login succeeded after retry",
        );
      }
      return result;
    } catch (err) {
      lastError = err;
      const rotate = shouldRotateProxy(err);
      logger.warn(
        {
          username: creds.igUsername,
          attempt,
          maxAttempts,
          proxy: proxyEndpointLabel(activeProxy.endpoint),
          rotate,
          err: describeError(err),
        },
        "[bot-login] login attempt failed",
      );

      if (
        err instanceof LoginAccountSuspendedError ||
        err instanceof LoginBadCredentialsError ||
        err instanceof Login2FARequiredButNoSecretError ||
        err instanceof LoginCaptchaRequiredError
      ) {
        throw err;
      }

      if (attempt >= maxAttempts) break;

      if (!allowProxyRotation) {
        logger.warn(
          { username: creds.igUsername, attempt, maxAttempts },
          "[bot-login] static proxy configured; retrying without provider rotation",
        );
        await delay(RETRY_BACKOFF_MS[attempt - 1] ?? 0);
        continue;
      }

      // Always rotate the proxy on retry — even non-typed failures often
      // correlate with the upstream IP (CAPTCHA, rate-limit, blank page).
      // Pulling a fresh one is cheap and removes one unknown.
      try {
        const [fresh] = await fetchHealthyEndpoints(1, {
          country: countryFromEndpoint(activeProxy.endpoint),
          purpose: "account-session",
          excludeEndpoints: [...triedProxyEndpoints],
        });
        if (fresh) {
          activeProxy = { endpoint: fresh.endpoint };
          logger.info(
            {
              username: creds.igUsername,
              nextAttempt: attempt + 1,
              proxy: proxyEndpointLabel(activeProxy.endpoint),
            },
            "[bot-login] rotated to fresh proxy for retry",
          );
        } else {
          logger.warn(
            { username: creds.igUsername },
            "[bot-login] fetchHealthyEndpoints returned empty list; reusing current proxy",
          );
        }
      } catch (rotateErr) {
        logger.warn(
          {
            username: creds.igUsername,
            err: describeError(rotateErr),
          },
          "[bot-login] proxy rotation failed; reusing current proxy",
        );
      }

      const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? 10_000;
      await delay(backoff);
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(
    `[bot-login] all ${maxAttempts} login attempts failed for ${creds.igUsername}`,
  );
}
