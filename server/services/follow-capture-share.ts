// ─── Shared follow-list captures (de-duplicated IG reads) ────────────────────
//
// The SAME Instagram account can be tracked by several customers — @tracked_user_1 is
// tracked by two. Each customer gets their own tracked_accounts row, their own
// roster baseline and their own event history, which is correct: their diffs are
// independent. What is NOT correct is fetching the identical follower list from
// Instagram once per customer. That doubles IG load and, because every read is a
// ban-risk call on a scarce pool, doubles the cost of the same information. It
// also lets the two customers drift apart (they saw 62 vs 83 unfollow events for
// one account) purely because their two captures landed at different moments.
//
// This module de-duplicates the CAPTURE only. Each caller still runs its own
// reconcile/diff against its own baseline — nothing about per-customer state is
// shared.
//
// KEY CORRECTNESS POINT: the key includes the resume cursor. Since roster walks
// became resumable (migration 0039), two trackers of the same account can be at
// DIFFERENT offsets, and handing one of them the other's slice would corrupt
// their roster. Sharing therefore only happens when the requested starting point
// is identical — in practice the common case, since both usually sit at the
// start of a fresh pass.

import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "follow-capture-share" });

/** 0 disables sharing entirely. */
function shareTtlMs(): number {
  const raw = Number(process.env.FOLLOW_CAPTURE_SHARE_TTL_MS ?? "900000");
  if (!Number.isFinite(raw) || raw < 0) return 900_000;
  return Math.min(raw, 3_600_000);
}

/** Bounds memory: a capture can hold thousands of users. */
function maxEntries(): number {
  const raw = Number(process.env.FOLLOW_CAPTURE_SHARE_MAX_ENTRIES ?? "32");
  if (!Number.isFinite(raw) || raw < 1) return 32;
  return Math.min(Math.trunc(raw), 256);
}

interface Entry<T> {
  readonly value: Promise<T>;
  readonly storedAt: number;
}

const inflight = new Map<string, Entry<unknown>>();

export function buildShareKey(
  dimension: "follower" | "following",
  igUserId: string,
  startCursor: string | null | undefined,
): string {
  // The cursor is part of the identity of the slice being requested.
  return `${dimension}:${igUserId}:${startCursor ?? "START"}`;
}

function evictExpired(now: number, ttl: number): void {
  for (const [key, entry] of inflight) {
    if (now - entry.storedAt >= ttl) inflight.delete(key);
  }
  while (inflight.size > maxEntries()) {
    const oldest = inflight.keys().next();
    if (oldest.done) break;
    inflight.delete(oldest.value);
  }
}

/**
 * Run `fetch`, or reuse an identical in-flight/recent capture.
 *
 * Reuse is deliberately promise-based: two customers' cycles often overlap, so
 * the second caller awaits the first's in-flight request rather than issuing a
 * duplicate one.
 */
export async function withSharedFollowCapture<T>(
  key: string,
  label: string,
  fetch: () => Promise<T>,
): Promise<T> {
  const ttl = shareTtlMs();
  if (ttl === 0) return fetch();

  const now = Date.now();
  evictExpired(now, ttl);

  const existing = inflight.get(key);
  if (existing && now - existing.storedAt < ttl) {
    logger.info(
      { key, label, ageMs: now - existing.storedAt },
      "[follow-share] reusing capture for an account tracked by multiple users — skipped a duplicate IG read",
    );
    return existing.value as Promise<T>;
  }

  const value = fetch();
  inflight.set(key, { value: value as Promise<unknown>, storedAt: now });
  // A failed capture must not be served to the next caller for the whole TTL.
  const forget = () => {
    const cur = inflight.get(key);
    if (cur && cur.value === (value as Promise<unknown>)) inflight.delete(key);
  };
  void value.then(result => {
    // Public-data failures resolve as {ok:false}; they do not reject. Keeping
    // that promise would suppress fresh reads for the entire sharing TTL.
    if (result && typeof result === "object" && "ok" in result && result.ok === false) forget();
  }, forget);
  return value;
}

/** Test/ops helper. */
export function resetFollowCaptureShare(): void {
  inflight.clear();
}

/** Observability: how many captures are currently shareable. */
export function followCaptureShareSize(): number {
  return inflight.size;
}
