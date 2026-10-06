-- Give reports real, HONEST content.
--
-- PROBLEM (two of them)
--   1. Thin: the table held 4 numbers (total_likes/follows/unfollows + peak hour)
--      and top_niche shipped hardcoded NULL. The Reports list could only render
--      "New followers / Unfollows / Likes / Peak hour" — not a digest.
--   2. WRONG: total_follows/total_unfollows come from follow/follower event
--      tables, which record roster DISCOVERY, not activity. Live examples:
--        @example_account  674 followers → card claimed "+3,251 new followers"
--        @wire.fluid      488 followers → card claimed "+7,031 / 7,108 unfollows"
--      Numbers a client can disprove by glancing at the profile.
--
-- FIX
--   Store the same payload the PDF renders (server/services/report-data.ts),
--   which derives growth from profile snapshots (Instagram's own follower count)
--   and carries trust flags so discovery noise is never shown as activity.
--   A single jsonb keeps the shape free to evolve without a migration per field.
ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS metrics jsonb;

COMMENT ON COLUMN reports.metrics IS
  'Rich report payload (summary/profile/ownPosts/content/previous) from buildReportData. Authoritative for the UI; total_* columns are legacy and may hold roster-discovery noise.';

-- Legacy rows have no metrics yet; the worker backfills on next generation.
CREATE INDEX IF NOT EXISTS idx_reports_account_created
  ON reports (tracked_account_id, created_at DESC);
