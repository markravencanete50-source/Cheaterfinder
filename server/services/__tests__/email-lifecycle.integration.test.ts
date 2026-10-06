import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
const url=process.env.BACKEND_FIX_TEST_DATABASE_URL;
if(url){const u=new URL(url);if(u.pathname!=='/cheaterfinder_backend_fix_test_20260907'||u.hostname!=='127.0.0.1'||u.port==='5432'||!(u.port==='55439'||process.env.STRESS_NONCE&&(process.env.STRESS_ALLOWED_PORTS??'').split(',').includes(u.port)))throw Error('Private scratch database required');process.env.DATABASE_URL=url;}
const send=vi.hoisted(()=>vi.fn());
const provider=vi.hoisted(()=>({subscriptions:{retrieve:vi.fn()},invoices:{retrieve:vi.fn()}}));
vi.mock('../email-delivery.js',async original=>({...await original<typeof import('../email-delivery.js')>(),sendApplicationEmail:send}));
vi.mock('stripe',()=>({default:class{constructor(){return provider;}}}));
const userId=randomUUID(),accountId=randomUUID(),reportId=randomUUID();
const invoiceFixture=(intentStatus='requires_action')=>({id:'in_mail_fixture',customer:'cus_mail_fixture',status:'open',attempt_count:1,amount_remaining:3500,
 payments:{has_more:false,data:[{invoice:'in_mail_fixture',is_default:true,status:'open',payment:{type:'payment_intent',payment_intent:{id:'pi_fixture',customer:'cus_mail_fixture',status:intentStatus}}}]}});
(url?describe:describe.skip)('automatic email lifecycle — real isolated PostgreSQL, simulated providers',()=>{
 let pool:typeof import('../../db.js').pool,db:typeof import('../../db.js').db,outbox:typeof import('../transactional-emails.js'),reports:typeof import('../report-delivery.js');
 let future:string;
 const stats={totalLikes:7,totalFollows:0,totalUnfollows:0,peakActivityHour:14,topNiche:null,metrics:{summary:{totalLikes:7,netFollowerChange:null},peakActivityHour:14}} as any;
 beforeAll(async()=>{vi.stubEnv('STRIPE_SECRET_KEY','sk_test_fixture_only');vi.stubEnv('APP_URL','https://cheaterfinder.com');({pool,db}=await import('../../db.js'));outbox=await import('../transactional-emails.js');reports=await import('../report-delivery.js');});
 beforeEach(async()=>{
  vi.resetAllMocks();send.mockResolvedValue('mail_fixture');future=new Date(Date.now()+86_400_000).toISOString();
  await pool.query('DELETE FROM users WHERE id=$1',[userId]);await pool.query("INSERT INTO users(id,name,email) VALUES($1,'Fixture',$2)",[userId,userId+'@example.invalid']);
  await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end,trial_ends_at) VALUES($1,'cus_mail_fixture','sub_mail_fixture','active','standard',$2,$2)",[userId,future]);
  await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,is_active,is_private) VALUES($1,$2,'report_fixture',true,false)",[accountId,userId]);
  await pool.query("INSERT INTO reports(id,tracked_account_id,type,period_start,period_end) VALUES($1,$2,'weekly',now()-interval '7 days',now())",[reportId,accountId]);
  provider.subscriptions.retrieve.mockResolvedValue({id:'sub_mail_fixture',customer:'cus_mail_fixture',metadata:{userId},status:'past_due',latest_invoice:'in_mail_fixture'});
  provider.invoices.retrieve.mockResolvedValue(invoiceFixture());
 });
 afterAll(async()=>{await pool.query('DELETE FROM users WHERE id=$1',[userId]);await pool.end();vi.unstubAllEnvs();});
 const due=()=>pool.query('UPDATE transactional_emails SET next_attempt_at=now() WHERE user_id=$1',[userId]);
 it('commits report readiness + one notification + one intent without needing Redis; repeated generation does not resend',async()=>{
  await reports.persistReadyReport(reportId,stats,true);await reports.persistReadyReport(reportId,stats,true);
  expect((await pool.query('SELECT status FROM reports WHERE id=$1',[reportId])).rows[0].status).toBe('ready');
  expect((await pool.query("SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND type='report_ready'",[userId])).rows[0].n).toBe(1);
  expect((await pool.query("SELECT count(*)::int n FROM transactional_emails WHERE user_id=$1 AND kind='report'",[userId])).rows[0].n).toBe(1);
  expect((await outbox.flushTransactionalEmails()).accepted).toBe(1);expect(send.mock.calls[0][1]).toBe(`email-job:report-email-${reportId}`);
  expect(send.mock.calls[0][0].text).toContain('Observed likes: 7');expect(send.mock.calls[0][0].text).toContain('14:00 UTC');
  await reports.persistReadyReport(reportId,stats,true);await outbox.flushTransactionalEmails();expect(send).toHaveBeenCalledTimes(1);
 });
 it.each(['optout','inactive','private','deleted','expired'] as const)('suppresses queued report after %s before sending',async change=>{
  await reports.persistReadyReport(reportId,stats,true);
  if(change==='optout')await pool.query('UPDATE users SET email_alerts=false WHERE id=$1',[userId]);
  if(change==='inactive')await pool.query('UPDATE tracked_accounts SET is_active=false WHERE id=$1',[accountId]);
  if(change==='private')await pool.query("UPDATE tracked_accounts SET is_private=true,access_status='pending_access' WHERE id=$1",[accountId]);
  if(change==='deleted')await pool.query('DELETE FROM reports WHERE id=$1',[reportId]);
  if(change==='expired')await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 second' WHERE user_id=$1",[userId]);
  expect((await outbox.flushTransactionalEmails()).skipped).toBe(1);expect(send).not.toHaveBeenCalled();
 });
 it('never makes a ready report or intent for private access that is no longer granted',async()=>{
  await pool.query("UPDATE tracked_accounts SET is_private=true,access_status='pending_access' WHERE id=$1",[accountId]);
  await reports.persistReadyReport(reportId,stats,true);expect((await pool.query('SELECT status FROM reports WHERE id=$1',[reportId])).rows[0].status).toBe('failed');
  expect((await pool.query('SELECT count(*)::int n FROM transactional_emails WHERE user_id=$1',[userId])).rows[0].n).toBe(0);
 });
 it('freezes report sender/content and stops ambiguous delivery after the provider retry horizon',async()=>{
  await reports.persistReadyReport(reportId,stats,true);send.mockRejectedValueOnce(Error('response lost'));
  expect((await outbox.flushTransactionalEmails()).failed).toBe(1);await due();
  await pool.query("UPDATE tracked_accounts SET ig_username='changed' WHERE id=$1",[accountId]);
  vi.stubEnv('EMAIL_FROM','Different Name <notifications@cheaterfinder.com>');
  try{expect((await outbox.flushTransactionalEmails()).accepted).toBe(1);expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);}finally{delete process.env.EMAIL_FROM;}
  await pool.query("UPDATE transactional_emails SET accepted_at=NULL,first_attempt_at=now()-interval '24 hours',next_attempt_at=now() WHERE user_id=$1",[userId]);
  await outbox.flushTransactionalEmails();expect(send).toHaveBeenCalledTimes(2);
 });
 it('legacy handoff preserves an ambiguous old send age even if generation created its intent first',async()=>{
  await reports.persistReadyReport(reportId,stats,true);
  await outbox.recordReportEmail(db,userId,reportId,{firstAttemptAt:new Date(Date.now()-24*3600_000),delivery:{to:userId+'@example.invalid',from:'notifications@cheaterfinder.com',subject:'Original',html:'<p>Original</p>'}});
  await outbox.flushTransactionalEmails();expect(send).not.toHaveBeenCalled();
  const row=(await pool.query('SELECT payload,first_attempt_at FROM transactional_emails WHERE id=$1',[outbox.reportEmailKey(reportId)])).rows[0];
  expect(row.payload.delivery.text).toBeUndefined();expect(row.payload.delivery.subject).toBe('Original');expect(row.first_attempt_at.getTime()).toBeLessThan(Date.now()-23*3600_000);
 });
 it('trial reminders are deduped and canceled/expired trials are never sent',async()=>{
  await pool.query("UPDATE subscriptions SET status='trialing' WHERE user_id=$1",[userId]);
  await outbox.recordDueTrialEndingEmails();await outbox.recordDueTrialEndingEmails();
  expect((await pool.query("SELECT count(*)::int n FROM transactional_emails WHERE user_id=$1 AND kind='trial_ending'",[userId])).rows[0].n).toBe(1);
  await pool.query('UPDATE subscriptions SET cancel_at_period_end=true WHERE user_id=$1',[userId]);
  expect((await outbox.flushTransactionalEmails()).skipped).toBe(1);expect(send).not.toHaveBeenCalled();
  await pool.query("UPDATE subscriptions SET cancel_at_period_end=false,trial_ends_at=now()-interval '1 second' WHERE user_id=$1",[userId]);
  await outbox.recordDueTrialEndingEmails();expect((await pool.query("SELECT count(*)::int n FROM transactional_emails WHERE user_id=$1 AND kind='trial_ending'",[userId])).rows[0].n).toBe(1);
 });
 it('sends one current future trial reminder with its actual end date',async()=>{
  await pool.query("UPDATE subscriptions SET status='trialing' WHERE user_id=$1",[userId]);await outbox.recordDueTrialEndingEmails();
  expect((await outbox.flushTransactionalEmails()).accepted).toBe(1);expect(send.mock.calls[0][0].text).toContain('Trial ends (UTC)');
  await outbox.recordDueTrialEndingEmails();await outbox.flushTransactionalEmails();expect(send).toHaveBeenCalledTimes(1);
 });
 it.each([false,true])('dedupes and revalidates current invoice attention (actionRequired=%s)',async actionRequired=>{
  await pool.query("UPDATE subscriptions SET status='past_due' WHERE user_id=$1",[userId]);
  provider.invoices.retrieve.mockResolvedValue(invoiceFixture(actionRequired?'requires_action':'requires_payment_method'));
  const state={subscriptionId:'sub_mail_fixture',customerId:'cus_mail_fixture',invoiceId:'in_mail_fixture',attempt:1,actionRequired};
  await outbox.recordInvoiceEmail(db,userId,state);await outbox.recordInvoiceEmail(db,userId,state);
  expect((await outbox.flushTransactionalEmails()).accepted).toBe(1);expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0].text).toContain('/settings?tab=billing');
  await outbox.flushTransactionalEmails();expect(send).toHaveBeenCalledTimes(1);
 });
 it.each(['paid','replaced','foreign','laterAttempt'] as const)('does not email a %s invoice snapshot',async condition=>{
  await pool.query("UPDATE subscriptions SET status='past_due' WHERE user_id=$1",[userId]);
  const state={subscriptionId:'sub_mail_fixture',customerId:'cus_mail_fixture',invoiceId:'in_mail_fixture',attempt:1,actionRequired:true};await outbox.recordInvoiceEmail(db,userId,state);
  if(condition==='paid')provider.invoices.retrieve.mockResolvedValue({id:state.invoiceId,customer:state.customerId,status:'paid',attempt_count:1});
  if(condition==='replaced')provider.subscriptions.retrieve.mockResolvedValue({customer:state.customerId,metadata:{userId},status:'past_due',latest_invoice:'in_new'});
  if(condition==='foreign')provider.invoices.retrieve.mockResolvedValue({id:state.invoiceId,customer:'cus_elsewhere',status:'open',attempt_count:1});
  if(condition==='laterAttempt')provider.invoices.retrieve.mockResolvedValue({id:state.invoiceId,customer:state.customerId,status:'open',attempt_count:2});
  expect((await outbox.flushTransactionalEmails()).skipped).toBe(1);expect(send).not.toHaveBeenCalled();
 });
 it('a failed invoice lookup stays retryable instead of sending unverified failure mail',async()=>{
  await pool.query("UPDATE subscriptions SET status='past_due' WHERE user_id=$1",[userId]);
  await outbox.recordInvoiceEmail(db,userId,{subscriptionId:'sub_mail_fixture',customerId:'cus_mail_fixture',invoiceId:'in_mail_fixture',attempt:1,actionRequired:true});
  provider.invoices.retrieve.mockRejectedValueOnce(Error('provider unavailable'));
  expect((await outbox.flushTransactionalEmails()).failed).toBe(1);expect(send).not.toHaveBeenCalled();await due();expect((await outbox.flushTransactionalEmails()).accepted).toBe(1);
 });
 it('normalizes explicit Stripe cancel_at in the stored state and the email key',async()=>{
  const stripe=await import('../../stripe.js'),end=Math.floor(Date.now()/1000)+3600;
  await stripe.syncSubscription({id:'sub_mail_fixture',customer:'cus_mail_fixture',metadata:{userId,plan:'standard'},status:'active',cancel_at:end,cancel_at_period_end:false,items:{data:[{price:{id:'price_fixture'},current_period_end:end+86400}]}} as any);
  expect((await outbox.flushTransactionalEmails()).accepted).toBe(1);expect(send.mock.calls[0][0].text).toContain('cancellation is confirmed');
 });
 it.each(['processing','succeeded','requires_payment_method'])('suppresses stale authorization mail after current payment changes to %s',async status=>{
  await pool.query("UPDATE subscriptions SET status='past_due' WHERE user_id=$1",[userId]);
  await outbox.recordInvoiceEmail(db,userId,{subscriptionId:'sub_mail_fixture',customerId:'cus_mail_fixture',invoiceId:'in_mail_fixture',attempt:1,actionRequired:true});
  provider.invoices.retrieve.mockResolvedValue(invoiceFixture(status));expect((await outbox.flushTransactionalEmails()).skipped).toBe(1);expect(send).not.toHaveBeenCalled();
 });
 it('does not retroactively email an already-ready report from an earlier release',async()=>{
  await pool.query("UPDATE reports SET status='ready',metrics=$2::jsonb WHERE id=$1",[reportId,JSON.stringify(stats.metrics)]);
  await reports.persistReadyReport(reportId,stats,true);expect((await pool.query('SELECT count(*)::int n FROM transactional_emails WHERE user_id=$1',[userId])).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM notifications WHERE user_id=$1',[userId])).rows[0].n).toBe(0);
 });
 it.each([false,true])('retention confirmation respects current entitlement (expired=%s)',async expired=>{
  const offerId=randomUUID();await pool.query("INSERT INTO billing_retention_offers(user_id,offer_id,subscription_id,customer_id,state,fingerprint,update_params,currency,amount,regular_amount,trial,expires_at,applied_at) VALUES($1,$2,'sub_mail_fixture','cus_mail_fixture','applied','fixture','{}','usd',1750,3500,false,now(),now())",[userId,offerId]);
  await outbox.recordRetentionEmail(db,userId,offerId);await outbox.recordRetentionEmail(db,userId,offerId);
  if(expired)await pool.query("UPDATE subscriptions SET current_period_end=now()-interval '1 second' WHERE user_id=$1",[userId]);
  const result=await outbox.flushTransactionalEmails();expect(result[expired?'skipped':'accepted']).toBe(1);
  if(expired)expect(send).not.toHaveBeenCalled();else {expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0].text).toContain('$17.50');}
 });
 it('honors a superseded claim that changes while provider-state verification is pending',async()=>{
  await pool.query("UPDATE subscriptions SET status='past_due' WHERE user_id=$1",[userId]);
  await outbox.recordInvoiceEmail(db,userId,{subscriptionId:'sub_mail_fixture',customerId:'cus_mail_fixture',invoiceId:'in_mail_fixture',attempt:1,actionRequired:true});
  let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  provider.invoices.retrieve.mockImplementationOnce(async()=>{entered();await gate;return invoiceFixture();});
  const flushing=outbox.flushTransactionalEmails();await waiting;
  try {await pool.query("UPDATE transactional_emails SET skipped_at=now(),last_error='superseded' WHERE user_id=$1",[userId]);}finally{release();}
  expect((await flushing).skipped).toBe(1);expect(send).not.toHaveBeenCalled();
 });
 it('weekly window and report IDs remain stable across delayed execution and adjacent periods',()=>{
  const end=Date.parse('2026-09-21T00:00:00Z'),window=reports.scheduledWeeklyWindow(end-10_000,end);
  expect(window.periodEnd.getTime()).toBe(end);expect(window.periodEnd.getTime()-window.periodStart.getTime()).toBe(7*86400_000);
  const next=reports.scheduledWeeklyWindow(end+1234,end+7*86400_000);expect(next.periodStart).toEqual(window.periodEnd);
  expect(reports.scheduledReportId(accountId,window.periodEnd)).toBe(reports.scheduledReportId(accountId,new Date(end)));
  expect(reports.scheduledReportId(accountId,next.periodEnd)).not.toBe(reports.scheduledReportId(accountId,window.periodEnd));
 });
});
