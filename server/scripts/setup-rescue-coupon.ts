// Provision the fixed rescue coupon in the Stripe mode selected by the key.
// Usage: npx tsx server/scripts/setup-rescue-coupon.ts
// This operator script is manual; application startup never creates coupons.
import "dotenv/config";
import Stripe from "stripe";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COUPON_ID = "TRIAL_RESCUE_50";
type CouponApi = {
  coupons: {
    retrieve(id: string): Promise<{ id: string }>;
    create(params: Stripe.CouponCreateParams): Promise<{ id: string }>;
  };
};

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function setupRescueCoupon({ secretKey, api, log = console.log }: {
  secretKey: string | undefined;
  api?: CouponApi;
  log?: (message: string) => void;
}): Promise<{ couponId: string; mode: "live" | "test"; created: boolean }> {
  const match = /^(?:sk|rk)_(live|test)_[A-Za-z0-9_]+$/.exec(secretKey ?? "");
  if (!match || match[0] !== secretKey) throw new Error("STRIPE_SECRET_KEY must be a valid live or test secret/restricted key.");
  const mode = match[1] as "live" | "test";
  log(`[rescue] stripe=${mode.toUpperCase()} coupon=${COUPON_ID}`);

  try {
    const stripe = api ?? new Stripe(secretKey!, { apiVersion: "2026-03-25.dahlia", timeout: 20_000, maxNetworkRetries: 1 });
    try {
      await stripe.coupons.retrieve(COUPON_ID);
      log(`[rescue] stripe=${mode.toUpperCase()} ${COUPON_ID} already exists, skipping`);
      return { couponId: COUPON_ID, mode, created: false };
    } catch (error) {
      if (!hasCode(error, "resource_missing")) throw error;
    }

    try {
      await stripe.coupons.create({
        id: COUPON_ID,
        name: "Trial Rescue 50",
        percent_off: 50,
        duration: "once",
        currency: "usd",
      });
    } catch (error) {
      if (!hasCode(error, "resource_already_exists")) throw error;
      // Another operator may have created the fixed ID after our first read.
      await stripe.coupons.retrieve(COUPON_ID);
      log(`[rescue] stripe=${mode.toUpperCase()} ${COUPON_ID} already exists, skipping`);
      return { couponId: COUPON_ID, mode, created: false };
    }
    log(`[rescue] stripe=${mode.toUpperCase()} created ${COUPON_ID}; set STRIPE_RESCUE_COUPON_ID=${COUPON_ID}`);
    return { couponId: COUPON_ID, mode, created: true };
  } catch {
    // Provider errors may contain request details or credentials; never print them.
    throw new Error("Stripe rescue coupon setup failed. Check the selected Stripe mode, key permissions, and dashboard.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void setupRescueCoupon({ secretKey: process.env.STRIPE_SECRET_KEY }).catch((error: unknown) => {
    console.error("[rescue] ERROR:", error instanceof Error ? error.message : "Stripe rescue coupon setup failed.");
    process.exitCode = 1;
  });
}
