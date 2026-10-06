-- Rotate liked-post evidence collection through the full following roster.
-- Existing installations repeatedly scanned the first 20 rows, so start at
-- 20 to move past the slice that has already received the most coverage.
ALTER TABLE "tracked_accounts"
  ADD COLUMN IF NOT EXISTS "like_evidence_cursor" integer NOT NULL DEFAULT 20;

ALTER TABLE "tracked_accounts"
  ADD COLUMN IF NOT EXISTS "last_like_evidence_scan_at" timestamp with time zone;
