-- Make the roster real state instead of re-deriving it from its own event log.
--
-- PROBLEM
--   There was no roster table. "Who does this account currently follow?" was
--   reconstructed on every read as: every follow_event with no newer
--   unfollow_event (fetchKnownFollowingSet / roster.ts / the collector all ran
--   variants of the same query). The event log was being used as mutable state.
--
--   That derivation is lossy, and the diff wrote its own input:
--     read roster -> diff vs derived set -> write events -> derived set changes
--   One short or differently-paginated read permanently corrupts the baseline,
--   and the next read "repairs" it by emitting the difference as fresh activity.
--   The loop never converges. Measured on live data (2026-07-15):
--
--     @example_account   IG: 215 following, unchanged for hours (zero real churn)
--                       derived roster: 170  -> permanently 45 short
--                       emitted EVERY ~90min cycle: ~45 follows + ~32 unfollows
--                       7d totals: 860 follows / 859 unfollows  (all fabricated)
--       target `e90_alva`: followed 8x and unfollowed 7x in one week.
--
--     distinct targets ≈ the account's real following count, re-emitted 4-6x:
--       complex 5,909 events / 1,086 distinct (follows 1,090)   = 5.4x
--       sample_account 1,264 / 208 (follows 209)             = 6.1x
--     @tracked_user_5 IG says 0 following; derived roster claimed 706.
--
--   The completeness gate (diff-completeness.ts) only guards the UNFOLLOW side
--   and assumed new follows are "additive-safe". They are not: once the derived
--   baseline drifts low, every complete read re-reports long-standing follows as
--   brand new. This is the root cause behind the wrong weekly cards, the
--   "Recently Followed" data dump, and the inflated report totals.
--
-- FIX
--   Materialize the roster, and require CONFIRMATION before believing a member
--   is gone. Instagram's paginated enumeration returns a slightly different
--   subset each pass, so absence from a single read means nothing; absence from
--   N consecutive complete reads means something.
--
--   Events become a derived audit trail of confirmed transitions, never an input.
CREATE TABLE IF NOT EXISTS roster_members (
  id                 varchar(36)  PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_account_id varchar(36)  NOT NULL REFERENCES tracked_accounts(id) ON DELETE CASCADE,
  -- 'following' = accounts this profile follows; 'follower' = accounts following it.
  dimension          text         NOT NULL CHECK (dimension IN ('following', 'follower')),
  -- Matching key. IG usernames are case-insensitive; the display form lives in
  -- `username` and is refreshed on every sighting.
  username_lower     text         NOT NULL,
  username           text         NOT NULL,
  display_name       text,
  -- Serving fields. They live here rather than being joined back out of
  -- follower_events because a silently-seeded member has NO event row: the old
  -- enrichment join would return an empty roster for every settled account.
  ig_user_id         text,
  pfp_url            text,
  first_seen_at      timestamptz  NOT NULL DEFAULT now(),
  last_seen_at       timestamptz  NOT NULL DEFAULT now(),
  -- Consecutive COMPLETE reads in which this member was absent. Reset to 0 on
  -- every sighting. The hysteresis that makes pagination churn a non-event.
  missing_streak     integer      NOT NULL DEFAULT 0,
  is_current         boolean      NOT NULL DEFAULT true,
  left_at            timestamptz
);

-- Named explicitly (rather than an inline UNIQUE) so the constraint name matches
-- shared/schema.ts and ON CONFLICT targets stay stable.
CREATE UNIQUE INDEX IF NOT EXISTS roster_members_account_dim_username
  ON roster_members (tracked_account_id, dimension, username_lower);

-- Hot path: reconcile reads the whole live roster for one account+dimension.
CREATE INDEX IF NOT EXISTS idx_roster_members_account_dim_current
  ON roster_members (tracked_account_id, dimension, is_current);

-- Serving path: roster.ts pages newest-first by first_seen_at.
CREATE INDEX IF NOT EXISTS idx_roster_members_account_dim_first_seen
  ON roster_members (tracked_account_id, dimension, is_current, first_seen_at DESC);

-- Per-(account, dimension) reconcile bookkeeping.
CREATE TABLE IF NOT EXISTS roster_sync_state (
  tracked_account_id    varchar(36) NOT NULL REFERENCES tracked_accounts(id) ON DELETE CASCADE,
  dimension             text        NOT NULL CHECK (dimension IN ('following', 'follower')),
  -- When the first COMPLETE read established the baseline. Members present at
  -- seed are pre-existing, not new follows, so seeding emits NO events. Until
  -- this is set we cannot tell discovery from activity and stay silent.
  seeded_at             timestamptz,
  -- Number of COMPLETE reads absorbed so far. The gate accepts a read at >=90%
  -- of IG's reported count, and IG's own number overshoots (ghosts/deactivated),
  -- so ONE read is not a trustworthy baseline: the missing tail would surface as
  -- fake "new follows" later. We union the first ROSTER_SETTLE_READS complete
  -- reads into the baseline in silence, which covers pagination variance.
  complete_reads        integer     NOT NULL DEFAULT 0,
  -- Set once complete_reads reaches the settle threshold. Only AFTER this do we
  -- believe additions/removals are real activity and emit events.
  settled_at            timestamptz,
  last_complete_read_at timestamptz,
  last_member_count     integer,
  PRIMARY KEY (tracked_account_id, dimension)
);

-- Deliberately NOT backfilled from the event-derived set: that set is the
-- corrupted value we are removing (170 vs a true 215). Seeding from it would
-- bake the drift in and emit 45 false follows on the next read. Instead every
-- account seeds from its next COMPLETE read straight off Instagram — one silent
-- cycle to a truthful baseline, then real data only.
COMMENT ON TABLE roster_members IS
  'Materialized follower/following roster. Source of truth for "who is currently in the roster". follow_events/unfollow_events are a derived audit trail of CONFIRMED transitions and must never be used to reconstruct roster state.';
