import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { resultRows } from "./operation-lease.js";
import { logger } from "../observability/logger.js";
import { TRIAL_PAYMENT_AMOUNT, TRIAL_PAYMENT_POLICY } from "../../shared/trial-payment.js";

export { TRIAL_PAYMENT_AMOUNT, TRIAL_PAYMENT_POLICY };
const request = { timeout: 15_000, maxNetworkRetries: 1 } as const;
const RETRY_WINDOW_MS = 23 * 60 * 60_000;
type Executor = Pick<typeof db, "execute">;
type CreditRow = {
  id: string; user_id: string | null; customer_id: string; subscription_id: string;
  checkout_session_id: string; invoice_id: string; payment_intent_id: string;
  policy_version: string; currency: string; amount: number;
  cancellation_policy: string; trial_ends_at: Date;
  state: "paid" | "credit_pending" | "credited" | "reversal_pending" | "refund_pending" | "refunded" | "compensation_pending" | "manual_review";
  credit_params: Stripe.CustomerCreateBalanceTransactionParams;
  credit_requested_at: Date | null; credit_transaction_id: string | null;
  credit_reversal_params: Stripe.CustomerCreateBalanceTransactionParams | null;
  credit_reversal_requested_at: Date | null; credit_reversal_transaction_id: string | null;
  credit_compensation_params: Stripe.CustomerCreateBalanceTransactionParams | null;
  credit_compensation_requested_at: Date | null; credit_compensation_transaction_id: string | null;
  refund_params: Stripe.RefundCreateParams | null; refund_requested_at: Date | null; refund_id: string | null;
};
export type TrialPaymentCreditState = { required: boolean; paid: boolean; credited: boolean };

export class TrialPaymentCreditError extends Error {
  constructor(message = "Your trial payment is being verified. Please retry shortly or contact support.") {
    super(message);
  }
}

function id(value: string | { id: string } | null | undefined): string | undefined {
  return typeof value === "string" ? value : value?.id;
}

function verifyLedger(row: CreditRow, userId: string, customerId: string, subscriptionId: string): void {
  if (row.user_id !== userId || row.customer_id !== customerId || row.subscription_id !== subscriptionId ||
    row.policy_version !== TRIAL_PAYMENT_POLICY || row.currency !== "usd" || row.amount !== TRIAL_PAYMENT_AMOUNT ||
    !["paid", "credit_pending", "credited", "reversal_pending", "refund_pending", "refunded", "compensation_pending", "manual_review"].includes(row.state)) throw new TrialPaymentCreditError();
  const params = row.credit_params;
  if (!params || params.amount !== -TRIAL_PAYMENT_AMOUNT || params.currency !== "usd" ||
    !params.metadata || typeof params.metadata === "string" ||
    params.metadata.trialPaymentId !== row.id || params.metadata.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY ||
    params.metadata.subscriptionId !== subscriptionId || params.metadata.invoiceId !== row.invoice_id) {
    throw new TrialPaymentCreditError();
  }
}

function verifyCredit(transaction: Stripe.CustomerBalanceTransaction, row: CreditRow): void {
  if (id(transaction.customer) !== row.customer_id || transaction.type !== "adjustment" ||
    transaction.amount !== -TRIAL_PAYMENT_AMOUNT || transaction.currency !== "usd" ||
    transaction.metadata?.trialPaymentId !== row.id || transaction.metadata?.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY ||
    transaction.metadata?.subscriptionId !== row.subscription_id || transaction.metadata?.invoiceId !== row.invoice_id) {
    throw new TrialPaymentCreditError("We could not verify your billing credit. Please contact support.");
  }
}

/** Recover an acknowledged or ambiguous write from its immutable ledger marker.
 * Never infer absence from a partial provider history. This is deliberately
 * bounded; an unusually large account needs reconciliation, not another credit.
 */
async function balanceHistory(api: Stripe, row: CreditRow): Promise<Stripe.CustomerBalanceTransaction[]> {
  let startingAfter: string | undefined;
  const history: Stripe.CustomerBalanceTransaction[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const transactions = await api.customers.listBalanceTransactions(row.customer_id,
      { limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) }, request);
    if (!Array.isArray(transactions.data) || typeof transactions.has_more !== "boolean") throw new TrialPaymentCreditError();
    for (const transaction of transactions.data) {
      if (seen.has(transaction.id)) throw new TrialPaymentCreditError();
      seen.add(transaction.id);
      history.push(transaction);
    }
    if (!transactions.has_more) return history;
    startingAfter = transactions.data.at(-1)?.id;
    if (!startingAfter) throw new TrialPaymentCreditError();
  }
  throw new TrialPaymentCreditError("Your billing history needs reconciliation. Please contact support.");
}

async function findExistingCredit(api: Stripe, row: CreditRow): Promise<Stripe.CustomerBalanceTransaction | undefined> {
  const matches = (await balanceHistory(api, row)).filter(transaction =>
    transaction.metadata?.trialPaymentId === row.id && !transaction.metadata?.trialPaymentAction);
  if (matches.length > 1) throw new TrialPaymentCreditError("Your billing credit needs reconciliation. Please contact support.");
  if (matches[0]) verifyCredit(matches[0], row);
  return matches[0];
}

async function markCredited(executor: Executor, row: CreditRow, transaction: Stripe.CustomerBalanceTransaction): Promise<void> {
  verifyCredit(transaction, row);
  const updated = resultRows(await executor.execute(sql`UPDATE billing_trial_payments
    SET state='credited',credit_transaction_id=${transaction.id},credited_at=COALESCE(credited_at,NOW()),updated_at=NOW()
    WHERE id=${row.id} AND user_id=${row.user_id} AND state IN ('paid','credit_pending') RETURNING id`));
  if (updated.length !== 1) throw new TrialPaymentCreditError();
}

/** Prove a real captured payment, rather than a zero invoice, balance payment,
 * unsigned success URL, setup intent, or completed-but-unpaid Checkout.
 */
async function paidCheckout(api: Stripe, sub: Stripe.Subscription, userId: string, customerId: string) {
  const sessions = await api.checkout.sessions.list({ subscription: sub.id, limit: 100 }, request);
  if (!Array.isArray(sessions.data) || sessions.has_more !== false || sessions.data.length > 1) throw new TrialPaymentCreditError();
  if (sessions.data.length === 0) return null;
  const session = await api.checkout.sessions.retrieve(sessions.data[0].id, {}, request);
  const depositPriceId = sub.metadata.trialPaymentPriceId;
  if (!depositPriceId?.startsWith("price_") || session.mode !== "subscription" || id(session.subscription) !== sub.id ||
    id(session.customer) !== customerId || session.client_reference_id !== userId || session.metadata?.userId !== userId ||
    session.metadata?.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY || session.metadata?.trialPaymentPriceId !== depositPriceId ||
    session.metadata?.trialCancellationPolicy !== sub.metadata.trialCancellationPolicy) {
    throw new TrialPaymentCreditError();
  }
  if (session.status !== "complete" || session.payment_status !== "paid") return null;
  if (session.amount_total !== TRIAL_PAYMENT_AMOUNT || session.currency !== "usd" || !id(session.invoice)) throw new TrialPaymentCreditError();
  const lines = await api.checkout.sessions.listLineItems(session.id, { limit: 100 }, request);
  if (lines.has_more !== false || lines.data.length !== 2) throw new TrialPaymentCreditError();
  const deposit = lines.data.find(line => line.price?.id === depositPriceId);
  const recurring = lines.data.find(line => line.price?.id !== depositPriceId);
  if (!deposit || deposit.quantity !== 1 || deposit.currency !== "usd" || deposit.amount_total !== TRIAL_PAYMENT_AMOUNT ||
    deposit.amount_discount !== 0 || deposit.price?.type !== "one_time" || deposit.price.unit_amount !== TRIAL_PAYMENT_AMOUNT ||
    deposit.price.currency !== "usd" || !recurring || recurring.quantity !== 1 || recurring.price?.type !== "recurring" ||
    recurring.price.currency !== "usd" || recurring.price.recurring?.interval !== "month" || recurring.price.recurring.interval_count !== 1) {
    throw new TrialPaymentCreditError();
  }
  const invoice = await api.invoices.retrieve(id(session.invoice)!, { expand: ["payments.data.payment.payment_intent"] }, request);
  if (id(invoice.customer) !== customerId || id(invoice.parent?.subscription_details?.subscription) !== sub.id ||
    invoice.billing_reason !== "subscription_create" || invoice.currency !== "usd" || invoice.total !== TRIAL_PAYMENT_AMOUNT ||
    invoice.amount_paid !== TRIAL_PAYMENT_AMOUNT || invoice.amount_remaining !== 0 || invoice.status !== "paid" ||
    invoice.payments?.has_more !== false || invoice.payments.data.length !== 1 || !invoice.status_transitions.paid_at) {
    throw new TrialPaymentCreditError();
  }
  const payment = invoice.payments.data[0];
  const intent = payment.payment.type === "payment_intent" ? payment.payment.payment_intent : undefined;
  if (payment.status !== "paid" || payment.amount_paid !== TRIAL_PAYMENT_AMOUNT || payment.currency !== "usd" ||
    id(payment.invoice) !== invoice.id || !intent || typeof intent === "string" || intent.status !== "succeeded" ||
    id(intent.customer) !== customerId || intent.currency !== "usd" || intent.amount_received !== TRIAL_PAYMENT_AMOUNT ||
    intent.amount !== TRIAL_PAYMENT_AMOUNT) throw new TrialPaymentCreditError();
  const chargeId = id(intent.latest_charge);
  if (!chargeId) throw new TrialPaymentCreditError();
  const charge = await api.charges.retrieve(chargeId, {}, request);
  if (id(charge.customer) !== customerId || id(charge.payment_intent) !== intent.id || charge.status !== "succeeded" ||
    charge.paid !== true || charge.captured !== true || charge.currency !== "usd" || charge.amount !== TRIAL_PAYMENT_AMOUNT ||
    charge.amount_captured !== TRIAL_PAYMENT_AMOUNT || charge.amount_refunded !== 0 || charge.refunded || charge.disputed) {
    throw new TrialPaymentCreditError();
  }
  return { sessionId: session.id, invoiceId: invoice.id, intentId: intent.id,
    paidAt: new Date(invoice.status_transitions.paid_at * 1000) };
}

/** Caller MUST hold the shared customer-billing advisory lock. Both webhook and
 * return-page paths use this same function; payment proof and a confirmed credit
 * are required before the new cohort receives access. Existing cohorts bypass
 * every new query/API operation. Credits apply to the next finalized invoice.
 */
export async function reconcileTrialPaymentCredit(api: Stripe, sub: Stripe.Subscription, executor: Executor = db): Promise<TrialPaymentCreditState> {
  if (!sub.metadata?.trialPaymentPolicy) return { required: false, paid: false, credited: false };
  if (sub.metadata.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY) throw new TrialPaymentCreditError();
  const userId = sub.metadata.userId, customerId = id(sub.customer);
  const cancellationPolicy = sub.metadata.trialCancellationPolicy;
  if (!userId || !customerId || !sub.id.startsWith("sub_") || !sub.trial_end ||
    !["refund_during_trial", "retain_credit"].includes(cancellationPolicy)) throw new TrialPaymentCreditError();
  const owner = resultRows(await executor.execute(sql`SELECT u.id FROM users u JOIN customer_billing_links l ON l.user_id=u.id
    WHERE u.id=${userId} AND l.stripe_customer_id=${customerId}`));
  if (owner.length !== 1) throw new TrialPaymentCreditError("Billing ownership could not be verified. Please contact support.");
  let row = resultRows<CreditRow>(await executor.execute(sql`SELECT * FROM billing_trial_payments WHERE subscription_id=${sub.id}`))[0];
  if (!row) {
    const paid = await paidCheckout(api, sub, userId, customerId);
    if (!paid) return { required: true, paid: false, credited: false };
    const paymentId = randomUUID();
    const params: Stripe.CustomerCreateBalanceTransactionParams = {
      amount: -TRIAL_PAYMENT_AMOUNT, currency: "usd", description: "Trial payment credit",
      metadata: { trialPaymentId: paymentId, trialPaymentPolicy: TRIAL_PAYMENT_POLICY, subscriptionId: sub.id, invoiceId: paid.invoiceId },
    };
    row = resultRows<CreditRow>(await executor.execute(sql`INSERT INTO billing_trial_payments
      (id,user_id,customer_id,subscription_id,checkout_session_id,invoice_id,payment_intent_id,policy_version,currency,amount,state,credit_params,paid_at,cancellation_policy,trial_ends_at)
      VALUES(${paymentId},${userId},${customerId},${sub.id},${paid.sessionId},${paid.invoiceId},${paid.intentId},
        ${TRIAL_PAYMENT_POLICY},'usd',${TRIAL_PAYMENT_AMOUNT},'paid',${JSON.stringify(params)}::jsonb,${paid.paidAt},
        ${cancellationPolicy},${new Date(sub.trial_end * 1000)}) RETURNING *`))[0];
    if (!row) throw new TrialPaymentCreditError();
  }
  verifyLedger(row, userId, customerId, sub.id);
  if (["reversal_pending", "refund_pending", "refunded", "compensation_pending", "manual_review"].includes(row.state)) {
    return { required: true, paid: false, credited: false };
  }
  if (row.state === "credited") {
    if (!row.credit_transaction_id || !row.credit_requested_at) throw new TrialPaymentCreditError();
    return { required: true, paid: true, credited: true };
  }
  const existing = await findExistingCredit(api, row);
  if (existing) {
    await markCredited(executor, row, existing);
    return { required: true, paid: true, credited: true };
  }
  if (row.state === "credit_pending" && (!row.credit_requested_at ||
    Date.now() - new Date(row.credit_requested_at).getTime() >= RETRY_WINDOW_MS)) {
    throw new TrialPaymentCreditError("We could not confirm an earlier billing credit. Please contact support.");
  }
  const pending = resultRows(await executor.execute(sql`UPDATE billing_trial_payments SET state='credit_pending',
    credit_requested_at=COALESCE(credit_requested_at,NOW()),updated_at=NOW()
    WHERE id=${row.id} AND user_id=${userId} AND state=${row.state} RETURNING id`));
  if (pending.length !== 1) throw new TrialPaymentCreditError();
  const credited = await api.customers.createBalanceTransaction(customerId, row.credit_params,
    { ...request, idempotencyKey: `trial-credit:${row.id}` });
  await markCredited(executor, row, credited);
  return { required: true, paid: true, credited: true };
}

export type TrialPaymentCancellationState = {
  applicable: boolean;
  state: "not_required" | "not_due" | "pending" | "refunded" | "manual_review";
  refunded: boolean;
};
const cancellationState = (state: TrialPaymentCancellationState["state"]): TrialPaymentCancellationState =>
  ({ applicable: state !== "not_required", state, refunded: state === "refunded" });

async function ownedLedger(executor: Executor, sub: Stripe.Subscription): Promise<CreditRow | undefined> {
  const row = resultRows<CreditRow>(await executor.execute(sql`SELECT * FROM billing_trial_payments WHERE subscription_id=${sub.id}`))[0];
  if (!row) return undefined;
  const customerId = id(sub.customer);
  if (!row.user_id || !customerId || (sub.metadata?.userId && sub.metadata.userId !== row.user_id)) throw new TrialPaymentCreditError();
  const owner = resultRows(await executor.execute(sql`SELECT u.id FROM users u JOIN customer_billing_links l ON l.user_id=u.id
    WHERE u.id=${row.user_id} AND l.stripe_customer_id=${customerId}`));
  if (owner.length !== 1) throw new TrialPaymentCreditError();
  verifyLedger(row, row.user_id, customerId, sub.id);
  return row;
}

async function manualReview(executor: Executor, row: CreditRow): Promise<TrialPaymentCancellationState> {
  await executor.execute(sql`UPDATE billing_trial_payments SET state='manual_review',updated_at=NOW() WHERE id=${row.id} AND state<>'refunded'`);
  logger.error("Trial payment requires manual billing reconciliation");
  return cancellationState("manual_review");
}

async function originalCharge(api: Stripe, row: CreditRow): Promise<Stripe.Charge> {
  const intent = await api.paymentIntents.retrieve(row.payment_intent_id, { expand: ["latest_charge"] }, request);
  if (intent.id !== row.payment_intent_id || id(intent.customer) !== row.customer_id || intent.currency !== "usd" ||
    intent.amount !== TRIAL_PAYMENT_AMOUNT || intent.amount_received !== TRIAL_PAYMENT_AMOUNT || intent.status !== "succeeded" ||
    !intent.latest_charge) throw new TrialPaymentCreditError();
  const charge = typeof intent.latest_charge === "string" ? await api.charges.retrieve(intent.latest_charge, {}, request) : intent.latest_charge;
  if (id(charge.payment_intent) !== row.payment_intent_id || id(charge.customer) !== row.customer_id ||
    charge.currency !== "usd" || charge.amount !== TRIAL_PAYMENT_AMOUNT || charge.amount_captured !== TRIAL_PAYMENT_AMOUNT ||
    charge.paid !== true || charge.captured !== true) throw new TrialPaymentCreditError();
  return charge;
}

function verifyReversal(transaction: Stripe.CustomerBalanceTransaction, row: CreditRow): void {
  if (id(transaction.customer) !== row.customer_id || transaction.type !== "adjustment" || transaction.amount !== TRIAL_PAYMENT_AMOUNT ||
    transaction.currency !== "usd" || transaction.metadata?.trialPaymentId !== row.id ||
    transaction.metadata.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY || transaction.metadata.trialPaymentAction !== "refund_reversal" ||
    transaction.metadata.subscriptionId !== row.subscription_id || transaction.metadata.invoiceId !== row.invoice_id) throw new TrialPaymentCreditError();
}

/** Restore an unused invoice credit before returning cash. Customer balance
 * history, rather than the current total alone, detects consumption by a plan
 * change or another invoice. An ambiguous/consumed credit needs manual review.
 */
async function reverseUnusedCredit(api: Stripe, row: CreditRow, executor: Executor): Promise<boolean> {
  const history = await balanceHistory(api, row);
  const reversals = history.filter(transaction => transaction.metadata?.trialPaymentId === row.id &&
    transaction.metadata.trialPaymentAction === "refund_reversal");
  if (reversals.length > 1) { await manualReview(executor, row); return false; }
  let reversal = reversals[0];
  if (reversal) verifyReversal(reversal, row);
  if (row.credit_reversal_transaction_id && row.credit_reversal_transaction_id !== reversal?.id) {
    await manualReview(executor, row); return false;
  }
  if (!reversal) {
    // Existing invoices can consume the credit independently of the app lock.
    // Refuse a reversal while any finalized debt or draft is outstanding.
    for (const status of ["open", "draft"] as const) {
      const invoices = await api.invoices.list({ customer: row.customer_id, status, limit: 100 }, request);
      if (!Array.isArray(invoices.data) || invoices.has_more !== false || invoices.data.length) {
        await manualReview(executor, row); return false;
      }
    }
    const creditIndex = history.findIndex(transaction => transaction.id === row.credit_transaction_id);
    if (creditIndex < 0) { await manualReview(executor, row); return false; }
    verifyCredit(history[creditIndex], row);
    const later = history.slice(0, creditIndex).filter(transaction => transaction.currency === "usd");
    // Stripe returns newest first. Any later invoice movement or debit means
    // this particular credit can no longer be safely identified as unspent.
    const current = history.find(transaction => transaction.currency === "usd");
    if (later.some(transaction => transaction.type !== "adjustment" || transaction.amount > 0) ||
      !current || !Number.isSafeInteger(current.ending_balance) || current.ending_balance > -TRIAL_PAYMENT_AMOUNT) {
      await manualReview(executor, row); return false;
    }
    if (row.credit_reversal_requested_at && Date.now() - new Date(row.credit_reversal_requested_at).getTime() >= RETRY_WINDOW_MS) {
      await manualReview(executor, row); return false;
    }
    const params: Stripe.CustomerCreateBalanceTransactionParams = row.credit_reversal_params ?? {
      amount: TRIAL_PAYMENT_AMOUNT, currency: "usd", description: "Trial payment credit reversal",
      metadata: { trialPaymentId: row.id, trialPaymentPolicy: TRIAL_PAYMENT_POLICY, trialPaymentAction: "refund_reversal",
        subscriptionId: row.subscription_id, invoiceId: row.invoice_id },
    };
    if (params.amount !== TRIAL_PAYMENT_AMOUNT || params.currency !== "usd" || !params.metadata || typeof params.metadata === "string" ||
      params.metadata.trialPaymentId !== row.id || params.metadata.trialPaymentAction !== "refund_reversal" ||
      params.metadata.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY || params.metadata.subscriptionId !== row.subscription_id ||
      params.metadata.invoiceId !== row.invoice_id) throw new TrialPaymentCreditError();
    const frozen = resultRows(await executor.execute(sql`UPDATE billing_trial_payments SET state='reversal_pending',
      credit_reversal_params=${JSON.stringify(params)}::jsonb,credit_reversal_requested_at=COALESCE(credit_reversal_requested_at,NOW()),updated_at=NOW()
      WHERE id=${row.id} AND state IN ('credited','reversal_pending') RETURNING id`));
    if (frozen.length !== 1) throw new TrialPaymentCreditError();
    reversal = await api.customers.createBalanceTransaction(row.customer_id, params,
      { ...request, idempotencyKey: `trial-credit-reversal:${row.id}` });
    verifyReversal(reversal, row);
  }
  const validEndingBalance = Number.isSafeInteger(reversal.ending_balance);
  const needsCompensation = validEndingBalance && reversal.ending_balance > 0;
  // Persist the provider identifier AND the next money state atomically. A
  // crash after this write cannot leave a raced debit labeled refund-ready.
  const nextState = !validEndingBalance ? "manual_review" : needsCompensation ? "compensation_pending" : "refund_pending";
  const saved = resultRows(await executor.execute(sql`UPDATE billing_trial_payments SET state=${nextState},
    credit_reversal_transaction_id=${reversal.id},updated_at=NOW() WHERE id=${row.id}
    AND state IN ('credited','reversal_pending','refund_pending') RETURNING id`));
  if (saved.length !== 1) throw new TrialPaymentCreditError();
  if (!validEndingBalance) { await manualReview(executor, row); return false; }
  if (needsCompensation) {
    // A provider-managed invoice may have consumed the credit after our last
    // read. Undo exactly our new debit before considering any cash refund.
    const pending = resultRows<CreditRow>(await executor.execute(sql`SELECT * FROM billing_trial_payments WHERE id=${row.id}`))[0];
    if (!pending) throw new TrialPaymentCreditError();
    await compensateRacedReversal(api, pending, executor);
    return false;
  }
  return true;
}

async function compensateRacedReversal(api: Stripe, row: CreditRow, executor: Executor): Promise<TrialPaymentCancellationState> {
  const candidates = (await balanceHistory(api, row)).filter(transaction => transaction.metadata?.trialPaymentId === row.id &&
    transaction.metadata.trialPaymentAction === "refund_compensation");
  if (candidates.length > 1) return manualReview(executor, row);
  let transaction = candidates[0];
  if (transaction) verifyCredit(transaction, row);
  if (row.credit_compensation_transaction_id && row.credit_compensation_transaction_id !== transaction?.id) return manualReview(executor, row);
  if (!transaction) {
    if (row.credit_compensation_requested_at && Date.now() - new Date(row.credit_compensation_requested_at).getTime() >= RETRY_WINDOW_MS) {
      return manualReview(executor, row);
    }
    const params: Stripe.CustomerCreateBalanceTransactionParams = row.credit_compensation_params ?? {
      amount: -TRIAL_PAYMENT_AMOUNT, currency: "usd", description: "Trial payment credit reversal correction",
      metadata: { trialPaymentId: row.id, trialPaymentPolicy: TRIAL_PAYMENT_POLICY, trialPaymentAction: "refund_compensation",
        subscriptionId: row.subscription_id, invoiceId: row.invoice_id },
    };
    if (params.amount !== -TRIAL_PAYMENT_AMOUNT || params.currency !== "usd" || !params.metadata || typeof params.metadata === "string" ||
      params.metadata.trialPaymentId !== row.id || params.metadata.trialPaymentAction !== "refund_compensation" ||
      params.metadata.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY || params.metadata.subscriptionId !== row.subscription_id ||
      params.metadata.invoiceId !== row.invoice_id) throw new TrialPaymentCreditError();
    const frozen = resultRows(await executor.execute(sql`UPDATE billing_trial_payments SET state='compensation_pending',
      credit_compensation_params=${JSON.stringify(params)}::jsonb,credit_compensation_requested_at=COALESCE(credit_compensation_requested_at,NOW()),updated_at=NOW()
      WHERE id=${row.id} AND state='compensation_pending' RETURNING id`));
    if (frozen.length !== 1) throw new TrialPaymentCreditError();
    transaction = await api.customers.createBalanceTransaction(row.customer_id, params,
      { ...request, idempotencyKey: `trial-credit-compensation:${row.id}` });
    verifyCredit(transaction, row);
  }
  await executor.execute(sql`UPDATE billing_trial_payments SET credit_compensation_transaction_id=${transaction.id},updated_at=NOW() WHERE id=${row.id}`);
  return manualReview(executor, row);
}

async function refundHistory(api: Stripe, row: CreditRow): Promise<Stripe.Refund[]> {
  let startingAfter: string | undefined;
  const refunds: Stripe.Refund[] = [], seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const result = await api.refunds.list({ payment_intent: row.payment_intent_id, limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}) }, request);
    if (!Array.isArray(result.data) || typeof result.has_more !== "boolean") throw new TrialPaymentCreditError();
    for (const refund of result.data) {
      if (seen.has(refund.id) || id(refund.payment_intent) !== row.payment_intent_id || refund.currency !== "usd") throw new TrialPaymentCreditError();
      seen.add(refund.id); refunds.push(refund);
    }
    if (!result.has_more) return refunds;
    startingAfter = result.data.at(-1)?.id;
    if (!startingAfter) throw new TrialPaymentCreditError();
  }
  throw new TrialPaymentCreditError();
}

function verifyRefund(refund: Stripe.Refund, row: CreditRow): void {
  if (id(refund.payment_intent) !== row.payment_intent_id || refund.currency !== "usd" || refund.amount !== TRIAL_PAYMENT_AMOUNT ||
    refund.metadata?.trialPaymentId !== row.id || refund.metadata.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY ||
    refund.metadata.trialPaymentAction !== "refund") throw new TrialPaymentCreditError();
}

async function saveRefund(executor: Executor, row: CreditRow, refund: Stripe.Refund): Promise<TrialPaymentCancellationState> {
  verifyRefund(refund, row);
  const done = refund.status === "succeeded";
  const saved = resultRows(await executor.execute(sql`UPDATE billing_trial_payments SET refund_id=${refund.id},
    state=${done ? "refunded" : "refund_pending"},refunded_at=CASE WHEN ${done} THEN COALESCE(refunded_at,NOW()) ELSE refunded_at END,updated_at=NOW()
    WHERE id=${row.id} AND state='refund_pending' RETURNING id`));
  if (saved.length !== 1) throw new TrialPaymentCreditError();
  if (["failed", "canceled"].includes(refund.status ?? "")) return manualReview(executor, row);
  return cancellationState(done ? "refunded" : "pending");
}

/** A bank can return a previously succeeded refund. Recheck its exact saved
 * provider identity on financial events, including refunds issued externally.
 * Keep the original settlement timestamp and never issue money from this path.
 */
async function revalidateSettledRefund(api: Stripe, row: CreditRow, executor: Executor): Promise<TrialPaymentCancellationState> {
  if (!row.refund_id) throw new TrialPaymentCreditError();
  const refund = await api.refunds.retrieve(row.refund_id, {}, request);
  if (refund.id !== row.refund_id || refund.currency !== row.currency || refund.amount !== row.amount) {
    throw new TrialPaymentCreditError();
  }
  const charge = await originalCharge(api, row);
  const intentId = id(refund.payment_intent), chargeId = id(refund.charge);
  if ((!intentId && !chargeId) || (intentId && intentId !== row.payment_intent_id) || (chargeId && chargeId !== charge.id)) {
    throw new TrialPaymentCreditError();
  }
  if (refund.status === "succeeded") return cancellationState("refunded");
  const saved = resultRows(await executor.execute(sql`UPDATE billing_trial_payments SET state='manual_review',updated_at=NOW()
    WHERE id=${row.id} AND state='refunded' AND refund_id=${row.refund_id} RETURNING id`));
  if (saved.length !== 1) throw new TrialPaymentCreditError();
  logger.error("A settled trial payment refund requires manual billing reconciliation");
  return cancellationState("manual_review");
}

/** Shared customer-billing lock required. Call only after cancellation is
 * confirmed at Stripe. Provider failures throw so webhook retry can reconcile;
 * the UI must still confirm cancellation and describe any refund as pending.
 */
export async function reconcileTrialPaymentCancellation(api: Stripe, sub: Stripe.Subscription, executor: Executor = db): Promise<TrialPaymentCancellationState> {
  let row = await ownedLedger(executor, sub);
  if (!row || row.cancellation_policy !== "refund_during_trial") return cancellationState("not_required");
  if (row.state === "refunded") return cancellationState("refunded");
  if (row.state === "compensation_pending") return compensateRacedReversal(api, row, executor);
  if (row.state === "manual_review") return cancellationState("manual_review");
  const begun = ["reversal_pending", "refund_pending"].includes(row.state);
  const cancelled = sub.status === "canceled" || sub.cancel_at_period_end || !!sub.cancel_at;
  if (!begun && (!cancelled || !sub.canceled_at || sub.canceled_at * 1000 >= new Date(row.trial_ends_at).getTime())) {
    return cancellationState("not_due");
  }
  // Portal cancellation may initially be scheduled. Root reconciliation closes
  // only this refundable trial cohort immediately before invoking this helper.
  if (!begun && sub.status !== "canceled") return cancellationState("pending");
  if (["paid", "credit_pending"].includes(row.state)) {
    await reconcileTrialPaymentCredit(api, sub, executor);
    row = (await ownedLedger(executor, sub))!;
  }
  const charge = await originalCharge(api, row);
  if (charge.disputed || charge.amount_refunded > 0) {
    // An already-issued refund can be ours after a lost response. Read its
    // immutable marker before treating it as a separate manual operation.
    const prior = (await refundHistory(api, row)).filter(refund => refund.metadata?.trialPaymentId === row!.id);
    if (!charge.disputed && prior.length === 1 && row.credit_reversal_transaction_id) {
      if (!await reverseUnusedCredit(api, row, executor)) return cancellationState("manual_review");
      return saveRefund(executor, row, prior[0]);
    }
    return reconcileTrialPaymentExternalReversal(api, sub, executor);
  }
  if (!await reverseUnusedCredit(api, row, executor)) return cancellationState("manual_review");
  row = (await ownedLedger(executor, sub))!;
  const refunds = await refundHistory(api, row);
  const own = refunds.filter(refund => refund.metadata?.trialPaymentId === row!.id);
  if (refunds.some(refund => refund.metadata?.trialPaymentId !== row!.id && !["failed", "canceled"].includes(refund.status ?? "")) || own.length > 1) {
    return manualReview(executor, row);
  }
  if (own[0]) return saveRefund(executor, row, own[0]);
  if (row.refund_id || (row.refund_requested_at && Date.now() - new Date(row.refund_requested_at).getTime() >= RETRY_WINDOW_MS)) {
    return manualReview(executor, row);
  }
  const params: Stripe.RefundCreateParams = row.refund_params ?? {
    payment_intent: row.payment_intent_id, amount: TRIAL_PAYMENT_AMOUNT,
    metadata: { trialPaymentId: row.id, trialPaymentPolicy: TRIAL_PAYMENT_POLICY, trialPaymentAction: "refund" },
  };
  if (params.payment_intent !== row.payment_intent_id || params.amount !== TRIAL_PAYMENT_AMOUNT || !params.metadata ||
    typeof params.metadata === "string" || params.metadata.trialPaymentId !== row.id ||
    params.metadata.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY || params.metadata.trialPaymentAction !== "refund") throw new TrialPaymentCreditError();
  const pending = resultRows(await executor.execute(sql`UPDATE billing_trial_payments SET refund_params=${JSON.stringify(params)}::jsonb,
    refund_requested_at=COALESCE(refund_requested_at,NOW()),updated_at=NOW() WHERE id=${row.id} AND state='refund_pending' RETURNING id`));
  if (pending.length !== 1) throw new TrialPaymentCreditError();
  const refund = await api.refunds.create(params, { ...request, idempotencyKey: `trial-payment-refund:${row.id}` });
  return saveRefund(executor, row, refund);
}

/** Called for refund/dispute events after resolving the subscription through
 * the persisted payment graph. It never sends cash and never decides monthly
 * access. Partial refunds or consumed credits require manual reconciliation.
 */
export async function reconcileTrialPaymentExternalReversal(api: Stripe, sub: Stripe.Subscription, executor: Executor = db): Promise<TrialPaymentCancellationState> {
  let row = await ownedLedger(executor, sub);
  if (!row) return cancellationState("not_required");
  if (row.state === "refunded") return revalidateSettledRefund(api, row, executor);
  if (row.state === "compensation_pending") return compensateRacedReversal(api, row, executor);
  if (row.state === "manual_review") return cancellationState("manual_review");
  const charge = await originalCharge(api, row);
  if (!charge.disputed && charge.amount_refunded === 0) return cancellationState("not_due");
  if ((!charge.disputed && charge.amount_refunded !== TRIAL_PAYMENT_AMOUNT) || !row.credit_transaction_id) return manualReview(executor, row);
  if (!await reverseUnusedCredit(api, row, executor)) return cancellationState("manual_review");
  row = (await ownedLedger(executor, sub))!;
  if (charge.disputed) return manualReview(executor, row);
  const paidRefunds = (await refundHistory(api, row)).filter(refund => refund.status === "succeeded");
  if (paidRefunds.length !== 1 || paidRefunds[0].amount !== TRIAL_PAYMENT_AMOUNT) return manualReview(executor, row);
  await executor.execute(sql`UPDATE billing_trial_payments SET state='refunded',refund_id=${paidRefunds[0].id},
    refunded_at=COALESCE(refunded_at,NOW()),updated_at=NOW() WHERE id=${row.id} AND state='refund_pending'`);
  return cancellationState("refunded");
}
