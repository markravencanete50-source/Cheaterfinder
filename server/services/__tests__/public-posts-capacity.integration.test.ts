import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url=process.env.BACKEND_FIX_TEST_DATABASE_URL;
if(url){
  const parsed=new URL(url);
  if(parsed.pathname!=="/cheaterfinder_backend_fix_test_20260907" || !["127.0.0.1","localhost"].includes(parsed.hostname)
    || !parsed.port || ["5432","6379"].includes(parsed.port) || !process.env.STRESS_NONCE
    || !(process.env.STRESS_ALLOWED_PORTS??"").split(",").includes(parsed.port)) throw Error("Isolated scratch database required");
  process.env.DATABASE_URL=url;
}
const ids=[randomUUID(),randomUUID(),randomUUID()];
const identity=(id:string)=>({identity_version:1,client:"instagram-firefox-web",browser_family:"firefox",platform:"Windows",
  browser_seed:123,bot_id:id,browser_version:"140",user_agent:"fixture",http_impersonate:"firefox",
  ja3:"fixture",h2_fingerprint:"fixture",locale:"en-US",timezone:"UTC"});
const mobile=()=>{
  const sessionid="1234%3Afixture",dsUserId="1234";
  return JSON.stringify({__marker:"instagram-mobile-bearer",version:1,sessionid,dsUserId,
    bearer:"Bearer IGT:2:"+Buffer.from(JSON.stringify({ds_user_id:dsUserId,sessionid})).toString("base64"),
    androidId:"android-123456789abcdef0",deviceUuid:"11111111-1111-4111-8111-111111111111"});
};
const web=(expires=-1)=>JSON.stringify({cookies:["sessionid","csrftoken"].map(name=>({name,value:"fixture",
  domain:".instagram.com",path:"/",expires,httpOnly:true,secure:true,sameSite:"Lax"})),origins:[]});

(url?describe:describe.skip)("public posts capacity forecast — isolated database",()=>{
  let pool:typeof import("../../db.js").pool;
  let forecast:typeof import("../../ig-public-scraper.js").getPublicPostsRetryAt;
  let encrypt:typeof import("../../crypto/session-envelope.js").encryptSessionData;
  let breaker:typeof import("../../domain/ig-circuit-breaker.js");
  let breakerKey:typeof import("../../ig-public-scraper.js").breakerKeyForLease;
  let now:Date,midnight:Date;
  beforeAll(async()=>{
    vi.stubEnv("SESSION_DATA_KEY",Buffer.alloc(32,23).toString("base64"));
    pool=(await import("../../db.js")).pool;
    forecast=(await import("../../ig-public-scraper.js")).getPublicPostsRetryAt;
    breakerKey=(await import("../../ig-public-scraper.js")).breakerKeyForLease;
    breaker=await import("../../domain/ig-circuit-breaker.js");
    encrypt=(await import("../../crypto/session-envelope.js")).encryptSessionData;
  });
  beforeEach(async()=>{
    vi.stubEnv("MOBILE_DAILY_CAP","60");vi.stubEnv("DAILY_CAP_MULTIPLIER","1");
    vi.stubEnv("BOT_READ_WARMUP_ENABLED","true");vi.stubEnv("IG_NATIVE_PUBLIC_READS_ENABLED","false");
    vi.stubEnv("IG_NATIVE_PUBLIC_TARGETS","");
    await pool.query("DELETE FROM bot_accounts WHERE id=ANY($1::varchar[])",[ids]);
    await pool.query("DELETE FROM backend_operation_leases WHERE key=ANY($1::text[])",[ids.map(id=>`bot:${id}`)]);
    breaker.resetBreaker();
    now=new Date();midnight=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1));
  });
  afterAll(async()=>{
    if(pool){await pool.query("DELETE FROM bot_accounts WHERE id=ANY($1::varchar[])",[ids]);await pool.query("DELETE FROM backend_operation_leases WHERE key=ANY($1::text[])",[ids.map(id=>`bot:${id}`)]);await pool.end();}
    vi.unstubAllEnvs();
  });
  const add=async(index=0,transport="mobile",session=transport==="mobile"?mobile():web())=>{
    await pool.query("INSERT INTO bot_accounts(id,ig_username,status,tier,role,transport,session_data,automation_identity,proxy_url,created_at) VALUES($1,$2,'available','worker','scraper',$3,$4,$5,'http://fixture.invalid:10000',$6)",
      [ids[index],"capacity_"+ids[index],transport,encrypt(session),transport==="web"?JSON.stringify(identity(ids[index])):null,now]);
  };
  const cap=async(index=0,count=60,day=now.toISOString().slice(0,10))=>pool.query("INSERT INTO bot_daily_calls(bot_id,day,endpoint,count) VALUES($1,$2::date,'posts',$3)",[ids[index],day,count]);
  const cool=async(index:number,until:Date)=>pool.query("UPDATE bot_accounts SET cooldown_until=$2,last_login_error='cooldown: checkpoint required' WHERE id=$1",[ids[index],until]);

  it("returns the next UTC reset when every otherwise usable mobile reader is at its posts cap",async()=>{
    await add();await cap();expect(await forecast(now)).toEqual(midnight);
  });
  it("uses the later of a reader's cooldown and quota reset",async()=>{
    await add();await cap();const until=new Date(midnight.getTime()+2*3600_000);await cool(0,until);
    expect(await forecast(now)).toEqual(until);
  });
  it("selects the earliest usable reader cooldown rather than the whole pool's latest",async()=>{
    await add();await add(1);const soon=new Date(now.getTime()+15*60_000),later=new Date(now.getTime()+60*60_000);
    await cool(0,later);await cool(1,soon);expect(await forecast(now)).toEqual(soon);
  });
  it("does not queue a future retry when a valid reader already has capacity",async()=>{
    await add();await cap();await add(1);expect(await forecast(now)).toBeNull();
  });
  it("an active operation lease cannot mask another reader's known cooldown recovery",async()=>{
    await add();await add(1);const soon=new Date(now.getTime()+30_000);await cool(1,soon);
    await pool.query("INSERT INTO backend_operation_leases(key,token,expires_at) VALUES($1,'fixture',$2)",[`bot:${ids[0]}`,new Date(now.getTime()+120_000)]);
    expect(await forecast(now)).toEqual(soon);
  });
  it("an open posts breaker cannot mask another reader's known cooldown recovery",async()=>{
    await add();await add(1);const soon=new Date(now.getTime()+30_000);await cool(1,soon);
    const key=breakerKey(ids[0],"posts","mobile","http");for(let i=0;i<10;i++)breaker.recordFailure(key);
    expect(await forecast(now)).toEqual(soon);
    expect(breaker.getBreakerSnapshot(key).state).toBe("OPEN");
  });
  it("native posts forecast uses the browser breaker without consuming a probe",async()=>{
    vi.stubEnv("IG_NATIVE_PUBLIC_READS_ENABLED","true");await add(0,"web");
    const http=breakerKey(ids[0],"posts","web","http"),browser=breakerKey(ids[0],"posts","web","browser");
    for(let i=0;i<10;i++)breaker.recordFailure(http);
    expect(await forecast(now)).toBeNull();
    for(let i=0;i<10;i++)breaker.recordFailure(browser);
    const until=breaker.getBreakerSnapshot(browser).openUntil!;
    expect(await forecast(now)).toEqual(new Date(until));
    expect(breaker.getBreakerSnapshot(browser).state).toBe("OPEN");
  });
  it("honors the exact configured mobile cap and multiplier",async()=>{
    vi.stubEnv("MOBILE_DAILY_CAP","20");vi.stubEnv("DAILY_CAP_MULTIPLIER","2");
    await add();await cap(0,39);expect(await forecast(now)).toBeNull();
    await pool.query("UPDATE bot_daily_calls SET count=40 WHERE bot_id=$1",[ids[0]]);
    expect(await forecast(now)).toEqual(midnight);
  });
  it("old UTC-day counters do not defer today's valid reader",async()=>{
    await add();await cap(0,60,new Date(now.getTime()-86400_000).toISOString().slice(0,10));
    expect(await forecast(now)).toBeNull();
  });
  it.each(["status='session_expired'","status='banned'","status='disabled'","status='in_use'",
    "tier='reserve'","role='feed_watcher'","session_data=NULL","session_data='broken'",
    "session_data='v1:bad:bad:bad'","last_login_error='auth rejected'","proxy_url=NULL",
    "proxy_url='not/a/proxy'","proxy_url='http://gateway.dataimpulse.com:823'"])("does not invent recovery for invalid candidate %s",async change=>{
    await add();await cap();await pool.query(`UPDATE bot_accounts SET ${change} WHERE id=$1`,[ids[0]]);
    expect(await forecast(now)).toBeNull();
  });
  it.each(["session_data='broken'","proxy_url='not/a/proxy'","last_login_error='checkpoint required'"])("invalid uncapped reader cannot suppress the valid reader's reset: %s",async change=>{
    await add();await cap();await add(1);await pool.query(`UPDATE bot_accounts SET ${change} WHERE id=$1`,[ids[1]]);
    expect(await forecast(now)).toEqual(midnight);
  });
  it("rejects a mobile bearer naming a different account",async()=>{
    const state=JSON.parse(mobile());state.dsUserId="9999";await add(0,"mobile",JSON.stringify(state));await cap();
    expect(await forecast(now)).toBeNull();
  });
  it("requires a provider proxy lease to survive past the predicted read",async()=>{
    await add();await cap();
    await pool.query("UPDATE bot_accounts SET proxy_url=NULL,proxy_endpoint='fixture.invalid:10000:user:pass',proxy_expires_at=$2 WHERE id=$1",[ids[0],new Date(midnight.getTime()+60_000)]);
    expect(await forecast(now)).toBeNull();
    await pool.query("UPDATE bot_accounts SET proxy_expires_at=$2 WHERE id=$1",[ids[0],new Date(midnight.getTime()+5*60_000)]);
    expect(await forecast(now)).toEqual(midnight);
  });
  it("ordinary mobile-only posts cannot borrow an uncapped web reader",async()=>{
    await add();await cap();await add(1,"web");expect(await forecast(now,"ordinary_target")).toEqual(midnight);
  });
  it("explicit native target policy uses its web pool and age-aware posts cap",async()=>{
    vi.stubEnv("IG_NATIVE_PUBLIC_TARGETS","native_target");await add();await add(1,"web");await cap(1,3);
    expect(await forecast(now,"native_target")).toEqual(midnight);
    expect(await forecast(now,"ordinary_target")).toBeNull();
  });
  it("native global policy does not invent a web retry from mobile capacity",async()=>{
    vi.stubEnv("IG_NATIVE_PUBLIC_READS_ENABLED","true");await add();await cap();expect(await forecast(now)).toBeNull();
  });
  it.each(["automation_identity='{}'::jsonb","automation_identity=jsonb_set(automation_identity,'{bot_id}','\"other\"')"])("native web retry rejects invalid identity %s",async change=>{
    vi.stubEnv("IG_NATIVE_PUBLIC_READS_ENABLED","true");await add(0,"web");await cap(0,3);
    await pool.query(`UPDATE bot_accounts SET ${change} WHERE id=$1`,[ids[0]]);expect(await forecast(now)).toBeNull();
  });
  it("does not forecast a web session whose auth cookies expire before the reset",async()=>{
    vi.stubEnv("IG_NATIVE_PUBLIC_READS_ENABLED","true");await add(0,"web",web(Math.floor(midnight.getTime()/1000)-1));await cap(0,3);
    expect(await forecast(now)).toBeNull();
  });
  it("performs no lease, quota, session or status mutation",async()=>{
    await add();await cap();const before=(await pool.query("SELECT to_jsonb(b) bot,d.count FROM bot_accounts b JOIN bot_daily_calls d ON d.bot_id=b.id WHERE b.id=$1",[ids[0]])).rows;
    expect(await forecast(now)).toEqual(midnight);expect(await forecast(now)).toEqual(midnight);
    expect((await pool.query("SELECT to_jsonb(b) bot,d.count FROM bot_accounts b JOIN bot_daily_calls d ON d.bot_id=b.id WHERE b.id=$1",[ids[0]])).rows).toEqual(before);
    expect((await pool.query("SELECT count(*)::int n FROM backend_operation_leases WHERE key=$1",[`bot:${ids[0]}`])).rows[0].n).toBe(0);
  });
});
