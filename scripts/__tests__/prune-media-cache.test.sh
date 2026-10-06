#!/usr/bin/env bash
# Tests for scripts/prune-media-cache.sh — the guard that stops media-cache from
# filling / (which kills Redis writes and silently halts all collection).
#
# Runs against a throwaway CACHE_DIR with synthetic file ages, and drives disk
# usage through PRUNE_USAGE_OVERRIDE so the prune/stop logic is exercised without
# needing a real full disk.
#
#   bash scripts/__tests__/prune-media-cache.test.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/prune-media-cache.sh"
PASS=0
FAIL=0

ok()   { echo "  ok  - $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL- $1"; FAIL=$((FAIL+1)); }
check(){ [ "$2" = "$3" ] && ok "$1 ($2)" || bad "$1: expected '$3', got '$2'"; }

# Build a cache dir with files at known ages (minutes old).
make_cache() {
  local dir; dir="$(mktemp -d)"
  # name:age_minutes
  for spec in old30d:43300 old7d:10100 old2d:2900 old12h:730 old2h:130 fresh:1; do
    local name="${spec%%:*}" age="${spec##*:}"
    touch -d "-${age} minutes" "$dir/$name" 2>/dev/null || touch -A "-00${age}00" "$dir/$name"
  done
  echo "$dir"
}
names() { (cd "$1" && ls | sort | tr '\n' ' ' | sed 's/ $//'); }

echo "prune-media-cache.sh"

# 1. Below threshold => no-op, nothing deleted.
DIR="$(make_cache)"
QUIET=1 CACHE_DIR="$DIR" PRUNE_USAGE_OVERRIDE=50 bash "$SCRIPT" >/dev/null 2>&1
check "below threshold deletes nothing" "$(names "$DIR")" "fresh old12h old2d old2h old30d old7d"
rm -rf "$DIR"

# 2. Above threshold, usage never drops (override is static) => escalates through
#    every tier, deleting everything older than the last tier (30m) but KEEPING
#    the fresh file. This is the worst-case escalation path.
DIR="$(make_cache)"
QUIET=1 CACHE_DIR="$DIR" PRUNE_USAGE_OVERRIDE=95 bash "$SCRIPT" >/dev/null 2>&1
check "full escalation keeps only fresh" "$(names "$DIR")" "fresh"
rm -rf "$DIR"

# 3. Invalid/unreadable usage => must abort loudly (exit 1), NOT silently skip.
#    Regression: an empty df value used to crash with "integer expression
#    expected" and skip the prune exactly when it was needed.
DIR="$(make_cache)"
out="$(QUIET=1 CACHE_DIR="$DIR" PRUNE_USAGE_OVERRIDE="notanumber" bash "$SCRIPT" 2>&1)"; rc=$?
check "invalid usage exits 1" "$rc" "1"
check "invalid usage deletes nothing" "$(names "$DIR")" "fresh old12h old2d old2h old30d old7d"
rm -rf "$DIR"

# 4. Missing cache dir => clean no-op, exit 0 (never fail the cron).
QUIET=1 CACHE_DIR="/nonexistent/nope-$$" PRUNE_USAGE_OVERRIDE=99 bash "$SCRIPT" >/dev/null 2>&1
check "missing cache dir exits 0" "$?" "0"

# 5. Still-over-threshold after pruning => must WARN (media-cache not the cause),
#    not report a clean run.
DIR="$(make_cache)"
out="$(CACHE_DIR="$DIR" PRUNE_USAGE_OVERRIDE=99 bash "$SCRIPT" 2>&1)"
echo "$out" | grep -q "WARNING: still 99%" && ok "warns when cache is not the offender" \
  || bad "warns when cache is not the offender: got '$out'"
rm -rf "$DIR"

echo "  ---"
echo "  passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
