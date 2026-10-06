-- Cache each following-roster owner's privacy verdict so the like-evidence scan
-- stops re-fetching every owner's PROFILE every cycle. The scan only ever used
-- that call to learn isPrivate + igUserId, and ig_user_id was already cached
-- for 100% of owners; the profile re-read alone was ~4,400 mobile calls/day and
-- capped 43 of 53 mobile bots' profile budget by early afternoon.
ALTER TABLE roster_members
  ADD COLUMN IF NOT EXISTS owner_is_private boolean,
  ADD COLUMN IF NOT EXISTS owner_profile_checked_at timestamptz;
