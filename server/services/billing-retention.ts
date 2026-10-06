import { recordRetentionEmail, recordSubscriptionEmail } from "./transactional-emails.js";
import { createHash, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { resultRows } from "./operation-lease.js";
import { requireBillingUser, withCustomerBillingLock, type BillingDatabase } from "./customer-billing-lifecycle.js";
import { reconcileTrialPaymentCredit, reconcileTrialPaymentCancellation } from "./trial-payment-credit.js";
import { readTrialPaymentSummary, pendingTrialPaymentSummary } from "./trial-payment-state.js";
import { TRIAL_PAYMENT_POLICY } from "../../shared/trial-payment.js";
import { logger } from "../observability/logger.js";

const COUPON_ID = "cheaterfinder_retention_50_once_v1";
const request = { timeout: 15_000, maxNetworkRetries: 1 } as const;
export class RetentionError extends Error {}
type OfferRow = {
  user_id: string; offer_id: string; subscription_id: string; customer_id: string;
  state: "quoted" | "pending" | "applied"; fingerprint: string;
  update_params: Stripe.SubscriptionUpdateParams; currency: string; amount: number;
  regular_amount: number; regular_invoice_total: number | null; offer_credit_applied: number | null; trial: boolean; expires_at: Date; requested_at: Date | null;
};
type LocalSubscription = { stripe_subscription_id: string; stripe_customer_id: string };

async function localSubscription(executor: BillingDatabase, userId: string) {
  await requireBillingUser(userId, executor);
  const local = resultRows<LocalSubscription>(await executor.execute(sql`
    SELECT stripe_subscription_id,stripe_customer_id FROM subscriptions WHERE user_id=${userId}`))[0];
  if (!local?.stripe_subscription_id || !local.stripe_customer_id) throw new RetentionError("No subscription found.");
  return local;
}

function verifyOwner(sub: Stripe.Subscription, local: LocalSubscription, userId: string) {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  if (sub.id !== local.stripe_subscription_id || customer !== local.stripe_customer_id ||
    (sub.metadata.userId && sub.metadata.userId !== userId)) throw new RetentionError("Billing ownership could not be verified. Please contact support.");
}

export function retentionFingerprint(sub: Stripe.Subscription): string {
  return createHash("sha256").update(JSON.stringify({
    id: sub.id, status: sub.status, trialEnd: sub.trial_end,
    cancel: sub.cancel_at_period_end, cancelAt: sub.cancel_at, schedule: sub.schedule,
    collection: sub.collection_method, pause: sub.pause_collection, pendingUpdate: sub.pending_update,
    items: sub.items.data.map(item => ({ id: item.id, price: item.price.id, quantity: item.quantity, end: item.current_period_end })),
    discounts: sub.discounts.map(d => typeof d === "string" ? d : d.id),
  })).digest("hex");
}

export function retentionEligible(sub: Stripe.Subscription): boolean {
  const item = sub.items.data[0];
  return ["trialing", "active"].includes(sub.status) && !sub.cancel_at_period_end && !sub.cancel_at &&
    !sub.schedule && !sub.pause_collection && !sub.pending_update && !sub.metadata.retentionOfferId &&
    sub.collection_method === "charge_automatically" && !sub.items.has_more && sub.items.data.length === 1 &&
    item.quantity === 1 && item.price.recurring?.interval === "month" && item.price.recurring.interval_count === 1 &&
    item.price.recurring.usage_type === "licensed" && !item.discounts?.length && sub.discounts.length < 20;
}

async function ensureCoupon(api: Stripe): Promise<void> {
  let coupon: Stripe.Coupon;
  try { coupon = await api.coupons.retrieve(COUPON_ID, { expand: ["applies_to"] }, request); }
  catch (error) {
    if ((error as { code?: string }).code !== "resource_missing") throw error;
    try {
      coupon = await api.coupons.create({ id: COUPON_ID, name: "50% off one monthly payment", percent_off: 50, duration: "once" },
        { ...request, idempotencyKey: COUPON_ID });
    } catch (creationError) {
      // Another customer can provision the same deterministic coupon first.
      if ((creationError as { code?: string }).code !== "resource_already_exists") throw creationError;
      coupon = await api.coupons.retrieve(COUPON_ID, { expand: ["applies_to"] }, request);
    }
  }
  if (!coupon.valid || coupon.percent_off !== 50 || coupon.duration !== "once" || coupon.applies_to ||
    coupon.max_redemptions || coupon.redeem_by) throw new RetentionError("This offer is currently unavailable. You can still cancel.");
}

function publicOffer(row: OfferRow) {
  return { eligible: true as const, offerId: row.offer_id, amount: row.amount, regularAmount: row.regular_amount,
    recurringAmount: row.regular_invoice_total ?? row.regular_amount,
    creditApplied: row.offer_credit_applied ?? 0,
    currency: row.currency, trial: row.trial,
    // Pending means the customer already accepted; allow reconciliation even
    // after the quote expired. The write path enforces the provider retry window.
    expiresAt: new Date(row.state === "pending" ? Date.now() + 15 * 60_000 : row.expires_at).toISOString() };
}

function monthlyPreview(invoice: Stripe.Invoice, sub: Stripe.Subscription): boolean {
  const item = sub.items.data[0], line = invoice.lines?.data[0];
  const details = line?.parent?.subscription_item_details;
  const price = line?.pricing?.price_details?.price;
  return !!line && invoice.lines.has_more === false && invoice.lines.data.length === 1 &&
    line.parent?.type === "subscription_item_details" && details?.subscription_item === item.id &&
    details.subscription === sub.id && details.proration === false && line.quantity === 1 &&
    (typeof price === "string" ? price : price?.id) === item.price.id &&
    line.period.end > line.period.start && (!sub.trial_end || line.period.start >= sub.trial_end);
}

async function previewOffer(api: Stripe, sub: Stripe.Subscription, customer: string, discounts: Stripe.SubscriptionUpdateParams["discounts"]) {
  // Both estimates describe the SAME next invoice. Recurring preview mode
  // excludes once coupons and does not support trial subscriptions.
  const regular = await api.invoices.createPreview({ customer, subscription: sub.id, preview_mode: "next" }, request);
  const preview = await api.invoices.createPreview({ customer, subscription: sub.id, discounts, preview_mode: "next" }, request);
  const existingDiscountIds = new Set(sub.discounts.map(d => typeof d === "string" ? d : d.id));
  // A customer-level discount can be inherited by the original invoice. Do
  // not replace it silently with a new subscription discount and call the
  // smaller effective reduction "50%".
  if (regular.discounts.some(d => !existingDiscountIds.has(typeof d === "string" ? d : d.id))) return null;
  if (!monthlyPreview(regular, sub) || !monthlyPreview(preview, sub) ||
    regular.lines.data[0].period.start !== preview.lines.data[0].period.start ||
    regular.lines.data[0].period.end !== preview.lines.data[0].period.end ||
    preview.currency !== regular.currency || !Number.isSafeInteger(preview.total) || preview.total < 0 ||
    !Number.isSafeInteger(regular.total) || regular.total <= 0 || preview.total >= regular.total ||
    !Number.isSafeInteger(preview.amount_due) || preview.amount_due < 0 ||
    !Number.isSafeInteger(regular.amount_due) || regular.amount_due <= 0 || preview.amount_due >= regular.amount_due) return null;
  // Stripe applies invoice discounts before the customer's invoice balance.
  // Quote the actual payable amounts and revalidate them again on acceptance.
  return { amount: preview.amount_due, regularAmount: regular.amount_due, recurringAmount: regular.total,
    creditApplied: Math.max(0, preview.total - preview.amount_due), currency: preview.currency };
}

/** Called only when a customer opens cancellation. Quotes never alter a subscription. */
export async function quoteRetentionOffer(api: Stripe, userId: string) {
  // A slow optional quote must never hold the cancellation/deletion lock.
  // Conditional ledger writes below cannot overwrite an accepted offer, and
  // acceptance revalidates ownership, subscription state and invoice amount.
  return withCustomerBillingLock(`retention-quote:${userId}`, async executor => {
    const local = await localSubscription(executor, userId);
    const previous = resultRows<OfferRow>(await executor.execute(sql`SELECT * FROM billing_retention_offers WHERE user_id=${userId}`))[0];
    if (previous?.state === "applied") return { eligible: false as const, reason: "This account has already used its one-time offer." };
    if (previous?.state === "pending") return publicOffer(previous);
    const sub = await api.subscriptions.retrieve(local.stripe_subscription_id, { expand: ["discounts"] }, request);
    verifyOwner(sub, local, userId);
    if (!retentionEligible(sub)) return { eligible: false as const, reason: "A one-time monthly offer is not available for this subscription." };
    // Preserve every existing discount, in order. A temporary discount or an
    // unexpanded reference cannot support a reliable regular-price promise.
    for (const discount of sub.discounts) {
      if (typeof discount === "string") return { eligible: false as const, reason: "Your existing discount needs review in billing." };
      const source = discount.source.coupon;
      const coupon = typeof source === "string" ? await api.coupons.retrieve(source, {}, request) : source;
      if (!coupon || coupon.duration !== "forever") return { eligible: false as const, reason: "Another limited-time offer is already active." };
    }
    await ensureCoupon(api);
    const discounts = [...sub.discounts.map(d => ({ discount: typeof d === "string" ? d : d.id })), { coupon: COUPON_ID }];
    const preview = await previewOffer(api, sub, local.stripe_customer_id, discounts);
    if (!preview) {
      return { eligible: false as const, reason: "We could not verify the offer amount. You can still cancel or open billing." };
    }
    const offerId = randomUUID(), expiresAt = new Date(Date.now() + 15 * 60_000);
    const params: Stripe.SubscriptionUpdateParams = { discounts, proration_behavior: "none", metadata: { retentionOfferId: offerId } };
    const row = resultRows<OfferRow>(await executor.execute(sql`
      INSERT INTO billing_retention_offers(user_id,offer_id,subscription_id,customer_id,state,fingerprint,update_params,currency,amount,regular_amount,regular_invoice_total,offer_credit_applied,trial,expires_at)
      VALUES(${userId},${offerId},${sub.id},${local.stripe_customer_id},'quoted',${retentionFingerprint(sub)},${JSON.stringify(params)}::jsonb,
        ${preview.currency},${preview.amount},${preview.regularAmount},${preview.recurringAmount},${preview.creditApplied},${sub.status === "trialing"},${expiresAt})
      ON CONFLICT(user_id) DO UPDATE SET offer_id=EXCLUDED.offer_id,subscription_id=EXCLUDED.subscription_id,
        customer_id=EXCLUDED.customer_id,state='quoted',fingerprint=EXCLUDED.fingerprint,update_params=EXCLUDED.update_params,
        currency=EXCLUDED.currency,amount=EXCLUDED.amount,regular_amount=EXCLUDED.regular_amount,regular_invoice_total=EXCLUDED.regular_invoice_total,offer_credit_applied=EXCLUDED.offer_credit_applied,trial=EXCLUDED.trial,
        expires_at=EXCLUDED.expires_at,requested_at=NULL WHERE billing_retention_offers.state='quoted' RETURNING *`))[0];
    if (!row) throw new RetentionError("Billing changed. Please reopen cancellation.");
    return publicOffer(row);
  });
}

export async function acceptRetentionOffer(api: Stripe, userId: string, offerId: string): Promise<void> {
  return withCustomerBillingLock(userId, async executor => {
    const local = await localSubscription(executor, userId);
    const row = resultRows<OfferRow>(await executor.execute(sql`SELECT * FROM billing_retention_offers WHERE user_id=${userId}`))[0];
    if (!row || row.offer_id !== offerId || row.subscription_id !== local.stripe_subscription_id || row.customer_id !== local.stripe_customer_id) {
      throw new RetentionError("This offer is no longer available. Please reopen cancellation.");
    }
    if (row.state === "applied") { await recordRetentionEmail(executor,userId,offerId); return; }
    let sub = await api.subscriptions.retrieve(row.subscription_id, {}, request);
    verifyOwner(sub, local, userId);
    if (sub.metadata.retentionOfferId !== offerId) {
      if (!retentionEligible(sub) || retentionFingerprint(sub) !== row.fingerprint) throw new RetentionError("Your billing changed. Please reopen cancellation to review the current details.");
      if (row.state === "quoted" && new Date(row.expires_at).getTime() <= Date.now()) throw new RetentionError("This quote expired. Please reopen cancellation.");
      if (row.state === "pending" && (!row.requested_at || Date.now() - new Date(row.requested_at).getTime() > 23 * 3600_000)) {
        throw new RetentionError("We could not confirm the earlier request. Please contact support; you can still cancel.");
      }
      if (row.state === "quoted") {
        const preview = await previewOffer(api, sub, row.customer_id, row.update_params.discounts);
        if (!preview || preview.amount !== row.amount || preview.regularAmount !== row.regular_amount || preview.recurringAmount !== (row.regular_invoice_total ?? row.regular_amount) || preview.creditApplied !== (row.offer_credit_applied ?? 0) || preview.currency !== row.currency) {
          throw new RetentionError("Your invoice changed. Please reopen cancellation to review the current amount.");
        }
      }
      // Freeze parameters before any provider write. Retries use this exact
      // body/key; crashes after provider success reconcile from its marker.
      const claimed = resultRows(await executor.execute(sql`UPDATE billing_retention_offers
        SET state='pending',requested_at=COALESCE(requested_at,NOW())
        WHERE user_id=${userId} AND offer_id=${offerId} AND state=${row.state} RETURNING offer_id`));
      if (!claimed.length) throw new RetentionError("A newer offer replaced this quote. Please reopen cancellation.");
      sub = await api.subscriptions.update(row.subscription_id, row.update_params, { ...request, idempotencyKey: `retention:${offerId}` });
      verifyOwner(sub, local, userId);
      if (sub.metadata.retentionOfferId !== offerId) throw new RetentionError("The offer has not been confirmed. Please retry.");
    }
    await executor.transaction(async tx => {
      const applied = resultRows(await tx.execute(sql`UPDATE billing_retention_offers SET state='applied',applied_at=NOW()
        WHERE user_id=${userId} AND offer_id=${offerId} RETURNING offer_id`));
      if (!applied.length) throw new RetentionError("The offer needs reconciliation. Please contact support.");
      await recordRetentionEmail(tx,userId,offerId);
    });
  });
}

/** Cancellation shares the checkout/deletion/offer lock and never undoes a prior cancellation. */
export async function cancelCustomerSubscription(api: Stripe, userId: string): Promise<void> {
  return withCustomerBillingLock(userId, async executor => {
    const local = await localSubscription(executor, userId);
    let sub = await api.subscriptions.retrieve(local.stripe_subscription_id, {}, request);
    verifyOwner(sub, local, userId);
    const refundTrial = sub.metadata.trialPaymentPolicy === TRIAL_PAYMENT_POLICY && sub.metadata.trialCancellationPolicy === "refund_during_trial" &&
      sub.status === "trialing" && !!sub.trial_end && sub.trial_end * 1000 > Date.now();
    if (refundTrial) {
      try { await reconcileTrialPaymentCredit(api, sub, executor); }
      catch (error) { logger.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Trial payment verification pending; cancellation will still proceed"); }
      sub = await api.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false }, request);
      verifyOwner(sub, local, userId);
      if (sub.status !== "canceled") throw new RetentionError("Cancellation was not confirmed. Please retry or open billing.");
    }
    if (!["canceled", "incomplete_expired"].includes(sub.status) && !sub.cancel_at_period_end && !sub.cancel_at) {
      sub = await api.subscriptions.update(sub.id, { cancel_at_period_end: true }, request);
      verifyOwner(sub, local, userId);
      if (!sub.cancel_at_period_end) throw new RetentionError("Cancellation was not confirmed. Please retry or open billing.");
    }
    const ended = ["canceled", "incomplete_expired"].includes(sub.status);
    const cancelAt = sub.cancel_at ? new Date(sub.cancel_at * 1000) : null;
    if (sub.metadata.trialPaymentPolicy === TRIAL_PAYMENT_POLICY) {
      try { await reconcileTrialPaymentCancellation(api, sub, executor); }
      catch (error) { logger.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Trial refund pending after confirmed cancellation"); }
    }
    const trialPayment = sub.metadata.trialPaymentPolicy === TRIAL_PAYMENT_POLICY ?
      (await readTrialPaymentSummary(userId, sub.id, executor) ?? pendingTrialPaymentSummary(sub.metadata.trialPaymentPolicy, sub.metadata.trialCancellationPolicy)) : undefined;
    await executor.transaction(async tx => {
      const [updated] = resultRows<Record<string,any>>(await tx.execute(sql`UPDATE subscriptions SET cancel_at_period_end=${sub.cancel_at_period_end || !!sub.cancel_at},
        status=CASE WHEN ${ended} THEN 'canceled'::subscription_status ELSE status END,
        current_period_end=CASE WHEN ${cancelAt}::timestamptz IS NOT NULL THEN LEAST(current_period_end,${cancelAt}::timestamptz) ELSE current_period_end END,
        trial_ends_at=CASE WHEN trial_ends_at IS NOT NULL AND ${cancelAt}::timestamptz IS NOT NULL THEN LEAST(trial_ends_at,${cancelAt}::timestamptz) ELSE trial_ends_at END,
        updated_at=NOW()
        WHERE user_id=${userId} AND stripe_subscription_id=${sub.id} RETURNING *`));
      if (!updated) throw new RetentionError("Cancellation needs reconciliation. Please retry.");
      await recordSubscriptionEmail(tx,userId,{stripeSubscriptionId:updated.stripe_subscription_id,status:updated.status,plan:updated.plan,
        currentPeriodEnd:updated.current_period_end ? new Date(updated.current_period_end).toISOString() : null,trialEndsAt:updated.trial_ends_at ? new Date(updated.trial_ends_at).toISOString() : null,cancelAtPeriodEnd:updated.cancel_at_period_end,
        ...(trialPayment ? { trialPayment } : {})});
    });
  });
}
