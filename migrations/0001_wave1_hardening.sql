-- Wave 1 hardening migration
-- 1. like_events uniqueness so we can use ON CONFLICT DO NOTHING (Fix #3, #11)
-- 2. Composite / partial indexes for hot query paths (Fix #19)
-- 3. password_reset_tokens timestamptz (Fix #17)

--> statement-breakpoint
-- Fix #3, #11, #19: unique (tracked_account_id, post_id) on like_events
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'like_events_tracked_post_unique'
  ) THEN
    ALTER TABLE "like_events"
      ADD CONSTRAINT "like_events_tracked_post_unique"
      UNIQUE ("tracked_account_id", "post_id");
  END IF;
END $$;

--> statement-breakpoint
-- Fix #19: bot assignment hot path
CREATE INDEX IF NOT EXISTS "idx_bot_accounts_assignment"
  ON "bot_accounts" ("status", "cooldown_until")
  WHERE "status" = 'available';

--> statement-breakpoint
-- Fix #19: bot_follow_requests hot paths
CREATE INDEX IF NOT EXISTS "idx_bfr_tracked_status"
  ON "bot_follow_requests" ("tracked_account_id", "status");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bfr_pending_expires"
  ON "bot_follow_requests" ("expires_at")
  WHERE "status" = 'pending';

--> statement-breakpoint
-- Fix #19: notifications inbox
CREATE INDEX IF NOT EXISTS "idx_notifications_user_unread"
  ON "notifications" ("user_id", "is_read", "created_at" DESC)
  WHERE "is_read" = false;

--> statement-breakpoint
-- Fix #19: standard FK index for password_reset_tokens
CREATE INDEX IF NOT EXISTS "idx_prt_user_id"
  ON "password_reset_tokens" ("user_id");

--> statement-breakpoint
-- Fix #17: timestamptz on password_reset_tokens. The `USING ... AT TIME ZONE 'UTC'`
-- converts existing values assuming they were stored as UTC (which is how
-- drizzle's default timestamp columns behave on PG).
ALTER TABLE "password_reset_tokens"
  ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';

--> statement-breakpoint
ALTER TABLE "password_reset_tokens"
  ALTER COLUMN "used_at" TYPE timestamptz USING "used_at" AT TIME ZONE 'UTC';

--> statement-breakpoint
ALTER TABLE "password_reset_tokens"
  ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
