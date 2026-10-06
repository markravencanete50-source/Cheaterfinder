-- Wave 4: Real public-data caching (stories, highlights, posts, inbound followers)
-- Idempotent: safe to re-run.

BEGIN;

-- ─── 1. Extend tracked_accounts with IG numeric PK ──────────────────────────

ALTER TABLE tracked_accounts
  ADD COLUMN IF NOT EXISTS ig_user_id text;

CREATE INDEX IF NOT EXISTS idx_tracked_accounts_ig_user_id
  ON tracked_accounts (ig_user_id);

-- ─── 2. Extend profile_snapshots with rich profile fields ───────────────────

ALTER TABLE profile_snapshots
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS biography text,
  ADD COLUMN IF NOT EXISTS profile_pic_url text,
  ADD COLUMN IF NOT EXISTS profile_pic_url_hd text,
  ADD COLUMN IF NOT EXISTS external_url text,
  ADD COLUMN IF NOT EXISTS is_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_business_account boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_private boolean DEFAULT false;

-- ─── 3. Inbound follower events (someone followed the tracked user) ─────────

CREATE TABLE IF NOT EXISTS follower_events (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_account_id varchar(36) NOT NULL
    REFERENCES tracked_accounts(id) ON DELETE CASCADE,
  follower_username text NOT NULL,
  follower_display_name text,
  follower_ig_user_id text,
  follower_pfp_url text,
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_follower_events_tracked_account_id
  ON follower_events (tracked_account_id);
CREATE INDEX IF NOT EXISTS idx_follower_events_detected_at
  ON follower_events (detected_at);
CREATE INDEX IF NOT EXISTS idx_follower_events_account_detected
  ON follower_events (tracked_account_id, detected_at);

-- ─── 4. Inbound follower-unfollow events ────────────────────────────────────

CREATE TABLE IF NOT EXISTS follower_unfollow_events (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_account_id varchar(36) NOT NULL
    REFERENCES tracked_accounts(id) ON DELETE CASCADE,
  unfollower_username text NOT NULL,
  unfollower_display_name text,
  unfollower_ig_user_id text,
  unfollower_pfp_url text,
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_follower_unfollow_events_tracked_account_id
  ON follower_unfollow_events (tracked_account_id);
CREATE INDEX IF NOT EXISTS idx_follower_unfollow_events_detected_at
  ON follower_unfollow_events (detected_at);
CREATE INDEX IF NOT EXISTS idx_follower_unfollow_events_account_detected
  ON follower_unfollow_events (tracked_account_id, detected_at);

-- ─── 5. Posts cache (tracked user's OWN posts) ──────────────────────────────

CREATE TABLE IF NOT EXISTS posts_cache (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_account_id varchar(36) NOT NULL
    REFERENCES tracked_accounts(id) ON DELETE CASCADE,
  shortcode text NOT NULL,
  media_id text,
  post_type post_type NOT NULL DEFAULT 'photo',
  thumbnail_url text,
  display_url text,
  caption text,
  like_count integer DEFAULT 0,
  comment_count integer DEFAULT 0,
  video_view_count integer,
  taken_at timestamptz,
  location_name text,
  hashtags text[] NOT NULL DEFAULT '{}'::text[],
  cached_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_posts_cache_tracked_account_id
  ON posts_cache (tracked_account_id);
CREATE INDEX IF NOT EXISTS idx_posts_cache_account_taken
  ON posts_cache (tracked_account_id, taken_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_cache_account_shortcode
  ON posts_cache (tracked_account_id, shortcode);

-- ─── 6. Stories cache (24h TTL) ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stories_cache (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_account_id varchar(36) NOT NULL
    REFERENCES tracked_accounts(id) ON DELETE CASCADE,
  story_id text NOT NULL,
  media_type text NOT NULL,
  media_url text NOT NULL,
  thumbnail_url text,
  taken_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  cached_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stories_cache_tracked_account_id
  ON stories_cache (tracked_account_id);
CREATE INDEX IF NOT EXISTS idx_stories_cache_expires_at
  ON stories_cache (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stories_cache_account_story
  ON stories_cache (tracked_account_id, story_id);

-- ─── 7. Highlights cache ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS highlights_cache (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_account_id varchar(36) NOT NULL
    REFERENCES tracked_accounts(id) ON DELETE CASCADE,
  highlight_id text NOT NULL,
  title text NOT NULL,
  cover_url text,
  media_count integer DEFAULT 0,
  cached_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_highlights_cache_tracked_account_id
  ON highlights_cache (tracked_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_highlights_cache_account_highlight
  ON highlights_cache (tracked_account_id, highlight_id);

-- ─── 8. Highlight inner items ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS highlight_items_cache (
  id varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  highlight_cache_id varchar(36) NOT NULL
    REFERENCES highlights_cache(id) ON DELETE CASCADE,
  story_id text NOT NULL,
  media_type text NOT NULL,
  media_url text,
  thumbnail_url text,
  taken_at timestamptz,
  cached_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_highlight_items_cache_highlight
  ON highlight_items_cache (highlight_cache_id);

COMMIT;
