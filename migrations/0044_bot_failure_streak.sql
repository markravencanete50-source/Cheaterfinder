-- Dead-session escalation (2026-09-02). A bot whose IG session is dead kept
-- answering every lease with an auth-class failure (mobile 401/403, HTTP 400
-- checkpoint/challenge_required, login-wall HTML on likers) and was only ever
-- parked for a flat 10-30 minutes — ~450 doomed IG calls/day across three
-- bots alone. The scraper now counts consecutive HARD failures per bot and
-- escalates the timed cooldown (3-5 → 6h, ≥6 → 24h; mobile ≥6 → parked as
-- session_expired). Rate limits and network faults never touch the streak,
-- and any successful call resets it.
ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS consecutive_hard_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_hard_failure_at timestamptz;
