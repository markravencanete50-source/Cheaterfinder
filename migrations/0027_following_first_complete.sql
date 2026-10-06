-- Distinguish roster DISCOVERY from genuinely-new follows.
--
-- PROBLEM
--   follow_events records "we first saw that this profile follows X" — not "they
--   just followed X". The first full enumeration therefore emits one event per
--   account already followed, and any later re-enumeration after a partial read
--   re-emits the gap. The UI's "Recently followed" column showed the raw table:
--     @complex           16,071 "recently followed"  — actually follows 1,090
--     @tracked_user_2   6,845                      — actually follows   984
--     @tracked_user_5  3,116                      — actually follows     0
--   i.e. a data dump, not recent activity.
--
-- FIX
--   Record WHEN each account's following roster was first completely enumerated.
--   After that instant we hold the whole roster, so every subsequent follow_event
--   is a real, new follow and can honestly be shown as "Recently followed".
--
--   Backfilled from last_following_refresh_at (migration 0025's per-roster
--   anchor): that is a known-complete enumeration, so events after it are
--   genuine. Accounts never fully enumerated stay NULL and show nothing until
--   they are — deliberately empty rather than dumping discovery noise.
ALTER TABLE tracked_accounts
  ADD COLUMN IF NOT EXISTS following_first_complete_at timestamptz;

UPDATE tracked_accounts
SET following_first_complete_at = last_following_refresh_at
WHERE last_following_refresh_at IS NOT NULL
  AND following_first_complete_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tracked_accounts_following_first_complete
  ON tracked_accounts (following_first_complete_at);
