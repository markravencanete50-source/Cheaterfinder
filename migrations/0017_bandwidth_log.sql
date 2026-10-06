-- Bandwidth attribution log: per (user, tracked profile, endpoint) scrape
-- transfer, time-bucketed by flush window. Powers the admin bandwidth panel.
-- The bandwidth-meter service also creates this lazily (CREATE TABLE IF NOT
-- EXISTS) so a missed migration never breaks scraping.

CREATE TABLE IF NOT EXISTS bandwidth_log (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(36),
  tracked_account_id VARCHAR(36),
  ig_username TEXT,
  endpoint TEXT NOT NULL,
  bytes_in BIGINT NOT NULL DEFAULT 0,
  bytes_out BIGINT NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bandwidth_log_occurred_at
  ON bandwidth_log (occurred_at);
CREATE INDEX IF NOT EXISTS idx_bandwidth_log_user
  ON bandwidth_log (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_bandwidth_log_account
  ON bandwidth_log (tracked_account_id, occurred_at);

-- system_settings already exists (scraper transport). The refresh cadence
-- setting reuses it under key 'scraper.refreshIntervalSec'. No DDL needed.
