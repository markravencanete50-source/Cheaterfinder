-- Additive durable progress for separately scheduled, bounded roster batches.
-- The existing roster_sync_state cursor/epoch remains the only resume point.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS roster_background_sync (
  tracked_account_id varchar(36) NOT NULL REFERENCES tracked_accounts(id) ON DELETE CASCADE,
  dimension text NOT NULL CHECK (dimension IN ('follower','following')),
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','graphql')),
  status text NOT NULL DEFAULT 'pending',
  baseline_complete_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  epoch_expected_count integer,
  epoch_seen_count integer NOT NULL DEFAULT 0,
  pages_completed integer NOT NULL DEFAULT 0,
  last_batch_count integer NOT NULL DEFAULT 0,
  last_started_at timestamptz,
  last_progress_at timestamptz,
  last_error text,
  PRIMARY KEY (tracked_account_id, dimension)
);
CREATE INDEX IF NOT EXISTS idx_roster_background_due ON roster_background_sync(next_run_at);
COMMIT;
