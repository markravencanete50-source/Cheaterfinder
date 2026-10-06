import type { CheckoutPlan } from "./billing-plans.js";

export const TRIAL_PAYMENT_POLICY = "trial-credit-usd-99-v1";
export const TRIAL_PAYMENT_AMOUNT = 99;
export type TrialCancellationPolicy = "refund_during_trial" | "retain_credit";
export interface CheckoutOffer {
  version: string;
  plan: CheckoutPlan;
  currency: "usd";
  trialDays: number;
  dueTodayAmount: number;
  creditAmount: number;
  recurringAmount: number;
  firstMonthlyAmount: number;
  requiresAcceptance: boolean;
  cancellationPolicy: TrialCancellationPolicy | "none";
}
/** A historical issued credit, not the customer's currently available balance. */
export interface TrialPaymentSummary {
  amount: number;
  currency: "usd";
  creditStatus: "credited" | "refunded" | "pending";
  cancellationPolicy: TrialCancellationPolicy;
}
