-- Wave 6: bot tier system. Limits the blast radius of risky operations by
-- restricting them to canary bots first, then promoting endpoints to the
-- worker pool only after they've been validated.
--
-- Tiers:
--   canary  - small set of bots that take experimental traffic first
--   worker  - main pool, only runs operations the canary has already proven
--   reserve - warmed up but not in active rotation (NEVER picked by assignment)
--   retired - permanently disabled (e.g. banned, session_expired beyond repair)
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bot_tier') THEN
    CREATE TYPE bot_tier AS ENUM ('canary', 'worker', 'reserve', 'retired');
  END IF;
END
$$;

ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS tier bot_tier NOT NULL DEFAULT 'reserve';

CREATE INDEX IF NOT EXISTS idx_bot_accounts_tier ON bot_accounts(tier);
