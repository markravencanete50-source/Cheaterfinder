-- Independent recent-observation clock. Never substitutes for the full epoch.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE roster_background_sync
  ADD COLUMN IF NOT EXISTS next_head_run_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_head_read_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_head_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS head_status text NOT NULL DEFAULT 'pending';
COMMIT;
