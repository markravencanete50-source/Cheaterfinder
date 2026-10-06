import { customerAccessSql, trackedAccountHasAccess } from "./services/subscription-access.js";
import { db } from "./db.js";
import {
  botAccounts,
  botFollowRequests,
  trackedAccounts,
  notifications,
} from "../shared/schema.js";
import { eq, ne, and, or, lt, sql, isNull, isNotNull, asc, inArray, not, desc } from "drizzle-orm";
import {
  transitionFollowRequest,
  revokeAcceptedFollowRequest,
  type FollowRequestStatus,
} from "./domain/follow-request-state.js";
import {
  decryptSessionData,
  ensureEncrypted,
  isEncryptedEnvelope,
} from "./crypto/session-envelope.js";
import { logger as baseLogger } from "./observability/logger.js";
import {
  resolveFingerprint,
  type DeviceFingerprint,
} from "./behavior/device-fingerprint.js";
import { createNotification } from "./services/notifications.js";
import { parseAutomationIdentity } from "./services/automation-identity.js";
import { KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX } from "./services/proxy-durability.js";
import { BAN_REASON_SQL_REGEX, COOLDOWN_REASON_PREFIX } from "./services/bot-cooldown.js";

const logger = baseLogger.child({ module: "bot-manager" });

// Health filter for follow-request bot selection — mirrors leaseBot's exclusion
// in ig-public-scraper.ts. A follow can only be sent from a bot with a genuinely
// USABLE session: `session_data IS NOT NULL` alone is not enough (a stale/expired
// blob still fails at send time, and if the bot is an email-login account IG
// rejects, its auto-login refresh can't recover — exactly how @tracked_user_7's
// requests kept dying on session_expired bots). We also skip bots whose
// last_login_error marks a terminal auth failure, so the picker never re-selects
// a known-dead account. Kept in one place so assign + rotate stay in lockstep.
function healthyFollowBotConditions() {
  return [
    // Follow requests use the authenticated browser. Mobile readers cannot
    // take a browser follow job just because a historical identity remains.
    eq(botAccounts.transport, "web"),
    eq(botAccounts.role, "scraper"),
    isNotNull(botAccounts.sessionData),
    isNotNull(botAccounts.automationIdentity),
    sql`length(trim(${botAccounts.sessionData})) > 0`,
    sql`${botAccounts.automationIdentity}->>'bot_id' = ${botAccounts.id}`,
    sql`(
      (
        ${botAccounts.proxyUrl} IS NOT NULL
        AND ${botAccounts.proxyUrl} !~* ${KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX}
      )
      OR (
        ${botAccounts.proxyUrl} IS NULL
        AND ${botAccounts.proxyEndpoint} IS NOT NULL
        AND ${botAccounts.proxyExpiresAt} > NOW() + INTERVAL '2 minutes'
      )
    )`,
    sql`(COALESCE(${botAccounts.lastLoginError}, '') LIKE ${COOLDOWN_REASON_PREFIX + "%"}
      OR COALESCE(${botAccounts.lastLoginError}, '') !~* ${BAN_REASON_SQL_REGEX})`,
  ];
}

// ─── Bot Pool Manager ────────────────────────────────────────────────────────
//
// Manages the pool of Instagram bot accounts used to send follow requests
// to private tracked accounts. Handles bot assignment, rotation, release,
// and follow-request lifecycle transitions.
//
// Concurrency: assignBot / rotateBot / releaseBot run inside a single
// transaction, pick the bot row with FOR UPDATE SKIP LOCKED, and increment
// currentFollows / flip status in the same txn — so two concurrent workers
// cannot pick the same bot or race the counter.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assign an available bot to a tracked account by creating a queued follow request.
 * Picks the least-loaded bot that is not in cooldown.
 * Returns the new botFollowRequest ID, or null if no bots are available.
 */
export async function assignBotToTrackedAccount(
  trackedAccountId: string,
  options: { backup?: boolean } = {},
): Promise<string | null> {
  logger.info({ trackedAccountId }, "assigning bot");
  if (!(await trackedAccountHasAccess(trackedAccountId))) return null;

  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      // Serialize primary, backup and rotation decisions for this target,
      // without reversing the bot -> target row-lock order used by failures.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'private-follow:' + trackedAccountId}, 0))`);

      const [account] = await tx.select({ id: trackedAccounts.id }).from(trackedAccounts)
        .where(and(eq(trackedAccounts.id, trackedAccountId), eq(trackedAccounts.isPrivate, true),
          eq(trackedAccounts.isActive, true), customerAccessSql(trackedAccounts.userId))).limit(1);
      if (!account) return null;

      // Fix #2/#9: guard — check if tracked account already has a non-terminal follow request
      const existingRequests = await tx
        .select({ id: botFollowRequests.id, botAccountId: botFollowRequests.botAccountId, status: botFollowRequests.status })
        .from(botFollowRequests)
        .where(
          and(
            eq(botFollowRequests.trackedAccountId, trackedAccountId),
            inArray(botFollowRequests.status, ["queued", "pending", "accepted"]),
          ),
        )
        .orderBy(asc(botFollowRequests.queuedAt), asc(botFollowRequests.id))
        .limit(2);
      const existingRequest = existingRequests[0];

      if (existingRequest && !options.backup) {
        logger.info(
          { trackedAccountId, botFollowRequestId: existingRequest.id },
          "tracked account already has active follow request, skipping",
        );
        return null;
      }
      if (options.backup) {
        // The primary must have actually reached Instagram first. A queued
        // backup is returned again to recover an interrupted Redis enqueue.
        if (!existingRequests.some(r => r.status === 'pending' || r.status === 'accepted')) return null;
        if (existingRequests.length >= 2) return existingRequests.find(r => r.status === 'queued')?.id ?? null;
      }
      // The primary fallback can run after rotation finds no unused viewer.
      // Reusing a terminal request's bot violates the unique bot/target key
      // and can otherwise repeat a previously stopped follow attempt.
      const priorRequests = await tx.select({ botAccountId: botFollowRequests.botAccountId, status: botFollowRequests.status })
        .from(botFollowRequests).where(eq(botFollowRequests.trackedAccountId, trackedAccountId));
      if (options.backup && priorRequests.filter(r => ['failed','expired','rejected'].includes(r.status)).length >= 3) return null;
      const excludedBotIds = [...new Set(priorRequests.map(r => r.botAccountId))];

      // Find the best available bot: available, under capacity, not in cooldown.
      // Fix #2: FOR UPDATE SKIP LOCKED ensures two concurrent txns never pick the
      // same row. Drizzle passes through raw SQL via `.for()`.
      //
      // Wave 6 — tier preference: prefer tier='worker', fall back to 'canary'
      // only when no workers are available. NEVER pick 'reserve' or
      // 'retired' so risky operations can't accidentally hit cold or dead
      // bots. We run two scoped picks so the SKIP LOCKED ordering still
      // works per-tier (one combined ORDER BY would let a locked worker
      // silently demote us to a canary).
      const pickByTier = (tier: "worker" | "canary") =>
        tx
          .select()
          .from(botAccounts)
          .where(
            and(
              eq(botAccounts.tier, tier),
              eq(botAccounts.status, "available"),
              // Only bots with a usable session + no terminal auth error (see
              // healthyFollowBotConditions). Without this the picker handed
              // follow requests to session-less or session_expired bots that
              // could never send.
              ...healthyFollowBotConditions(),
              ...(excludedBotIds.length ? [not(inArray(botAccounts.id, excludedBotIds))] : []),
              sql`${botAccounts.currentFollows} < ${botAccounts.maxFollows}`,
              or(
                isNull(botAccounts.cooldownUntil),
                lt(botAccounts.cooldownUntil, now),
              ),
            ),
          )
          .orderBy(asc(botAccounts.currentFollows), asc(botAccounts.lastUsedAt))
          .limit(1)
          .for("update", { skipLocked: true });

      let [bot] = await pickByTier("worker");
      if (!bot) {
        [bot] = await pickByTier("canary");
        if (bot) {
          logger.info(
            { trackedAccountId, botId: bot.id },
            "no workers available, falling back to canary",
          );
        }
      }

      if (!bot) {
        logger.info({ trackedAccountId }, "no available bots");
        return null;
      }

      logger.info(
        { trackedAccountId, botId: bot.id, botUsername: bot.igUsername },
        "selected bot",
      );

      const [followRequest] = await tx
        .insert(botFollowRequests)
        .values({
          botAccountId: bot.id,
          trackedAccountId,
          status: "queued",
          queuedAt: now,
        })
        .returning({ id: botFollowRequests.id });

      // Atomic increment of currentFollows inside the same txn.
      // Compute next status in JS so Drizzle emits a properly-cast enum
      // literal — inline `CASE WHEN ... 'in_use' ... 'available' END` SQL
      // returns text and Postgres rejects assignment to bot_status without
      // an explicit ::bot_status cast.
      const nextCurrentFollows = bot.currentFollows + 1;
      const nextStatus: "in_use" | "available" =
        nextCurrentFollows >= bot.maxFollows ? "in_use" : "available";
      await tx
        .update(botAccounts)
        .set({
          currentFollows: nextCurrentFollows,
          lastUsedAt: now,
          status: nextStatus,
          updatedAt: now,
        })
        .where(eq(botAccounts.id, bot.id));

      await tx
        .update(trackedAccounts)
        .set({
          accessStatus: "pending_access",
          updatedAt: now,
        })
        .where(and(eq(trackedAccounts.id, trackedAccountId), ne(trackedAccounts.accessStatus, 'has_access')));

      logger.info(
        {
          botFollowRequestId: followRequest.id,
          botUsername: bot.igUsername,
          trackedAccountId,
        },
        "created follow request",
      );

      return followRequest.id;
    });
  } catch (err) {
    logger.error({ trackedAccountId, err }, "error assigning bot");
    throw err;
  }
}

/**
 * Release a bot from a tracked account by decrementing its follow count.
 * If the bot was marked 'in_use' and now has capacity, set it back to 'available'.
 *
 * Wrapped in a transaction so the read-modify-write on currentFollows + status
 * is atomic — two concurrent release calls cannot over-decrement.
 */
export async function releaseBotFromTrackedAccount(
  botFollowRequestId: string,
): Promise<void> {
  logger.info({ botFollowRequestId }, "releasing bot");

  try {
    await db.transaction(async (tx) => {
      const [followRequest] = await tx
        .select()
        .from(botFollowRequests)
        .where(eq(botFollowRequests.id, botFollowRequestId))
        .limit(1)
        .for("update");

      if (!followRequest) {
        logger.info(
          { botFollowRequestId },
          "follow request not found, skipping release",
        );
        return;
      }

      // Idempotency: if already in terminal state, the bot was already released.
      if (["expired", "failed", "rejected"].includes(followRequest.status)) {
        logger.info(
          { botFollowRequestId, status: followRequest.status },
          "follow request in terminal state, skipping release",
        );
        return;
      }

      const botId = followRequest.botAccountId;

      // Lock the bot row, read current state, decrement, flip status if needed —
      // all inside the same transaction.
      const [bot] = await tx
        .select()
        .from(botAccounts)
        .where(eq(botAccounts.id, botId))
        .limit(1)
        .for("update");

      if (!bot) {
        logger.info({ botId }, "bot not found, skipping release");
        return;
      }

      const nextCurrent = Math.max(0, bot.currentFollows - 1);
      const nextStatus =
        bot.status === "in_use" && nextCurrent < bot.maxFollows
          ? "available"
          : bot.status;

      await tx
        .update(botAccounts)
        .set({
          currentFollows: nextCurrent,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(eq(botAccounts.id, botId));

      if (bot.status === "in_use" && nextStatus === "available") {
        logger.info({ botUsername: bot.igUsername }, "bot set back to available");
      }

      logger.info({ botId, botFollowRequestId }, "released bot");
    });
  } catch (err) {
    logger.error({ botFollowRequestId, err }, "error releasing bot");
    throw err;
  }
}

/**
 * Rotate to a different bot for a tracked account.
 * Excludes bots that have already attempted this account (rejected/expired/failed).
 * If no bots are available after >= 3 failures and no live request remains,
 * marks eligible pending access as denied and notifies the user.
 * Returns the new botFollowRequest ID, or null if no bots available.
 */
export async function rotateBotForTrackedAccount(
  trackedAccountId: string,
  options: { onlyIfNoActive?: boolean } = {},
): Promise<string | null> {
  logger.info({ trackedAccountId }, "rotating bot");
  if (!(await trackedAccountHasAccess(trackedAccountId))) return null;

  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'private-follow:' + trackedAccountId}, 0))`);
      const [account] = await tx.select({ id: trackedAccounts.id }).from(trackedAccounts)
        .where(and(eq(trackedAccounts.id, trackedAccountId), eq(trackedAccounts.isPrivate, true),
          eq(trackedAccounts.isActive, true), customerAccessSql(trackedAccounts.userId))).limit(1);
      if (!account) return null;
      const active = await tx.select({ id: botFollowRequests.id }).from(botFollowRequests)
        .where(and(eq(botFollowRequests.trackedAccountId, trackedAccountId),
          inArray(botFollowRequests.status, ['queued','pending','accepted']))).limit(2);
      // Replacement callers only need one surviving viewer. Check under the
      // same target lock so concurrent cleanup retries cannot add another.
      if (options.onlyIfNoActive && active.length > 0) return null;
      if (active.length >= 2) return null;

      // Exclude ALL bots that have ANY existing row for this tracked account.
      const allAttempts = await tx
        .select({ botAccountId: botFollowRequests.botAccountId })
        .from(botFollowRequests)
        .where(eq(botFollowRequests.trackedAccountId, trackedAccountId));

      const excludedBotIds = Array.from(
        new Set(allAttempts.map((r) => r.botAccountId)),
      );

      // Wave 6 — same tier preference as assignBotToTrackedAccount: try
      // workers first, fall back to canary, never pick reserve/retired.
      const baseConditions = (tier: "worker" | "canary") => {
        const conds = [
          eq(botAccounts.tier, tier),
          eq(botAccounts.status, "available"),
          // Same usable-session + auth-health filter as the assign picker.
          ...healthyFollowBotConditions(),
          sql`${botAccounts.currentFollows} < ${botAccounts.maxFollows}`,
          or(
            isNull(botAccounts.cooldownUntil),
            lt(botAccounts.cooldownUntil, now),
          ),
        ];
        if (excludedBotIds.length > 0) {
          conds.push(not(inArray(botAccounts.id, excludedBotIds)));
        }
        return conds;
      };

      const pickByTier = (tier: "worker" | "canary") =>
        tx
          .select()
          .from(botAccounts)
          .where(and(...baseConditions(tier)))
          .orderBy(asc(botAccounts.currentFollows), asc(botAccounts.lastUsedAt))
          .limit(1)
          .for("update", { skipLocked: true });

      let [bot] = await pickByTier("worker");
      if (!bot) {
        [bot] = await pickByTier("canary");
        if (bot) {
          logger.info(
            { trackedAccountId, botId: bot.id },
            "rotation: no workers available, falling back to canary",
          );
        }
      }

      if (bot) {
        logger.info(
          { trackedAccountId, botId: bot.id, botUsername: bot.igUsername },
          "rotating to bot",
        );

        const [followRequest] = await tx
          .insert(botFollowRequests)
          .values({
            botAccountId: bot.id,
            trackedAccountId,
            status: "queued",
            queuedAt: now,
          })
          .returning({ id: botFollowRequests.id });

        // Compute status in JS — see assignBotToTrackedAccount for the cast rationale.
        const nextCurrentFollows = bot.currentFollows + 1;
        const nextStatus: "in_use" | "available" =
          nextCurrentFollows >= bot.maxFollows ? "in_use" : "available";
        await tx
          .update(botAccounts)
          .set({
            currentFollows: nextCurrentFollows,
            lastUsedAt: now,
            status: nextStatus,
            updatedAt: now,
          })
          .where(eq(botAccounts.id, bot.id));

        // Serialize with a concurrent terminal failure's target update. The
        // replacement request is now queued, so a failed older attempt must
        // not leave the customer seeing Retry Access while this one proceeds.
        // Acceptance wins if another request has already established access.
        await tx.update(trackedAccounts).set({
          accessStatus: "pending_access",
          updatedAt: now,
        }).where(and(
          eq(trackedAccounts.id, trackedAccountId),
          eq(trackedAccounts.isPrivate, true),
          eq(trackedAccounts.isActive, true),
          inArray(trackedAccounts.accessStatus, ["public", "pending_access", "access_denied"]),
          customerAccessSql(trackedAccounts.userId),
        ));

        logger.info(
          { botFollowRequestId: followRequest.id },
          "created rotated follow request",
        );

        return followRequest.id;
      }

      // No bot available — check if we should give up
      const totalAttempts = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(botFollowRequests)
        .where(
          and(
            eq(botFollowRequests.trackedAccountId, trackedAccountId),
            inArray(botFollowRequests.status, ["rejected", "expired", "failed"]),
          ),
        );

      const attemptCount = totalAttempts[0]?.count ?? 0;

      if (attemptCount >= 3) {
        // Serialize with assignment/rotation and terminal failure before
        // checking surviving requests. NO KEY UPDATE allows request inserts'
        // foreign-key checks; successful access always wins.
        await tx.select({ id: trackedAccounts.id }).from(trackedAccounts)
          .where(eq(trackedAccounts.id, trackedAccountId)).for("no key update");
        const [account] = await tx
          .update(trackedAccounts)
          .set({
            accessStatus: "access_denied",
            updatedAt: now,
          })
          .where(and(
            eq(trackedAccounts.id, trackedAccountId),
            eq(trackedAccounts.isPrivate, true),
            eq(trackedAccounts.isActive, true),
            eq(trackedAccounts.accessStatus, "pending_access"),
            customerAccessSql(trackedAccounts.userId),
            sql`NOT EXISTS (SELECT 1 FROM bot_follow_requests other
              WHERE other.tracked_account_id = ${trackedAccounts.id}
                AND other.status IN ('queued', 'pending', 'accepted'))`,
          ))
          .returning({
            userId: trackedAccounts.userId,
            igUsername: trackedAccounts.igUsername,
          });

        if (account) {
          await tx.insert(notifications).values({
            userId: account.userId,
            type: "access_pending",
            title: "Access Denied",
            body: `We were unable to gain access to the private account @${account.igUsername} after multiple attempts. Please try again later or remove this account.`,
          });

          logger.info(
            { userId: account.userId, igUsername: account.igUsername },
            "notified user about access_denied",
          );
        }
      } else {
        logger.info(
          { trackedAccountId, attemptCount },
          "no available bots for rotation",
        );
      }

      return null;
    });
  } catch (err) {
    logger.error({ trackedAccountId, err }, "error rotating bot");
    throw err;
  }
}

/**
 * Get the session data of an accepted bot for a tracked account.
 * Returns the encrypted-or-plaintext envelope AS STORED; callers decrypt
 * via decryptSessionData() in crypto/session-envelope.ts. Lazily re-encrypts
 * legacy plaintext rows as a one-time migration on read (Wave 2 task E).
 */
export async function getAcceptedBotSession(
  trackedAccountId: string,
): Promise<string | null> {
  logger.debug({ trackedAccountId }, "looking up accepted bot session");

  try {
    const [result] = await db
      .select({
        botId: botAccounts.id,
        sessionData: botAccounts.sessionData,
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

    if (!result) {
      logger.info({ trackedAccountId }, "no accepted bot session found");
      return null;
    }

    // Wave 4: session_data may be NULL on a freshly-seeded bot that hasn't
    // been auto-logged-in yet. Caller decides what to do (typically defer
    // until ensureBotReady runs).
    if (!result.sessionData) {
      logger.info(
        { trackedAccountId, botId: result.botId },
        "bot session not yet established — caller should run ensureBotReady",
      );
      return null;
    }
    const sessionData: string = result.sessionData;

    // Lazy encrypt-at-rest: if the stored envelope is legacy plaintext,
    // fire a background UPDATE to replace it with a v1 envelope.
    if (!isEncryptedEnvelope(sessionData)) {
      void (async () => {
        try {
          const encrypted = ensureEncrypted(sessionData);
          await db
            .update(botAccounts)
            .set({ sessionData: encrypted, updatedAt: new Date() })
            .where(eq(botAccounts.id, result.botId));
          logger.info({ botId: result.botId }, "lazy-encrypted session_data");
        } catch (err) {
          logger.error({ botId: result.botId, err }, "lazy-encrypt failed");
        }
      })();
    }

    logger.debug({ trackedAccountId }, "found accepted bot session");

    return sessionData;
  } catch (err) {
    logger.error({ trackedAccountId, err }, "error looking up bot session");
    throw err;
  }
}

// Re-export for callers that need transparent decryption.
export { decryptSessionData };

/**
 * Mark a follow request as sent (pending), with an expiration of 7 days.
 * Uses the state machine: queued -> pending.
 */
export async function markFollowRequestSent(
  botFollowRequestId: string,
): Promise<void> {
  logger.info({ botFollowRequestId }, "marking follow request as sent");

  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const result = await transitionFollowRequest(
      db,
      botFollowRequestId,
      "queued",
      "pending",
      { sentAt: now, expiresAt },
    );

    if (!result.changed) {
      logger.info(
        { botFollowRequestId },
        "follow request already advanced past queued (idempotent no-op)",
      );
      return;
    }

    logger.info(
      { botFollowRequestId, expiresAt: expiresAt.toISOString() },
      "follow request marked as pending",
    );
  } catch (err) {
    logger.error({ botFollowRequestId, err }, "error marking follow request as sent");
    throw err;
  }
}

/**
 * Mark a follow request as accepted. Updates the tracked account to has_access
 * and sends a notification to the user. Valid sources: queued | pending.
 */
export async function markFollowRequestAccepted(
  botFollowRequestId: string,
  trackedAccountUserId: string,
): Promise<void> {
  logger.info({ botFollowRequestId }, "marking follow request as accepted");

  try {
    const now = new Date();

    const [followRequest] = await db
      .select({
        trackedAccountId: botFollowRequests.trackedAccountId,
      })
      .from(botFollowRequests)
      .where(eq(botFollowRequests.id, botFollowRequestId))
      .limit(1);

    if (!followRequest) {
      logger.info(
        { botFollowRequestId },
        "follow request not found before accepted transition",
      );
      return;
    }

    const grant = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'private-follow:' + followRequest.trackedAccountId}, 0))`);
      const [request] = await tx.select().from(botFollowRequests)
        .where(eq(botFollowRequests.id, botFollowRequestId)).limit(1).for("update");
      if (!request || !["queued", "pending", "accepted"].includes(request.status)) return null;
      // Request -> target matches the completion/revocation lock order. The
      // request and customer-visible grant must commit together: a crash
      // between them previously left an accepted request permanently pending.
      const [account] = await tx.select({
        id: trackedAccounts.id, userId: trackedAccounts.userId,
        isActive: trackedAccounts.isActive, isPrivate: trackedAccounts.isPrivate,
        accessStatus: trackedAccounts.accessStatus,
        // Keep the outer reference qualified in a SELECT expression; Drizzle
        // otherwise strips the column's table and correlates to entitlement.
        entitled: customerAccessSql(sql`tracked_accounts.user_id`),
      }).from(trackedAccounts).where(eq(trackedAccounts.id, request.trackedAccountId))
        .limit(1).for("no key update");
      if (!account || account.userId !== trackedAccountUserId) return null;
      if (!account.isActive || !account.entitled) return { ineligible: true, notify: false };
      if (!account.isPrivate) return null;

      if (request.status !== "accepted") {
        const result = await transitionFollowRequest(tx, request.id, request.status, "accepted", { resolvedAt: now });
        if (!result.changed) return null;
      }
      // Repair a prior interrupted grant as well as processing fresh approval.
      // An accepted backup never duplicates the first access notification.
      if (account.accessStatus === "has_access") return { ineligible: false, notify: false };
      await tx.update(trackedAccounts).set({ accessStatus: "has_access", updatedAt: now })
        .where(eq(trackedAccounts.id, account.id));
      await tx.insert(notifications).values({
        userId: account.userId, type: "access_granted", title: "Access Granted",
        body: "Access to the private account you're tracking is approved. Data will appear after collection succeeds.",
      });
      return { ineligible: false, notify: true };
    });
    if (!grant) return;
    if (grant.ineligible) {
      await markFollowRequestFailed(botFollowRequestId, "Tracking access ended");
      return;
    }
    if (grant.notify) {
      await createNotification({
        userId: trackedAccountUserId,
        type: "access_granted",
        title: "Access Granted",
        body: "Access to the private account you're tracking is approved. Data will appear after collection succeeds.",
        skipInsert: true,
      });
    }

    logger.info(
      { botFollowRequestId, trackedAccountId: followRequest.trackedAccountId },
      "follow request accepted, tracked account now has_access",
    );
  } catch (err) {
    logger.error({ botFollowRequestId, err }, "error marking follow request as accepted");
    throw err;
  }
}

/**
 * Mark a follow request as failed with an error message, then release the bot.
 * Uses the state machine — valid sources queued | pending.
 */
export async function markFollowRequestFailed(
  botFollowRequestId: string,
  error: string,
): Promise<void> {
  await finishFollowRequest(botFollowRequestId, "failed", error);
  logger.info({ botFollowRequestId }, "follow request failure reconciled");
}

/** Revoke only a provider-confirmed lost relationship for this exact viewer.
 * A generic read error never calls this path. Row locks and the accepted-state
 * compare-and-swap release capacity once even when two collectors observe it.
 */
export async function revokeAcceptedBotAccess(trackedAccountId: string, botAccountId: string): Promise<boolean> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'private-follow:' + trackedAccountId}, 0))`);
    const [request] = await tx.select().from(botFollowRequests).where(and(
      eq(botFollowRequests.trackedAccountId, trackedAccountId),
      eq(botFollowRequests.botAccountId, botAccountId),
      eq(botFollowRequests.status, 'accepted'),
    )).limit(1).for('update');
    if (!request) return false;
    const [bot] = await tx.select().from(botAccounts).where(eq(botAccounts.id, botAccountId)).limit(1).for('update');
    await tx.select({ id: trackedAccounts.id }).from(trackedAccounts)
      .where(eq(trackedAccounts.id, trackedAccountId)).for('no key update');
    if (!(await revokeAcceptedFollowRequest(tx, request.id)).changed) return false;
    if (bot) {
      const currentFollows = Math.max(0, bot.currentFollows - 1);
      await tx.update(botAccounts).set({ currentFollows,
        status: bot.status === 'in_use' && currentFollows < bot.maxFollows ? 'available' : bot.status,
        updatedAt: new Date(),
      }).where(eq(botAccounts.id, bot.id));
    }
    const surviving = await tx.select({ status: botFollowRequests.status }).from(botFollowRequests).where(and(
      eq(botFollowRequests.trackedAccountId, trackedAccountId),
      inArray(botFollowRequests.status, ['queued', 'pending', 'accepted']),
    ));
    if (!surviving.some(row => row.status === 'accepted')) {
      await tx.update(trackedAccounts).set({
        accessStatus: surviving.length ? 'pending_access' : 'access_denied', updatedAt: new Date(),
      }).where(and(eq(trackedAccounts.id, trackedAccountId), eq(trackedAccounts.isPrivate, true),
        eq(trackedAccounts.accessStatus, 'has_access')));
    }
    return true;
  });
}

async function finishFollowRequest(
  botFollowRequestId: string,
  status: "failed" | "expired",
  error?: string,
): Promise<boolean> {
  // Transition and capacity release share one lock/transaction. Concurrent
  // cancellation, expiry and a worker failure must not release capacity twice.
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(botFollowRequests)
      .where(eq(botFollowRequests.id, botFollowRequestId)).limit(1).for("update");
    if (!request || !["queued", "pending"].includes(request.status)) return false;
    if (status === "expired" && request.status !== "pending") return false;
    const [bot] = await tx.select().from(botAccounts)
      .where(eq(botAccounts.id, request.botAccountId)).limit(1).for("update");
    if (status === "failed") {
      // Serialize failures for the same target before checking other requests.
      // Otherwise two failing bots can each see the other's pending request
      // and leave the customer waiting after both attempts have stopped.
      // NO KEY UPDATE permits concurrent request inserts' foreign-key checks.
      await tx.select({ id: trackedAccounts.id }).from(trackedAccounts)
        .where(eq(trackedAccounts.id, request.trackedAccountId)).for("no key update");
    }
    await transitionFollowRequest(tx, request.id, request.status, status, {
      ...(error ? { error } : {}), resolvedAt: new Date(),
    });
    if (bot) {
      const currentFollows = Math.max(0, bot.currentFollows - 1);
      await tx.update(botAccounts).set({
        currentFollows,
        status: bot.status === "in_use" && currentFollows < bot.maxFollows ? "available" : bot.status,
        updatedAt: new Date(),
      }).where(eq(botAccounts.id, bot.id));
    }
    if (status === "failed") {
      // A stopped attempt must offer the existing Retry Access action instead
      // of implying that a request is still awaiting the owner's approval.
      // Preserve successful access and any other live/accepted request. Expiry
      // keeps its separate rotation flow, and canceled/inactive customers do
      // not acquire a new private-access action from this reconciliation.
      await tx.update(trackedAccounts).set({
        accessStatus: "access_denied",
        updatedAt: new Date(),
      }).where(and(
        eq(trackedAccounts.id, request.trackedAccountId),
        eq(trackedAccounts.isPrivate, true),
        eq(trackedAccounts.isActive, true),
        eq(trackedAccounts.accessStatus, "pending_access"),
        customerAccessSql(trackedAccounts.userId),
        sql`NOT EXISTS (SELECT 1 FROM bot_follow_requests other
          WHERE other.tracked_account_id = ${trackedAccounts.id}
            AND other.status IN ('queued', 'pending', 'accepted'))`,
      ));
    }
    return true;
  });
}

/**
 * Mark a follow request as expired — used by bot-follow-check when the
 * 7-day TTL elapses. Valid source: pending.
 */
export async function markFollowRequestExpired(
  botFollowRequestId: string,
): Promise<boolean> {
  return finishFollowRequest(botFollowRequestId, "expired");
}

/**
 * Get all follow requests that are pending and have expired (expiresAt < now).
 */
export async function getExpiredFollowRequests(): Promise<
  Array<{ id: string; trackedAccountId: string }>
> {
  logger.debug("querying expired follow requests");

  try {
    const now = new Date();

    const expired = await db
      .select({
        id: botFollowRequests.id,
        trackedAccountId: botFollowRequests.trackedAccountId,
      })
      .from(botFollowRequests)
      .innerJoin(trackedAccounts, eq(botFollowRequests.trackedAccountId, trackedAccounts.id))
      .where(
        and(
          eq(botFollowRequests.status, "pending"),
          lt(botFollowRequests.expiresAt, now),
          eq(trackedAccounts.isActive, true),
          customerAccessSql(trackedAccounts.userId),
        ),
      );

    logger.info({ count: expired.length }, "found expired follow requests");

    return expired;
  } catch (err) {
    logger.error({ err }, "error querying expired follow requests");
    throw err;
  }
}

/**
 * Get all currently pending follow requests (for polling acceptance status),
 * enriched with bot and tracked account details so workers don't need N+1 queries.
 */
export interface PendingFollowRequestRow {
  id: string;
  botAccountId: string;
  // Wave 4: nullable when the bot was just seeded and hasn't auto-logged in
  // yet. Workers must check before passing to IG client.
  botSessionData: string | null;
  botUsername: string;
  trackedAccountId: string;
  trackedUsername: string;
  trackedUserId: string;
}

export async function getPendingFollowRequests(): Promise<
  PendingFollowRequestRow[]
> {
  logger.debug("querying pending follow requests");

  try {
    // Fix #9: innerJoin bot + tracked account so the worker loop is one query,
    // not N*3. Returns everything downstream needs.
    const pending = await db
      .select({
        id: botFollowRequests.id,
        botAccountId: botFollowRequests.botAccountId,
        botSessionData: botAccounts.sessionData,
        botUsername: botAccounts.igUsername,
        trackedAccountId: botFollowRequests.trackedAccountId,
        trackedUsername: trackedAccounts.igUsername,
        trackedUserId: trackedAccounts.userId,
      })
      .from(botFollowRequests)
      .innerJoin(botAccounts, eq(botFollowRequests.botAccountId, botAccounts.id))
      .innerJoin(
        trackedAccounts,
        eq(botFollowRequests.trackedAccountId, trackedAccounts.id),
      )
      .where(and(eq(botFollowRequests.status, "pending"), eq(trackedAccounts.isActive, true), customerAccessSql(trackedAccounts.userId)));

    logger.info({ count: pending.length }, "found pending follow requests");

    return pending;
  } catch (err) {
    logger.error({ err }, "error querying pending follow requests");
    throw err;
  }
}

// ─── Wave 3: per-bot persistent device fingerprint ──────────────────────────

/**
 * Ensure the bot row has a persistent device fingerprint. If any field is
 * missing we generate it deterministically from the username and persist so
 * the very next request uses the same identity. This is a best-effort write —
 * the generator is deterministic so even if persistence fails we still emit
 * stable headers for this process's lifetime.
 */
export async function ensureBotFingerprint(botId: string): Promise<DeviceFingerprint> {
  const [row] = await db
    .select({
      igUsername: botAccounts.igUsername,
      deviceId: botAccounts.deviceId,
      deviceUserAgent: botAccounts.deviceUserAgent,
      igAppId: botAccounts.igAppId,
      timezone: botAccounts.timezone,
      locale: botAccounts.locale,
      awakeHourStart: botAccounts.awakeHourStart,
      awakeHourEnd: botAccounts.awakeHourEnd,
      automationIdentity: botAccounts.automationIdentity,
    })
    .from(botAccounts)
    .where(eq(botAccounts.id, botId))
    .limit(1);

  if (!row) throw new Error(`[bot-manager] bot ${botId} not found`);

  const automationIdentity = parseAutomationIdentity(row.automationIdentity, botId);
  const fingerprint = resolveFingerprint({
    ...row,
    deviceUserAgent: automationIdentity?.user_agent ?? row.deviceUserAgent,
    timezone: automationIdentity?.timezone ?? row.timezone,
    locale: automationIdentity?.locale ?? row.locale,
  });

  const needsPersist =
    !row.deviceId ||
    !row.deviceUserAgent ||
    !row.igAppId ||
    !row.timezone ||
    !row.locale ||
    (automationIdentity !== null &&
      (row.deviceUserAgent !== automationIdentity.user_agent ||
        row.timezone !== automationIdentity.timezone ||
        row.locale !== automationIdentity.locale)) ||
    row.awakeHourStart === null ||
    row.awakeHourEnd === null;

  if (needsPersist) {
    try {
      await db
        .update(botAccounts)
        .set({
          deviceId: fingerprint.deviceId,
          deviceUserAgent: fingerprint.userAgent,
          igAppId: fingerprint.appId,
          timezone: fingerprint.timezone,
          locale: fingerprint.locale,
          awakeHourStart: fingerprint.awakeHourStart,
          awakeHourEnd: fingerprint.awakeHourEnd,
          updatedAt: new Date(),
        })
        .where(eq(botAccounts.id, botId));
      logger.info({ botId }, "persisted device fingerprint");
    } catch (err) {
      logger.warn({ botId, err }, "failed to persist fingerprint, using generated only");
    }
  }

  return fingerprint;
}

/**
 * Idempotent fingerprint backfill for every bot row with null device fields,
 * plus migrated rows whose legacy columns drifted from automation_identity.
 */
export async function backfillBotFingerprints(): Promise<number> {
  const rows = await db
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
      automationIdentity: botAccounts.automationIdentity,
    })
    .from(botAccounts)
    .where(
      or(
        isNull(botAccounts.deviceId),
        isNull(botAccounts.deviceUserAgent),
        isNotNull(botAccounts.automationIdentity),
      ),
    );

  let count = 0;
  for (const row of rows) {
    const automationIdentity = parseAutomationIdentity(row.automationIdentity, row.id);
    const fp = resolveFingerprint({
      ...row,
      deviceUserAgent: automationIdentity?.user_agent ?? row.deviceUserAgent,
      timezone: automationIdentity?.timezone ?? row.timezone,
      locale: automationIdentity?.locale ?? row.locale,
    });
    const needsPersist =
      !row.deviceId ||
      !row.deviceUserAgent ||
      !row.igAppId ||
      !row.timezone ||
      !row.locale ||
      row.awakeHourStart === null ||
      row.awakeHourEnd === null ||
      (automationIdentity !== null &&
        (row.deviceUserAgent !== automationIdentity.user_agent ||
          row.timezone !== automationIdentity.timezone ||
          row.locale !== automationIdentity.locale));
    if (!needsPersist) continue;
    try {
      await db
        .update(botAccounts)
        .set({
          deviceId: fp.deviceId,
          deviceUserAgent: fp.userAgent,
          igAppId: fp.appId,
          timezone: fp.timezone,
          locale: fp.locale,
          awakeHourStart: fp.awakeHourStart,
          awakeHourEnd: fp.awakeHourEnd,
          updatedAt: new Date(),
        })
        .where(eq(botAccounts.id, row.id));
      count += 1;
    } catch (err) {
      logger.warn({ botId: row.id, err }, "backfill fingerprint failed");
    }
  }

  if (count > 0) logger.info({ count }, "backfilled bot fingerprints");
  return count;
}

/**
 * Fetch the full bot row (minus sessionData) plus the resolved fingerprint.
 * Returned shape is safe for the worker to pass into pacing / cap checks
 * without needing another round-trip.
 */
export async function getBotForTrackedAccount(
  trackedAccountId: string,
): Promise<
  | {
      id: string;
      igUsername: string;
      // Wave 4: nullable when the bot has just been seeded and never logged
      // in. Caller is responsible for invoking ensureBotReady before use.
      sessionData: string | null;
      proxyUrl: string | null;
      createdAt: Date;
      maxFollows: number;
      timezone: string;
      awakeHourStart: number;
      awakeHourEnd: number;
      fingerprint: DeviceFingerprint;
    }
  | null
> {
  // Wave 6: only return the assigned bot if it is still in an active tier.
  // If ops has re-tiered the bot to 'reserve' or 'retired' after assignment
  // we treat it as if no bot is available — caller will rotate to a fresh
  // worker/canary instead of poking a cold bot.
  const [row] = await db
    .select({
      id: botAccounts.id,
      igUsername: botAccounts.igUsername,
      sessionData: botAccounts.sessionData,
      proxyUrl: botAccounts.proxyUrl,
      createdAt: botAccounts.createdAt,
      maxFollows: botAccounts.maxFollows,
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
        inArray(botAccounts.tier, ["worker", "canary"]),
      ),
    )
    .limit(1);

  if (!row) return null;

  const fingerprint = resolveFingerprint(row);
  return {
    id: row.id,
    igUsername: row.igUsername,
    sessionData: row.sessionData,
    proxyUrl: row.proxyUrl,
    createdAt: row.createdAt,
    maxFollows: row.maxFollows,
    timezone: fingerprint.timezone,
    awakeHourStart: fingerprint.awakeHourStart,
    awakeHourEnd: fingerprint.awakeHourEnd,
    fingerprint,
  };
}

// ─── Wave 6: tier ops ────────────────────────────────────────────────────────

/**
 * The canary bot row shape returned by getCanaryBot. Mirrors the fields
 * needed by the canary protocol (it does not need the heavy fingerprint
 * payload — the IG client resolves that itself).
 */
export interface CanaryBotRow {
  id: string;
  igUsername: string;
  sessionData: string | null;
  proxyUrl: string | null;
  status: string;
  tier: "canary" | "worker" | "reserve" | "retired";
}

/**
 * Wave 6 — return the lone canary bot used by the canary protocol to probe
 * new endpoints. There is intentionally one canary at a time: more than one
 * defeats the blast-radius point. If multiple canaries exist (e.g. during a
 * promotion) we return the most recently used one so probes stay sticky.
 *
 * Returns null when no canary is configured. Callers must be defensive —
 * the canary tier is optional ops state, not a hard requirement.
 */
export async function getCanaryBot(): Promise<CanaryBotRow | null> {
  const [row] = await db
    .select({
      id: botAccounts.id,
      igUsername: botAccounts.igUsername,
      sessionData: botAccounts.sessionData,
      proxyUrl: botAccounts.proxyUrl,
      status: botAccounts.status,
      tier: botAccounts.tier,
    })
    .from(botAccounts)
    .where(eq(botAccounts.tier, "canary"))
    .orderBy(desc(botAccounts.lastUsedAt))
    .limit(1);

  if (!row) return null;
  return row as CanaryBotRow;
}

/**
 * Wave 6 — ops helper to promote/demote a bot between tiers. This is the
 * ONLY supported way to flip a bot in/out of rotation: assignment helpers
 * never mutate tier on their own. Returns the number of rows updated (0 if
 * the bot id is unknown).
 */
export async function setBotTier(
  botId: string,
  tier: "canary" | "worker" | "reserve" | "retired",
): Promise<number> {
  const result = await db
    .update(botAccounts)
    .set({ tier, updatedAt: new Date() })
    .where(eq(botAccounts.id, botId))
    .returning({ id: botAccounts.id });

  if (result.length > 0) {
    logger.info({ botId, tier }, "bot tier updated");
  } else {
    logger.warn({ botId, tier }, "setBotTier: bot not found");
  }

  return result.length;
}

/** Reconcile persisted queued/pending work after cancellation, expiry or stop.
 * Old BullMQ jobs become harmless because execution also checks the row state. */
export async function cancelIneligibleFollowRequests(): Promise<number> {
  const rows = await db.select({ id: botFollowRequests.id })
    .from(botFollowRequests)
    .innerJoin(trackedAccounts, eq(botFollowRequests.trackedAccountId, trackedAccounts.id))
    .where(and(inArray(botFollowRequests.status, ["queued", "pending"]),
      sql`(NOT ${trackedAccounts.isActive} OR NOT ${customerAccessSql(trackedAccounts.userId)})`));
  for (const row of rows) await markFollowRequestFailed(row.id, "Tracking access ended");
  return rows.length;
}
