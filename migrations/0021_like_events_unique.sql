-- 0021 (D15 fix): Deduplicate like_events and enforce a UNIQUE constraint on
-- the natural key (tracked_account_id, post_id) so the application can switch
-- from a racy check-then-insert to INSERT ... ON CONFLICT DO NOTHING.
--
-- ── Natural key ──────────────────────────────────────────────────────────────
--
-- Unlike follow_events / follower_events (append-only "membership began"
-- markers whose key legitimately repeats across re-follow epochs — see 0019),
-- a like_event is a single fact: "this account liked this post". A given
-- tracked account can like a given post AT MOST ONCE, so the pair
-- (tracked_account_id, post_id) is a true natural key with no epoch nuance.
-- This is exactly the pair the old NOT EXISTS guard in
-- collectKnownLikerEvidence() and the SELECT-then-INSERT in
-- persistLikeEvidenceFromPost() were checking — both of which raced and could
-- insert duplicates under concurrency.
--
-- ── Dedupe policy ────────────────────────────────────────────────────────────
--
-- Keep the EARLIEST (detected_at, id) row per (tracked_account_id, post_id);
-- discard later duplicates. detected_at is the "first observed liking" signal
-- that downstream activity feeds order by, so keeping the earliest preserves
-- feed output. (Display fields on discarded later rows may be lost; the next
-- collection cycle repopulates them via the normal upsert/diff flow.)
--
-- Live-DB count at the time of writing (read-only audit, 2026-06-13):
--   like_events: 20 rows, 0 duplicate rows on (tracked_account_id, post_id).
-- The dedupe DELETE below is therefore a no-op on the current database; it
-- exists so this migration is correct on any database where duplicates have
-- accumulated (or on a fresh build replayed without the constraint).
--
-- ── Idempotency ──────────────────────────────────────────────────────────────
--
-- The constraint may already exist on some environments (it was added out of
-- band on production as like_events_tracked_post_unique). The DO block adds it
-- only when absent, so this migration is safe to (re)apply anywhere.

BEGIN;

-- 1. Remove duplicates, keeping the earliest row of each (tracked_account_id,
--    post_id) group.
DELETE FROM like_events le
USING (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tracked_account_id, post_id
      ORDER BY detected_at ASC, id ASC
    ) AS rn
  FROM like_events
) ranked
WHERE le.id = ranked.id
  AND ranked.rn > 1;

-- 2. Add the UNIQUE constraint only if it is not already present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'like_events'::regclass
      AND contype = 'u'
      AND conname = 'like_events_tracked_post_unique'
  ) THEN
    ALTER TABLE like_events
      ADD CONSTRAINT like_events_tracked_post_unique
      UNIQUE (tracked_account_id, post_id);
  END IF;
END
$$;

COMMIT;
