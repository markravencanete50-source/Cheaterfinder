import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { db, pool } from "../db.js";
import * as schema from "../../shared/schema.js";
import { resultRows } from "./operation-lease.js";
import { reconcileTrialPaymentCredit, reconcileTrialPaymentCancellation } from "./trial-payment-credit.js";
import { TRIAL_PAYMENT_POLICY } from "../../shared/trial-payment.js";

export class CustomerBillingBusyError extends Error {
  constructor() { super("Another billing or account request is in progress. Please retry shortly."); }
}
export class CustomerDeletionBillingError extends Error {
  constructor(message = "We could not confirm billing closure. Your account has not been deleted. Please retry or contact support.") { super(message); }
}
export class CustomerAccountMissingError extends Error {
  constructor() { super("Account no longer exists. Please sign in again."); }
}

/** Session-level advisory lock: no long DB transaction or expiring lease across
 * Stripe I/O. A crashed connection releases the lock. Checkout and deletion
 * share it, and must re-read user existence AFTER acquiring it.
 */
export type BillingDatabase = NodePgDatabase<typeof schema>;

export async function withCustomerBillingLock<T>(userId: string, work: (billingDb: BillingDatabase) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false, destroy = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", ["customer-billing:" + userId])).rows[0].locked === true;
    if (!locked) throw new CustomerBillingBusyError();
    // Reuse the lock-owning connection for ALL DB work in the callback.
    // Borrowing from the global pool here self-starves at 20 different users:
    // all 20 slots hold locks while all callbacks wait for a 21st connection.
    // This is a session lock, NOT a transaction held over provider requests.
    return await work(drizzle(client, { schema }));
  } finally {
    if (locked) {
      try { destroy = (await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked", ["customer-billing:" + userId])).rows[0].unlocked !== true; }
      catch { destroy = true; }
    }
    client.release(destroy);
  }
}

export async function requireBillingUser(userId: string, executor: Pick<BillingDatabase, "execute"> = db): Promise<{ id: string; email: string }> {
  const user = resultRows<{ id: string; email: string }>(await executor.execute(sql`SELECT id,email FROM users WHERE id=${userId}`))[0];
  if (!user) throw new CustomerAccountMissingError();
  return user;
}

export async function linkedStripeCustomer(userId: string, executor: Pick<BillingDatabase, "execute"> = db): Promise<string | undefined> {
  return resultRows<{ id: string }>(await executor.execute(sql`SELECT stripe_customer_id AS id FROM customer_billing_links WHERE user_id=${userId}`))[0]?.id;
}

export async function saveStripeCustomerLink(userId: string, customerId: string, executor: Pick<BillingDatabase, "execute"> = db): Promise<void> {
  await executor.execute(sql`INSERT INTO customer_billing_links(user_id,stripe_customer_id) VALUES(${userId},${customerId})
    ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=EXCLUDED.stripe_customer_id`);
}

const deletionRequest = { timeout: 15_000, maxNetworkRetries: 1 } as const;

/** Only called inside an explicit customer account-deletion request. Deleting
 * the verified Stripe Customer closes ALL subscriptions and prevents pending
 * Checkout/portal links from creating new billing after the app account is gone.
 * https://docs.stripe.com/api/customers/delete
 * No API failure/ambiguous response is permission to erase local account data.
 */
export async function closeCustomerBilling(
  api: Stripe | null,
  userId: string,
  linkedIds: readonly string[],
  executor: BillingDatabase = db,
): Promise<void> {
  if (!api) {
    if (linkedIds.length) throw new CustomerDeletionBillingError();
    return;
  }
  const ids = new Set(linkedIds);
  // Also find legacy pre-subscription Customers (created before durable links).
  // Search by immutable app id, never by email alone. Fail closed on truncation.
  if (!/^[a-zA-Z0-9_-]{1,36}$/.test(userId)) throw new CustomerDeletionBillingError();
  const candidates = await api.customers.search({ query: `metadata['userId']:'${userId}'`, limit: 100 }, deletionRequest);
  if (candidates.has_more) throw new CustomerDeletionBillingError();
  for (const customer of candidates.data) {
    if (customer.metadata?.userId === userId) ids.add(customer.id);
  }
  // Bound an abnormal legacy account; support can reconcile it explicitly.
  if (ids.size > 5) throw new CustomerDeletionBillingError();
  // Verify ALL targets before any irreversible Stripe operation.
  const pending: string[] = [];
  for (const id of ids) {
    const customer = await api.customers.retrieve(id, {}, deletionRequest);
    if (customer.deleted) {
      // A provider-side deletion is not proof that an ambiguous local refund
      // or credit write finished. Keep its application owner until reconciled.
      const unresolved = resultRows(await executor.execute(sql`SELECT 1 FROM billing_trial_payments
        WHERE customer_id=${id} AND user_id=${userId} AND state NOT IN ('credited','refunded') LIMIT 1`));
      if (unresolved.length) throw new CustomerDeletionBillingError();
      continue; // safe retry after confirmed billing closure but failed DB cleanup
    }
    if (customer.metadata?.userId && customer.metadata.userId !== userId) throw new CustomerDeletionBillingError();
    // A missing metadata tag is accepted only on a durable DB-owned link.
    if (!customer.metadata?.userId && !linkedIds.includes(id)) throw new CustomerDeletionBillingError();
    pending.push(id);
  }
  for (const id of pending) {
    const history = await api.subscriptions.list({ customer: id, status: "all", limit: 100 }, deletionRequest);
    if (history.has_more) throw new CustomerDeletionBillingError();
    const payments = resultRows<{ subscription_id: string; state: string; policy_version: string }>(await executor.execute(sql`
      SELECT subscription_id,state,policy_version FROM billing_trial_payments WHERE customer_id=${id} AND user_id=${userId}`));
    for (const payment of payments) {
      const matching = history.data.find(subscription => subscription.id === payment.subscription_id);
      if (!matching || matching.metadata.trialPaymentPolicy !== payment.policy_version || matching.metadata.userId !== userId) throw new CustomerDeletionBillingError();
    }
    for (let subscription of history.data) {
      if (subscription.metadata.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY) continue;
      if (subscription.metadata.userId !== userId) throw new CustomerDeletionBillingError();
      const payment = await reconcileTrialPaymentCredit(api, subscription, executor);
      // Do not erase an account while its captured payment is still ambiguous.
      const settled = payments.find(row => row.subscription_id === subscription.id)?.state === "refunded";
      if (!payment.paid && !settled && !["canceled", "incomplete_expired"].includes(subscription.status)) throw new CustomerDeletionBillingError();
      if (subscription.metadata.trialCancellationPolicy === "refund_during_trial" && subscription.status === "trialing" &&
        subscription.trial_end && subscription.trial_end * 1000 > Date.now()) {
        subscription = await api.subscriptions.cancel(subscription.id, { invoice_now: false, prorate: false }, deletionRequest);
        if (subscription.status !== "canceled") throw new CustomerDeletionBillingError();
      }
      const refund = await reconcileTrialPaymentCancellation(api, subscription, executor);
      if (["pending", "manual_review"].includes(refund.state)) throw new CustomerDeletionBillingError();
      const ledger = resultRows<{ state: string }>(await executor.execute(sql`SELECT state FROM billing_trial_payments WHERE subscription_id=${subscription.id} AND user_id=${userId}`))[0];
      if (ledger && !["credited", "refunded"].includes(ledger.state)) throw new CustomerDeletionBillingError();
      const balanceOwner = await api.customers.retrieve(id, {}, deletionRequest);
      if (balanceOwner.deleted) throw new CustomerDeletionBillingError();
      const available = balanceOwner.invoice_credit_balance?.usd ?? balanceOwner.balance;
      if (!Number.isSafeInteger(available) || available < 0) {
        throw new CustomerDeletionBillingError("Your account has unused billing credit. Please contact support to settle it before deleting your account.");
      }
    }
    const deleted = await api.customers.del(id, {}, deletionRequest);
    if (deleted.id !== id || deleted.deleted !== true) throw new CustomerDeletionBillingError();
  }
}

export async function deleteCustomerAccount(userId: string, stripe: Stripe | null): Promise<void> {
  return withCustomerBillingLock(userId, async billingDb => {
    await requireBillingUser(userId, billingDb);
    const before = resultRows<{ id: string }>(await billingDb.execute(sql`
      SELECT stripe_customer_id AS id FROM customer_billing_links WHERE user_id=${userId}
      UNION SELECT stripe_customer_id AS id FROM subscriptions WHERE user_id=${userId} AND stripe_customer_id IS NOT NULL
    `)).map(row => row.id);
    const incompleteLink = resultRows(await billingDb.execute(sql`SELECT 1 FROM subscriptions WHERE user_id=${userId}
      AND stripe_subscription_id IS NOT NULL AND stripe_customer_id IS NULL`));
    if (incompleteLink.length) throw new CustomerDeletionBillingError();
    try { await closeCustomerBilling(stripe, userId, before, billingDb); }
    catch (error) { throw error instanceof CustomerDeletionBillingError ? error : new CustomerDeletionBillingError(); }
    // No network inside this short atomic cleanup. A concurrent webhook changing
    // the customer association must force a retry, never bypass billing closure.
    await billingDb.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM users WHERE id=${userId} FOR UPDATE`);
      const current = resultRows<{ id: string }>(await tx.execute(sql`SELECT stripe_customer_id AS id FROM subscriptions WHERE user_id=${userId} FOR UPDATE`));
      if (current.some(row => row.id && !before.includes(row.id))) throw new CustomerDeletionBillingError();
      await tx.execute(sql`DELETE FROM session WHERE sess::jsonb #>> '{passport,user}'=${userId} OR sess::jsonb #>> '{passport,user,id}'=${userId}`);
      await tx.execute(sql`DELETE FROM device_tokens WHERE user_id=${userId}`);
      await tx.execute(sql`DELETE FROM users WHERE id=${userId}`);
    });
  });
}
