-- Wave 6: bot account warming.
--
-- IG flags fresh accounts (zero history) on the higher-trust endpoints —
-- stories, highlights, reels, tagged feed. The mitigation is "warming":
-- a daily 30-min low-volume browsing session per bot (feed, profile views,
-- search) that gradually escalates over 5-7 days until IG's heuristics treat
-- the bot as a normal returning user.
--
-- We track each bot's progress through the ramp via `warming_day` (0..7).
-- The daily scheduler increments this on each successful warm session.
-- Once `warming_day >= 7` the bot is "fully warmed" and the scheduler
-- stops enqueueing warm jobs for it.
--
-- `last_warming_at` lets the scheduler skip bots that just ran a warm
-- session (avoid double-burning) and lets the admin status endpoint
-- surface "next warming due" timing.

BEGIN;

ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS warming_day integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_warming_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_bot_accounts_warming_day
  ON bot_accounts (warming_day)
  WHERE warming_day < 7;

COMMIT;
