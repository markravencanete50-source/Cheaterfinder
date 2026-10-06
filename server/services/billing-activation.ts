import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { resultRows } from "./operation-lease.js";
import { requireBillingUser, withCustomerBillingLock } from "./customer-billing-lifecycle.js";
import { assertRescueOfferClaim, validateRescueCoupon, type VerifiedRescueOffer } from "./billing-rescue-offer.js";

/** Set only by an explicit activation; passive trial conversions never use it. */
export const TRIAL_ACTIVATION_POLICY = "invoice-paid-v1";
const request = { timeout: 15_000, maxNetworkRetries: 1 } as const;

export class BillingActivationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "BillingActivationError";
  }
}

function id(value: string | { id: string } | null | undefined): string | undefined {
  return typeof value === "string" ? value : value?.id;
}

function noTrial(): never {
  throw new BillingActivationError(400, "no_trial", "An unexpired trial is required to activate this subscription.");
}

/** No subscription state is written here. Only the normal Stripe sync unlocks access. */
export async function activateTrialNow(api: Stripe, userId: string, couponId?: string,
  rescueOffer?: VerifiedRescueOffer): Promise<{ status: "activating" }> {
  if (!userId) throw new BillingActivationError(401, "authentication_required", "Please sign in.");
  return withCustomerBillingLock(userId, async executor => {
    await requireBillingUser(userId, executor);
    const local = resultRows<{
      stripe_subscription_id: string | null; stripe_customer_id: string | null;
      status: string; trial_ends_at: Date | string | null; plan: string | null;
    }>(await executor.execute(sql`SELECT stripe_subscription_id,stripe_customer_id,status,trial_ends_at,plan
      FROM subscriptions WHERE user_id=${userId}`))[0];
    if (local?.status === "active") throw new BillingActivationError(409, "already_active", "Your subscription is already active.");
    if (!local?.stripe_subscription_id?.startsWith("sub_") || !local.stripe_customer_id?.startsWith("cus_") ||
      local.status !== "trialing" || !local.trial_ends_at || new Date(local.trial_ends_at).getTime() <= Date.now()) noTrial();
    if (couponId) await assertRescueOfferClaim(executor, userId, local.stripe_subscription_id!, local.plan, couponId, rescueOffer);

    const sub = await api.subscriptions.retrieve(local.stripe_subscription_id, {
      expand: ["default_payment_method", "default_source", ...(couponId ? ["discounts"] : [])],
    }, request);
    if (sub.id !== local.stripe_subscription_id || id(sub.customer) !== local.stripe_customer_id ||
      (sub.metadata.userId && sub.metadata.userId !== userId)) {
      throw new BillingActivationError(400, "billing_ownership", "Billing ownership could not be verified.");
    }
    // A lost response is recovered from the marker. Never end the same trial twice.
    if (sub.metadata.trialActivationPolicy === TRIAL_ACTIVATION_POLICY && sub.status !== "trialing") {
      return { status: "activating" };
    }
    if (sub.status === "active") throw new BillingActivationError(409, "already_active", "Your subscription is already active.");
    if (sub.status !== "trialing" || !sub.trial_end || sub.trial_end * 1000 <= Date.now() ||
      sub.cancel_at_period_end || sub.cancel_at || sub.pause_collection || sub.collection_method !== "charge_automatically") noTrial();

    const customer = await api.customers.retrieve(local.stripe_customer_id, {
      expand: ["invoice_settings.default_payment_method", "default_source"],
    }, request);
    if (customer.deleted || customer.id !== local.stripe_customer_id ||
      (customer.metadata.userId && customer.metadata.userId !== userId)) {
      throw new BillingActivationError(400, "billing_ownership", "Billing ownership could not be verified.");
    }
    // Stripe precedence: subscription PM, subscription source, customer PM, customer source.
    const paymentMethod = sub.default_payment_method ?? (!sub.default_source ? customer.invoice_settings.default_payment_method : null);
    const source = sub.default_source ?? customer.default_source;
    let hasCard = false;
    if (paymentMethod) {
      const method = typeof paymentMethod === "string" ? await api.paymentMethods.retrieve(paymentMethod, {}, request) : paymentMethod;
      hasCard = method.type === "card" && id(method.customer) === customer.id;
    } else if (source) {
      const card = typeof source === "string" ? await api.customers.retrieveSource(customer.id, source, {}, request) : source;
      hasCard = !("deleted" in card && card.deleted) &&
        (card.object === "card" || (card.object === "source" && card.type === "card" && card.status === "chargeable")) &&
        id(card.customer) === customer.id;
    }
    if (!hasCard) throw new BillingActivationError(400, "no_payment_method", "Add a card in billing before activating your subscription.");

    if (couponId) await validateRescueCoupon(api, couponId);

    // Preserve existing discounts in order: FOUNDERS is applied before rescue.
    // The ordinary activation request remains identical to v1.
    // Never rotate the key after a timeout. If discounts changed in the meantime,
    // Stripe must reject the mismatched retry body rather than create a new request.
    await api.subscriptions.update(sub.id, {
      trial_end: "now",
      proration_behavior: "none",
      metadata: { trialActivationPolicy: TRIAL_ACTIVATION_POLICY },
      ...(couponId ? { discounts: [...sub.discounts.map(discount => ({ discount: typeof discount === "string" ? discount : discount.id })), { coupon: couponId }] } : {}),
    }, { ...request, idempotencyKey: couponId ? `activate-trial:v2:${sub.id}:rescue` : `activate-trial:v1:${sub.id}` });
    return { status: "activating" };
  });
}

/** Proof for the first active transition after explicit activation, not renewal policy. */
export async function activationPaymentVerified(api: Stripe, sub: Stripe.Subscription): Promise<boolean> {
  if (sub.metadata.trialActivationPolicy !== TRIAL_ACTIVATION_POLICY || sub.status !== "active") return true;
  const invoiceId = id(sub.latest_invoice);
  if (!invoiceId || !sub.trial_end) return false;
  const invoice = await api.invoices.retrieve(invoiceId, {}, request);
  if (invoice.id !== invoiceId || invoice.status !== "paid" || invoice.amount_remaining !== 0 ||
    !["subscription_cycle", "subscription_update"].includes(invoice.billing_reason ?? "") ||
    id(invoice.customer) !== id(sub.customer) || id(invoice.parent?.subscription_details?.subscription) !== sub.id) return false;
  // A paid signup advance, proration or old invoice must never unlock the monthly data.
  return invoice.lines.data.some(line => {
    const details = line.parent?.subscription_item_details;
    const item = sub.items.data.find(candidate => candidate.id === details?.subscription_item);
    return !!item?.price.recurring && details?.subscription === sub.id && details.proration === false &&
      id(line.pricing?.price_details?.price) === item.price.id && line.amount > 0 &&
      line.period.start >= sub.trial_end! && line.period.end > line.period.start;
  });
}
