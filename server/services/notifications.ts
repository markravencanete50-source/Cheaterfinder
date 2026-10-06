/**
 * Notification creation.
 *
 * The in-app row is the notification centre and is always recorded; the push is
 * a best-effort nudge on top. Both used to be separate concerns at four
 * scattered `db.insert(notifications)` call sites, which is exactly how a new
 * notification type ends up silently never pushing. One helper, one hook point.
 *
 * Push is deliberately fire-and-forget: it must never delay or fail the action
 * that produced the notification (a webhook, a worker sweep, a bot follow
 * acceptance). `sendPushToUser` already swallows and logs its own errors.
 */

import { db } from "../db.js";
import { notifications } from "../../shared/schema.js";
import { sendPushToUser } from "./push-notifications.js";
import { isTrialPreviewUser } from "./trial-preview-access.js";
import { sanitizeTrialPreview } from "./trial-preview.js";

/** Mirrors `notification_type` in shared/schema.ts. */
export type NotificationType =
  | "new_like"
  | "new_follow"
  | "new_unfollow"
  | "report_ready"
  | "subscription_updated"
  | "trial_ending"
  | "payment_failed"
  | "access_granted"
  | "access_pending";

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /**
   * Extra values delivered with the push so the app can deep-link. Values must
   * be strings — APNs and FCM payloads are string-keyed.
   */
  data?: Record<string, string>;
  /**
   * Set when the row was already inserted by the caller (e.g. inside a
   * transaction that must not be split). Skips the insert and only pushes.
   */
  skipInsert?: boolean;
  /** Stable business-event key; duplicate webhook delivery must not push twice. */
  dedupeKey?: string;
}

export async function createNotification({
  userId,
  type,
  title,
  body,
  data,
  skipInsert = false,
  dedupeKey,
}: CreateNotificationInput): Promise<void> {
  if (!skipInsert) {
    if (dedupeKey) {
      const inserted = await db.insert(notifications).values({ userId, type, title, body, dedupeKey })
        .onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id });
      if (!inserted.length) return;
    } else {
      await db.insert(notifications).values({ userId, type, title, body });
    }
  }

  // Stored evidence remains real. The delivery boundary projects activity for
  // current trials, so a push cannot bypass the customer API preview.
  void (async () => {
    const payload = { type, title, body, data: { type, ...(data ?? {}) } };
    const outgoing = await isTrialPreviewUser(userId)
      ? sanitizeTrialPreview("notifications", payload, userId) as typeof payload
      : payload;
    await sendPushToUser(userId, { title: outgoing.title, body: outgoing.body, data: outgoing.data });
  })().catch(() => { /* Preview lookup failure must never send unsanitized content. */ });
}
