-- Cursor-based older-post pagination for the on-demand "Load more" path.
-- posts_next_cursor: IG next_max_id to continue paging OLDER posts from, so each
--   load-more click fetches only the next page instead of re-paging from the top.
-- posts_pagination_done: true once IG reports no more older posts (drives hasMore).
ALTER TABLE tracked_accounts ADD COLUMN IF NOT EXISTS posts_next_cursor text;
ALTER TABLE tracked_accounts ADD COLUMN IF NOT EXISTS posts_pagination_done boolean NOT NULL DEFAULT false;
