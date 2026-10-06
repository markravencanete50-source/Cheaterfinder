import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutOffer,
  checkoutTrialDisclosure,
  requireCurrentCheckoutOffer,
  trialPaymentConfiguration,
  TrialPaymentConfigurationError,
  verifyTrialPaymentConfiguration,
} from "../trial-payment-offer.js";

describe("99-cent trial offer — provider configuration and explicit customer terms", () => {
  const api = {
    prices: { retrieve: vi.fn() },
    coupons: { retrieve: vi.fn() },
    paymentMethodConfigurations: { retrieve: vi.fn() },
    billingPortal: { configurations: { retrieve: vi.fn() } },
  };
  const stripe = api as unknown as Stripe;
  let advance: any, recurring: any, coupon: any, methods: any;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_ENABLED", "true");
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_PRICE_ID", "price_advance");
    vi.stubEnv("STRIPE_TRIAL_PAYMENT_METHOD_CONFIG_ID", "pmc_immediate");
    vi.stubEnv("STRIPE_TRIAL_REFUND_PORTAL_CONFIG_ID", "bpc_immediate_refund");
    vi.stubEnv("STRIPE_TRIAL_CANCELLATION_POLICY", "refund_during_trial");
    for (const plan of ["starter", "standard", "pro"]) vi.stubEnv(`STRIPE_TRIAL_FOUNDERS_COUPON_${plan.toUpperCase()}`, `coupon_scoped_${plan}`);
    advance = { id: "price_advance", active: true, currency: "usd", unit_amount: 99, type: "one_time", recurring: null, product: "prod_advance" };
    recurring = { id: "price_standard", active: true, currency: "usd", unit_amount: 2799, type: "recurring", product: "prod_standard",
      recurring: { interval: "month", interval_count: 1 } };
    coupon = { id: "coupon_scoped_standard", valid: true, currency: "usd", duration: "forever", amount_off: 800, percent_off: null,
      applies_to: { products: ["prod_starter", "prod_standard", "prod_pro"] } };
    methods = { id: "pmc_immediate", active: true, card: { available: true, display_preference: { value: "on" } },
      apple_pay: { display_preference: { value: "on" } }, google_pay: { display_preference: { value: "on" } },
      us_bank_account: { display_preference: { value: "off" } } };
    api.prices.retrieve.mockImplementation(async id => structuredClone(id === "price_advance" ? advance : recurring));
    api.coupons.retrieve.mockImplementation(async (_id, params?: Stripe.CouponRetrieveParams) => {
      const result = structuredClone(coupon);
      // Stripe omits this includable property unless the caller requests it.
      if (!params?.expand?.includes("applies_to")) delete result.applies_to;
      return result;
    });
    api.paymentMethodConfigurations.retrieve.mockImplementation(async () => structuredClone(methods));
    api.billingPortal.configurations.retrieve.mockResolvedValue({ id: "bpc_immediate_refund", active: true,
      features: { subscription_cancel: { enabled: true, mode: "immediately" } } });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["starter", 1199, 1100],
    ["standard", 1999, 1900],
    ["pro", 3499, 3400],
  ] as const)("discloses %s trial collection and the full account credit separately from recurring price", (plan, recurringAmount, firstMonthlyAmount) => {
    expect(checkoutOffer(plan, true)).toMatchObject({ plan, currency: "usd", trialDays: 3,
      dueTodayAmount: 99, creditAmount: 99, recurringAmount, firstMonthlyAmount,
      requiresAcceptance: true, cancellationPolicy: "refund_during_trial" });
  });
  it("keeps existing no-version clients on their original terms while the feature is off", async () => {
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_ENABLED", "false");
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_PRICE_ID", "invalid-unused-price");
    const offer = checkoutOffer("standard", true);
    expect(offer).toMatchObject({ version: "subscription-v1:standard:trial", dueTodayAmount: 0, creditAmount: 0,
      firstMonthlyAmount: 1999, requiresAcceptance: false, cancellationPolicy: "none" });
    expect(() => requireCurrentCheckoutOffer(offer)).not.toThrow();
    expect(trialPaymentConfiguration()).toBeNull();
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).resolves.toBeNull();
    expect(api.prices.retrieve).not.toHaveBeenCalled();
    expect(api.coupons.retrieve).not.toHaveBeenCalled();
    expect(api.paymentMethodConfigurations.retrieve).not.toHaveBeenCalled();
    expect(api.billingPortal.configurations.retrieve).not.toHaveBeenCalled();
  });
  it("does not apply the trial payment to an account that already used its trial", () => {
    const offer = checkoutOffer("standard", false);
    expect(offer).toMatchObject({ version: "subscription-v1:standard:paid", trialDays: 0, dueTodayAmount: 1999,
      creditAmount: 0, firstMonthlyAmount: 1999, requiresAcceptance: false, cancellationPolicy: "none" });
    expect(() => requireCurrentCheckoutOffer(offer)).not.toThrow();
  });
  it("rejects absent consent, stale free-trial consent, and another plan's consent", () => {
    const offer = checkoutOffer("standard", true);
    for (const version of [undefined, "subscription-v1:standard:trial", checkoutOffer("starter", true).version]) {
      expect(() => requireCurrentCheckoutOffer(offer, version)).toThrow("Checkout terms changed");
    }
    expect(() => requireCurrentCheckoutOffer(offer, offer.version)).not.toThrow();
  });
  it("requires renewed acceptance when the cancellation policy changes", () => {
    const original = checkoutOffer("standard", true);
    vi.stubEnv("STRIPE_TRIAL_CANCELLATION_POLICY", "retain_credit");
    const revised = checkoutOffer("standard", true);
    expect(revised.version).not.toBe(original.version);
    expect(() => requireCurrentCheckoutOffer(revised, original.version)).toThrow("Checkout terms changed");
    expect(() => requireCurrentCheckoutOffer(revised, revised.version)).not.toThrow();
  });
  it.each([
    ["STRIPE_TRIAL_ADVANCE_PRICE_ID", ""],
    ["STRIPE_TRIAL_PAYMENT_METHOD_CONFIG_ID", ""],
    ["STRIPE_TRIAL_REFUND_PORTAL_CONFIG_ID", ""],
    ["STRIPE_TRIAL_CANCELLATION_POLICY", ""],
    ["STRIPE_TRIAL_CANCELLATION_POLICY", "unspecified"],
    ["STRIPE_TRIAL_FOUNDERS_COUPON_PRO", "   "],
  ])("fails closed when required enabled configuration %s is missing or invalid", (name, value) => {
    vi.stubEnv(name, value);
    expect(() => checkoutOffer("standard", true)).toThrow(TrialPaymentConfigurationError);
  });
  it("accepts a product-scoped founder discount without allowing that discount to consume the advance", async () => {
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).resolves.toMatchObject({
      priceId: "price_advance", paymentMethodConfiguration: "pmc_immediate", coupons: { standard: "coupon_scoped_standard" },
    });
    expect(api.coupons.retrieve).toHaveBeenCalledWith("coupon_scoped_standard", { expand: ["applies_to"] });
    expect(api.paymentMethodConfigurations.retrieve).toHaveBeenCalledWith("pmc_immediate");
  });
  it("retrieves hidden product restrictions when checking the retain-credit offer", async () => {
    vi.stubEnv("STRIPE_TRIAL_CANCELLATION_POLICY", "retain_credit");
    coupon.applies_to.products = ["prod_standard"];
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard"))
      .resolves.toMatchObject({ cancellationPolicy: "retain_credit" });
    expect(api.coupons.retrieve).toHaveBeenCalledExactlyOnceWith("coupon_scoped_standard", { expand: ["applies_to"] });
    // Expansion must reveal an unsafe scope as well, rather than bypassing it.
    coupon.applies_to.products.push("prod_advance");
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard"))
      .rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it.each(["unrestricted", "includes advance", "wrong recurring product"])("rejects a coupon that is %s", async condition => {
    if (condition === "unrestricted") delete coupon.applies_to;
    else coupon.applies_to.products = condition === "includes advance" ? ["prod_standard", "prod_advance"] : ["prod_starter"];
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it.each([
    ["amount_off", 799], ["percent_off", 50], ["currency", "eur"], ["duration", "once"], ["valid", false],
  ])("rejects a founder coupon whose %s would change the disclosed recurring terms", async (field, value) => {
    coupon[field as string] = value;
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it.each([98, 100])("rejects an advance price of %s cents instead of 99", async amount => {
    advance.unit_amount = amount;
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it("rejects an advance accidentally configured as a recurring charge", async () => {
    advance.recurring = { interval: "month", interval_count: 1 };
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it("rejects recurring price changes that would charge more than the accepted monthly amount", async () => {
    recurring.unit_amount = 2999;
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it("supports expanded product references without weakening deposit exclusion", async () => {
    advance.product = { id: "prod_advance" };
    recurring.product = { id: "prod_standard" };
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).resolves.not.toBeNull();
    advance.product.id = "prod_standard";
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it.each(["us_bank_account", "sepa_debit", "link", "future_delayed_method"])("rejects enabled %s that could delay the initial payment beyond the trial", async method => {
    methods[method] = { display_preference: { value: "on" } };
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it("rejects inactive configurations and configurations without card collection", async () => {
    methods.active = false;
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
    methods.active = true;
    methods.card.display_preference.value = "off";
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it("rejects card display that is enabled but unavailable to the Stripe account", async () => {
    methods.card.available = false;
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it.each([
    { active: false, enabled: true, mode: "immediately" },
    { active: true, enabled: false, mode: "immediately" },
    { active: true, enabled: true, mode: "at_period_end" },
  ])("refuses a refundable trial when the portal cannot end access immediately ($active/$enabled/$mode)", async values => {
    api.billingPortal.configurations.retrieve.mockResolvedValue({ active: values.active,
      features: { subscription_cancel: { enabled: values.enabled, mode: values.mode } } });
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).rejects.toBeInstanceOf(TrialPaymentConfigurationError);
  });
  it("does not require or read the immediate-refund portal for a retain-credit policy", async () => {
    vi.stubEnv("STRIPE_TRIAL_CANCELLATION_POLICY", "retain_credit");
    vi.stubEnv("STRIPE_TRIAL_REFUND_PORTAL_CONFIG_ID", "");
    await expect(verifyTrialPaymentConfiguration(stripe, "standard", "price_standard")).resolves.toMatchObject({ cancellationPolicy: "retain_credit" });
    expect(api.billingPortal.configurations.retrieve).not.toHaveBeenCalled();
  });
  it("discloses account-credit timing, renewal, taxes and the selected cancellation treatment", () => {
    const refund = checkoutTrialDisclosure(checkoutOffer("standard", true));
    expect(refund).toContain("US$0.99 charged today and credited once to your next invoice");
    expect(refund).toContain("US$19.99/month");
    expect(refund).toContain("refund of your unused 99-cent advance");
    expect(refund).toContain("end access immediately");
    expect(refund).toContain("before applicable tax");
    expect(refund).toContain("plan change may use the credit earlier");
    vi.stubEnv("STRIPE_TRIAL_CANCELLATION_POLICY", "retain_credit");
    const retained = checkoutTrialDisclosure(checkoutOffer("standard", true));
    expect(retained).toContain("stays as account credit for a future invoice");
    expect(retained).toContain("not refunded in cash");
  });
});
