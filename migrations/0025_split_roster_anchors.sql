-- Split the single graph-refresh anchor into per-roster anchors.
--
-- Bug: `last_graph_refresh_at` was only advanced when BOTH the following AND the
-- followers enumeration completed in the same cycle:
--     if (anyEnumerated && followingAnchorSafe && followersAnchorSafe) { ... }
-- The two rosters are independent, so an un-enumerable FOLLOWERS list poisoned
-- the FOLLOWING side. Real case (client-watched @sample_account): following
-- enumerated perfectly (209 items, complete, stopReason=exhausted) while the
-- followers walk failed/capped (9.5k followers). The anchor therefore stayed
-- NULL, computeRosterSyncState() returned "syncing" instead of "capped", and
-- isUnfollowRosterTrusted() hid all 1,130 of that account's real unfollow events
-- from the UI — the "unfollowed nahi load ho raha" report.
--
-- Fix: track each roster's own last completed enumeration.
ALTER TABLE tracked_accounts
  ADD COLUMN IF NOT EXISTS last_following_refresh_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_followers_refresh_at timestamptz;

-- Backfill: preserve today's behaviour for accounts that already had a
-- both-complete anchor. Accounts whose anchor was blocked (NULL) stay NULL and
-- are re-anchored by the next cycle that completes that specific roster.
UPDATE tracked_accounts
SET last_following_refresh_at = last_graph_refresh_at,
    last_followers_refresh_at = last_graph_refresh_at
WHERE last_graph_refresh_at IS NOT NULL
  AND last_following_refresh_at IS NULL
  AND last_followers_refresh_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tracked_accounts_last_following_refresh
  ON tracked_accounts (last_following_refresh_at);
CREATE INDEX IF NOT EXISTS idx_tracked_accounts_last_followers_refresh
  ON tracked_accounts (last_followers_refresh_at);
