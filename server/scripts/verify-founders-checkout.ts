// Check provider pricing by creating and immediately expiring trial and paid
// Checkout sessions. This does not complete checkout or make a payment.
// STRIPE_EXPECTED_ACCOUNT_ID must identify the intended Stripe account.

import "dotenv/config";
import Stripe from "stripe";
import { BILLING_PLANS } from "../../shared/billing-plans.js";

class CheckoutCleanupError extends Error {}

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !/^(sk|rk)_(live|test)_/.test(key)) throw new Error("STRIPE_SECRET_KEY not configured");
  const expectedAccount = process.env.STRIPE_EXPECTED_ACCOUNT_ID;
  if (!expectedAccount?.startsWith("acct_")) throw new Error("STRIPE_EXPECTED_ACCOUNT_ID not configured");
  const configuredUrl = new URL(process.env.APP_URL ?? "https://cheaterfinder.com");
  if (!["https:", "http:"].includes(configuredUrl.protocol) || configuredUrl.username || configuredUrl.password ||
      (process.env.NODE_ENV === "production" && configuredUrl.protocol !== "https:")) {
    throw new Error("APP_URL must be a valid application origin using HTTPS in production");
  }
  const appUrl = configuredUrl.origin;
  const s = new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
  if ((await s.accounts.retrieve()).id !== expectedAccount) throw new Error("Stripe account identity was not confirmed");
  const tiers = [
    { plan: "starter", price: process.env.STRIPE_STARTER_PRICE_ID!, coupon: process.env.STRIPE_FOUNDERS_COUPON_STARTER! },
    { plan: "standard", price: process.env.STRIPE_STANDARD_PRICE_ID!, coupon: process.env.STRIPE_FOUNDERS_COUPON_STANDARD! },
    { plan: "pro", price: process.env.STRIPE_PRO_PRICE_ID!, coupon: process.env.STRIPE_FOUNDERS_COUPON_PRO! },
  ] as const;
  for (const t of tiers) {
    try {
      if (!t.price?.startsWith("price_") || !t.coupon) throw new Error(`Price and founders coupon must be configured for ${t.plan}`);
      const price = await s.prices.retrieve(t.price);
      const coupon = await s.coupons.retrieve(t.coupon);
      const plan = BILLING_PLANS[t.plan];
      const monthlyCents = Math.round(plan.price * 100);
      const anchorCents = Math.round((plan.anchorPrice ?? plan.price) * 100);
      if (!price.active || price.unit_amount !== anchorCents || price.currency !== "usd" ||
          price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 ||
          coupon.amount_off !== anchorCents - monthlyCents || coupon.currency !== "usd" ||
          coupon.duration !== "forever" || !coupon.valid) {
        throw new Error("Stripe pricing does not match the advertised monthly package");
      }
      for (const trialEligible of [true, false]) {
        const session = await s.checkout.sessions.create({
          mode: "subscription",
          payment_method_collection: "always",
          line_items: [{ price: t.price, quantity: 1 }],
          discounts: [{ coupon: t.coupon }],
          ...(trialEligible ? { subscription_data: { trial_period_days: 3 } } : {}),
          success_url: `${appUrl}/settings?tab=billing&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${appUrl}/payment?checkout=cancelled&plan=${t.plan}`,
          metadata: { purpose: "deployment-verification", plan: t.plan, trialEligible: String(trialEligible) },
        });
        try {
          const expectedTotal = trialEligible ? 0 : monthlyCents;
          if (!session.url || session.amount_total !== expectedTotal || session.currency !== "usd" ||
              session.payment_method_collection !== "always" || session.subscription || session.customer) {
            throw new Error("Checkout did not match the trial/payment contract");
          }
          console.log(JSON.stringify({ plan: t.plan, trialEligible, dueTodayCents: session.amount_total,
            monthlyCents, sessionCreated: true, actualCharge: false }));
        } finally {
          try {
            const expired = await s.checkout.sessions.expire(session.id);
            if (expired.status !== "expired") throw new Error("unexpected session status");
          } catch {
            // Stop creating further sessions if cleanup cannot be confirmed.
            throw new CheckoutCleanupError(`Verification Checkout ${session.id} could not be confirmed expired`);
          }
        }
      }
      console.log(`[verify] ${t.plan}: effective $${(monthlyCents / 100).toFixed(2)}/month; both sessions expired`);
    } catch (e) {
      console.error(`[verify] ${t.plan}: FAIL ${e instanceof Error ? e.message.slice(0, 240) : String(e)}`);
      process.exitCode = 1;
      if (e instanceof CheckoutCleanupError) throw e;
    }
  }
}

void main().catch((e: unknown) => {
  console.error("[verify] ERR", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
