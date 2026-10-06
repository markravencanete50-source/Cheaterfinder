-- Re-key media_assets on the STABLE asset path instead of the volatile signed URL.
--
-- PROBLEM
--   Instagram re-signs every media URL on each scrape and load-balances the CDN
--   hostname, so one image arrives as an unbounded stream of distinct URLs:
--     scontent-ord5-3.cdninstagram.com/v/t51.../abc_n.jpg?oh=<sig1>&oe=<exp1>
--     scontent-ber1-1.cdninstagram.com/v/t51.../abc_n.jpg?oh=<sig2>&oe=<exp2>
--   cache_key was sha256(full URL), so every re-scrape minted a NEW row and
--   re-downloaded an image we already had, over metered residential proxy.
--   Measured before this migration: 200,547 rows for 59,090 distinct images —
--   70.5% pure duplication, ~21 GB. That is the engine behind the recurring
--   "/ hits 100% -> Redis MISCONF -> collection silently dies" incident, and it
--   also made freshly-refreshed posts render as "no image".
--
-- FIX
--   Identity = the URL PATH (host rotates, query holds the signature).
--   mediaCacheKey() now hashes only the path; this migration reconciles the
--   existing table to that scheme.
--
-- SAFETY
--   - Keeps the BEST row per stable path (prefer status='cached' with a
--     local_path, then most recently fetched) and deletes the redundant rows.
--   - local_path is stored per-row, so surviving files stay valid even though
--     their name still encodes the OLD key — nothing re-reads the name.
--   - Orphaned files on disk are left for scripts/prune-media-cache.sh, which
--     already evicts by age under disk pressure.
--   - Idempotent: re-running is a no-op once cache_key already equals the
--     stable hash.

-- Postgres has no sha256-of-text without pgcrypto; digest() needs the extension.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Stable path per row: strip scheme+host (everything up to the first single
--    slash after the authority) and the query string.
CREATE TEMP TABLE _ma_keyed AS
SELECT
  id,
  cache_key,
  status,
  local_path,
  last_fetched_at,
  updated_at,
  encode(
    digest(
      '/' || COALESCE(
        NULLIF(split_part(split_part(original_url, '?', 1), '.net/', 2), ''),
        NULLIF(split_part(split_part(original_url, '?', 1), '.com/', 2), ''),
        split_part(original_url, '?', 1)
      ),
      'sha256'
    ),
    'hex'
  ) AS stable_key
FROM media_assets;

-- 2. Winner per stable_key: a real cached file first, then the freshest.
CREATE TEMP TABLE _ma_keep AS
SELECT DISTINCT ON (stable_key) id, stable_key
FROM _ma_keyed
ORDER BY
  stable_key,
  (status = 'cached' AND local_path IS NOT NULL) DESC,
  last_fetched_at DESC NULLS LAST,
  updated_at DESC NULLS LAST;

-- 3. Drop the losers (pure duplicates of the winner's image).
DELETE FROM media_assets ma
WHERE NOT EXISTS (SELECT 1 FROM _ma_keep k WHERE k.id = ma.id);

-- 4. Re-key the survivors. cache_key is UNIQUE and step 3 guaranteed one row per
--    stable_key, so this cannot collide.
UPDATE media_assets ma
SET cache_key = k.stable_key
FROM _ma_keep k
WHERE k.id = ma.id AND ma.cache_key <> k.stable_key;

-- 5. original_url is now just "the URL we last fetched from" — it MUST be free to
--    change as IG re-signs, so its uniqueness no longer holds (and would break
--    the ON CONFLICT (cache_key) upsert). cache_key is the identity now.
DROP INDEX IF EXISTS idx_media_assets_original_url;
CREATE INDEX IF NOT EXISTS idx_media_assets_original_url ON media_assets (original_url);
