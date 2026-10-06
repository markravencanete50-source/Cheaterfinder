-- Wave 6: per-endpoint 3-strikes auto-disable.
--
-- When endpoint X returns auth-rejection (401/403/CSRF/auth_rejected/
-- checkpoint_required) on bot A → endpoint X marked "warning". When the
-- same endpoint fails on a 2nd bot → "risky". On a 3rd different bot →
-- the endpoint is disabled pool-wide for 24h. After 24h the row in
-- endpoint_disabled is auto-cleared on next read; a successful call also
-- resets counters.
--
-- endpoint_strikes records every auth-class failure with bot identity so
-- "3 distinct bots in 1h" is a simple SELECT COUNT(DISTINCT bot_id).
-- endpoint_disabled is a singleton row per endpoint while the cooldown
-- is in effect.

CREATE TABLE IF NOT EXISTS endpoint_strikes (
  endpoint TEXT NOT NULL,
  bot_id VARCHAR(36) NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint, bot_id, failed_at)
);

CREATE INDEX IF NOT EXISTS idx_endpoint_strikes_endpoint_at
  ON endpoint_strikes(endpoint, failed_at DESC);

CREATE TABLE IF NOT EXISTS endpoint_disabled (
  endpoint TEXT PRIMARY KEY,
  disabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled_again_at TIMESTAMPTZ NOT NULL,
  reason TEXT
);
