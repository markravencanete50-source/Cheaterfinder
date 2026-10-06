-- Provision durable bootstrap state during deployment rather than requiring
-- schema-creation privileges from the running application.
CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by varchar(36)
);

-- Account and subscription events are recorded in the same short transaction
-- as the underlying change. Provider requests happen later, outside DB locks.
CREATE TABLE IF NOT EXISTS transactional_emails (
  id varchar(64) PRIMARY KEY,
  user_id varchar(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  accepted_at timestamptz,
  skipped_at timestamptz,
  provider_id text,
  last_error text
);
CREATE INDEX IF NOT EXISTS transactional_emails_pending_idx
  ON transactional_emails(next_attempt_at) WHERE accepted_at IS NULL AND skipped_at IS NULL;
