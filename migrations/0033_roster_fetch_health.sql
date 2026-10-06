-- Persist graph-list failures separately from roster completeness.
--
-- A legacy refresh timestamp only means an old enumeration once finished; it
-- does not prove the materialized roster introduced in 0029 was seeded. These
-- fields let the worker back off a specifically restricted list and let the UI
-- report that state without pretending an empty roster is complete/capped.
ALTER TABLE roster_sync_state
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_kind text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_roster_sync_state_next_retry
  ON roster_sync_state (next_retry_at)
  WHERE next_retry_at IS NOT NULL;

COMMENT ON COLUMN roster_sync_state.failure_kind IS
  'Latest fetch failure class: list_restricted, rate_limited, auth, or unavailable. Cleared by the next usable capture.';
COMMENT ON COLUMN roster_sync_state.next_retry_at IS
  'Do not issue another expensive graph request before this instant. Content/profile refreshes continue normally.';
