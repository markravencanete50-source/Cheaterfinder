// Create CheaterFinder Stripe products, prices and coupons from the shared catalog.
//
// The SUBSCRIPTION price is the anchor; a forever-duration coupon (display name
// "FOUNDERS") is applied at checkout, so Stripe renders the
// strike-through discount at checkout and on the subscription. Renaming later
// (HOLIDAY, VALENTINE…) = update the coupon `name`; pulling it = stop applying.
//
// Products/prices are matched by metadata, coupons by fixed id. Run serially;
// provider search may take time to reflect new objects. Dry-run by default.
// STRIPE_EXPECTED_ACCOUNT_ID must identify the intended Stripe account.
//
// Usage:
//   npx tsx server/scripts/setup-founders-pricing.ts            # dry-run
//   npx tsx server/scripts/setup-founders-pricing.ts --apply    # create live

import "dotenv/config";
import Stripe from "stripe";
import { BILLING_PLANS, CHECKOUT_PLAN_IDS } from "../../shared/billing-plans.js";

const TIERS = CHECKOUT_PLAN_IDS.map(id => {
  const plan = BILLING_PLANS[id];
  const anchorCents = Math.round((plan.anchorPrice ?? plan.price) * 100);
  const saleCents = Math.round(plan.price * 100);
  if (plan.cadence !== "/month" || !Number.isSafeInteger(anchorCents) ||
      !Number.isSafeInteger(saleCents) || saleCents <= 0 || anchorCents <= saleCents) {
    throw new Error(`Invalid founders pricing for ${id}`);
  }
  return { id, name: `CheaterFinder ${plan.name}`, anchorCents,
    discountCents: anchorCents - saleCents, accounts: plan.accountLimit, sale: plan.priceLabel };
});

const COUPON_DISPLAY_NAME = "FOUNDERS";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !/^(sk|rk)_(live|test)_/.test(key)) throw new Error("STRIPE_SECRET_KEY not configured");
  const expectedAccount = process.env.STRIPE_EXPECTED_ACCOUNT_ID;
  if (!expectedAccount?.startsWith("acct_")) throw new Error("STRIPE_EXPECTED_ACCOUNT_ID not configured");
  const live = /^(sk|rk)_live_/.test(key);
  const stripe = new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
  if ((await stripe.accounts.retrieve()).id !== expectedAccount) throw new Error("Stripe account identity was not confirmed");
  console.log(`[founders] mode=${apply ? "APPLY" : "DRY-RUN"} stripe=${live ? "LIVE" : "TEST"}`);

  const out: Record<string, { priceId: string; couponId: string }> = {};

  for (const tier of TIERS) {
    // ── Product (match by metadata.cheaterfinder_tier) ──────────────────────────────
    const products = await stripe.products.search({
      query: `metadata['cheaterfinder_tier']:'${tier.id}' AND metadata['cheaterfinder_kind']:'founders'`,
    });
    if (products.has_more || products.data.length > 1) throw new Error(`Ambiguous founders product for ${tier.id}`);
    let productId = products.data[0]?.id;
    if (!productId) {
      if (apply) {
        const p = await stripe.products.create({
          name: tier.name,
          description: `Track ${tier.accounts} Instagram account${tier.accounts > 1 ? "s" : ""}`,
          metadata: { cheaterfinder_tier: tier.id, cheaterfinder_kind: "founders" },
        });
        productId = p.id;
      } else {
        productId = "(new product)";
      }
    }

    // ── Anchor price (match by metadata) ──────────────────────────────────────
    let priceId = "(existing/new price)";
    if (productId.startsWith("prod_")) {
      const prices = await stripe.prices.search({
        query: `product:'${productId}' AND metadata['cheaterfinder_kind']:'anchor' AND active:'true'`,
      });
      if (prices.has_more) throw new Error(`Anchor price history needs reconciliation for ${tier.id}`);
      const match = prices.data.find((p) => p.unit_amount === tier.anchorCents &&
        p.currency === "usd" && p.recurring?.interval === "month" && p.recurring.interval_count === 1);
      priceId = match?.id ?? "(new price)";
      if (!match && apply) {
        const price = await stripe.prices.create({
          product: productId,
          currency: "usd",
          unit_amount: tier.anchorCents,
          recurring: { interval: "month" },
          metadata: { cheaterfinder_tier: tier.id, cheaterfinder_kind: "anchor" },
        });
        priceId = price.id;
      }
    }

    // ── Coupon (fixed id, forever duration, display name FOUNDERS) ────────────
    const couponId = `founders_${tier.id}`;
    let couponExists = false;
    try {
      const coupon = await stripe.coupons.retrieve(couponId, { expand: ["applies_to"] });
      if (coupon.amount_off !== tier.discountCents || coupon.currency !== "usd" ||
          coupon.duration !== "forever" || !coupon.valid ||
          (coupon.applies_to?.products?.length && !coupon.applies_to.products.includes(productId))) {
        throw new Error(`Existing ${couponId} does not match the advertised monthly package`);
      }
      couponExists = true;
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError) || error.code !== "resource_missing") throw error;
    }
    if (!couponExists && apply) {
      await stripe.coupons.create({
        id: couponId,
        name: COUPON_DISPLAY_NAME,
        amount_off: tier.discountCents,
        currency: "usd",
        duration: "forever",
        metadata: { cheaterfinder_tier: tier.id },
      });
    }

    out[tier.id] = { priceId, couponId };
    console.log(
      `[founders] ${tier.id}: product=${productId} anchor=$${(tier.anchorCents / 100).toFixed(2)} price=${priceId} coupon=${couponId}(${couponExists || apply ? "ready" : "would-create"}) → ${tier.sale}`,
    );
  }

  console.log("\n[founders] ENV to set (STRIPE_*_PRICE_ID + coupon ids):");
  console.log(`STRIPE_STARTER_PRICE_ID=${out.starter.priceId}`);
  console.log(`STRIPE_STANDARD_PRICE_ID=${out.standard.priceId}`);
  console.log(`STRIPE_PRO_PRICE_ID=${out.pro.priceId}`);
  console.log(`STRIPE_FOUNDERS_COUPON_STARTER=${out.starter.couponId}`);
  console.log(`STRIPE_FOUNDERS_COUPON_STANDARD=${out.standard.couponId}`);
  console.log(`STRIPE_FOUNDERS_COUPON_PRO=${out.pro.couponId}`);
  if (!apply) console.log("\n[founders] DRY-RUN — re-run with --apply to create.");
}

void main().catch((e: unknown) => {
  console.error("[founders] ERROR", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
