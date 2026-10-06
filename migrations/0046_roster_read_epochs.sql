-- 0046: roster read EPOCHS (audit 2026-09-02, lane C2).
--
-- Instagram refuses deep pagination (HTTP 400 past a few pages), so one roster
-- is read across several cycles through the resume cursor added in 0039. The
-- unfollow side of the diff, however, still judged each capture on its own: a
-- departure was recorded only when ONE capture covered >= 90% of the held
-- roster (roster-store ROSTER_READ_COVERAGE). No leg of a resumed walk ever
-- does, so absence was never evaluated and lost-follower detection was dead
-- for 6 of the 7 walked accounts — last complete follower read
-- @example_account 07-25, @tracked_user_2 08-15, @sample_account 08-27,
-- @tracked_user_3 08-31; only @tracked_user_1 had any departures in 14 days — while the
-- walks themselves DID reach the end (tracked_accounts.last_followers_refresh_at
-- advanced for every one of them on 09-02).
--
-- An epoch is the resumed sequence cursor NULL -> ... -> exhausted, treated as
-- ONE logical read. Sightings accumulate across its legs (a member is "seen in
-- the epoch" when roster_members.last_seen_at >= epoch_started_at) and
-- absence, missing_streak, departures and last_complete_read_at are judged
-- once, when the epoch ends. A leg that restarts from a NULL cursor resets the
-- epoch; a partial epoch never yields departures.
ALTER TABLE roster_sync_state
  ADD COLUMN IF NOT EXISTS epoch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS epoch_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS epoch_start_member_count integer,
  ADD COLUMN IF NOT EXISTS epoch_legs integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN roster_sync_state.epoch_started_at IS
  'When the current (or latest) read epoch began: the transaction time of the leg that started at cursor NULL. Sightings at/after it belong to the epoch.';
COMMENT ON COLUMN roster_sync_state.epoch_completed_at IS
  'When the epoch that began at epoch_started_at reached the end of the list. NULL while a multi-leg walk is still in progress.';
COMMENT ON COLUMN roster_sync_state.epoch_start_member_count IS
  'last_member_count when the epoch began; the epoch''s growth (settling) is measured against it, not against the previous leg.';
COMMENT ON COLUMN roster_sync_state.epoch_legs IS
  'Captures folded into the current/latest epoch (1 = the whole list was read in one cycle).';
