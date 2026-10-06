-- 0040: remember which followed accounts actually POST.
--
-- The liked-post scan rotates blindly through a tracked user's following list.
-- Most of those accounts are dormant: only 284 of 1,741 cached posts are from
-- the last 30 days (16%). Every dormant owner still costs a profile fetch plus
-- a posts fetch, yields no candidate inside the freshness window, and returns
-- zero liker reads — so the scarce budget is spent discovering, over and over,
-- that the same people have not posted.
--
-- Recording each owner's newest post lets the rotation put active posters
-- first, which is where a tracked user's NEW likes can actually be.
ALTER TABLE roster_members
  ADD COLUMN IF NOT EXISTS last_post_at timestamptz,
  ADD COLUMN IF NOT EXISTS posts_checked_at timestamptz;

-- Rotation lookup: active posters first, then never-checked, then dormant.
CREATE INDEX IF NOT EXISTS idx_roster_members_post_activity
  ON roster_members (tracked_account_id, dimension, last_post_at DESC NULLS FIRST)
  WHERE is_current = true;
