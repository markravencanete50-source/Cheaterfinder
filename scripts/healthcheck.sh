#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${WATCHDOG_ENV_FILE:-$SCRIPT_DIR/../.env}"
if [[ -z "${PORT:-}" && -r "$ENV_FILE" ]]; then
  PORT=$(awk -F= '$1=="PORT" {gsub(/["\047[:space:]]/, "", $2); print $2; exit}' "$ENV_FILE")
fi
PORT="${PORT:-8080}"
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "Invalid watchdog port" >&2; exit 2; }
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"
TIMEOUT="${WATCHDOG_TIMEOUT:-10}"
LOG_FILE="${WATCHDOG_LOG_FILE:-/var/log/cheaterfinder-watchdog.log}"
PM2_BIN="${PM2_BIN:-pm2}"
mkdir -p "$(dirname -- "$LOG_FILE")"
log_message() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $1" >> "$LOG_FILE"
}
health_code() {
  local code
  if code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$HEALTH_URL" 2>/dev/null); then
    [[ "$code" =~ ^[0-9]{3}$ ]] && echo "$code" || echo '000'
  else
    echo '000'
  fi
}
# Prevent overlapping cron runs from issuing repeated restarts.
exec 9>"${WATCHDOG_LOCK_FILE:-$LOG_FILE.lock}"
flock -n 9 || exit 0
HTTP_CODE=$(health_code)
if [[ "$HTTP_CODE" =~ ^2[0-9]{2}$ ]]; then
  log_message "Health check passed (HTTP $HTTP_CODE)"
  exit 0
fi
if [[ "$HTTP_CODE" =~ ^5[0-9]{2}$ || "$HTTP_CODE" == '000' ]]; then
  log_message "Health check failed (HTTP $HTTP_CODE). Attempting restart..."
  if "$PM2_BIN" restart cheaterfinder >> "$LOG_FILE" 2>&1; then
    sleep "${WATCHDOG_RESTART_DELAY:-5}"
    RETRY_CODE=$(health_code)
    if [[ "$RETRY_CODE" =~ ^2[0-9]{2}$ ]]; then
      log_message "Post-restart health check passed (HTTP $RETRY_CODE)"
      exit 0
    fi
    log_message "Post-restart health check still failing (HTTP $RETRY_CODE)"
  else
    log_message "Failed to send restart command to pm2"
  fi
else
  log_message "Health check returned HTTP $HTTP_CODE; check endpoint configuration"
fi
logger -p daemon.err -t cheaterfinder-watchdog 'CheaterFinder health check failed; see watchdog log' || true
exit 1
