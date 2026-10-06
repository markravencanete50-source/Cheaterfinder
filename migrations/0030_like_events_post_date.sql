-- Order liked posts by when the POST was published, not when we noticed the like.
--
-- PROBLEM
--   like_events stored only detected_at — the moment our collector inferred the
--   like. Every surface (dashboard gallery, reports, PDF) therefore ordered
--   liked posts by DETECTION time, which has no relationship to the post's own
--   recency: a week-old post inferred five minutes ago outranked a post
--   published this morning. Reported as "liked post order off".
--
-- FIX
--   Persist the post's own taken_at (Instagram sends it on every feed media;
--   the parser was simply dropping it) and order by it, newest post first.
--
--   Existing rows have no post date and cannot get one retroactively without
--   re-fetching each post, so readers COALESCE to detected_at. Those rows keep
--   their current (detection-ordered) position and are corrected naturally as
--   posts are re-seen.
ALTER TABLE like_events
  ADD COLUMN IF NOT EXISTS post_taken_at timestamptz;

COMMENT ON COLUMN like_events.post_taken_at IS
  'When the liked post was published (IG taken_at). NULL for rows captured before migration 0030; readers COALESCE to detected_at. detected_at is when WE inferred the like and must never be shown as the post date.';

-- Backs the newest-post-first ordering per account.
CREATE INDEX IF NOT EXISTS idx_like_events_account_post_taken
  ON like_events (tracked_account_id, post_taken_at DESC NULLS LAST);
