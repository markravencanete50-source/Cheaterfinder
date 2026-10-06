/**
 * Expo push delivery.
 *
 * The app registers an Expo push token per install; this module stores those
 * tokens and pushes to them. Expo's HTTP API is used directly rather than the
 * SDK — it is a single POST, and one fewer dependency in a bundle that already
 * ships 1.7MB.
 *
 * Delivery is strictly best-effort and never blocks the caller: an in-app
 * notification row is the source of truth (the client polls and lists it), and
 * push is only a nudge. A failed push must never fail the action that produced
 * it, so `sendPushToUser` swallows its errors after logging.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { deviceTokens, users } from "../../shared/schema.js";
import { logger } from "../observability/logger.js";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** Expo caps a single request at 100 messages. */
const EXPO_BATCH_SIZE = 100;

export type DevicePlatform = "ios" | "android";

export interface PushPayload {
  title: string;
  body: string;
  /** Routed by the app to deep-link the right screen. */
  data?: Record<string, string>;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** Expo tokens look like `ExponentPushToken[...]` or `ExpoPushToken[...]`. */
export function isExpoPushToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^Expo(nent)?PushToken\[[^\]]+\]$/.test(value.trim())
  );
}

/**
 * Register (or refresh) a device token for a user.
 *
 * Upserts on the token, not on (user, token): Expo issues one token per install,
 * so if a different user signs in on that device the row must move to them or
 * the previous user would keep receiving the new user's notifications.
 */
export async function registerDeviceToken(
  userId: string,
  token: string,
  platform: DevicePlatform,
): Promise<void> {
  await db
    .insert(deviceTokens)
    .values({ userId, token, platform })
    .onConflictDoUpdate({
      target: deviceTokens.token,
      set: { userId, platform, lastSeenAt: new Date() },
    });
}

/** Remove a token. Called on sign-out and when Expo reports it is dead. */
export async function unregisterDeviceToken(
  token: string,
  userId?: string,
): Promise<void> {
  await db
    .delete(deviceTokens)
    .where(
      userId
        ? and(eq(deviceTokens.token, token), eq(deviceTokens.userId, userId))
        : eq(deviceTokens.token, token),
    );
}

async function pruneTokens(tokens: readonly string[]): Promise<void> {
  if (tokens.length === 0) return;
  await db.delete(deviceTokens).where(inArray(deviceTokens.token, [...tokens]));
}

/**
 * Push to every device belonging to `userId`, honouring their preference.
 *
 * Respects `users.push_notifications`: the toggle in Settings is the user's
 * answer to "may we push to you", so it is checked here rather than at each
 * call site, where it would inevitably be forgotten.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    const [user] = await db
      .select({ pushEnabled: users.pushNotifications })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || user.pushEnabled === false) return;

    const rows = await db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, userId));

    if (rows.length === 0) return;

    const messages = rows.map((row) => ({
      to: row.token,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      sound: "default" as const,
      channelId: "default",
    }));

    for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
      const batch = messages.slice(i, i + EXPO_BATCH_SIZE);
      const response = await fetch(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        logger.warn(
          { module: "push", status: response.status, userId },
          "expo push request failed",
        );
        continue;
      }

      const parsed = (await response.json()) as { data?: ExpoTicket[] };
      const tickets = parsed.data ?? [];

      // A token that Expo reports as unregistered is dead — the app was
      // uninstalled or the token rotated. Drop it so we stop paying for it.
      const dead = tickets
        .map((ticket, index) =>
          ticket.status === "error" &&
          ticket.details?.error === "DeviceNotRegistered"
            ? batch[index].to
            : null,
        )
        .filter((token): token is string => token !== null);

      await pruneTokens(dead);
    }
  } catch (err) {
    logger.warn(
      { module: "push", userId, err: err instanceof Error ? err.message : String(err) },
      "push delivery failed",
    );
  }
}
