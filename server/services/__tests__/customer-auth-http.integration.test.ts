import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const url=process.env.BACKEND_FIX_TEST_DATABASE_URL;
if(url){
  if(new URL(url).pathname!=="/cheaterfinder_backend_fix_test_20260907")throw new Error("Guarded scratch DB required");
  process.env.DATABASE_URL=url;process.env.WORKERS_DISABLED="1";
  process.env.SESSION_SECRET="isolated-customer-auth-fixture-only";
  process.env.HTTPS_ENABLED="false";
  delete process.env.ADMIN_EMAIL;delete process.env.RESEND_API_KEY;delete process.env.STRIPE_SECRET_KEY;
}
vi.mock("../public-read-client.js",()=>({maybeRevalidateTier1:vi.fn(),fetchPublicProfileTier1:vi.fn()}));
vi.mock("../../workers.js",()=>({
  collectionProfileQueue:{add:vi.fn()},reportGenerateQueue:{add:vi.fn()},botFollowRequestQueue:{add:vi.fn()},getQueues:()=>({}),
}));
vi.mock("../media-cache-jobs.js",()=>({enqueueMediaCacheUrls:vi.fn()}));
vi.mock("../../stripe.js",async original=>({...await original<typeof import("../../stripe.js")>(),stripe:null}));
const userId=randomUUID(),otherId=randomUUID(),email=userId+"@example.invalid";
const password="Fixture-password-old", nextPassword="Fixture-password-new";
(url?describe:describe.skip)("real customer HTTP auth and versioned sessions — scratch only",()=>{
  let pool:typeof import("../../db.js").pool,server:Server,origin:string,registeredId:string|undefined;
  let clientNumber=1;
  beforeEach(()=>{clientNumber++;});
  const request=async(path:string,method="GET",body?:unknown,cookie="",headers:Record<string,string>={})=>{
    const res=await fetch(origin+path,{method,headers:{"Content-Type":"application/json",cookie,"x-forwarded-for":"192.0.2."+clientNumber,...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return{status:res.status,body:await res.json(),cookies:res.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ")};
  };
  const csrf=(cookie:string)=>({"x-csrf-token":decodeURIComponent(cookie.match(/csrf_token=([^;]+)/)?.[1]??"")});
  beforeAll(async()=>{
    pool=(await import("../../db.js")).pool;
    const hash=await bcrypt.hash(password,4);
    await pool.query("INSERT INTO users(id,email,name,hashed_password) VALUES($1,$2,'HTTP fixture',$3),($4,$5,'Other HTTP fixture',$3)",[userId,email,hash,otherId,otherId+"@example.invalid"]);
    await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end) VALUES($1,$2,$3,'active','standard',now()+interval '30 days')",[otherId,"cus_http_fixture_"+otherId,"sub_http_fixture_"+otherId]);
    const app=express();app.set("trust proxy","loopback");app.use(express.json());
    const {setupAuth,requireCsrfToken}=await import("../../auth.js");setupAuth(app);
    app.use((req,res,next)=>req.isAuthenticated()&&!['GET','HEAD','OPTIONS'].includes(req.method)?requireCsrfToken(req,res,next):next());
    server=createServer(app);await (await import("../../routes.js")).registerRoutes(server,app);
    app.use((_err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(500).json({message:"Fixture internal error"}));
    await new Promise<void>(resolve=>server.listen(Number(process.env.STRESS_FAULT_PORT ?? 0),"127.0.0.1",resolve));origin="http://127.0.0.1:"+(server.address() as {port:number}).port;
  },60_000);
  afterAll(async()=>{
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(pool){const ids=[userId,otherId,...(registeredId?[registeredId]:[])];
      await pool.query("DELETE FROM session WHERE sess::jsonb #>> '{passport,user}'=ANY($1::text[]) OR sess::jsonb #>> '{passport,user,id}'=ANY($1::text[])",[ids]);
      await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])",[ids]);await pool.end();}
  });
  it("registers, normalizes email, starts a session, and never exposes a password hash",async()=>{
    const registered=await request("/api/auth/register","POST",{name:"Customer Fixture",email:"  "+randomUUID().toUpperCase()+"@EXAMPLE.INVALID  ",password});
    expect(registered.status).toBe(201);registeredId=registered.body.id;
    expect(registered.body.email).toBe(registered.body.email.trim().toLowerCase());
    expect(registered.body).not.toHaveProperty("hashedPassword");
    expect((await request("/api/auth/me","GET",undefined,registered.cookies)).body.id).toBe(registeredId);
    expect((await request("/api/admin/health","GET",undefined,registered.cookies)).status).toBe(403);
  });
  it("mobile registration atomically records the welcome email and returns usable tokens",async()=>{
    const result=await request("/api/auth/mobile/register","POST",{name:"Mobile Fixture",email:randomUUID()+"@example.invalid",password});
    expect(result.status).toBe(201);
    const id=result.body.user.id;
    try {
      expect(result.body.user).not.toHaveProperty("hashedPassword");
      expect((await pool.query("SELECT count(*)::int n FROM transactional_emails WHERE user_id=$1 AND kind='welcome'",[id])).rows[0].n).toBe(1);
      expect((await request("/api/auth/me","GET",undefined,"",{authorization:"Bearer "+result.body.accessToken})).body.id).toBe(id);
    } finally { await pool.query("DELETE FROM users WHERE id=$1",[id]); }
  });
  it("rejects browser cross-site login/logout before authentication",async()=>{
    expect((await request("/api/auth/login","POST",{email,password},"",{origin:"https://unrelated.example","sec-fetch-site":"cross-site"})).status).toBe(403);
    expect((await request("/api/auth/logout","POST",undefined,"",{origin:"null"})).status).toBe(403);
  });
  it("persists first-access acknowledgement per account and requires browser CSRF",async()=>{
    const login=await request("/api/auth/login","POST",{email:otherId+"@example.invalid",password});
    expect((await request("/api/auth/onboarding-ack","POST")).status).toBe(401);
    expect((await request("/api/auth/onboarding-ack","POST",undefined,login.cookies)).status).toBe(403);
    const acknowledged=await request("/api/auth/onboarding-ack","POST",undefined,login.cookies,csrf(login.cookies));
    expect(acknowledged.status).toBe(200);expect(acknowledged.body.acknowledgedAt).toBeTruthy();
    expect((await request("/api/auth/onboarding-ack","POST",undefined,login.cookies,csrf(login.cookies))).body).toEqual(acknowledged.body);
    expect((await request("/api/auth/me","GET",undefined,login.cookies)).body.onboardingAcknowledgedAt).toBe(acknowledged.body.acknowledgedAt);
    expect((await pool.query("SELECT onboarding_acknowledged_at FROM users WHERE id=$1",[userId])).rows[0].onboarding_acknowledged_at).toBeNull();
  });
  it("restores a missing CSRF cookie only for an authenticated browser and preserves valid tokens",async()=>{
    const login=await request("/api/auth/login","POST",{email:otherId+"@example.invalid",password});
    expect(login.status).toBe(200);
    const sessionOnly=login.cookies.split("; ").filter(value=>!value.startsWith("csrf_token=")).join("; ");
    const denied=await request("/api/account/profile","PUT",{name:"CSRF restored fixture"},sessionOnly);
    expect(denied.status).toBe(403);expect(denied.body.message).toMatch(/csrf/i);
    const recovered=await request("/api/auth/me","GET",undefined,sessionOnly);
    expect(recovered.status).toBe(200);expect(recovered.cookies).toMatch(/csrf_token=[a-f0-9]{64}/);
    const cookies=sessionOnly+"; "+recovered.cookies;
    expect((await request("/api/account/profile","PUT",{name:"CSRF restored fixture"},cookies,csrf(cookies))).status).toBe(200);
    expect((await request("/api/auth/me","GET",undefined,cookies)).cookies).not.toContain("csrf_token=");
    const malformed=await request("/api/auth/me","GET",undefined,sessionOnly+"; csrf_token=%ZZ");
    expect(malformed.cookies).toMatch(/csrf_token=[a-f0-9]{64}/);
    const anonymous=await request("/api/auth/me");
    expect(anonymous.status).toBe(401);expect(anonymous.cookies).not.toContain("csrf_token=");
  });
  it("password change rotates this browser, revokes another browser + mobile tokens, and enforces CSRF",async()=>{
    const a=await request("/api/auth/login","POST",{email,password});
    const b=await request("/api/auth/login","POST",{email,password});
    const mobile=await request("/api/auth/mobile/login","POST",{email,password});
    expect(a.status).toBe(200);expect(b.status).toBe(200);expect(mobile.status).toBe(200);
    expect((await request("/api/account/password","PUT",{currentPassword:password,newPassword:nextPassword},a.cookies)).status).toBe(403);
    expect((await request("/api/account/password","PUT",{currentPassword:password,newPassword:nextPassword},"csrf_token=%ZZ; "+a.cookies,{"x-csrf-token":"x"})).status).toBe(403);
    const changed=await request("/api/account/password","PUT",{currentPassword:password,newPassword:nextPassword},a.cookies,csrf(a.cookies));
    expect(changed.status).toBe(200);expect(changed.cookies).not.toBe(a.cookies);
    expect((await request("/api/auth/me","GET",undefined,changed.cookies)).status).toBe(200);
    expect((await request("/api/auth/me","GET",undefined,a.cookies)).status).toBe(401);
    expect((await request("/api/auth/me","GET",undefined,b.cookies)).status).toBe(401);
    expect((await request("/api/auth/me","GET",undefined,"",{authorization:"Bearer "+mobile.body.accessToken})).status).toBe(401);
    expect((await request("/api/auth/mobile/refresh","POST",{refreshToken:mobile.body.refreshToken})).status).toBe(401);
    expect((await request("/api/auth/login","POST",{email,password})).status).toBe(401);
    expect((await request("/api/auth/login","POST",{email,password:nextPassword})).status).toBe(200);
  });
  it("reset consumes the link once and rejects a resurrected pre-reset session",async()=>{
    const login=await request("/api/auth/login","POST",{email,password:nextPassword});
    expect(login.status).toBe(200);
    const oldSessions=(await pool.query("SELECT sid,sess,expire FROM session WHERE sess::jsonb #>> '{passport,user,id}'=$1",[userId])).rows;
    const token=randomBytes(32).toString("hex"),digest=createHash("sha256").update(token).digest("hex");
    await pool.query("INSERT INTO password_reset_tokens(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[randomUUID(),userId,digest]);
    const reset=await request("/api/auth/reset-password","POST",{token,password:"Fixture-password-reset"},login.cookies);
    expect(reset.status).toBe(200);
    // Simulates an old in-flight HTTP response re-saving its already-loaded session.
    for(const row of oldSessions){
      const serialized=typeof row.sess==="string"?row.sess:JSON.stringify(row.sess);
      expect(JSON.parse(serialized).passport.user.id).toBe(userId);
      await pool.query("INSERT INTO session(sid,sess,expire) VALUES($1,$2,$3) ON CONFLICT(sid) DO NOTHING",[row.sid,serialized,row.expire]);
    }
    expect((await request("/api/auth/me","GET",undefined,login.cookies)).status).toBe(401);
    expect((await request("/api/auth/reset-password","POST",{token,password:"replay-password"})).status).toBe(400);
    expect((await request("/api/auth/login","POST",{email,password:"Fixture-password-reset"})).status).toBe(200);
  });
  it("a billing failure preserves the authenticated customer's session and account",async()=>{
    const login=await request("/api/auth/login","POST",{email:otherId+"@example.invalid",password});
    await pool.query("INSERT INTO customer_billing_links(user_id,stripe_customer_id) VALUES($1,$2)",[otherId,"cus_http_fixture_"+otherId]);
    const deleted=await request("/api/account","DELETE",undefined,login.cookies,csrf(login.cookies));
    expect(deleted.status).toBe(503);expect(deleted.body.message).toContain("has not been deleted");
    expect((await request("/api/auth/me","GET",undefined,login.cookies)).status).toBe(200);
  });
  it("blocks admin self-deletion through customer settings without closing billing or the session",async()=>{
    await pool.query("UPDATE users SET role='admin' WHERE id=$1",[otherId]);
    try {
      const login=await request("/api/auth/login","POST",{email:otherId+"@example.invalid",password});
      expect(login.status).toBe(200);expect(login.body.role).toBe("admin");
      const deleted=await request("/api/account","DELETE",undefined,login.cookies,csrf(login.cookies));
      expect(deleted.status).toBe(403);expect(deleted.body.message).toMatch(/admin role/i);
      expect((await request("/api/auth/me","GET",undefined,login.cookies)).body.role).toBe("admin");
      expect((await pool.query("SELECT status FROM subscriptions WHERE user_id=$1",[otherId])).rows[0].status).toBe("active");
    } finally { await pool.query("UPDATE users SET role='user' WHERE id=$1",[otherId]); }
  });
  it("closes an active customer event stream and refuses late streams during shutdown",async()=>{
    const login=await request("/api/auth/login","POST",{email:otherId+"@example.invalid",password});
    const {markShuttingDown,resetShutdownStateForTests}=await import("../shutdown-state.js");
    const stream=await fetch(origin+"/api/realtime/events",{headers:{cookie:login.cookies}});
    expect(stream.status).toBe(200);const reader=stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: hello");
    try {
      markShuttingDown();expect((await reader.read()).done).toBe(true);
      expect((await request("/api/realtime/events","GET",undefined,login.cookies)).status).toBe(503);
    } finally { await reader.cancel();resetShutdownStateForTests(); }
  });
});
