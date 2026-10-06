import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only the private-cluster harness may supply this database. Stripe is entirely
// simulated; these cases exercise actual SQL, billing locks and service code.
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || parsed.hostname !== "127.0.0.1" ||
    !parsed.port || parsed.port === "5432" ||
    !(parsed.port === "55439" || process.env.STRESS_NONCE &&
      (process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(parsed.port))) {
    throw new Error("Private scratch database required");
  }
  process.env.DATABASE_URL = url;
}

const userId = randomUUID(), otherId = randomUUID();
const customerId = "cus_rescue_" + userId, subscriptionId = "sub_rescue_" + userId;
const couponId = "TRIAL_RESCUE_50";

(url ? describe : describe.skip)("trial rescue — real persistence and locks, simulated Stripe", () => {
  let pool: typeof import("../../db.js").pool;
  let rescue: typeof import("../billing-rescue-offer.js");
  let activation: typeof import("../billing-activation.js");
  let lifecycle: typeof import("../customer-billing-lifecycle.js");
  let sub: any;
  const api = {
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
    customers: { retrieve: vi.fn(), retrieveSource: vi.fn() },
    paymentMethods: { retrieve: vi.fn() },
    coupons: { retrieve: vi.fn(), create: vi.fn() },
  };
  const stripe = api as unknown as Stripe;
  const offeredAt = async () => (await pool.query(
    "SELECT rescue_discount_offered_at FROM users WHERE id=$1", [userId],
  )).rows[0]?.rescue_discount_offered_at;
  const subscription = async () => (await pool.query("SELECT * FROM subscriptions WHERE user_id=$1", [userId])).rows[0];
  const otherLedgers = async () => ({
    signup: (await pool.query("SELECT * FROM billing_trial_payments WHERE subscription_id=$1", [subscriptionId])).rows,
    retention: (await pool.query("SELECT * FROM billing_retention_offers WHERE user_id=$1", [userId])).rows,
  });
  async function claim() {
    const offer = await rescue.claimRescueOffer(stripe, userId);
    if (!offer.eligible) throw new Error("Expected eligible fixture");
    return { ...offer, verified: rescue.verifyRescueOfferToken(offer.offerId, userId) };
  }
  const activate = (offer: Awaited<ReturnType<typeof claim>>) =>
    activation.activateTrialNow(stripe, userId, offer.verified.couponId, offer.verified);
  async function clean() {
    // Trial-payment records deliberately survive user deletion; remove only this
    // suite's independently generated fixture, before deleting its owned users.
    await pool.query("DELETE FROM billing_trial_payments WHERE subscription_id=$1", [subscriptionId]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [[userId, otherId]]);
  }

  beforeAll(async () => {
    vi.stubEnv("STRIPE_RESCUE_COUPON_ID", couponId);
    vi.stubEnv("SESSION_SECRET", "rescue-integration-fixture-signing-secret");
    pool = (await import("../../db.js")).pool;
    rescue = await import("../billing-rescue-offer.js");
    activation = await import("../billing-activation.js");
    lifecycle = await import("../customer-billing-lifecycle.js");
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    await clean();
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Rescue fixture'),($3,$4,'Other fixture')",
      [userId, `${userId}@example.invalid`, otherId, `${otherId}@example.invalid`]);
    await pool.query(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,trial_ends_at)
      VALUES($1,$2,$3,'trialing','standard',now()+interval '1 day')`, [userId, customerId, subscriptionId]);
    await pool.query(`INSERT INTO billing_retention_offers(user_id,offer_id,subscription_id,customer_id,state,fingerprint,
      update_params,currency,amount,regular_amount,trial,expires_at)
      VALUES($1,$2,$3,$4,'quoted','fixture','{}','usd',1000,2000,true,now()+interval '1 day')`,
    [userId, randomUUID(), subscriptionId, customerId]);
    await pool.query(`INSERT INTO billing_trial_payments(id,user_id,customer_id,subscription_id,checkout_session_id,
      invoice_id,payment_intent_id,policy_version,cancellation_policy,trial_ends_at,currency,amount,state,credit_params,paid_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'trial-credit-usd-99-v1','retain_credit',now()+interval '1 day','usd',99,'credited','{}',now())`,
    [randomUUID(), userId, customerId, subscriptionId, `cs_${userId}`, `in_${userId}`, `pi_${userId}`]);
    sub = {
      id: subscriptionId, customer: customerId, metadata: { userId, plan: "standard" }, status: "trialing",
      trial_end: Math.floor(Date.now() / 1000) + 86400, collection_method: "charge_automatically",
      cancel_at_period_end: false, cancel_at: null, pause_collection: null,
      default_payment_method: { id: "pm_rescue_fixture", type: "card", customer: customerId }, default_source: null,
      discounts: ["di_founders", { id: "di_existing_second" }],
    };
    api.subscriptions.retrieve.mockImplementation(async () => structuredClone(sub));
    api.subscriptions.update.mockImplementation(async (_id, params) => {
      sub.status = "active"; sub.metadata = { ...sub.metadata, ...params.metadata };
      return structuredClone(sub);
    });
    api.customers.retrieve.mockResolvedValue({ id: customerId, metadata: { userId },
      invoice_settings: { default_payment_method: null }, default_source: null });
    api.coupons.retrieve.mockResolvedValue({ id: couponId, valid: true, percent_off: 50, duration: "once" });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (pool) { await clean(); await pool.end(); }
    vi.unstubAllEnvs();
  });

  it("persists exposure immediately and never offers again, including after decline", async () => {
    expect(await offeredAt()).toBeNull();
    const offer = await claim(), stamp = await offeredAt();
    expect(offer).toMatchObject({ eligible: true, plan: "Standard", percentOff: 50 });
    expect(stamp).toBeInstanceOf(Date);
    expect(offer.verified.offeredAt).toBe(stamp.toISOString());
    expect(offer.verified.exp - offer.verified.iat).toBe(600);
    const response = await rescue.claimRescueOffer(stripe, userId);
    expect(response).toEqual({ eligible: false });
    expect(await offeredAt()).toEqual(stamp);
    expect(api.coupons.retrieve).toHaveBeenCalledTimes(1);
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });

  it("keeps coupon configuration out of the public response and readable JWT payload", async () => {
    const offer = await rescue.claimRescueOffer(stripe, userId);
    if (!offer.eligible) throw new Error("Expected eligible fixture");
    expect(offer).not.toHaveProperty("couponId");
    expect(JSON.stringify(offer)).not.toContain(couponId);
    expect(Buffer.from(offer.offerId.split(".")[1], "base64url").toString()).not.toContain(couponId);
    expect(rescue.verifyRescueOfferToken(offer.offerId, userId).couponId).toBe(couponId);
  });

  it("issues at most one offer during concurrent claims under the real billing lock", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => rescue.claimRescueOffer(stripe, userId)));
    const successful = outcomes.filter(result => result.status === "fulfilled" && result.value.eligible);
    expect(successful).toHaveLength(1);
    for (const result of outcomes) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(lifecycle.CustomerBillingBusyError);
    }
    expect(await offeredAt()).toBeInstanceOf(Date);
    expect(await rescue.claimRescueOffer(stripe, userId)).toEqual({ eligible: false });
  });

  it.each(["active", "expired", "canceling", "unlinked", "weekly"])("does not consume an ineligible %s trial", async reason => {
    const statements = {
      active: "UPDATE subscriptions SET status='active' WHERE user_id=$1",
      expired: "UPDATE subscriptions SET trial_ends_at=now()-interval '1 second' WHERE user_id=$1",
      canceling: "UPDATE subscriptions SET cancel_at_period_end=true WHERE user_id=$1",
      unlinked: "UPDATE subscriptions SET stripe_subscription_id=NULL WHERE user_id=$1",
      weekly: "UPDATE subscriptions SET plan='weekly' WHERE user_id=$1",
    };
    await pool.query(statements[reason as keyof typeof statements], [userId]);
    expect(await rescue.claimRescueOffer(stripe, userId)).toEqual({ eligible: false });
    expect(await offeredAt()).toBeNull();
    expect(api.coupons.retrieve).not.toHaveBeenCalled();
  });

  it.each(["wrong_percent", "wrong_duration", "invalid", "restricted", "provider_error"])("leaves exposure unused for %s coupon", async issue => {
    if (issue === "provider_error") api.coupons.retrieve.mockRejectedValueOnce(new Error("fixture Stripe failure"));
    else api.coupons.retrieve.mockResolvedValueOnce({ id: couponId, valid: issue !== "invalid",
      percent_off: issue === "wrong_percent" ? 25 : 50, duration: issue === "wrong_duration" ? "forever" : "once",
      ...(issue === "restricted" ? { applies_to: { products: ["prod_other"] } } : {}),
    });
    await expect(rescue.claimRescueOffer(stripe, userId)).rejects.toThrow();
    expect(await offeredAt()).toBeNull();
    expect(api.coupons.create).not.toHaveBeenCalled();
  });

  it("rejects malformed, tampered and foreign offer tokens", async () => {
    const offer = await claim();
    expect(() => rescue.verifyRescueOfferToken("not-a-token", userId)).toThrow(rescue.RescueOfferError);
    const [header, payload, signature] = offer.offerId.split(".");
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: otherId })).toString("base64url");
    expect(() => rescue.verifyRescueOfferToken(`${header}.${altered}.${signature}`, otherId)).toThrow(rescue.RescueOfferError);
    expect(() => rescue.verifyRescueOfferToken(offer.offerId, otherId)).toThrow(rescue.RescueOfferError);
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });

  it("expires at ten minutes and rechecks expiry inside activation's lock", async () => {
    const offer = await claim();
    vi.spyOn(Date, "now").mockReturnValue(offer.verified.exp * 1000);
    expect(() => rescue.verifyRescueOfferToken(offer.offerId, userId)).toThrow(rescue.RescueOfferError);
    await expect(activate(offer)).rejects.toBeInstanceOf(rescue.RescueOfferError);
    expect(api.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it.each(["missing_stamp", "replaced_stamp", "different_subscription", "different_plan"])("rejects %s under the activation lock", async issue => {
    const offer = await claim();
    const statements = {
      missing_stamp: "UPDATE users SET rescue_discount_offered_at=NULL WHERE id=$1",
      replaced_stamp: "UPDATE users SET rescue_discount_offered_at=rescue_discount_offered_at+interval '1 second' WHERE id=$1",
      different_subscription: "UPDATE subscriptions SET stripe_subscription_id='sub_rescue_replacement' WHERE user_id=$1",
      different_plan: "UPDATE subscriptions SET plan='pro' WHERE user_id=$1",
    };
    await pool.query(statements[issue as keyof typeof statements], [userId]);
    await expect(activate(offer)).rejects.toBeInstanceOf(rescue.RescueOfferError);
    expect(api.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });

  it("does not accept a raw coupon without verified offer context", async () => {
    await claim();
    await expect(activation.activateTrialNow(stripe, userId, couponId)).rejects.toBeInstanceOf(rescue.RescueOfferError);
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });

  it("appends rescue after all existing discounts using v2 and leaves local access and billing ledgers unchanged", async () => {
    const before = await otherLedgers(), local = await subscription(), offer = await claim();
    expect(await activate(offer)).toEqual({ status: "activating" });
    expect(api.subscriptions.update).toHaveBeenCalledExactlyOnceWith(subscriptionId, {
      trial_end: "now", proration_behavior: "none", metadata: { trialActivationPolicy: activation.TRIAL_ACTIVATION_POLICY },
      discounts: [{ discount: "di_founders" }, { discount: "di_existing_second" }, { coupon: couponId }],
    }, { timeout: 15000, maxNetworkRetries: 1, idempotencyKey: `activate-trial:v2:${subscriptionId}:rescue` });
    expect(await subscription()).toEqual(local);
    expect(await otherLedgers()).toEqual(before);
    expect(api.coupons.create).not.toHaveBeenCalled();
  });

  it("preserves the v1 ordinary activation body and does not claim rescue", async () => {
    expect(await activation.activateTrialNow(stripe, userId)).toEqual({ status: "activating" });
    expect(api.subscriptions.update).toHaveBeenCalledExactlyOnceWith(subscriptionId, {
      trial_end: "now", proration_behavior: "none", metadata: { trialActivationPolicy: activation.TRIAL_ACTIVATION_POLICY },
    }, { timeout: 15000, maxNetworkRetries: 1, idempotencyKey: `activate-trial:v1:${subscriptionId}` });
    expect(await offeredAt()).toBeNull();
    expect(api.coupons.retrieve).not.toHaveBeenCalled();
  });

  it("recovers a lost Stripe success response without applying rescue twice", async () => {
    const offer = await claim();
    api.subscriptions.update.mockImplementationOnce(async (_id, params) => {
      sub.status = "active"; sub.metadata = { ...sub.metadata, ...params.metadata };
      throw new Error("fixture response lost");
    });
    await expect(activate(offer)).rejects.toThrow("fixture response lost");
    await expect(activate(offer)).resolves.toEqual({ status: "activating" });
    expect(api.subscriptions.update).toHaveBeenCalledTimes(1);
    expect((await subscription()).status).toBe("trialing");
  });

  it("retries an undelivered rescue update with identical body and key", async () => {
    const offer = await claim();
    api.subscriptions.update.mockRejectedValueOnce(new Error("fixture request not delivered"));
    await expect(activate(offer)).rejects.toThrow("fixture request not delivered");
    await expect(activate(offer)).resolves.toEqual({ status: "activating" });
    expect(api.subscriptions.update.mock.calls[1]).toEqual(api.subscriptions.update.mock.calls[0]);
    expect(api.subscriptions.update).toHaveBeenCalledTimes(2);
  });
});
