import { and, asc, count, desc, eq, or, sql } from "drizzle-orm";
import IORedis from "ioredis";
import { db } from "../db.js";
import { collectionJobs, postsCache, profileSnapshots, trackedAccounts } from "../../shared/schema.js";
import type { PostsCollectionState } from "../../shared/posts-collection-state.js";
import { customerHasAccess } from "./subscription-access.js";
import { canonicalTwinId } from "./tracked-account-twins.js";

type Timestamp = Date | string | null | undefined;
type Attempt = { status: string; startedAt: Timestamp; completedAt: Timestamp; error: string | null };
const millis = (value: Timestamp): number | null => {
  if (!value) return null;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
};
const iso = (value: Timestamp): string | null => {
  const result = millis(value);
  return result === null ? null : new Date(result).toISOString();
};

export function derivePostsCollectionState(input: {
  savedTotal: number; profileSnapshot: { postCount: number; snapshotAt: Timestamp } | null;
  lastContentRefreshAt: Timestamp; attempt: Attempt | null; nextRetryAt: Timestamp;
  trackingActive: boolean; source: PostsCollectionState["source"]; now?: number;
}): PostsCollectionState {
  const now = input.now ?? Date.now();
  const lastRead = millis(input.lastContentRefreshAt);
  const attempt = input.attempt;
  const attemptAt = millis(attempt?.startedAt) ?? millis(attempt?.completedAt);
  const finishedAt = millis(attempt?.completedAt) ?? attemptAt;
  const error = attempt?.error ?? "";
  const retry = millis(input.nextRetryAt);
  const nextRetryAt = input.trackingActive && retry !== null && retry > now ? new Date(retry).toISOString() : null;
  // A profile job also gathers unrelated dimensions. A failed roster must not
  // label a successfully saved posts read as failed.
  const relevantFailure = !error.startsWith("partial collection:") || /(?:^partial collection:\s*| \| )(?:posts|profile):/.test(error);
  const newerFailure = attempt?.status === "failed" && relevantFailure &&
    (lastRead === null || (finishedAt !== null && finishedAt > lastRead));
  let state: PostsCollectionState["state"];
  if (input.trackingActive && attempt?.status === "running" && attemptAt !== null && now - attemptAt < 2 * 60 * 60 * 1000) {
    state = "collecting";
  } else if (input.trackingActive && (attempt?.status === "pending" || attempt?.status === "running" || newerFailure)) {
    state = nextRetryAt || /deferred|cooldown|rate.?limit|no (?:healthy|available|eligible)|no.pool|throttl|capacity/i.test(error) || attempt?.status === "pending"
      ? "delayed" : "failed";
  } else if (input.savedTotal > 0) {
    state = "available";
  } else if (lastRead !== null && input.profileSnapshot?.postCount === 0 &&
    millis(input.profileSnapshot.snapshotAt) !== null && millis(input.profileSnapshot.snapshotAt)! <= lastRead && !newerFailure) {
    state = "empty_observed";
  } else {
    state = input.trackingActive && lastRead === null ? "not_collected" : "unavailable";
  }
  return {
    state, savedTotal: input.savedTotal,
    recordedProfileCount: input.profileSnapshot?.postCount ?? null,
    recordedProfileAt: iso(input.profileSnapshot?.snapshotAt),
    lastPostsReadAt: iso(input.lastContentRefreshAt), lastAttemptAt: iso(attempt?.startedAt ?? attempt?.completedAt),
    nextRetryAt, trackingActive: input.trackingActive, source: input.source,
  };
}

interface QueueReader {
  hget(key: string, field: string): Promise<string | null>;
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>;
  zscore(key: string, member: string): Promise<string | null>;
}

/** Read only exact scheduler/recovery IDs. Never scan a queue or forecast a bot. */
export async function verifiedPostsCheckAt(redis: QueueReader, accountId: string, error: string | null, now = Date.now()): Promise<string | null> {
  const prefix = "bull:collection-profile";
  if (await redis.hget(`${prefix}:meta`, "paused")) return null;
  const scheduler = `account-refresh:${accountId}`;
  const score = Number(await redis.zscore(`${prefix}:repeat`, scheduler));
  const candidates: Array<{ id: string; expectedAt: number; source?: string }> = [];
  if (Number.isSafeInteger(score) && score > now) candidates.push({ id: `repeat:${scheduler}:${score}`, expectedAt: score });
  const match = /^(?:deferred until (public posts reader capacity returns|approved viewer cooldown expires)): (\d{4}-\d\d-\d\dT[\d:.]+Z)(?:;|$)/.exec(error ?? "");
  if (match) {
    const expectedAt = Date.parse(match[2]);
    if (Number.isSafeInteger(expectedAt) && expectedAt > now) {
      const source = match[1].startsWith("public") ? "public-posts-capacity" : "private-cooldown";
      candidates.push({ id: `${source}_${accountId}_${expectedAt - 1000}`, expectedAt, source });
    }
  }
  const dates = await Promise.all(candidates.map(async candidate => {
    const [delayedScore, fields] = await Promise.all([
      redis.zscore(`${prefix}:delayed`, candidate.id),
      redis.hmget(`${prefix}:${candidate.id}`, "name", "data", "timestamp", "delay"),
    ]);
    const [name, data, timestamp, delay] = fields;
    if (!delayedScore || name !== (candidate.source ? "collect-profile" : "account-refresh") || !data) return null;
    let payload: { trackedAccountId?: unknown; source?: unknown };
    try { payload = JSON.parse(data); } catch { return null; }
    if (!payload || payload.trackedAccountId !== accountId || payload.source !== (candidate.source ?? "account-refresh")) return null;
    const dueAt = Math.floor(Number(delayedScore) / 4096);
    const hashDue = Number(timestamp) + Number(delay);
    // Both the actual delayed-set membership and stored timing must agree.
    if (!Number.isSafeInteger(dueAt) || dueAt <= now || Math.abs(hashDue - dueAt) > 1) return null;
    return dueAt;
  }));
  const future = dates.filter((value): value is number => value !== null);
  return future.length ? new Date(Math.min(...future)).toISOString() : null;
}

async function scheduledCheckAt(accountId: string, error: string | null): Promise<string | null> {
  // No default connection: an unconfigured/read-only process must not start a
  // local Redis service or leave retrying sockets behind after an API request.
  if (!process.env.REDIS_URL) return null;
  const redis = new IORedis(process.env.REDIS_URL, {
    lazyConnect: true, enableReadyCheck: false, enableOfflineQueue: false,
    maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 500, commandTimeout: 500,
  });
  redis.on("error", () => {});
  try {
    await redis.connect();
    return await verifiedPostsCheckAt(redis, accountId, error);
  } catch { return null; }
  finally { redis.disconnect(); }
}

export async function readPostsCollectionState(requestingAccountId: string, options: {
  contentAccountId?: string; savedTotal?: number; latestSavedAt?: Timestamp;
  profileSnapshot?: { postCount: number; snapshotAt: Date | string } | null;
} = {}): Promise<PostsCollectionState> {
  const [requesting] = await db.select({ id: trackedAccounts.id, userId: trackedAccounts.userId,
    isPrivate: trackedAccounts.isPrivate, isActive: trackedAccounts.isActive, accessStatus: trackedAccounts.accessStatus })
    .from(trackedAccounts).where(eq(trackedAccounts.id, requestingAccountId)).limit(1);
  const blocked = !requesting || (requesting.isPrivate && (!requesting.isActive || requesting.accessStatus !== "has_access" || !await customerHasAccess(requesting.userId)));
  if (blocked) return {
    state: requesting?.isActive && requesting.accessStatus !== "has_access" ? "waiting_for_access" : "unavailable",
    savedTotal: null, recordedProfileCount: null, recordedProfileAt: null, lastPostsReadAt: null,
    lastAttemptAt: null, nextRetryAt: null, trackingActive: requesting?.isActive ?? false, source: "account",
  };
  const contentId = await canonicalTwinId(requestingAccountId);
  const matchingSource = options.contentAccountId === contentId;
  const [[source], [attempt], totals, snapshots] = await Promise.all([
    db.select({ lastContentRefreshAt: trackedAccounts.lastContentRefreshAt, isActive: trackedAccounts.isActive })
      .from(trackedAccounts).where(eq(trackedAccounts.id, contentId)).limit(1),
    db.select({ status: collectionJobs.status, startedAt: collectionJobs.startedAt,
      completedAt: collectionJobs.completedAt, error: collectionJobs.error }).from(collectionJobs)
      .where(and(eq(collectionJobs.trackedAccountId, contentId), eq(collectionJobs.jobType, "profile"),
        or(sql`${collectionJobs.error} IS NULL`, sql`${collectionJobs.error} NOT LIKE 'skipped:%'`)))
      .orderBy(sql`${collectionJobs.startedAt} DESC NULLS LAST`, desc(collectionJobs.id)).limit(1),
    matchingSource && Number.isSafeInteger(options.savedTotal) && options.savedTotal! >= 0 ? Promise.resolve([{ total: options.savedTotal! }])
      : db.select({ total: count() }).from(postsCache).where(eq(postsCache.trackedAccountId, contentId)),
    matchingSource && options.profileSnapshot !== undefined ? Promise.resolve(options.profileSnapshot ? [options.profileSnapshot] : [])
      : db.select({ postCount: profileSnapshots.postCount, snapshotAt: profileSnapshots.snapshotAt }).from(profileSnapshots)
        .where(eq(profileSnapshots.trackedAccountId, contentId)).orderBy(desc(profileSnapshots.snapshotAt), asc(profileSnapshots.id)).limit(1),
  ]);
  const nextRetryAt = requesting.isActive && source?.isActive ? await scheduledCheckAt(contentId, attempt?.error ?? null) : null;
  return derivePostsCollectionState({ savedTotal: totals[0]?.total ?? 0, profileSnapshot: snapshots[0] ?? null,
    lastContentRefreshAt: source?.lastContentRefreshAt, attempt: attempt ?? null, nextRetryAt,
    trackingActive: requesting.isActive, source: contentId === requestingAccountId ? "account" : "shared_public_profile" });
}
