import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { resultRows, withOperationLease } from "./operation-lease.js";

/** Current entitlement wins over an old canceled subscription for the same
 * customer. Stripe event timestamps are deliberately not used as a total order.
 */
export function chooseCurrentSubscription(subscriptions: readonly Stripe.Subscription[]): Stripe.Subscription | null {
  const rank = (s: Stripe.Subscription) => ["active", "trialing"].includes(s.status) ? 0 :
    ["past_due", "unpaid", "paused", "incomplete"].includes(s.status) ? 1 : 2;
  return [...subscriptions].sort((a, b) => rank(a) - rank(b) || b.created - a.created)[0] ?? null;
}

export async function processStripeEventOnce(event: Pick<Stripe.Event, "id" | "type">, customerId: string, work: () => Promise<void>): Promise<void> {
  await withOperationLease(`stripe:${customerId}`, async (signal) => {
    const done = resultRows(await db.execute(sql`SELECT 1 FROM stripe_webhook_events WHERE id = ${event.id}`));
    if (done.length) return;
    await work();
    signal.throwIfAborted();
    await db.execute(sql`INSERT INTO stripe_webhook_events (id, type) VALUES (${event.id}, ${event.type}) ON CONFLICT (id) DO NOTHING`);
  });
}
