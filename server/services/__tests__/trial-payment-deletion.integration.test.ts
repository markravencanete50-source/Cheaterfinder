import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !parsed.port || parsed.port === "5432") throw new Error("Private scratch database required");
  process.env.DATABASE_URL = url;
}
const userId = randomUUID(), paymentId = randomUUID();
const customerId = "cus_deletion_trial_" + userId, subscriptionId = "sub_deletion_trial_" + userId;
const intentId = "pi_deletion_trial_" + userId, invoiceId = "in_deletion_trial_" + userId;
const policy = "trial-credit-usd-99-v1";

(url ? describe : describe.skip)("trial advance account deletion — actual ledger/lifecycle, simulated Stripe", () => {
  let pool: typeof import("../../db.js").pool;
  let lifecycle: typeof import("../customer-billing-lifecycle.js");
  let sub: any, charge: any, balance: number, transactions: any[], refunds: any[], steps: string[];
  const api = {
    customers: { search: vi.fn(), retrieve: vi.fn(), del: vi.fn(), listBalanceTransactions: vi.fn(), createBalanceTransaction: vi.fn() },
    subscriptions: { list: vi.fn(), cancel: vi.fn() },
    paymentIntents: { retrieve: vi.fn() }, invoices: { list: vi.fn() },
    refunds: { list: vi.fn(), create: vi.fn() },
  };
  const stripe = api as unknown as Stripe;
  const exists = async () => (await pool.query("SELECT id FROM users WHERE id=$1", [userId])).rowCount === 1;
  const ledger = async () => (await pool.query("SELECT * FROM billing_trial_payments WHERE id=$1", [paymentId])).rows[0];
  const remove = () => lifecycle.deleteCustomerAccount(userId, stripe);
  const setPolicy = async (value: "refund_during_trial" | "retain_credit") => {
    sub.metadata.trialCancellationPolicy = value;
    await pool.query("UPDATE billing_trial_payments SET cancellation_policy=$1 WHERE id=$2", [value, paymentId]);
    await pool.query("UPDATE subscriptions SET trial_cancellation_policy=$1 WHERE user_id=$2", [value, userId]);
  };

  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    lifecycle = await import("../customer-billing-lifecycle.js");
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM billing_trial_payments WHERE id=$1", [paymentId]);
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Deletion billing fixture')", [userId, userId + "@example.invalid"]);
    await lifecycle.saveStripeCustomerLink(userId, customerId);
    const now = Math.floor(Date.now() / 1000), trialEnd = now + 3 * 86400;
    sub = { id: subscriptionId, customer: customerId, status: "trialing", trial_end: trialEnd, canceled_at: null,
      cancel_at_period_end: false, cancel_at: null,
      metadata: { userId, trialPaymentPolicy: policy, trialCancellationPolicy: "retain_credit", trialPaymentPriceId: "price_trial_fixture" } };
    const params = { amount: -99, currency: "usd", description: "Trial payment credit", metadata: {
      trialPaymentId: paymentId, trialPaymentPolicy: policy, subscriptionId, invoiceId,
    } };
    await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,trial_ends_at,trial_payment_policy,trial_cancellation_policy) VALUES($1,$2,$3,'trialing',$4,$5,'retain_credit')",
      [userId, customerId, subscriptionId, new Date(trialEnd * 1000), policy]);
    await pool.query(`INSERT INTO billing_trial_payments(id,user_id,customer_id,subscription_id,checkout_session_id,invoice_id,payment_intent_id,
      policy_version,cancellation_policy,trial_ends_at,currency,amount,state,credit_params,credit_requested_at,credit_transaction_id,paid_at,credited_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'retain_credit',$9,'usd',99,'credited',$10,now(),'cbtxn_deletion_credit',now(),now())`,
      [paymentId, userId, customerId, subscriptionId, "cs_deletion_trial_" + userId, invoiceId, intentId, policy, new Date(trialEnd * 1000), params]);
    charge = { id: "ch_deletion_fixture", customer: customerId, payment_intent: intentId, currency: "usd", amount: 99,
      amount_captured: 99, paid: true, captured: true, amount_refunded: 0, refunded: false, disputed: false };
    balance = -99; refunds = []; steps = [];
    transactions = [{ id: "cbtxn_deletion_credit", customer: customerId, type: "adjustment", ...params, ending_balance: -99, created: now }];
    vi.resetAllMocks();
    api.customers.search.mockResolvedValue({ data: [], has_more: false });
    api.customers.retrieve.mockImplementation(async (id: string) => ({ id, metadata: { userId }, balance, invoice_credit_balance: { usd: balance } }));
    api.customers.del.mockImplementation(async (id: string) => { steps.push("delete"); expect(await exists()).toBe(true); return { id, deleted: true }; });
    api.subscriptions.list.mockImplementation(async () => ({ data: [structuredClone(sub)], has_more: false }));
    api.subscriptions.cancel.mockImplementation(async (id: string) => {
      expect(id).toBe(subscriptionId); steps.push("cancel");
      sub = { ...sub, status: "canceled", canceled_at: Math.floor(Date.now() / 1000), cancel_at_period_end: false };
      return structuredClone(sub);
    });
    api.paymentIntents.retrieve.mockImplementation(async () => ({ id: intentId, customer: customerId, currency: "usd", amount: 99,
      amount_received: 99, status: "succeeded", latest_charge: structuredClone(charge) }));
    api.invoices.list.mockResolvedValue({ data: [], has_more: false });
    api.customers.listBalanceTransactions.mockImplementation(async () => ({ data: structuredClone(transactions), has_more: false }));
    api.customers.createBalanceTransaction.mockImplementation(async (id: string, value: any) => {
      expect(id).toBe(customerId); expect(sub.status).toBe("canceled"); steps.push(value.amount === 99 ? "reverse" : "compensate");
      balance += value.amount;
      const transaction = { id: "cbtxn_deletion_" + value.metadata.trialPaymentAction, customer: customerId, type: "adjustment", ...value, ending_balance: balance };
      transactions.unshift(transaction); return structuredClone(transaction);
    });
    api.refunds.list.mockImplementation(async () => ({ data: structuredClone(refunds), has_more: false }));
    api.refunds.create.mockImplementation(async (value: any) => {
      expect((await ledger()).credit_reversal_transaction_id).toBeTruthy(); steps.push("refund");
      const refund = { id: "re_deletion_fixture", currency: "usd", status: "succeeded", ...value };
      refunds.push(refund); charge.amount_refunded = 99; charge.refunded = true; return structuredClone(refund);
    });
  });
  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM billing_trial_payments WHERE id=$1", [paymentId]);
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await pool.end();
  });

  it("cancels a refundable trial and settles reversal/refund before deleting the Stripe customer", async () => {
    await setPolicy("refund_during_trial");
    await remove();
    expect(steps).toEqual(["cancel", "reverse", "refund", "delete"]);
    expect(api.subscriptions.cancel).toHaveBeenCalledWith(subscriptionId, { invoice_now: false, prorate: false }, expect.any(Object));
    expect(await exists()).toBe(false);
    expect(await ledger()).toMatchObject({ user_id: null, customer_id: customerId, state: "refunded", refund_id: "re_deletion_fixture" });
    expect((await pool.query("SELECT * FROM subscriptions WHERE user_id=$1", [userId])).rowCount).toBe(0);
  });
  it("preserves the account and customer when a refund is processing", async () => {
    await setPolicy("refund_during_trial");
    api.refunds.create.mockImplementationOnce(async (value: any) => { const refund = { id: "re_pending_fixture", currency: "usd", status: "pending", ...value }; refunds.push(refund); return refund; });
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(await exists()).toBe(true); expect((await ledger()).state).toBe("refund_pending");
    expect(api.customers.del).not.toHaveBeenCalled();
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(api.refunds.create).toHaveBeenCalledTimes(1); expect(api.customers.del).not.toHaveBeenCalled();
  });
  it("preserves the account after an ambiguous refund and safely retries deletion after reconciliation", async () => {
    await setPolicy("refund_during_trial");
    const original = api.refunds.create.getMockImplementation()!;
    api.refunds.create.mockImplementationOnce(async value => { await original(value); throw Error("refund response lost"); });
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(await exists()).toBe(true); expect(api.customers.del).not.toHaveBeenCalled();
    await remove();
    expect(api.refunds.create).toHaveBeenCalledTimes(1); expect(api.customers.del).toHaveBeenCalledTimes(1);
    expect(await ledger()).toMatchObject({ user_id: null, state: "refunded" });
  });
  it("does not cancel or forfeit retained unused credit during deletion", async () => {
    await expect(remove()).rejects.toThrow("unused billing credit");
    expect(await exists()).toBe(true); expect((await ledger()).state).toBe("credited");
    expect(api.subscriptions.cancel).not.toHaveBeenCalled(); expect(api.refunds.create).not.toHaveBeenCalled();
    expect(api.customers.createBalanceTransaction).not.toHaveBeenCalled(); expect(api.customers.del).not.toHaveBeenCalled();
  });
  it("can close a retained-credit account after its available USD balance reaches zero", async () => {
    balance = 0;
    await remove();
    expect(api.customers.del).toHaveBeenCalledTimes(1); expect(await exists()).toBe(false);
    expect(await ledger()).toMatchObject({ user_id: null, state: "credited", amount: 99 });
    expect(api.refunds.create).not.toHaveBeenCalled();
  });
  it("reads the authoritative USD invoice balance even if the generic balance is zero", async () => {
    api.customers.retrieve.mockResolvedValue({ id: customerId, metadata: { userId }, balance: 0, invoice_credit_balance: { usd: -99 } });
    await expect(remove()).rejects.toThrow("unused billing credit"); expect(api.customers.del).not.toHaveBeenCalled();
  });
  it.each(["manual_review", "refund_pending", "reversal_pending", "compensation_pending"])("does not erase a %s financial operation", async state => {
    await pool.query("UPDATE billing_trial_payments SET state=$1 WHERE id=$2", [state, paymentId]);
    balance = 0;
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(await exists()).toBe(true); expect((await ledger()).state).toBe(state);
    expect(api.customers.del).not.toHaveBeenCalled();
  });
  it.each(["paid", "credit_pending"])("preserves a %s credit while its provider result cannot be reconciled", async state => {
    await pool.query("UPDATE billing_trial_payments SET state=$1,credit_transaction_id=NULL WHERE id=$2", [state, paymentId]);
    api.customers.listBalanceTransactions.mockRejectedValue(Error("billing history unavailable"));
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(await exists()).toBe(true); expect((await ledger()).state).toBe(state);
    expect(api.customers.del).not.toHaveBeenCalled(); expect(api.refunds.create).not.toHaveBeenCalled();
  });
  it("does not reverse or refund if immediate cancellation was not confirmed", async () => {
    await setPolicy("refund_during_trial");
    api.subscriptions.cancel.mockImplementationOnce(async () => structuredClone(sub));
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(await exists()).toBe(true); expect((await ledger()).state).toBe("credited");
    expect(api.customers.createBalanceTransaction).not.toHaveBeenCalled(); expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.del).not.toHaveBeenCalled();
  });
  it("keeps the account when an earlier invoice consumed the refundable advance", async () => {
    await setPolicy("refund_during_trial"); balance = 0;
    transactions.unshift({ id: "cbtxn_spent_fixture", customer: customerId, currency: "usd", type: "applied_to_invoice", amount: 99, ending_balance: 0, metadata: {} });
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(await exists()).toBe(true); expect((await ledger()).state).toBe("manual_review");
    expect(api.customers.del).not.toHaveBeenCalled(); expect(api.refunds.create).not.toHaveBeenCalled();
  });
  it("does not treat a remotely deleted customer as proof that its pending refund settled", async () => {
    await pool.query("UPDATE billing_trial_payments SET state='refund_pending' WHERE id=$1", [paymentId]);
    api.customers.retrieve.mockResolvedValue({ id: customerId, deleted: true });
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(await exists()).toBe(true); expect((await ledger()).state).toBe("refund_pending");
    expect(api.customers.del).not.toHaveBeenCalled();
  });
  it("rejects a different customer owner before any irreversible billing action", async () => {
    await setPolicy("refund_during_trial");
    api.customers.retrieve.mockResolvedValue({ id: customerId, metadata: { userId: "another_user" }, balance: 0 });
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(api.subscriptions.cancel).not.toHaveBeenCalled(); expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.del).not.toHaveBeenCalled();
  });
  it("rejects a different subscription owner without mutating it", async () => {
    await setPolicy("refund_during_trial"); sub.metadata.userId = "another_user";
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(api.subscriptions.cancel).not.toHaveBeenCalled(); expect(api.customers.del).not.toHaveBeenCalled(); expect(await exists()).toBe(true);
  });
  it("refuses incomplete provider subscription history before deletion", async () => {
    balance = 0; api.subscriptions.list.mockResolvedValue({ data: [sub], has_more: true });
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(api.customers.del).not.toHaveBeenCalled(); expect(await exists()).toBe(true);
  });
  it("does not erase a ledger merely because provider policy metadata was removed", async () => {
    balance = 0; delete sub.metadata.trialPaymentPolicy;
    await pool.query("UPDATE billing_trial_payments SET state='manual_review' WHERE id=$1", [paymentId]);
    await expect(remove()).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(api.customers.del).not.toHaveBeenCalled(); expect(await exists()).toBe(true);
  });
  it("allows fully settled refunds with zero balance to close even after a subscription was resumed", async () => {
    await setPolicy("refund_during_trial"); balance = 0; sub.status = "active";
    await pool.query("UPDATE billing_trial_payments SET state='refunded',refund_id='re_settled_fixture',refunded_at=now() WHERE id=$1", [paymentId]);
    await remove();
    expect(api.customers.del).toHaveBeenCalledTimes(1); expect(api.refunds.create).not.toHaveBeenCalled();
    expect(await ledger()).toMatchObject({ user_id: null, state: "refunded" });
  });
});
