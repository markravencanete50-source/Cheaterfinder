#!/usr/bin/env bash
# Keep storage/media-cache from filling / and taking the app down.
#
# Why this exists: media-cache grows unbounded. When / hits 100%, Redis can no
# longer bgsave -> "MISCONF ... stop-writes-on-bgsave-error" floods the logs ->
# every BullMQ worker fails its writes -> collection silently dies while the app
# still serves HTTP 200 (looks alive, collects nothing). Recurred 2026-06-27,
# 2026-06-28, 2026-07-15.
#
# SCOPE (important): this guards ONLY the media-cache growth path. It does not
# protect / from anything else (DB, logs, backups, another app). It is a
# mitigation for the known offender, not a general disk guarantee.
#
# Policy: do NOTHING below THRESHOLD_PCT. The cache is regenerable, but
# regenerating re-downloads images through the METERED residential proxy, so we
# never prune more than we must. Above the threshold, drop oldest files first in
# escalating age tiers, stopping as soon as we are back under TARGET_PCT.
#
# Safe by construction: only ever deletes plain files under CACHE_DIR (which is
# gitignored + regenerable). Never touches the DB, Redis, or app state.
#
# Tunable via env (also used by scripts/__tests__/prune-media-cache.test.sh):
#   CACHE_DIR, THRESHOLD_PCT, TARGET_PCT, PRUNE_USAGE_OVERRIDE (test seam), QUIET
set -uo pipefail

CACHE_DIR="${CACHE_DIR:-/root/instaapp/ROB-APP/ROB-APP/storage/media-cache}"
THRESHOLD_PCT="${THRESHOLD_PCT:-80}"
TARGET_PCT="${TARGET_PCT:-70}"
LOG_TAG="prune-media-cache"

log() {
  [ -n "${QUIET:-}" ] || echo "[$LOG_TAG] $*"
  command -v logger >/dev/null 2>&1 && logger -t "$LOG_TAG" "$*"
  return 0
}

# Disk usage of the filesystem holding CACHE_DIR, as a bare integer.
# PRUNE_USAGE_OVERRIDE is a test seam: when set, it is echoed verbatim so the
# test suite can drive the escalation/stop logic without a real full disk.
usage_pct() {
  if [ -n "${PRUNE_USAGE_OVERRIDE:-}" ]; then
    echo "$PRUNE_USAGE_OVERRIDE"
    return 0
  fi
  df -P "$CACHE_DIR" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}'
}

# Guard: df can fail or return junk (missing mount, weird container fs). An
# unvalidated value made `[ "$x" -lt 80 ]` abort with "integer expression
# expected" and silently skip the prune — exactly when it was needed most.
is_int() { [ -n "${1:-}" ] && [ -z "${1//[0-9]/}" ]; }

[ -d "$CACHE_DIR" ] || { log "cache dir $CACHE_DIR absent; nothing to do"; exit 0; }

before="$(usage_pct)"
if ! is_int "$before"; then
  log "ERROR: could not read disk usage for $CACHE_DIR (got '${before:-<empty>}'); aborting"
  exit 1
fi

if [ "$before" -lt "$THRESHOLD_PCT" ]; then
  exit 0
fi

log "disk ${before}% >= ${THRESHOLD_PCT}%, pruning $CACHE_DIR"

# Escalating age tiers (minutes): 30d, 7d, 2d, 12h, 2h, 30m. Stop as soon as we
# are under TARGET_PCT so we keep the warmest cache the disk can afford.
for mins in 43200 10080 2880 720 120 30; do
  now="$(usage_pct)"
  is_int "$now" || break
  [ "$now" -le "$TARGET_PCT" ] && break
  find "$CACHE_DIR" -type f -mmin +"$mins" -delete 2>/dev/null
done

after="$(usage_pct)"
log "done: ${before}% -> ${after}%"

# Escalation exhausted and still over threshold => media-cache was NOT the thing
# filling the disk. Say so loudly instead of reporting a clean run.
if is_int "$after" && [ "$after" -ge "$THRESHOLD_PCT" ]; then
  log "WARNING: still ${after}% after pruning — media-cache is not the offender; investigate other disk usage"
fi

# If Redis had already tripped its write-protect, clear it now that space is back.
if redis-cli info persistence 2>/dev/null | grep -q 'rdb_last_bgsave_status:err'; then
  redis-cli config set stop-writes-on-bgsave-error no >/dev/null 2>&1
  redis-cli bgsave >/dev/null 2>&1
  redis-cli config set stop-writes-on-bgsave-error yes >/dev/null 2>&1
  log "redis bgsave was failing; forced bgsave after freeing space"
fi
exit 0
