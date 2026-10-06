-- Wave 9: "liked-by inference" squad.
--
-- Instagram removed the public "posts a user liked" API. But a logged-in
-- account's HOME feed (POST /api/v1/feed/timeline/) and REELS feed
-- (POST /api/v1/clips/discover/) inject "suggested" posts that carry a
-- facepile of "people you follow who liked this". So we dedicate a few bot
-- accounts as WATCHERS that follow the tracked users, poll their own timeline +
-- reels feeds, and harvest which tracked users liked which posts. This is
-- SAMPLED INFERENCE — coverage is partial (only what IG happens to surface in a
-- watcher's feed), never a complete ledger.
--
-- This migration adds ONLY a role marker to bot_accounts so ops can designate
-- watcher bots. Harvested likes are written into the EXISTING `like_events`
-- table (owner_username = the liked post's owner; tracked_account_id = the
-- tracked user who liked it) — no new table. Idempotent: safe to re-run.
--
--   scraper       - default; normal public-data / follow-rotation bot
--   feed_watcher  - polls POST /api/v1/feed/timeline/ for liked-by facepiles
--   reels_watcher - polls POST /api/v1/clips/discover/ for liked-by facepiles

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bot_role') THEN
    CREATE TYPE bot_role AS ENUM ('scraper', 'feed_watcher', 'reels_watcher');
  END IF;
END
$$;

ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS role bot_role NOT NULL DEFAULT 'scraper';

-- ADD COLUMN ... NOT NULL DEFAULT already backfills existing rows on modern
-- Postgres; this UPDATE is a belt-and-suspenders no-op that also covers a
-- partially-applied state where the column was added nullable out of band.
UPDATE bot_accounts SET role = 'scraper' WHERE role IS NULL;

CREATE INDEX IF NOT EXISTS idx_bot_accounts_role ON bot_accounts(role);
