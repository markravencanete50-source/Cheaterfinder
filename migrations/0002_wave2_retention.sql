-- Wave 2 migration:
--   1. Add `session_expired` as a new bot_status enum value so the re-auth
--      pipeline can distinguish operator-actionable session expiry from a
--      permanent IG ban.
--   2. (Retention itself is pure DELETE via drizzle — no schema change.)

--> statement-breakpoint
-- Postgres requires ADD VALUE for enums to run outside of any open
-- transaction block. Drizzle migrations run statement-by-statement, so this
-- single ALTER is fine on its own; we also guard with IF NOT EXISTS so
-- rerunning the migration is safe.
ALTER TYPE "bot_status" ADD VALUE IF NOT EXISTS 'session_expired';
