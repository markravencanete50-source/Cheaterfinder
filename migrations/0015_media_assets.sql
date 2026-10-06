DO $$ BEGIN
  CREATE TYPE "media_asset_status" AS ENUM ('pending', 'cached', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "media_assets" (
  "id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "original_url" text NOT NULL,
  "cache_key" text NOT NULL,
  "local_path" text,
  "content_type" text,
  "byte_size" integer,
  "status" "media_asset_status" DEFAULT 'pending' NOT NULL,
  "error_message" text,
  "last_fetched_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_media_assets_original_url"
  ON "media_assets" ("original_url");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_media_assets_cache_key"
  ON "media_assets" ("cache_key");

CREATE INDEX IF NOT EXISTS "idx_media_assets_status"
  ON "media_assets" ("status");

CREATE INDEX IF NOT EXISTS "idx_media_assets_updated_at"
  ON "media_assets" ("updated_at");
