-- 0019 (D2 fix): Deduplicate the four follow/unfollow event tables and add
-- expression indexes that support the new SQL known-set queries.
--
-- ── Why there is NO UNIQUE index in this migration ───────────────────────────
--
-- follow_events / follower_events rows are append-only "membership began"
-- markers. The current roster is reconstructed (see server/services/roster.ts
-- and the known-set queries in server/services/public-data-persistence.ts) as:
--
--     username is currently a member  <=>  max(follow.detected_at)
--                                          >  max(unfollow.detected_at)
--                                          (or no unfollow row exists)
--
-- The same (tracked_account_id, lower(username)) key therefore LEGITIMATELY
-- appears multiple times: each re-follow after an unfollow starts a new
-- "epoch" and must insert a fresh follow row, otherwise the re-follow would
-- be invisible to the roster and the activity feed. A global
-- UNIQUE (tracked_account_id, lower(username)) would reject legitimate
-- re-follows, and the real invariant — "at most one follow row per epoch,
-- where epochs are delimited by rows in a DIFFERENT table (the unfollow
-- table)" — cannot be expressed as any (partial) unique index, because
-- partial-index predicates cannot reference other tables. The same reasoning
-- applies symmetrically to the unfollow tables (a user can unfollow,
-- re-follow, and unfollow again).
--
-- Concurrency correctness is instead enforced in application code:
-- persistFollowingDiff / persistFollowerDiff now wrap the whole
-- read-known-set -> compute-diff -> insert sequence in a transaction that
-- first takes
--
--     pg_advisory_xact_lock(<dimension namespace int4>, hashtext(tracked_account_id))
--
-- (namespaces FOLLOWING_DIFF_LOCK_NS / FOLLOWER_DIFF_LOCK_NS in
-- server/services/public-data-persistence.ts), which serializes concurrent
-- diff computations per tracked account and dimension (profile worker,
-- collection-follows worker, manual refresh) while letting different
-- accounts proceed in parallel. The lock is released automatically at
-- commit/rollback.
--
-- ── What this migration deletes ──────────────────────────────────────────────
--
-- A row is a duplicate iff another row exists for the same
-- (tracked_account_id, lower(username)) within the same epoch — i.e. with no
-- intervening row in the opposite table between them. We keep the EARLIEST
-- (detected_at, id) row of each epoch: roster.ts derives firstSeenAt from the
-- earliest row, so keeping the earliest preserves roster output exactly.
-- (Display fields from discarded later duplicates may be lost; the next
-- collection cycle repopulates them via normal upsert/diff flow.)
--
-- Epoch definitions (mirroring roster.ts tie-breaking, where a follow at the
-- exact timestamp of an unfollow is treated as shadowed by that unfollow):
--   * follow-type row epoch  = COUNT(unfollows with detected_at <  row.detected_at)
--   * unfollow-type row epoch = COUNT(follows  with detected_at <= row.detected_at)
--
-- Live-DB counts at the time of writing (read-only audit, re-verified
-- 2026-06-12 — duplicates are still accumulating until this ships):
--   follow_events:            35,482 rows, 30,197 epoch-duplicates
--   follower_events:          42,378 rows, 32,860 epoch-duplicates
--   unfollow_events:           1,313 rows,      0 epoch-duplicates
--   follower_unfollow_events:  1,203 rows,      0 epoch-duplicates
-- The unfollow-table deletes are included anyway: they are no-ops on clean
-- data and make the migration self-contained and idempotent.
--
-- Semantics of the known-set SQL these indexes serve were verified read-only
-- against the live DB: the "latest follow strictly newer than latest
-- unfollow" reconstruction matches roster.ts's EXISTS-based reconstruction
-- exactly (0 rows differ in either direction across all accounts).
--
-- Safety: the whole dedupe runs in one transaction. Re-running the migration
-- is safe (second run deletes nothing, CREATE INDEX IF NOT EXISTS is a no-op).

BEGIN;

-- 1) Expression indexes FIRST: the dedupe deletes below probe the opposite
--    table once per window row via correlated subqueries shaped exactly like
--    (tracked_account_id = ? AND lower(username) = ? AND detected_at <= ?),
--    so building the indexes up front turns ~35-42k seq-scan probes into
--    index range scans. They then permanently back the SQL known-set queries
--    in public-data-persistence.ts (GROUP BY lower(username) per account)
--    and the case-insensitive unfollower-detail lookup (D12). Declared in
--    shared/schema.ts as well so the ORM schema stays in sync.

CREATE INDEX IF NOT EXISTS idx_follow_events_account_lower_username
  ON follow_events (tracked_account_id, lower(followed_username), detected_at);

CREATE INDEX IF NOT EXISTS idx_unfollow_events_account_lower_username
  ON unfollow_events (tracked_account_id, lower(unfollowed_username), detected_at);

CREATE INDEX IF NOT EXISTS idx_follower_events_account_lower_username
  ON follower_events (tracked_account_id, lower(follower_username), detected_at);

CREATE INDEX IF NOT EXISTS idx_follower_unfollow_events_account_lower_username
  ON follower_unfollow_events (tracked_account_id, lower(unfollower_username), detected_at);

-- 2) Unfollow tables next. Note: removing an epoch-duplicate unfollow row
--    never changes follow-row epochs, because an unfollow that separates two
--    follow rows is by definition in a different epoch from its predecessor
--    and is therefore never deleted.

WITH numbered AS (
  SELECT uf.id,
         row_number() OVER (
           PARTITION BY uf.tracked_account_id, lower(uf.unfollowed_username), (
             SELECT count(*) FROM follow_events f
             WHERE f.tracked_account_id = uf.tracked_account_id
               AND lower(f.followed_username) = lower(uf.unfollowed_username)
               AND f.detected_at <= uf.detected_at
           )
           ORDER BY uf.detected_at, uf.id
         ) AS rn
  FROM unfollow_events uf
)
DELETE FROM unfollow_events
WHERE id IN (SELECT id FROM numbered WHERE rn > 1);

WITH numbered AS (
  SELECT uf.id,
         row_number() OVER (
           PARTITION BY uf.tracked_account_id, lower(uf.unfollower_username), (
             SELECT count(*) FROM follower_events f
             WHERE f.tracked_account_id = uf.tracked_account_id
               AND lower(f.follower_username) = lower(uf.unfollower_username)
               AND f.detected_at <= uf.detected_at
           )
           ORDER BY uf.detected_at, uf.id
         ) AS rn
  FROM follower_unfollow_events uf
)
DELETE FROM follower_unfollow_events
WHERE id IN (SELECT id FROM numbered WHERE rn > 1);

-- 3) Follow tables: delete every row that repeats its (account, username)
--    key inside the same epoch, keeping the earliest row of the epoch.
--    These run AFTER the unfollow dedupe, so follow epochs are computed
--    against the already-clean unfollow tables (safe in both orders — see
--    the epoch argument above — but this order makes the reasoning local).

WITH numbered AS (
  SELECT f.id,
         row_number() OVER (
           PARTITION BY f.tracked_account_id, lower(f.followed_username), (
             SELECT count(*) FROM unfollow_events u
             WHERE u.tracked_account_id = f.tracked_account_id
               AND lower(u.unfollowed_username) = lower(f.followed_username)
               AND u.detected_at < f.detected_at
           )
           ORDER BY f.detected_at, f.id
         ) AS rn
  FROM follow_events f
)
DELETE FROM follow_events
WHERE id IN (SELECT id FROM numbered WHERE rn > 1);

WITH numbered AS (
  SELECT f.id,
         row_number() OVER (
           PARTITION BY f.tracked_account_id, lower(f.follower_username), (
             SELECT count(*) FROM follower_unfollow_events u
             WHERE u.tracked_account_id = f.tracked_account_id
               AND lower(u.unfollower_username) = lower(f.follower_username)
               AND u.detected_at < f.detected_at
           )
           ORDER BY f.detected_at, f.id
         ) AS rn
  FROM follower_events f
)
DELETE FROM follower_events
WHERE id IN (SELECT id FROM numbered WHERE rn > 1);

COMMIT;
