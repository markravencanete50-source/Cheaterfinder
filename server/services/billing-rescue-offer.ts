import { createHmac, timingSafeEqual } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { BILLING_PLANS, hasSubscriptionAccess, isSubscriptionPlan, type SubscriptionPlan } from "../../shared/billing-plans.js";
import { logger } from "../observability/logger.js";
import { requireBillingUser, withCustomerBillingLock, type BillingDatabase } from "./customer-billing-lifecycle.js";
import { resultRows } from "./operation-lease.js";

// Read once at startup: changing coupon configuration requires a restart.
const couponId = process.env.STRIPE_RESCUE_COUPON_ID?.trim() ?? "";
if (!couponId) logger.warn("[billing rescue] STRIPE_RESCUE_COUPON_ID is missing; rescue offers are disabled");
const ttlSeconds = 600;
const request = { timeout: 15_000, maxNetworkRetries: 1 } as const;
const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export class RescueOfferError extends Error {
  constructor(public readonly status = 400, public readonly code = "invalid_rescue_offer",
    message = "This offer is invalid or expired. You can still activate your subscription at its regular price.") {
    super(message);
    this.name = "RescueOfferError";
  }
}

interface Claims { sub: string; subscriptionId: string; plan: string; offeredAt: string; iat: number; exp: number }
export interface VerifiedRescueOffer extends Claims { couponId: string }

function signingKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!couponId || !secret?.trim()) throw new RescueOfferError(503, "rescue_unavailable", "This offer is currently unavailable.");
  // Bind to this feature AND coupon configuration without putting the coupon ID
  // in the decodable JWT payload. Never reuse mobile/session token signatures.
  return createHmac("sha256", secret).update(JSON.stringify(["cheaterfinder-trial-rescue-v1", couponId])).digest();
}

function signOffer(claims: Claims, key: Buffer): string {
  const body = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function verifyRescueOfferToken(token: unknown, userId: string): VerifiedRescueOffer {
  if (typeof token !== "string" || token.length > 2048) throw new RescueOfferError();
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== header || !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) throw new RescueOfferError();
  const signature = Buffer.from(parts[2], "base64url");
  const expected = createHmac("sha256", signingKey()).update(`${parts[0]}.${parts[1]}`).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new RescueOfferError();
  let claims: Claims;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { throw new RescueOfferError(); }
  const now = Math.floor(Date.now() / 1000);
  if (!claims || claims.sub !== userId || typeof claims.subscriptionId !== "string" || !claims.subscriptionId.startsWith("sub_") ||
    !isSubscriptionPlan(claims.plan) || BILLING_PLANS[claims.plan].cadence !== "/month" ||
    typeof claims.offeredAt !== "string" || !Number.isFinite(Date.parse(claims.offeredAt)) ||
    !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
    claims.iat > now || claims.exp - claims.iat !== ttlSeconds || now >= claims.exp) throw new RescueOfferError();
  return { ...claims, couponId };
}

/** Only reads the operator-provisioned coupon; application requests never create one. */
export async function validateRescueCoupon(api: Stripe, selectedCouponId: string): Promise<void> {
  if (!couponId || selectedCouponId !== couponId) throw new RescueOfferError();
  const coupon = await api.coupons.retrieve(couponId, { expand: ["applies_to"] }, request);
  if (coupon.id !== couponId || !coupon.valid || coupon.percent_off !== 50 || coupon.duration !== "once" || coupon.applies_to) {
    throw new RescueOfferError(503, "rescue_unavailable", "This offer is currently unavailable.");
  }
}

export async function claimRescueOffer(api: Stripe, userId: string) {
  if (!couponId) return { eligible: false as const };
  const key = signingKey(); // Fail before consuming exposure if signing is unavailable.
  return withCustomerBillingLock(userId, async executor => {
    await requireBillingUser(userId, executor);
    const local = resultRows<{
      plan: SubscriptionPlan | null; status: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null;
      trialEndsAt: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; offeredAt: Date | null;
    }>(await executor.execute(sql`SELECT s.plan,s.status,s.stripe_customer_id AS "stripeCustomerId",
      s.stripe_subscription_id AS "stripeSubscriptionId",s.trial_ends_at AS "trialEndsAt",
      s.current_period_end AS "currentPeriodEnd",s.cancel_at_period_end AS "cancelAtPeriodEnd",
      u.rescue_discount_offered_at AS "offeredAt" FROM users u JOIN subscriptions s ON s.user_id=u.id WHERE u.id=${userId}`))[0];
    if (!local || local.offeredAt || local.status !== "trialing" || local.cancelAtPeriodEnd ||
      !hasSubscriptionAccess(local) || !isSubscriptionPlan(local.plan) || BILLING_PLANS[local.plan].cadence !== "/month") {
      return { eligible: false as const };
    }
    await validateRescueCoupon(api, couponId);
    const [claimed] = resultRows<{ offeredAt: Date }>(await executor.execute(sql`
      UPDATE users SET rescue_discount_offered_at=now()
      WHERE id=${userId} AND rescue_discount_offered_at IS NULL RETURNING rescue_discount_offered_at AS "offeredAt"`));
    if (!claimed) return { eligible: false as const };
    const now = Math.floor(Date.now() / 1000);
    const offerId = signOffer({ sub: userId, subscriptionId: local.stripeSubscriptionId!, plan: local.plan,
      offeredAt: new Date(claimed.offeredAt).toISOString(), iat: now, exp: now + ttlSeconds }, key);
    return { eligible: true as const, offerId, plan: BILLING_PLANS[local.plan].name, percentOff: 50 as const };
  });
}

/** Recheck persisted ownership under activation's existing customer billing lock. */
export async function assertRescueOfferClaim(executor: Pick<BillingDatabase, "execute">, userId: string,
  subscriptionId: string, plan: string | null, selectedCouponId: string, offer?: VerifiedRescueOffer): Promise<void> {
  if (!offer || offer.sub !== userId || offer.subscriptionId !== subscriptionId || offer.plan !== plan ||
    offer.couponId !== couponId || selectedCouponId !== couponId || Math.floor(Date.now() / 1000) >= offer.exp) throw new RescueOfferError();
  const [user] = resultRows<{ offeredAt: Date | null }>(await executor.execute(sql`
    SELECT rescue_discount_offered_at AS "offeredAt" FROM users WHERE id=${userId}`));
  if (!user?.offeredAt || new Date(user.offeredAt).toISOString() !== offer.offeredAt) throw new RescueOfferError();
}
