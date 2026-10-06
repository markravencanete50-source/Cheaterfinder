import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
const url=process.env.BACKEND_FIX_TEST_DATABASE_URL;
if(url){const u=new URL(url);if(u.pathname!=='/cheaterfinder_backend_fix_test_20260907'||(u.port!=='55439'&&!(process.env.STRESS_NONCE&&u.port!=='5432'&&(process.env.STRESS_ALLOWED_PORTS??'').split(',').includes(u.port)))||u.hostname!=='127.0.0.1')throw Error('Private scratch database required');process.env.DATABASE_URL=url;}
const send=vi.hoisted(()=>vi.fn());
vi.mock('../email-delivery.js',async original=>({...await original<typeof import('../email-delivery.js')>(),sendApplicationEmail:send}));
(url?describe:describe.skip)('durable transactional email delivery',()=>{
 let pool:typeof import('../../db.js').pool,db:typeof import('../../db.js').db,outbox:typeof import('../transactional-emails.js');
 const id=randomUUID();
 beforeAll(async()=>{({pool,db}=await import('../../db.js'));outbox=await import('../transactional-emails.js');});
 beforeEach(async()=>{send.mockReset();send.mockResolvedValue('provider-fixture');await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.query("INSERT INTO users(id,name,email) VALUES($1,'Fixture',$2)",[id,id+'@example.invalid']);});
 afterAll(async()=>{await pool.query('DELETE FROM users WHERE id=$1',[id]);await pool.end();});
 it('rolls back the email with a failed account transaction',async()=>{
  await expect(db.transaction(async tx=>{await outbox.recordWelcomeEmail(tx,id);throw Error('rollback');})).rejects.toThrow('rollback');
  expect((await pool.query('SELECT id FROM transactional_emails WHERE user_id=$1',[id])).rowCount).toBe(0);
 });
 it('deduplicates records, concurrent claims and completed retries',async()=>{
  await Promise.all([outbox.recordWelcomeEmail(db,id),outbox.recordWelcomeEmail(db,id)]);
  expect((await pool.query('SELECT id FROM transactional_emails WHERE user_id=$1',[id])).rowCount).toBe(1);
  await Promise.all([outbox.flushTransactionalEmails(),outbox.flushTransactionalEmails()]);
  expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0].text).toContain('does not start a paid membership');
  await outbox.flushTransactionalEmails();expect(send).toHaveBeenCalledTimes(1);
 });
 it('keeps an unconfirmed send pending and freezes its retry body/key',async()=>{
  await outbox.recordWelcomeEmail(db,id);send.mockRejectedValueOnce(Error('provider down'));
  expect((await outbox.flushTransactionalEmails()).failed).toBe(1);
  expect((await pool.query('SELECT accepted_at FROM transactional_emails WHERE user_id=$1',[id])).rows[0].accepted_at).toBeNull();
  await pool.query("UPDATE transactional_emails SET next_attempt_at=now() WHERE user_id=$1",[id]);
  await pool.query("UPDATE users SET name='Updated name' WHERE id=$1",[id]);
  expect((await outbox.flushTransactionalEmails()).accepted).toBe(1);
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
 });
 it('does not retry an ambiguous send after provider deduplication expires',async()=>{
  await outbox.recordWelcomeEmail(db,id);
  await pool.query("UPDATE transactional_emails SET first_attempt_at=now()-interval '24 hours',attempts=1 WHERE user_id=$1",[id]);
  await outbox.flushTransactionalEmails();expect(send).not.toHaveBeenCalled();
 });
 it('skips a queued trial email when cancellation superseded it',async()=>{
  const state={stripeSubscriptionId:'sub_email_fixture',status:'trialing',plan:'standard',currentPeriodEnd:null,trialEndsAt:new Date(Date.now()+86_400_000).toISOString(),cancelAtPeriodEnd:false};
  await outbox.recordSubscriptionEmail(db,id,state);
  await pool.query("INSERT INTO subscriptions(user_id,status,stripe_subscription_id,plan) VALUES($1,'canceled','sub_email_fixture','standard')",[id]);
  expect((await outbox.flushTransactionalEmails()).skipped).toBe(1);expect(send).not.toHaveBeenCalled();
 });
 it('sends current membership confirmations once and deletes pending mail with the account',async()=>{
  const state={stripeSubscriptionId:'sub_email_fixture',status:'trialing',plan:'standard',currentPeriodEnd:null,trialEndsAt:new Date(Date.now()+86_400_000).toISOString(),cancelAtPeriodEnd:false};
  await pool.query("INSERT INTO subscriptions(user_id,status,stripe_subscription_id,plan,trial_ends_at) VALUES($1,'trialing','sub_email_fixture','standard',$2)",[id,state.trialEndsAt]);
  await outbox.recordSubscriptionEmail(db,id,state);await outbox.recordSubscriptionEmail(db,id,state);
  expect((await outbox.flushTransactionalEmails()).accepted).toBe(1);expect(send.mock.calls[0][0].text).toContain('Your trial starts here');
  await outbox.recordWelcomeEmail(db,id);await pool.query('DELETE FROM users WHERE id=$1',[id]);await outbox.flushTransactionalEmails();expect(send).toHaveBeenCalledTimes(1);
 });
});
