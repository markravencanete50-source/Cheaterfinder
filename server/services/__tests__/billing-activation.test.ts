import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ execute: vi.fn(), requireUser: vi.fn(), lock: vi.fn() }));
vi.mock("../customer-billing-lifecycle.js", () => ({
  requireBillingUser: storage.requireUser,
  withCustomerBillingLock: storage.lock,
}));
vi.mock("../operation-lease.js", () => ({ resultRows: (result: { rows: unknown[] }) => result.rows }));

import { activateTrialNow, activationPaymentVerified, TRIAL_ACTIVATION_POLICY } from "../billing-activation.js";

const userId = "activation_fixture", customerId = "cus_activation_fixture", subscriptionId = "sub_activation_fixture";
const api = {
  subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  customers: { retrieve: vi.fn(), retrieveSource: vi.fn() },
  paymentMethods: { retrieve: vi.fn() },
  invoices: { retrieve: vi.fn() },
};
const provider = api as unknown as Stripe;
let local: any, sub: any, customer: any, invoice: any;

beforeEach(() => {
  vi.resetAllMocks();
  const now = Math.floor(Date.now() / 1000);
  local = { stripe_subscription_id: subscriptionId, stripe_customer_id: customerId, status: "trialing", trial_ends_at: new Date((now + 86400) * 1000) };
  sub = {
    id: subscriptionId, customer: customerId, metadata: { userId, plan: "standard", existing: "preserved" },
    status: "trialing", trial_end: now + 86400, collection_method: "charge_automatically", cancel_at_period_end: false, cancel_at: null,
    default_payment_method: { id: "pm_card", type: "card", customer: customerId }, default_source: null,
    discounts: ["di_founders"], latest_invoice: "in_monthly",
    items: { data: [{ id: "si_monthly", price: { id: "price_standard", recurring: { interval: "month" } } }] },
  };
  customer = { id: customerId, metadata: { userId }, invoice_settings: { default_payment_method: null }, default_source: null };
  invoice = {
    id: "in_monthly", customer: customerId, parent: { subscription_details: { subscription: subscriptionId } },
    status: "paid", amount_paid: 1900, amount_remaining: 0, billing_reason: "subscription_cycle",
    lines: { has_more: false, data: [{ amount: 1999, parent: { subscription_item_details: { subscription_item: "si_monthly", subscription: subscriptionId, proration: false } },
      pricing: { price_details: { price: "price_standard" } }, period: { start: sub.trial_end, end: sub.trial_end + 2592000 } }] },
  };
  storage.execute.mockImplementation(async () => ({ rows: local ? [structuredClone(local)] : [] }));
  storage.lock.mockImplementation(async (_id, work) => work({ execute: storage.execute }));
  storage.requireUser.mockResolvedValue({ id: userId });
  api.subscriptions.retrieve.mockImplementation(async () => structuredClone(sub));
  api.subscriptions.update.mockImplementation(async (_id, params) => {
    sub = { ...sub, status: "active", trial_end: now, metadata: { ...sub.metadata, ...params.metadata } };
    return structuredClone(sub);
  });
  api.customers.retrieve.mockImplementation(async () => structuredClone(customer));
  api.invoices.retrieve.mockImplementation(async () => structuredClone(invoice));
});

describe("explicit trial activation — mocked persistence and Stripe", () => {
  it("ends the owned trial with a stable idempotency key without writing local state or changing plan/discounts", async () => {
    expect(await activateTrialNow(provider, userId)).toEqual({ status: "activating" });
    expect(storage.lock).toHaveBeenCalledWith(userId, expect.any(Function));
    expect(storage.requireUser.mock.invocationCallOrder[0]).toBeLessThan(storage.execute.mock.invocationCallOrder[0]);
    expect(storage.execute).toHaveBeenCalledTimes(1);
    expect(api.subscriptions.update).toHaveBeenCalledWith(subscriptionId, {
      trial_end: "now", proration_behavior: "none", metadata: { trialActivationPolicy: TRIAL_ACTIVATION_POLICY },
    }, { timeout: 15000, maxNetworkRetries: 1, idempotencyKey: `activate-trial:v1:${subscriptionId}` });
    expect(local.status).toBe("trialing");
    expect(sub.discounts).toEqual(["di_founders"]);
    expect(api.invoices.retrieve).not.toHaveBeenCalled();
  });

  it("does not allow a missing/deleted user to reach Stripe", async () => {
    await expect(activateTrialNow(provider, "")).rejects.toMatchObject({ status: 401, code: "authentication_required" });
    expect(storage.lock).not.toHaveBeenCalled();
    storage.requireUser.mockRejectedValueOnce(Error("Account no longer exists"));
    await expect(activateTrialNow(provider, userId)).rejects.toThrow("Account no longer exists");
    expect(api.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it.each(["no_local", "expired_local", "expired_stripe", "past_due", "canceled", "cancel_scheduled", "send_invoice"])("rejects %s instead of reviving or charging it", async state => {
    if (state === "no_local") local = undefined;
    if (state === "expired_local") local.trial_ends_at = new Date(0);
    if (state === "expired_stripe") sub.trial_end = 1;
    if (["past_due", "canceled"].includes(state)) sub.status = state;
    if (state === "cancel_scheduled") sub.cancel_at_period_end = true;
    if (state === "send_invoice") sub.collection_method = "send_invoice";
    await expect(activateTrialNow(provider, userId)).rejects.toMatchObject({ status: 400, code: "no_trial" });
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });

  it.each(["local", "stripe"])("returns already_active for %s active membership", async side => {
    (side === "local" ? local : sub).status = "active";
    await expect(activateTrialNow(provider, userId)).rejects.toMatchObject({ status: 409, code: "already_active" });
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });

  it.each(["subscription", "subscription_customer", "subscription_user", "customer_id", "customer_user", "customer_deleted"])("rejects mismatched %s ownership", async field => {
    if (field === "subscription") sub.id = "sub_other";
    if (field === "subscription_customer") sub.customer = "cus_other";
    if (field === "subscription_user") sub.metadata.userId = "other_user";
    if (field === "customer_id") customer.id = "cus_other";
    if (field === "customer_user") customer.metadata.userId = "other_user";
    if (field === "customer_deleted") customer.deleted = true;
    await expect(activateTrialNow(provider, userId)).rejects.toMatchObject({ status: 400, code: "billing_ownership" });
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });

  it.each(["none", "foreign", "bank"])("rejects %s effective payment method", async kind => {
    if (kind === "none") sub.default_payment_method = null;
    if (kind === "foreign") sub.default_payment_method.customer = "cus_other";
    if (kind === "bank") sub.default_payment_method.type = "us_bank_account";
    await expect(activateTrialNow(provider, userId)).rejects.toMatchObject({ status: 400, code: "no_payment_method" });
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });

  it.each(["subscription_source", "customer_method", "customer_source"])("accepts the %s fallback without changing defaults", async location => {
    sub.default_payment_method = null;
    const card = { id: "card_fixture", object: "card", customer: customerId };
    if (location === "subscription_source") {
      sub.default_source = card;
      customer.invoice_settings.default_payment_method = { type: "us_bank_account", customer: customerId };
    }
    if (location === "customer_method") customer.invoice_settings.default_payment_method = { id: "pm_customer", type: "card", customer: customerId };
    if (location === "customer_source") customer.default_source = card;
    await expect(activateTrialNow(provider, userId)).resolves.toEqual({ status: "activating" });
    expect(api.subscriptions.update.mock.calls[0][1]).not.toHaveProperty("default_payment_method");
  });

  it("resolves an unexpanded saved card and checks its owner", async () => {
    sub.default_payment_method = "pm_card";
    api.paymentMethods.retrieve.mockResolvedValue({ id: "pm_card", type: "card", customer: customerId });
    await activateTrialNow(provider, userId);
    expect(api.paymentMethods.retrieve).toHaveBeenCalledWith("pm_card", {}, expect.any(Object));
  });

  it("recovers a lost provider response without a second trial update", async () => {
    api.subscriptions.update.mockImplementationOnce(async (_id, params) => {
      sub.status = "active"; sub.metadata = { ...sub.metadata, ...params.metadata };
      throw Error("response lost");
    });
    await expect(activateTrialNow(provider, userId)).rejects.toThrow("response lost");
    await expect(activateTrialNow(provider, userId)).resolves.toEqual({ status: "activating" });
    expect(api.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(local.status).toBe("trialing");
  });

  it("retries an undelivered request with exactly the same provider body and key", async () => {
    api.subscriptions.update.mockRejectedValueOnce(Error("timeout before delivery"));
    await expect(activateTrialNow(provider, userId)).rejects.toThrow("timeout before delivery");
    await activateTrialNow(provider, userId);
    expect(api.subscriptions.update.mock.calls[1]).toEqual(api.subscriptions.update.mock.calls[0]);
  });

  it("leaves a payment failure to webhooks without granting local active status", async () => {
    api.subscriptions.update.mockImplementationOnce(async () => ({ ...sub, status: "past_due" }));
    expect(await activateTrialNow(provider, userId)).toEqual({ status: "activating" });
    expect(local.status).toBe("trialing");
    expect(storage.execute).toHaveBeenCalledTimes(1);
  });
});

describe("manual activation invoice proof", () => {
  beforeEach(() => { sub.status = "active"; sub.metadata.trialActivationPolicy = TRIAL_ACTIVATION_POLICY; });

  it("requires a paid owned recurring invoice, including when credit covers its payment", async () => {
    expect(await activationPaymentVerified(provider, sub)).toBe(true);
    invoice.amount_paid = 0;
    expect(await activationPaymentVerified(provider, sub)).toBe(true);
  });

  it.each(["draft", "open", "uncollectible", "void"])("never unlocks from an %s invoice", async status => {
    invoice.status = status;
    expect(await activationPaymentVerified(provider, sub)).toBe(false);
  });

  it.each(["missing_invoice", "wrong_invoice", "signup_99", "remaining", "customer", "subscription", "proration", "old_period", "wrong_item", "wrong_price", "zero_line"])("rejects %s as first-month proof", async issue => {
    if (issue === "missing_invoice") sub.latest_invoice = null;
    if (issue === "wrong_invoice") invoice.id = "in_other";
    if (issue === "signup_99") { invoice.billing_reason = "subscription_create"; invoice.amount_paid = 99; }
    if (issue === "remaining") invoice.amount_remaining = 1;
    if (issue === "customer") invoice.customer = "cus_other";
    if (issue === "subscription") invoice.parent.subscription_details.subscription = "sub_other";
    const line = invoice.lines.data[0];
    if (issue === "proration") line.parent.subscription_item_details.proration = true;
    if (issue === "old_period") line.period.start = sub.trial_end - 1;
    if (issue === "wrong_item") line.parent.subscription_item_details.subscription_item = "si_other";
    if (issue === "wrong_price") line.pricing.price_details.price = "price_other";
    if (issue === "zero_line") line.amount = 0;
    expect(await activationPaymentVerified(provider, sub)).toBe(false);
  });

  it("does not add provider calls to passive trial conversion or past_due synchronization", async () => {
    delete sub.metadata.trialActivationPolicy;
    expect(await activationPaymentVerified(provider, sub)).toBe(true);
    sub.metadata.trialActivationPolicy = TRIAL_ACTIVATION_POLICY; sub.status = "past_due";
    expect(await activationPaymentVerified(provider, sub)).toBe(true);
    expect(api.invoices.retrieve).not.toHaveBeenCalled();
  });
});
