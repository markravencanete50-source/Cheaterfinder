export const FREE_ACCOUNT_LIMIT = 0;

export const CHECKOUT_PLAN_IDS = ["starter", "standard", "pro"] as const;
export type CheckoutPlan = (typeof CHECKOUT_PLAN_IDS)[number];

export const LEGACY_PLAN_IDS = ["weekly", "monthly"] as const;
export type LegacyPlan = (typeof LEGACY_PLAN_IDS)[number];
export type SubscriptionPlan = CheckoutPlan | LegacyPlan;

export interface BillingPlanDefinition {
  readonly name: string;
  /** Effective price the customer pays (anchor − founders discount). */
  readonly price: number;
  readonly priceLabel: string;
  readonly cadence: "/month" | "/week";
  readonly accountLimit: number;
  readonly description: string;
  readonly legacy: boolean;
  /** Founders anchor ("before") price shown struck-through. */
  readonly anchorPrice?: number;
  readonly anchorLabel?: string;
  /** Display name of the active discount shown at checkout (e.g. "FOUNDERS"). */
  readonly discountName?: string;
  /** Red "−$X.00" savings label shown next to the discount. */
  readonly discountSaveLabel?: string;
}

export const BILLING_PLANS: Record<
  SubscriptionPlan,
  BillingPlanDefinition
> = {
  starter: {
    name: "Starter",
    price: 11.99,
    priceLabel: "$11.99",
    cadence: "/month",
    accountLimit: 1,
    description: "Track 1 Instagram account",
    legacy: false,
    anchorPrice: 16.99,
    anchorLabel: "$16.99",
    discountName: "FOUNDERS",
    discountSaveLabel: "-$5.00",
  },
  standard: {
    name: "Standard",
    price: 19.99,
    priceLabel: "$19.99",
    cadence: "/month",
    accountLimit: 3,
    description: "Track up to 3 Instagram accounts",
    legacy: false,
    anchorPrice: 27.99,
    anchorLabel: "$27.99",
    discountName: "FOUNDERS",
    discountSaveLabel: "-$8.00",
  },
  pro: {
    name: "Pro",
    price: 34.99,
    priceLabel: "$34.99",
    cadence: "/month",
    accountLimit: 6,
    description: "Track up to 6 Instagram accounts",
    legacy: false,
    anchorPrice: 44.99,
    anchorLabel: "$44.99",
    discountName: "FOUNDERS",
    discountSaveLabel: "-$10.00",
  },
  weekly: {
    name: "Weekly Intelligence",
    price: 7.95,
    priceLabel: "$7.95",
    cadence: "/week",
    accountLimit: 3,
    description: "Legacy plan · track up to 3 Instagram accounts",
    legacy: true,
  },
  monthly: {
    name: "Monthly Intelligence",
    price: 19.99,
    priceLabel: "$19.99",
    cadence: "/month",
    accountLimit: 3,
    description: "Legacy plan · track up to 3 Instagram accounts",
    legacy: true,
  },
};

export function isCheckoutPlan(value: unknown): value is CheckoutPlan {
  return (
    typeof value === "string" &&
    (CHECKOUT_PLAN_IDS as readonly string[]).includes(value)
  );
}

export function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  return (
    typeof value === "string" &&
    (
      [...CHECKOUT_PLAN_IDS, ...LEGACY_PLAN_IDS] as readonly string[]
    ).includes(value)
  );
}

export function accountLimitForPlan(
  plan: SubscriptionPlan | null | undefined,
): number {
  // Active legacy rows created before plan capture historically received three
  // tracked accounts. Preserve that entitlement instead of unexpectedly
  // downgrading an existing paying customer.
  return plan ? BILLING_PLANS[plan].accountLimit : 3;
}

export interface SubscriptionAccess {
  readonly plan?: SubscriptionPlan | null;
  readonly status?: string | null;
  readonly stripeCustomerId?: string | null;
  readonly stripeSubscriptionId?: string | null;
  readonly currentPeriodEnd?: Date | string | null;
  readonly trialEndsAt?: Date | string | null;
  readonly now?: Date;
}

/** Access expires even when a webhook is delayed. Local/manual rows cannot
 * grant access without a Stripe customer and subscription. */
export function hasSubscriptionAccess(input: SubscriptionAccess | null | undefined): boolean {
  if (!input?.stripeCustomerId?.startsWith("cus_") || !input.stripeSubscriptionId?.startsWith("sub_")) return false;
  const until = input.status === "trialing" ? input.trialEndsAt
    : input.status === "active" ? input.currentPeriodEnd : null;
  return !!until && new Date(until).getTime() > (input.now ?? new Date()).getTime();
}

export function accountLimitForSubscription(input: SubscriptionAccess): number {
  return hasSubscriptionAccess(input) ? accountLimitForPlan(input.plan) : FREE_ACCOUNT_LIMIT;
}
