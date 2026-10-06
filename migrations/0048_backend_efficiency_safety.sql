-- Additive only. Apply before deploying the corresponding application build.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS backend_operation_leases (
  key text PRIMARY KEY,
  token text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backend_operation_leases_expiry ON backend_operation_leases(expires_at);
CREATE TABLE IF NOT EXISTS scrape_capacity_log (
  id bigserial PRIMARY KEY, endpoint text NOT NULL, reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scrape_capacity_log_time ON scrape_capacity_log(occurred_at);
CREATE TABLE IF NOT EXISTS interactive_refresh_state (
  media_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('likers', 'comments')),
  succeeded_at timestamptz NOT NULL,
  PRIMARY KEY (media_id, kind)
);
CREATE TABLE IF NOT EXISTS mobile_auth_sessions (
  id text PRIMARY KEY,
  user_id varchar(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mobile_auth_sessions_user ON mobile_auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_mobile_auth_sessions_expiry ON mobile_auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS mobile_legacy_revocations (
  user_id varchar(36) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revoked_before timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key ON notifications(dedupe_key);
ALTER TABLE like_events ADD COLUMN IF NOT EXISTS evidence_source jsonb;
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS warm_failure_streak integer NOT NULL DEFAULT 0;
ALTER TABLE roster_sync_state ADD COLUMN IF NOT EXISTS viewer_bot_id varchar(36);
ALTER TABLE bandwidth_log ADD COLUMN IF NOT EXISTS byte_source text NOT NULL DEFAULT 'legacy_mixed';
ALTER TABLE bandwidth_log ADD COLUMN IF NOT EXISTS bot_id varchar(36);
ALTER TABLE bandwidth_log ADD COLUMN IF NOT EXISTS transport text;
ALTER TABLE bandwidth_log ADD COLUMN IF NOT EXISTS failures integer NOT NULL DEFAULT 0;
ALTER TABLE bandwidth_log ADD COLUMN IF NOT EXISTS resource_bytes jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMIT;
