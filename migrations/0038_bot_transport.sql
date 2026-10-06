-- 0038: mobile-session read transport.
--
-- Adds a `transport` discriminator to bot_accounts so pre-authenticated
-- Instagram MOBILE sessions (Bearer IGT:2 token + Android device fingerprint,
-- replayed against i.instagram.com by server/ig-mobile-read-client.ts) can live
-- in the same pool as web/browser bots.
--
--   'web'    → default; existing behaviour. session_data is a Playwright
--              storage-state (sessionid + csrftoken cookies), driven by the
--              web HTTP client or the Firefox/FastAPI browser client.
--   'mobile' → session_data is an encrypted mobile envelope (see
--              server/services/mobile-session.ts). Routed to the mobile client,
--              which needs NO automation_identity and NO csrftoken.
--
-- Every existing row defaults to 'web', so web behaviour is unchanged.
ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'web';

CREATE INDEX IF NOT EXISTS idx_bot_accounts_transport
  ON bot_accounts (transport);
