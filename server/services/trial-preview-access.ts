import type { Request, Response } from "express";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db.js";
import { profileSnapshots, subscriptions, trackedAccounts } from "../../shared/schema.js";
import { mediaCacheKey } from "./media-cache.js";
import { isTrialPreview } from "./trial-preview.js";

export async function isTrialPreviewUser(userId: string): Promise<boolean> {
  const [subscription] = await db.select({ status: subscriptions.status }).from(subscriptions)
    .where(eq(subscriptions.userId, userId)).limit(1);
  return isTrialPreview(subscription);
}

/** The exception comes from owned database rows, never a caller's "profile" flag. */
export async function isPermittedPreviewAvatar(userId: string, req: Request): Promise<boolean> {
  const cached = req.path.toLowerCase().startsWith("/api/media/");
  const cacheKey = cached ? req.path.slice("/api/media/".length) : null;
  const accountId = cached && typeof req.query.trackedAccountId === "string" ? req.query.trackedAccountId : null;
  const originalUrl = !cached && typeof req.query.url === "string" ? req.query.url : null;
  if (cached ? !accountId || !/^[a-f0-9]{64}$/.test(cacheKey!) : !originalUrl) return false;
  const accounts = await db.select({ id: trackedAccounts.id, profilePicUrl: trackedAccounts.profilePicUrl })
    .from(trackedAccounts).where(and(eq(trackedAccounts.userId, userId), eq(trackedAccounts.isActive, true),
      ...(accountId ? [eq(trackedAccounts.id, accountId)] : [])));
  for (const account of accounts) {
    const [latest] = await db.select({ profilePicUrl: profileSnapshots.profilePicUrl, profilePicUrlHd: profileSnapshots.profilePicUrlHd })
      .from(profileSnapshots).where(eq(profileSnapshots.trackedAccountId, account.id))
      .orderBy(desc(profileSnapshots.snapshotAt)).limit(1);
    const urls = [account.profilePicUrl, latest?.profilePicUrl, latest?.profilePicUrlHd].filter((url): url is string => !!url);
    if (urls.some(url => cached ? mediaCacheKey(url) === cacheKey : url === originalUrl)) return true;
  }
  return false;
}

export function sendPreviewPlaceholder(res: Response): void {
  const root = process.env.NODE_ENV === "production" ? "dist/public" : "client/public";
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "image/png");
  res.sendFile(path.resolve(root, "assets/preview-blur.png"));
}
