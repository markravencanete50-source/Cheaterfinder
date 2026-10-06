-- Keep existing sessions valid until THIS customer's credentials change.
-- A version also rejects an old in-flight login/session write after revocation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_session_legacy_user ON session ((sess::jsonb #>> '{passport,user}'));
CREATE INDEX IF NOT EXISTS idx_session_versioned_user ON session ((sess::jsonb #>> '{passport,user,id}'));
COMMIT;
