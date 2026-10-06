import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const state=vi.hoisted(()=>({in:1500,out:700,fail:"none" as "none"|"before"|"after",inserts:new Map<string,unknown[]>(),reads:0}));
vi.mock("node:child_process",async()=>{
  const {promisify}=await import("node:util");
  const execFile=vi.fn();Object.assign(execFile,{[promisify.custom]:async(_command:string,args:string[])=>{
    state.reads+=1;const bytes=args.includes("INPUT")?state.in:state.out;
    return{stdout:`1 ${bytes} tcp -- * * 127.0.0.1 0.0.0.0/0 /* cheaterfinder-proxy-wire */`,stderr:""};
  }});return{execFile};
});
vi.mock("../../db.js",()=>({db:{execute:vi.fn(async(query:unknown)=>{
  const compiled=new PgDialect().sqlToQuery(query as import("drizzle-orm").SQL);
  if(compiled.sql.includes("INSERT INTO proxy_wire_samples")){
    const failure=state.fail;state.fail="none";
    if(failure==="before")throw new Error("DB unavailable");
    state.inserts.set(String(compiled.params.at(-1)),compiled.params);
    if(failure==="after")throw new Error("DB commit response lost");
  }return{rows:[]};
})}}));
vi.mock("../../observability/logger.js",()=>({logger:{child:()=>({info:vi.fn(),warn:vi.fn(),error:vi.fn()})}}));
import {__testing,__resetForTests} from "../proxy-wire-sampler.js";
describe("wire sample delivery",()=>{
  beforeEach(()=>{__resetForTests();state.in=1500;state.out=700;state.fail="none";state.inserts.clear();state.reads=0;__testing.seedCounters({in:1000,out:500},Date.now()-60_000);});
  it("keeps failed deltas until commit and then captures traffic accrued during the outage",async()=>{
    state.fail="before";await expect(__testing.sampleOnce()).rejects.toThrow();expect(__testing.getPending()).not.toBeNull();
    state.in=1800;state.out=900;await __testing.sampleOnce();expect(__testing.getPending()).toBeNull();
    const records=[...state.inserts.values()];expect(records).toHaveLength(2);
    expect(records.reduce((n,r)=>n+Number(r[1]),0)).toBe(800);expect(records.reduce((n,r)=>n+Number(r[2]),0)).toBe(400);
  });
  it("reuses the sample identity if the first commit succeeded but its response was lost",async()=>{
    state.fail="after";await expect(__testing.sampleOnce()).rejects.toThrow();const key=__testing.getPending()!.key;
    await __testing.sampleOnce();expect(state.inserts.has(key)).toBe(true);
    expect([...state.inserts.values()].reduce((n,r)=>n+Number(r[1]),0)).toBe(500);
  });
  it("coalesces overlapping timer and final-drain sampling",async()=>{
    const a=__testing.sampleOnce(),b=__testing.sampleOnce();expect(a).toBe(b);await Promise.all([a,b]);
    expect(state.reads).toBe(2);expect(state.inserts.size).toBe(1);
  });
});
