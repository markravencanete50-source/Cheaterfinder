-- Wave 6: per-endpoint canary trial state. Tracks whether the canary tier
-- has tested an Instagram endpoint enough times (>= 3 attempts) with a
-- high-enough success rate (>= 80%) within the trailing 24h window for the
-- worker pool to start using it. Workers refuse endpoints that aren't yet
-- pool_approved; canaries probe them on the workers' behalf.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS endpoint_canary_state (
  endpoint TEXT PRIMARY KEY,
  last_tested_at TIMESTAMPTZ,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  pool_approved BOOLEAN NOT NULL DEFAULT false,
  pool_approved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_endpoint_canary_pool_approved
  ON endpoint_canary_state(pool_approved);
