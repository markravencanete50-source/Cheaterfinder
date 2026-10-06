-- Wave 5: per-scrape outcome history.
--
-- Append-only log of every IG scrape attempt so we can compute long-window
-- success rates and spot per-bot failure clusters across deploys. The
-- in-memory rolling counters in server/services/scrape-metrics.ts feed the
-- live admin /health endpoint; this table is the durable backing store.
--
-- Inserts are fire-and-forget from recordOutcome() so a flaky DB never
-- blocks the scrape path. Bot id is nullable because login failures may
-- happen before any bot is leased.

CREATE TABLE IF NOT EXISTS scrape_outcome_log (
  id BIGSERIAL PRIMARY KEY,
  bot_id VARCHAR(36) REFERENCES bot_accounts(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  error_kind TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scrape_outcome_log_occurred_at
  ON scrape_outcome_log (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_scrape_outcome_log_endpoint_occurred_at
  ON scrape_outcome_log (endpoint, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_scrape_outcome_log_bot_id_occurred_at
  ON scrape_outcome_log (bot_id, occurred_at DESC);
