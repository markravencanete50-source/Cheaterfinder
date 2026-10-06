// Customer journeys against real Express, PostgreSQL, Redis and compiled UI.
// Only provider boundaries are simulated. Never accepts a production DB URL.
import {randomUUID,createHash} from "node:crypto";
import {createServer,type Server} from "node:http";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import express from "express";
import { join } from "node:path";
import {chromium,type Browser} from "playwright";
import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
const url=process.env.BACKEND_FIX_TEST_DATABASE_URL;
if(url){if(new URL(url).pathname!=="/cheaterfinder_backend_fix_test_20260907"||!["127.0.0.1","localhost"].includes(new URL(url).hostname)||new URL(url).port==="5432")throw Error("Private scratch cluster required");process.env.DATABASE_URL=url;process.env.WORKERS_DISABLED="1";}
const provider=vi.hoisted(()=>({customers:{list:vi.fn(),create:vi.fn(),retrieve:vi.fn(),search:vi.fn(),del:vi.fn()},subscriptions:{list:vi.fn(),retrieve:vi.fn(),update:vi.fn()},coupons:{retrieve:vi.fn(),create:vi.fn()},checkout:{sessions:{list:vi.fn(),create:vi.fn(),expire:vi.fn(),retrieve:vi.fn()}},billingPortal:{sessions:{create:vi.fn()}},webhooks:{constructEvent:vi.fn()},invoices:{retrieve:vi.fn(),createPreview:vi.fn()}}));
const mail=vi.hoisted(()=>({send:vi.fn(async()=>"fixture-mail-id")}));
vi.mock("stripe",()=>({default:class{constructor(){return provider}}}));
vi.mock("../email-delivery.js",async original=>({...await original<typeof import("../email-delivery.js")>(),sendApplicationEmail:mail.send}));
vi.mock("../public-read-client.js",()=>({maybeRevalidateTier1:vi.fn(),fetchPublicProfileTier1:vi.fn(async()=>({ok:false,reason:"fixture-provider-offline"}))}));
vi.mock("../media-cache-jobs.js",async original=>({...await original<typeof import("../media-cache-jobs.js")>(),enqueueMediaCacheUrls:vi.fn(async()=>{})}));
const prefix="launch_"+randomUUID().replaceAll("-","").slice(0,12),password="Launch-Fixture-Password!";
const signingSecret="whsec_isolated_launch_fixture_only";
const fixtureUsers:string[]=[],customers=new Map<string,string>();
let fakeSubscription:any=null,checkoutSession:any=null,origin:string,pool:typeof import("../../db.js").pool,server:Server,browser:Browser;
const dir=process.env.CUSTOMER_FLOW_EVIDENCE_DIR??"/tmp/cheaterfinder-customer-flow-evidence-20260910";
const checks:string[]=[],observations:Record<string,unknown>={};
let fixtureClient=1;
const request=async(path:string,method="GET",body?:unknown,cookie="",extra:Record<string,string>={})=>{
 const csrf=cookie.match(/csrf_token=([^;]+)/)?.[1];
 const res=await fetch(origin+path,{method,headers:{"Content-Type":"application/json",cookie,...(csrf?{"x-csrf-token":decodeURIComponent(csrf)}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body),redirect:"manual"});
 const raw=await res.text();let data:any;try{data=JSON.parse(raw)}catch{data=raw}
 return{status:res.status,body:data,cookies:res.headers.getSetCookie().map(x=>x.split(";")[0]).join("; "),headers:res.headers};
};
const register=async(label:string)=>{
 const r=await request("/api/auth/register","POST",{name:"Launch Customer",email:prefix+label+"@example.invalid",password},"",{"x-forwarded-for":"192.0.2."+fixtureClient++});expect(r.status).toBe(201);fixtureUsers.push(r.body.id);expect((await pool.query("SELECT count(*)::int n FROM transactional_emails WHERE user_id=$1 AND kind='welcome'",[r.body.id])).rows[0].n).toBe(1);return{id:r.body.id,cookie:r.cookies,email:r.body.email};
};
function subscription(userId:string,status="trialing",plan="standard"){
 const now=Math.floor(Date.now()/1000);return{id:"sub_fixture_"+userId,customer:"cus_fixture_"+userId,status,created:now,metadata:{userId,plan},collection_method:"charge_automatically",discounts:[{id:"di_founder_fixture",source:{coupon:{id:"coupon_fixture_"+plan,duration:"forever"}}}],items:{has_more:false,data:[{id:"si_fixture",quantity:1,price:{id:"price_fixture_"+plan,recurring:{interval:"month",interval_count:1,usage_type:"licensed"}},current_period_end:now+259200}]},cancel_at_period_end:false,trial_end:now+259200,latest_invoice:"in_fixture"};
}
async function grant(user: {id:string}, plan="starter") {
  await (await import("../../stripe.js")).syncSubscription(subscription(user.id,"active",plan));
}
(url?describe:describe.skip)("customer launch complete flows — private fixtures only",()=>{
 beforeAll(async()=>{
  vi.stubEnv("STRIPE_SECRET_KEY","sk_test_local_fixture_only");vi.stubEnv("STRIPE_WEBHOOK_SECRET",signingSecret);vi.stubEnv("HTTPS_ENABLED","false");vi.stubEnv("SESSION_SECRET","isolated-launch-session-fixture-only");delete process.env.ADMIN_EMAIL;
  vi.stubEnv("STRIPE_TRIAL_ADVANCE_ENABLED","false");
  vi.stubEnv("SESSION_DATA_KEY",Buffer.alloc(32,71).toString('base64'));vi.stubEnv("BOT_CRED_KEY",Buffer.alloc(32,83).toString('base64'));
  for(const p of ["STARTER","STANDARD","PRO"]) { vi.stubEnv("STRIPE_"+p+"_PRICE_ID","price_fixture_"+p.toLowerCase()); vi.stubEnv("STRIPE_FOUNDERS_COUPON_"+p,"coupon_fixture_"+p.toLowerCase()); }
  vi.stubEnv("STRIPE_MANAGE_PORTAL_CONFIG_ID","bpc_manage_fixture"); vi.stubEnv("STRIPE_PLAN_PORTAL_CONFIG_ID","bpc_plan_fixture");
  vi.stubEnv("IMAGE_CACHE_DIR",dir+"/img-cache");
  provider.invoices.createPreview.mockImplementation(async(params:any)=>({ total: params.discounts ? 1750 : 3499, amount_due: params.discounts ? 1750 : 3499, starting_balance: 0, currency: "usd",discounts:["di_founder_fixture"],
    lines:{has_more:false,data:[{quantity:1,parent:{type:"subscription_item_details",subscription_item_details:{subscription:fakeSubscription?.id,subscription_item:"si_fixture",proration:false}},pricing:{price_details:{price:fakeSubscription?.items.data[0].price.id}},period:{start:fakeSubscription?.trial_end,end:(fakeSubscription?.trial_end??0)+2592000}}]} }));
  provider.coupons.retrieve.mockResolvedValue({id:"cheaterfinder_retention_50_once_v1",valid:true,percent_off:50,duration:"once"});
  pool=(await import("../../db.js")).pool;
  provider.customers.list.mockResolvedValue({data:[],has_more:false});provider.customers.create.mockImplementation(async({metadata}:any)=>{const id="cus_fixture_"+metadata.userId;customers.set(id,metadata.userId);return{id,metadata}});
  provider.customers.retrieve.mockImplementation(async(id:string)=>({id,metadata:{userId:customers.get(id)}}));
  provider.customers.search.mockResolvedValue({data:[],has_more:false});provider.customers.del.mockImplementation(async(id:string)=>{ if(checkoutSession?.customer===id) checkoutSession.status="expired"; return {id,deleted:true}; });
  provider.subscriptions.list.mockImplementation(async({customer}:any)=>({data:fakeSubscription?.customer===customer?[fakeSubscription]:[],has_more:false}));
  provider.subscriptions.retrieve.mockImplementation(async()=>fakeSubscription);
  provider.subscriptions.update.mockImplementation(async(_id:string,patch:any)=>{ fakeSubscription={...fakeSubscription,...patch,metadata:{...fakeSubscription.metadata,...patch.metadata}}; return fakeSubscription; });
  provider.checkout.sessions.list.mockResolvedValue({data:[],has_more:false});provider.checkout.sessions.expire.mockResolvedValue({status:"expired"});
  provider.checkout.sessions.create.mockImplementation(async(params:any)=>{checkoutSession={id:"cs_test_FixtureLaunch",url:origin+"/fixture-checkout",status:"open",payment_status:"unpaid",metadata:params.metadata,client_reference_id:params.client_reference_id,customer:params.customer,subscription:null};return checkoutSession});
  provider.checkout.sessions.retrieve.mockImplementation(async()=>checkoutSession);
  provider.billingPortal.sessions.create.mockResolvedValue({url:"https://billing.example.invalid/fixture"});
  const actual=await vi.importActual<typeof import("stripe")>("stripe");const sdk=new actual.default("sk_test_fixture");provider.webhooks.constructEvent.mockImplementation((...args:any[])=>sdk.webhooks.constructEvent(args[0],args[1],args[2]));
  const app=express();app.set("trust proxy","loopback");app.use(express.json({verify:(req,_res,buf)=>{(req as any).rawBody=buf}}));
  const {setupAuth,requireCsrfToken}=await import("../../auth.js");setupAuth(app);
  app.use((req,res,next)=>req.isAuthenticated()&&!['GET','HEAD','OPTIONS'].includes(req.method)?requireCsrfToken(req,res,next):next());
  server=createServer(app);await(await import("../../routes.js")).registerRoutes(server,app);
  app.use("/api",(_req,res)=>res.status(404).json({message:"Unknown fixture API"}));
  const buildDir=process.env.CUSTOMER_FLOW_BUILD_DIR??"dist";
  app.use(express.static(join(buildDir,"public")));const shell=await readFile(join(buildDir,"app-shell.html"),"utf8");app.use((_req,res)=>res.type("html").send(shell));
  app.use((err:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(500).json({message:"Fixture server error",type:err.name}));
  // The isolated runner reserves this localhost port in its network allowlist.
  await new Promise<void>(resolve=>server.listen(Number(process.env.STRESS_FAULT_PORT??0),"127.0.0.1",resolve));origin="http://127.0.0.1:"+(server.address() as {port:number}).port;vi.stubEnv("APP_URL",origin);
  await mkdir(dir,{recursive:true});browser=await chromium.launch({args:["--no-sandbox"]});
 },60000);
 it("logged-out billing and report email links resume their destination after real sign-in",async()=>{
  for(const destination of ['/settings?tab=billing','/reports']){
   fakeSubscription=null;const user=await register(destination==='/reports'?'returnreport':'returnbilling');
   fakeSubscription=subscription(user.id,destination==='/reports'?'active':'past_due');await(await import('../../stripe.js')).syncSubscription(fakeSubscription);
   await pool.query('UPDATE users SET onboarding_acknowledged_at=now() WHERE id=$1',[user.id]);
   const context=await browser.newContext({viewport:{width:390,height:844},extraHTTPHeaders:{'x-forwarded-for':'192.0.2.'+fixtureClient++}}),page=await context.newPage(),errors:string[]=[];
   page.on('pageerror',error=>errors.push(error.message));
   await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   try{
    // Start without cookies, exactly as an email opened in a signed-out browser.
    await page.goto(origin+destination);await page.locator('#auth-email').waitFor();
    expect(new URL(page.url()).pathname).toBe('/auth');expect(new URL(page.url()).searchParams.get('returnTo')).toBe(destination);
    if(destination.startsWith('/settings')){
     await page.getByRole('link',{name:'Forgot password?',exact:true}).click();await page.locator('#forgot-email').waitFor();
     expect(new URL(page.url()).searchParams.get('returnTo')).toBe(destination);
     await page.getByRole('button',{name:'Back to Sign In',exact:true}).click();await page.locator('#auth-email').waitFor();
     expect(new URL(page.url()).searchParams.get('returnTo')).toBe(destination);
    }
    await page.locator('#auth-email').fill(user.email);await page.locator('#auth-password').fill(password);
    const signedIn=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'&&r.request().method()==='POST');await page.locator('button[type="submit"]').click();expect((await signedIn).status()).toBe(200);
    await page.waitForURL(origin+destination);
    if(destination==='/reports')await page.getByRole('heading',{name:'Reports',exact:true}).waitFor();
    else {await page.getByRole('button',{name:'Manage',exact:true}).waitFor();await page.getByRole('button',{name:'Review payment in billing',exact:true}).waitFor();expect(await page.getByRole('heading',{name:'Profile Information',exact:true}).count()).toBe(0);}
    expect(new URL(page.url()).pathname+new URL(page.url()).search).toBe(destination);expect(errors).toEqual([]);
    await page.screenshot({path:dir+(destination==='/reports'?'/email-report-signin-mobile.png':'/email-billing-signin-mobile.png'),fullPage:true});
   }finally{await context.close();}
  }
  checks.push('signed-out payment-recovery CTA resumes billing tab even when past due; report CTA resumes reports after real sign-in; password-help back link preserves destination');
 },60000);
 it("browser rejects external return destinations and preserves the admin sign-in landing",async()=>{
  fakeSubscription=null;const user=await register('returnunsafe');fakeSubscription=subscription(user.id,'active');await(await import('../../stripe.js')).syncSubscription(fakeSubscription);
  await pool.query('UPDATE users SET onboarding_acknowledged_at=now() WHERE id=$1',[user.id]);
  for(const destination of ['https://example.invalid/settings','//example.invalid/reports','/settings?tab=billing']){
   const admin=destination.startsWith('/settings');if(admin)await pool.query("UPDATE users SET role='admin' WHERE id=$1",[user.id]);
   const context=await browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:{'x-forwarded-for':'192.0.2.'+fixtureClient++}}),page=await context.newPage(),externalNavigations:string[]=[];
   await context.route('**/*',route=>{
    const request=route.request();if(new URL(request.url()).origin===origin)return route.continue();
    if(request.isNavigationRequest())externalNavigations.push(new URL(request.url()).origin);return route.abort();
   });
   try{
    await page.goto(origin+'/auth?returnTo='+encodeURIComponent(destination));await page.locator('#auth-email').fill(user.email);await page.locator('#auth-password').fill(password);
    const signedIn=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login'&&r.request().method()==='POST');await page.locator('button[type="submit"]').click();expect((await signedIn).status()).toBe(200);
    await page.waitForURL(origin+(admin?'/admin':'/members'));await page.getByRole('heading',{name:admin?'Overview':'Your Tracked Accounts',exact:true}).waitFor();expect(externalNavigations).toEqual([]);
   }finally{await context.close();}
  }
  checks.push('real browser sign-in rejects absolute/protocol-relative redirects, defaults customers to members, and keeps admins in the admin console');
 },60000);
 it("browser first-access acknowledgement persists, settings save, retention acceptance and direct cancellation",async()=>{
  fakeSubscription=null;const user=await register('retentionbrowser');fakeSubscription=subscription(user.id);await(await import('../../stripe.js')).syncSubscription(fakeSubscription);
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addCookies(user.cookie.split('; ').map(value=>({name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:origin})));
  await page.goto(origin+'/members');await page.getByTestId('onboarding-notice').waitFor();
  const ack=page.waitForResponse(r=>r.url().endsWith('/api/auth/onboarding-ack'));await page.keyboard.press('Escape');expect((await ack).status()).toBe(200);
  await page.reload();await page.getByRole('heading',{name:'Your Tracked Accounts'}).waitFor();expect(await page.getByTestId('onboarding-notice').count()).toBe(0);
  expect((await pool.query('SELECT onboarding_acknowledged_at FROM users WHERE id=$1',[user.id])).rows[0].onboarding_acknowledged_at).not.toBeNull();
  await page.goto(origin+'/settings');await page.getByRole('heading',{name:'Profile Information'}).waitFor();await page.locator('form input[type="text"]').fill('Saved Browser Name');
  const emailSwitch=page.getByRole('switch',{name:'Email Alerts',exact:true}),pushSwitch=page.getByRole('switch',{name:'Push Notifications',exact:true});
  expect(await emailSwitch.getAttribute('aria-checked')).toBe('true');const previousPush=await pushSwitch.getAttribute('aria-checked');await emailSwitch.click();await pushSwitch.click();
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/account/profile')&&r.request().method()==='PUT');await page.getByRole('button',{name:'Save Changes',exact:true}).click();expect((await saved).status()).toBe(200);
  await page.getByText('Settings saved!',{exact:true}).waitFor();expect((await pool.query('SELECT name FROM users WHERE id=$1',[user.id])).rows[0].name).toBe('Saved Browser Name');
  expect((await pool.query('SELECT email_alerts,push_notifications FROM users WHERE id=$1',[user.id])).rows[0]).toEqual({email_alerts:false,push_notifications:previousPush!=='true'});
  await page.getByRole('button',{name:'Security',exact:true}).click();await page.getByPlaceholder('Enter new password').fill('Different-Password-1!');await page.getByPlaceholder('Confirm new password').fill('Mismatch-Password-2!');
  await page.getByRole('button',{name:'Update Password',exact:true}).click();expect(await page.locator('body').innerText()).toMatch(/match|required|current password/i);
  await page.getByRole('button',{name:'Billing & Plans',exact:true}).click();await page.getByRole('button',{name:'Cancel Subscription',exact:true}).click();
  await page.getByTestId('retention-accept').waitFor();await finishDialogAnimations(page);await page.screenshot({path:dir+'/retention-offer-desktop.png',fullPage:true});
  const offer=await ledgerForUser(user.id);expect(offer.amount).toBe(1750);expect(offer.regular_amount).toBe(3499);
  expect(await page.getByTestId('cancellation-dialog').innerText()).toContain('50%');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await finishDialogAnimations(page);expect(await page.getByTestId('cancellation-confirm').evaluate(button=>{const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})).toBe(true);
  await page.screenshot({path:dir+'/retention-offer-mobile.png',fullPage:true});
  const accepted=page.waitForResponse(r=>r.url().endsWith('/api/billing/retention-accept'));await page.getByTestId('retention-accept').click();expect((await accepted).status()).toBe(200);
  expect((await ledgerForUser(user.id)).state).toBe('applied');expect(fakeSubscription.cancel_at_period_end).toBe(false);
  await page.getByRole('button',{name:'Cancel Subscription',exact:true}).click();await page.getByTestId('cancellation-confirm').waitFor();
  const cancelled=page.waitForResponse(r=>r.url().endsWith('/api/billing/cancel'));await page.getByTestId('cancellation-confirm').click();expect((await cancelled).status()).toBe(200);
  await page.getByText(/Cancellation is scheduled/).waitFor();expect(fakeSubscription.cancel_at_period_end).toBe(true);
  expect(errors).toEqual([]);await context.close();checks.push('browser first-access notice/ack/reload, settings/profile/security controls, monthly retention acceptance, cancellation after redemption; desktop/mobile');
 },60000);
 it("browser cancellation remains available when offer quote fails and for past-due subscriptions",async()=>{
  fakeSubscription=null;const user=await register('cancelbrowser');fakeSubscription=subscription(user.id,'past_due');await(await import('../../stripe.js')).syncSubscription(fakeSubscription);
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
  await context.addCookies(user.cookie.split('; ').map(value=>({name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:origin})));
  await page.goto(origin+'/settings?tab=billing');await page.getByRole('button',{name:'Cancel Subscription',exact:true}).waitFor();
  await page.route('**/api/billing/retention-offer',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Offer temporarily unavailable'})}));
  await page.getByRole('button',{name:'Cancel Subscription',exact:true}).click();await page.getByTestId('cancellation-confirm').waitFor();
  expect(await page.getByTestId('retention-accept').count()).toBe(0);
  const cancel=page.waitForResponse(r=>r.url().endsWith('/api/billing/cancel'));await page.getByTestId('cancellation-confirm').click();expect((await cancel).status()).toBe(200);
  expect(fakeSubscription.cancel_at_period_end).toBe(true);await context.close();checks.push('past-due customer can cancel on mobile even when offer service fails');
 },60000);
 it("browser ignores delayed closed-dialog quotes and can cancel while a new quote is pending",async()=>{
  fakeSubscription=null;const user=await register('quoterace');fakeSubscription=subscription(user.id);await(await import('../../stripe.js')).syncSubscription(fakeSubscription);
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),acceptedIds:string[]=[];
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addCookies(user.cookie.split('; ').map(value=>({name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:origin})));
  const held:Array<{status:number;body:any;release:()=>void;done:Promise<void>}>=[];
  await page.route('**/api/billing/retention-offer',async route=>{
   // Generate each quote through the real billing route, then delay only delivery.
   const response=await route.fetch(),body=await response.json();let release!:()=>void,finished!:()=>void;
   const gate=new Promise<void>(resolve=>{release=resolve}),done=new Promise<void>(resolve=>{finished=resolve});held.push({status:response.status(),body,release,done});await gate;
   // Closing the dialog aborts its request, so delivery may correctly be rejected.
   try {await route.fulfill({response});} catch {} finally {finished();}
  });
  page.on('request',r=>{if(new URL(r.url()).pathname==='/api/billing/retention-accept')acceptedIds.push(r.postDataJSON().offerId)});
  try {
   await page.goto(origin+'/settings?tab=billing');await page.getByRole('button',{name:'Cancel Subscription',exact:true}).click();await vi.waitFor(()=>expect(held).toHaveLength(1));expect(held[0].status).toBe(200);expect(held[0].body.eligible).toBe(true);
   expect(await page.getByTestId('retention-accept').count()).toBe(0);await page.getByTestId('cancellation-back').click();await page.getByTestId('cancellation-dialog').waitFor({state:'detached'});
   await page.getByRole('button',{name:'Cancel Subscription',exact:true}).click();await vi.waitFor(()=>expect(held).toHaveLength(2));expect(held[1].status).toBe(200);expect(held[1].body.offerId).not.toBe(held[0].body.offerId);
   held[0].release();await held[0].done;await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   expect(await page.getByTestId('retention-accept').count()).toBe(0);expect(acceptedIds).toEqual([]);expect(await page.getByTestId('cancellation-confirm').isEnabled()).toBe(true);
   held[1].release();await held[1].done;await page.getByTestId('retention-accept').waitFor();const accept=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/billing/retention-accept');await page.getByTestId('retention-accept').click();expect((await accept).status()).toBe(200);expect(acceptedIds).toEqual([held[1].body.offerId]);expect((await ledgerForUser(user.id)).offer_id).toBe(held[1].body.offerId);
   await page.getByRole('button',{name:'Cancel Subscription',exact:true}).click();await vi.waitFor(()=>expect(held).toHaveLength(3));expect(await page.getByTestId('retention-accept').count()).toBe(0);expect(await page.getByTestId('cancellation-confirm').isEnabled()).toBe(true);
   const cancel=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/billing/cancel');await page.getByTestId('cancellation-confirm').click();expect((await cancel).status()).toBe(200);expect(fakeSubscription.cancel_at_period_end).toBe(true);await page.getByTestId('cancellation-dialog').waitFor({state:'detached'});
   held[2].release();await held[2].done;expect(acceptedIds).toEqual([held[1].body.offerId]);expect(await page.getByTestId('cancellation-dialog').count()).toBe(0);
   checks.push('delayed real quotes: closed-dialog response never enables stale acceptance; reopening accepts only current quote; cancellation succeeds before optional quote delivery');
  } finally {held.forEach(response=>response.release());await context.close();}
 },60000);
 afterAll(async()=>{
  if(browser)await browser.close();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
  await writeFile(dir+"/flows.json",JSON.stringify({at:new Date().toISOString(),checks,observations,providerMode:"simulated Stripe and email; real HTTP/auth/database/Redis/compiled UI",liveCustomerWrites:false},null,2));
  if(pool){await pool.query("DELETE FROM session WHERE sess::jsonb #>> '{passport,user,id}'=ANY($1::text[])",[fixtureUsers]);await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])",[fixtureUsers]);await pool.end()}
  vi.unstubAllEnvs();
 });
 it("browser signup, pricing, checkout click, cancel return and mobile layout",async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[];
  page.on("pageerror",e=>errors.push(e.message));await context.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin+"/payment?username=launch_target&plan=pro");await page.locator('input[type="email"]').waitFor();
  const inputs=page.locator('input');observations.signupInputs=await inputs.evaluateAll(xs=>xs.map(x=>({type:x.getAttribute('type'),name:x.getAttribute('name'),placeholder:x.getAttribute('placeholder')})));
  await page.locator('input[type="text"]').first().fill("Launch Browser");await page.locator('input[type="email"]').fill(prefix+"browser@example.invalid");await page.locator('input[type="password"]').fill(password);
  const registered=page.waitForResponse(r=>r.url().endsWith('/api/auth/register')&&r.request().method()==='POST');
  const eligibility=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/billing/eligibility'&&new URL(r.url()).searchParams.get('plan')==='pro');
  await page.locator('button[type="submit"]').click();const response=await registered;expect(response.status()).toBe(201);const user=await response.json();fixtureUsers.push(user.id);
  const eligibilityResponse=await eligibility;expect(eligibilityResponse.status()).toBe(200);const eligible=await eligibilityResponse.json();
  expect(eligible).toMatchObject({trialEligible:true,hasAccess:false,offer:{plan:'pro',currency:'usd',trialDays:3,dueTodayAmount:0,creditAmount:0,recurringAmount:3499,firstMonthlyAmount:3499,requiresAcceptance:false,cancellationPolicy:'none'}});
  const verifyLegacyOffer=async()=>{
   const offer=page.getByTestId('checkout-offer');await offer.waitFor();
   expect(await page.getByTestId('checkout-due-today').innerText()).toBe('$0.00');
   expect(await offer.locator('dl > div').filter({hasText:'Due today'}).locator('dd').innerText()).toBe('$0.00');
   expect(await offer.locator('dl > div').filter({hasText:'First monthly bill estimate'}).locator('dd').innerText()).toBe('$34.99');
   expect(await offer.locator('dl > div').filter({hasText:'Then monthly'}).locator('dd').innerText()).toBe('$34.99/month');
   await page.getByText('Includes a 3-day trial',{exact:true}).waitFor();
   for(const [name,price]of [['Starter','$11.99'],['Standard','$19.99'],['Pro','$34.99']])expect(await page.getByRole('button',{name:new RegExp('^'+name+' ')}).innerText()).toContain(price);
   expect(await page.getByRole('button',{name:/^Pro /}).getAttribute('aria-pressed')).toBe('true');
   expect(await page.getByTestId('checkout-offer-accept').count()).toBe(0);
   expect(await page.getByTestId('checkout-continue').innerText()).toBe('Continue to secure checkout');
   await vi.waitFor(async()=>expect(await page.getByTestId('checkout-continue').isEnabled()).toBe(true));
  };
  await verifyLegacyOffer();await page.screenshot({path:dir+"/signup-plan-desktop.png",fullPage:true});
  const checkout=page.waitForResponse(r=>r.url().endsWith('/api/billing/checkout'));await page.getByTestId('checkout-continue').click();const checkoutResponse=await checkout;expect(checkoutResponse.status()).toBe(200);
  expect(checkoutResponse.request().postDataJSON()).toMatchObject({plan:'pro',acceptedOfferVersion:eligible.offer.version,igUsername:'launch_target'});await page.waitForURL('**/fixture-checkout');
  const expectedCheckout={metadata:{userId:user.id,plan:"pro",trialEligible:"true"},line_items:[{price:"price_fixture_pro",quantity:1}],discounts:[{coupon:"coupon_fixture_pro"}],payment_method_collection:"always",subscription_data:{trial_period_days:3}};
  expect(provider.checkout.sessions.create.mock.lastCall?.[0]).toMatchObject(expectedCheckout);
  await page.goto(origin+'/payment?checkout=cancelled&username=launch_target&plan=pro');await page.getByText('You returned from checkout. Review your billing status before starting another payment.',{exact:true}).waitFor();
  await verifyLegacyOffer();
  await page.setViewportSize({width:390,height:844}); await page.screenshot({path:dir+'/checkout-cancel-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true); await page.setViewportSize({width:1440,height:1000});
  const retried=page.waitForResponse(r=>r.url().endsWith('/api/billing/checkout'));await page.getByTestId('checkout-continue').click();const retryResponse=await retried;expect(retryResponse.status()).toBe(200);
  expect(retryResponse.request().postDataJSON()).toMatchObject({plan:'pro',acceptedOfferVersion:eligible.offer.version,igUsername:'launch_target'});await page.waitForURL('**/fixture-checkout');
  expect(provider.checkout.sessions.create.mock.lastCall?.[0]).toMatchObject(expectedCheckout);
  fakeSubscription=subscription(user.id,"trialing","pro");checkoutSession={...checkoutSession,status:"complete",payment_status:"no_payment_required",subscription:fakeSubscription};
  const confirmed=page.waitForResponse(r=>r.url().includes('/api/billing/checkout-session/'));await page.goto(origin+'/settings?tab=billing&checkout=success&session_id=cs_test_FixtureLaunch');expect((await confirmed).status()).toBe(200);
  await page.waitForURL("**/members?username=launch_target");
  await page.getByTestId("onboarding-ack").click();
  await page.locator('input[value="launch_target"]').waitFor();
  expect(await page.locator('input[value="launch_target"]').count()).toBe(1);
  await page.locator('input[value="launch_target"]').press('Enter'); await page.waitForURL('**/dashboard/*');
  expect((await pool.query("SELECT count(*)::int n FROM tracked_accounts WHERE user_id=$1 AND ig_username='launch_target'",[user.id])).rows[0].n).toBe(1);
  await page.goto(origin+'/settings?tab=billing'); await page.getByText("Pro Plan",{exact:true}).waitFor();await page.screenshot({path:dir+'/checkout-success-settings.png',fullPage:true});
  observations.heroTargetPersisted=(await pool.query("SELECT count(*)::int n FROM tracked_accounts WHERE user_id=$1",[user.id])).rows[0].n;
  const logoutStatus=await page.evaluate(async()=>{const res=await fetch('/api/auth/logout',{method:'POST',headers:{'X-Requested-With':'XMLHttpRequest','x-csrf-token':decodeURIComponent(document.cookie.match(/csrf_token=([^;]+)/)?.[1]??'')}});return res.status});
  expect(logoutStatus).toBe(200); expect(errors).toEqual([]); await context.close();checks.push("browser signup → plan → checkout → success confirmation/settings → cancellation page; desktop/mobile");
 },60000);
 it("registers/login boundary, paid-only entitlement and concurrent limit enforcement",async()=>{
  const user=await register('free');
  expect((await request('/api/billing/subscription','GET',undefined,user.cookie)).body).toBeNull();
  for (const path of ['/api/tracking/accounts','/api/viewer/example','/api/reports','/api/realtime/events','/api/media/fixture','/api/img-proxy?url=https://example.com','/api/notifications']) expect((await request(path,'GET',undefined,user.cookie)).status).toBe(402);
  expect((await request('/api/tracking/accounts','POST',{igUsername:prefix+'unpaid'},user.cookie)).status).toBe(402);
  await grant(user);
  const attempts=await Promise.all(['alpha','beta'].map(s=>request('/api/tracking/accounts','POST',{igUsername:prefix+s},user.cookie)));
  expect(attempts.map(r=>r.status).sort()).toEqual([201,402]);const id=attempts.find(r=>r.status===201)!.body.id;
  expect((await request('/api/viewer/'+prefix+(attempts[0].status===201?'alpha':'beta'),'GET',undefined,user.cookie)).status).toBe(200);
  const foreign=await register('foreign');await grant(foreign);expect((await request('/api/tracking/accounts/'+id+'/report','GET',undefined,foreign.cookie)).status).toBe(404);
  expect((await request('/api/tracking/accounts/'+id,'DELETE',undefined,foreign.cookie)).status).toBe(404);
  expect((await request('/api/tracking/accounts/'+id,'DELETE',undefined,user.cookie)).status).toBe(200);
  expect((await request('/api/tracking/accounts','GET',undefined,user.cookie)).body).toEqual([]);
  observations.unpaidUsersCanTrackAndRead=false;checks.push("real signup, paid-only limit under concurrency, viewer access, cross-customer denial, stop tracking");
 },30000);
 it("expired periods and unlinked manual subscriptions cannot grant data or collection access",async()=>{
  const user=await register('expiry'); await grant(user);
  const account=await request('/api/tracking/accounts','POST',{igUsername:prefix+'expiry'},user.cookie); expect(account.status).toBe(201);
  const {customerHasAccess,trackedAccountHasAccess}=await import('../subscription-access.js');
  const mediaUrl='https://scontent.cdninstagram.com/'+prefix+'.png', mediaKey=createHash('sha256').update(mediaUrl).digest('hex');
  await mkdir(dir+'/img-cache',{recursive:true});
  await writeFile(dir+'/img-cache/'+mediaKey+'.body',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOZkAAAAASUVORK5CYII=','base64'));
  await writeFile(dir+'/img-cache/'+mediaKey+'.json',JSON.stringify({contentType:'image/png'}));
  const verify=async(allowed:boolean)=>{
   expect(await customerHasAccess(user.id)).toBe(allowed); expect(await trackedAccountHasAccess(account.body.id)).toBe(allowed);
   expect((await request('/api/tracking/accounts','GET',undefined,user.cookie)).status).toBe(allowed?200:402);
   const media=await request('/api/img-proxy?url='+encodeURIComponent(mediaUrl),'GET',undefined,user.cookie);
   expect(media.status).toBe(allowed?200:402);
   if(allowed)expect(media.headers.get('cache-control')).toBe('private, no-store');
  };
  await verify(true);
  await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 second' WHERE user_id=$1",[user.id]); await verify(false);
  await pool.query("UPDATE subscriptions SET status='trialing',trial_ends_at=now()-interval '1 second' WHERE user_id=$1",[user.id]); await verify(false);
  await pool.query("UPDATE subscriptions SET trial_ends_at=now()+interval '1 day' WHERE user_id=$1",[user.id]); await verify(true);
  await pool.query("UPDATE subscriptions SET stripe_subscription_id=NULL WHERE user_id=$1",[user.id]); await verify(false);
  expect((await request('/api/tracking/accounts/'+account.body.id,'DELETE',undefined,user.cookie)).status).toBe(200);
  checks.push("paid/trial expiry and manual rows deny HTTP + collection + cached image access; images are private/no-store; unpaid customers can stop tracking");
 });
 it("signed webhook → trial entitlement → replay → cancellation → downgrade; invalid signatures denied",async()=>{
  const user=await register('paid');await request('/api/billing/checkout','POST',{plan:'standard'},user.cookie);
  fakeSubscription=subscription(user.id);checkoutSession={...checkoutSession,status:'complete',payment_status:'no_payment_required',subscription:fakeSubscription};
  const actual=await vi.importActual<typeof import("stripe")>('stripe');const sdk=new actual.default('sk_test_fixture');
  const event={id:'evt_fixture_'+randomUUID(),type:'customer.subscription.created',data:{object:fakeSubscription}};
  expect((await request('/api/webhooks/stripe','POST',event)).status).toBe(400);
  const sign=(obj:any)=>sdk.webhooks.generateTestHeaderString({payload:JSON.stringify(obj),secret:signingSecret});
  expect((await request('/api/webhooks/stripe','POST',event,'',{'stripe-signature':sign(event)})).status).toBe(200);
  expect((await request('/api/webhooks/stripe','POST',event,'',{'stripe-signature':sign(event)})).status).toBe(200);
  expect((await pool.query('SELECT count(*)::int n FROM stripe_webhook_events WHERE id=$1',[event.id])).rows[0].n).toBe(1);
  expect((await request('/api/billing/subscription','GET',undefined,user.cookie)).body).toMatchObject({status:'trialing',plan:'standard'});
  const other=await register('checkoutforeign');expect((await request('/api/billing/checkout-session/cs_test_FixtureLaunch','GET',undefined,other.cookie)).status).toBe(404);
  expect((await request('/api/billing/checkout-session/cs_test_FixtureLaunch','GET',undefined,user.cookie)).status).toBe(200);
  for(let n=0;n<3;n++)expect((await request('/api/tracking/accounts','POST',{igUsername:prefix+'paid'+n},user.cookie)).status).toBe(201);
  expect((await request('/api/tracking/accounts','POST',{igUsername:prefix+'paidextra'},user.cookie)).status).toBe(402);
  expect((await request('/api/billing/portal','POST',undefined,user.cookie)).status).toBe(200);
  expect(provider.billingPortal.sessions.create.mock.lastCall?.[0].configuration).toBe('bpc_manage_fixture');
  expect((await request('/api/billing/portal','POST',{plan:'pro'},user.cookie)).status).toBe(200);
  expect(provider.billingPortal.sessions.create.mock.lastCall?.[0]).toMatchObject({configuration:'bpc_plan_fixture',flow_data:{type:'subscription_update_confirm',subscription_update_confirm:{items:[{id:'si_fixture',price:'price_fixture_pro',quantity:1}],discounts:[{coupon:'coupon_fixture_pro'}]}}});
  expect((await request('/api/billing/cancel','POST',undefined,user.cookie)).status).toBe(200);
  expect((await request('/api/billing/subscription','GET',undefined,user.cookie)).body.cancelAtPeriodEnd).toBe(true);
  fakeSubscription={...fakeSubscription,status:'canceled'};const cancel={...event,id:'evt_fixture_'+randomUUID(),type:'customer.subscription.deleted',data:{object:fakeSubscription}};
  expect((await request('/api/webhooks/stripe','POST',cancel,'',{'stripe-signature':sign(cancel)})).status).toBe(200);
  expect((await request('/api/tracking/accounts','GET',undefined,user.cookie)).status).toBe(402);
  expect((await pool.query('SELECT count(*)::int n FROM tracked_accounts WHERE user_id=$1 AND is_active',[user.id])).rows[0].n).toBe(0);
  observations.afterCancellationActiveAccounts=0;
  await pool.query('DELETE FROM stripe_webhook_events WHERE id=ANY($1::varchar[])',[[event.id,cancel.id]]);
  checks.push("real signature check/replay ledger, checkout ownership, trial limit, portal route, cancel and webhook downgrade");
 },30000);
 it("returning canceled subscriber cannot receive another trial",async()=>{
  const user=await register('returning');customers.set('cus_fixture_'+user.id,user.id);fakeSubscription=subscription(user.id,'canceled');
  await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,trial_ends_at) VALUES($1,$2,$3,'canceled','standard',now()-interval '1 day')",[user.id,fakeSubscription.customer,fakeSubscription.id]);
  expect((await request('/api/billing/checkout','POST',{plan:'standard'},user.cookie)).status).toBe(200);
  expect(provider.checkout.sessions.create.mock.lastCall?.[0].subscription_data.trial_period_days).toBeUndefined();
  // Durable trial history survives replacement/removal of a local subscription row.
  await (await import('../../stripe.js')).syncSubscription(fakeSubscription);
  expect((await pool.query('SELECT trial_used_at FROM users WHERE id=$1',[user.id])).rows[0].trial_used_at).not.toBeNull();
  await pool.query('DELETE FROM subscriptions WHERE user_id=$1',[user.id]); fakeSubscription=null;
  expect((await request('/api/billing/checkout','POST',{plan:'standard'},user.cookie)).status).toBe(200);
  expect(provider.checkout.sessions.create.mock.lastCall?.[0].subscription_data.trial_period_days).toBeUndefined();
  observations.returningCustomerReceivesAnotherThreeDayTrial=false;checks.push("returning subscriber does not receive another trial");
 });
 it("signed payment authorization webhook notifies once and ignores a subsequently paid invoice",async()=>{
  const user=await register('authorization');customers.set('cus_fixture_'+user.id,user.id);
  fakeSubscription=subscription(user.id,'past_due');const invoiceId='in_authorization_'+randomUUID();fakeSubscription.latest_invoice=invoiceId;
  const actual=await vi.importActual<typeof import('stripe')>('stripe'),sdk=new actual.default('sk_test_fixture');
  const event={id:'evt_authorization_'+randomUUID(),type:'invoice.payment_action_required',data:{object:{id:invoiceId,customer:fakeSubscription.customer}}};
  const stale={...event,id:'evt_authorization_paid_'+randomUUID()};
  const send=(payload:any)=>request('/api/webhooks/stripe','POST',payload,'',{'stripe-signature':sdk.webhooks.generateTestHeaderString({payload:JSON.stringify(payload),secret:signingSecret})});
  provider.invoices.retrieve.mockResolvedValue({id:invoiceId,customer:fakeSubscription.customer,status:'open',attempt_count:1,amount_remaining:3500,payments:{has_more:false,data:[{invoice:invoiceId,is_default:true,status:'open',payment:{type:'payment_intent',payment_intent:{id:'pi_auth_fixture',customer:fakeSubscription.customer,status:'requires_action'}}}]}});
  try {
   expect((await send(event)).status).toBe(200);expect((await send(event)).status).toBe(200);
   const notifications=(await pool.query("SELECT title,body FROM notifications WHERE user_id=$1 AND type='payment_failed'",[user.id])).rows;
   expect(notifications).toHaveLength(1);expect(notifications[0].title).toBe('Payment authorization required');expect(notifications[0].body).toMatch(/bank requires payment authorization/i);
   expect((await pool.query('SELECT count(*)::int n FROM stripe_webhook_events WHERE id=$1',[event.id])).rows[0].n).toBe(1);
   const mailRows=(await pool.query("SELECT id FROM transactional_emails WHERE user_id=$1 AND kind='payment_action_required'",[user.id])).rows;expect(mailRows).toHaveLength(1);
   const {flushTransactionalEmails}=await import('../transactional-emails.js');expect((await flushTransactionalEmails(1,mailRows[0].id)).accepted).toBe(1);
   const actionMail=mail.send.mock.calls.filter((args:any)=>args[0].to===user.email && args[0].subject.includes('Authorize'));expect(actionMail).toHaveLength(1);
   expect((actionMail[0] as any)[0].text).toContain('/settings?tab=billing');
   fakeSubscription={...fakeSubscription,status:'active'};provider.invoices.retrieve.mockResolvedValue({id:invoiceId,status:'paid',attempt_count:1});
   expect((await send(stale)).status).toBe(200);
   expect((await pool.query("SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type='payment_failed'",[user.id])).rows[0].n).toBe(1);
   expect((await request('/api/billing/subscription','GET',undefined,user.cookie)).body.status).toBe('active');
   checks.push('signed payment_action_required webhook creates one actionable notice; replay and later paid invoice do not duplicate or downgrade');
  } finally {await pool.query('DELETE FROM stripe_webhook_events WHERE id=ANY($1::varchar[])',[[event.id,stale.id]]);provider.invoices.retrieve.mockReset();}
 });
 it("signed trial-ending events ignore an extended trial and queue one current reminder",async()=>{
  const user=await register('trialreminder');customers.set('cus_fixture_'+user.id,user.id);fakeSubscription=subscription(user.id);
  fakeSubscription.trial_end=Math.floor(Date.now()/1000)+5*86400;
  const actual=await vi.importActual<typeof import('stripe')>('stripe'),sdk=new actual.default('sk_test_fixture');
  const old={id:'evt_trial_extended_'+randomUUID(),type:'customer.subscription.trial_will_end',data:{object:{id:fakeSubscription.id,customer:fakeSubscription.customer,trial_end:Math.floor(Date.now()/1000)+86400}}};
  const current={...old,id:'evt_trial_current_'+randomUUID()};
  const sendEvent=(payload:any)=>request('/api/webhooks/stripe','POST',payload,'',{'stripe-signature':sdk.webhooks.generateTestHeaderString({payload:JSON.stringify(payload),secret:signingSecret})});
  try {
   expect((await sendEvent(old)).status).toBe(200);
   expect((await pool.query("SELECT count(*)::int n FROM transactional_emails WHERE user_id=$1 AND kind='trial_ending'",[user.id])).rows[0].n).toBe(0);
   fakeSubscription.trial_end=Math.floor(Date.now()/1000)+2*86400;
   expect((await sendEvent(current)).status).toBe(200);expect((await sendEvent(current)).status).toBe(200);
   const queued=(await pool.query("SELECT id,payload FROM transactional_emails WHERE user_id=$1 AND kind='trial_ending'",[user.id])).rows;
   expect(queued).toHaveLength(1);expect(queued[0].payload.trialEndsAt).toBe(new Date(fakeSubscription.trial_end*1000).toISOString());
   expect((await(await import('../transactional-emails.js')).flushTransactionalEmails(1,queued[0].id)).accepted).toBe(1);
   expect(mail.send.mock.calls.filter((args:any)=>args[0].to===user.email && args[0].subject.includes('trial ends soon'))).toHaveLength(1);
   checks.push('signed trial-ending webhook respects the current extended trial date and deduplicates its future reminder');
  } finally {await pool.query('DELETE FROM stripe_webhook_events WHERE id=ANY($1::varchar[])',[[old.id,current.id]]);}
 });
 it("password-reset email boundary, one-use link, settings preferences, logout and deletion",async()=>{
  fakeSubscription=null;const user=await register('reset');
  expect((await request('/api/account/profile','PUT',{name:'Updated Customer',emailAlerts:false,pushNotifications:false},user.cookie)).status).toBe(200);
  expect((await request('/api/auth/me','GET',undefined,user.cookie)).body).toMatchObject({emailAlerts:false,pushNotifications:false});
  expect((await request('/api/auth/forgot-password','POST',{email:user.email})).status).toBe(200);
  const html=(mail.send.mock.lastCall as any)?.[0]?.html as string;const token=html.match(/reset-password\?token=([a-f0-9]{64})/)?.[1];expect(token).toBeTruthy();
  expect((await request('/api/auth/reset-password','POST',{token,password:'Changed-Launch-Password!'})).status).toBe(200);
  expect((await request('/api/auth/reset-password','POST',{token,password:'Another-Launch-Password!'})).status).toBe(400);
  expect((await request('/api/auth/me','GET',undefined,user.cookie)).status).toBe(401);
  const login=await request('/api/auth/login','POST',{email:user.email,password:'Changed-Launch-Password!'});expect(login.status).toBe(200);
  expect((await request('/api/account','DELETE',undefined,login.cookies)).status).toBe(200);
  expect((await request('/api/auth/me','GET',undefined,login.cookies)).status).toBe(401);
  expect((await pool.query('SELECT id FROM users WHERE id=$1',[user.id])).rowCount).toBe(0);
  checks.push("preferences persist, reset template/token redemption/replay, session revocation and account deletion");
 },30000);
 it("customer browser opens roster tabs, reads notifications and removes a tracked account through confirmation",async()=>{
  fakeSubscription=null;const user=await register('navigation');await grant(user);await pool.query('UPDATE users SET onboarding_acknowledged_at=now() WHERE id=$1',[user.id]);
  const username=prefix+'nav',account=await request('/api/tracking/accounts','POST',{igUsername:username},user.cookie);expect(account.status).toBe(201);
  const noticeId=randomUUID();await pool.query("INSERT INTO notifications(id,user_id,type,title,body) VALUES($1,$2,'new_follow','Browser first notification','First fixture observation'),($3,$2,'new_follow','Browser second notification','Second fixture observation')",[noticeId,user.id,randomUUID()]);
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addCookies(user.cookie.split('; ').map(value=>({name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:origin})));
  try {
   await page.goto(origin+'/dashboard/'+account.body.id);await page.getByRole('tablist',{name:'Followers view'}).waitFor();
   const reject=page.getByRole('button',{name:'Reject analytics',exact:true});if(await reject.isVisible())await reject.click();
   for(const [label,mode] of [['All followers','followers'],['Following list','following']]){
    const roster=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tracking/accounts/'+account.body.id+'/'+mode+'/roster');await page.getByRole('tab',{name:label,exact:true}).click();expect((await roster).status()).toBe(200);expect(await page.getByRole('tab',{name:label,exact:true}).getAttribute('aria-selected')).toBe('true');
   }
   await page.getByRole('tab',{name:'Recent activity',exact:true}).click();expect(await page.getByRole('tab',{name:'Recent activity',exact:true}).getAttribute('aria-selected')).toBe('true');
   await page.getByRole('button',{name:'All Accounts',exact:true}).click();await page.waitForURL('**/members');
   await page.locator('aside nav').getByText('Notifications',{exact:true}).click();await page.waitForURL('**/notifications');
   const readOne=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/notifications/'+noticeId+'/read'&&r.request().method()==='PATCH');await page.getByText('Browser first notification',{exact:true}).click();expect((await readOne).status()).toBe(200);expect((await pool.query('SELECT is_read FROM notifications WHERE id=$1',[noticeId])).rows[0].is_read).toBe(true);
   const readAll=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/notifications/read-all'&&r.request().method()==='PATCH');await page.getByRole('button',{name:'Mark all as read',exact:true}).click();expect((await readAll).status()).toBe(200);expect((await pool.query('SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND NOT is_read',[user.id])).rows[0].n).toBe(0);
   await page.locator('aside nav').getByText('Tracked Accounts',{exact:true}).click();await page.waitForURL('**/members');
   await page.getByRole('button',{name:'Remove @'+username,exact:true}).click();const dialog=page.getByRole('alertdialog',{name:'Remove this account?',exact:true});await dialog.getByRole('button',{name:'Cancel',exact:true}).click();expect((await pool.query('SELECT id FROM tracked_accounts WHERE id=$1',[account.body.id])).rowCount).toBe(1);
   await page.getByRole('button',{name:'Remove @'+username,exact:true}).click();const remove=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tracking/accounts/'+account.body.id&&r.request().method()==='DELETE');await dialog.getByRole('button',{name:'Remove',exact:true}).click();expect((await remove).status()).toBe(200);expect((await pool.query('SELECT is_active FROM tracked_accounts WHERE id=$1',[account.body.id])).rows[0].is_active).toBe(false);
   expect((await request('/api/tracking/accounts','GET',undefined,user.cookie)).body).toEqual([]);await page.getByRole('button',{name:'Remove @'+username,exact:true}).waitFor({state:'detached'});
   expect(errors).toEqual([]);checks.push('customer browser: dashboard followers/following/recent tabs, account/notification navigation, single/all notification read, dismiss/confirm tracked-account removal');
  } finally {await context.close();}
 },60000);
 it("admin deletion closes owned pending Stripe checkout before removing the user",async()=>{
  fakeSubscription=null;const admin=await register('admin'),user=await register('admindelete');
  await pool.query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]);
  expect((await request('/api/billing/checkout','POST',{plan:'starter'},user.cookie)).status).toBe(200);
  provider.customers.del.mockRejectedValueOnce(new Error('Fixture Stripe outage'));
  expect((await request('/api/admin/users/'+user.id,'DELETE',undefined,admin.cookie)).status).toBe(502);
  expect((await pool.query('SELECT id FROM users WHERE id=$1',[user.id])).rowCount).toBe(1);
  expect(checkoutSession.status).toBe('open');
  const before=provider.customers.del.mock.calls.length;
  expect((await request('/api/admin/users/'+user.id,'DELETE',undefined,admin.cookie)).status).toBe(200);
  expect((await pool.query('SELECT id FROM users WHERE id=$1',[user.id])).rowCount).toBe(0);
  expect(provider.customers.del.mock.calls.length).toBe(before+1);
  expect(checkoutSession.status).toBe('expired');
  observations.adminDeletionLeavesOwnedCheckoutOpen=false;checks.push("admin deletion closes owned Stripe billing and revokes local account");
 });
 it("admin browser navigates every section, filters saved data, opens details and reads real queue health",async()=>{
  const admin=await register('adminnav'),customer=await register('adminnavcustomer');
  await pool.query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]);await grant(customer);
  const accountId=randomUUID(),mineId=randomUUID(),pendingId=randomUUID(),username=prefix+'adm',mineUsername=prefix+'own',pendingUsername=prefix+'waiting';
  await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id) VALUES($1,$2,$3,$4),($5,$6,$7,$8)",[accountId,customer.id,username,accountId,mineId,admin.id,mineUsername,mineId]);
  const context=await browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:{'x-forwarded-for':'198.51.100.210'}}),page=await context.newPage(),errors:string[]=[];
  const adminFailures:string[]=[];page.on('response',response=>{const u=new URL(response.url());if(u.pathname.startsWith('/api/admin/')&&response.status()!==200)adminFailures.push(response.request().method()+' '+u.pathname+' '+response.status())});
  page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addCookies(admin.cookie.split('; ').map(value=>({name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:origin})));
  const api=(path:string,params:Record<string,string>={})=>page.waitForResponse(response=>{const u=new URL(response.url());return u.pathname===path&&Object.entries(params).every(([key,value])=>u.searchParams.get(key)===value)});
  const section=async(label:string,path:string)=>{const response=api(path);await page.getByRole('navigation',{name:'Admin sections'}).getByRole('button',{name:label,exact:true}).click();expect((await response).status()).toBe(200)};
  try {
   const overview=api('/api/admin/overview');await page.goto(origin+'/admin');expect((await overview).status()).toBe(200);await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
   await section('Users','/api/admin/users');
   const users=api('/api/admin/users',{search:customer.email});await page.getByPlaceholder('Search by name or email...').fill(customer.email);await page.getByPlaceholder('Search by name or email...').press('Enter');expect((await users).status()).toBe(200);
   const active=api('/api/admin/users',{status:'active'});await page.getByRole('combobox').click();await page.getByRole('option',{name:'Active',exact:true}).click();expect((await active).status()).toBe(200);
   const detail=api('/api/admin/users/'+customer.id);await page.getByRole('row').filter({hasText:customer.email}).click();expect((await detail).status()).toBe(200);
   const userDialog=page.getByRole('dialog',{name:'User Details'});await userDialog.getByText(customer.email,{exact:true}).waitFor();await userDialog.getByRole('button',{name:'Close',exact:true}).click();
   await section('Tracked Accounts','/api/admin/tracked-accounts');
   const tracks=api('/api/admin/tracked-accounts',{search:username});await page.getByRole('textbox',{name:'Search tracked accounts'}).fill(username);await page.getByRole('textbox',{name:'Search tracked accounts'}).press('Enter');expect((await tracks).status()).toBe(200);
   const tracked=api('/api/admin/tracked-accounts/'+accountId);await page.getByRole('row',{name:'Open details for @'+username}).click();expect((await tracked).status()).toBe(200);
   const trackedDialog=page.getByRole('dialog',{name:'Tracked account',exact:true});await trackedDialog.getByRole('heading',{name:'@'+username,exact:true}).waitFor();
   await trackedDialog.getByTestId('admin-content-posts').waitFor();
   const likesPage=api('/api/admin/tracked-accounts/'+accountId+'/liked-posts');await trackedDialog.getByRole('tab',{name:'Liked posts',exact:true}).click();expect((await likesPage).status()).toBe(200);
   await trackedDialog.getByText('No liked posts have been detected. This does not establish that there was no activity.').waitFor();await trackedDialog.getByRole('button',{name:'Close',exact:true}).click();
   const paused=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/tracked-accounts/'+accountId&&r.request().method()==='PATCH');await page.getByRole('switch',{name:'Pause tracking for @'+username}).click();expect((await paused).status()).toBe(200);
   expect((await pool.query('SELECT is_active FROM tracked_accounts WHERE id=$1',[accountId])).rows[0].is_active).toBe(false);
   const resumed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/tracked-accounts/'+accountId&&r.request().method()==='PATCH');await page.getByRole('switch',{name:'Resume tracking for @'+username}).click();expect((await resumed).status()).toBe(200);
   const publicFilter=api('/api/admin/tracked-accounts',{access:'public'});await page.getByRole('combobox').nth(1).click();await page.getByRole('option',{name:'Public',exact:true}).click();expect((await publicFilter).status()).toBe(200);
   const clearSearch=api('/api/admin/tracked-accounts',{access:'public'});await page.getByRole('textbox',{name:'Search tracked accounts'}).fill('');await page.getByRole('textbox',{name:'Search tracked accounts'}).press('Enter');expect((await clearSearch).status()).toBe(200);
   const mine=api('/api/admin/tracked-accounts',{owner:'me'});await page.getByRole('button',{name:'Mine',exact:true}).click();const mineResult=await mine;expect(mineResult.status()).toBe(200);expect((await mineResult.json()).items.every((row:any)=>row.userId===admin.id)).toBe(true);
   await section('Activity','/api/admin/activity');
   const activitySearch=api('/api/admin/activity',{search:username});await page.getByPlaceholder('Search by IG username...').fill(username);await page.getByPlaceholder('Search by IG username...').press('Enter');expect((await activitySearch).status()).toBe(200);
   const follows=api('/api/admin/activity',{type:'follow'});await page.getByRole('combobox').click();await page.getByRole('option',{name:'Follows',exact:true}).click();expect((await follows).status()).toBe(200);
   const refreshed=api('/api/admin/activity');await page.getByRole('button',{name:'Refresh',exact:true}).click();expect((await refreshed).status()).toBe(200);
   await section('Bots','/api/admin/bots');await page.getByRole('heading',{name:'Bot Accounts',exact:true}).waitFor();
   const cadence=api('/api/admin/refresh-interval');await section('Bandwidth','/api/admin/bandwidth');expect((await cadence).status()).toBe(200);
   const week=api('/api/admin/bandwidth',{window:'7d'});await page.getByRole('button',{name:'7 days',exact:true}).click();expect((await week).status()).toBe(200);
   const bandwidth=api('/api/admin/bandwidth');await page.getByRole('button',{name:'Refresh bandwidth',exact:true}).click();expect((await bandwidth).status()).toBe(200);
   const queues=api('/api/admin/queues'),transport=api('/api/admin/scraper-transport');await section('System','/api/admin/jobs');expect((await transport).status()).toBe(200);const queueResult=await queues;expect(queueResult.status()).toBe(200);expect((await queueResult.json()).queues.length).toBeGreaterThan(0);await page.getByRole('heading',{name:'Queue Health',exact:true}).waitFor();
   const failed=api('/api/admin/jobs',{status:'failed'});await page.getByRole('combobox').filter({hasText:'All Status'}).click();await page.getByRole('option',{name:'Failed',exact:true}).click();expect((await failed).status()).toBe(200);
   const profile=api('/api/admin/jobs',{jobType:'profile'});await page.getByRole('combobox').filter({hasText:'All Types'}).click();await page.getByRole('option',{name:'Profile',exact:true}).click();expect((await profile).status()).toBe(200);
   await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,is_private,access_status) VALUES($1,$2,$3,true,'pending_access')",[pendingId,customer.id,pendingUsername]);
   const health=api('/api/admin/health');await page.getByRole('button',{name:'Live Health',exact:true}).click();const snapshot=await health;expect(snapshot.status()).toBe(200);const healthBody=await snapshot.json();expect(healthBody.status).toBe('red');await page.getByRole('heading',{name:'System Health',exact:true}).waitFor();
   expect(healthBody.collection.awaitingApprovalProfiles).toBeGreaterThan(0);expect(healthBody.collection.missingProfileBaselines).toBeGreaterThan(0);expect(healthBody.collection.verification).toBe('degraded');
   const collectionCard=page.getByTestId('roster-health');await collectionCard.getByRole('row').filter({hasText:'@'+pendingUsername}).getByText('Awaiting private approval',{exact:true}).waitFor();
   await collectionCard.getByRole('row').filter({hasText:'@'+username}).getByText('Initial profile baseline needed',{exact:true}).waitFor();
   await collectionCard.getByText(`${healthBody.collection.staleFollowerRosters}/${healthBody.collection.rosterEligibleProfiles} eligible follower rosters and ${healthBody.collection.staleFollowingRosters}/${healthBody.collection.rosterEligibleProfiles} eligible following rosters have no complete read within 48h.`,{exact:true}).waitFor();
   await page.screenshot({path:dir+'/admin-collection-reasons-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:dir+'/admin-collection-reasons-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});
   const healthRefresh=api('/api/admin/health');await page.getByRole('button',{name:'Refresh',exact:true}).click();expect((await healthRefresh).status()).toBe(200);
   await page.getByRole('main').getByRole('button',{name:'Admin',exact:true}).click();await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
   await page.setViewportSize({width:390,height:844});const mobileUsers=api('/api/admin/users');await page.getByRole('navigation',{name:'Admin sections'}).getByRole('button',{name:'Users',exact:true}).click();expect((await mobileUsers).status()).toBe(200);await page.getByRole('heading',{name:'Users',exact:true}).waitFor();
   await page.waitForFunction(()=>{const input=document.querySelector('input[placeholder="Search by name or email..."]');if(!input)return false;for(let el:Element|null=input;el;el=el.parentElement)if(Number(getComputedStyle(el).opacity)<0.99)return false;return true});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:dir+'/admin-users-mobile.png',fullPage:true});
   expect(errors).toEqual([]);expect(adminFailures).toEqual([]);checks.push('admin browser: all seven sections; user/tracked details and filters; pause/resume; activity refresh; bandwidth windows; cadence/transport read controls; queue/job filters; live-health refresh; mobile navigation; every observed admin response is HTTP 200');
  } finally {await context.close();await pool.query('DELETE FROM tracked_accounts WHERE id=ANY($1::varchar[])',[[accountId,mineId,pendingId]]);}
 },90000);
 it("admin browser creates, edits, disables, enables, resets cooldown and deletes only its fixture bot",async()=>{
  const admin=await register('adminbot');await pool.query("UPDATE users SET role='admin' WHERE id=$1",[admin.id]);
  const username=prefix+'bot',context=await browser.newContext({viewport:{width:1440,height:1000},extraHTTPHeaders:{'x-forwarded-for':'198.51.100.211'}}),page=await context.newPage(),errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addCookies(admin.cookie.split('; ').map(value=>({name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:origin})));
  let botId:string|undefined;
  const mutation=(method:string,path:string)=>page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()===method);
  try {
   await page.goto(origin+'/admin?section=bots');await page.getByRole('button',{name:'Add Bot',exact:true}).click();
   const add=page.getByRole('dialog',{name:'Add Bot Account'});await add.getByLabel('IG Username *').fill(username);await add.getByLabel('Session Data *').fill(JSON.stringify({cookies:[{name:'sessionid',value:'isolated-bot-cookie',domain:'.instagram.com',path:'/'}],origins:[]}));await add.getByLabel('Display Name',{exact:true}).fill('Browser fixture');
   const created=mutation('POST','/api/admin/bots');await add.getByRole('button',{name:'Add Bot',exact:true}).click();const createdResponse=await created;expect(createdResponse.status()).toBe(201);const createdBot=await createdResponse.json();botId=createdBot.id;expect(createdBot).not.toHaveProperty('sessionData');
   expect((await pool.query('SELECT tier,transport FROM bot_accounts WHERE id=$1',[botId])).rows[0]).toEqual({tier:'reserve',transport:'web'});
   expect((await pool.query('SELECT session_data FROM bot_accounts WHERE id=$1',[botId])).rows[0].session_data).toMatch(/^v1:/);
   await page.getByRole('button',{name:'Edit @'+username,exact:true}).click();const edit=page.getByRole('dialog',{name:'Edit Bot: @'+username});await edit.getByLabel('Display Name',{exact:true}).fill('Edited browser fixture');await edit.getByLabel('Max Follows',{exact:true}).fill('7');
   const edited=mutation('PUT','/api/admin/bots/'+botId);await edit.getByRole('button',{name:'Save Changes',exact:true}).click();expect((await edited).status()).toBe(200);
   expect((await pool.query('SELECT display_name,max_follows FROM bot_accounts WHERE id=$1',[botId])).rows[0]).toEqual({display_name:'Edited browser fixture',max_follows:7});
   const row=()=>page.getByRole('row').filter({has:page.getByRole('button',{name:'Edit @'+username,exact:true})});
   const disabled=mutation('POST','/api/admin/bots/'+botId+'/disable');await row().getByTitle('Disable Bot',{exact:true}).click();expect((await disabled).status()).toBe(200);expect((await pool.query('SELECT status FROM bot_accounts WHERE id=$1',[botId])).rows[0].status).toBe('disabled');
   const enabled=mutation('POST','/api/admin/bots/'+botId+'/enable');await row().getByTitle('Enable Bot',{exact:true}).click();expect((await enabled).status()).toBe(200);expect((await pool.query('SELECT status FROM bot_accounts WHERE id=$1',[botId])).rows[0].status).toBe('available');
   await page.getByRole('button',{name:'Edit @'+username,exact:true}).click();await page.getByRole('dialog').getByRole('combobox').click();await page.getByRole('option',{name:'Cooldown',exact:true}).click();const cooled=mutation('PUT','/api/admin/bots/'+botId);await page.getByRole('dialog').getByRole('button',{name:'Save Changes',exact:true}).click();expect((await cooled).status()).toBe(200);
   const reset=mutation('POST','/api/admin/bots/'+botId+'/reset-cooldown');await row().getByTitle('Reset Cooldown',{exact:true}).click();expect((await reset).status()).toBe(200);expect((await pool.query('SELECT status,cooldown_until FROM bot_accounts WHERE id=$1',[botId])).rows[0]).toEqual({status:'available',cooldown_until:null});
   const search=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/bots'&&new URL(r.url()).searchParams.get('search')===username);await page.getByPlaceholder('Search bot username or display name...').fill(username);await page.getByPlaceholder('Search bot username or display name...').press('Enter');expect((await search).status()).toBe(200);
   const filtered=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/bots'&&new URL(r.url()).searchParams.get('status')==='available');await page.getByRole('combobox').first().click();await page.getByRole('option',{name:'Available',exact:true}).click();expect((await filtered).status()).toBe(200);
   await page.getByRole('button',{name:'Delete @'+username,exact:true}).click();await page.getByRole('dialog',{name:'Delete Bot Account'}).getByRole('button',{name:'Cancel',exact:true}).click();expect((await pool.query('SELECT id FROM bot_accounts WHERE id=$1',[botId])).rowCount).toBe(1);
   await page.getByRole('button',{name:'Delete @'+username,exact:true}).click();const deleted=mutation('DELETE','/api/admin/bots/'+botId);await page.getByRole('dialog',{name:'Delete Bot Account'}).getByRole('button',{name:'Delete Bot',exact:true}).click();expect((await deleted).status()).toBe(200);expect((await pool.query('SELECT id FROM bot_accounts WHERE id=$1',[botId])).rowCount).toBe(0);
   expect(errors).toEqual([]);checks.push('admin bot browser: create encrypted reserve fixture, edit, disable/enable, cooldown/reset, search/status filters, dismiss delete, confirm delete with database assertions');
  } finally {await context.close();if(botId)await pool.query('DELETE FROM bot_accounts WHERE id=$1',[botId]);}
 },60000);
 it("monthly report request runs real BullMQ worker, produces downloadable PDF/CSV, delivers notification and honors email opt-out",async()=>{
  fakeSubscription=null;const user=await register('report'),foreign=await register('reportforeign'); await grant(user); await grant(foreign);
  const account=await request('/api/tracking/accounts','POST',{igUsername:prefix+'report'},user.cookie);expect(account.status).toBe(201);
  const {startSafeBackgroundWorkers,stopWorkers}=await import('../../workers.js');
  startSafeBackgroundWorkers();
  try{
   const requested=await request('/api/tracking/accounts/'+account.body.id+'/report/generate','POST',{period:'monthly'},user.cookie);expect(requested.status).toBe(202);
   const reportId=requested.body.reportId;
   await vi.waitFor(async()=>{expect((await pool.query('SELECT status FROM reports WHERE id=$1',[reportId])).rows[0].status).toBe('ready')},{timeout:15000,interval:100});
   await vi.waitFor(()=>expect(mail.send.mock.calls.some((c:any)=>c[0].to===user.email && c[0].subject.includes("report"))).toBe(true),{timeout:10000,interval:100});
   observations.monthlyReportEmailSubject=(mail.send.mock.calls as any).find((c:any)=>c[0].to===user.email && c[0].subject.includes("report"))[0].subject.replace(prefix+'report','fixture_profile');
   const reportMail=(mail.send.mock.calls as any).find((c:any)=>c[0].to===user.email && c[0].subject.includes("report"))[0];
   expect(reportMail.subject).toContain('monthly report'); expect(reportMail.html).toContain('Reporting window (UTC)'); expect(reportMail.html).toContain('Net follower change'); expect(reportMail.html).not.toContain('New followers');
   const notices=await request('/api/notifications','GET',undefined,user.cookie);observations.reportNotificationShape=Array.isArray(notices.body)?'array':Object.keys(notices.body);
   expect((await request('/api/reports/'+reportId+'/pdf','GET',undefined,foreign.cookie)).status).toBe(404);
   const pdf=await fetch(origin+'/api/reports/'+reportId+'/pdf',{headers:{cookie:user.cookie}});expect(pdf.status).toBe(200);expect(pdf.headers.get('cache-control')).toContain('no-store');
   const bytes=Buffer.from(await pdf.arrayBuffer());expect(bytes.subarray(0,4).toString()).toBe('%PDF');await writeFile(dir+'/monthly-report-fixture.pdf',bytes);
   const csv=await request('/api/reports/'+reportId+'/csv','GET',undefined,user.cookie);expect(csv.status).toBe(200);expect(csv.headers.get('content-type')).toContain('text/csv');await writeFile(dir+'/monthly-report-fixture.csv',csv.body);
   await pool.query('UPDATE users SET onboarding_acknowledged_at=now() WHERE id=$1',[user.id]);
   const reportContext=await browser.newContext({viewport:{width:390,height:844}}),reportPage=await reportContext.newPage();
   await reportContext.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   await reportContext.addCookies(user.cookie.split('; ').map(value=>({name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:origin})));
   try {
    await reportPage.goto(origin+'/reports');await reportPage.getByTestId('download-report-'+reportId).waitFor();
    const reject=reportPage.getByRole('button',{name:'Reject analytics',exact:true});if(await reject.isVisible())await reject.click();
    for(const [testId,extension] of [['download-report-'+reportId,'pdf'],['download-report-csv-'+reportId,'csv']]){
     const downloading=reportPage.waitForEvent('download');await reportPage.getByTestId(testId).click();const download=await downloading;expect(await download.failure()).toBeNull();await download.saveAs(dir+'/browser-monthly-report.'+extension);const downloaded=await readFile(dir+'/browser-monthly-report.'+extension);expect(downloaded.length).toBeGreaterThan(0);if(extension==='pdf')expect(downloaded.subarray(0,4).toString()).toBe('%PDF');
    }
    expect(await reportPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await reportPage.screenshot({path:dir+'/reports-mobile.png',fullPage:true});checks.push('mobile reports page downloads actual ready PDF and CSV through browser controls');
   } finally {await reportContext.close();}
   const mailCount=mail.send.mock.calls.filter((c:any)=>c[0].to===user.email && c[0].subject.includes("report")).length;
   expect((await request('/api/account/profile','PUT',{emailAlerts:false},user.cookie)).status).toBe(200);
   const second=await request('/api/tracking/accounts/'+account.body.id+'/report/generate','POST',{period:'weekly'},user.cookie);expect(second.status).toBe(202);
   await vi.waitFor(async()=>expect((await pool.query('SELECT status FROM reports WHERE id=$1',[second.body.reportId])).rows[0].status).toBe('ready'),{timeout:10000,interval:100});
   await vi.waitFor(async()=>expect((await pool.query("SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type='report_ready'",[user.id])).rows[0].n).toBe(2),{timeout:10000,interval:100});
   expect(mail.send.mock.calls.filter((c:any)=>c[0].to===user.email && c[0].subject.includes("report"))).toHaveLength(mailCount);
   const {reportGenerateQueue}=await import('../../workers.js');
   await reportGenerateQueue.pause();
   const queuedId=randomUUID();
   try {
    await pool.query("INSERT INTO reports(id,tracked_account_id,type,status,period_start,period_end) VALUES($1,$2,'weekly','generating',now()-interval '7 days',now())",[queuedId,account.body.id]);
    await reportGenerateQueue.add('fixture-expiring-report',{reportId:queuedId,deliver:true});
    await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 second' WHERE user_id=$1",[user.id]);
   } finally { await reportGenerateQueue.resume(); }
   await vi.waitFor(async()=>expect((await pool.query('SELECT status FROM reports WHERE id=$1',[queuedId])).rows[0].status).toBe('failed'),{timeout:10000,interval:100});
   expect((await request('/api/reports/'+reportId+'/pdf','GET',undefined,user.cookie)).status).toBe(402);
   expect(mail.send.mock.calls.filter((c:any)=>c[0].to===user.email && c[0].subject.includes("report"))).toHaveLength(mailCount);
   checks.push("queued report and prior report download denied after subscription expiry");
   checks.push("actual report queue/worker → ready → offline Chromium PDF/CSV → notification/mail boundary; other-customer denial and email opt-out");
  }finally{await stopWorkers();await(await import('../bandwidth-meter.js')).stopBandwidthMeter()}
 },60000);
});

async function ledgerForUser(userId:string){return(await pool.query('SELECT * FROM billing_retention_offers WHERE user_id=$1',[userId])).rows[0];}

async function finishDialogAnimations(page:import('playwright').Page){
 await page.getByTestId('cancellation-dialog').evaluate(async dialog=>{await Promise.allSettled(dialog.getAnimations({subtree:true}).filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished))});
}
