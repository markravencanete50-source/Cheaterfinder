-- Wave 5: likers cache. Stores the users who liked a post via
-- /api/v1/media/<media_id>/likers/. IG caps that endpoint at ~100 users
-- and exposes no pagination cursor, so we persist whatever we receive.
-- Idempotent: re-scraping the same post upserts via ON CONFLICT
-- (post_shortcode, liker_username) DO NOTHING.
CREATE TABLE IF NOT EXISTS likers_cache (
  id BIGSERIAL PRIMARY KEY,
  post_shortcode TEXT NOT NULL,
  liker_username TEXT NOT NULL,
  liker_display_name TEXT,
  liker_pfp_url TEXT,
  liker_ig_user_id TEXT,
  is_verified BOOLEAN DEFAULT false,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_shortcode, liker_username)
);
CREATE INDEX IF NOT EXISTS idx_likers_post ON likers_cache(post_shortcode, cached_at DESC);
