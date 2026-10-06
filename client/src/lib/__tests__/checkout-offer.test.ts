import { describe, expect, it } from "vitest";
import { parseCheckoutOffer, parseTrialPayment } from "../checkout-offer";

const offer = {
  version: "trial-advance-99-v1", plan: "standard", currency: "usd", trialDays: 3,
  dueTodayAmount: 99, creditAmount: 99, recurringAmount: 1999, firstMonthlyAmount: 1900,
  requiresAcceptance: true, cancellationPolicy: "retain_credit",
};

describe("server-authoritative checkout offers", () => {
  it("retains minor units and the exact offered plan and policy", () => {
    expect(parseCheckoutOffer(offer, "standard")).toEqual(offer);
    expect(parseCheckoutOffer({ ...offer, cancellationPolicy: "refund_during_trial" }, "standard")?.dueTodayAmount).toBe(99);
  });
  it("refuses missing quotes, stale plan responses, invalid amounts and unconfirmed paid offers", () => {
    for (const value of [undefined, null, {}, { ...offer, plan: "starter" }, { ...offer, version: "" },
      { ...offer, dueTodayAmount: 0.99 }, { ...offer, creditAmount: 100 }, { ...offer, recurringAmount: 0 },
      { ...offer, firstMonthlyAmount: 2000 }, { ...offer, currency: "eur" }, { ...offer, trialDays: -1 },
      { ...offer, requiresAcceptance: false }, { ...offer, cancellationPolicy: "none" }]) {
      expect(parseCheckoutOffer(value, "standard")).toBeNull();
    }
  });
  it("preserves existing free-trial and regular paid checkout offers", () => {
    expect(parseCheckoutOffer({ ...offer, dueTodayAmount: 0, creditAmount: 0, firstMonthlyAmount: 1999,
      requiresAcceptance: false, cancellationPolicy: "none" }, "standard")?.dueTodayAmount).toBe(0);
    expect(parseCheckoutOffer({ ...offer, dueTodayAmount: 1999, creditAmount: 0, trialDays: 0,
      firstMonthlyAmount: 1999, requiresAcceptance: false, cancellationPolicy: "none" }, "standard")?.trialDays).toBe(0);
  });
});

describe("trial payment summary", () => {
  it("retains provider-confirmed states and rejects unsupported receipts", () => {
    for (const creditStatus of ["credited", "refunded", "pending"]) expect(parseTrialPayment({ amount: 99,
      currency: "usd", creditStatus, cancellationPolicy: "refund_during_trial" })?.creditStatus).toBe(creditStatus);
    for (const value of [null, {}, { amount: 0.99, currency: "usd", creditStatus: "credited", cancellationPolicy: "retain_credit" },
      { amount: 99, currency: "usd", creditStatus: "available", cancellationPolicy: "retain_credit" }]) {
      expect(parseTrialPayment(value)).toBeNull();
    }
  });
});
