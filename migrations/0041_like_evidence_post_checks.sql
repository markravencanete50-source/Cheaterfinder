-- 0041: remember which POSTS the liked-post scan has already read likers for.
--
-- The scan sorts an owner's candidate posts by recency and always takes the top
-- LIKE_EVIDENCE_POSTS_PER_OWNER of them. Nothing recorded what had already been
-- read, so until an owner published something new, every cycle spent its liker
-- reads re-reading the SAME two posts — and we already knew the tracked user was
-- not in those liker lists. Measured on the live pool: scans reported
-- postsChecked=3..18 with inserted=0, cycle after cycle, while owners deeper in
-- the following list were never reached at all.
--
-- Skipping a post we read recently lets the same scarce budget walk FURTHER
-- down the candidate list, so each cycle covers posts (and owners) the previous
-- cycle could not reach.
--
-- The skip must EXPIRE. A liker list keeps growing after publication, so a post
-- checked minutes after it went up can still collect the tracked user's like an
-- hour later. LIKE_EVIDENCE_RECHECK_HOURS (default 24) bounds how long a check
-- suppresses a re-read; posts older than LIKE_EVIDENCE_MAX_POST_AGE_HOURS are
-- dropped by the freshness filter anyway.
--
-- Keyed per (tracked_account, media) rather than per media alone: two customers
-- can track different users, and a post that is uninteresting for one tracked
-- account still has to be checked for the other.
CREATE TABLE IF NOT EXISTS like_evidence_post_checks (
  tracked_account_id varchar(36) NOT NULL
    REFERENCES tracked_accounts(id) ON DELETE CASCADE,
  media_id text NOT NULL,
  owner_username text,
  post_taken_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tracked_account_id, media_id)
);

-- The scan's only read pattern: "which media for THIS account were checked
-- since <cutoff>".
CREATE INDEX IF NOT EXISTS idx_like_evidence_checks_account_checked
  ON like_evidence_post_checks (tracked_account_id, checked_at);

-- Retention: rows older than the longest plausible recheck window are dead
-- weight. Pruned opportunistically by the scan.
CREATE INDEX IF NOT EXISTS idx_like_evidence_checks_checked_at
  ON like_evidence_post_checks (checked_at);
