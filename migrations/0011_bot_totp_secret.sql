-- Wave 7: TOTP (Google Authenticator-style) 2FA support for bot accounts.
--
-- New bots provisioned for Wave 7 use TOTP-based 2FA instead of email OTP.
-- The shared Base32 secret captured at provisioning time is stored here and
-- consumed by the auto-login worker to generate the current 6-digit code
-- when IG presents the 2FA prompt.
--
-- The column is nullable because:
--   * legacy bots (tracked_user_8 cohort, onet.pl mailboxes) still use the
--     email-OTP path and have no TOTP secret
--   * new bots may not have provisioned 2FA yet at insert time
--
-- Idempotent — safe to run repeatedly (IF NOT EXISTS).
ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS totp_secret TEXT NULL;

COMMENT ON COLUMN bot_accounts.totp_secret IS
  'Base32-encoded TOTP shared secret (Google Authenticator-compatible). '
  'NULL means this bot uses email-OTP or no 2FA. '
  'Whitespace tolerated — bot-login normalizes before generating codes.';
