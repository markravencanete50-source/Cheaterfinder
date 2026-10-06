import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TRIAL_PAYMENT_POLICY } from "../../../shared/trial-payment.js";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || parsed.hostname !== "127.0.0.1" || parsed.port === "5432" ||
    !(parsed.port === "55439" || process.env.STRESS_NONCE && (process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(parsed.port))) {
    throw new Error("Private scratch database required");
  }
  process.env.DATABASE_URL = url;
}
const money = vi.hoisted(() => ({ cancellation: vi.fn(), reversal: vi.fn() }));
vi.mock("../trial-payment-credit.js", async original => ({ ...await original<typeof import("../trial-payment-credit.js")>(),
  reconcileTrialPaymentCancellation: money.cancellation, reconcileTrialPaymentExternalReversal: money.reversal }));

const userId = randomUUID(), otherUserId = randomUUID(), customerId = `cus_events_${userId}`, otherCustomerId = `cus_events_${otherUserId}`;
const subscriptionId = `sub_events_${userId}`, intentId = `pi_events_${userId}`, paymentId = randomUUID(), eventId = `evt_events_${userId}`;
(url ? describe : describe.skip)("trial financial events — real ledger, advisory lock and event deduplication", () => {
  let pool: typeof import("../../db.js").pool, db: typeof import("../../db.js").db;
  let service: typeof import("../trial-payment-events.js"), lifecycle: typeof import("../customer-billing-lifecycle.js");
  let events: typeof import("../stripe-webhook-safety.js"), log: any;
  let sub: any;
  const api = { subscriptions: { retrieve: vi.fn() }, refunds: { create: vi.fn() }, customers: { createBalanceTransaction: vi.fn() } };
  const stripe = api as unknown as Stripe;
  const seedLedger = async (executor: Pick<typeof db, "execute"> = db) => {
    const params = { amount: -99, currency: "usd", metadata: { trialPaymentId: paymentId, trialPaymentPolicy: TRIAL_PAYMENT_POLICY,
      subscriptionId, invoiceId: `in_events_${userId}` } };
    await executor.execute(sql`INSERT INTO billing_trial_payments(id,user_id,customer_id,subscription_id,checkout_session_id,invoice_id,payment_intent_id,
      policy_version,cancellation_policy,trial_ends_at,currency,amount,state,credit_params,paid_at,credit_requested_at,credit_transaction_id,credited_at)
      VALUES(${paymentId},${userId},${customerId},${subscriptionId},${`cs_events_${userId}`},${`in_events_${userId}`},${intentId},
      ${TRIAL_PAYMENT_POLICY},'retain_credit',${new Date(sub.trial_end * 1000)},'usd',99,'credited',${JSON.stringify(params)}::jsonb,
      now(),now(),${`cbtxn_events_${userId}`},now())`);
  };
  const reconcile = (customer = customerId, intent = intentId) => service.reconcileTrialPaymentFinancialEvent(stripe, customer, intent);
  const webhook = () => events.processStripeEventOnce({ id: eventId, type: "charge.refunded" }, customerId, () => reconcile());
  const acknowledged = async () => (await pool.query("SELECT id FROM stripe_webhook_events WHERE id=$1", [eventId])).rowCount;
  const noMoney = () => { expect(money.cancellation).not.toHaveBeenCalled(); expect(money.reversal).not.toHaveBeenCalled();
    expect(api.refunds.create).not.toHaveBeenCalled(); expect(api.customers.createBalanceTransaction).not.toHaveBeenCalled(); };

  beforeAll(async () => {
    ({ pool, db } = await import("../../db.js"));
    service = await import("../trial-payment-events.js"); lifecycle = await import("../customer-billing-lifecycle.js"); events = await import("../stripe-webhook-safety.js");
    log = vi.spyOn((await import("../../observability/logger.js")).logger, "error").mockImplementation(() => undefined);
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    await pool.query("DELETE FROM stripe_webhook_events WHERE id=$1", [eventId]);
    await pool.query("DELETE FROM billing_trial_payments WHERE customer_id=$1", [customerId]);
    await pool.query("DELETE FROM users WHERE id IN($1,$2)", [userId, otherUserId]);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Financial fixture'),($3,$4,'Other fixture')",
      [userId, userId + "@example.invalid", otherUserId, otherUserId + "@example.invalid"]);
    await pool.query("INSERT INTO customer_billing_links(user_id,stripe_customer_id) VALUES($1,$2),($3,$4)", [userId, customerId, otherUserId, otherCustomerId]);
    sub = { id: subscriptionId, customer: customerId, status: "canceled", trial_end: Math.floor(Date.now() / 1000) + 86400,
      metadata: { userId, trialPaymentPolicy: TRIAL_PAYMENT_POLICY, trialCancellationPolicy: "retain_credit" } };
    api.subscriptions.retrieve.mockImplementation(async () => structuredClone(sub));
    money.cancellation.mockResolvedValue({ applicable: false, state: "not_required", refunded: false });
    money.reversal.mockResolvedValue({ applicable: true, state: "refunded", refunded: true });
  });
  afterAll(async () => {
    log?.mockRestore();
    if (pool) { await pool.query("DELETE FROM stripe_webhook_events WHERE id=$1", [eventId]); await pool.query("DELETE FROM billing_trial_payments WHERE customer_id=$1", [customerId]);
      await pool.query("DELETE FROM users WHERE id IN($1,$2)", [userId, otherUserId]); await pool.end(); }
  });

  it("retries a busy customer even when no ledger exists yet, rather than acknowledging the event", async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const holding = lifecycle.withCustomerBillingLock(userId, async () => { entered(); await gate; });
    await ready;
    try {
      await expect(webhook()).rejects.toBeInstanceOf(lifecycle.CustomerBillingBusyError);
      expect(await acknowledged()).toBe(0); expect(api.subscriptions.retrieve).not.toHaveBeenCalled(); noMoney();
    } finally { release(); await holding; }
    await webhook(); expect(await acknowledged()).toBe(1); noMoney();
  });
  it("does not drop a refund event racing with insertion of initial captured-payment proof", async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const capturing = lifecycle.withCustomerBillingLock(userId, async executor => { entered(); await gate; await seedLedger(executor); });
    await ready;
    try { await expect(webhook()).rejects.toBeInstanceOf(lifecycle.CustomerBillingBusyError); expect(await acknowledged()).toBe(0); }
    finally { release(); await capturing; }
    await webhook(); expect(await acknowledged()).toBe(1);
    expect(api.subscriptions.retrieve).toHaveBeenCalledWith(subscriptionId, {}, { timeout: 15000, maxNetworkRetries: 0 });
    expect(money.cancellation).toHaveBeenCalledTimes(1); expect(money.reversal).toHaveBeenCalledTimes(1);
  });
  it("coordinates one owned event once through the existing durable event deduplicator", async () => {
    await seedLedger();
    await webhook(); await webhook();
    expect(await acknowledged()).toBe(1); expect(api.subscriptions.retrieve).toHaveBeenCalledTimes(1);
    expect(money.cancellation).toHaveBeenCalledTimes(1); expect(money.reversal).toHaveBeenCalledTimes(1);
    expect(money.cancellation.mock.invocationCallOrder[0]).toBeLessThan(money.reversal.mock.invocationCallOrder[0]);
    expect(money.cancellation.mock.calls[0][0]).toBe(stripe); expect(money.cancellation.mock.calls[0][1]).toMatchObject({ id: subscriptionId, customer: customerId });
    expect(money.cancellation.mock.calls[0][2]).toBe(money.reversal.mock.calls[0][2]);
  });
  it("keeps the same customer lock held through both financial reconciliation steps", async () => {
    await seedLedger();
    money.cancellation.mockImplementation(async () => {
      await expect(lifecycle.withCustomerBillingLock(userId, async () => undefined)).rejects.toBeInstanceOf(lifecycle.CustomerBillingBusyError);
      return { applicable: false, state: "not_required", refunded: false };
    });
    money.reversal.mockImplementation(async () => {
      await expect(lifecycle.withCustomerBillingLock(userId, async () => undefined)).rejects.toBeInstanceOf(lifecycle.CustomerBillingBusyError);
      return { applicable: true, state: "refunded", refunded: true };
    });
    await reconcile();
    await expect(lifecycle.withCustomerBillingLock(userId, async () => undefined)).resolves.toBeUndefined();
  });
  it.each(["other_customer", "unknown_intent", "later_monthly_payment"])("does not mutate a trial advance for %s", async condition => {
    await seedLedger();
    await reconcile(condition === "other_customer" ? otherCustomerId : customerId,
      condition === "unknown_intent" ? "pi_unknown_fixture" : condition === "later_monthly_payment" ? "pi_monthly_fixture" : intentId);
    noMoney(); expect(api.subscriptions.retrieve).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state FROM billing_trial_payments WHERE id=$1", [paymentId])).rows[0].state).toBe("credited");
  });
  it("logs manual review for an orphaned ledger and never sends cash for a deleted user", async () => {
    await seedLedger(); await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    expect((await pool.query("SELECT user_id FROM billing_trial_payments WHERE id=$1", [paymentId])).rows[0].user_id).toBeNull();
    await reconcile(); noMoney(); expect(api.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("manual financial review"));
    expect((await pool.query("SELECT state FROM billing_trial_payments WHERE id=$1", [paymentId])).rows[0].state).toBe("manual_review");
  });
  it("durably flags a late refund failure after deletion before acknowledging the webhook, preserving its financial history", async () => {
    await seedLedger();
    const refundedAt = new Date("2026-09-24T12:00:00Z"), refundId = `re_events_${userId}`;
    await pool.query("UPDATE billing_trial_payments SET state='refunded',refund_id=$2,refunded_at=$3 WHERE id=$1", [paymentId, refundId, refundedAt]);
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    const before = (await pool.query("SELECT * FROM billing_trial_payments WHERE id=$1", [paymentId])).rows[0];
    const failure = () => events.processStripeEventOnce({ id: eventId, type: "refund.failed" }, customerId, async () => {
      await reconcile();
      expect((await pool.query("SELECT state FROM billing_trial_payments WHERE id=$1", [paymentId])).rows[0].state).toBe("manual_review");
      expect(await acknowledged()).toBe(0);
    });
    await failure(); await failure();
    expect(await acknowledged()).toBe(1);
    const after = (await pool.query("SELECT * FROM billing_trial_payments WHERE id=$1", [paymentId])).rows[0];
    expect(after).toMatchObject({ ...before, state: "manual_review", updated_at: expect.any(Date) });
    expect(after.refund_id).toBe(refundId); expect(after.refunded_at).toEqual(refundedAt);
    noMoney(); expect(api.subscriptions.retrieve).not.toHaveBeenCalled();
  });
  it.each(["unknown_intent", "later_monthly_payment", "other_customer"])("does not flag an orphaned advance for an unrelated %s event", async condition => {
    await seedLedger(); await pool.query("DELETE FROM users WHERE id IN($1,$2)", [userId, otherUserId]);
    await reconcile(condition === "other_customer" ? otherCustomerId : customerId,
      condition === "other_customer" ? intentId : condition === "unknown_intent" ? "pi_unknown_fixture" : "pi_monthly_fixture");
    expect((await pool.query("SELECT state FROM billing_trial_payments WHERE id=$1", [paymentId])).rows[0].state).toBe("credited");
    noMoney(); expect(api.subscriptions.retrieve).not.toHaveBeenCalled();
  });
  it("does not change a current user's ledger when only its customer link is missing", async () => {
    await seedLedger(); await pool.query("DELETE FROM customer_billing_links WHERE user_id=$1", [userId]);
    await reconcile();
    expect((await pool.query("SELECT state,user_id FROM billing_trial_payments WHERE id=$1", [paymentId])).rows[0]).toEqual({ state: "credited", user_id: userId });
    noMoney(); expect(api.subscriptions.retrieve).not.toHaveBeenCalled();
  });
  it.each(["subscription", "customer", "owner"])("rejects a mismatched returned %s before financial mutation", async mismatch => {
    await seedLedger();
    if (mismatch === "subscription") sub.id = "sub_other_fixture";
    if (mismatch === "customer") sub.customer = otherCustomerId;
    if (mismatch === "owner") sub.metadata.userId = otherUserId;
    await expect(webhook()).rejects.toThrow("ownership mismatch"); noMoney(); expect(await acknowledged()).toBe(0);
  });
  it.each(["retrieve", "cancellation", "reversal"])("propagates a %s outage without acknowledging the event", async step => {
    await seedLedger();
    (step === "retrieve" ? api.subscriptions.retrieve : step === "cancellation" ? money.cancellation : money.reversal).mockRejectedValueOnce(new Error("Fixture outage"));
    await expect(webhook()).rejects.toThrow("Fixture outage"); expect(await acknowledged()).toBe(0);
    await webhook(); expect(await acknowledged()).toBe(1);
  });
  it.each(["cancellation", "reversal"])("records manual review when the %s boundary reports unresolved money state", async step => {
    await seedLedger(); money[step].mockResolvedValue({ applicable: true, state: "manual_review", refunded: false });
    await webhook(); expect(await acknowledged()).toBe(1);
    expect(log).toHaveBeenCalledWith("Trial payment reversal needs manual financial reconciliation");
    expect(api.refunds.create).not.toHaveBeenCalled();
  });
});
