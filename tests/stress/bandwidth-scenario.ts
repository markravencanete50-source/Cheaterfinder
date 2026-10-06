import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { PgFaultProxy } from "./pg-fault-proxy.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function bandwidthScenario(admin:Pool,proxy:PgFaultProxy,metrics:Record<string,unknown>) {
  const meter=await import("../../server/services/bandwidth-meter.js");
  const customers=Array.from({length:450},()=>({userId:randomUUID(),trackedAccountId:randomUUID()}));
  // Real synthetic customer + tracking rows, not just arbitrary IDs in the
  // meter. This exercises the report's LEFT JOIN and the UI owner labels.
  await admin.query("INSERT INTO users(id,email,name) SELECT x.id,x.email,'Stress customer' FROM jsonb_to_recordset($1::jsonb) AS x(id varchar(36),email text)",[
    JSON.stringify(customers.map((c,i)=>({id:c.userId,email:`stress-meter-${i}@example.invalid`})))]);
  await admin.query("INSERT INTO tracked_accounts(id,user_id,ig_username) SELECT x.id,x.user_id,x.username FROM jsonb_to_recordset($1::jsonb) AS x(id varchar(36),user_id varchar(36),username text)",[
    JSON.stringify(customers.map((c,i)=>({id:c.trackedAccountId,user_id:c.userId,username:`stress_meter_${i}`})))]);
  assert.equal((await admin.query("SELECT count(*)::int n FROM users WHERE id=ANY($1::varchar[])",[customers.map(c=>c.userId)])).rows[0].n,450);
  const expected={bytesIn:0,bytesOut:0,requests:0,failures:0,xhr:0};
  const record=(i:number)=>{
    const bytesIn=100+(i%100),bytesOut=20+(i%10),failed=i%7===0;
    expected.bytesIn+=bytesIn;expected.bytesOut+=bytesOut;expected.requests++;expected.failures+=Number(failed);expected.xhr+=bytesIn;
    return meter.withScrapeContext({...customers[i%450],username:`stress_meter_${i%450}`},async()=>{
      // Yield inside ALS to interleave 128 producers' attribution contexts.
      await Promise.resolve();
      meter.recordBytes({endpoint:`stress_endpoint_${Math.floor(i/450)%24}`,bytesIn,bytesOut,byteSource:"browser_wire",failed,resourceBytes:{xhr:bytesIn}});
    });
  };
  // Force a real transport outage BEFORE a DB connection can be established.
  proxy.control.offline=true;
  await Promise.all(Array.from({length:128},async(_,producer)=>{
    for(let i=producer;i<10_050;i+=128)await record(i);
  }));
  assert.equal(await meter.flushBandwidth(),0);
  assert(proxy.control.rejectedConnections>0,"Outage was not actually exercised");
  assert.equal((await admin.query("SELECT count(*)::int n FROM bandwidth_log")).rows[0].n,0);
  metrics.outage={concurrentProducers:128,requestsRecorded:expected.requests,rejectedTcpConnections:proxy.control.rejectedConnections,rowsBeforeRecovery:0};
  proxy.control.offline=false;proxy.control.dropNextInsertAck=true;
  assert.equal(await meter.flushBandwidth(),0,"Client must not receive a false acknowledgement");
  assert.equal(proxy.control.ackDrops,1);
  const committed=(await admin.query("SELECT count(*)::int n FROM bandwidth_log")).rows[0].n;
  assert.equal(committed,1000,"Independent observer must see the first committed chunk after its ACK was dropped");
  metrics.ambiguousCommit={actualTcpAckDrops:1,rowsCommittedBeforeClientAck:committed,chunkSize:1000};
  // New traffic while the older 5,001 buckets wait for retry; separate delivery
  // identity, even when it reuses exactly the same attribution key.
  await Promise.all(Array.from({length:100},(_,i)=>record(i)));
  const flushes=Array.from({length:100},()=>meter.flushBandwidth());
  assert(flushes.every(f=>f===flushes[0]),"Concurrent timer/report flushes did not coalesce");
  await Promise.all(flushes);
  const totals=async()=> (await admin.query(`SELECT sum(bytes_in)::text AS incoming,sum(bytes_out)::text AS outgoing,sum(requests)::int AS requests,sum(failures)::int AS failures,
    sum((resource_bytes->>'xhr')::bigint)::text AS xhr,count(*)::int AS buckets,count(DISTINCT delivery_id)::int AS identities FROM bandwidth_log`)).rows[0];
  let actual=await totals();
  assert.deepEqual({bytesIn:Number(actual.incoming),bytesOut:Number(actual.outgoing),requests:actual.requests,failures:actual.failures,xhr:Number(actual.xhr)},expected);
  assert.equal(actual.buckets,actual.identities);
  assert.equal((await admin.query("SELECT sum(requests)::int n FROM bandwidth_log WHERE byte_source='mixed_overflow'")).rows[0].n,5050);
  metrics.recovery={...expected,persistedDeliveryIds:actual.identities,duplicateDeliveryIds:0,overflowRequests:5050,concurrentFlushes:100};

  // Preserve historical traffic after ONE synthetic customer's deletion.
  // Its missing owner is NOT system traffic; the UI must distinguish them.
  await admin.query("DELETE FROM users WHERE id=$1",[customers[49].userId]);
  const report=await meter.getBandwidthReport("1h");
  assert.equal(report.byUser.find(row=>row.userId===customers[49].userId)?.userEmail,null);
  assert(report.byUser.some(row=>row.userEmail?.endsWith("@example.invalid")));
  metrics.customerOwnership={actualCustomersCreated:450,trackingRowsCreated:450,fixtureCustomersDeleted:1,historicalTrafficRetained:true};
  if(process.env.STRESS_OUTPUT_DIR)await writeFile(join(process.env.STRESS_OUTPUT_DIR,"bandwidth-api.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});
  assert.equal(report.totals.totalBytes,expected.bytesIn+expected.bytesOut);
  assert.equal(report.totals.requests,expected.requests);
  assert.equal(report.counts.profilesWithTraffic,450);
  assert.equal(report.counts.customersWithTraffic,450);
  const profileSum=report.byProfile.reduce((n,row)=>n+row.totalBytes,0),userSum=report.byUser.reduce((n,row)=>n+row.totalBytes,0);
  metrics.largeAdminReport={profiles:450,customers:450,profileRowsReturned:report.byProfile.length,customerRowsReturned:report.byUser.length,totalBytes:report.totals.totalBytes,profileBytesOmitted:report.totals.totalBytes-profileSum,customerBytesOmitted:report.totals.totalBytes-userSum};
  // Top-N lists are fine, SILENT truncation is not. Independent arithmetic
  // requires the API to disclose omitted totals for the UI to explain them.
  const coverage=(report as any).breakdownCoverage;
  assert(coverage,"Admin bandwidth silently truncates 450 customers/profiles to 200 without reporting omitted totals");
  assert.equal(coverage.profiles.omittedBytes,report.totals.totalBytes-profileSum);
  assert.equal(coverage.customers.omittedBytes,report.totals.totalBytes-userSum);

  // No shared table reset: real writer and readers overlap. A single report
  // must reconcile its snapshot internally even while later commits happen.
  await Promise.all([
    (async()=>{for(let i=0;i<30;i++){await record(11_000+i);await meter.flushBandwidth();}})(),
    ...Array.from({length:4},async()=>{
      for(let i=0;i<10;i++){
        const r=await meter.getBandwidthReport("1h");
        assert.equal(r.byEndpoint.reduce((n,e)=>n+e.totalBytes,0),r.totals.totalBytes);
        assert.equal(r.byProfile.reduce((n,e)=>n+e.totalBytes,0)+(r as any).breakdownCoverage.profiles.omittedBytes,r.totals.totalBytes);
        assert.equal(r.byUser.reduce((n,e)=>n+e.totalBytes,0)+(r as any).breakdownCoverage.customers.omittedBytes,r.totals.totalBytes);
      }
    }),
  ]);
  actual=await totals();
  assert.equal(Number(actual.incoming),expected.bytesIn);assert.equal(Number(actual.outgoing),expected.bytesOut);assert.equal(actual.requests,expected.requests);
  metrics.concurrentReports={readers:4,snapshots:40,writerFlushes:30,snapshotMismatches:0};
  await meter.stopBandwidthMeter();
}
