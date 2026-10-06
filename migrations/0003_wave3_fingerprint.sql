-- Wave 3 migration: per-bot device fingerprint + behavioral pacing columns.
--
-- Adds fields so each bot gets a stable (username-derived) browser identity
-- across sessions, a timezone-aware circadian schedule, and per-day counters
-- enforcing soft caps below IG's own limits. All columns are additive with
-- sensible defaults so existing rows continue to work without manual backfill.
--
-- See server/behavior/device-fingerprint.ts and server/behavior/caps.ts.

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "device_id" text;

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "device_user_agent" text;

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "ig_app_id" text DEFAULT '936619743392459';

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'America/New_York';

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "locale" text DEFAULT 'en-US';

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "awake_hour_start" smallint DEFAULT 10;

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "awake_hour_end" smallint DEFAULT 23;

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "daily_follows_used" smallint DEFAULT 0;

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "daily_profile_views_used" smallint DEFAULT 0;

--> statement-breakpoint
ALTER TABLE "bot_accounts"
  ADD COLUMN IF NOT EXISTS "daily_counters_reset_at" timestamptz DEFAULT now();
