// ─── Playwright-backed IG client for sensitive writes (Wave 3) ───────────────
//
// Reads intentionally use the configured HTTP transport. Follow writes use
// an actual profile navigation and a scoped UI button click; failure never
// silently falls back to an API write. Playwright is imported lazily.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  IGClientFactory,
  IGClientPort,
  IGFeedPage,
  IGFriendshipPage,
  IGFriendshipStatus,
  IGProfile,
} from "./domain/ig-client-port.js";
import { logger as baseLogger } from "./observability/logger.js";
import {
  createHttpBotClientWithFingerprint,
} from "./ig-http-client.js";
import type { DeviceFingerprint } from "./behavior/device-fingerprint.js";
import { resolveFingerprint } from "./behavior/device-fingerprint.js";
import { humanDelay, sleep } from "./behavior/pacing.js";
import { randomInt } from "node:crypto";

const logger = baseLogger.child({ module: "ig-playwright-client" });

// Minimal shape of a Playwright cookie as stored in Playwright's storageState.
interface PwCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None" | string;
}

interface StorageState {
  cookies: PwCookie[];
  origins?: unknown[];
}

function parseStorage(sessionData: string): StorageState {
  const parsed = JSON.parse(sessionData);
  if (!parsed || !Array.isArray(parsed.cookies)) {
    throw new Error("[ig-playwright] sessionData missing cookies[]");
  }
  return parsed as StorageState;
}

function parseProxy(proxyUrl?: string | null): {
  server: string;
  username?: string;
  password?: string;
} | undefined {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    if (!["http:", "https:", "socks5:"].includes(u.protocol) || !u.hostname || u.pathname !== "/" || u.search || u.hash) throw new Error("Invalid proxy URL");
    const out: { server: string; username?: string; password?: string } = {
      server: `${u.protocol}//${u.host}`,
    };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch (err) {
    throw new Error("[ig-playwright] invalid assigned proxy; refusing direct connection");
  }
}

// Narrow shape of what we actually consume from "playwright" so we don't
// pull types in at build time (dependency is optional in wave 3).
interface PlaywrightLike {
  chromium: {
    launch(opts?: Record<string, unknown>): Promise<PlaywrightBrowser>;
  };
}
interface PlaywrightBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
  addCookies(cookies: PwCookie[]): Promise<void>;
}
interface PlaywrightPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  locator(selector: string): {
    first(): {
      click(opts?: Record<string, unknown>): Promise<void>;
      waitFor(opts?: Record<string, unknown>): Promise<void>;
      isVisible(opts?: Record<string, unknown>): Promise<boolean>;
    };
  };
  mouse: {
    move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
  };
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

async function loadPlaywright(): Promise<PlaywrightLike | null> {
  try {
    // Dynamic import so bundling/build works when the dep is not installed.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - optional dependency
    const mod = await import("playwright");
    return mod as unknown as PlaywrightLike;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[ig-playwright] playwright not installed; browser follow unavailable",
    );
    return null;
  }
}

export interface PlaywrightBotDeps {
  sessionData: string;
  fingerprint: DeviceFingerprint;
  botUsername: string;
  proxyUrl?: string | null;
}

/** HTTP reads plus an explicit UI follow for a previously resolved target.
 * Browser unavailability or an unconfirmed click never starts an HTTP write.
 */
export async function createPlaywrightBotClient(deps: PlaywrightBotDeps): Promise<IGClientPort> {
  const endpoint = deps.proxyUrl ? (() => {
    const proxy = parseProxy(deps.proxyUrl)!;
    const url = new URL(proxy.server);
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
      + (proxy.username ? `:${proxy.username}:${proxy.password ?? ''}` : '');
  })() : null;
  const http = createHttpBotClientWithFingerprint(deps.sessionData, deps.fingerprint, deps.botUsername, endpoint);
  const targets = new Map<string, string>();
  return {
    ...http,
    fetchProfile: async username => {
      const profile = await http.fetchProfile(username);
      if (profile.pk && profile.username.toLowerCase() === username.toLowerCase()) targets.set(profile.pk, profile.username);
      return profile;
    },
    sendFollow: async targetPk => {
      const targetUsername = targets.get(targetPk);
      if (!targetUsername || !deps.proxyUrl) throw new Error('Browser follow requires a verified target and assigned proxy');
      const result = await playwrightSendFollowByUsername({ ...deps, targetUsername });
      if (!result || (!result.following && !result.requested)) throw new Error('Browser follow unconfirmed; refusing another write');
      return { following: result.following, outgoingRequest: result.requested,
        incomingRequest: false, followedBy: false, isPrivate: true };
    },
  };
}

// Selectors are kept module-local so they can be exercised by unit tests
// without standing up a real Playwright browser.
const FOLLOWING_SELECTOR =
  'main header button:text-is("Following"), main header div[role="button"]:text-is("Following")';
const REQUESTED_SELECTOR =
  'main header button:text-is("Requested"), main header div[role="button"]:text-is("Requested")';
const FOLLOW_SELECTOR =
  'main header button:text-is("Follow"), main header div[role="button"]:text-is("Follow"), main header button:text-is("Follow Back"), main header button:text-is("Seguir")';

/**
 * Inspect the profile page and either:
 *   - Recognize that we're already in Following / Requested state and report it
 *   - Find the Follow button, click it, then read the post-click state
 *   - Conclude no relevant button exists and return null (treat as failure)
 *
 * Returning null on the no-button-visible path is the bug-fix: the previous
 * implementation incorrectly reported `following: true` whenever the Follow
 * button locator timed out, which caused downstream systems to grant access
 * even though no follow request had actually been sent.
 *
 * Exported for unit testing.
 */
export async function detectAndClickFollow(
  page: PlaywrightPage,
  targetUsername: string,
  canFollow: () => Promise<boolean> = async () => true,
): Promise<{ requested: boolean; following: boolean } | null> {
  const isTargetPage = () => {
    try {
      const current = new URL(page.url());
      return current.origin === "https://www.instagram.com" && !current.username && !current.password
        && current.pathname.toLowerCase() === `/${targetUsername.toLowerCase()}/`;
    } catch { return false; }
  };
  if (!isTargetPage()) return null;
  // 0) Wait for the action row to HYDRATE before deciding anything.
  //
  // page.goto uses waitUntil:"domcontentloaded", which fires long before IG's
  // React app renders. A debug screenshot from a real failure showed the bot
  // logged in and the profile header populated (posts / followers / bio all
  // present) while the Follow and Message buttons were still grey skeleton
  // placeholders and the post grid was still spinning. Every selector below
  // then missed and we reported "follow button not found" for an account that
  // was perfectly followable — which is why several targets ended up with one
  // watcher instead of three.
  //
  // Waiting for whichever of the three states appears first is both faster and
  // far more reliable than a longer fixed sleep, because it returns the moment
  // the row is real. A timeout here is not fatal: the checks below still run
  // and can still find a button that appeared late.
  await page
    .locator(
      `${FOLLOWING_SELECTOR}, ${REQUESTED_SELECTOR}, ${FOLLOW_SELECTOR}`,
    )
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => undefined);

  if (!isTargetPage()) return null;

  // 1) Already-following: bot has previously followed this account.
  const alreadyFollowing = await page
    .locator(FOLLOWING_SELECTOR)
    .first()
    .isVisible({ timeout: 2_000 })
    .catch(() => false);

  if (alreadyFollowing && isTargetPage()) {
    logger.info(
      { target: targetUsername },
      "[ig-playwright] target already followed by this bot",
    );
    return { requested: false, following: true };
  }

  // 2) Already-requested: bot has previously sent a follow request.
  const alreadyRequested = await page
    .locator(REQUESTED_SELECTOR)
    .first()
    .isVisible({ timeout: 2_000 })
    .catch(() => false);

  if (alreadyRequested && isTargetPage()) {
    logger.info(
      { target: targetUsername },
      "[ig-playwright] follow already requested previously",
    );
    return { requested: true, following: false };
  }

  // 3) Look for the Follow button. IG uses localized labels; match both
  // English and the most common accessible role fallback.
  const followBtn = page.locator(FOLLOW_SELECTOR).first();
  const visible = await followBtn
    .isVisible({ timeout: 5_000 })
    .catch(() => false);

  if (!visible) {
    // No actionable button. Capture a debug screenshot for triage and tell
    // the caller this attempt failed so it can be requeued / retried with a
    // different bot. Do NOT optimistically claim following=true.
    const screenshotPath = `/tmp/ig-bots/follow-btn-missing-${targetUsername}-${Date.now()}.png`;
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
      logger.warn(
        { target: targetUsername, screenshotPath },
        "[ig-playwright] follow button not found — saved debug screenshot, returning failure",
      );
    } catch (err) {
      logger.warn(
        {
          target: targetUsername,
          err: err instanceof Error ? err.message : String(err),
        },
        "[ig-playwright] follow button not found AND screenshot failed",
      );
    }
    return null;
  }

  // 4) Click the Follow button and read post-click state.
  // Eligibility can end while Chromium starts, the page hydrates, or the
  // human delay runs. Recheck at the final boundary before the external write.
  if (!(await canFollow()) || !isTargetPage()) return null;
  await followBtn.click();
  await sleep(randomInt(1500, 4500));

  const requested = await page
    .locator(REQUESTED_SELECTOR)
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  const following = await page
    .locator(FOLLOWING_SELECTOR)
    .first()
    .isVisible({ timeout: 2_000 })
    .catch(() => false);

  return isTargetPage() ? { requested, following } : null;
}

/**
 * Full-Playwright sendFollow: opens Chrome with the bot's cookies, navigates
 * to the target profile, and clicks the Follow button like a human would.
 * Used when we know the target username (sendFollowForRequest path).
 */
export async function playwrightSendFollowByUsername(
  deps: PlaywrightBotDeps & { targetUsername: string; canFollow?: () => Promise<boolean> },
): Promise<{ requested: boolean; following: boolean } | null> {
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(deps.targetUsername)) throw new Error('Browser follow requires a valid target username');
  if (!deps.proxyUrl) throw new Error('Browser follow requires the assigned proxy');
  const pw = await loadPlaywright();
  if (!pw) return null;
  if (deps.canFollow && !(await deps.canFollow())) return null;

  const storage = parseStorage(deps.sessionData);
  const proxy = parseProxy(deps.proxyUrl);

  const browser = await pw.chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
    ...(proxy ? { proxy } : {}),
  });

  try {
    const context = await browser.newContext({
      userAgent: deps.fingerprint.userAgent,
      viewport: { width: 1366, height: 768 },
      locale: deps.fingerprint.locale,
      timezoneId: deps.fingerprint.timezone,
    });

    // Load bot's cookies into the new context.
    await context.addCookies(
      storage.cookies.filter((c) => /(^|\.)instagram\.com$/i.test(c.domain ?? "")),
    );

    const page = await context.newPage();
    const url = `https://www.instagram.com/${encodeURIComponent(deps.targetUsername)}/`;
    if (deps.canFollow && !(await deps.canFollow())) return null;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Human-like micro-motion before we interact.
    await page.mouse.move(
      randomInt(300, 900),
      randomInt(200, 600),
      { steps: 25 },
    );
    await humanDelay(3_000, 12_000, 5_000, 3_000);

    const result = await detectAndClickFollow(page, deps.targetUsername, deps.canFollow);

    await page.close();
    await context.close();
    return result;
  } catch (err) {
    logger.warn(
      {
        target: deps.targetUsername,
        err: err instanceof Error ? err.message : String(err),
      },
      "[ig-playwright] sendFollow error",
    );
    return null;
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}

// Factory variant matching IGClientFactory's signature. Lazy wraps the HTTP
// client for reads; Playwright is only used if the caller also supplies a
// target username via the extended createPlaywrightBotClient above.
export const createPlaywrightBotClientFactory: IGClientFactory = async (
  sessionData: string,
): Promise<IGClientPort> => {
  return createPlaywrightBotClient({ sessionData, botUsername: "", fingerprint: {
    deviceId: "00000000-0000-4000-8000-000000000000",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    appId: "936619743392459",
    timezone: "America/New_York",
    locale: "en-US",
    awakeHourStart: 10,
    awakeHourEnd: 23,
  } });
};

// Re-export types used by callers who want to compose their own transport mix.
export type { IGClientPort, IGProfile, IGFeedPage, IGFriendshipPage, IGFriendshipStatus };
