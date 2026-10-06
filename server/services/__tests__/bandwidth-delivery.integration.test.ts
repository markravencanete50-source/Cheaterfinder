import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const url=process.env.BACKEND_FIX_TEST_DATABASE_URL;
if(url){if(new URL(url).pathname!=="/cheaterfinder_backend_fix_test_20260907")throw new Error("Guarded scratch DB required");process.env.DATABASE_URL=url;}
const username="meter_fixture_"+randomUUID().slice(0,8);
(url?describe:describe.skip)("idempotent bandwidth delivery — real scratch PG",()=>{
  let pool:typeof import("../../db.js").pool,db:typeof import("../../db.js").db,meter:typeof import("../bandwidth-meter.js");
  beforeAll(async()=>{({pool,db}=await import("../../db.js"));meter=await import("../bandwidth-meter.js");});
  beforeEach(async()=>{vi.restoreAllMocks();meter.__resetForTests();await pool.query("DELETE FROM bandwidth_log WHERE ig_username=$1",[username]);});
  afterAll(async()=>{vi.restoreAllMocks();if(pool){await pool.query("DELETE FROM bandwidth_log WHERE ig_username=$1",[username]);await pool.end();}});
  const record=()=>meter.withScrapeContext({userId:null,trackedAccountId:null,username},async()=>meter.recordBytes({endpoint:"followers",bytesIn:123,bytesOut:45,byteSource:"browser_wire",failed:true,resourceBytes:{xhr:123}}));
  const rows=async()=>(await pool.query("SELECT bytes_in,bytes_out,requests,failures,resource_bytes,delivery_id FROM bandwidth_log WHERE ig_username=$1",[username])).rows;
  const intercept=(ambiguous:boolean)=>{
    const execute=db.execute.bind(db);let failed=false;
    vi.spyOn(db,"execute").mockImplementation((async(query:Parameters<typeof db.execute>[0])=>{
      if(!failed&&JSON.stringify(query).includes("INSERT INTO bandwidth_log")){
        failed=true;if(ambiguous)await execute(query);throw new Error("simulated DB response loss");
      }return execute(query);
    }) as typeof db.execute);
  };
  it("retains a rejected write and delivers it on the next flush",async()=>{
    await record();intercept(false);expect(await meter.flushBandwidth()).toBe(0);expect(await rows()).toHaveLength(0);
    await meter.flushBandwidth();expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({bytes_in:"123",bytes_out:"45",requests:1,failures:1,resource_bytes:{xhr:123}});
  });
  it("does not double count a committed INSERT whose response was lost",async()=>{
    await record();intercept(true);await meter.flushBandwidth();expect(await rows()).toHaveLength(1);
    const originalId=(await rows())[0].delivery_id;await meter.flushBandwidth();
    expect(await rows()).toHaveLength(1);expect((await rows())[0].delivery_id).toBe(originalId);
  });
  it("coalesces simultaneous report/timer flushes into one delivery",async()=>{
    await record();const a=meter.flushBandwidth(),b=meter.flushBandwidth();expect(a).toBe(b);await Promise.all([a,b]);
    expect(await rows()).toHaveLength(1);
  });
  it("keeps new traffic separate while an older retry is unresolved",async()=>{
    await record();intercept(false);await meter.flushBandwidth();await record();await meter.flushBandwidth();
    expect(await rows()).toHaveLength(2);
    expect((await rows()).reduce((total,row)=>total+Number(row.bytes_in),0)).toBe(246);
  });
  it("counts one profile across two customer tracking records and excludes system traffic",async()=>{
    const before=await meter.getBandwidthReport("1h");
    for(const user of [randomUUID(),randomUUID()])await pool.query("INSERT INTO bandwidth_log(user_id,tracked_account_id,ig_username,endpoint,bytes_in,bytes_out,requests) VALUES($1,$2,$3,'followers',100,0,1)",[user,randomUUID(),username]);
    await pool.query("INSERT INTO bandwidth_log(ig_username,endpoint,bytes_in,bytes_out,requests) VALUES($1,'followers',500,0,1)",[username]);
    const report=await meter.getBandwidthReport("1h");
    expect(report.counts.profilesWithTraffic-before.counts.profilesWithTraffic).toBe(1);
    expect(report.counts.customersWithTraffic-before.counts.customersWithTraffic).toBe(2);
    expect(report.byProfile.reduce((n,r)=>n+r.totalBytes,0)).toBe(report.totals.totalBytes);
    expect(report.byUser.reduce((n,r)=>n+r.totalBytes,0)).toBe(report.totals.totalBytes);
  });
});
