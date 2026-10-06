import { sql, type SQL } from "drizzle-orm";

import { likeEvents, trackedAccounts } from "../../shared/schema.js";

/**
 * Customer-facing liked-post activity is intentionally forward-only.
 *
 * Instagram does not expose the time a like happened, so the product uses the
 * liked post's publication time as the boundary requested by the customer:
 * only posts published after tracking began are eligible. A missing post date
 * is not evidence that the post is new and therefore stays hidden.
 */
/**
 * Forward-only can be measured two ways, and the difference is large.
 *
 * POST-DATE mode (the original): only posts PUBLISHED after tracking began are
 * eligible. Faithful to the original request, but it silently drops real,
 * current activity — someone liking a six-month-old post today is invisible.
 * The effect scales with how recently an account was added: @example_account
 * (tracked 2026-05-10) accumulated 60 events while @tracked_user_2 and
 * @tracked_user_4 (tracked 2026-07/08) sat at exactly 0, because almost
 * nothing they like was published inside their short window.
 *
 * OBSERVED mode (default): eligibility is judged by when WE FIRST SAW the like.
 * Still strictly forward-only — anything observed before tracking began is
 * never shown, so no history dump on day 1 — but a new like on an old post is
 * reported, which is what the customer actually means by "new liked post".
 *
 * Set LIKE_EVENT_WINDOW=post_date to restore the original behaviour.
 */
function useObservedWindow(): boolean {
  return (process.env.LIKE_EVENT_WINDOW ?? "observed") !== "post_date";
}

export function isLikedPostAfterTrackingStart(
  postTakenAt: Date | null | undefined,
  trackingStarted: Date,
  observedAt?: Date | null,
): boolean {
  if (useObservedWindow()) {
    // We are observing the like right now, so the sighting is by definition
    // inside the tracking window unless an explicit earlier time is supplied
    // (backfill from cached liker rows predating tracking).
    const seenAt = observedAt instanceof Date ? observedAt : new Date();
    return seenAt > trackingStarted;
  }
  return postTakenAt instanceof Date && postTakenAt > trackingStarted;
}

/**
 * Visibility predicate when the tracked account has already been loaded.
 *
 * MUST mirror isLikedPostAfterTrackingStart: if the write path stores an event
 * the read path hides, the row exists in the DB and the customer still sees an
 * empty panel — which is exactly the failure this pair caused.
 */
export function likedPostAfterTrackingStart(trackingStarted: Date): SQL {
  return useObservedWindow()
    ? sql`${likeEvents.detectedAt} > ${trackingStarted}`
    : sql`${likeEvents.postTakenAt} > ${trackingStarted}`;
}

/** Visibility predicate for queries joined to tracked_accounts. */
export function likedPostAfterJoinedAccountTrackingStart(): SQL {
  return useObservedWindow()
    ? sql`${likeEvents.detectedAt} > ${trackedAccounts.trackingStarted}`
    : sql`${likeEvents.postTakenAt} > ${trackedAccounts.trackingStarted}`;
}
