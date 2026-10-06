-- Wave 4: bot credentials + auto-login support
--
-- Adds the columns we need to *re-login* a bot autonomously when its
-- session_data goes stale. Previously the system only stored the cookie
-- envelope (session_data) and the bot was dead the moment IG invalidated
-- those cookies. With these columns the worker can:
--   1. fetch a sticky proxy endpoint
--   2. drive a Playwright login with the encrypted IG password
--   3. read IG's verification code straight from the bot's mailbox
--   4. write fresh cookies back into session_data
--
-- All credential columns are stored as v1: AES-256-GCM envelopes (see
-- server/crypto/credentials.ts) and never logged.

BEGIN;

-- session_data was NOT NULL because legacy import always supplied a blob.
-- New flow can seed a bot with creds only and obtain cookies via auto-login,
-- so allow it to be empty until first successful login.
ALTER TABLE bot_accounts
  ALTER COLUMN session_data DROP NOT NULL;

ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS ig_password_encrypted text,
  ADD COLUMN IF NOT EXISTS email_address text,
  ADD COLUMN IF NOT EXISTS email_password_encrypted text,
  ADD COLUMN IF NOT EXISTS imap_host text DEFAULT 'imap.rambler.ru',
  ADD COLUMN IF NOT EXISTS imap_port integer DEFAULT 993,
  ADD COLUMN IF NOT EXISTS proxy_endpoint text,
  ADD COLUMN IF NOT EXISTS proxy_session_id text,
  ADD COLUMN IF NOT EXISTS proxy_expires_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_login_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_login_error text,
  ADD COLUMN IF NOT EXISTS login_attempt_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bot_accounts_proxy_expires
  ON bot_accounts (proxy_expires_at)
  WHERE proxy_expires_at IS NOT NULL;

COMMIT;
