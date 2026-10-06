import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fork, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { connect } from "node:net";

const [name, resultFile] = process.argv.slice(2);
// Prove the guard is installed; these rejections happen before any socket is
// opened. A missing guard must fail the run, not reach the production services.
assert.throws(()=>connect({host:"127.0.0.1",port:5432}),/STRESS_NETWORK_DENIED/);
assert.throws(()=>connect({host:"127.0.0.1",port:6379}),/STRESS_NETWORK_DENIED/);
await assert.rejects(fetch("https://example.invalid/stress-must-not-connect"),/STRESS_NETWORK_DENIED/);
assert.equal(process.env.STRIPE_SECRET_KEY,undefined);
assert.equal(process.env.RESEND_API_KEY,undefined);
const admin = new Pool({ connectionString: process.env.STRESS_ADMIN_URL, max: 3, connectionTimeoutMillis: 5000 });
const dbUrl = new URL(process.env.DATABASE_URL!);
assert.equal(dbUrl.hostname, "127.0.0.1");
assert.equal(dbUrl.pathname, "/cheaterfinder_stress_" + process.env.STRESS_NONCE!.replaceAll("-", ""));
assert.equal((await admin.query("SHOW data_directory")).rows[0].data_directory, process.env.STRESS_DATA_DIR);
assert.equal((await admin.query("SELECT nonce FROM stress_safety_marker")).rows[0].nonce, process.env.STRESS_NONCE);
const faultProxy=name==="bandwidth" ? await (await import("./pg-fault-proxy.js")).startPgFaultProxy(Number(dbUrl.port),Number(process.env.STRESS_FAULT_PORT)) : undefined;
if(faultProxy){dbUrl.port=process.env.STRESS_FAULT_PORT!;process.env.DATABASE_URL=dbUrl.toString();}
// Only now may application imports connect. No vi.mock or DB method spies.
const { pool, db } = await import("../../server/db.js");
const metrics: Record<string, unknown> = {};
metrics.safety={productionDbDenied:true,productionRedisDenied:true,externalHttpDenied:true,providerCredentialsAbsent:true};
const children = new Set<ChildProcess>();
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function eventually(check: () => Promise<boolean>, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  do { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } while (Date.now() < until);
  throw new Error("Timed out waiting for an observable DB/process condition");
}
async function user() {
  const id = randomUUID();
  await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic stress fixture')", [id, id + "@example.invalid"]);
  return id;
}
async function account(userId: string, username = "stress_" + randomUUID().replaceAll("-", "").slice(0,20)) {
  const id = randomUUID();
  await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,tracking_started) VALUES($1,$2,$3,$4,'2020-01-01')", [id,userId,username,id]);
  return id;
}
const members = (count: number, offset = 1) => Array.from({ length: count }, (_, n) => ({ username: `member_${offset + n}`, fullName: `Verified member ${offset + n}`, igUserId: `${offset + n}`, profilePicUrl: "", isPrivate: false, isVerified: false }));
const quantiles = (values: number[]) => {
  const v = [...values].sort((a,b) => a-b);
  return { samples: v.length, p50Ms: Math.round(v[Math.floor(v.length * .5)]), p95Ms: Math.round(v[Math.min(v.length - 1, Math.floor(v.length * .95))]), maxMs: Math.round(v.at(-1)!) };
};

async function billing() {
  const service = await import("../../server/services/customer-billing-lifecycle.js");
  const ids = await Promise.all(Array.from({ length: 20 }, user));
  const gate = deferred(); let entered = 0;
  const times: number[] = [];
  // Force all production-sized pool slots to hold a different customer's lock
  // before ANY callback asks the database for customer state. Deterministic
  // saturation, not a scheduler-dependent two-promise race.
  const jobs = ids.map(id => {
    const start = performance.now();
    return service.withCustomerBillingLock(id, async (...context: any[]) => {
      if (++entered === ids.length) gate.resolve();
      await gate.promise;
      // The optional context is ignored by the pre-fix implementation. This is
      // the same actual application lookup, not a fake query-success callback.
      const result = await (service.requireBillingUser as any)(id, context[0]);
      assert.equal(result.id, id);
      return result.id;
    }).finally(() => times.push(performance.now() - start));
  });
  const results = await Promise.allSettled(jobs);
  metrics.distinctCustomers = { concurrent: 20, entered, succeeded: results.filter(r=>r.status === "fulfilled").length, errors: results.flatMap(r=>r.status === "rejected" ? [String(r.reason?.cause?.message ?? r.reason?.message ?? r.reason)] : []), ...quantiles(times) };
  assert.equal(results.filter(r => r.status === "rejected").length, 0, "Different customers exhaust the pool while lock callbacks borrow another connection");

  let ownerEntered = 0;
  const held = deferred(), release = deferred();
  const owner = service.withCustomerBillingLock(ids[0], async () => { ++ownerEntered; held.resolve(); await release.promise; });
  await held.promise;
  const collisions = await Promise.allSettled(Array.from({ length: 100 }, () => service.withCustomerBillingLock(ids[0], async () => { ++ownerEntered; })));
  release.resolve(); await owner;
  assert.equal(ownerEntered, 1);
  assert(collisions.every(r => r.status === "rejected" && r.reason instanceof service.CustomerBillingBusyError));
  await service.withCustomerBillingLock(ids[0], async () => {});
  assert.equal((await admin.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory'")).rows[0].n, 0);
  metrics.sameCustomer = { contenders: 101, entered: ownerEntered, cleanBusyRejections: 100, leakedAdvisoryLocks: 0 };

  // End-to-end LOCAL deletion path: no Stripe API configured, no billing links.
  // Tests the call-site uses the lock's connection as well as the helper.
  const deletionIds = await Promise.all(Array.from({ length: 20 }, user));
  const deletes = await Promise.allSettled(deletionIds.map(id => service.deleteCustomerAccount(id, null)));
  metrics.localDeletions = { concurrent: 20, successful: deletes.filter(r => r.status === "fulfilled").length };
  assert(deletes.every(r => r.status === "fulfilled"), "Local account deletion must not self-starve the DB pool");
  assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE id=ANY($1::varchar[])", [deletionIds])).rows[0].n, 0);
}

async function credentials() {
  const service = await import("../../server/services/customer-credentials.js");
  const owner = await user(), other = await user();
  const oldHash = await bcrypt.hash("stress-old-password", 10);
  const alternatives = await Promise.all(["reset-password", "changed-password"].map(s => bcrypt.hash(s, 10)));
  await pool.query("UPDATE users SET hashed_password=$1 WHERE id=ANY($2::varchar[])", [oldHash,[owner,other]]);
  await pool.query(`INSERT INTO session(sid,sess,expire)
    SELECT gen_random_uuid()::text, json_build_object('passport', json_build_object('user',
      CASE WHEN i%2=0 THEN to_json($1::text) ELSE json_build_object('id',$1::text,'version',0) END)), now()+interval '1 day' FROM generate_series(1,500) i`, [owner]);
  await pool.query("INSERT INTO session(sid,sess,expire) VALUES($1,$2,now()+interval '1 day')", [randomUUID(), JSON.stringify({passport:{user:other}})]);
  await pool.query("INSERT INTO mobile_auth_sessions(id,user_id,refresh_digest,expires_at) SELECT gen_random_uuid(),$1,gen_random_uuid()::text,now()+interval '1 day' FROM generate_series(1,100)", [owner]);
  await pool.query("INSERT INTO mobile_auth_sessions(id,user_id,refresh_digest,expires_at) VALUES($1,$2,$1,now()+interval '1 day')", [randomUUID(),other]);
  const digests = Array.from({ length: 50 }, () => createHash("sha256").update(randomUUID()).digest("hex"));
  await pool.query("INSERT INTO password_reset_tokens(id,user_id,token,expires_at) SELECT gen_random_uuid(),$1,d,now()+interval '1 hour' FROM unnest($2::text[]) d", [owner,digests]);
  const blocker = await admin.connect();
  await blocker.query("BEGIN"); await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [owner]);
  const times: number[] = [];
  const operations = Array.from({ length: 100 }, (_, i) => {
    const start = performance.now();
    return (i % 2 === 0 ? service.applyCustomerPasswordReset(digests[i/2], alternatives[0]) : service.changeCustomerPassword(owner, oldHash, alternatives[1]))
      .then(value => ({ won: value === true || value === 1, kind: i % 2 }))
      .finally(() => times.push(performance.now()-start));
  });
  // Attach rejection handlers immediately; release even on a failed assertion.
  const settled = Promise.allSettled(operations);
  try {
    await eventually(async () => (await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n >= 10);
    metrics.observedWaitingDbTransactions = (await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n;
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  const results = await settled;
  metrics.contention = { operations:100, failures: results.filter(r=>r.status === "rejected").length, ...quantiles(times) };
  assert(results.every(r=>r.status === "fulfilled"), "Credential contention caused a timeout/deadlock");
  const winners = results.flatMap(r=>r.status === "fulfilled" && r.value.won ? [r.value] : []);
  assert.equal(winners.length, 1);
  const row = (await pool.query("SELECT session_version,hashed_password FROM users WHERE id=$1", [owner])).rows[0];
  assert.equal(row.session_version, 1);
  assert(await bcrypt.compare(winners[0].kind === 0 ? "reset-password" : "changed-password", row.hashed_password));
  assert.equal(await bcrypt.compare("stress-old-password", row.hashed_password), false);
  assert.equal((await pool.query("SELECT count(*)::int n FROM session WHERE sess::jsonb #>> '{passport,user}'=$1 OR sess::jsonb #>> '{passport,user,id}'=$1", [owner])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM mobile_auth_sessions WHERE user_id=$1 AND revoked_at IS NULL", [owner])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM session WHERE sess::jsonb #>> '{passport,user}'=$1", [other])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM mobile_auth_sessions WHERE user_id=$1 AND revoked_at IS NULL", [other])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT session_version FROM users WHERE id=$1", [other])).rows[0].session_version, 0);
  assert((await Promise.all(digests.map(d=>service.applyCustomerPasswordReset(d, oldHash)))).every(v=>v === false));
  metrics.oracle = { winners:1, versionIncrements:1, webSessionsRevoked:500, mobileSessionsRevoked:100, otherCustomerUnchanged:true, replayedTokensRejected:50, bcryptVerified:true };
}

async function roster() {
  const { persistFollowerDiff } = await import("../../server/services/public-data-persistence.js");
  const store = await import("../../server/services/roster-store.js");
  const owner = await user(), id = await account(owner), twin = await account(await user());
  const size = 335_609, old = new Date("2020-01-01T00:00:00Z");
  await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,following_count) VALUES($1,'synthetic_large', $2,0)", [id,size]);
  await pool.query("INSERT INTO roster_sync_state(tracked_account_id,dimension,settled_at,last_complete_read_at,last_success_at,last_member_count) VALUES($1,'follower',$2,$2,$2,$3)", [id,old,size]);
  const seedStart = performance.now();
  await pool.query(`INSERT INTO roster_members(tracked_account_id,dimension,username_lower,username,display_name,ig_user_id,first_seen_at,last_seen_at)
    SELECT $1,'follower','member_'||n,'member_'||n,'Original '||n,n::text,'2020-01-01','2020-01-01' FROM generate_series(1,$2::int) n`, [id,size]);
  await admin.query("ANALYZE roster_members");
  metrics.fixture = { actualDatabaseMembers:size, seedMs:Math.round(performance.now()-seedStart), note:"Existing long-roster state seeded in SQL; continuations, final evaluation and sibling copy use real application code (not 672 upstream fetches)" };
  const pageTimes: number[] = [], readTimes: number[] = [];
  await pool.query("INSERT INTO roster_background_sync(tracked_account_id,dimension) VALUES($1,'follower'),($2,'follower')",[id,twin]);
  await persistFollowerDiff(id, members(500), { baselineOnly:true, minimumCompleteReadMembers:Math.ceil(size*.9), leg:{startsEpoch:true,endsEpoch:false}, cursor:{nextCursor:"gql:stress-1",viewerBotId:null} });
  const epochStart=(await pool.query("SELECT epoch_started_at FROM roster_sync_state WHERE tracked_account_id=$1 AND dimension='follower'",[id])).rows[0].epoch_started_at;
  // Multiple duplicate/reordered capture deliveries while readers poll the
  // actual 335k table. Advisory locks must prevent lost writes/churn.
  await Promise.all([
    // Actual recent-head writes compete with deep continuations and customer
    // reads over the entire 335k table, without owning the deep cursor/epoch.
    ...Array.from({length:5},()=>persistFollowerDiff(id,members(100),{
      baselineOnly:true,leg:{startsEpoch:false,endsEpoch:false,headOnly:true},
      transactionCheckpoint:async tx=>{await tx.execute(sql`UPDATE roster_background_sync SET
        last_head_read_at=now(),last_head_count=100,head_status='checked'
        WHERE tracked_account_id=${id} AND dimension='follower'`);},
    })),
    ...Array.from({ length:10 }, (_, i) => (async()=>{
      const start = performance.now();
      const batch = members(500, 501 + (i%5)*500);
      const result = await persistFollowerDiff(id, [...batch,...batch.slice(0,50)].reverse(), {baselineOnly:true,leg:{startsEpoch:false,endsEpoch:false}});
      assert.deepEqual(result,{newFollowers:0,newFollowerUnfollows:0});
      pageTimes.push(performance.now()-start);
    })()),
    ...Array.from({length:4}, async()=>{
      for(let i=0;i<5;i++) {
        const start=performance.now();
        const rows=await pool.query("SELECT username_lower FROM roster_members WHERE tracked_account_id=$1 AND is_current ORDER BY first_seen_at,username_lower LIMIT 100 OFFSET $2",[id,(i*7999)%size]);
        assert.equal(rows.rowCount,100);assert.equal(new Set(rows.rows.map(r=>r.username_lower)).size,100);
        readTimes.push(performance.now()-start);
      }
    }),
  ]);
  let health=await store.getRosterSyncHealth(id,"follower");
  const epochAfter=(await pool.query("SELECT epoch_started_at,epoch_legs FROM roster_sync_state WHERE tracked_account_id=$1 AND dimension='follower'",[id])).rows[0];
  assert.equal(+epochAfter.epoch_started_at,+epochStart);
  assert.equal(epochAfter.epoch_legs,11,"Five head checks must not be counted as deep epoch legs");
  assert.equal(await store.loadRosterCursor(id,"follower"),"gql:stress-1");
  assert.equal((await pool.query("SELECT last_head_count FROM roster_background_sync WHERE tracked_account_id=$1",[id])).rows[0].last_head_count,100);
  metrics.recentLane={concurrentHeads:5,concurrentDeepLegs:10,deepCursorPreserved:true,epochLegs:11,fullClockUnchanged:true};
  assert.equal(health.lastCompleteReadAt?.getTime(),old.getTime(),"Partial pages must not turn the full-roster clock green");
  assert.equal((await pool.query("SELECT count(*)::int n FROM roster_members WHERE tracked_account_id=$1 AND is_current",[id])).rows[0].n,size);
  // An exhausted-but-short response is still not a completed full roster.
  await persistFollowerDiff(id,members(48),{baselineOnly:true,minimumCompleteReadMembers:Math.ceil(size*.9),leg:{startsEpoch:false,endsEpoch:true}});
  assert.equal((await store.getRosterSyncHealth(id,"follower")).lastCompleteReadAt?.getTime(),old.getTime());
  // Represent durable earlier legs of a nearly-completed walk, then execute
  // the real final-page transaction and its full 335k-member absence pass.
  await persistFollowerDiff(id,members(500),{baselineOnly:true,leg:{startsEpoch:true,endsEpoch:false}});
  await pool.query("UPDATE roster_members SET last_seen_at=clock_timestamp() WHERE tracked_account_id=$1 AND ig_user_id::int<=$2",[id,size-500]);
  const completeStart=performance.now();
  await persistFollowerDiff(id,members(500,size-499),{baselineOnly:true,minimumCompleteReadMembers:Math.ceil(size*.9),leg:{startsEpoch:false,endsEpoch:true},cursor:{nextCursor:null,viewerBotId:null}});
  metrics.finalEpochMs=Math.round(performance.now()-completeStart);
  health=await store.getRosterSyncHealth(id,"follower");
  assert(health.lastCompleteReadAt && health.lastCompleteReadAt>old);
  assert.equal(await store.loadRosterCursor(id,"follower"),null);
  const copyStart=performance.now();
  const copied=await store.copyRosterFromSibling(id,twin,"follower",{copyBackgroundProgress:true});
  assert.equal(copied.currentMembers,size);
  // Independent SQL oracle compares ALL serving fields, not just counts.
  const mismatch=await pool.query(`SELECT count(*)::int n FROM (
    (SELECT username_lower,display_name,ig_user_id,is_current,missing_streak,first_seen_at,last_seen_at FROM roster_members WHERE tracked_account_id=$1
     EXCEPT SELECT username_lower,display_name,ig_user_id,is_current,missing_streak,first_seen_at,last_seen_at FROM roster_members WHERE tracked_account_id=$2)
    UNION ALL
    (SELECT username_lower,display_name,ig_user_id,is_current,missing_streak,first_seen_at,last_seen_at FROM roster_members WHERE tracked_account_id=$2
     EXCEPT SELECT username_lower,display_name,ig_user_id,is_current,missing_streak,first_seen_at,last_seen_at FROM roster_members WHERE tracked_account_id=$1)
  ) differences`,[id,twin]);
  assert.equal(mismatch.rows[0].n,0);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM roster_background_sync a JOIN roster_background_sync b ON b.tracked_account_id=$2 AND b.dimension=a.dimension
    WHERE a.tracked_account_id=$1 AND (a.last_head_read_at IS DISTINCT FROM b.last_head_read_at OR a.last_head_count IS DISTINCT FROM b.last_head_count OR a.head_status IS DISTINCT FROM b.head_status)`,[id,twin])).rows[0].n,0);
  // A count alone would miss replacement/corruption: verify the generated set.
  assert.equal((await pool.query("SELECT count(*)::int n FROM generate_series(1,$2::int) x WHERE NOT EXISTS(SELECT 1 FROM roster_members r WHERE r.tracked_account_id=$1 AND r.username_lower='member_'||x AND r.is_current)",[id,size])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM follower_events WHERE tracked_account_id=ANY($1::varchar[])",[[id,twin]])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM follower_unfollow_events WHERE tracked_account_id=ANY($1::varchar[])",[[id,twin]])).rows[0].n,0);
  metrics.copy={members:copied.currentMembers,ms:Math.round(performance.now()-copyStart),fieldMismatches:0};
  metrics.continuations=quantiles(pageTimes);metrics.concurrentReads=quantiles(readTimes);
  metrics.oracle={missingMembers:0,fakeArrivalEvents:0,fakeDepartureEvents:0,partialClockUnchanged:true,verifiedCompleteClockAdvanced:true};
}

async function rosterPool() {
  const persist=await import("../../server/services/public-data-persistence.js");
  const owner=await user();
  const ids=await Promise.all(Array.from({length:20},()=>account(owner)));
  await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,following_count) SELECT x,'pool_fixture',100,100 FROM unnest($1::varchar[]) x",[ids]);
  for(const dimension of ["follower","following"] as const){
    const gate=deferred();let entered=0,peakExtraBorrowers=0;
    const durations:number[]=[];
    let sampler:ReturnType<typeof setInterval>|undefined;
    const write=dimension==="follower"?persist.persistFollowerDiff:persist.persistFollowingDiff;
    try {
      await Promise.all(ids.map(id=>{
        const start=performance.now();
        return write(id,members(50),{
          baselineOnly:true,leg:{startsEpoch:true,endsEpoch:false},
          transactionGuard:async()=>{
            if(++entered===20){
              sampler=setInterval(()=>{peakExtraBorrowers=Math.max(peakExtraBorrowers,pool.waitingCount);},5);
              gate.resolve();
            }
            await gate.promise;
          },
        }).finally(()=>durations.push(performance.now()-start));
      }));
    } finally {if(sampler)clearInterval(sampler);}
    metrics[dimension]={concurrentTransactions:20,entered,peakExtraPoolBorrowers:peakExtraBorrowers,...quantiles(durations)};
    assert.equal((await pool.query("SELECT count(*)::int n FROM roster_members WHERE tracked_account_id=ANY($1::varchar[]) AND dimension=$2",[ids,dimension])).rows[0].n,1000);
    assert.equal(peakExtraBorrowers,0,`${dimension} persistence tries to borrow extra pool connections while all 20 transactions already hold a connection`);
  }
}

function child(mode: string, id: string, key: string) {
  const proc=fork(new URL("./crash-child.ts",import.meta.url),[mode,id,key],{execArgv:["--import","tsx"],env:process.env,stdio:["ignore","inherit","inherit","ipc"]});
  children.add(proc);proc.once("exit",()=>children.delete(proc));
  return proc;
}
function message(proc:ChildProcess, stage:string) {
  return new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error(`Child did not reach ${stage}`));},15_000);
    const receive=(m:any)=>{if(m.stage===stage){cleanup();resolve(m);}};
    const exit=(code:number|null,signal:string|null)=>{cleanup();reject(new Error(`Child exited ${code}/${signal} before ${stage}`));};
    function cleanup(){clearTimeout(timer);proc.off("message",receive);proc.off("exit",exit);}
    proc.on("message",receive);proc.once("exit",exit);
  });
}
async function kill(proc:ChildProcess) {const done=new Promise(r=>proc.once("exit",r));assert(proc.kill("SIGKILL"));await done;}
async function crash() {
  const {persistFollowerDiff}=await import("../../server/services/public-data-persistence.js");
  const store=await import("../../server/services/roster-store.js");
  const {withOperationLease}=await import("../../server/services/operation-lease.js");
  const id=await account(await user()),key=`stress-crash:${id}`;
  await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,follower_count,following_count) VALUES($1,'crash_fixture',2000,0)",[id]);
  await pool.query("INSERT INTO roster_background_sync(tracked_account_id,dimension,pages_completed) VALUES($1,'follower',1)",[id]);
  await persistFollowerDiff(id,members(500),{baselineOnly:true,leg:{startsEpoch:true,endsEpoch:false},cursor:{nextCursor:"gql:committed",viewerBotId:null}});
  const dying=child("checkpoint",id,key);await message(dying,"checkpoint-uncommitted");
  // Independent reader sees only the prior committed checkpoint.
  assert.equal((await pool.query("SELECT count(*)::int n FROM roster_members WHERE tracked_account_id=$1",[id])).rows[0].n,500);
  assert.equal(await store.loadRosterCursor(id,"follower"),"gql:committed");
  await kill(dying);
  await eventually(async()=> (await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n===0);
  assert.equal((await pool.query("SELECT pages_completed FROM roster_background_sync WHERE tracked_account_id=$1",[id])).rows[0].pages_completed,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM roster_members WHERE tracked_account_id=$1",[id])).rows[0].n,500);
  assert.equal(await store.loadRosterCursor(id,"follower"),"gql:committed");
  // Expiry accelerated ONLY in the private cluster; production TTL unchanged.
  await pool.query("UPDATE backend_operation_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE key=$1",[key]);
  await withOperationLease(key,async(_signal,guard)=>persistFollowerDiff(id,members(500,501),{baselineOnly:true,leg:{startsEpoch:false,endsEpoch:false},cursor:{nextCursor:"gql:resumed",viewerBotId:null},transactionGuard:guard.assertOwned,transactionCheckpoint:async tx=>{await tx.execute(sql`UPDATE roster_background_sync SET pages_completed=2 WHERE tracked_account_id=${id}`);}}));
  assert.equal((await pool.query("SELECT count(*)::int n FROM roster_members WHERE tracked_account_id=$1",[id])).rows[0].n,1000);
  assert.equal(await store.loadRosterCursor(id,"follower"),"gql:resumed");
  assert.equal((await pool.query("SELECT pages_completed FROM roster_background_sync WHERE tracked_account_id=$1",[id])).rows[0].pages_completed,2);
  metrics.hardKill={signal:"SIGKILL",point:"after member/cursor/checkpoint SQL, before COMMIT",committedBefore:500,afterCrash:500,afterResume:1000,checkpointRolledBack:true};
  const stale=child("stale-owner",id,key);await message(stale,"lease-acquired");
  await pool.query("UPDATE backend_operation_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE key=$1",[key]);
  await withOperationLease(key,async()=>{
    const replacement=(await pool.query("SELECT token FROM backend_operation_leases WHERE key=$1",[key])).rows[0].token;
    const response=message(stale,"stale-rejected");stale.send({stage:"attempt-write"});
    assert.match((await response).error,/lease lost/);
    assert.equal((await pool.query("SELECT token FROM backend_operation_leases WHERE key=$1",[key])).rows[0].token,replacement,"Stale owner's finally deleted its successor's lease");
  });
  assert.equal((await pool.query("SELECT count(*)::int n FROM roster_members WHERE tracked_account_id=$1 AND username_lower='stale_must_not_exist'",[id])).rows[0].n,0);
  metrics.staleOwner={actualSeparateProcess:true,staleWriteRejected:true,successorLeasePreserved:true};
}

async function bandwidth() {
  const {bandwidthScenario}=await import("./bandwidth-scenario.js");
  assert(faultProxy);
  await bandwidthScenario(admin,faultProxy,metrics);
}

let failure: unknown;
try {
  const cases:Record<string,()=>Promise<void>>={billing,credentials,"roster-pool":rosterPool,roster,crash,bandwidth};
  assert(cases[name],"Unknown stress case");
  await cases[name]();
} catch(error) {failure=error;console.error(error);}
finally {
  for(const proc of children) await kill(proc).catch(()=>{});
  metrics.maxRssMiB=Math.round(process.resourceUsage().maxRSS/1024);
  await writeFile(resultFile,JSON.stringify({passed:!failure,metrics,...(failure?{error:failure instanceof Error?failure.stack:String(failure)}:{})},null,2)+"\n");
  await pool.end();await faultProxy?.close();await admin.end();
  // Some imported app modules own idle Redis connections. This isolated
  // scenario process exits after DB completion; the runner stops its Redis.
  process.exit(failure?1:0);
}
