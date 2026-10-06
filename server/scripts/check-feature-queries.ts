// Read-only EXPLAIN ANALYZE + SELECT of the exact new feature query builders.
import "dotenv/config";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { pool } from "../db.js";
import { adminActivityQuery } from "../services/admin-activity.js";
import { collectionHealthQuery } from "../services/collection-health.js";
import { healthyPrivateReaderTargetIds } from "../services/private-account-access.js";
import { visibleRosterDeparturesSql, visibleFollowerUnfollowsSql } from "../services/roster.js";
const dialect = new PgDialect(), client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout='15s'");
  const check = async (label:string, query:SQL) => {
    const compiled = dialect.sqlToQuery(query);
    const plan = await client.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+compiled.sql,compiled.params);
    const result = await client.query(compiled.sql,compiled.params);
    console.log(JSON.stringify({label,executionMs:plan.rows[0]["QUERY PLAN"][0]["Execution Time"],rows:result.rowCount,
      total:result.rows[0]?.total,summary:result.rows[0]?.summary,health:result.rows[0]?.health}));
  };
  const healthyPrivateTargets = await healthyPrivateReaderTargetIds();
  await check("admin-activity",adminActivityQuery({type:"all",search:"",limit:30,offset:0},healthyPrivateTargets));
  await check("collection-health",collectionHealthQuery(healthyPrivateTargets));
  const rows=(await client.query(`SELECT DISTINCT ON (COALESCE(NULLIF(t.ig_user_id,''),lower(t.ig_username)))
    t.id,t.tracking_started,GREATEST(t.tracking_started,t.following_first_complete_at,s.settled_at) boundary
    FROM tracked_accounts t LEFT JOIN roster_sync_state s ON s.tracked_account_id=t.id AND s.dimension='following'
    WHERE t.is_active ORDER BY COALESCE(NULLIF(t.ig_user_id,''),lower(t.ig_username)),t.tracking_started,t.id`)).rows;
  for(const row of rows){
    await check("confirmed-following-departures",sql`SELECT count(*)::int total FROM roster_members WHERE ${visibleRosterDeparturesSql(row.id,row.boundary)}`);
    await check("confirmed-follower-departures",sql`SELECT count(*)::int total FROM follower_unfollow_events WHERE ${visibleFollowerUnfollowsSql(row.id,row.tracking_started)}`);
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({passed:2+rows.length*2,at:new Date().toISOString(),readOnly:true}));
} catch(error) {
  await client.query("ROLLBACK");
  console.error("Feature query validation failed",error instanceof Error?error.message:"unknown"); process.exitCode=1;
} finally {client.release();await pool.end();}
process.exit(Number(process.exitCode ?? 0));
