import { currentInvoiceAttention } from "./billing-email-state.js";
import { createHash } from "node:crypto";
import { db, pool } from "../db.js";
import { transactionalEmails } from "../../shared/schema.js";
import { EmailDeliveryError, sendApplicationEmail } from "./email-delivery.js";
import { applicationEmailFrom } from "./email-config.js";
import { subscriptionEmail, welcomeEmail, trialEndingEmail, invoiceAttentionEmail, retentionConfirmedEmail, reportReadyEmail, type BillingEmailState, type ApplicationEmail } from "./email-templates.js";
import { logger } from "../observability/logger.js";
import { customerAccessSql } from "./subscription-access.js";
import { sql } from "drizzle-orm";
import { trialPaymentSummary, pendingTrialPaymentSummary } from "./trial-payment-state.js";

type EmailDatabase = Pick<typeof db, "insert">;
const digest = (key: string) => createHash("sha256").update(key).digest("hex");
export const billingEmailKey = (userId: string, state: BillingEmailState) => digest(`membership:${userId}:${JSON.stringify(state)}`);
export const reportEmailKey = (reportId: string) => digest(`report:${reportId}`);
export type InvoiceEmailState = { subscriptionId: string; customerId: string; invoiceId: string; attempt: number; actionRequired: boolean };
type Delivery = Omit<ApplicationEmail,"text"> & { to: string; from: string; text?: string };

export async function recordWelcomeEmail(database: EmailDatabase, userId: string): Promise<void> {
  await database.insert(transactionalEmails).values({ id:digest(`welcome:${userId}`), userId,kind:"welcome",payload:{} }).onConflictDoNothing();
}

export async function recordSubscriptionEmail(database: EmailDatabase, userId: string, state: BillingEmailState): Promise<void> {
  await database.insert(transactionalEmails).values({id:billingEmailKey(userId,state),userId,kind:"membership",payload:{state},
    // Allow the invoice event to provide the actionable message instead of
    // immediately sending a second generic past-due status email.
    ...(state.status==="past_due" && !state.cancelAtPeriodEnd ? {nextAttemptAt:new Date(Date.now()+60_000)} : {})}).onConflictDoNothing();
}

export async function recordTrialEndingEmail(database: EmailDatabase, userId: string, subscriptionId: string, trialEndsAt: string): Promise<void> {
  await database.insert(transactionalEmails).values({ id:digest(`trial-ending:${userId}:${subscriptionId}:${trialEndsAt}`), userId,
    kind:"trial_ending",payload:{subscriptionId,trialEndsAt} }).onConflictDoNothing();
}

export async function recordInvoiceEmail(database: EmailDatabase, userId: string, state: InvoiceEmailState): Promise<void> {
  const kind = state.actionRequired ? "payment_action_required" : "payment_failed";
  await database.insert(transactionalEmails).values({ id:digest(`${kind}:${userId}:${state.invoiceId}:${state.attempt}`), userId, kind, payload:state }).onConflictDoNothing();
}

export async function recordRetentionEmail(database: EmailDatabase, userId: string, offerId: string): Promise<void> {
  await database.insert(transactionalEmails).values({ id:digest(`retention:${userId}:${offerId}`), userId, kind:"retention",payload:{offerId} }).onConflictDoNothing();
}

/** Called in the report-ready transaction. Redis is only a wake-up signal. */
export async function recordReportEmail(database: Pick<typeof db,"insert"|"execute">, userId: string, reportId: string,
  legacy?: { delivery: Delivery; firstAttemptAt?: Date }): Promise<string> {
  const id = reportEmailKey(reportId);
  await database.insert(transactionalEmails).values({ id,userId,kind:"report",payload:{reportId,...(legacy ? {delivery:legacy.delivery} : {})},
    ...(legacy?.firstAttemptAt ? {firstAttemptAt:legacy.firstAttemptAt} : {}) }).onConflictDoNothing();
  if (legacy) {
    // A retry of generation can create an intent before an old Redis send is
    // imported. Never reset that send's age or replace an attempted payload.
    const delivery = JSON.stringify(legacy.delivery);
    await database.execute(sql`UPDATE transactional_emails SET
      first_attempt_at=CASE WHEN ${legacy.firstAttemptAt ?? null}::timestamptz IS NULL THEN first_attempt_at
        ELSE LEAST(COALESCE(first_attempt_at,${legacy.firstAttemptAt ?? null}::timestamptz),${legacy.firstAttemptAt ?? null}::timestamptz) END,
      payload=CASE WHEN attempts=0 AND NOT (payload ? 'delivery') THEN jsonb_set(payload,'{delivery}',${delivery}::jsonb) ELSE payload END,
      skipped_at=CASE WHEN payload ? 'delivery' AND payload->'delivery' IS DISTINCT FROM ${delivery}::jsonb THEN now() ELSE skipped_at END,
      last_error=CASE WHEN payload ? 'delivery' AND payload->'delivery' IS DISTINCT FROM ${delivery}::jsonb THEN 'legacy_delivery_conflict' ELSE last_error END
      WHERE id=${id} AND user_id=${userId} AND accepted_at IS NULL AND skipped_at IS NULL`);
  }
  return id;
}

/** Only current, future renewals qualify; no historical welcome or failure replay. */
export async function recordDueTrialEndingEmails(): Promise<void> {
  const {rows} = await pool.query(`SELECT s.user_id,s.stripe_subscription_id,s.trial_ends_at FROM subscriptions s
    WHERE s.status='trialing' AND s.cancel_at_period_end=false AND s.trial_ends_at>now()
      AND s.trial_ends_at<=now()+interval '3 days' AND left(s.stripe_subscription_id,4)='sub_'
      AND left(s.stripe_customer_id,4)='cus_'
      AND NOT EXISTS(SELECT 1 FROM transactional_emails e WHERE e.user_id=s.user_id AND e.kind='trial_ending'
        AND e.payload->>'subscriptionId'=s.stripe_subscription_id AND (e.payload->>'trialEndsAt')::timestamptz=s.trial_ends_at)
    ORDER BY s.trial_ends_at LIMIT 50`);
  for (const row of rows) await recordTrialEndingEmail(db,row.user_id,row.stripe_subscription_id,row.trial_ends_at.toISOString());
}

/** Re-read Stripe's current invoice at delivery time, not just an old webhook. */
async function invoiceStillNeedsAttention(state: InvoiceEmailState, userId: string): Promise<boolean> {
  const local = (await pool.query("SELECT stripe_subscription_id,stripe_customer_id,status FROM subscriptions WHERE user_id=$1",[userId])).rows[0];
  if (!local || local.stripe_subscription_id!==state.subscriptionId || local.stripe_customer_id!==state.customerId || local.status!=="past_due") return false;
  const { stripe } = await import("../stripe.js");
  if (!stripe) throw new EmailDeliveryError("billing_unavailable");
  const options = {timeout:15_000,maxNetworkRetries:0};
  const current = await stripe.subscriptions.retrieve(state.subscriptionId,{},options);
  const customer = typeof current.customer === "string" ? current.customer : current.customer.id;
  const latest = typeof current.latest_invoice === "string" ? current.latest_invoice : current.latest_invoice?.id;
  if (customer!==state.customerId || (current.metadata.userId && current.metadata.userId!==userId) ||
    latest!==state.invoiceId || !["past_due","unpaid","incomplete"].includes(current.status)) return false;
  const invoice = await stripe.invoices.retrieve(state.invoiceId,{expand:["payments.data.payment.payment_intent"]},options);
  const invoiceCustomer = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  return invoice.id===state.invoiceId && invoiceCustomer===state.customerId && invoice.status==="open" && invoice.attempt_count===state.attempt &&
    currentInvoiceAttention(invoice)===(state.actionRequired?"action_required":"payment_failed");
}

function billingState(sub: Record<string,any>): BillingEmailState {
  const trialPayment = trialPaymentSummary(sub.payment_amount == null ? undefined : {
    amount: sub.payment_amount, currency: sub.payment_currency, state: sub.payment_state, cancellation_policy: sub.payment_cancellation_policy }) ??
    pendingTrialPaymentSummary(sub.trial_payment_policy, sub.trial_cancellation_policy);
  return {stripeSubscriptionId:sub.stripe_subscription_id,status:sub.status,plan:sub.plan,
    currentPeriodEnd:sub.current_period_end?.toISOString() ?? null,trialEndsAt:sub.trial_ends_at?.toISOString() ?? null,cancelAtPeriodEnd:sub.cancel_at_period_end,
    ...(trialPayment ? { trialPayment } : {})};
}

async function currentEmail(row: {id:string;user_id:string;kind:string;payload:any}, recipient: {name:string;email:string}): Promise<ApplicationEmail | null> {
  const payload = row.payload;
  if (row.kind==="welcome") return welcomeEmail(recipient.name);
  if (row.kind==="membership" || row.kind==="trial_ending") {
    const sub = (await pool.query(`SELECT s.stripe_subscription_id,s.status,s.plan,s.current_period_end,s.trial_ends_at,s.cancel_at_period_end,s.trial_payment_policy,s.trial_cancellation_policy,
      p.amount AS payment_amount,p.currency AS payment_currency,p.state AS payment_state,p.cancellation_policy AS payment_cancellation_policy
      FROM subscriptions s LEFT JOIN billing_trial_payments p ON p.user_id=s.user_id AND p.subscription_id=s.stripe_subscription_id
      WHERE s.user_id=$1`,[row.user_id])).rows[0];
    if (!sub) return null;
    const actual = billingState(sub);
    if (row.kind==="trial_ending") {
      const end = actual.trialEndsAt ? new Date(actual.trialEndsAt).getTime() : 0;
      if (actual.status!=="trialing" || actual.cancelAtPeriodEnd || actual.stripeSubscriptionId!==payload.subscriptionId ||
        actual.trialEndsAt!==payload.trialEndsAt || end<=Date.now() || end>Date.now()+3*86_400_000) return null;
      return trialEndingEmail(recipient.name,actual.trialEndsAt!);
    }
    if (!payload.state || billingEmailKey(row.user_id,actual)!==row.id) return null;
    if (actual.status==="past_due" && !actual.cancelAtPeriodEnd) {
      const attention=(await pool.query(`SELECT 1 FROM transactional_emails e
        WHERE e.user_id=$1 AND e.kind IN ('payment_failed','payment_action_required') AND e.skipped_at IS NULL
          AND e.payload->>'subscriptionId'=$2
          AND e.created_at>=(SELECT created_at FROM transactional_emails WHERE id=$3)-interval '2 minutes' LIMIT 1`,
        [row.user_id,actual.stripeSubscriptionId,row.id])).rowCount;
      if (attention) return null;
    }
    if (actual.status==="trialing" && (!actual.trialEndsAt || new Date(actual.trialEndsAt).getTime()<=Date.now())) return null;
    if (actual.status==="active" && (!actual.currentPeriodEnd || new Date(actual.currentPeriodEnd).getTime()<=Date.now())) return null;
    return subscriptionEmail(recipient.name,actual);
  }
  if (row.kind==="payment_failed" || row.kind==="payment_action_required") {
    return await invoiceStillNeedsAttention(payload,row.user_id) ? invoiceAttentionEmail(recipient.name,row.kind==="payment_action_required") : null;
  }
  if (row.kind==="retention") {
    const offer = (await pool.query(`SELECT o.amount,o.regular_amount,o.regular_invoice_total,o.offer_credit_applied,o.currency,o.trial FROM billing_retention_offers o
      JOIN subscriptions s ON s.user_id=o.user_id AND s.stripe_subscription_id=o.subscription_id
      WHERE o.user_id=$1 AND o.offer_id=$2 AND o.state='applied' AND NOT s.cancel_at_period_end
        AND ((s.status='trialing' AND s.trial_ends_at>now()) OR (s.status='active' AND s.current_period_end>now()))`,[row.user_id,payload.offerId])).rows[0];
    return offer ? retentionConfirmedEmail(recipient.name,{amount:offer.amount,regularAmount:offer.regular_amount,
      recurringAmount:offer.regular_invoice_total ?? offer.regular_amount,
      creditApplied:offer.offer_credit_applied ?? 0,currency:offer.currency,trial:offer.trial}) : null;
  }
  if (row.kind==="report") {
    const rows = await db.execute(sql`SELECT r.type,r.metrics,r.period_start,r.period_end,t.ig_username FROM reports r
      JOIN tracked_accounts t ON t.id=r.tracked_account_id JOIN users u ON u.id=t.user_id
      WHERE r.id=${payload.reportId} AND t.user_id=${row.user_id} AND r.status='ready' AND t.is_active
        AND (NOT t.is_private OR t.access_status='has_access') AND u.email_alerts
        AND ${customerAccessSql(sql`t.user_id`)}
        AND NOT EXISTS (SELECT 1 FROM subscriptions preview WHERE preview.user_id=t.user_id AND preview.status='trialing')`);
    const report = (rows as unknown as {rows:Array<any>}).rows[0];
    const summary = report?.metrics?.summary;
    if (!report || !summary || !Number.isFinite(summary.totalLikes)) return null;
    const hour = report.metrics.peakActivityHour;
    return reportReadyEmail({name:recipient.name,username:report.ig_username,period:report.type,
      netFollowerChange:summary.netFollowerChange ?? null,observedLikes:summary.totalLikes,
      periodStart:new Date(report.period_start).toISOString(),periodEnd:new Date(report.period_end).toISOString(),
      peakHour:Number.isInteger(hour) ? `${String(hour).padStart(2,"0")}:00 UTC` : null});
  }
  return null;
}

/** Claims are short DB statements. Network calls hold no DB transaction open.
 * Six bounded retries fit within Resend's 24h idempotency retention. Ambiguous
 * deliveries older than 23h remain visible for operator review, never resent.
 */
export async function flushTransactionalEmails(limit = 5, onlyId?: string): Promise<{accepted:number;skipped:number;failed:number}> {
  const summary = {accepted:0,skipped:0,failed:0};
  const { rows } = await pool.query(`
    WITH due AS (
      SELECT id FROM transactional_emails
      WHERE accepted_at IS NULL AND skipped_at IS NULL AND next_attempt_at <= now()
        AND attempts < 6 AND (first_attempt_at IS NULL OR first_attempt_at > now() - interval '23 hours')
        AND ($2::varchar IS NULL OR id=$2)
      ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED
    )
    UPDATE transactional_emails e SET attempts=e.attempts+1,
      first_attempt_at=COALESCE(e.first_attempt_at,now()),
      next_attempt_at=now() + interval '5 minutes' * power(2,e.attempts)
    FROM due WHERE e.id=due.id RETURNING e.id,e.user_id,e.kind,e.payload`, [Math.min(5,Math.max(1,limit)),onlyId ?? null]);
  for(const row of rows) {
    try {
      const recipient = (await pool.query("SELECT name,email FROM users WHERE id=$1",[row.user_id])).rows[0];
      const body = recipient && (!row.payload.delivery || row.payload.delivery.to===recipient.email) ? await currentEmail(row,recipient) : null;
      if(!body) {
        await pool.query("UPDATE transactional_emails SET skipped_at=now(),last_error='superseded' WHERE id=$1",[row.id]);
        summary.skipped++;continue;
      }
      // Freeze recipient, sender and body, including report jobs. Regenerating
      // content with the same provider key would break safe retry semantics.
      const message: Delivery = row.payload.delivery ?? {to:recipient.email,from:applicationEmailFrom(),...body};
      const frozen = await pool.query(`UPDATE transactional_emails
        SET payload=jsonb_set(payload,'{delivery}',$2::jsonb)
        WHERE id=$1 AND accepted_at IS NULL AND skipped_at IS NULL
          AND first_attempt_at>now()-interval '23 hours' AND payload=$3::jsonb RETURNING id`,
        [row.id,JSON.stringify(message),JSON.stringify(row.payload)]);
      // A concurrent legacy import or operator reconciliation can supersede a
      // claim while rendering/provider validation awaits. Re-check before I/O.
      if (!frozen.rowCount) { summary.skipped++;continue; }
      // Preserve the existing report queue key during rollout.
      const key = row.kind==="report" ? `email-job:report-email-${row.payload.reportId}` : `transactional:${row.id}`;
      const providerId = await sendApplicationEmail(message,key);
      await pool.query("UPDATE transactional_emails SET accepted_at=now(),provider_id=$2,last_error=NULL WHERE id=$1",[row.id,providerId]);
      summary.accepted++;
    } catch(error) {
      const code = error instanceof EmailDeliveryError ? error.code : "delivery_unconfirmed";
      await pool.query("UPDATE transactional_emails SET last_error=$2 WHERE id=$1",[row.id,code]);
      logger.warn({emailId:row.id,code},"transactional email acceptance unconfirmed; bounded retry scheduled");
      summary.failed++;
    }
  }
  return summary;
}
