// Read-only profile health diagnosis. No Instagram reads, logins or workers.
import "dotenv/config";
import { Client } from "pg";
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='15s'");
  const at = (await client.query("SELECT now() at")).rows[0].at as Date;
  const windows = (await client.query(`
    WITH windows(label,hours) AS (VALUES ('24h',24.0),('6h',6.0),('1h',1.0),('15m',0.25))
    SELECT w.label, count(s.id)::int attempts,
      count(s.id) FILTER (WHERE s.outcome='success')::int successes,
      count(s.id) FILTER (WHERE s.outcome='failure')::int failures,
      round(100.0*count(s.id) FILTER (WHERE s.outcome='success')/NULLIF(count(s.id),0),1) success_pct,
      max(s.occurred_at) FILTER (WHERE s.outcome='success') latest_success
    FROM windows w LEFT JOIN scrape_outcome_log s ON s.endpoint='profile'
      AND s.occurred_at>=now()-interval '1 hour'*w.hours
    GROUP BY w.label,w.hours ORDER BY w.hours DESC`)).rows;
  const reasons = (await client.query(`SELECT coalesce(b.transport,'unknown') transport,
      s.outcome,coalesce(s.error_kind,'none') error_kind,count(*)::int attempts,
      count(*) FILTER(WHERE s.occurred_at>=now()-interval '1 hour')::int last_hour
    FROM scrape_outcome_log s LEFT JOIN bot_accounts b ON b.id=s.bot_id
    WHERE s.endpoint='profile' AND s.occurred_at>=now()-interval '24 hours'
    GROUP BY 1,2,3 ORDER BY 1,2,3`)).rows;
  const sinceRelease = (await client.query(`SELECT outcome,coalesce(error_kind,'none') error_kind,count(*)::int attempts
    FROM scrape_outcome_log WHERE endpoint='profile' AND occurred_at>=$1 GROUP BY 1,2 ORDER BY 1,2`,["2026-09-07T15:03:34.625Z"])).rows;
  const hourly = (await client.query(`SELECT date_trunc('hour',occurred_at) AS hour_start,
    count(*)::int attempts,count(*) FILTER(WHERE outcome='success')::int successes
    FROM scrape_outcome_log WHERE endpoint='profile' AND occurred_at>=now()-interval '6 hours'
    GROUP BY 1 ORDER BY 1`)).rows;
  const tracked = (await client.query(`SELECT t.ig_username,right(t.id,6) tracked_row,
    p.snapshot_at,round(extract(epoch FROM (now()-p.snapshot_at))/60)::int age_minutes,
    t.last_content_refresh_at
    FROM tracked_accounts t LEFT JOIN LATERAL (
      SELECT snapshot_at FROM profile_snapshots WHERE tracked_account_id=t.id
      ORDER BY snapshot_at DESC LIMIT 1) p ON true
    WHERE t.is_active ORDER BY t.ig_username,t.tracking_started`)).rows;
  const persisted = (await client.query(`SELECT count(*) FILTER(WHERE snapshot_at>=now()-interval '1 hour')::int snapshots_last_hour,
    count(*) FILTER(WHERE snapshot_at>=now()-interval '6 hours')::int snapshots_last_6h,
    max(snapshot_at) latest_snapshot FROM profile_snapshots`)).rows[0];
  const repeatedFailures = (await client.query(`SELECT count(*)::int failing_bots,
    count(*) FILTER(WHERE failures>=3)::int bots_with_3plus_failures,
    max(failures)::int most_failures_one_bot
    FROM (SELECT bot_id,count(*) failures FROM scrape_outcome_log
      WHERE endpoint='profile' AND outcome='failure' AND occurred_at>=now()-interval '6 hours'
      AND bot_id IS NOT NULL GROUP BY bot_id) x`)).rows[0];
  const screenshotWindow = (await client.query(`SELECT count(*)::int attempts,
    count(*) FILTER(WHERE outcome='success')::int successes,
    count(*) FILTER(WHERE outcome='failure')::int failures
    FROM scrape_outcome_log WHERE endpoint='profile'
      AND occurred_at>=$1::timestamptz-interval '24 hours'
      AND occurred_at<=$1::timestamptz`, ['2026-09-07T20:34:53.286Z'])).rows[0];
  const recentAuthContext = (await client.query(`WITH failed AS (
    SELECT bot_id,max(occurred_at) failed_at FROM scrape_outcome_log
    WHERE endpoint='profile' AND error_kind='auth'
      AND occurred_at>=now()-interval '1 hour' AND bot_id IS NOT NULL
    GROUP BY bot_id
  ) SELECT count(*)::int auth_failing_bots_last_hour,
    count(*) FILTER(WHERE EXISTS(SELECT 1 FROM scrape_outcome_log s
      WHERE s.bot_id=f.bot_id AND s.endpoint<>'profile' AND s.outcome='success'
        AND s.occurred_at>=f.failed_at-interval '6 hours' AND s.occurred_at<f.failed_at))::int
      with_other_endpoint_success_in_prior_6h
    FROM failed f`)).rows[0];
  console.log(JSON.stringify({ at,readOnly:true,windows,reasons,sinceRelease,hourly,tracked,persisted,repeatedFailures,screenshotWindow,recentAuthContext },null,2));
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  console.error(error instanceof Error ? error.message : "Profile health report failed"); process.exitCode=1;
} finally {await client.end();}
