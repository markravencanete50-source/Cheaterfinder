import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasSubscriptionAccess } from "../../../shared/billing-plans.js";
import { TRIAL_PAYMENT_POLICY } from "../../../shared/trial-payment.js";

// Only the isolated runner's disposable database may execute these writes.
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || parsed.hostname !== "127.0.0.1" || parsed.port === "5432" ||
    !(parsed.port === "55439" || process.env.STRESS_NONCE && (process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(parsed.port))) {
    throw new Error("Private scratch database required");
  }
  process.env.DATABASE_URL = url;
}
const send = vi.hoisted(() => vi.fn());
const proof = vi.hoisted(() => ({ credit: vi.fn(), cancellation: vi.fn(), reversal: vi.fn() }));
const provider = vi.hoisted(() => ({ subscriptions: { retrieve: vi.fn(), cancel: vi.fn(), update: vi.fn() }, invoices: { retrieve: vi.fn() } }));
vi.mock("stripe", () => ({ default: class { constructor() { return provider; } } }));
vi.mock("../email-delivery.js", async original => ({ ...await original<typeof import("../email-delivery.js")>(), sendApplicationEmail: send }));
// Provider-proof/credit/refund invariants have their own real-service tests.
// This suite tests their contract with real subscription, entitlement and outbox persistence.
vi.mock("../trial-payment-credit.js", async original => ({ ...await original<typeof import("../trial-payment-credit.js")>(),
  reconcileTrialPaymentCredit: proof.credit, reconcileTrialPaymentCancellation: proof.cancellation, reconcileTrialPaymentExternalReversal: proof.reversal }));

const userId = randomUUID(), customerId = `cus_sync_${userId}`, subscriptionId = `sub_sync_${userId}`, paymentId = randomUUID();
(url ? describe : describe.skip)("trial payment synchronization — isolated PG with provider-proof stubs", () => {
  let pool: typeof import("../../db.js").pool;
  let billing: typeof import("../../stripe.js");
  let outbox: typeof import("../transactional-emails.js");
  let retention: typeof import("../billing-retention.js");
  let sub: any;
  const ledger = async (state = "credited", policy = "retain_credit") => {
    const params = { amount: -99, currency: "usd", metadata: { trialPaymentId: paymentId, trialPaymentPolicy: TRIAL_PAYMENT_POLICY,
      subscriptionId, invoiceId: `in_advance_${userId}` } };
    await pool.query(`INSERT INTO billing_trial_payments(id,user_id,customer_id,subscription_id,checkout_session_id,invoice_id,payment_intent_id,
      policy_version,cancellation_policy,trial_ends_at,currency,amount,state,credit_params,paid_at,credit_requested_at,credit_transaction_id,credited_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'usd',99,$11,$12::jsonb,now(),now(),$13,now())`,
      [paymentId, userId, customerId, subscriptionId, `cs_${userId}`, `in_advance_${userId}`, `pi_${userId}`, TRIAL_PAYMENT_POLICY,
        policy, new Date(sub.trial_end * 1000), state, JSON.stringify(params), `cbtxn_${userId}`]);
  };
  const local = async () => {
    const row = (await pool.query("SELECT * FROM subscriptions WHERE user_id=$1", [userId])).rows[0];
    return row && { ...row, stripeCustomerId: row.stripe_customer_id, stripeSubscriptionId: row.stripe_subscription_id,
      trialEndsAt: row.trial_ends_at, currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: row.cancel_at_period_end };
  };
  const emails = async () => (await pool.query("SELECT id,payload,accepted_at,skipped_at FROM transactional_emails WHERE user_id=$1 AND kind='membership' ORDER BY created_at,id", [userId])).rows;
  const deliver = async (id: string) => outbox.flushTransactionalEmails(1, id);
  const confirmedCredit = () => proof.credit.mockResolvedValue({ required: true, paid: true, credited: true });

  beforeAll(async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_local_sync_fixture"); vi.stubEnv("STRIPE_STANDARD_PRICE_ID", "price_sync_standard");
    vi.stubEnv("APP_URL", "https://cheaterfinder.com");
    pool = (await import("../../db.js")).pool;
    billing = await import("../../stripe.js"); outbox = await import("../transactional-emails.js"); retention = await import("../billing-retention.js");
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    await pool.query("DELETE FROM billing_trial_payments WHERE customer_id=$1", [customerId]);
    await pool.query("DELETE FROM users WHERE id=$1", [userId]);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Sync fixture')", [userId, userId + "@example.invalid"]);
    await pool.query("INSERT INTO customer_billing_links(user_id,stripe_customer_id) VALUES($1,$2)", [userId, customerId]);
    const now = Math.floor(Date.now() / 1000);
    sub = { id: subscriptionId, customer: customerId, status: "trialing", trial_start: now, trial_end: now + 3 * 86400,
      cancel_at: null, canceled_at: null, cancel_at_period_end: false, latest_invoice: `in_advance_${userId}`,
      metadata: { userId, plan: "standard", trialPaymentPolicy: TRIAL_PAYMENT_POLICY, trialPaymentPriceId: "price_sync_advance", trialCancellationPolicy: "retain_credit" },
      items: { data: [{ id: "si_fixture", quantity: 1, current_period_end: now + 3 * 86400, price: { id: "price_sync_standard" } }] } };
    send.mockResolvedValue("email_fixture");
    proof.credit.mockResolvedValue({ required: true, paid: false, credited: false });
    proof.cancellation.mockResolvedValue({ applicable: false, state: "not_required", refunded: false });
    proof.reversal.mockResolvedValue({ applicable: false, state: "not_required", refunded: false });
    provider.subscriptions.retrieve.mockImplementation(async () => structuredClone(sub));
    provider.subscriptions.cancel.mockImplementation(async () => {
      sub = { ...sub, status: "canceled", canceled_at: Math.floor(Date.now() / 1000), cancel_at_period_end: false };
      return structuredClone(sub);
    });
    provider.subscriptions.update.mockImplementation(async (_id, params) => { sub = { ...sub, ...params }; return structuredClone(sub); });
    provider.invoices.retrieve.mockImplementation(async id => ({ id, customer: customerId, currency: "usd", status: "open",
      amount_paid: 0, amount_remaining: 99, billing_reason: "subscription_create", parent: { subscription_details: { subscription: subscriptionId } } }));
  });
  afterAll(async () => {
    if (pool) { await pool.query("DELETE FROM billing_trial_payments WHERE customer_id=$1", [customerId]); await pool.query("DELETE FROM users WHERE id=$1", [userId]); await pool.end(); }
    vi.unstubAllEnvs();
  });

  it.each(["trialing", "active"])("does not unlock a new %s subscription or queue a welcome-to-trial email before proof", async status => {
    sub.status = status;
    const accountId = randomUUID();
    await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,is_active) VALUES($1,$2,'sync_fixture_profile',true)", [accountId, userId]);
    await billing.syncSubscription(sub);
    const row = await local(); expect(row.status).toBe("past_due"); expect(hasSubscriptionAccess(row)).toBe(false);
    expect(row.trial_payment_policy).toBe(TRIAL_PAYMENT_POLICY); expect(await emails()).toEqual([]);
    expect((await pool.query("SELECT is_active FROM tracked_accounts WHERE id=$1", [accountId])).rows[0].is_active).toBe(false);
  });
  it("exposes no partial subscription or email while payment proof is still running", async () => {
    await ledger();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    proof.credit.mockImplementationOnce(async () => { enter(); await gate; return { required: true, paid: true, credited: true }; });
    const syncing = billing.syncSubscription(sub); await entered;
    try { expect(await local()).toBeUndefined(); expect(await emails()).toEqual([]); } finally { release(); }
    await syncing; expect(hasSubscriptionAccess(await local())).toBe(true);
  });
  it("grants a confirmed paid trial and delivers one ledger-aware email across repeated synchronization", async () => {
    await ledger(); confirmedCredit(); await billing.syncSubscription(sub); await billing.syncSubscription(sub);
    expect(hasSubscriptionAccess(await local())).toBe(true);
    const rows = await emails(); expect(rows).toHaveLength(1);
    expect(rows[0].payload.state.trialPayment).toEqual({ amount: 99, currency: "usd", creditStatus: "credited", cancellationPolicy: "retain_credit" });
    expect(await deliver(rows[0].id)).toEqual({ accepted: 1, skipped: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0].text).toContain("$0.99 issued once");
    await billing.syncSubscription(sub); await deliver(rows[0].id); expect(send).toHaveBeenCalledTimes(1);
  });
  it("waits for later payment proof after the subscription-first event and only sends the confirmed state", async () => {
    await billing.syncSubscription(sub); expect(hasSubscriptionAccess(await local())).toBe(false); expect(await emails()).toHaveLength(0);
    await ledger(); confirmedCredit(); await billing.syncSubscription(sub);
    expect(hasSubscriptionAccess(await local())).toBe(true); const rows = await emails(); expect(rows).toHaveLength(1);
    expect((await deliver(rows[0].id)).accepted).toBe(1); expect(send.mock.calls[0][0].text).toContain("Your trial starts here");
  });
  it("leaves entitlement and email untouched when provider proof fails", async () => {
    proof.credit.mockRejectedValueOnce(new Error("Verification unavailable"));
    await expect(billing.syncSubscription(sub)).rejects.toThrow("Verification unavailable");
    expect(await local()).toBeUndefined(); expect(await emails()).toHaveLength(0);
  });
  it.each(["trialing", "active"].flatMap(previousStatus => ["canceled", "incomplete_expired"].map(terminalStatus => ({ previousStatus, terminalStatus }))))(
    "closes existing $previousStatus access on $terminalStatus even when payment proof must retry", async ({ previousStatus, terminalStatus }) => {
      sub.status = previousStatus;
      await ledger(); confirmedCredit(); await billing.syncSubscription(sub);
      expect(hasSubscriptionAccess(await local())).toBe(true);
      const [queued] = await emails();
      const accountId = randomUUID();
      await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,is_active) VALUES($1,$2,'terminal_sync_fixture',true)", [accountId, userId]);

      sub.status = terminalStatus; sub.canceled_at = Math.floor(Date.now() / 1000);
      proof.credit.mockRejectedValueOnce(new Error("Credit provider unavailable"));
      await expect(billing.syncSubscription(sub)).rejects.toThrow("Credit provider unavailable");

      // The retry must preserve the provider-confirmed end of access, without
      // claiming the separate financial reconciliation has completed.
      const current = await local();
      expect(current.status).toBe("canceled"); expect(hasSubscriptionAccess(current)).toBe(false);
      expect((await pool.query("SELECT is_active FROM tracked_accounts WHERE id=$1", [accountId])).rows[0].is_active).toBe(false);
      expect((await pool.query("SELECT state FROM billing_trial_payments WHERE subscription_id=$1", [subscriptionId])).rows[0].state).toBe("credited");
      expect((await deliver(queued.id)).skipped).toBe(1); expect(send).not.toHaveBeenCalled();
    },
  );
  it("omits optional payment state for legacy membership hashes so already-queued mail is still deliverable", async () => {
    delete sub.metadata.trialPaymentPolicy; delete sub.metadata.trialCancellationPolicy; delete sub.metadata.trialPaymentPriceId;
    proof.credit.mockResolvedValue({ required: false, paid: false, credited: false });
    await billing.syncSubscription(sub); const rows = await emails(); expect(rows).toHaveLength(1);
    expect(rows[0].payload.state).not.toHaveProperty("trialPayment");
    const expected = { stripeSubscriptionId: subscriptionId, status: "trialing", plan: "standard",
      currentPeriodEnd: new Date(sub.items.data[0].current_period_end * 1000).toISOString(), trialEndsAt: new Date(sub.trial_end * 1000).toISOString(), cancelAtPeriodEnd: false };
    expect(rows[0].id).toBe(outbox.billingEmailKey(userId, expected));
    expect((await deliver(rows[0].id)).accepted).toBe(1); expect(send.mock.calls[0][0].text).not.toContain("Advance payment");
  });
  it("suppresses an obsolete credited-trial email after refund state changes before delivery", async () => {
    await ledger(); confirmedCredit(); await billing.syncSubscription(sub); const [queued] = await emails();
    await pool.query("UPDATE billing_trial_payments SET state='refunded' WHERE subscription_id=$1", [subscriptionId]);
    expect((await deliver(queued.id)).skipped).toBe(1); expect(send).not.toHaveBeenCalled();
  });
  it("keeps a refunded or disputed trial locked even if a late snapshot still says trialing", async () => {
    await ledger("refunded", "refund_during_trial"); sub.metadata.trialCancellationPolicy = "refund_during_trial";
    await billing.syncSubscription(sub); expect(hasSubscriptionAccess(await local())).toBe(false);
    expect(await emails()).toHaveLength(0);
  });
  it("immediately closes trial access on refundable cancellation and delivers the confirmed refund state", async () => {
    sub.metadata.trialCancellationPolicy = "refund_during_trial"; await ledger("credited", "refund_during_trial"); confirmedCredit();
    await billing.syncSubscription(sub); const [oldEmail] = await emails();
    proof.cancellation.mockImplementation(async (_api, current, executor) => {
      if (current.status !== "canceled") return { applicable: true, state: "not_due", refunded: false };
      await executor.execute(sql`UPDATE billing_trial_payments SET state='refunded',refunded_at=now() WHERE subscription_id=${subscriptionId}`);
      return { applicable: true, state: "refunded", refunded: true };
    });
    await retention.cancelCustomerSubscription(provider as unknown as Stripe, userId);
    expect(provider.subscriptions.cancel).toHaveBeenCalledWith(subscriptionId, { invoice_now: false, prorate: false }, expect.anything());
    expect(provider.subscriptions.update).not.toHaveBeenCalled(); expect(hasSubscriptionAccess(await local())).toBe(false); expect((await local()).status).toBe("canceled");
    const rows = await emails(); const refundEmail = rows.find(row => row.payload.state.status === "canceled"); expect(refundEmail).toBeDefined();
    expect(refundEmail!.payload.state.trialPayment.creditStatus).toBe("refunded");
    expect((await deliver(oldEmail.id)).skipped).toBe(1); expect((await deliver(refundEmail!.id)).accepted).toBe(1);
    expect(send.mock.calls[0][0].text).toContain("Advance refund: $0.99 confirmed");
  });
  it("records a canceled/refunded state from synchronization so portal-originated refunds have an email", async () => {
    sub.status = "canceled"; sub.canceled_at = Math.floor(Date.now() / 1000); sub.metadata.trialCancellationPolicy = "refund_during_trial";
    await ledger("refunded", "refund_during_trial"); await billing.syncSubscription(sub);
    expect(hasSubscriptionAccess(await local())).toBe(false);
    const rows = await emails(); expect(rows).toHaveLength(1); expect(rows[0].payload.state.trialPayment.creditStatus).toBe("refunded");
    expect((await deliver(rows[0].id)).accepted).toBe(1); expect(send.mock.calls[0][0].text).toContain("Advance refund: $0.99 confirmed");
  });
  it.each(["subscription_cycle", "subscription_update"])("preserves a later paid membership after advance refund using a verified %s invoice", async billingReason => {
    sub.status = "active"; await ledger("refunded");
    provider.invoices.retrieve.mockResolvedValue({ id: sub.latest_invoice, customer: customerId, status: "paid", currency: "usd", amount_paid: 1999,
      amount_remaining: 0, billing_reason: billingReason, parent: { subscription_details: { subscription: subscriptionId } } });
    await billing.syncSubscription(sub); expect(hasSubscriptionAccess(await local())).toBe(true);
    const [row] = await emails(); expect(row.payload.state.status).toBe("active"); expect(row.payload.state.trialPayment.creditStatus).toBe("refunded");
    expect((await deliver(row.id)).accepted).toBe(1); expect(send.mock.calls[0][0].text).toContain("Your membership is active");
  });
  it.each(["unpaid", "zero", "advance_invoice", "foreign_customer", "foreign_subscription", "different_invoice"])(
    "does not use a %s invoice to bypass the refunded-advance access gate", async invalid => {
      sub.status = "active"; await ledger("refunded");
      const invoice: any = { id: sub.latest_invoice, customer: customerId, status: "paid", currency: "usd", amount_paid: 1999,
        amount_remaining: 0, billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: subscriptionId } } };
      if (invalid === "unpaid") { invoice.status = "open"; invoice.amount_remaining = 1999; }
      if (invalid === "zero") invoice.amount_paid = 0;
      if (invalid === "advance_invoice") { invoice.billing_reason = "subscription_create"; invoice.amount_paid = 99; }
      if (invalid === "foreign_customer") invoice.customer = "cus_other_fixture";
      if (invalid === "foreign_subscription") invoice.parent.subscription_details.subscription = "sub_other_fixture";
      if (invalid === "different_invoice") invoice.id = "in_other_fixture";
      provider.invoices.retrieve.mockResolvedValue(invoice);
      await billing.syncSubscription(sub); expect(hasSubscriptionAccess(await local())).toBe(false); expect(await emails()).toHaveLength(0);
    });
  it("reconciles an early portal cancellation into immediate closure before saving or emailing state", async () => {
    sub.metadata.trialCancellationPolicy = "refund_during_trial"; sub.cancel_at_period_end = true; sub.canceled_at = Math.floor(Date.now() / 1000);
    await ledger("credited", "refund_during_trial"); confirmedCredit();
    proof.cancellation.mockImplementation(async (_api, current, executor) => {
      expect(current.status).toBe("canceled");
      await executor.execute(sql`UPDATE billing_trial_payments SET state='refunded' WHERE subscription_id=${subscriptionId}`);
      return { applicable: true, state: "refunded", refunded: true };
    });
    await billing.syncSubscription(sub); expect((await local()).status).toBe("canceled"); expect(hasSubscriptionAccess(await local())).toBe(false);
    expect(proof.cancellation.mock.invocationCallOrder[0]).toBeGreaterThan(provider.subscriptions.cancel.mock.invocationCallOrder[0]);
    const [row] = await emails(); expect(row.payload.state.status).toBe("canceled"); expect(row.payload.state.trialPayment.creditStatus).toBe("refunded");
  });
  it.each(["subscription", "customer", "owner"])("never persists a mismatched %s returned by immediate portal cancellation", async mismatch => {
    sub.metadata.trialCancellationPolicy = "refund_during_trial"; sub.cancel_at_period_end = true; sub.canceled_at = Math.floor(Date.now() / 1000);
    await ledger("credited", "refund_during_trial"); confirmedCredit();
    const canceled = structuredClone(sub); canceled.status = "canceled";
    if (mismatch === "subscription") canceled.id = "sub_unrelated_fixture";
    if (mismatch === "customer") canceled.customer = "cus_unrelated_fixture";
    if (mismatch === "owner") canceled.metadata.userId = "other_fixture";
    provider.subscriptions.cancel.mockResolvedValue(canceled);
    await expect(billing.syncSubscription(sub)).rejects.toThrow(); expect(await local()).toBeUndefined(); expect(await emails()).toHaveLength(0);
  });
  it("does not reclassify an existing refunded paid trial as legacy after its metadata policy disappears", async () => {
    sub.status = "canceled"; sub.canceled_at = Math.floor(Date.now() / 1000);
    await ledger("refunded"); await billing.syncSubscription(sub); expect((await local()).status).toBe("canceled");
    delete sub.metadata.trialPaymentPolicy; sub.status = "trialing";
    proof.credit.mockResolvedValue({ required: false, paid: false, credited: false });
    try { await billing.syncSubscription(sub); } catch { /* Rejecting missing required policy also preserves the last verified state. */ }
    expect(hasSubscriptionAccess(await local())).toBe(false);
    expect((await local()).trial_payment_policy).toBe(TRIAL_PAYMENT_POLICY);
  });
  it("still confirms cancellation and removes access when advance-credit verification is unavailable", async () => {
    sub.metadata.trialCancellationPolicy = "refund_during_trial";
    await billing.syncSubscription(sub);
    await ledger("credit_pending", "refund_during_trial");
    await pool.query("UPDATE billing_trial_payments SET credit_transaction_id=NULL,credited_at=NULL WHERE subscription_id=$1", [subscriptionId]);
    proof.credit.mockRejectedValue(new Error("Credit provider unavailable"));
    proof.cancellation.mockResolvedValue({ applicable: true, state: "pending", refunded: false });
    await expect(retention.cancelCustomerSubscription(provider as unknown as Stripe, userId)).resolves.toBeUndefined();
    expect(provider.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect((await local()).status).toBe("canceled"); expect(hasSubscriptionAccess(await local())).toBe(false);
    const rows = await emails(); expect(rows).toHaveLength(1);
    expect(rows[0].payload.state.trialPayment.creditStatus).toBe("pending");
    expect((await deliver(rows[0].id)).accepted).toBe(1);
    expect(send.mock.calls[0][0].text).toContain("Your membership has ended");
    expect(send.mock.calls[0][0].text).not.toContain("Advance refund: $0.99 confirmed");
  });
  it("keeps the pending cancellation email hash valid when payment proof has not created a ledger yet", async () => {
    sub.metadata.trialCancellationPolicy = "refund_during_trial";
    await billing.syncSubscription(sub); expect((await local()).trial_payment_policy).toBe(TRIAL_PAYMENT_POLICY);
    proof.credit.mockRejectedValue(new Error("Payment proof unavailable"));
    await retention.cancelCustomerSubscription(provider as unknown as Stripe, userId);
    expect((await local()).status).toBe("canceled"); expect(hasSubscriptionAccess(await local())).toBe(false);
    const [row] = await emails(); expect(row.payload.state.trialPayment).toEqual({ amount: 99, currency: "usd", creditStatus: "pending", cancellationPolicy: "refund_during_trial" });
    expect((await deliver(row.id)).accepted).toBe(1);
    expect(send.mock.calls[0][0].text).toContain("Confirmation pending");
    expect(send.mock.calls[0][0].text).not.toContain("Advance refund: $0.99 confirmed");
  });
});
