// Read-only live status: DB snapshot, Redis queue reads and local health GETs.
import "dotenv/config";
import { Client } from "pg";
import IORedis from "ioredis";
import { PgDialect } from "drizzle-orm/pg-core";
import { collectionHealthQuery } from "../services/collection-health.js";
import { healthyPrivateReaderTargetIds } from "../services/private-account-access.js";
import { pool } from "../db.js";
import { createAutomationClient } from "../services/automation-client.js";

const client=new Client({connectionString:process.env.DATABASE_URL,
  options:"-c default_transaction_read_only=on -c statement_timeout=15000 -c TimeZone=UTC"});
const redis=new IORedis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:1,connectTimeout:5000});
const names=["collection-profile","collection-likes","collection-follows","collection-roster","report-generate","email-send","weekly-report","bot-follow-request","bot-follow-check","retention","refresh-sweep","bot-cooldown-probe","bot-pool-rescue","bot-warmer"];
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const at=(await client.query("SELECT now() AS at")).rows[0].at;
  const outcomes=(await client.query(`SELECT endpoint,count(*)::int attempts,
    count(*) FILTER(WHERE outcome='success')::int successes,
    count(*) FILTER(WHERE outcome='failure')::int failures,
    max(occurred_at) FILTER(WHERE outcome='success') AS latest_success
    FROM scrape_outcome_log WHERE occurred_at>=now()-interval '1 hour' GROUP BY 1 ORDER BY 1`)).rows;
  const jobs=(await client.query(`SELECT job_type,status,count(*)::int jobs,
    max(completed_at) latest_completion,max(started_at) latest_start
    FROM collection_jobs WHERE started_at>=now()-interval '6 hours' OR completed_at>=now()-interval '6 hours'
    GROUP BY 1,2 ORDER BY 1,2`)).rows;
  const persisted=[];
  for(const [table,column] of [["profile_snapshots","snapshot_at"],["posts_cache","cached_at"],
    ["stories_cache","cached_at"],["highlights_cache","cached_at"],["like_events","detected_at"],
    ["follow_events","detected_at"],["follower_events","detected_at"],["reports","created_at"]]) {
    persisted.push({table,...(await client.query(`SELECT count(*) FILTER(WHERE ${column}>=now()-interval '1 hour')::int rows_last_hour,
      count(*) FILTER(WHERE ${column}>=now()-interval '6 hours')::int rows_last_6h,max(${column}) latest FROM ${table}`)).rows[0]});
  }
  const query=new PgDialect().sqlToQuery(collectionHealthQuery(await healthyPrivateReaderTargetIds()));
  const collection=(await client.query(query.sql,query.params)).rows[0].health;
  const overdueProfiles=(await client.query(`SELECT count(*)::int active_rows,
    count(*) FILTER(WHERE p.at IS NULL OR p.at<now()-interval '3 hours')::int snapshots_older_than_3h,
    min(p.at) oldest_latest_snapshot
    FROM tracked_accounts t LEFT JOIN LATERAL(SELECT max(snapshot_at) at FROM profile_snapshots WHERE tracked_account_id=t.id) p ON true
    WHERE t.is_active`)).rows[0];
  await client.query("COMMIT");
  const redisPing=await redis.ping();
  const queues=await Promise.all(names.map(async name=>{
    const key=`bull:${name}`;
    const [waiting,active,delayed,failedRetained,failedLast24h,completedLastHour,paused,prioritized,activeIds]=await Promise.all([
      redis.llen(key+":wait"),redis.llen(key+":active"),redis.zcard(key+":delayed"),redis.zcard(key+":failed"),
      redis.zcount(key+":failed",Date.now()-86400000,"+inf"),redis.zcount(key+":completed",Date.now()-3600000,"+inf"),
      redis.hget(key+":meta","paused"),redis.zcard(key+":prioritized"),redis.lrange(key+":active",0,19)]);
    const activeLocks=await Promise.all(activeIds.map(async id=>({
      lockTtlMs:await redis.pttl(key+":"+id+":lock"),
      processedOn:await redis.hget(key+":"+id,"processedOn")})));
    return {name,waiting,active,delayed,prioritized,paused:paused==="1",failedRetained,failedLast24h,completedLastHour,activeLocks};
  }));
  const automation=await createAutomationClient().health().catch(e=>({error:e instanceof Error?e.message:"health failed"}));
  const web=await fetch(`http://127.0.0.1:${process.env.PORT??5000}/api/health`,{signal:AbortSignal.timeout(5000)})
    .then(async r=>({status:r.status,body:await r.json()})).catch(()=>({error:"local app health GET failed"}));
  console.log(JSON.stringify({at,readOnly:true,outcomes,jobs,persisted,collection,overdueProfiles,redisPing,queues,automation,web},null,2));
} catch(error) {
  console.error(error instanceof Error?error.message:"System status report failed");process.exitCode=1;
} finally {await client.end();await redis.quit();await pool.end();}
