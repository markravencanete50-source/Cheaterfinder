// Exact production query checks / checkpoint report. No jobs, writes or IG reads.
import "dotenv/config";
import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { db,pool } from "../db.js";
import { buildLeaseCandidateQuery } from "../ig-public-scraper.js";
import { dueBackgroundRosterQuery } from "../services/roster-background-sync.js";
const client=await pool.connect();
try {
  const query=buildLeaseCandidateQuery(db,{label:"followers",viewer:{pin:true,rosterSource:"graphql",savedSessionOnly:true}}).toSQL();
  await client.query("EXPLAIN "+query.sql,query.params);
  // The exact lease SELECT carries FOR UPDATE; its transient lock is released
  // immediately in autocommit. No UPDATE/reservation follows this diagnostic.
  const lease=(await client.query(query.sql,query.params)).rows[0];
  console.log(JSON.stringify({query:"graphql-saved-viewer-lease",passed:true,candidate:!!lease,transport:lease?.transport??null}));
  await client.query("BEGIN READ ONLY");await client.query("SET LOCAL statement_timeout='15s'");
  const due=new PgDialect().sqlToQuery(dueBackgroundRosterQuery());
  const plan=(await client.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+due.sql,due.params)).rows[0]["QUERY PLAN"][0];
  console.log(JSON.stringify({query:"background-due",executionMs:plan["Execution Time"],rows:(await client.query(due.sql,due.params)).rowCount}));
  const rows=(await client.query(`SELECT t.ig_username,b.dimension,b.source,b.status,b.baseline_complete_at,b.epoch_expected_count,b.epoch_seen_count,b.pages_completed,b.last_batch_count,b.last_progress_at,b.next_run_at,
    s.last_complete_read_at,s.next_cursor,s.viewer_bot_id,s.epoch_legs,
    (SELECT count(*)::int FROM roster_members m WHERE m.tracked_account_id=t.id AND m.dimension=b.dimension AND m.is_current) AS held_current
    FROM roster_background_sync b JOIN tracked_accounts t ON t.id=b.tracked_account_id
    LEFT JOIN roster_sync_state s ON s.tracked_account_id=t.id AND s.dimension=b.dimension
    ORDER BY t.ig_username,b.dimension`)).rows;
  const fingerprint=(v:string|null)=>v?createHash("sha256").update(v).digest("hex").slice(0,12):null;
  console.log(JSON.stringify({at:new Date().toISOString(),progress:rows.map(({next_cursor,viewer_bot_id,...row})=>({...row,hasCursor:!!next_cursor,cursorFingerprint:fingerprint(next_cursor),viewerFingerprint:fingerprint(viewer_bot_id)}))}));
  await client.query("COMMIT");
} catch(error) {await client.query("ROLLBACK");console.error(error instanceof Error?error.message:"query check failed");process.exitCode=1;}
finally {client.release();await pool.end();}
// Imported application singletons may hold Redis/transport handles; this
// operator-only script has finished all checks and does not start workers.
process.exit(Number(process.exitCode ?? 0));
