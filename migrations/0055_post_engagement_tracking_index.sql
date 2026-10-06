-- Execute outside a transaction so account deletion remains available during creation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_post_engagement_checks_tracked_account_id
  ON post_engagement_checks (tracked_account_id);
