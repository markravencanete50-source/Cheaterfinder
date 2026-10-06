#!/usr/bin/env bash
# Re-sign expired liked-post thumbnails.
#
# IG signs CDN thumbnail URLs to expire in days. like_events store the URL
# captured at detection, so a liked post older than roughly a week renders as a
# blank tile in the gallery. The repair path (getFreshMediaThumbnail → a fresh
# signed URL) already existed, but ONLY as a manual script — nothing ran it, so
# thumbnails rotted until somebody noticed. Measured 2026-09-01:
# example_account had 14 of 63 liked posts showing blank.
#
# Runs a bounded batch: --days 1 selects anything not refreshed in the last day,
# --limit caps the work so a backlog never turns into a burst of IG calls, and
# --pace-ms spaces them out. Deletion of genuinely-gone media is left to a
# manual run (--no-delete here) so an automated job can never quietly remove a
# customer's liked posts because the pool was having a bad hour.
set -uo pipefail

cd /root/instaapp/ROB-APP/ROB-APP || exit 1

LIMIT="${THUMB_REFRESH_LIMIT:-80}"
PACE="${THUMB_REFRESH_PACE_MS:-900}"

exec /usr/bin/timeout 1500 npx tsx server/scripts/refresh-liked-thumbnails.ts \
  --days 1 \
  --limit "$LIMIT" \
  --pace-ms "$PACE" \
  --attempts 2 \
  --no-delete
