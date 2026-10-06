// Read-only per-roster diagnosis; no Instagram requests or scheduler changes.
import "dotenv/config";
import { Client } from "pg";
import { readFile } from "node:fs/promises";
const client=new Client({connectionString:process.env.DATABASE_URL,
  options:"-c default_transaction_read_only=on -c statement_timeout=15000 -c TimeZone=UTC"});
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const at=(await client.query("SELECT now() AS at")).rows[0].at;
  const rosters=(await client.query(`WITH canonical AS (
    SELECT DISTINCT ON (COALESCE(NULLIF(ig_user_id,''),lower(ig_username))) *
    FROM tracked_accounts WHERE is_active
    ORDER BY COALESCE(NULLIF(ig_user_id,''),lower(ig_username)),tracking_started,id
  ) SELECT c.ig_username,c.id,c.is_private,r.dimension,r.settled_at,
    r.last_member_count,r.last_attempt_at,r.last_success_at,r.last_complete_read_at,
    r.failure_kind,r.next_retry_at,r.last_error,
    (r.next_cursor IS NOT NULL AND r.next_cursor<>'') AS has_cursor,r.cursor_updated_at,
    r.epoch_started_at,r.epoch_completed_at,r.epoch_legs,
    r.epoch_start_member_count,
    CASE WHEN r.dimension='follower' THEN c.last_followers_refresh_at ELSE c.last_following_refresh_at END AS walk_anchor,
    CASE WHEN r.dimension='follower' THEN p.follower_count ELSE p.following_count END AS reported_count,
    members.held,members.seen_24h,members.seen_in_epoch
    FROM canonical c JOIN roster_sync_state r ON r.tracked_account_id=c.id
    LEFT JOIN LATERAL(SELECT follower_count,following_count FROM profile_snapshots
      WHERE tracked_account_id=c.id ORDER BY snapshot_at DESC LIMIT 1) p ON true
    LEFT JOIN LATERAL(SELECT count(*) FILTER(WHERE is_current)::int held,
      count(*) FILTER(WHERE is_current AND last_seen_at>=now()-interval '24 hours')::int seen_24h,
      count(*) FILTER(WHERE is_current AND last_seen_at>=r.epoch_started_at)::int seen_in_epoch
      FROM roster_members WHERE tracked_account_id=c.id AND dimension=r.dimension) members ON true
    ORDER BY c.ig_username,r.dimension`)).rows;
  await client.query("COMMIT");
  const rosterIds=new Set(rosters.map(r=>r.id));
  const logs=[];
  for(const line of (await readFile("/root/.pm2/logs/cheaterfinder-out.log","utf8")).split("\n")) {
    const start=line.indexOf("{");if(start<0)continue;
    let r;try{r=JSON.parse(line.slice(start));}catch{continue;}
    if(!(Date.parse(r.time)>=Date.parse("2026-09-07T15:03:34.625Z")))continue;
    if(!rosterIds.has(r.trackedAccountId)|| !/roster (?:walk outcome|gate decision|epoch|head-walk)|re-walk deferred|graph backoff|skipping unfollow diff|read epoch/.test(r.msg??""))continue;
    const item:Record<string,unknown>={};
    for(const key of ["time","trackedAccountId","username","kind","dimension","msg","ok","itemsFetched","pagesFetched","rawItemsFetched","distinctItemsFetched","complete","stopReason","resumed","hasResumeCursor","epochLeg","following","followers","legs","epochSeen","held","coverage","isCompleteRead","nextRetryAt","error"])if(r[key]!==undefined)item[key]=r[key];
    logs.push(item);
  }
  console.log(JSON.stringify({at,readOnly:true,rosters,logs},null,2));
} finally {await client.end();}
