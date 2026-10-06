-- 0045: remember each liked-by WATCHER bot's follow relationship with each
-- tracked target, so the squad stops re-probing friendships/show every sweep.
--
-- ensureWatcherFollows() was stateless: every 25-minute sweep, every watcher
-- probed GET friendships/<pk>/show/ for every distinct tracked target and then
-- did nothing, because the watcher already followed them. Measured on
-- 2026-09-02: 208 cycles x 7 targets = 1,456 probes by 17:30, every single one
-- "probed":7,"followed":0 — 100% re-confirming a state observed 25 minutes
-- earlier — plus 102 "follow probe failed" 400s from one watcher that were
-- retried on the same pairs every sweep. None of it is metered in
-- bot_daily_calls / scrape_outcome_log, and all of it lands on the six web
-- watcher bots the squad most needs alive (~2,250 calls/day projected).
--
-- With this table a pair is re-probed only when:
--   * there is no row yet (first sight), or
--   * the row says 'not_following' and the watcher CAN follow (web transport;
--     the probe is the guard before a Chromium follow, so it stays live), or
--   * the row is older than WATCHER_FOLLOW_REVERIFY_HOURS (default 24, 1..168).
-- 'following' / 'requested' pairs — the steady state — therefore cost one probe
-- per watcher per day instead of ~58. 'unavailable' (a hard non-checkpoint
-- probe failure, e.g. a target IG refuses with a plain 400) is retried after the
-- same window rather than every 25 minutes (lesson 5: retrying a deterministic
-- error is what bans accounts). A checkpoint still cools the WATCHER for 24h
-- (bot_accounts.cooldown_until) and writes nothing here — it is a bot verdict,
-- not a pair state.
--
-- The facepile HARVEST (the detection call) is untouched by this; only the
-- follow-probe bookkeeping changes.
--
-- Keyed per (bot, target): follow state is a property of the PAIR — two
-- watchers can legitimately disagree about the same target.
--
-- NOTE: no FOREIGN KEY to bot_accounts(id) is declared here. The migration is
-- applied by the coordinator and the `cheaterfinder` role was reported to lack
-- REFERENCES on some tables, so the table is created standalone. Orphan rows
-- for a deleted bot are harmless (they are only ever read keyed by a live
-- bot_id) and are bounded by the size of the tracked-target list. An opt-in
-- constraint is provided (commented) at the bottom for whoever holds the
-- privilege.
CREATE TABLE IF NOT EXISTS watcher_follow_state (
  bot_id varchar(36) NOT NULL,
  target_ig_user_id text NOT NULL,
  target_username text NOT NULL,
  state text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, target_ig_user_id),
  CONSTRAINT watcher_follow_state_state_check
    CHECK (state IN ('following', 'requested', 'not_following', 'unavailable'))
);

-- "Which watchers follow this target?" — the read pattern for coverage
-- diagnostics and for a future unfollow/cleanup pass when a target stops being
-- tracked. The harvester's own read ("this bot's rows for these targets") is
-- served by the primary key.
CREATE INDEX IF NOT EXISTS idx_watcher_follow_state_target
  ON watcher_follow_state (target_ig_user_id);

-- Optional, requires REFERENCES on bot_accounts (the `cheaterfinder` role owns
-- bot_accounts on the current production DB, so it can run this):
-- ALTER TABLE watcher_follow_state
--   ADD CONSTRAINT watcher_follow_state_bot_id_fkey
--   FOREIGN KEY (bot_id) REFERENCES bot_accounts(id) ON DELETE CASCADE;
