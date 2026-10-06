-- Store playable video URLs for reels/video posts so the UI can render the
-- actual media instead of only the cover frame.
ALTER TABLE "posts_cache"
  ADD COLUMN IF NOT EXISTS "video_url" text;
