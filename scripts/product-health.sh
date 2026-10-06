#!/bin/bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/database-monitor-env.sh"
# PRODUCT health — not plumbing. The infra monitor (likes-metrics.sh) reported
# "green" for days while follower_events sat at 0 rows and @sample_account's
# roster had been unsettled since 08-26. App-up + low-bans says nothing about
# whether a customer sees data. This checks the actual panels, per account.
# Credentials come from the environment, never hardcoded in a committed file.
PSQL="psql --no-password -v ON_ERROR_STOP=1 -U cheaterfinder -h localhost -d cheaterfinder_ai -tAc"
# Match canonicalTwinId: oldest active row by IG id (username fallback), then id.
# Twins do not walk separate rosters; counting them reports healthy shared data
# as dead panels. Keep this predicate identical across all four health queries.
CANONICAL="t.is_active=true AND NOT EXISTS (
  SELECT 1 FROM tracked_accounts sibling
  WHERE sibling.is_active=true
    AND CASE WHEN NULLIF(BTRIM(t.ig_user_id),'') IS NOT NULL
      THEN sibling.ig_user_id=t.ig_user_id ELSE sibling.ig_username=t.ig_username END
    AND (sibling.tracking_started, sibling.id) < (t.tracking_started, t.id)
)"
echo "=== PRODUCT HEALTH $(date -u +%H:%MZ) ==="
$PSQL "
SELECT
  t.ig_username
  ||' | followers='||COALESCE((SELECT last_member_count::text FROM roster_sync_state r WHERE r.tracked_account_id=t.id AND r.dimension='follower'),'-')
  ||'/'||COALESCE(t.follower_count::text,'?')
  ||' settled='||COALESCE((SELECT CASE WHEN settled_at IS NOT NULL THEN 'yes' WHEN failure_kind='too_large' THEN 'n/a(too-large)' ELSE 'NO' END FROM roster_sync_state r WHERE r.tracked_account_id=t.id AND r.dimension='follower'),'-')
  ||' | new_followers_7d='||(SELECT COUNT(*) FROM follower_events f WHERE f.tracked_account_id=t.id AND f.detected_at>NOW()-INTERVAL '7 days')
  ||' unfollows_7d='||(SELECT COUNT(*) FROM follower_unfollow_events u WHERE u.tracked_account_id=t.id AND u.detected_at>NOW()-INTERVAL '7 days')
  ||' likes_7d='||(SELECT COUNT(*) FROM like_events l WHERE l.tracked_account_id=t.id AND l.detected_at>NOW()-INTERVAL '7 days')
  ||' posts='||(SELECT COUNT(*) FROM posts_cache p WHERE p.tracked_account_id=t.id)
FROM tracked_accounts t WHERE $CANONICAL ORDER BY t.ig_username;"
echo "--- DEAD PANELS (feature producing nothing in 7d) ---"
$PSQL "
SELECT COUNT(*) FILTER (WHERE nf=0)||' accounts with NO new-follower events'
     ||' | '||COUNT(*) FILTER (WHERE lk=0)||' with NO liked-posts'
     ||' | '||COUNT(*) FILTER (WHERE unsettled)||' rosters UNSETTLED'
FROM (
  SELECT t.id,
    (SELECT COUNT(*) FROM follower_events f WHERE f.tracked_account_id=t.id AND f.detected_at>NOW()-INTERVAL '7 days') AS nf,
    (SELECT COUNT(*) FROM like_events l WHERE l.tracked_account_id=t.id AND l.detected_at>NOW()-INTERVAL '7 days') AS lk,
    -- An over-cap roster is a known limit, not a fault: excluded so it stops
    -- showing as a broken panel every 10 minutes.
    COALESCE((SELECT settled_at IS NULL AND COALESCE(failure_kind,'') <> 'too_large' FROM roster_sync_state r WHERE r.tracked_account_id=t.id AND r.dimension='follower'),true) AS unsettled
  FROM tracked_accounts t WHERE $CANONICAL
) x;"
# --- Follower read freshness (audit 2026-09-02 C10b) ---------------------------
# roster_sync_state.last_complete_read_at moves only when a read epoch that began
# at cursor NULL reaches the end of the list (migration 0046). A SETTLED roster
# whose last complete read is older than the threshold means departures and
# missing_streak have stopped moving for that account even though every other
# panel can look alive (sample: 6 days, example: 39 days on 2026-09-02).
# Unsettled rosters (too_large / still syncing) are shown, not warned.
STALE_READ_WARN_HOURS="${STALE_READ_WARN_HOURS:-48}"
case "$STALE_READ_WARN_HOURS" in
  ''|*[!0-9]*) echo "STALE_READ_WARN_HOURS must be a positive integer (got '$STALE_READ_WARN_HOURS')" >&2; exit 2 ;;
esac
echo "--- FOLLOWER READ FRESHNESS (WARN: settled roster, no complete read in ${STALE_READ_WARN_HOURS}h) ---"
$PSQL "
SELECT t.ig_username
  ||' last complete follower read '
  ||COALESCE(ROUND(EXTRACT(EPOCH FROM (NOW()-r.last_complete_read_at))/3600)::text||' h ago','never')
  ||CASE
      WHEN r.settled_at IS NOT NULL
       AND (r.last_complete_read_at IS NULL OR r.last_complete_read_at < NOW()-INTERVAL '${STALE_READ_WARN_HOURS} hours')
        THEN '  WARN stale (settled)'
      WHEN r.settled_at IS NULL
        THEN '  (unsettled'||COALESCE(': '||r.failure_kind,'')||')'
      ELSE ''
    END
FROM tracked_accounts t
LEFT JOIN roster_sync_state r ON r.tracked_account_id=t.id AND r.dimension='follower'
WHERE $CANONICAL
ORDER BY t.ig_username;"
$PSQL "
SELECT COUNT(*)||' settled follower rosters with no complete read in ${STALE_READ_WARN_HOURS}h'
FROM tracked_accounts t
JOIN roster_sync_state r ON r.tracked_account_id=t.id AND r.dimension='follower'
WHERE $CANONICAL
  AND r.settled_at IS NOT NULL
  AND (r.last_complete_read_at IS NULL OR r.last_complete_read_at < NOW()-INTERVAL '${STALE_READ_WARN_HOURS} hours');"
