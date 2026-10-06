-- Wave 5: comments cache. Stores actual comment text/author/likes for posts
-- so the UI can render the comments list without re-scraping every open.
-- Idempotent: re-scraping the same post upserts via ON CONFLICT (post_shortcode, ig_comment_pk).
CREATE TABLE IF NOT EXISTS comments_cache (
  id BIGSERIAL PRIMARY KEY,
  post_shortcode TEXT NOT NULL,
  ig_comment_pk TEXT NOT NULL,
  author_username TEXT NOT NULL,
  author_display_name TEXT,
  author_pfp_url TEXT,
  text TEXT NOT NULL,
  like_count INT NOT NULL DEFAULT 0,
  created_at_ig TIMESTAMPTZ,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_shortcode, ig_comment_pk)
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments_cache(post_shortcode, created_at_ig DESC);
