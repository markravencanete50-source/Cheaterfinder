-- 0020 (D7 fix): expression index for the case-insensitive likers_cache
-- lookup in server/workers.ts (persistLikeEvidenceFromLikersCache):
--
--     WHERE LOWER(lc.liker_username) = LOWER($1)
--
-- EXPLAIN on the live DB shows this as a Seq Scan over likers_cache because
-- the only username index (likers_cache_post_shortcode_liker_username_key)
-- is on the raw column and cannot serve a lower() comparison. The expression
-- index below makes the lookup an index scan.
--
-- Audited 2026-06-12: no other un-indexed LOWER() query exists on the cache
-- tables — comments_cache is only ever filtered by post_shortcode, and the
-- four follow/unfollow event tables get their
-- (tracked_account_id, lower(username), detected_at) indexes in migration
-- 0019_event_dedupe_unique.sql.

CREATE INDEX IF NOT EXISTS idx_likers_cache_lower_username
  ON likers_cache (lower(liker_username));
