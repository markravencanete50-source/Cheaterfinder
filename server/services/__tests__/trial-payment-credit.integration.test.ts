import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.port === "5432" || !parsed.port) throw new Error("Private scratch database required");
  process.env.DATABASE_URL = url;
}
const userId = randomUUID();
const customerId = "cus_trial_credit_fixture_" + userId;
const subscriptionId = "sub_trial_credit_fixture_" + userId;
const policy = "trial-credit-usd-99-v1";

(url ? describe : describe.skip)("99-cent trial credit — real ledger and locks, simulated Stripe", () => {
  let pool: typeof import("../../db.js").pool;
  let service: typeof import("../trial-payment-credit.js");
  let lifecycle: typeof import("../customer-billing-lifecycle.js");
  const api = {
    checkout: { sessions: { list: vi.fn(), retrieve: vi.fn(), listLineItems: vi.fn() } },
    invoices: { retrieve: vi.fn(), list: vi.fn() }, charges: { retrieve: vi.fn() }, paymentIntents: { retrieve: vi.fn() },
    customers: { listBalanceTransactions: vi.fn(), createBalanceTransaction: vi.fn() },
    refunds: { list: vi.fn(), create: vi.fn(), retrieve: vi.fn() },
  };
  const stripe = api as unknown as Stripe;
  let sub: any, session: any, invoice: any, lines: any, charge: any, transactions: any[], refunds: any[];
  const ledger = async () => (await pool.query("SELECT * FROM billing_trial_payments WHERE subscription_id=$1", [subscriptionId])).rows[0];
  const reconcile = () => lifecycle.withCustomerBillingLock(userId, executor => service.reconcileTrialPaymentCredit(stripe, sub, executor));
  const cancelReconcile = () => lifecycle.withCustomerBillingLock(userId, executor => service.reconcileTrialPaymentCancellation(stripe, sub, executor));
  const externalReconcile = () => lifecycle.withCustomerBillingLock(userId, executor => service.reconcileTrialPaymentExternalReversal(stripe, sub, executor));
  const successfulCredit = async (_customer: string, params: any) => {
    const action = params.metadata.trialPaymentAction;
    expect((await ledger()).state).toBe(action === "refund_reversal" ? "reversal_pending" : action === "refund_compensation" ? "compensation_pending" : "credit_pending");
    const transaction = { id: "cbtxn_fixture" + (action ? "_" + action : ""), customer: customerId, type: "adjustment", ...params,
      created: Math.floor(Date.now() / 1000), ending_balance: (transactions[0]?.ending_balance ?? 0) + params.amount };
    transactions.unshift(transaction);
    return structuredClone(transaction);
  };
  const enableRefundPolicy = () => { sub.metadata.trialCancellationPolicy = "refund_during_trial"; session.metadata.trialCancellationPolicy = "refund_during_trial"; };
  const confirmCancellation = () => { sub.status = "canceled"; sub.cancel_at_period_end = false; sub.canceled_at = Math.floor(Date.now() / 1000); };

  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    service = await import("../trial-payment-credit.js");
    lifecycle = await import("../customer-billing-lifecycle.js");
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM billing_trial_payments WHERE customer_id=$1", [customerId]);
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Trial payment fixture')", [userId, userId + "@example.invalid"]);
    await lifecycle.saveStripeCustomerLink(userId, customerId);
    const now = Math.floor(Date.now() / 1000);
    sub = { id: subscriptionId, customer: customerId, status: "trialing", trial_end: now + 3 * 86400,
      metadata: { userId, trialPaymentPolicy: policy, trialPaymentPriceId: "price_trial_fixture", trialCancellationPolicy: "retain_credit" } };
    session = { id: "cs_trial_fixture", mode: "subscription", subscription: subscriptionId, customer: customerId,
      client_reference_id: userId, metadata: { ...sub.metadata }, status: "complete", payment_status: "paid", currency: "usd", amount_total: 99, invoice: "in_trial_fixture" };
    lines = { has_more: false, data: [
      { id: "li_deposit_fixture", quantity: 1, currency: "usd", amount_total: 99, amount_discount: 0,
        price: { id: "price_trial_fixture", type: "one_time", currency: "usd", unit_amount: 99 } },
      { id: "li_recurring_fixture", quantity: 1, currency: "usd", amount_total: 0, amount_discount: 0,
        price: { id: "price_monthly_fixture", type: "recurring", currency: "usd", unit_amount: 1999, recurring: { interval: "month", interval_count: 1 } } },
    ] };
    invoice = { id: "in_trial_fixture", customer: customerId, parent: { subscription_details: { subscription: subscriptionId } },
      billing_reason: "subscription_create", currency: "usd", total: 99, amount_paid: 99, amount_remaining: 0, status: "paid", status_transitions: { paid_at: now },
      payments: { has_more: false, data: [{ id: "inpay_trial_fixture", invoice: "in_trial_fixture", status: "paid", amount_paid: 99, currency: "usd",
        payment: { type: "payment_intent", payment_intent: { id: "pi_trial_fixture", customer: customerId, status: "succeeded", currency: "usd", amount: 99, amount_received: 99, latest_charge: "ch_trial_fixture" } } }] } };
    charge = { id: "ch_trial_fixture", customer: customerId, payment_intent: "pi_trial_fixture", status: "succeeded", paid: true, captured: true,
      currency: "usd", amount: 99, amount_captured: 99, amount_refunded: 0, refunded: false, disputed: false };
    transactions = []; refunds = [];
    vi.resetAllMocks();
    api.checkout.sessions.list.mockImplementation(async () => ({ data: [structuredClone(session)], has_more: false }));
    api.checkout.sessions.retrieve.mockImplementation(async () => structuredClone(session));
    api.checkout.sessions.listLineItems.mockImplementation(async () => structuredClone(lines));
    api.invoices.retrieve.mockImplementation(async () => structuredClone(invoice));
    api.invoices.list.mockResolvedValue({ data: [], has_more: false });
    api.charges.retrieve.mockImplementation(async () => structuredClone(charge));
    api.paymentIntents.retrieve.mockImplementation(async () => ({ ...structuredClone(invoice.payments.data[0].payment.payment_intent), latest_charge: structuredClone(charge) }));
    api.customers.listBalanceTransactions.mockImplementation(async () => ({ data: structuredClone(transactions), has_more: false }));
    api.customers.createBalanceTransaction.mockImplementation(successfulCredit);
    api.refunds.list.mockImplementation(async () => ({ data: structuredClone(refunds), has_more: false }));
    api.refunds.retrieve.mockImplementation(async refundId => {
      const refund = refunds.find(item => item.id === refundId);
      if (!refund) throw Error("Refund fixture missing");
      return structuredClone(refund);
    });
    api.refunds.create.mockImplementation(async params => {
      expect((await ledger()).state).toBe("refund_pending");
      expect((await ledger()).credit_reversal_transaction_id).toBeTruthy();
      const refund = { id: "re_trial_fixture", status: "succeeded", currency: "usd", ...params };
      refunds.push(refund); charge.amount_refunded = 99; charge.refunded = true;
      return structuredClone(refund);
    });
  });
  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM billing_trial_payments WHERE customer_id=$1", [customerId]);
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await pool.end();
  });

  it("bypasses every new database/provider operation for grandfathered subscriptions", async () => {
    const executor = { execute: vi.fn(() => { throw Error("must not query"); }) };
    await expect(service.reconcileTrialPaymentCredit(stripe, { metadata: {} } as Stripe.Subscription, executor as any))
      .resolves.toEqual({ required: false, paid: false, credited: false });
    expect(executor.execute).not.toHaveBeenCalled(); expect(api.checkout.sessions.list).not.toHaveBeenCalled();
  });
  it.each(["unpaid", "no_payment_required"])("does not activate or credit a complete %s checkout", async status => {
    session.payment_status = status;
    expect(await reconcile()).toEqual({ required: true, paid: false, credited: false });
    expect(await ledger()).toBeUndefined(); expect(api.invoices.retrieve).not.toHaveBeenCalled();
    expect(api.customers.createBalanceTransaction).not.toHaveBeenCalled();
  });
  it("waits for Checkout linkage when the subscription webhook arrives first", async () => {
    api.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false });
    expect(await reconcile()).toEqual({ required: true, paid: false, credited: false });
    expect(await ledger()).toBeUndefined();
  });
  it("captures an exact proof, freezes money parameters, and issues one credit across replays", async () => {
    expect(await reconcile()).toEqual({ required: true, paid: true, credited: true });
    const row = await ledger();
    expect(row).toMatchObject({ user_id: userId, customer_id: customerId, subscription_id: subscriptionId,
      amount: 99, currency: "usd", state: "credited", checkout_session_id: session.id, invoice_id: invoice.id,
      payment_intent_id: "pi_trial_fixture", cancellation_policy: "retain_credit", credit_transaction_id: "cbtxn_fixture" });
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledWith(customerId, row.credit_params,
      expect.objectContaining({ idempotencyKey: "trial-credit:" + row.id }));
    expect(row.credit_params).toMatchObject({ amount: -99, currency: "usd", metadata: { trialPaymentId: row.id, invoiceId: invoice.id } });
    expect(await reconcile()).toEqual({ required: true, paid: true, credited: true });
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
    expect(api.checkout.sessions.retrieve).toHaveBeenCalledTimes(1);
  });
  it.each(["owner", "subscription", "policy", "cancellation_policy", "amount", "currency", "deposit", "invoice_owner", "invoice_subscription", "invoice_amount", "intent_owner", "intent_amount", "intent_status", "balance_payment"])(
    "fails closed for invalid %s evidence", async field => {
      if (field === "owner") session.client_reference_id = "another_user";
      if (field === "subscription") session.subscription = "sub_another";
      if (field === "policy") session.metadata.trialPaymentPolicy = "other-policy";
      if (field === "cancellation_policy") session.metadata.trialCancellationPolicy = "refund_during_trial";
      if (field === "amount") session.amount_total = 0;
      if (field === "currency") session.currency = "eur";
      if (field === "deposit") lines.data[0].amount_total = 0;
      if (field === "invoice_owner") invoice.customer = "cus_another";
      if (field === "invoice_subscription") invoice.parent.subscription_details.subscription = "sub_another";
      if (field === "invoice_amount") invoice.amount_paid = 0;
      if (field === "intent_owner") invoice.payments.data[0].payment.payment_intent.customer = "cus_another";
      if (field === "intent_amount") invoice.payments.data[0].payment.payment_intent.amount_received = 0;
      if (field === "intent_status") invoice.payments.data[0].payment.payment_intent.status = "requires_payment_method";
      if (field === "balance_payment") invoice.payments.data = [];
      await expect(reconcile()).rejects.toBeInstanceOf(service.TrialPaymentCreditError);
      expect(await ledger()).toBeUndefined(); expect(api.customers.createBalanceTransaction).not.toHaveBeenCalled();
    });
  it.each(["refunded", "partially_refunded", "disputed", "not_captured"])("does not credit a %s charge", async state => {
    if (state === "refunded") { charge.refunded = true; charge.amount_refunded = 99; }
    if (state === "partially_refunded") charge.amount_refunded = 1;
    if (state === "disputed") charge.disputed = true;
    if (state === "not_captured") { charge.captured = false; charge.amount_captured = 0; }
    await expect(reconcile()).rejects.toBeInstanceOf(service.TrialPaymentCreditError);
    expect(await ledger()).toBeUndefined(); expect(api.customers.createBalanceTransaction).not.toHaveBeenCalled();
  });
  it("recovers a successful credit after a lost response without another money write", async () => {
    api.customers.createBalanceTransaction.mockImplementationOnce(async (...args: [string, any]) => { await successfulCredit(...args); throw Error("response lost"); });
    await expect(reconcile()).rejects.toThrow("response lost");
    expect((await ledger()).state).toBe("credit_pending");
    expect(await reconcile()).toEqual({ required: true, paid: true, credited: true });
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("retries a request that never arrived with the exact frozen body/key", async () => {
    api.customers.createBalanceTransaction.mockRejectedValueOnce(Error("request not delivered"));
    await expect(reconcile()).rejects.toThrow("request not delivered");
    expect(await reconcile()).toEqual({ required: true, paid: true, credited: true });
    expect(api.customers.createBalanceTransaction.mock.calls[1]).toEqual(api.customers.createBalanceTransaction.mock.calls[0]);
  });
  it("never sends an unresolved credit again after the provider idempotency window", async () => {
    api.customers.createBalanceTransaction.mockRejectedValueOnce(Error("unknown result"));
    await expect(reconcile()).rejects.toThrow();
    await pool.query("UPDATE billing_trial_payments SET credit_requested_at=now()-interval '24 hours' WHERE subscription_id=$1", [subscriptionId]);
    await expect(reconcile()).rejects.toThrow("earlier billing credit");
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("recovers a matching old transaction even after idempotency has expired", async () => {
    api.customers.createBalanceTransaction.mockImplementationOnce(async (...args: [string, any]) => { await successfulCredit(...args); throw Error("unknown result"); });
    await expect(reconcile()).rejects.toThrow();
    await pool.query("UPDATE billing_trial_payments SET credit_requested_at=now()-interval '24 hours' WHERE subscription_id=$1", [subscriptionId]);
    expect(await reconcile()).toEqual({ required: true, paid: true, credited: true });
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("detects duplicate or mismatched credit markers without issuing a third adjustment", async () => {
    api.customers.createBalanceTransaction.mockRejectedValueOnce(Error("unknown result"));
    await expect(reconcile()).rejects.toThrow();
    const row = await ledger();
    transactions = [{ id: "cbtxn_one", customer: customerId, type: "adjustment", ...row.credit_params },
      { id: "cbtxn_two", customer: customerId, type: "adjustment", ...row.credit_params }];
    await expect(reconcile()).rejects.toThrow("reconciliation");
    transactions = [{ ...transactions[0], amount: -100 }];
    await expect(reconcile()).rejects.toThrow("could not verify");
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("does not accept malformed or incomplete payment/history pages", async () => {
    invoice.payments.has_more = true;
    await expect(reconcile()).rejects.toThrow(); expect(await ledger()).toBeUndefined();
    invoice.payments.has_more = false;
    api.customers.listBalanceTransactions.mockResolvedValue({ data: [], has_more: true });
    await expect(reconcile()).rejects.toThrow();
    expect((await ledger()).state).toBe("paid"); expect(api.customers.createBalanceTransaction).not.toHaveBeenCalled();
  });
  it("finds an ambiguous credit beyond the first history page", async () => {
    api.customers.createBalanceTransaction.mockImplementationOnce(async (...args: [string, any]) => { await successfulCredit(...args); throw Error("unknown result"); });
    await expect(reconcile()).rejects.toThrow();
    api.customers.listBalanceTransactions.mockImplementation(async (_customer, params) => params.starting_after
      ? { data: structuredClone(transactions), has_more: false }
      : { data: [{ id: "cbtxn_other", metadata: {}, amount: 100 }], has_more: true });
    expect(await reconcile()).toEqual({ required: true, paid: true, credited: true });
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("refuses new work after account deletion and preserves money history", async () => {
    await reconcile();
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    expect((await ledger()).user_id).toBeNull();
    await expect(service.reconcileTrialPaymentCredit(stripe, sub)).rejects.toThrow("ownership");
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("uses the shared lock boundary so two return/webhook paths cannot issue credits concurrently", async () => {
    await lifecycle.withCustomerBillingLock(userId, async () => {
      await expect(reconcile()).rejects.toBeInstanceOf(lifecycle.CustomerBillingBusyError);
    });
    await reconcile(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("keeps cancellation from refunding a persisted retain-credit policy", async () => {
    await reconcile(); confirmCancellation();
    expect(await cancelReconcile()).toMatchObject({ applicable: false, state: "not_required", refunded: false });
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("reverses unused credit before refunding and never credits/refunds twice", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    expect(await cancelReconcile()).toMatchObject({ state: "refunded", refunded: true });
    const row = await ledger();
    expect(row.state).toBe("refunded"); expect(row.credit_reversal_transaction_id).toBeTruthy(); expect(row.refund_id).toBe("re_trial_fixture");
    expect(transactions[0].ending_balance).toBe(0);
    expect(api.refunds.create).toHaveBeenCalledWith(row.refund_params, expect.objectContaining({ idempotencyKey: "trial-payment-refund:" + row.id }));
    expect(await cancelReconcile()).toMatchObject({ state: "refunded" });
    expect(await reconcile()).toEqual({ required: true, paid: false, credited: false });
    expect(api.refunds.create).toHaveBeenCalledTimes(1); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2);
  });
  it("does not refund before actual trial cancellation or after the cancellation cutoff", async () => {
    enableRefundPolicy(); await reconcile();
    expect(await cancelReconcile()).toMatchObject({ state: "not_due" });
    sub.cancel_at_period_end = true; sub.canceled_at = Math.floor(Date.now() / 1000);
    expect(await cancelReconcile()).toMatchObject({ state: "pending", refunded: false });
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
    confirmCancellation(); sub.canceled_at = sub.trial_end;
    expect(await cancelReconcile()).toMatchObject({ state: "not_due" });
    expect(api.refunds.create).not.toHaveBeenCalled();
  });
  it("uses the persisted trial end and actual cancellation timestamp after a delayed webhook", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    await pool.query("UPDATE billing_trial_payments SET trial_ends_at=now()-interval '1 hour' WHERE subscription_id=$1", [subscriptionId]);
    sub.canceled_at = Math.floor(Date.now() / 1000) - 7200; sub.trial_end = sub.canceled_at - 86400;
    expect(await cancelReconcile()).toMatchObject({ state: "refunded" });
  });
  it("reconciles an ambiguous reversal and continues after cancellation is resumed", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.customers.createBalanceTransaction.mockImplementationOnce(async (...args: [string, any]) => { await successfulCredit(...args); throw Error("reversal response lost"); });
    await expect(cancelReconcile()).rejects.toThrow("reversal response lost");
    expect((await ledger()).state).toBe("reversal_pending");
    sub.status = "trialing"; sub.canceled_at = null;
    expect(await cancelReconcile()).toMatchObject({ state: "refunded" });
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2); expect(api.refunds.create).toHaveBeenCalledTimes(1);
  });
  it("retries an undelivered reversal with frozen params/key and refuses expired ambiguity", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.customers.createBalanceTransaction.mockRejectedValueOnce(Error("reversal unavailable"));
    await expect(cancelReconcile()).rejects.toThrow();
    const first = api.customers.createBalanceTransaction.mock.calls[1];
    api.customers.createBalanceTransaction.mockRejectedValueOnce(Error("still unavailable"));
    await expect(cancelReconcile()).rejects.toThrow();
    expect(api.customers.createBalanceTransaction.mock.calls[2]).toEqual(first);
    await pool.query("UPDATE billing_trial_payments SET credit_reversal_requested_at=now()-interval '24 hours' WHERE subscription_id=$1", [subscriptionId]);
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review", refunded: false });
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(3);
  });
  it("recovers an already succeeded cash refund after a lost response", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    const original = api.refunds.create.getMockImplementation()!;
    api.refunds.create.mockImplementationOnce(async params => { await original(params); throw Error("refund response lost"); });
    await expect(cancelReconcile()).rejects.toThrow("refund response lost");
    expect((await ledger()).state).toBe("refund_pending");
    expect(await cancelReconcile()).toMatchObject({ state: "refunded" });
    expect(api.refunds.create).toHaveBeenCalledTimes(1); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2);
  });
  it("retries undelivered refunds with frozen params/key only inside the idempotency window", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.refunds.create.mockRejectedValueOnce(Error("refund unavailable"));
    await expect(cancelReconcile()).rejects.toThrow();
    const first = api.refunds.create.mock.calls[0];
    api.refunds.create.mockRejectedValueOnce(Error("still unavailable"));
    await expect(cancelReconcile()).rejects.toThrow();
    expect(api.refunds.create.mock.calls[1]).toEqual(first);
    await pool.query("UPDATE billing_trial_payments SET refund_requested_at=now()-interval '24 hours' WHERE subscription_id=$1", [subscriptionId]);
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review", refunded: false });
    expect(api.refunds.create).toHaveBeenCalledTimes(2);
  });
  it("keeps a processing refund pending and does not label provider failure as refunded", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.refunds.create.mockImplementationOnce(async params => { const refund = { id: "re_pending", status: "pending", currency: "usd", ...params }; refunds.push(refund); return refund; });
    expect(await cancelReconcile()).toMatchObject({ state: "pending", refunded: false });
    expect(await cancelReconcile()).toMatchObject({ state: "pending", refunded: false });
    refunds[0].status = "failed";
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review", refunded: false });
    expect(api.refunds.create).toHaveBeenCalledTimes(1);
  });
  it.each(["failed", "canceled", "pending", "requires_action", null, "unexpected_status"])(
    "moves a previously settled refund to review when its verified status becomes %s", async status => {
      enableRefundPolicy(); await reconcile(); confirmCancellation();
      expect(await cancelReconcile()).toMatchObject({ state: "refunded", refunded: true });
      await pool.query("UPDATE billing_trial_payments SET refunded_at=now()-interval '28 days' WHERE subscription_id=$1", [subscriptionId]);
      const settled = await ledger();
      refunds[0].status = status;
      // A failed refund can return money to the merchant, so charge totals
      // alone must not short-circuit the saved refund's current status.
      charge.amount_refunded = 0; charge.refunded = false;
      expect(await externalReconcile()).toMatchObject({ state: "manual_review", refunded: false });
      expect(await ledger()).toMatchObject({ state: "manual_review", refund_id: settled.refund_id, refunded_at: settled.refunded_at,
        credit_transaction_id: settled.credit_transaction_id, credit_reversal_transaction_id: settled.credit_reversal_transaction_id });
      expect(await externalReconcile()).toMatchObject({ state: "manual_review", refunded: false });
      expect(await cancelReconcile()).toMatchObject({ state: "manual_review", refunded: false });
      expect(api.refunds.retrieve).toHaveBeenCalledTimes(1);
      expect(api.refunds.create).toHaveBeenCalledTimes(1); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2);
    });
  it.each(["payment_intent", "charge"])("preserves a settled refund proven through its %s", async relation => {
    enableRefundPolicy(); await reconcile(); confirmCancellation(); await cancelReconcile();
    const settled = await ledger();
    if (relation === "charge") { refunds[0].payment_intent = null; refunds[0].charge = charge.id; }
    expect(await externalReconcile()).toMatchObject({ state: "refunded", refunded: true });
    expect(await ledger()).toMatchObject({ state: "refunded", refunded_at: settled.refunded_at });
    expect(api.refunds.retrieve).toHaveBeenCalledWith(settled.refund_id, {}, expect.objectContaining({ timeout: 15_000 }));
    expect(api.refunds.create).toHaveBeenCalledTimes(1); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2);
  });
  it.each(["id", "payment_intent", "charge", "amount", "currency", "missing_relation", "intent_customer", "charge_customer"])(
    "rejects foreign or malformed %s evidence when rechecking a settled refund", async field => {
      enableRefundPolicy(); await reconcile(); confirmCancellation(); await cancelReconcile();
      const settled = await ledger();
      const foreign = { ...refunds[0], status: "failed" };
      if (field === "id") foreign.id = "re_another";
      if (field === "payment_intent") foreign.payment_intent = "pi_another";
      if (field === "charge") foreign.charge = "ch_another";
      if (field === "amount") foreign.amount = 100;
      if (field === "currency") foreign.currency = "eur";
      if (field === "missing_relation") { foreign.payment_intent = null; foreign.charge = null; }
      if (field === "intent_customer") invoice.payments.data[0].payment.payment_intent.customer = "cus_another";
      if (field === "charge_customer") charge.customer = "cus_another";
      api.refunds.retrieve.mockResolvedValueOnce(foreign);
      await expect(externalReconcile()).rejects.toBeInstanceOf(service.TrialPaymentCreditError);
      expect(await ledger()).toMatchObject({ state: "refunded", refund_id: settled.refund_id, refunded_at: settled.refunded_at });
      expect(api.refunds.create).toHaveBeenCalledTimes(1); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2);
    });
  it("retries a failed refund status lookup without changing settlement or issuing money", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation(); await cancelReconcile();
    const settled = await ledger();
    refunds[0].status = "failed";
    api.refunds.retrieve.mockRejectedValueOnce(Error("Refund lookup unavailable"));
    await expect(externalReconcile()).rejects.toThrow("Refund lookup unavailable");
    expect(await ledger()).toMatchObject({ state: "refunded", refunded_at: settled.refunded_at });
    expect(await externalReconcile()).toMatchObject({ state: "manual_review", refunded: false });
    expect(api.refunds.create).toHaveBeenCalledTimes(1); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2);
  });
  it("rechecks a succeeded external refund without requiring application metadata", async () => {
    await reconcile(); charge.amount_refunded = 99; charge.refunded = true;
    refunds.push({ id: "re_external", amount: 99, currency: "usd", payment_intent: "pi_trial_fixture", status: "succeeded", metadata: {} });
    expect(await externalReconcile()).toMatchObject({ state: "refunded" });
    const settled = await ledger();
    expect(settled.refund_params).toBeNull();
    expect(await externalReconcile()).toMatchObject({ state: "refunded", refunded: true });
    refunds[0].status = "failed";
    expect(await externalReconcile()).toMatchObject({ state: "manual_review", refunded: false });
    expect(await ledger()).toMatchObject({ refund_id: "re_external", refunded_at: settled.refunded_at });
    expect(await externalReconcile()).toMatchObject({ state: "manual_review", refunded: false });
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2);
  });
  it("will not refund credit already consumed by a different invoice", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    transactions.unshift({ id: "cbtxn_spent", customer: customerId, currency: "usd", type: "applied_to_invoice", amount: 99, ending_balance: 0,
      invoice: "in_proration_fixture", metadata: {} });
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review" });
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("will not debit credit while a draft or open invoice can consume it", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.invoices.list.mockImplementation(async params => ({ data: params.status === "draft" ? [{ id: "in_pending" }] : [], has_more: false }));
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review" });
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
  it("compensates a provider invoice that races the reversal without refunding cash", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.customers.createBalanceTransaction.mockImplementationOnce(async (...args: [string, any]) => {
      transactions.unshift({ id: "cbtxn_race", customer: customerId, currency: "usd", type: "applied_to_invoice", amount: 99, ending_balance: 0, metadata: {} });
      return successfulCredit(...args);
    });
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review", refunded: false });
    expect(transactions[0]).toMatchObject({ amount: -99, ending_balance: 0, metadata: { trialPaymentAction: "refund_compensation" } });
    expect((await ledger()).credit_compensation_transaction_id).toBeTruthy();
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(3);
  });
  it("reconciles a lost compensation response without duplicate corrections", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.customers.createBalanceTransaction.mockImplementationOnce(async (...args: [string, any]) => {
      transactions.unshift({ id: "cbtxn_race", customer: customerId, currency: "usd", type: "applied_to_invoice", amount: 99, ending_balance: 0, metadata: {} });
      return successfulCredit(...args);
    }).mockImplementationOnce(async (...args: [string, any]) => { await successfulCredit(...args); throw Error("compensation response lost"); });
    await expect(cancelReconcile()).rejects.toThrow("compensation response lost");
    expect((await ledger()).state).toBe("compensation_pending");
    expect(await reconcile()).toEqual({ required: true, paid: false, credited: false });
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review" });
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(3); expect(api.refunds.create).not.toHaveBeenCalled();
  });
  it("compensates a raced reversal even when its original response was lost", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.customers.createBalanceTransaction.mockImplementationOnce(async (...args: [string, any]) => {
      transactions.unshift({ id: "cbtxn_race", customer: customerId, currency: "usd", type: "applied_to_invoice", amount: 99, ending_balance: 0, metadata: {} });
      await successfulCredit(...args); throw Error("raced reversal response lost");
    });
    await expect(cancelReconcile()).rejects.toThrow("raced reversal response lost");
    expect((await ledger()).state).toBe("reversal_pending");
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review" });
    expect(transactions[0]).toMatchObject({ amount: -99, ending_balance: 0, metadata: { trialPaymentAction: "refund_compensation" } });
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(3); expect(api.refunds.create).not.toHaveBeenCalled();
  });
  it("freezes undelivered compensation and stops automatic retry after its idempotency window", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.customers.createBalanceTransaction.mockImplementationOnce(async (...args: [string, any]) => {
      transactions.unshift({ id: "cbtxn_race", customer: customerId, currency: "usd", type: "applied_to_invoice", amount: 99, ending_balance: 0, metadata: {} });
      return successfulCredit(...args);
    }).mockRejectedValueOnce(Error("correction unavailable"));
    await expect(cancelReconcile()).rejects.toThrow("correction unavailable");
    const first = api.customers.createBalanceTransaction.mock.calls[2];
    api.customers.createBalanceTransaction.mockRejectedValueOnce(Error("still unavailable"));
    await expect(cancelReconcile()).rejects.toThrow();
    expect(api.customers.createBalanceTransaction.mock.calls[3]).toEqual(first);
    await pool.query("UPDATE billing_trial_payments SET credit_compensation_requested_at=now()-interval '24 hours' WHERE subscription_id=$1", [subscriptionId]);
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review" });
    expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(4); expect(api.refunds.create).not.toHaveBeenCalled();
  });
  it("rechecks a persisted reversal before any cash refund after an interrupted state transition", async () => {
    enableRefundPolicy(); await reconcile(); confirmCancellation();
    api.customers.createBalanceTransaction.mockImplementationOnce(async (...args: [string, any]) => {
      transactions.unshift({ id: "cbtxn_race", customer: customerId, currency: "usd", type: "applied_to_invoice", amount: 99, ending_balance: 0, metadata: {} });
      return successfulCredit(...args);
    }).mockRejectedValueOnce(Error("interrupted correction"));
    await expect(cancelReconcile()).rejects.toThrow("interrupted correction");
    // Simulate a previously persisted identifier without the matching next
    // financial state. Provider evidence must prevent a premature cash refund.
    await pool.query("UPDATE billing_trial_payments SET state='refund_pending' WHERE subscription_id=$1", [subscriptionId]);
    expect((await ledger()).credit_reversal_transaction_id).toBeTruthy();
    expect(await cancelReconcile()).toMatchObject({ state: "manual_review", refunded: false });
    expect(transactions[0]).toMatchObject({ amount: -99, ending_balance: 0 });
    expect(api.refunds.create).not.toHaveBeenCalled();
  });
  it("reverses unspent credit for an external full refund without creating another refund", async () => {
    await reconcile(); charge.amount_refunded = 99; charge.refunded = true;
    refunds.push({ id: "re_external", amount: 99, currency: "usd", payment_intent: "pi_trial_fixture", status: "succeeded", metadata: {} });
    expect(await externalReconcile()).toMatchObject({ state: "refunded" });
    expect((await ledger()).refund_id).toBe("re_external");
    expect(await externalReconcile()).toMatchObject({ state: "refunded" });
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2);
  });
  it("withdraws unspent credit for a dispute and marks review without issuing cash", async () => {
    await reconcile(); charge.disputed = true;
    expect(await externalReconcile()).toMatchObject({ state: "manual_review" });
    expect(transactions[0].ending_balance).toBe(0);
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(2);
  });
  it("preserves spent-credit and partial-refund cases for review", async () => {
    await reconcile(); charge.amount_refunded = 50;
    expect(await externalReconcile()).toMatchObject({ state: "manual_review" });
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
});
