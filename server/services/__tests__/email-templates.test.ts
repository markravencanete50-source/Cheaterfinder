import { afterEach, describe, expect, it, vi } from "vitest";
import { welcomeEmail, passwordResetEmail, subscriptionEmail, reportReadyEmail, trialEndingEmail, invoiceAttentionEmail, retentionConfirmedEmail, type BillingEmailState } from "../email-templates.js";
const state: BillingEmailState = {stripeSubscriptionId:"sub_fixture",status:"trialing",plan:"standard",currentPeriodEnd:"2026-09-25T12:00:00.000Z",trialEndsAt:"2026-09-25T12:00:00.000Z",cancelAtPeriodEnd:false};
afterEach(()=>vi.unstubAllEnvs());
describe("transactional email content",()=>{
 it("escapes names and profiles while providing actionable plain text",()=>{
  const mail=reportReadyEmail({name:'<script>bad()</script>',username:'x"><img src=x>',period:"weekly",netFollowerChange:null,observedLikes:0});
  expect(mail.html).not.toContain('<script>');expect(mail.html).not.toContain('<img src=x>');
  expect(mail.html).toContain('Unavailable');expect(mail.text).toContain('https://cheaterfinder.com/reports');
  expect(mail.text).toContain('Unavailable data does not mean there was no activity');
 });
 it("never claims signup started a trial or charged a membership",()=>{
  expect(welcomeEmail("Khalid").text).toContain('does not start a paid membership');
  expect(welcomeEmail("Khalid").text).not.toContain('$0');
 });
 it("uses actual trial dates without assuming every trial has no upfront payment",()=>{
  const trial=subscriptionEmail("Khalid",state);expect(trial.text).toContain('Starts after your trial');expect(trial.text).not.toContain('No membership charge');expect(trial.text).toContain('25 September 2026');expect(trial.text).toContain('starts automatically');
  for(const status of ['active','past_due','canceled'])expect(subscriptionEmail('Khalid',{...state,status}).text).not.toContain('$0');
  const cancel=subscriptionEmail('Khalid',{...state,cancelAtPeriodEnd:true});expect(cancel.text).toContain('will not renew');expect(cancel.text).not.toContain('$0');
 });
 it("describes a confirmed 99-cent advance as issued credit, not a monthly payment or available balance",()=>{
  const mail=subscriptionEmail('Fixture',{...state,trialPayment:{amount:99,currency:'usd',creditStatus:'credited',cancellationPolicy:'retain_credit'}});
  expect(mail.text).toContain('Advance payment: $0.99');expect(mail.text).toContain('Invoice credit: $0.99 issued once');
  expect(mail.text).toContain('may already have been applied');expect(mail.text).toContain('not automatically refunded');
  expect(mail.text).not.toContain('No membership charge');expect(mail.text).not.toContain('available credit');
 });
 it("does not announce trial access or a successful payment while advance confirmation is pending",()=>{
  const mail=subscriptionEmail('Fixture',{...state,trialPayment:{amount:99,currency:'usd',creditStatus:'pending',cancellationPolicy:'refund_during_trial'}});
  expect(mail.text).toContain('still processing');expect(mail.text).toContain('Confirmation pending');
  expect(mail.text).not.toContain('You can now add a profile');expect(mail.text).not.toContain('$0.99 issued');
 });
 it("keeps confirmed refund and credited advance states distinct",()=>{
  const mail=subscriptionEmail('Fixture',{...state,status:'canceled',trialPayment:{amount:99,currency:'usd',creditStatus:'refunded',cancellationPolicy:'refund_during_trial'}});
  expect(mail.text).toContain('Advance refund: $0.99 confirmed');expect(mail.text).toContain('no longer available as invoice credit');
  expect(mail.text).not.toContain('Invoice credit:');
 });
 it("rejects invalid advance amounts instead of sending an incorrect receipt",()=>{
  for (const amount of [0,-99,0.99,NaN]) expect(()=>subscriptionEmail('Fixture',{...state,trialPayment:{amount,currency:'usd',creditStatus:'credited',cancellationPolicy:'retain_credit'}})).toThrow('Invalid advance');
 });
 it("uses only the configured origin for reset links, keeps expiry and the app handoff",()=>{
  vi.stubEnv('APP_URL','https://cheaterfinder.com/');const mail=passwordResetEmail('Khalid','a'.repeat(64));
  expect(mail.html).toContain('https://cheaterfinder.com/reset-password?token='+ 'a'.repeat(64));
  expect(mail.text).toContain('/app/reset-password?token=');expect(mail.text).toContain('1 hour and works once');
  vi.stubEnv('APP_URL','javascript:alert(1)');expect(()=>welcomeEmail('Khalid')).toThrow();
 });
});


describe("production email links and lifecycle copy",()=>{
 it("requires HTTPS on the production domain and rejects escaping CTA paths",async()=>{
  const {emailAppUrl}=await import('../email-config.js');vi.stubEnv('NODE_ENV','production');
  for(const origin of ['http://cheaterfinder.com','https://localhost','https://127.0.0.1','https://cheaterfinder.com.attacker.test','https://user:secret@cheaterfinder.com','https://cheaterfinder.com:444']) {
   vi.stubEnv('APP_URL',origin);expect(()=>emailAppUrl('/settings')).toThrow();
  }
  vi.stubEnv('APP_URL','https://cheaterfinder.com');
  for(const path of ['//elsewhere.test/a','https://elsewhere.test','/\\elsewhere.test'])expect(()=>emailAppUrl(path)).toThrow();
  expect(emailAppUrl('/settings?tab=billing')).toBe('https://cheaterfinder.com/settings?tab=billing');
 });
 it("puts every template link on the production origin and makes billing actions direct",()=>{
  vi.stubEnv('NODE_ENV','production');vi.stubEnv('APP_URL','https://cheaterfinder.com');
  const billing=[subscriptionEmail('Fixture',{...state,status:'past_due'}),trialEndingEmail('Fixture',state.trialEndsAt!),invoiceAttentionEmail('Fixture',true),invoiceAttentionEmail('Fixture',false),retentionConfirmedEmail('Fixture',{amount:1750,regularAmount:3500,currency:'usd',trial:true})];
  for(const email of [...billing,welcomeEmail('Fixture'),passwordResetEmail('Fixture','a'.repeat(64)),reportReadyEmail({name:'Fixture',username:'fixture',period:'weekly',netFollowerChange:null,observedLikes:7})]) {
   for(const match of email.html.matchAll(/href="([^"]+)"/g))expect(new URL(match[1].replaceAll('&amp;','&')).origin).toBe('https://cheaterfinder.com');
   expect(email.text.length).toBeGreaterThan(100);expect(email.html).not.toContain('localhost');
  }
  for(const email of billing)expect(email.text).toContain('/settings?tab=billing');
 });
 it("formats one-time offer estimates correctly for zero/three decimal currencies",()=>{
  const jpy=retentionConfirmedEmail('Fixture',{amount:500,regularAmount:1000,currency:'jpy',trial:false});expect(jpy.text).toContain('¥500');
  const kwd=retentionConfirmedEmail('Fixture',{amount:1250,regularAmount:2500,currency:'kwd',trial:true});expect(kwd.text).toContain('1.250');expect(kwd.text).toContain('first paid month');expect(kwd.text).toContain('one-time');
 });
 it("keeps a one-time balance credit separate from the later recurring price",()=>{
  const mail=retentionConfirmedEmail('Fixture',{amount:901,regularAmount:1900,recurringAmount:1999,creditApplied:99,currency:'usd',trial:true});
  expect(mail.text).toContain('Estimated next monthly invoice: $9.01');
  expect(mail.text).toContain('Estimated regular monthly invoice: $19.99');
  expect(mail.text).toContain('Balance credit in estimate: $0.99');
 });
 it("confirms cancellation without promising active access on an unpaid account",()=>{
  const email=subscriptionEmail('Fixture',{...state,status:'past_due',cancelAtPeriodEnd:true});
  expect(email.text).toContain('cancellation is confirmed');expect(email.text).toContain('outstanding invoice');expect(email.text).not.toContain('remains available until');
 });
 it("uses one branded sender and rejects unverified production domains and header injection",async()=>{
  const {applicationEmailFrom}=await import('../email-config.js');vi.stubEnv('NODE_ENV','production');delete process.env.EMAIL_FROM;
  expect(applicationEmailFrom()).toBe('CheaterFinder <notifications@cheaterfinder.com>');
  for(const from of ['Test <sender@example.invalid>','bad\r\nBcc:x@example.invalid','broken@cheaterfinder.com>']){vi.stubEnv('EMAIL_FROM',from);expect(applicationEmailFrom).toThrow();}
 });
});
