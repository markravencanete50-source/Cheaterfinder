import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f=vi.hoisted(()=>({rows:[] as any[],updates:[] as any[],mode:"ok",calls:0,lookup:vi.fn(),requestOptions:null as any,destroyed:0}));
vi.mock("../../observability/logger.js",()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock("../../db.js",()=>({db:{
  select:()=>({from:()=>({where:()=>{const p=Promise.resolve(f.rows);return Object.assign(p,{limit:async()=>f.rows});}})}),
  insert:()=>({values:()=>({onConflictDoUpdate:async()=>{}})}),
  update:()=>({set:(value:any)=>({where:async()=>{f.updates.push(value);}})}),
}}));
vi.mock("node:dns",()=>({default:{promises:{lookup:f.lookup}}}));
vi.mock("node:https",()=>({default:{get:(_url:any,opts:any,callback:any)=>{
  f.calls++;f.requestOptions=opts;const req=new EventEmitter() as any;req.setTimeout=()=>{};req.destroy=(err:any)=>{f.destroyed++;req.emit("error",err);};
  opts.signal?.addEventListener("abort",()=>req.destroy(opts.signal.reason),{once:true});
  if(f.mode==="no-connect")return req;
  queueMicrotask(()=>{
    const res=new EventEmitter() as any;res.statusCode=200;res.headers={"content-type":f.mode==="rejected-open-body"?"text/html":"image/png","content-length":"4"};res.resume=()=>{};callback(res);
    if(f.mode==="rejected-open-body")return;
    if(f.mode==="aborted"){res.emit("aborted");res.emit("error",new Error("connection reset"));return;}
    if(f.mode!=="empty")res.emit("data",Buffer.from(f.mode==="truncated"?"PN":"PNGF"));
    res.emit("end");
  });return req;
}}}));
const dir=await mkdtemp("/tmp/media-integrity-");vi.stubEnv("MEDIA_CACHE_DIR",dir);
const {cacheMediaUrl,resolveCachedMediaUrls,mediaCacheKey,readCachedMediaAsset}=await import("../media-cache.js");
const url="https://scontent.cdninstagram.com/test.png",key=mediaCacheKey(url),file=path.join(dir,key+".png");
beforeEach(async()=>{f.rows=[];f.updates=[];f.mode="ok";f.calls=0;f.requestOptions=null;f.destroyed=0;f.lookup.mockReset().mockResolvedValue([{address:"8.8.8.8",family:4}]);await rm(file,{force:true});});
afterEach(()=>vi.useRealTimers());
afterAll(async()=>{await rm(dir,{recursive:true,force:true});vi.unstubAllEnvs();});
describe("media download integrity",()=>{
  it("closes a rejected response even when its upstream body never ends",async()=>{
    f.mode="rejected-open-body";
    expect((await cacheMediaUrl(url)).status).toBe("failed");
    expect(f.updates.at(-1).errorMessage).toBe("unsupported media content-type text/html");
    expect(f.destroyed).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });
  it("pins every validated address so Node can fall back from unreachable IPv6 to IPv4",async()=>{
    const addresses=[{address:"2606:4700:4700::1111",family:6},{address:"1.1.1.1",family:4}];
    f.lookup.mockResolvedValue(addresses);
    expect((await cacheMediaUrl(url)).status).toBe("cached");
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith("scontent.cdninstagram.com",{all:true,verbatim:true});
    expect(f.requestOptions).toMatchObject({autoSelectFamily:true,autoSelectFamilyAttemptTimeout:250});
    const all=vi.fn();f.requestOptions.lookup("scontent.cdninstagram.com",{all:true},all);
    expect(all).toHaveBeenCalledWith(null,addresses);
    const single=vi.fn();f.requestOptions.lookup("scontent.cdninstagram.com",{},single);
    expect(single).toHaveBeenCalledWith(null,"1.1.1.1",4);
    expect(f.lookup).toHaveBeenCalledTimes(1); // No unvalidated second DNS lookup.
  });
  it.each(["127.0.0.1","10.0.0.1","169.254.169.254","::1","fd00::1","fe90::1","ff02::1","::ffff:127.0.0.1","::ffff:7f00:1"])("rejects the entire DNS answer when any candidate is non-public (%s)",async address=>{
    f.lookup.mockResolvedValue([{address:"8.8.8.8",family:4},{address,family:address.includes(":")?6:4}]);
    expect((await cacheMediaUrl(url)).status).toBe("failed");expect(f.calls).toBe(0);
    expect(f.updates.at(-1).errorMessage).toBe("media host resolved to private network");
    expect(await readdir(dir)).toEqual([]);
  });
  it("rejects an empty DNS answer without connecting",async()=>{
    f.lookup.mockResolvedValue([]);
    expect((await cacheMediaUrl(url)).status).toBe("failed");expect(f.calls).toBe(0);
  });
  it.each(["dns","no-connect"])("enforces the total deadline while %s never completes",async phase=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
    if(phase==="dns")f.lookup.mockImplementation(()=>new Promise(()=>{}));else f.mode="no-connect";
    const pending=cacheMediaUrl(url);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(f.updates).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe("failed");
    expect(f.updates.at(-1).errorMessage).toBe("media fetch timeout");
    expect(f.calls).toBe(phase==="dns"?0:1);
    if(phase!=="dns")expect(f.destroyed).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });
  it.each(["empty","truncated","aborted"])("does not publish %s responses as cached",async(mode)=>{
    f.mode=mode;expect((await cacheMediaUrl(url)).status).toBe("failed");
    expect(f.updates.at(-1).status).toBe("failed");expect(await readdir(dir)).toEqual([]);
  });
  it("publishes a complete file and leaves no temporary partial file",async()=>{
    expect((await cacheMediaUrl(url)).status).toBe("cached");expect(await readFile(file,"utf8")).toBe("PNGF");
    expect(await readdir(dir)).toEqual([key+".png"]);expect(f.updates.at(-1).byteSize).toBe(4);
  });
  it.each(["", "PN"])("rejects a truncated disk cache and repairs it",async(body)=>{
    await writeFile(file,body);f.rows=[{cacheKey:key,status:"cached",localPath:file,byteSize:4}];
    expect((await resolveCachedMediaUrls([url])).size).toBe(0);
    expect((await cacheMediaUrl(url)).status).toBe("cached");expect(f.calls).toBe(1);expect(await readFile(file,"utf8")).toBe("PNGF");
  });
  it("serves an intact cached asset without fetching it again",async()=>{
    await writeFile(file,"PNGF");f.rows=[{cacheKey:key,status:"cached",localPath:file,byteSize:4}];
    expect((await resolveCachedMediaUrls([url])).get(url)).toBe("/api/media/"+key);
    expect((await cacheMediaUrl(url)).status).toBe("cached");expect(f.calls).toBe(0);
  });
  it("lets cache-only admin display read intact bytes without any upstream work",async()=>{
    await writeFile(file,"PNGF");f.rows=[{cacheKey:key,status:"cached",localPath:file,byteSize:4,contentType:"image/png",originalUrl:url}];
    expect(await readCachedMediaAsset(key,{repairMissing:false})).toMatchObject({body:Buffer.from("PNGF"),byteSize:4});
    expect(f.calls).toBe(0);expect(f.updates).toEqual([]);
  });
  it.each(["missing","truncated"])("does not self-heal a %s file during cache-only display",async kind=>{
    if(kind==="truncated")await writeFile(file,"PN");
    f.rows=[{cacheKey:key,status:"cached",localPath:file,byteSize:4,contentType:"image/png",originalUrl:url}];
    expect(await readCachedMediaAsset(key,{repairMissing:false})).toBeNull();
    expect(f.calls).toBe(0);expect(f.updates).toEqual([]);
  });
});
