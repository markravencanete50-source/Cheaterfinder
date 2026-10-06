-- Wave 6: per-bot daily IG-call budget. Caps the number of calls a bot can
-- make to each public-data endpoint per UTC-day, ramping up with bot age so
-- a fresh account doesn't burn its quota in 30 minutes and trip IG's
-- "suspicious activity" heuristic.
--
-- One row per (bot_id, UTC date, normalized endpoint). The day rollover is
-- implicit via the natural key: a new day key = a fresh row at count = 0.
-- See server/behavior/daily-budget.ts for the age-based cap schedule and
-- the atomic check-and-increment via INSERT ... ON CONFLICT ... WHERE
-- count < cap.

CREATE TABLE IF NOT EXISTS bot_daily_calls (
  bot_id   VARCHAR(36) NOT NULL REFERENCES bot_accounts(id) ON DELETE CASCADE,
  day      DATE        NOT NULL,
  endpoint TEXT        NOT NULL,
  count    INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, day, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_bot_daily_calls_bot_day
  ON bot_daily_calls(bot_id, day);
