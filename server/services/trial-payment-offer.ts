import type Stripe from "stripe";
import { BILLING_PLANS, CHECKOUT_PLAN_IDS, type CheckoutPlan } from "../../shared/billing-plans.js";
import { TRIAL_PAYMENT_AMOUNT, TRIAL_PAYMENT_POLICY, type CheckoutOffer, type TrialCancellationPolicy } from "../../shared/trial-payment.js";

export class CheckoutOfferChangedError extends Error {
  constructor() { super("Checkout terms changed. Please review the current payment amount and terms before continuing."); }
}
export class TrialPaymentConfigurationError extends Error {
  constructor() { super("Trial payment setup is unavailable. Please retry shortly or contact support."); }
}

export function trialPaymentConfiguration() {
  if (process.env.STRIPE_TRIAL_ADVANCE_ENABLED !== "true") return null;
  const cancellationPolicy = process.env.STRIPE_TRIAL_CANCELLATION_POLICY;
  const priceId = process.env.STRIPE_TRIAL_ADVANCE_PRICE_ID ?? "";
  const paymentMethodConfiguration = process.env.STRIPE_TRIAL_PAYMENT_METHOD_CONFIG_ID ?? "";
  const refundPortalConfiguration = process.env.STRIPE_TRIAL_REFUND_PORTAL_CONFIG_ID ?? "";
  if (!priceId.startsWith("price_") || !paymentMethodConfiguration.startsWith("pmc_") || !["refund_during_trial", "retain_credit"].includes(cancellationPolicy ?? "")) {
    throw new TrialPaymentConfigurationError();
  }
  if (cancellationPolicy === "refund_during_trial" && !refundPortalConfiguration.startsWith("bpc_")) throw new TrialPaymentConfigurationError();
  const coupons = Object.fromEntries(CHECKOUT_PLAN_IDS.map(plan => [plan, process.env[`STRIPE_TRIAL_FOUNDERS_COUPON_${plan.toUpperCase()}`] ?? ""])) as Record<CheckoutPlan, string>;
  if (Object.values(coupons).some(value => !value.trim())) throw new TrialPaymentConfigurationError();
  return { priceId, coupons, paymentMethodConfiguration, refundPortalConfiguration, cancellationPolicy: cancellationPolicy as TrialCancellationPolicy };
}

export function checkoutOffer(plan: CheckoutPlan, trialEligible: boolean): CheckoutOffer {
  const config = trialEligible ? trialPaymentConfiguration() : null;
  const recurringAmount = Math.round(BILLING_PLANS[plan].price * 100);
  const creditAmount = config ? TRIAL_PAYMENT_AMOUNT : 0;
  return {
    version: config ? `${TRIAL_PAYMENT_POLICY}:${config.cancellationPolicy}:${plan}` : `subscription-v1:${plan}:${trialEligible ? "trial" : "paid"}`,
    plan, currency: "usd", trialDays: trialEligible ? 3 : 0,
    dueTodayAmount: trialEligible ? creditAmount : recurringAmount,
    creditAmount, recurringAmount, firstMonthlyAmount: recurringAmount - creditAmount,
    requiresAcceptance: !!config, cancellationPolicy: config?.cancellationPolicy ?? "none",
  };
}

export function requireCurrentCheckoutOffer(offer: CheckoutOffer, acceptedVersion?: string): void {
  if ((offer.requiresAcceptance || acceptedVersion != null) && acceptedVersion !== offer.version) throw new CheckoutOfferChangedError();
}

/** Validate all monetary configuration before accepting a new paid trial.
 * No provider mutations, and no changes to grandfathered coupons/subscriptions.
 */
export async function verifyTrialPaymentConfiguration(api: Stripe, plan: CheckoutPlan, recurringPriceId: string) {
  const config = trialPaymentConfiguration();
  if (!config) return null;
  const [advance, recurring, coupon, methods, refundPortal] = await Promise.all([
    api.prices.retrieve(config.priceId), api.prices.retrieve(recurringPriceId),
    // Product restrictions are includable and omitted from ordinary retrieval.
    api.coupons.retrieve(config.coupons[plan], { expand: ["applies_to"] }),
    api.paymentMethodConfigurations.retrieve(config.paymentMethodConfiguration),
    config.cancellationPolicy === "refund_during_trial" ? api.billingPortal.configurations.retrieve(config.refundPortalConfiguration) : Promise.resolve(null),
  ]);
  const recurringProduct = typeof recurring.product === "string" ? recurring.product : recurring.product.id;
  const advanceProduct = typeof advance.product === "string" ? advance.product : advance.product.id;
  const expectedAnchor = Math.round(BILLING_PLANS[plan].anchorPrice! * 100);
  const immediateMethods = new Set(["card", "apple_pay", "google_pay"]);
  const anyDelayedMethod = Object.entries(methods).some(([method, value]) => value && typeof value === "object" &&
    "display_preference" in value && value.display_preference?.value === "on" && !immediateMethods.has(method));
  if (!methods.active || methods.card?.available !== true || methods.card.display_preference.value !== "on" || anyDelayedMethod ||
    (refundPortal && (!refundPortal.active || !refundPortal.features.subscription_cancel.enabled || refundPortal.features.subscription_cancel.mode !== "immediately")) ||
    !advance.active || advance.currency !== "usd" || advance.unit_amount !== TRIAL_PAYMENT_AMOUNT || advance.recurring ||
    !recurring.active || recurring.currency !== "usd" || recurring.unit_amount !== expectedAnchor || recurring.recurring?.interval !== "month" ||
    recurring.recurring.interval_count !== 1 || recurringProduct === advanceProduct || !coupon.valid || coupon.currency !== "usd" ||
    coupon.duration !== "forever" || coupon.percent_off != null || coupon.amount_off !== expectedAnchor - Math.round(BILLING_PLANS[plan].price * 100) ||
    !coupon.applies_to?.products.includes(recurringProduct) || coupon.applies_to.products.includes(advanceProduct)) {
    throw new TrialPaymentConfigurationError();
  }
  return config;
}

export function checkoutTrialDisclosure(offer: CheckoutOffer): string {
  const monthly = (offer.recurringAmount / 100).toFixed(2);
  const cancellation = offer.cancellationPolicy === "refund_during_trial"
    ? "Cancel before the trial ends to end access immediately and receive a refund of your unused 99-cent advance; the matching credit will be removed."
    : "If you cancel, the 99-cent advance stays as account credit for a future invoice and is not refunded in cash.";
  return `US$0.99 charged today and credited once to your next invoice. Your 3-day trial then renews at US$${monthly}/month unless canceled. ${cancellation} Amounts are before applicable tax; a plan change may use the credit earlier.`;
}
