-- 0039: resumable roster pagination.
--
-- Instagram refuses deep pagination on large follower lists: the walk dies with
-- HTTP 400 after ~8 pages (~200 items). Because every run restarted from
-- cursor=NULL, we re-read the SAME first 200 accounts forever and could never
-- reach the end of a 9,908-follower list. @sample_account was stuck at
-- 6,092/9,908 with zero follower events for days.
--
-- Persisting the cursor lets each run RESUME where the last one stopped, so a
-- large roster is enumerated across several cycles instead of never.
ALTER TABLE roster_sync_state
  ADD COLUMN IF NOT EXISTS next_cursor text,
  ADD COLUMN IF NOT EXISTS cursor_updated_at timestamptz;
