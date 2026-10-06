-- Posts: pinned flag + carousel children media.
-- is_pinned: post is pinned to the profile grid (timeline_pinned_user_ids includes owner).
-- carousel_media: ordered child media for carousel/sidecar posts (jsonb array of
--   { type: 'photo'|'video', displayUrl: string, videoUrl: string|null }). NULL for single-media posts.
ALTER TABLE posts_cache ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT false;
ALTER TABLE posts_cache ADD COLUMN IF NOT EXISTS carousel_media jsonb;
