import type Stripe from "stripe";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ execute: vi.fn(), requireUser: vi.fn(), lock: vi.fn() }));
vi.mock("../customer-billing-lifecycle.js", () => ({ requireBillingUser: storage.requireUser, withCustomerBillingLock: storage.lock }));
vi.mock("../operation-lease.js", () => ({ resultRows: (result: { rows: unknown[] }) => result.rows }));
vi.mock("../../observability/logger.js", () => ({ logger: { warn: vi.fn() } }));
let rescue: typeof import("../billing-rescue-offer.js");
let activation: typeof import("../billing-activation.js");
const userId = "rescue_fixture", subscriptionId = "sub_rescue_fixture", customerId = "cus_rescue_fixture";
const api = { coupons: { retrieve: vi.fn(), create: vi.fn() }, subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  customers: { retrieve: vi.fn() }, invoices: { retrieve: vi.fn() } };
const stripe = api as unknown as Stripe;
let offeredAt: Date | null, local: any, sub: any;

beforeAll(async () => {
  vi.stubEnv("STRIPE_RESCUE_COUPON_ID", "TRIAL_RESCUE_50");
  vi.stubEnv("SESSION_SECRET", "rescue-unit-test-signing-secret");
  rescue = await import("../billing-rescue-offer.js");
  activation = await import("../billing-activation.js");
});
afterAll(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
beforeEach(() => {
  vi.useRealTimers(); vi.resetAllMocks(); offeredAt = null;
  local = { plan: "starter", status: "trialing", stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId,
    trialEndsAt: new Date(Date.now() + 86400000), currentPeriodEnd: new Date(Date.now() + 86400000), cancelAtPeriodEnd: false };
  sub = { id: subscriptionId, customer: customerId, status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 86400,
    metadata: { userId }, collection_method: "charge_automatically", cancel_at_period_end: false, cancel_at: null,
    default_payment_method: { id: "pm_rescue", type: "card", customer: customerId }, default_source: null,
    discounts: ["di_founders", { id: "di_other_forever" }] };
  storage.lock.mockImplementation(async (_id, work) => work({ execute: storage.execute }));
  storage.requireUser.mockResolvedValue({ id: userId });
  storage.execute.mockImplementation(async query => {
    const text = new PgDialect().sqlToQuery(query).sql;
    if (text.includes("UPDATE users")) {
      if (offeredAt) return { rows: [] };
      offeredAt = new Date(); return { rows: [{ offeredAt }] };
    }
    if (text.includes("JOIN subscriptions")) return { rows: local ? [{ ...local, offeredAt }] : [] };
    if (text.includes("FROM subscriptions")) return { rows: local ? [{ stripe_subscription_id: local.stripeSubscriptionId,
      stripe_customer_id: local.stripeCustomerId, status: local.status, trial_ends_at: local.trialEndsAt, plan: local.plan }] : [] };
    return { rows: [{ offeredAt }] };
  });
  api.coupons.retrieve.mockResolvedValue({ id: "TRIAL_RESCUE_50", valid: true, percent_off: 50, duration: "once" });
  api.subscriptions.retrieve.mockImplementation(async () => structuredClone(sub));
  api.subscriptions.update.mockResolvedValue({ ...sub, status: "active" });
  api.customers.retrieve.mockResolvedValue({ id: customerId, metadata: { userId }, invoice_settings: { default_payment_method: null } });
});

describe("rescue offer authorization with fixture persistence", () => {
  async function claim() {
    const result = await rescue.claimRescueOffer(stripe, userId);
    if (!result.eligible) throw Error("Expected eligible fixture");
    return result;
  }
  it("issues one offer, does not expose the coupon in response/token, and never creates coupons", async () => {
    const offer = await claim();
    expect(offer).toMatchObject({ eligible: true, plan: "Starter", percentOff: 50 });
    expect(offer).not.toHaveProperty("couponId");
    expect(Buffer.from(offer.offerId.split(".")[1], "base64url").toString()).not.toContain("TRIAL_RESCUE_50");
    expect(rescue.verifyRescueOfferToken(offer.offerId, userId).exp - rescue.verifyRescueOfferToken(offer.offerId, userId).iat).toBe(600);
    expect(await rescue.claimRescueOffer(stripe, userId)).toEqual({ eligible: false });
    expect(api.coupons.create).not.toHaveBeenCalled();
  });
  it.each(["missing", "expired", "active", "canceled", "no_stripe", "weekly"])("does not stamp %s trial", async kind => {
    if (kind === "missing") local = null;
    if (kind === "expired") local.trialEndsAt = new Date(0);
    if (kind === "active") local.status = "active";
    if (kind === "canceled") local.cancelAtPeriodEnd = true;
    if (kind === "no_stripe") local.stripeCustomerId = null;
    if (kind === "weekly") local.plan = "weekly";
    expect(await rescue.claimRescueOffer(stripe, userId)).toEqual({ eligible: false });
    expect(offeredAt).toBeNull(); expect(api.coupons.retrieve).not.toHaveBeenCalled();
  });
  it("does not consume exposure when the operator coupon is invalid", async () => {
    api.coupons.retrieve.mockResolvedValue({ id: "TRIAL_RESCUE_50", valid: true, percent_off: 100, duration: "forever" });
    await expect(claim()).rejects.toMatchObject({ code: "rescue_unavailable" });
    expect(offeredAt).toBeNull();
  });
  it("does not consume exposure when signing is unavailable", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    try {
      await expect(claim()).rejects.toMatchObject({ code: "rescue_unavailable" });
      expect(offeredAt).toBeNull(); expect(api.coupons.retrieve).not.toHaveBeenCalled();
    } finally { vi.stubEnv("SESSION_SECRET", "rescue-unit-test-signing-secret"); }
  });
  it("rejects malformed, tampered, foreign and expired offers", async () => {
    const offer = await claim();
    for (const value of [null, 12, "", "fake", `${offer.offerId}x`, offer.offerId.replace(/.$/, "!")]) {
      expect(() => rescue.verifyRescueOfferToken(value, userId)).toThrow();
    }
    expect(() => rescue.verifyRescueOfferToken(offer.offerId, "other_user")).toThrow();
    const claims = rescue.verifyRescueOfferToken(offer.offerId, userId);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(claims.exp * 1000));
    expect(() => rescue.verifyRescueOfferToken(offer.offerId, userId)).toThrow();
  });
  it("applies the verified coupon after existing discounts using the separate rescue key", async () => {
    const claims = rescue.verifyRescueOfferToken((await claim()).offerId, userId);
    expect(await activation.activateTrialNow(stripe, userId, claims.couponId, claims)).toEqual({ status: "activating" });
    expect(api.subscriptions.update).toHaveBeenCalledWith(subscriptionId, {
      trial_end: "now", proration_behavior: "none", metadata: { trialActivationPolicy: "invoice-paid-v1" },
      discounts: [{ discount: "di_founders" }, { discount: "di_other_forever" }, { coupon: "TRIAL_RESCUE_50" }],
    }, { timeout: 15000, maxNetworkRetries: 1, idempotencyKey: `activate-trial:v2:${subscriptionId}:rescue` });
    expect(local.status).toBe("trialing");
  });
  it.each(["unstamped", "subscription", "plan", "coupon", "missing_claims"])("rejects %s authorization under the billing lock", async kind => {
    const claims = rescue.verifyRescueOfferToken((await claim()).offerId, userId);
    if (kind === "unstamped") offeredAt = null;
    if (kind === "subscription") local.stripeSubscriptionId = "sub_replaced";
    if (kind === "plan") local.plan = "pro";
    await expect(activation.activateTrialNow(stripe, userId, kind === "coupon" ? "attacker_coupon" : claims.couponId,
      kind === "missing_claims" ? undefined : claims)).rejects.toMatchObject({ code: "invalid_rescue_offer" });
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });
  it("warns and disables claims without consuming exposure when coupon configuration is missing", async () => {
    vi.stubEnv("STRIPE_RESCUE_COUPON_ID", ""); vi.resetModules();
    try {
      const disabled = await import("../billing-rescue-offer.js");
      const { logger } = await import("../../observability/logger.js");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("STRIPE_RESCUE_COUPON_ID is missing"));
      expect(await disabled.claimRescueOffer(stripe, userId)).toEqual({ eligible: false });
      expect(offeredAt).toBeNull(); expect(storage.lock).not.toHaveBeenCalled();
    } finally { vi.stubEnv("STRIPE_RESCUE_COUPON_ID", "TRIAL_RESCUE_50"); }
  });
});
