ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS automation_identity jsonb;

COMMENT ON COLUMN bot_accounts.automation_identity IS
  'Persistent local FastAPI invisible-playwright/pyhttpz Firefox identity per bot.';
