// Read-only, explicit UTC windows. Works before and after migration 0048.
// Never equate decoded HTTP bytes with proxy-wire bytes or zero new events
// with a failed refresh. Run both windows for comparable before/after evidence.
import "dotenv/config";
import { Client } from "pg";

const arg = (name: string) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const until = new Date(arg("until") ?? Date.now());
const since = new Date(arg("since") ?? until.getTime() - 30 * 60_000);
if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) throw new Error("Invalid UTC report window");
const client = new Client({ connectionString: process.env.DATABASE_URL,
  options: "-c default_transaction_read_only=on -c statement_timeout=15000 -c TimeZone=UTC" });
async function main() {
  await client.connect();
  const query = async (text: string) => (await client.query(text, [since, until])).rows;
  const report = {
    capturedAt: new Date().toISOString(), since: since.toISOString(), until: until.toISOString(),
    durationMinutes: (until.getTime() - since.getTime()) / 60_000,
    wire: await query(`SELECT count(*)::int samples, COALESCE(sum(bytes_in+bytes_out),0)::text bytes,
      COALESCE(sum(span_seconds),0)::text sampled_seconds FROM proxy_wire_samples WHERE sampled_at >= $1 AND sampled_at < $2`),
    outcomes: await query(`SELECT s.endpoint,b.transport,count(*)::int attempts,
      count(*) FILTER (WHERE s.outcome='success')::int successes,
      count(*) FILTER (WHERE s.outcome<>'success')::int failures
      FROM scrape_outcome_log s LEFT JOIN bot_accounts b ON b.id=s.bot_id
      WHERE s.occurred_at >= $1 AND s.occurred_at < $2 GROUP BY s.endpoint,b.transport ORDER BY s.endpoint,b.transport`),
    attributedBytes: await query(`SELECT endpoint,COALESCE(to_jsonb(b)->>'byte_source','legacy_mixed') byte_source,
      sum(requests)::int requests,sum(bytes_in+bytes_out)::text bytes
      FROM bandwidth_log b WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY 1,2 ORDER BY 1,2`),
    output: await query(`SELECT
      (SELECT count(*) FROM (SELECT DISTINCT COALESCE(NULLIF(t.ig_user_id,''),lower(t.ig_username)),l.post_id
        FROM like_events l JOIN tracked_accounts t ON t.id=l.tracked_account_id
        WHERE l.detected_at >= $1 AND l.detected_at < $2) x)::int new_distinct_likes,
      (SELECT count(*) FROM follower_events WHERE detected_at >= $1 AND detected_at < $2)::int follower_events,
      (SELECT count(*) FROM follow_events WHERE detected_at >= $1 AND detected_at < $2)::int follow_events,
      (SELECT count(*) FROM posts_cache WHERE cached_at >= $1 AND cached_at < $2)::int newly_cached_posts`),
    // Snapshot, not a historical reconstruction of these mutable timestamps.
    freshnessNow: (await client.query(`SELECT DISTINCT ON (COALESCE(NULLIF(ig_user_id,''),lower(ig_username)))
      ig_username,last_content_refresh_at,last_followers_refresh_at,last_following_refresh_at,last_like_evidence_scan_at
      FROM tracked_accounts WHERE is_active ORDER BY COALESCE(NULLIF(ig_user_id,''),lower(ig_username)),tracking_started,id`)).rows,
  };
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error("Report failed:", error.code ?? error.name); process.exitCode = 1; })
  .finally(() => client.end());
