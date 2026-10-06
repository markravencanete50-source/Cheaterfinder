import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { pool, db } from "../../server/db.js";
import { withOperationLease } from "../../server/services/operation-lease.js";
import { persistFollowerDiff } from "../../server/services/public-data-persistence.js";
const [mode,id,key]=process.argv.slice(2);
assert.equal(new URL(process.env.DATABASE_URL!).pathname,"/cheaterfinder_stress_"+process.env.STRESS_NONCE!.replaceAll("-",""));
assert.equal((await pool.query("SELECT nonce FROM stress_safety_marker")).rows[0].nonce,process.env.STRESS_NONCE);
try {
  await withOperationLease(key,async(_signal,guard)=>{
    if(mode==="checkpoint") {
      await persistFollowerDiff(id,Array.from({length:500},(_,n)=>({username:`member_${501+n}`,fullName:`Crash ${n}`,igUserId:`${501+n}`,profilePicUrl:"",isPrivate:false,isVerified:false})),{
        baselineOnly:true,leg:{startsEpoch:false,endsEpoch:false},cursor:{nextCursor:"gql:UNCOMMITTED",viewerBotId:null},transactionGuard:guard.assertOwned,
        transactionCheckpoint:async tx=>{
          await tx.execute(sql`UPDATE roster_background_sync SET pages_completed=999 WHERE tracked_account_id=${id}`);
          process.send!({stage:"checkpoint-uncommitted",pid:process.pid});
          await new Promise(()=>{}); // Parent kills THIS fixture after observing IPC.
        },
      });
    } else if(mode==="stale-owner") {
      const resume=new Promise<void>(resolve=>process.once("message",()=>resolve()));
      process.send!({stage:"lease-acquired"});await resume;
      await db.transaction(async tx=>{
        await guard.assertOwned(tx);
        await tx.execute(sql`INSERT INTO roster_members(tracked_account_id,dimension,username_lower,username) VALUES(${id},'follower','stale_must_not_exist','stale_must_not_exist')`);
      });
      throw new Error("Stale owner unexpectedly wrote data");
    } else throw new Error("Unknown fixture mode");
  });
  process.exitCode=1;
} catch(error) {
  if(mode!=="stale-owner") throw error;
  // This message is after withOperationLease's finally has finished.
  await new Promise<void>(resolve=>process.send!({stage:"stale-rejected",error:String((error as Error).message)},()=>resolve()));
} finally {await pool.end();process.exit(process.exitCode??0);}
