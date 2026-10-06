import { describe, expect, it } from "vitest";
import {
  accountLimitForPlan,
  accountLimitForSubscription,
  hasSubscriptionAccess,
  isCheckoutPlan,
} from "../../shared/billing-plans.js";
import { checkoutSchema } from "../../shared/validation.js";

const now = new Date("2026-09-11T00:00:00Z");
const paid = { status: "active", stripeCustomerId: "cus_test", stripeSubscriptionId: "sub_test", currentPeriodEnd: "2026-10-11T00:00:00Z", now };
describe("billing package entitlements", () => {
  it.each([["starter", 1], ["standard", 3], ["pro", 6], ["weekly", 3], ["monthly", 3]] as const)("%s allows %i with paid billing", (plan, limit) => {
    expect(accountLimitForSubscription({ ...paid, plan })).toBe(limit);
  });
  it("denies absent, canceled, past-due, manual and expired billing", () => {
    for (const row of [{}, { ...paid, status: "canceled" }, { ...paid, status: "past_due" }, { ...paid, stripeSubscriptionId: null }, { ...paid, stripeCustomerId: null }, { ...paid, currentPeriodEnd: null }, { ...paid, currentPeriodEnd: now }, { ...paid, currentPeriodEnd: "invalid" }]) {
      expect(hasSubscriptionAccess(row)).toBe(false);
      expect(accountLimitForSubscription(row)).toBe(0);
    }
  });
  it("requires an unexpired Stripe trial; missing end never grants access", () => {
    expect(hasSubscriptionAccess({ ...paid, status: "trialing", trialEndsAt: "2026-09-12T00:00:00Z" })).toBe(true);
    for (const trialEndsAt of [null, "invalid", now, "2026-09-10T00:00:00Z"]) expect(hasSubscriptionAccess({ ...paid, status: "trialing", trialEndsAt })).toBe(false);
  });
});

describe("checkout package validation", () => {
  it.each(["starter", "standard", "pro"])("accepts %s", (plan) => {
    expect(isCheckoutPlan(plan)).toBe(true);
    expect(checkoutSchema.safeParse({ plan }).success).toBe(true);
  });

  it.each(["weekly", "monthly", "enterprise", ""])(
    "rejects legacy/unknown checkout plan %s",
    (plan) => {
      expect(checkoutSchema.safeParse({ plan }).success).toBe(false);
    },
  );
});
