// ── Churn cancellation ──────────────────────────────────────────────────────
//
// Even with the roster's absence-confirmation hysteresis, an account that sits
// on Instagram's pagination boundary (returned by ~half of complete reads) can
// still oscillate: absent for enough reads to confirm a departure (unfollow
// event), then present again (follow event) — a net-zero follow/unfollow PAIR on
// the same username. Measured 2026-07-16 AFTER the roster rewrite: every one of
// @sample_account's 14 follows + 14 unfollows in a day was the same usernames
// flapping; none was real.
//
// A follow and an unfollow of the SAME account within a short window is churn,
// not activity — real users do not follow then unfollow (or vice-versa) the same
// person within a day or two. So when we are about to record one direction and
// the OPPOSITE event for that account already exists inside the churn window, we
// delete the opposite event and skip the new one: the pair cancels to nothing.
// Genuine transitions (the account stays followed, or stays gone) have no
// opposite event and pass through untouched.

import { and, eq, gt, inArray, sql, type AnyColumn } from "drizzle-orm";

import { db } from "../db.js";
import {
  followEvents,
  followerEvents,
  followerUnfollowEvents,
  unfollowEvents,
} from "../../shared/schema.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ChurnRefs {
  readonly followTable: typeof followEvents | typeof followerEvents;
  readonly followUsername: AnyColumn;
  readonly followDetectedAt: AnyColumn;
  readonly unfollowTable: typeof unfollowEvents | typeof followerUnfollowEvents;
  readonly unfollowUsername: AnyColumn;
  readonly unfollowDetectedAt: AnyColumn;
}

const CHURN_WINDOW_MS = (() => {
  const raw = Number(process.env.ROSTER_CHURN_WINDOW_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 2 * 24 * 60 * 60 * 1000; // 2 days
  return Math.min(Math.max(raw, 60 * 60 * 1000), 14 * 24 * 60 * 60 * 1000);
})();

/**
 * Drop follow/unfollow candidates that cancel a recent opposite event, deleting
 * that opposite event. Returns the survivors (genuine transitions).
 *
 * Columns are passed as drizzle refs so the same logic serves both the
 * following dimension (follow_events / unfollow_events) and the follower
 * dimension (follower_events / follower_unfollow_events).
 *
 * @param arrivals   lowercased usernames about to be recorded as follows
 * @param departures lowercased usernames about to be recorded as unfollows
 */
export async function cancelChurn(
  tx: Tx,
  trackedAccountId: string,
  arrivals: ReadonlyArray<string>,
  departures: ReadonlyArray<string>,
  refs: ChurnRefs,
): Promise<{ arrivals: string[]; departures: string[] }> {
  const cutoff = new Date(Date.now() - CHURN_WINDOW_MS);

  // Arrivals that cancel a recent unfollow → delete the unfollow, drop arrival.
  let cancelledUnfollows = new Set<string>();
  if (arrivals.length > 0) {
    const rows = await tx
      .select({ u: sql<string>`lower(${refs.unfollowUsername})` })
      .from(refs.unfollowTable)
      .where(
        and(
          eq(refs.unfollowTable.trackedAccountId, trackedAccountId),
          inArray(sql`lower(${refs.unfollowUsername})`, [...arrivals]),
          gt(refs.unfollowDetectedAt, cutoff),
        ),
      );
    cancelledUnfollows = new Set(rows.map((r) => String(r.u)));
    if (cancelledUnfollows.size > 0) {
      await tx
        .delete(refs.unfollowTable)
        .where(
          and(
            eq(refs.unfollowTable.trackedAccountId, trackedAccountId),
            inArray(sql`lower(${refs.unfollowUsername})`, [...cancelledUnfollows]),
            gt(refs.unfollowDetectedAt, cutoff),
          ),
        );
    }
  }

  // Departures that cancel a recent follow → delete the follow, drop departure.
  let cancelledFollows = new Set<string>();
  if (departures.length > 0) {
    const rows = await tx
      .select({ u: sql<string>`lower(${refs.followUsername})` })
      .from(refs.followTable)
      .where(
        and(
          eq(refs.followTable.trackedAccountId, trackedAccountId),
          inArray(sql`lower(${refs.followUsername})`, [...departures]),
          gt(refs.followDetectedAt, cutoff),
        ),
      );
    cancelledFollows = new Set(rows.map((r) => String(r.u)));
    if (cancelledFollows.size > 0) {
      await tx
        .delete(refs.followTable)
        .where(
          and(
            eq(refs.followTable.trackedAccountId, trackedAccountId),
            inArray(sql`lower(${refs.followUsername})`, [...cancelledFollows]),
            gt(refs.followDetectedAt, cutoff),
          ),
        );
    }
  }

  return {
    arrivals: arrivals.filter((a) => !cancelledUnfollows.has(a)),
    departures: departures.filter((d) => !cancelledFollows.has(d)),
  };
}
