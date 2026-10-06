import { isCheckoutPlan, type CheckoutPlan } from "../../../shared/billing-plans";

export type CheckoutOffer = {
  version: string;
  plan: CheckoutPlan;
  currency: "usd";
  trialDays: number;
  dueTodayAmount: number;
  creditAmount: number;
  recurringAmount: number;
  firstMonthlyAmount: number;
  requiresAcceptance: boolean;
  cancellationPolicy: "refund_during_trial" | "retain_credit" | "none";
};

/** An unavailable or malformed quote must never become an implied free trial. */
export function parseCheckoutOffer(value: unknown, plan: CheckoutPlan): CheckoutOffer | null {
  if (!value || typeof value !== "object") return null;
  const offer = value as Record<string, unknown>;
  const amounts = [offer.dueTodayAmount, offer.creditAmount, offer.recurringAmount, offer.firstMonthlyAmount];
  if (typeof offer.version !== "string" || !offer.version.trim() || offer.version.length > 200 ||
    !isCheckoutPlan(offer.plan) || offer.plan !== plan || offer.currency !== "usd" ||
    !Number.isSafeInteger(offer.trialDays) || Number(offer.trialDays) < 0 || Number(offer.trialDays) > 365 ||
    amounts.some(amount => !Number.isSafeInteger(amount) || Number(amount) < 0) ||
    Number(offer.recurringAmount) <= 0 || Number(offer.creditAmount) > Number(offer.dueTodayAmount) ||
    Number(offer.firstMonthlyAmount) > Number(offer.recurringAmount) ||
    typeof offer.requiresAcceptance !== "boolean" ||
    !["refund_during_trial", "retain_credit", "none"].includes(String(offer.cancellationPolicy)) ||
    (Number(offer.creditAmount) > 0 && (!offer.requiresAcceptance || offer.cancellationPolicy === "none"))) return null;
  return offer as CheckoutOffer;
}

export type TrialPaymentSummary = {
  amount: number;
  currency: string;
  creditStatus: "credited" | "refunded" | "pending";
  cancellationPolicy: "refund_during_trial" | "retain_credit" | "none";
};

export function parseTrialPayment(value: unknown): TrialPaymentSummary | null {
  if (!value || typeof value !== "object") return null;
  const payment = value as Record<string, unknown>;
  if (!Number.isSafeInteger(payment.amount) || Number(payment.amount) <= 0 ||
    payment.currency !== "usd" || !["credited", "refunded", "pending"].includes(String(payment.creditStatus)) ||
    !["refund_during_trial", "retain_credit", "none"].includes(String(payment.cancellationPolicy))) return null;
  return payment as TrialPaymentSummary;
}
