// Bounded release observations. Server-enforced read-only; no workers, bot
// leases, Instagram requests, session changes, or opaque cursor disclosure.
import "dotenv/config";
import { createHash } from "node:crypto";
import { Client } from "pg";

const since = process.argv[2] ?? "2026-09-07T22:52:08.492Z";
if (!Number.isFinite(Date.parse(since))) throw new Error("Valid observation start required");
const client = new Client({ connectionString: process.env.DATABASE_URL,
  options: "-c default_transaction_read_only=on -c statement_timeout=15000 -c TimeZone=UTC" });
const fingerprint = (value: string | null) => value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : null;
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const at = (await client.query("SELECT now() AS at")).rows[0].at;
  const recentColumns=(await client.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='roster_background_sync' AND column_name IN ('last_head_read_at','last_head_count','head_status','next_head_run_at')")).rows[0].n===4;
  const recentFields=recentColumns ? "b.last_head_read_at,b.last_head_count,b.head_status,b.next_head_run_at,"
    : "NULL AS last_head_read_at,NULL AS last_head_count,NULL AS head_status,NULL AS next_head_run_at,";
  const rows = (await client.query(`SELECT t.ig_username,b.dimension,b.source,b.status,
    ${recentFields}
    b.baseline_complete_at,b.epoch_expected_count,b.epoch_seen_count,b.pages_completed,
    b.last_batch_count,b.last_progress_at,b.next_run_at,b.last_error IS NOT NULL AS has_error,
    r.last_complete_read_at,r.next_cursor,r.viewer_bot_id,r.epoch_started_at,r.epoch_legs,
    p.follower_count,p.snapshot_at,
    (SELECT count(*)::int FROM roster_members m WHERE m.tracked_account_id=t.id AND m.dimension=b.dimension AND m.is_current) held_current,
    (SELECT count(*)::int FROM follower_events e WHERE e.tracked_account_id=t.id AND e.detected_at >= $1::timestamptz) follower_events_since_release,
    (SELECT count(*)::int FROM follower_unfollow_events e WHERE e.tracked_account_id=t.id AND e.detected_at >= $1::timestamptz) follower_unfollow_events_since_release
    FROM roster_background_sync b JOIN tracked_accounts t ON t.id=b.tracked_account_id
    LEFT JOIN roster_sync_state r ON r.tracked_account_id=t.id AND r.dimension=b.dimension
    LEFT JOIN LATERAL(SELECT follower_count,snapshot_at FROM profile_snapshots WHERE tracked_account_id=t.id ORDER BY snapshot_at DESC LIMIT 1) p ON true
    ORDER BY t.ig_username,b.dimension`, [since])).rows;
  const bandwidth = (await client.query(`SELECT ig_username,endpoint,transport,byte_source,
    sum(requests)::bigint requests,sum(failures)::bigint failures,
    sum(bytes_in+bytes_out)::bigint attributed_bytes,max(occurred_at) latest_record
    FROM bandwidth_log WHERE occurred_at >= $1::timestamptz AND ig_username='tracked_user_4'
    GROUP BY 1,2,3,4 ORDER BY 2,3,4`, [since])).rows;
  const wireMeter=(await client.query(`SELECT count(*)::int samples,max(sampled_at) latest,
    count(*) FILTER(WHERE sample_key IS NOT NULL)-count(DISTINCT sample_key) duplicate_keys,
    coalesce(sum(bytes_in+bytes_out),0)::bigint measured_bytes
    FROM proxy_wire_samples WHERE sampled_at >= $1::timestamptz`,[since])).rows[0];
  const attributionDelivery=(await client.query(`SELECT count(*) FILTER(WHERE delivery_id IS NOT NULL)::int durable_rows,
    count(*) FILTER(WHERE delivery_id IS NOT NULL)-count(DISTINCT delivery_id) duplicate_ids,
    max(occurred_at) latest FROM bandwidth_log WHERE occurred_at >= $1::timestamptz`,[since])).rows[0];
  const output = [];
  for (const [table, column] of [["profile_snapshots", "snapshot_at"], ["posts_cache", "cached_at"], ["stories_cache", "cached_at"], ["highlights_cache", "cached_at"]]) {
    output.push({ table, ...(await client.query(`SELECT count(*)::int rows_since_release,max(${column}) latest FROM ${table} WHERE ${column} >= $1::timestamptz`, [since])).rows[0] });
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ at, since, readOnly: true,
    progress: rows.map(({next_cursor, viewer_bot_id, ...row}) => ({...row,
      hasCursor: !!next_cursor, cursorFingerprint: fingerprint(next_cursor), viewerFingerprint: fingerprint(viewer_bot_id)})),
    bandwidth, wireMeter, attributionDelivery, otherCollection: output }, null, 2));
} finally { await client.end(); }
