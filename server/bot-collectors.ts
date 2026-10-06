import { ensureBotReady, type BotRuntimeContext } from "./services/bot-runtime.js";
import { sendBrowserFollow } from "./services/bot-follow-browser.js";
import { trackedAccountHasAccess } from "./services/subscription-access.js";
import { db } from "./db.js";
import {
  likeEvents,
  followEvents,
  unfollowEvents,
  botAccounts,
  botFollowRequests,
  type BotAccount,
  type TrackedAccount,
} from "../shared/schema.js";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { isIgWebThrottleBody } from "./services/ig-throttle.js";
import { cooldownBotForRateLimit } from "./services/bot-cooldown.js";
import {
  IGAuthExpiredError,
  IGHttpError,
  IGRateLimitedError,
  type BotClientIdentity,
  type IGBotClientFactory,
} from "./ig-http-client.js";
import type {
  IGClientPort,
  IGFriendshipPage,
  IGFriendshipUser,
} from "./domain/ig-client-port.js";
import {
  markFollowRequestAccepted,
  markFollowRequestFailed,
  markFollowRequestSent,
  ensureBotFingerprint,
} from "./bot-manager.js";
import {
  decryptSessionData,
} from "./crypto/session-envelope.js";
import {
  humanDelay,
  isAwake,
  msUntilAwake,
  reserveGlobalFollow,
} from "./behavior/pacing.js";
import {
  reserveDailyBudget,
  effectiveFollowCap,
  isInWarmup,
  IGDailyCapExceededError,
  nextMidnightUtc,
} from "./behavior/caps.js";
import { resolveFingerprint } from "./behavior/device-fingerprint.js";
import { proxyAgentUriForEndpoint } from "./services/proxy-provider.js";
import { playwrightSendFollowByUsername } from "./ig-playwright-client.js";
import {
  COMPLETENESS_THRESHOLD,
  shouldComputeUnfollowDiff,
} from "./services/diff-completeness.js";

// ─── Bot session collectors ──────────────────────────────────────────────────
//
// Wave 2: this layer depends only on IGClientPort (see domain/ig-client-port.ts)
// — no direct import of ig-http-client internals. The factory is injected via
// createBotCollectors(deps) so tests, mocks, and future transports can swap in
// a different client implementation.
//
// Called by server/workers.ts when a private tracked account has an accepted
// bot follow.
// ─────────────────────────────────────────────────────────────────────────────

// Result of attempting to send a follow request. Workers use it to decide
// whether to enqueue downstream collection jobs.
//
// Wave 3: adds two deferral outcomes so the worker can requeue with a
// purpose-built delay instead of marking the request failed when the bot is
// simply asleep or fleet-wide throttled.
export type SendFollowOutcome =
  | { kind: "accepted" }
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "deferred"; reason: "asleep" | "global-throttle" | "warmup" | "cooldown"; retryAfterMs: number };

export interface BotCollectors {
  collectLikesViaBotSession(
    trackedAccountId: string,
    igUsername: string,
    sessionData: string,
  ): Promise<number>;
  collectFollowsViaBotSession(
    trackedAccountId: string,
    igUsername: string,
    sessionData: string,
  ): Promise<number>;
  sendFollowForRequest(
    botFollowRequestId: string,
    bot: BotAccount,
    trackedAccount: TrackedAccount,
    runtime: BotRuntimeContext,
  ): Promise<SendFollowOutcome>;
}

// ─── Bot state helpers (shared across collectors) ──────────────────────────

// Mark a bot as banned/unusable. "suspended" is not a bot_status enum value,
// so we use "banned" which matches the actual outcome (IG has positively
// blocked this bot — the admin must investigate).
export async function suspendBot(botId: string, reason: string): Promise<void> {
  console.error(`[collectors] banning bot ${botId}: ${reason}`);
  await db
    .update(botAccounts)
    .set({ status: "banned", updatedAt: new Date() })
    .where(eq(botAccounts.id, botId))
    .catch((err) =>
      console.error(`[collectors] failed to mark bot ${botId} banned:`, err),
    );
}

// Wave 2: session_expired is distinct from banned — the IG session cookies
// timed out / were invalidated, but the bot account itself is not in trouble.
// The admin can self-serve re-auth by uploading a fresh sessionData blob
// (see PATCH /api/admin/bots/:id/session). This status excludes the bot from
// assignment (bot-manager only picks status="available") but does not require
// manual recovery in the sense a "banned" bot does.
export async function markBotSessionExpired(
  botId: string,
  reason: string,
): Promise<void> {
  console.warn(`[collectors] bot ${botId} session expired: ${reason}`);
  await db
    .update(botAccounts)
    .set({ status: "session_expired", updatedAt: new Date() })
    .where(eq(botAccounts.id, botId))
    .catch((err) =>
      console.error(
        `[collectors] failed to mark bot ${botId} session_expired:`,
        err,
      ),
    );
}

export async function cooldownBot(botId: string, untilMs: number): Promise<void> {
  const until = new Date(untilMs);
  console.warn(`[collectors] cooldown bot ${botId} until ${until.toISOString()}`);
  await db
    .update(botAccounts)
    .set({ cooldownUntil: until, updatedAt: new Date() })
    // A shorter throttle must not overwrite a stronger hold from another flow.
    .where(and(eq(botAccounts.id, botId), or(isNull(botAccounts.cooldownUntil), lt(botAccounts.cooldownUntil, until))))
    .catch((err) =>
      console.error(`[collectors] failed to set cooldown for bot ${botId}:`, err),
    );
}

// Audit B1: the row shape collectors need to build a full BotClientIdentity —
// id/username plus the sticky residential proxy and the persisted device
// fingerprint columns (resolveFingerprint falls back deterministically when
// any of them is NULL on a legacy row).
interface AcceptedBotRow {
  id: string;
  igUsername: string;
  deviceId: string | null;
  deviceUserAgent: string | null;
  igAppId: string | null;
  timezone: string | null;
  locale: string | null;
  awakeHourStart: number | null;
  awakeHourEnd: number | null;
}

// Look up which bot account owns the session currently accepted on this tracked account.
async function getAcceptedBotForTrackedAccount(
  trackedAccountId: string,
): Promise<AcceptedBotRow | null> {
  const [row] = await db
    .select({
      id: botAccounts.id,
      igUsername: botAccounts.igUsername,
      deviceId: botAccounts.deviceId,
      deviceUserAgent: botAccounts.deviceUserAgent,
      igAppId: botAccounts.igAppId,
      timezone: botAccounts.timezone,
      locale: botAccounts.locale,
      awakeHourStart: botAccounts.awakeHourStart,
      awakeHourEnd: botAccounts.awakeHourEnd,
    })
    .from(botFollowRequests)
    .innerJoin(botAccounts, eq(botFollowRequests.botAccountId, botAccounts.id))
    .where(
      and(
        eq(botFollowRequests.trackedAccountId, trackedAccountId),
        eq(botFollowRequests.status, "accepted"),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Map IG media_type to our postTypeEnum. IG: 1=photo, 2=video, 8=carousel.
function mapIgMediaType(mediaType: number): "photo" | "video" | "reel" | "carousel" {
  if (mediaType === 8) return "carousel";
  if (mediaType === 2) return "video";
  return "photo";
}

function extractHashtags(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const matches = caption.match(/#[a-zA-Z]\w{2,}/g);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

// IG-side semantic codes that mean the bot's session is no longer trustworthy
// to IG and a fresh Playwright login (with a fresh proxy IP) is required.
// Wave 5: HTTP 400 + `checkpoint_required` / `challenge_required` are not
// auth errors per HTTP semantics, but IG uses them to gate the session until
// the user re-verifies — the practical recovery is identical to a 401/403,
// so we treat them the same way (null session_data → ensureBotReady drives
// a relogin on the next call).
const SESSION_INVALIDATING_IG_ERROR_CODES = new Set<string>([
  "checkpoint_required",
  "challenge_required",
  "login_required",
]);

const WEB_THROTTLE_COOLDOWN_MS = 10 * 60_000;

// Treat an IGHttpError body fragment as a CSRF / auth_rejected signal.
// IG returns `{"message":"CSRF token missing or incorrect","status":"fail"}`
// on 403 most of the time — that path becomes an IGAuthExpiredError already,
// but in some odd edge cases (cloudfront-rewritten responses, retries via
// challenge surface) the same payload appears as a non-403, so we sniff the
// body too.
function isCsrfOrAuthRejectedBody(body: string | undefined): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("csrf token missing") ||
    lower.includes("csrf_token_missing") ||
    lower.includes("auth_rejected")
  );
}

// Run an IG HTTP call and translate auth/rate-limit/challenge errors into
// bot-state updates. Wave 4 nulls session_data on IGAuthExpiredError so
// the next ensureBotReady() drives auto-relogin; Wave 5 extends the same
// recovery path to checkpoint/challenge/login_required (HTTP 400 semantics)
// and explicit CSRF rejections that don't surface as IGAuthExpiredError.
export async function withBotErrorHandling<T>(
  botId: string,
  botUsername: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IGAuthExpiredError) {
      if (err.status === 401 && isIgWebThrottleBody(err.body ?? "")) {
        // A localized "please wait" envelope is a throttle of a saved session,
        // not evidence that its cookies need replacement or another login.
        await cooldownBot(botId, Date.now() + WEB_THROTTLE_COOLDOWN_MS);
        throw new IGRateLimitedError(WEB_THROTTLE_COOLDOWN_MS, "Instagram web session temporarily throttled", { cause: err });
      }
      console.warn(
        `[collectors] bot @${botUsername} auth expired (status=${err.status ?? "?"}) — invalidating session for auto-relogin`,
      );
      const { invalidateBotSession } = await import(
        "./services/bot-runtime.js"
      );
      await invalidateBotSession(botId);
      throw err;
    }
    if (err instanceof IGRateLimitedError) {
      console.warn(`[collectors] bot @${botUsername} rate limited: ${err.retryAfterMs}ms`);
      await cooldownBotForRateLimit(botId, err.retryAfterMs);
      throw err;
    }
    if (err instanceof IGHttpError) {
      const code = err.igErrorCode;
      const sessionInvalidating =
        (code && SESSION_INVALIDATING_IG_ERROR_CODES.has(code)) ||
        isCsrfOrAuthRejectedBody(err.body);
      if (sessionInvalidating) {
        console.warn(
          `[collectors] bot @${botUsername} session-invalidating IG error (status=${err.status} code=${code ?? "n/a"}) — invalidating session for auto-relogin`,
        );
        const { invalidateBotSession } = await import(
          "./services/bot-runtime.js"
        );
        await invalidateBotSession(botId);
        throw err;
      }
    }
    throw err;
  }
}

// Open a client from an encrypted-or-plaintext stored session. Decryption is
// isolated here so the port (transport) never sees the key. Audit B1: the
// full bot identity (proxy + fingerprint) is mandatory — an identity-less
// client silently egressed from the datacenter IP with the shared default UA.
async function openClient(
  factory: IGBotClientFactory,
  storedSession: string,
  identity: BotClientIdentity,
): Promise<IGClientPort> {
  const plaintext = decryptSessionData(storedSession);
  return factory(plaintext, identity);
}

// Audit B1: build the per-bot client identity (stable device fingerprint +
// sticky residential proxy). Callers guard `proxyEndpoint` themselves first
// so a missing proxy produces the right outcome (skip / fail the request)
// before constructing the client.
async function resolveBotClientIdentity(
  bot: AcceptedBotRow,
  runtime: BotRuntimeContext,
): Promise<BotClientIdentity> {
  const fingerprint = await ensureBotFingerprint(bot.id).catch((err) => {
    console.warn(
      `[collectors] fingerprint resolve failed for @${bot.igUsername}:`,
      err,
    );
    return resolveFingerprint(bot);
  });
  return {
    botId: bot.id,
    botUsername: bot.igUsername,
    fingerprint,
    proxyEndpoint: runtime.proxyEndpoint,
    automationIdentity: runtime.automationIdentity,
  };
}

// ─── Private-roster pagination + unfollow gate (Audit B12) ──────────────────
//
// Audit B12: this collector used a hardcoded maxPages=10 cap (50 users/page →
// 500 max) and then diffed `prior \ live` with no check that the live capture
// was complete. Any private account with more followings than the cap — or a
// page failure mid-walk — marked every prior-known following outside the
// captured window as "unfollowed", emitting false mass-unfollow events. Same
// failure class as the public-path wire.fluid incident (305 false unfollows;
// see services/diff-completeness.ts).
//
// Completeness contract: a capture is COMPLETE only when IG itself terminated
// the pagination (no next cursor). Stopping because the page budget ran out,
// or because a page errored mid-walk, yields complete=false. Incomplete
// captures still feed new-follow detection (additions are safe: seeing a user
// in ANY page proves the follow exists) but must never feed unfollow
// detection. Even complete captures must pass the same 0.90 sanity ratio the
// public path uses (shouldComputeUnfollowDiff) before unfollows are diffed.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_PRIVATE_FOLLOWS_MAX_PAGES = 10;

/** Page budget for the private following paginator (50 users/page). Override
 *  with PRIVATE_FOLLOWS_MAX_PAGES for large private accounts; invalid values
 *  fall back to the default. Raising the cap helps reach completeness, but
 *  the gate below is what actually prevents false unfollows. */
export function resolvePrivateFollowsMaxPages(): number {
  const raw = process.env.PRIVATE_FOLLOWS_MAX_PAGES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PRIVATE_FOLLOWS_MAX_PAGES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      `[collectors:follows] invalid PRIVATE_FOLLOWS_MAX_PAGES="${raw}" — using default ${DEFAULT_PRIVATE_FOLLOWS_MAX_PAGES}`,
    );
    return DEFAULT_PRIVATE_FOLLOWS_MAX_PAGES;
  }
  return parsed;
}

/** Why the paginator stopped walking. Only "exhausted" (IG returned no next
 *  cursor) counts as a complete capture. */
export type FollowingCaptureTermination =
  | "exhausted"
  | "max-pages"
  | "page-error";

export interface FollowingCaptureResult {
  readonly users: ReadonlyArray<IGFriendshipUser>;
  /** True only when termination === "exhausted". */
  readonly complete: boolean;
  readonly termination: FollowingCaptureTermination;
  readonly pagesFetched: number;
}

export async function fetchAllFollowing(
  client: IGClientPort,
  pk: string,
  botId: string,
  igUsername: string,
  maxPages = DEFAULT_PRIVATE_FOLLOWS_MAX_PAGES,
): Promise<FollowingCaptureResult> {
  const users: IGFriendshipUser[] = [];
  let cursor: string | undefined;
  let pagesFetched = 0;
  for (let i = 0; i < maxPages; i++) {
    let page: IGFriendshipPage;
    try {
      page = await withBotErrorHandling(botId, igUsername, () =>
        client.fetchFollowing(pk, { count: 50, maxId: cursor }),
      );
    } catch (err) {
      // First page failed → we know nothing; let the caller's error path run
      // (withBotErrorHandling already applied session/cooldown side effects).
      if (pagesFetched === 0) throw err;
      // Mid-walk failure → the pages we already hold are real data. Return
      // them as an explicitly INCOMPLETE capture so the unfollow diff is
      // suppressed downstream while additions are still recorded.
      console.warn(
        `[collectors:follows] @${igUsername}: page ${i + 1} failed mid-walk after ${users.length} users — returning partial capture:`,
        err,
      );
      return { users, complete: false, termination: "page-error", pagesFetched };
    }
    pagesFetched++;
    users.push(...page.users);
    if (!page.nextMaxId) {
      return { users, complete: true, termination: "exhausted", pagesFetched };
    }
    cursor = page.nextMaxId;
    // Wave 3: human-like pause between paginated calls. Real users do not
    // scroll 10 pages of a follower list in 2 seconds.
    if (i < maxPages - 1) {
      await humanDelay(2_000, 20_000, 5_000, 4_000);
    }
  }
  // Page budget exhausted with a live cursor still in hand → IG had more.
  return { users, complete: false, termination: "max-pages", pagesFetched };
}

export type UnfollowGateDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: "incomplete-capture" | "ratio-failed";
      readonly detail: string;
    };

/**
 * Pure decision: may the unfollow side of the diff run against this capture?
 *
 *   - capture incomplete (page cap / page error)        → never.
 *   - liveCount < 0.90 × priorActiveCount (sanity ratio) → never.
 *   - otherwise                                          → allow.
 *
 * Mirrors shouldComputeUnfollowDiff on the public path; the prior-known
 * still-active roster stands in for the snapshot count as the baseline.
 */
export function decideUnfollowGate(
  capture: Pick<
    FollowingCaptureResult,
    "complete" | "termination" | "pagesFetched"
  >,
  liveCount: number,
  priorActiveCount: number,
): UnfollowGateDecision {
  if (!capture.complete) {
    return {
      allow: false,
      reason: "incomplete-capture",
      detail:
        `pagination ended early (${capture.termination}) after ` +
        `${capture.pagesFetched} page(s): captured=${liveCount}, priorKnown=${priorActiveCount}`,
    };
  }
  if (priorActiveCount > 0) {
    const decision = shouldComputeUnfollowDiff(liveCount, priorActiveCount);
    if (!decision.allowUnfollowDiff) {
      return {
        allow: false,
        reason: "ratio-failed",
        detail:
          `captured=${liveCount} is below ${COMPLETENESS_THRESHOLD * 100}% of ` +
          `priorKnown=${priorActiveCount} (completeness=${decision.completeness?.toFixed(3) ?? "n/a"})`,
      };
    }
  }
  return { allow: true };
}

// ─── Factory (DI entry point) ──────────────────────────────────────────────

export function createBotCollectors(deps: {
  createClient: IGBotClientFactory;
}): BotCollectors {
  async function collectLikesViaBotSession(
    trackedAccountId: string,
    igUsername: string,
    sessionData: string,
  ): Promise<number> {
    const bot = await getAcceptedBotForTrackedAccount(trackedAccountId);
    if (!bot) {
      console.warn(`[collectors:likes] no accepted bot for ${trackedAccountId}`);
      return 0;
    }

    if (!(await trackedAccountHasAccess(trackedAccountId))) return 0;
    // Use the accepted bot's current session and its canonical fixed proxy and
    // automation identity. Never fall back to another bot or direct transport.
    const runtime = await ensureBotReady(bot.id, { allowLogin: false });
    const identity = await resolveBotClientIdentity(bot, runtime);

    let client: IGClientPort;
    try {
      client = await openClient(deps.createClient, runtime.sessionData, identity);
    } catch (err) {
      console.error(`[collectors:likes] client initialization failed for bot ${bot.id}:`, err);
      // Local parsing or client setup cannot prove an account suspension.
      if (err instanceof IGAuthExpiredError) {
        await markBotSessionExpired(bot.id, "stored session missing or expired during client initialization");
      }
      throw err;
    }

    try {
      const profile = await withBotErrorHandling(bot.id, bot.igUsername, () =>
        client.fetchProfile(igUsername),
      );
      if (!profile.pk) {
        console.error(`[collectors:likes] could not resolve pk for @${igUsername}`);
        return 0;
      }

      const feed = await withBotErrorHandling(bot.id, bot.igUsername, () =>
        client.fetchUserFeed(profile.pk, { count: 24 }),
      );

      if (feed.items.length === 0) {
        console.log(`[collectors:likes] no feed items for @${igUsername}`);
        return 0;
      }

      const rows = feed.items
        .filter((item) => !!item.id)
        .map((item) => ({
          trackedAccountId,
          postId: item.id,
          ownerUsername: igUsername,
          postType: mapIgMediaType(item.mediaType),
          caption: item.caption,
          thumbnailUrl: null,
          postUrl: item.code ? `https://www.instagram.com/p/${item.code}/` : null,
          hashtags: extractHashtags(item.caption),
          likesCount: item.likeCount,
          commentsCount: item.commentCount,
          videoViewCount: null,
          locationName: null,
          detectedAt: item.takenAt > 0 ? new Date(item.takenAt * 1000) : new Date(),
        }));

      if (rows.length === 0) return 0;

      const inserted = await db
        .insert(likeEvents)
        .values(rows)
        .onConflictDoNothing({
          target: [likeEvents.trackedAccountId, likeEvents.postId],
        })
        .returning({ id: likeEvents.id });

      return inserted.length;
    } finally {
      await client.close();
    }
  }

  async function collectFollowsViaBotSession(
    trackedAccountId: string,
    igUsername: string,
    sessionData: string,
  ): Promise<number> {
    const bot = await getAcceptedBotForTrackedAccount(trackedAccountId);
    if (!bot) {
      console.warn(`[collectors:follows] no accepted bot for ${trackedAccountId}`);
      return 0;
    }

    if (!(await trackedAccountHasAccess(trackedAccountId))) return 0;
    // Use the accepted bot's current session and its canonical fixed proxy and
    // automation identity. Never fall back to another bot or direct transport.
    const runtime = await ensureBotReady(bot.id, { allowLogin: false });
    const identity = await resolveBotClientIdentity(bot, runtime);

    let client: IGClientPort;
    try {
      client = await openClient(deps.createClient, runtime.sessionData, identity);
    } catch (err) {
      console.error(`[collectors:follows] client initialization failed for bot ${bot.id}:`, err);
      if (err instanceof IGAuthExpiredError) {
        await markBotSessionExpired(bot.id, "stored session missing or expired during client initialization");
      }
      throw err;
    }

    try {
      const profile = await withBotErrorHandling(bot.id, bot.igUsername, () =>
        client.fetchProfile(igUsername),
      );
      if (!profile.pk) {
        console.error(`[collectors:follows] could not resolve pk for @${igUsername}`);
        return 0;
      }

      const capture = await fetchAllFollowing(
        client,
        profile.pk,
        bot.id,
        bot.igUsername,
        resolvePrivateFollowsMaxPages(),
      );
      const liveUsernames = new Set(
        capture.users.map((u) => u.username).filter(Boolean),
      );

      const result = await db.transaction(async (tx) => {
        const priorFollows = await tx
          .select({ followedUsername: followEvents.followedUsername })
          .from(followEvents)
          .where(eq(followEvents.trackedAccountId, trackedAccountId));
        const priorUsernames = new Set(priorFollows.map((r) => r.followedUsername));

        const priorUnfollows = await tx
          .select({ unfollowedUsername: unfollowEvents.unfollowedUsername })
          .from(unfollowEvents)
          .where(eq(unfollowEvents.trackedAccountId, trackedAccountId));
        const priorUnfollowedUsernames = new Set(
          priorUnfollows.map((r) => r.unfollowedUsername),
        );

        // Additions are always safe, even from a partial capture: seeing a
        // user in ANY page proves the follow exists.
        const newFollows = capture.users.filter(
          (u) =>
            u.username &&
            !priorUnfollowedUsernames.has(u.username) &&
            !priorUsernames.has(u.username),
        );

        // Prior-known followings not yet marked unfollowed — the baseline the
        // unfollow diff (and its sanity ratio) is measured against.
        const priorActive = Array.from(priorUsernames).filter(
          (name) => !priorUnfollowedUsernames.has(name),
        );

        // Audit B12: only diff `priorActive \ live` when the capture walked
        // every page (IG returned no next cursor) AND passes the 0.90 sanity
        // ratio. An incomplete/short capture must not fabricate unfollows.
        const gate = decideUnfollowGate(
          capture,
          liveUsernames.size,
          priorActive.length,
        );
        const unfollowedCandidates = gate.allow
          ? priorActive.filter((name) => !liveUsernames.has(name))
          : [];
        if (!gate.allow) {
          console.warn(
            `[collectors:follows] @${igUsername}: unfollow detection SKIPPED (${gate.reason}) — ${gate.detail}`,
          );
        }

        if (newFollows.length > 0) {
          await tx.insert(followEvents).values(
            newFollows.map((u) => ({
              trackedAccountId,
              followedUsername: u.username,
              followedDisplayName: u.fullName,
            })),
          );
        }

        if (unfollowedCandidates.length > 0) {
          await tx.insert(unfollowEvents).values(
            unfollowedCandidates.map((name) => ({
              trackedAccountId,
              unfollowedUsername: name,
            })),
          );
        }

        return {
          newFollowsCount: newFollows.length,
          unfollowedCount: unfollowedCandidates.length,
        };
      });

      console.log(
        `[collectors:follows] @${igUsername}: live=${capture.users.length}, pages=${capture.pagesFetched}, complete=${capture.complete}, new=${result.newFollowsCount}, unfollowed=${result.unfollowedCount}`,
      );
      return result.newFollowsCount + result.unfollowedCount;
    } finally {
      await client.close();
    }
  }

  async function sendFollowForRequest(
    botFollowRequestId: string,
    bot: BotAccount,
    trackedAccount: TrackedAccount,
    runtime: BotRuntimeContext,
  ): Promise<SendFollowOutcome> {
    const hasAccess = async () => {
      if (await trackedAccountHasAccess(trackedAccount.id)) return true;
      await markFollowRequestFailed(botFollowRequestId, "Tracking access ended");
      return false;
    };
    if (!(await hasAccess())) return { kind: "failed" };
    // Wave 3: resolve or lazily persist the bot's fingerprint so every
    // downstream HTTP call uses a stable device identity.
    const fingerprint = await ensureBotFingerprint(bot.id).catch((err) => {
      console.warn(
        `[collectors:bot-follow] fingerprint resolve failed for ${bot.igUsername}:`,
        err,
      );
      return resolveFingerprint(bot);
    });

    // Audit B1: a bot without a sticky residential proxy must never attempt
    // a follow — the old path silently fell back to a direct connection, so
    // decoration, profile reads, and the follow itself egressed from the
    // datacenter IP. Fail the request loudly (before burning daily budget);
    // re-assignment / ensureBotReady provisions a proxy for the next attempt.
    if (runtime.botId !== bot.id) throw new Error("Follow runtime does not match assigned bot");
    const proxyEndpoint = runtime.proxyEndpoint;
    if (!proxyEndpoint) {
      const msg = `bot @${bot.igUsername} has no proxy_endpoint — refusing to send follow traffic from the datacenter IP`;
      console.error(`[collectors:bot-follow] ${msg}`);
      await markFollowRequestFailed(botFollowRequestId, msg);
      return { kind: "failed" };
    }

    // Respect upstream Retry-After before spending budget or making any call.
    const cooldownUntil = bot.cooldownUntil ? new Date(bot.cooldownUntil).getTime() : 0;
    if (cooldownUntil > Date.now()) {
      return { kind: "deferred", reason: "cooldown", retryAfterMs: cooldownUntil - Date.now() };
    }

    // Wave 3: circadian guard. If the bot is "asleep", defer instead of
    // running. Requeue delay covers the remaining sleep time so we naturally
    // cluster activity into the bot's awake window.
    if (!isAwake({ ...fingerprint })) {
      const retryAfterMs = msUntilAwake({ ...fingerprint });
      console.log(
        `[collectors:bot-follow] bot @${bot.igUsername} asleep, deferring ${retryAfterMs}ms`,
      );
      return { kind: "deferred", reason: "asleep", retryAfterMs };
    }

    // Wave 3: warm-up ramp for freshly-logged-in bots. Day 0..2 → zero
    // follows allowed. effectiveFollowCap returns 0 for those, which we
    // translate into a big deferral (try tomorrow).
    if (effectiveFollowCap(bot) === 0 && isInWarmup(bot)) {
      const retryAfterMs = nextMidnightUtc().getTime() - Date.now();
      console.log(
        `[collectors:bot-follow] bot @${bot.igUsername} in warm-up, deferring until midnight`,
      );
      return { kind: "deferred", reason: "warmup", retryAfterMs };
    }

    // Wave 3: fleet-wide throttle. Even with per-bot caps, simultaneous
    // follows across 60 bots in the same minute is a detectable pattern.
    if (!reserveGlobalFollow()) {
      const retryAfterMs = 60_000;
      console.log(
        `[collectors:bot-follow] global follow throttle hit, deferring ${retryAfterMs}ms`,
      );
      return { kind: "deferred", reason: "global-throttle", retryAfterMs };
    }

    // Reserve one unit before any IG call. Private/unknown targets use the
    // stricter request cap; explicitly public targets use the follow cap.
    // Both actions increment the same counter once, and the locked reservation
    // enforces the bot's current age ramp and maxFollows override.
    try {
      await reserveDailyBudget(bot.id, trackedAccount.isPrivate === false ? "follows" : "privateRequests");
    } catch (err) {
      if (err instanceof IGDailyCapExceededError) {
        console.warn(
          `[collectors:bot-follow] bot @${bot.igUsername} hit daily cap, cooldown until ${err.resetAt.toISOString()}`,
        );
        await cooldownBot(bot.id, err.resetAt.getTime());
        return { kind: "deferred", reason: "asleep", retryAfterMs: err.resetAt.getTime() - Date.now() };
      }
      throw err;
    }

    if (!runtime.sessionData) {
      // Wave 4: bot rows can have NULL session_data (e.g. freshly seeded,
      // not yet logged in). The follow-request worker doesn't carry the
      // auto-login plumbing yet — defer back into the queue so a future
      // assignment lands on a logged-in bot or auto-relogin runs.
      console.warn(
        `[collectors:bot-follow] bot @${bot.igUsername} has no session_data; deferring`,
      );
      return {
        kind: "deferred",
        reason: "warmup",
        retryAfterMs: 60_000,
      };
    }

    let client: IGClientPort;
    try {
      // Audit B1: thread the full bot identity into the client so every IG
      // call (decoration, profile read, HTTP sendFollow) exits through the
      // bot's residential proxy wearing its persistent device fingerprint.
      client = await openClient(deps.createClient, runtime.sessionData, {
        botId: bot.id,
        botUsername: bot.igUsername,
        fingerprint,
        proxyEndpoint,
        automationIdentity: runtime.automationIdentity,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown session error";
      console.error(`[collectors:bot-follow] bot ${bot.igUsername} client initialization failed:`, msg);
      if (err instanceof IGAuthExpiredError) {
        await markBotSessionExpired(bot.id, "stored session missing or expired during client initialization");
        await markFollowRequestFailed(botFollowRequestId, "bot session missing or expired");
        return { kind: "failed" };
      }
      // Preserve the queued request and bot state on local setup/transport
      // faults. The worker owns bounded retries; no follow has been sent.
      throw err;
    }

    try {
      if (!(await hasAccess())) return { kind: "failed" };
      // Profile collection already resolved this account's stable numeric ID.
      // Read the actual relationship directly, avoiding unrelated warmup reads
      // and an unnecessary dependency on the web profile-info endpoint.
      const targetPk = trackedAccount.igUserId;
      let profile: { pk: string; followedByViewer?: boolean; requestedByViewer?: boolean; isPrivate: boolean };
      if (targetPk && /^\d+$/.test(targetPk) && client.fetchFriendshipStatus) {
        const friendship = await client.fetchFriendshipStatus(targetPk);
        profile = {
          pk: targetPk,
          followedByViewer: friendship.following,
          requestedByViewer: friendship.outgoingRequest,
          isPrivate: friendship.isPrivate,
        };
      } else {
        profile = await client.fetchProfile(trackedAccount.igUsername);
      }
      if (!(await hasAccess())) return { kind: "failed" };
      if (!profile.pk) {
        throw new Error(`could not resolve pk for @${trackedAccount.igUsername}`);
      }

      // Already follows / already requested: do not re-send.
      if (profile.followedByViewer || profile.requestedByViewer) {
        console.log(
          `[collectors:bot-follow] bot @${bot.igUsername} already follows/requested @${trackedAccount.igUsername}`,
        );
        await markFollowRequestSent(botFollowRequestId);
        if (profile.followedByViewer && !profile.requestedByViewer) {
          await markFollowRequestAccepted(botFollowRequestId, trackedAccount.userId);
          return { kind: "accepted" };
        }
        return { kind: "pending" };
      }

      // Wave 3: pause between "reading" the profile and clicking follow.
      await humanDelay(3_000, 30_000, 8_000, 6_000);

      if (!(await hasAccess())) return { kind: "failed" };

      // Migrated bots follow inside their existing Firefox identity. The raw
      // HTTP follow endpoint can redirect to HTML despite working read APIs.
      // Never repeat a possibly completed browser click through HTTP.
      const transport = process.env.FOLLOW_TRANSPORT ?? "playwright";
      let status: Awaited<ReturnType<typeof client.sendFollow>> | null = null;

      if (runtime.automationIdentity) {
        status = await sendBrowserFollow(runtime, trackedAccount.igUsername, profile.pk);
      } else if (transport === "playwright") {
        // sessionData null-guard at top of function (Wave 4) means we
        // never reach here without a string; TS can't narrow across an
        // async boundary so we re-assert.
        const sessionDataValue = runtime.sessionData;
        const pwResult = await playwrightSendFollowByUsername({
          sessionData: decryptSessionData(sessionDataValue),
          fingerprint,
          botUsername: bot.igUsername,
          // Use the same resolved proxy as the authenticated client.
          proxyUrl: proxyAgentUriForEndpoint(proxyEndpoint),
          targetUsername: trackedAccount.igUsername,
          canFollow: hasAccess,
        });
        if (pwResult) {
          status = {
            following: pwResult.following,
            outgoingRequest: pwResult.requested,
            incomingRequest: false,
            followedBy: false,
            isPrivate: profile.isPrivate,
          };
        }
      }

      if (!status && (runtime.automationIdentity || transport === "playwright")) {
        throw new Error("Browser follow returned no confirmed relationship; refusing another write");
      }
      if (!status) {
        if (!(await hasAccess())) return { kind: "failed" };
        status = await client.sendFollow(profile.pk);
      }

      console.log(
        `[collectors:bot-follow] sendFollow @${bot.igUsername} -> @${trackedAccount.igUsername}: following=${status.following}, outgoingRequest=${status.outgoingRequest}`,
      );

      const accepted = status.following && !status.outgoingRequest;
      const pending = status.outgoingRequest;
      if (!accepted && !pending) {
        throw new Error(`unexpected friendship_status: ${JSON.stringify(status)}`);
      }

      if (!(await hasAccess())) return { kind: "failed" };
      await markFollowRequestSent(botFollowRequestId);
      if (accepted) {
        await markFollowRequestAccepted(botFollowRequestId, trackedAccount.userId);
        return { kind: "accepted" };
      }
      return { kind: "pending" };
    } catch (err) {
      if (err instanceof IGAuthExpiredError) {
        if (err.status === 401 && isIgWebThrottleBody(err.body ?? "")) {
          await cooldownBot(bot.id, Date.now() + WEB_THROTTLE_COOLDOWN_MS);
          return { kind: "deferred", reason: "cooldown", retryAfterMs: WEB_THROTTLE_COOLDOWN_MS };
        }
        console.warn(
          `[collectors:bot-follow] bot @${bot.igUsername} auth expired — admin must re-auth`,
        );
        await markBotSessionExpired(bot.id, "auth expired");
        await markFollowRequestFailed(botFollowRequestId, "bot auth expired");
        return { kind: "failed" };
      }
      if (err instanceof IGRateLimitedError) {
        console.warn(
          `[collectors:bot-follow] bot @${bot.igUsername} rate limited, cooldown ${err.retryAfterMs}ms`,
        );
        await cooldownBotForRateLimit(bot.id, err.retryAfterMs);
        throw err; // let BullMQ retry after its own backoff
      }
      throw err;
    } finally {
      await client.close();
    }
  }

  return {
    collectLikesViaBotSession,
    collectFollowsViaBotSession,
    sendFollowForRequest,
  };
}
