import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { resultRows } from "./operation-lease.js";
import { type TrialPaymentSummary } from "../../shared/trial-payment.js";
import { TRIAL_PAYMENT_POLICY } from "../../shared/trial-payment.js";

export function pendingTrialPaymentSummary(policy: string | null | undefined, cancellationPolicy: string | null | undefined): TrialPaymentSummary | undefined {
  if (policy !== TRIAL_PAYMENT_POLICY || !["refund_during_trial", "retain_credit"].includes(cancellationPolicy ?? "")) return undefined;
  return { amount: 99, currency: "usd", creditStatus: "pending", cancellationPolicy: cancellationPolicy as TrialPaymentSummary["cancellationPolicy"] };
}

export function trialPaymentSummary(row: { amount: number; currency: string; state: string; cancellation_policy: string } | undefined): TrialPaymentSummary | undefined {
  if (!row || row.amount !== 99 || row.currency !== "usd" || !["refund_during_trial", "retain_credit"].includes(row.cancellation_policy)) return undefined;
  return { amount: row.amount, currency: "usd", creditStatus: row.state === "credited" ? "credited" : row.state === "refunded" ? "refunded" : "pending",
    cancellationPolicy: row.cancellation_policy as TrialPaymentSummary["cancellationPolicy"] };
}

export async function readTrialPaymentSummary(userId: string, subscriptionId: string, executor: Pick<typeof db,"execute"> = db): Promise<TrialPaymentSummary | undefined> {
  const row = resultRows<{amount:number;currency:string;state:string;cancellation_policy:string}>(await executor.execute(sql`
    SELECT amount,currency,state,cancellation_policy FROM billing_trial_payments
    WHERE user_id=${userId} AND subscription_id=${subscriptionId}`))[0];
  return trialPaymentSummary(row);
}
