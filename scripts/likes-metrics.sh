#!/bin/bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/database-monitor-env.sh"
# Hourly snapshot of the liked-posts economics: detections vs the account cost
# of producing them. Written after the 2026-08-28 sustainability rework
# (likers velocity 30->10/bot/day, freshness 96h, visibility <=1500 likes).
# Output: /var/log/cheaterfinder-likes-metrics.log  (one CSV line per hour)
# Credentials come from the environment, never hardcoded in a committed file.
PSQL="psql --no-password -v ON_ERROR_STOP=1 -U cheaterfinder -h localhost -d cheaterfinder_ai -tAc"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
ROW=$($PSQL "
SELECT
  (SELECT COUNT(*) FROM like_events WHERE detected_at > NOW()-INTERVAL '1 hour'),
  (SELECT COUNT(*) FROM like_events WHERE detected_at > NOW()-INTERVAL '24 hours'),
  (SELECT COUNT(*) FILTER (WHERE outcome='success') FROM scrape_outcome_log WHERE endpoint='likers' AND occurred_at > NOW()-INTERVAL '1 hour'),
  (SELECT COUNT(*) FILTER (WHERE outcome='failure') FROM scrape_outcome_log WHERE endpoint='likers' AND occurred_at > NOW()-INTERVAL '1 hour'),
  (SELECT COUNT(*) FROM bot_accounts WHERE status='banned' AND updated_at > NOW()-INTERVAL '1 hour'),
  (SELECT COUNT(*) FROM bot_accounts WHERE status='banned' AND updated_at > NOW()-INTERVAL '24 hours'),
  (SELECT COUNT(*) FROM bot_accounts WHERE transport='web' AND status='available' AND tier IN ('worker','canary') AND session_data IS NOT NULL AND automation_identity IS NOT NULL AND (cooldown_until IS NULL OR cooldown_until<NOW())),
  (SELECT COUNT(*) FROM bot_accounts WHERE transport='mobile' AND status='available')
" 2>/dev/null | tr -d ' ' | tr '|' ',')
echo "$TS,$ROW" >> /var/log/cheaterfinder-likes-metrics.log
