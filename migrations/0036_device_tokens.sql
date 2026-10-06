-- Push-notification device registry.
--
-- Additive only: one new table plus its enum. Nothing existing is touched.
--
-- NOTE ON THE MISSING FOREIGN KEY: this table intentionally has no
-- `REFERENCES users(id) ON DELETE CASCADE`. The application role owns
-- public.users but its ACL is {cheaterfinder=arwd/cheaterfinder} — REFERENCES (x) and
-- TRIGGER (t) were deliberately revoked, so the constraint cannot be created
-- without widening the role's privileges on a production database. Rather than
-- do that, `user_id` is an unconstrained varchar and rows are cleaned up in
-- application code when an account is deleted (see the DELETE /api/account
-- handler). A DBA who wants referential integrity can add it later with:
--   GRANT REFERENCES ON public.users TO cheaterfinder;
--   ALTER TABLE device_tokens
--     ADD CONSTRAINT device_tokens_user_id_fk
--     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

DO $$ BEGIN
  CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "device_tokens" (
  "id"           varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      varchar(36) NOT NULL,
  "token"        text NOT NULL UNIQUE,
  "platform"     "public"."device_platform" NOT NULL,
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_device_tokens_user_id" ON "device_tokens" ("user_id");
