#!/usr/bin/env bash
# ─── CheaterFinder platform health check ──────────────────────────────────────────
#
# Detects the failure modes that have actually taken this platform down, each
# of which was previously SILENT (the dashboard kept showing live profile
# counts while bot-only data froze for days):
#
#   1. Leasable bot pool collapsed to zero        (collection stops)
#   2. Bot-only data (stories/roster/highlights) gone stale while the public
#      profile path still looks fresh             (the silent-fallback trap)
#   3. Disk near full                             (Redis MISCONF -> silent death)
#   4. Proxy-durability guard throwing            (guard closed under prod)
#   5. No successful scrape in the recent window  (pipeline wedged)
#   6. Zero successes while web bots are leasable (lease/scrape path wedged —
#      the 37-minute ORDER BY outage of 2026-09-02 reported OK throughout)
#   7. `Failed query` lines piling up in the pm2 log (SQL broken under prod)
#   8. A proxy lane failing a large share of its attempts at the transport
#      (one dying CONNECT tunnel hidden behind green pool-level numbers)
#
# Exit code: 0 = OK, 1 = WARN, 2 = CRITICAL. Designed for cron + alerting:
#
#   */10 * * * * /root/instaapp/ROB-APP/ROB-APP/scripts/health-check.sh \
#     || /path/to/notify "cheaterfinder health $(cat /tmp/cheaterfinder-health.txt)"
#
# Set ALERT_WEBHOOK to POST the summary on WARN/CRITICAL (optional).
# ────────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="${APP_DIR:-/root/instaapp/ROB-APP/ROB-APP}"
LOG="${LOG:-$HOME/.pm2/logs/cheaterfinder-out.log}"
OUT="${OUT:-/tmp/cheaterfinder-health.txt}"
KNOWN_EPHEMERAL_RX='(^|@|//)([a-z0-9-]+\.)*dataimpulse\.com:823/?$'

# thresholds (override via env)
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
DISK_CRIT_PCT="${DISK_CRIT_PCT:-93}"
POOL_WARN="${POOL_WARN:-3}"
BOT_DATA_STALE_WARN_H="${BOT_DATA_STALE_WARN_H:-6}"
BOT_DATA_STALE_CRIT_H="${BOT_DATA_STALE_CRIT_H:-24}"
SCRAPE_IDLE_CRIT_MIN="${SCRAPE_IDLE_CRIT_MIN:-90}"
GUARD_LOG_TAIL="${GUARD_LOG_TAIL:-500}"
SUCCESS_GAP_CRIT_MIN="${SUCCESS_GAP_CRIT_MIN:-15}"        # 6: 0 successes in N min with leasable web bots
FAILED_QUERY_WINDOW_MIN="${FAILED_QUERY_WINDOW_MIN:-10}"  # 7: window for 'Failed query' lines
FAILED_QUERY_CRIT="${FAILED_QUERY_CRIT:-20}"              # 7: CRIT above this many in the window
FAILED_QUERY_LOG_TAIL="${FAILED_QUERY_LOG_TAIL:-50000}"   # 7: log lines scanned for the window
LANE_WINDOW_H="${LANE_WINDOW_H:-6}"                       # 8: per-lane window
LANE_NET_FAIL_WARN_PCT="${LANE_NET_FAIL_WARN_PCT:-25}"    # 8: WARN when network failures exceed this share
LANE_MIN_ATTEMPTS="${LANE_MIN_ATTEMPTS:-20}"              # 8: ignore lanes with fewer attempts (noise floor)

status=0                       # 0 ok, 1 warn, 2 crit
lines=()
bump() { (( $1 > status )) && status=$1; }
add()  { lines+=("$2"); bump "$1"; }   # add LEVEL "message"

DB_URL=""
if [[ -r "$APP_DIR/.env" ]]; then
  DB_URL="$(grep -m1 -E '^DATABASE_URL=' "$APP_DIR/.env" | cut -d= -f2-)"
fi
q() { psql "$DB_URL" -t -A -c "$1" 2>/dev/null; }

# Leasable-bot predicate, shared by checks 1 and 6.
#
# Raw-SQL twin of `leasableBotSqlPredicate()` in server/ig-public-scraper.ts —
# the bot-level half of the lease WHERE that leaseBot and the admin health
# snapshot both use (audit D7, 2026-09-03). A shell script cannot import it, so
# the two are kept in step by hand; `npx tsx server/scripts/smoke-lease.ts
# --poll-sec 0` prints the runtime SQL to diff against. Endpoint-specific parts
# (mobile capability, daily-budget gate, first-touch guard) are deliberately
# absent: this counts bots leasable for SOME endpoint.
#   - role='scraper': squad watchers are pinned by id, never pool-leased
#   - a `cooldown: ` reason is a timed cooldown, never a ban verdict (lesson 16);
#     BAN_REASON_RX is BAN_REASON_SQL_REGEX from server/services/bot-cooldown.ts
#   - mobile bots carry a Bearer session and legitimately have NO
#     automation_identity (the predicate that lived here excluded all of them)
#   - session_data is required only when BOT_AUTO_LOGIN_ENABLED=false
#     (isBotAutoLoginEnabled(): anything but the literal "false" is enabled);
#     the flag is read from the running app's environment, then .env
BAN_REASON_RX='auth rejected|csrf token|sessionid cookie|csrftoken cookie|checkpoint|required|suspended|rejected username/password|login information .* incorrect'
auto_login="${BOT_AUTO_LOGIN_ENABLED:-}"
if [[ -z "$auto_login" ]]; then
  app_pid="$(pgrep -f '^node dist/index.cjs' 2>/dev/null | head -1)"
  if [[ -n "$app_pid" && -r "/proc/$app_pid/environ" ]]; then
    auto_login="$(tr '\0' '\n' < "/proc/$app_pid/environ" | sed -n 's/^BOT_AUTO_LOGIN_ENABLED=//p' | head -1)"
  fi
fi
if [[ -z "$auto_login" && -r "$APP_DIR/.env" ]]; then
  auto_login="$(grep -m1 -E '^BOT_AUTO_LOGIN_ENABLED=' "$APP_DIR/.env" | cut -d= -f2-)"
fi
SESSION_CLAUSE=""
[[ "$auto_login" == "false" ]] && SESSION_CLAUSE="AND session_data IS NOT NULL"
LEASABLE_WHERE="status='available' AND role='scraper' AND tier IN ('worker','canary')
      AND (cooldown_until IS NULL OR cooldown_until < now())
      AND (COALESCE(last_login_error,'') LIKE 'cooldown: %' OR COALESCE(last_login_error,'') !~* '$BAN_REASON_RX')
      AND (automation_identity IS NOT NULL OR transport = 'mobile')
      AND ( (proxy_url IS NOT NULL AND proxy_url !~* '$KNOWN_EPHEMERAL_RX')
         OR (proxy_url IS NULL AND proxy_endpoint IS NOT NULL AND proxy_expires_at > now() + interval '2 minutes')
         OR (session_data IS NULL AND proxy_url IS NULL) )
      $SESSION_CLAUSE"

# ── 1. leasable bot pool ────────────────────────────────────────────────────
if [[ -n "$DB_URL" ]]; then
  leasable="$(q "SELECT count(*) FROM bot_accounts WHERE $LEASABLE_WHERE;")"
  leasable="${leasable:-ERR}"
  # Web and mobile separately: only web can serve likers/stories/highlights/
  # comments, so "N leasable" with 0 web is a collection outage for those.
  leasable_split="$(q "SELECT count(*) FILTER (WHERE transport <> 'mobile') || ' web / ' || count(*) FILTER (WHERE transport = 'mobile') || ' mobile' FROM bot_accounts WHERE $LEASABLE_WHERE;")"
  leasable_split="${leasable_split:-? web / ? mobile}"
  if [[ "$leasable" == "ERR" ]]; then add 2 "CRITICAL: cannot query bot pool (DB down?)"
  elif (( leasable == 0 ));        then add 2 "CRITICAL: 0 leasable bots — collection is stopped"
  elif (( leasable < POOL_WARN )); then add 1 "WARN: only $leasable leasable bots ($leasable_split) (< $POOL_WARN)"
  else                                  add 0 "ok: $leasable leasable bots ($leasable_split)"
  fi

  # ── 2. silent-fallback trap: bot-only endpoints not succeeding ────────────
  #    Hours since the LAST SUCCESSFUL bot-only scrape (stories/roster/
  #    highlights). Measured from scrape_outcome_log, not the cache tables:
  #    a story scrape on an account with no active stories succeeds but writes
  #    no cache row, so cache-write time would false-alarm forever. What we
  #    care about is "is the authenticated bot path returning at all".
  botstale="$(q "
    SELECT COALESCE(ceil(EXTRACT(EPOCH FROM (now()-max(occurred_at)))/3600.0), 999999)
    FROM scrape_outcome_log
    WHERE outcome='success'
      AND endpoint IN ('stories','highlights','followers','following');")"
  botstale="${botstale:-ERR}"
  if [[ "$botstale" =~ ^[0-9]+$ ]]; then
    if   (( botstale >= BOT_DATA_STALE_CRIT_H )); then add 2 "CRITICAL: bot-only data ${botstale}h stale (stories/roster/highlights) — silent fallback"
    elif (( botstale >= BOT_DATA_STALE_WARN_H )); then add 1 "WARN: bot-only data ${botstale}h stale"
    else                                              add 0 "ok: bot-only data ${botstale}h fresh"
    fi
  else add 1 "WARN: could not compute bot-data freshness"
  fi

  # ── 5. scrape pipeline alive (any success recently) ───────────────────────
  lastok="$(q "SELECT COALESCE(ceil(EXTRACT(EPOCH FROM (now()-max(occurred_at)))/60.0),999999) FROM scrape_outcome_log WHERE outcome='success';")"
  lastok="${lastok:-ERR}"
  if [[ "$lastok" =~ ^[0-9]+$ ]]; then
    if (( lastok >= SCRAPE_IDLE_CRIT_MIN )); then add 2 "CRITICAL: no successful scrape in ${lastok} min"
    else add 0 "ok: last successful scrape ${lastok} min ago"
    fi
  fi

  # ── 6. zero successes while web bots are leasable ─────────────────────────
  #    Check 5 fires only after SCRAPE_IDLE_CRIT_MIN (90 min). The 37-minute
  #    lease outage of 2026-09-02 (CLAUDE.md lesson 22) sat under that the whole
  #    time: the pool looked healthy, every lease failed at the SQL, and zero
  #    outcomes were written. Leasable web bots + no success in the window means
  #    the lease/scrape path is wedged NOW, not "quiet".
  leasable_web="$(q "SELECT count(*) FROM bot_accounts WHERE $LEASABLE_WHERE AND transport <> 'mobile';")"
  recent_ok="$(q "SELECT count(*) FROM scrape_outcome_log WHERE outcome='success' AND occurred_at > now() - interval '${SUCCESS_GAP_CRIT_MIN} minutes';")"
  if [[ "$leasable_web" =~ ^[0-9]+$ && "$recent_ok" =~ ^[0-9]+$ ]]; then
    if (( recent_ok == 0 && leasable_web > 0 )); then add 2 "CRITICAL: 0 successful scrapes in last ${SUCCESS_GAP_CRIT_MIN} min while ${leasable_web} web bots are leasable — lease/scrape path wedged"
    else add 0 "ok: ${recent_ok} successful scrapes in last ${SUCCESS_GAP_CRIT_MIN} min (${leasable_web} leasable web bots)"
    fi
  else add 1 "WARN: could not compute recent-success vs leasable-web check"
  fi

  # ── 8. proxy lanes with a high network-failure share ──────────────────────
  #    A dying CONNECT tunnel shows up as status-0 "network" outcomes on every
  #    bot pinned to that lane (lane 10925: 31% of attempts on 2026-09-02)
  #    while pool-level numbers stay green. Lane = port of bot_accounts.proxy_url
  #    (sticky lanes), falling back to proxy_endpoint for lazily-leased lanes.
  #    Lanes under LANE_MIN_ATTEMPTS are skipped so one bad call on a quiet lane
  #    does not page anyone.
  lanes_flagged=0
  while IFS='|' read -r lane attempts netfail pct; do
    [[ -n "$lane" ]] || continue
    lanes_flagged=$((lanes_flagged + 1))
    add 1 "WARN: proxy lane ${lane}: ${netfail}/${attempts} network failures (${pct}%) in last ${LANE_WINDOW_H}h"
  done < <(q "
    SELECT lane, attempts, net_fail, round(100.0 * net_fail / attempts)
    FROM (
      SELECT COALESCE(substring(b.proxy_url from ':([0-9]+)/?$'), split_part(b.proxy_endpoint, ':', 2)) AS lane,
             count(*) AS attempts,
             count(*) FILTER (WHERE s.outcome <> 'success' AND s.error_kind = 'network') AS net_fail
      FROM scrape_outcome_log s
      JOIN bot_accounts b ON b.id = s.bot_id
      WHERE s.occurred_at > now() - interval '${LANE_WINDOW_H} hours'
        AND (b.proxy_url IS NOT NULL OR b.proxy_endpoint IS NOT NULL)
      GROUP BY 1
    ) t
    WHERE lane IS NOT NULL AND lane <> ''
      AND attempts >= ${LANE_MIN_ATTEMPTS}
      AND net_fail * 100 > attempts * ${LANE_NET_FAIL_WARN_PCT}
    ORDER BY (net_fail::numeric / attempts) DESC, attempts DESC
    LIMIT 10;")
  if (( lanes_flagged == 0 )); then add 0 "ok: no proxy lane above ${LANE_NET_FAIL_WARN_PCT}% network failures in last ${LANE_WINDOW_H}h"
  fi
else
  add 2 "CRITICAL: DATABASE_URL not found in $APP_DIR/.env"
fi

# ── 3. disk ─────────────────────────────────────────────────────────────────
disk="$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')"
disk="${disk:-0}"
if   (( disk >= DISK_CRIT_PCT )); then add 2 "CRITICAL: disk ${disk}% (Redis MISCONF risk)"
elif (( disk >= DISK_WARN_PCT )); then add 1 "WARN: disk ${disk}%"
else                                   add 0 "ok: disk ${disk}%"
fi

# ── 4. proxy-durability guard firing under prod ──────────────────────────────
if [[ -r "$LOG" ]]; then
  guard="$(tail -n "$GUARD_LOG_TAIL" "$LOG" | grep -c 'proxy-durability')"
  if (( guard > 0 )); then add 1 "WARN: proxy-durability guard fired ${guard}x in last ${GUARD_LOG_TAIL} log lines"
  else add 0 "ok: no proxy-guard throws"
  fi

  # ── 7. 'Failed query' lines in the pm2 log (SQL broken under prod) ────────
  #    1,073 of these in 37 minutes on 2026-09-02 while this script said OK.
  #    pm2 stamps each line with a LOCAL-time "YYYY-MM-DDTHH:MM:SS: " prefix;
  #    compare that prefix against a local-time cutoff so only the last
  #    FAILED_QUERY_WINDOW_MIN minutes count. Lines with no stamp cannot be
  #    windowed and are reported separately instead of being counted as current.
  fq_cutoff="$(date -d "-${FAILED_QUERY_WINDOW_MIN} minutes" '+%Y-%m-%dT%H:%M:%S')"
  read -r fq_recent fq_untimed < <(tail -n "$FAILED_QUERY_LOG_TAIL" "$LOG" \
    | awk -v cut="$fq_cutoff" '
        /Failed query/ {
          if ($0 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) {
            if (substr($0, 1, 19) >= cut) recent++
          } else {
            untimed++
          }
        }
        END { print recent + 0, untimed + 0 }')
  fq_recent="${fq_recent:-0}"; fq_untimed="${fq_untimed:-0}"
  if   (( fq_recent > FAILED_QUERY_CRIT )); then add 2 "CRITICAL: ${fq_recent} 'Failed query' lines in last ${FAILED_QUERY_WINDOW_MIN} min (> ${FAILED_QUERY_CRIT}) — SQL failing under prod"
  elif (( fq_untimed > FAILED_QUERY_CRIT )); then add 1 "WARN: ${fq_untimed} 'Failed query' lines without pm2 timestamps in last ${FAILED_QUERY_LOG_TAIL} log lines (cannot window)"
  else add 0 "ok: ${fq_recent} 'Failed query' lines in last ${FAILED_QUERY_WINDOW_MIN} min"
  fi
fi

# ── redis reachable ──────────────────────────────────────────────────────────
if command -v redis-cli >/dev/null 2>&1; then
  [[ "$(redis-cli ping 2>/dev/null)" == "PONG" ]] || add 2 "CRITICAL: redis not responding to PING"
fi

label=OK; (( status == 1 )) && label=WARN; (( status == 2 )) && label=CRITICAL
ts="$(date '+%Y-%m-%d %H:%M:%S')"
{
  echo "[$label] cheaterfinder health @ $ts"
  for l in "${lines[@]}"; do echo "  - $l"; done
} | tee "$OUT"

if [[ -n "${ALERT_WEBHOOK:-}" && "$status" -ge 1 ]]; then
  curl -s -m 8 -X POST -H 'Content-Type: application/json' \
    --data "$(printf '{"text":%s}' "$(python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' < "$OUT")")" \
    "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
fi

exit "$status"
