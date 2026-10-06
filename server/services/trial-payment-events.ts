import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { logger } from "../observability/logger.js";
import { withCustomerBillingLock } from "./customer-billing-lifecycle.js";
import { operationSignal, resultRows } from "./operation-lease.js";
import { reconcileTrialPaymentCancellation, reconcileTrialPaymentExternalReversal } from "./trial-payment-credit.js";

async function flagOrphanedPayment(
  executor: Pick<typeof db, "execute">,
  customerId: string,
  paymentIntentId: string,
): Promise<void> {
  operationSignal()?.throwIfAborted();
  // A refund can fail after account deletion. Keep that financial event durable
  // even though there is no longer an owner authorized for automatic settlement.
  // Preserve the original refund identifiers/timestamps for operator review.
  await executor.execute(sql`UPDATE billing_trial_payments
    SET state='manual_review',updated_at=NOW()
    WHERE customer_id=${customerId} AND payment_intent_id=${paymentIntentId}
      AND user_id IS NULL AND state<>'manual_review'`);
}

/** Customer and intent must come from the verified Stripe payment graph. The
 * caller retains signature verification and durable webhook/event deduplication.
 * A busy customer must be retried before any absence of payment proof is trusted.
 */
export async function reconcileTrialPaymentFinancialEvent(
  api: Stripe,
  customerId: string,
  paymentIntentId: string,
): Promise<void> {
  operationSignal()?.throwIfAborted();
  const owner = resultRows<{ user_id: string }>(await db.execute(sql`
    SELECT user_id FROM customer_billing_links WHERE stripe_customer_id=${customerId}`))[0];
  if (!owner) {
    // Account deletion intentionally preserves its financial ledger with no
    // user FK. Never infer authority to refund an orphaned payment automatically.
    await flagOrphanedPayment(db, customerId, paymentIntentId);
    logger.error("Payment reversal has no current application customer owner; manual financial review required");
    return;
  }

  await withCustomerBillingLock(owner.user_id, async executor => {
    operationSignal()?.throwIfAborted();
    const currentOwner = resultRows(await executor.execute(sql`
      SELECT u.id FROM users u JOIN customer_billing_links l ON l.user_id=u.id
      WHERE u.id=${owner.user_id} AND l.stripe_customer_id=${customerId}`));
    if (currentOwner.length !== 1) {
      await flagOrphanedPayment(executor, customerId, paymentIntentId);
      logger.error("Payment reversal customer ownership changed; manual financial review required");
      return;
    }
    // Read only after acquiring the same lock used by first capture, checkout,
    // cancellation and deletion. A no-row result before that lock could drop an
    // event racing with the initial durable payment proof.
    const row = resultRows<{ subscription_id: string }>(await executor.execute(sql`
      SELECT subscription_id FROM billing_trial_payments
      WHERE user_id=${owner.user_id} AND customer_id=${customerId} AND payment_intent_id=${paymentIntentId}`))[0];
    if (!row) return; // Unknown intent / later monthly invoice: no advance to reverse.

    const target = await api.subscriptions.retrieve(row.subscription_id, {}, { timeout: 15_000, maxNetworkRetries: 0 });
    const returnedCustomer = typeof target.customer === "string" ? target.customer : target.customer?.id;
    if (target.id !== row.subscription_id || returnedCustomer !== customerId ||
      (target.metadata?.userId && target.metadata.userId !== owner.user_id)) {
      throw new Error("Trial payment event subscription ownership mismatch");
    }
    operationSignal()?.throwIfAborted();
    const cancellation = await reconcileTrialPaymentCancellation(api, target, executor);
    operationSignal()?.throwIfAborted();
    const reversal = await reconcileTrialPaymentExternalReversal(api, target, executor);
    if (cancellation.state === "manual_review" || reversal.state === "manual_review") {
      logger.error("Trial payment reversal needs manual financial reconciliation");
    }
  });
}
