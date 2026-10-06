-- 0042: remember which POSTS the per-post engagement scrape (likers + comments)
-- has already read, so an old post is not re-read on every profile refresh.
--
-- collectPostEngagement() takes the newest ENGAGEMENT_POSTS_PER_CYCLE posts of a
-- tracked account and scrapes likers AND comments for each one, on every profile
-- refresh (currently every 3h => 8 cycles/day). It had no memory, so the same
-- twelve posts were re-read eight times a day forever. Measured on production
-- over 24h: 540 engagement calls pulled 24,789 items and inserted 231 rows —
-- 477 calls (88%) produced ZERO new rows, and the comments endpoint alone burned
-- 418 calls, each paginating up to 10+ pages.
--
-- The waste is specifically OLD posts. Engagement on a RECENT post genuinely
-- keeps growing, and both caches are read live by the UI and by
-- collectKnownLikerEvidence (which mines likers_cache to detect that one tracked
-- account liked another tracked account's post). So the skip is AGE-TIERED, not
-- a blanket dedupe:
--   * post younger than ENGAGEMENT_FRESH_POST_HOURS (default 48) -> scraped
--     every cycle exactly as before; this table is ignored for it.
--   * older post -> re-scraped at most once per ENGAGEMENT_RECHECK_HOURS
--     (default 24).
--   * ENGAGEMENT_RECHECK_HOURS=0 disables the memory entirely and restores the
--     old re-read-everything behaviour.
--
-- Keyed on (media_id, kind), NOT on (tracked_account_id, media_id) the way
-- like_evidence_post_checks (0041) is. That difference is deliberate:
--   * likers_cache / comments_cache are keyed by post_shortcode ALONE — the
--     scraped engagement is global, not per-customer. If two customers track the
--     same IG user, the second one re-scraping the identical post learns nothing
--     new, so the memory must be shared across tracked accounts. (0041 answers a
--     per-customer question — "is THIS tracked user in that liker list?" — so
--     there the tracked account genuinely belongs in the key.)
--   * `kind` is in the key because likers and comments are two independent IG
--     calls that fail independently. A successful likers read must not suppress
--     a retry of a comments read that errored on the same post.
--
-- tracked_account_id is informational only (which cycle last scraped this post).
-- ON DELETE SET NULL rather than CASCADE: removing one customer's tracked
-- account must not erase memory that another customer's account still relies on.
CREATE TABLE IF NOT EXISTS post_engagement_checks (
  media_id text NOT NULL,
  kind text NOT NULL,
  post_shortcode text,
  tracked_account_id varchar(36)
    REFERENCES tracked_accounts(id) ON DELETE SET NULL,
  post_taken_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_id, kind),
  CONSTRAINT post_engagement_checks_kind_check
    CHECK (kind IN ('likers', 'comments'))
);

-- Retention only: "delete everything checked before <cutoff>". The scan's own
-- read pattern ("which of these <=12 media ids were checked since <cutoff>")
-- is served by the primary key.
CREATE INDEX IF NOT EXISTS idx_post_engagement_checks_checked_at
  ON post_engagement_checks (checked_at);
