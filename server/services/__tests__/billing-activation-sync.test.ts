import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TRIAL_PAYMENT_POLICY } from "../../../shared/trial-payment.js";

const fixture = vi.hoisted(() => ({
  select: vi.fn(), update: vi.fn(), transaction: vi.fn(), insert: vi.fn(),
  invoice: vi.fn(), credit: vi.fn(), email: vi.fn(), lock: vi.fn(),
}));
vi.mock("../../db.js", () => ({ db: fixture }));
vi.mock("stripe", () => ({ default: class { constructor() { return { invoices: { retrieve: fixture.invoice } }; } } }));
vi.mock("../../integrations.js", () => ({ isStripeConfigured: () => true }));
vi.mock("../customer-billing-lifecycle.js", () => ({
  requireBillingUser: vi.fn(), linkedStripeCustomer: vi.fn(), saveStripeCustomerLink: vi.fn(),
  withCustomerBillingLock: fixture.lock,
}));
vi.mock("../operation-lease.js", () => ({
  resultRows: (result: { rows: unknown[] }) => result.rows, operationSignal: () => undefined, withOperationLease: vi.fn(),
}));
vi.mock("../trial-payment-credit.js", () => ({ reconcileTrialPaymentCredit: fixture.credit, reconcileTrialPaymentCancellation: vi.fn() }));
vi.mock("../trial-payment-state.js", () => ({ readTrialPaymentSummary: vi.fn(), pendingTrialPaymentSummary: vi.fn() }));
vi.mock("../transactional-emails.js", () => ({ recordSubscriptionEmail: fixture.email }));

describe("activation sync — real syncSubscription with fixture persistence and Stripe", () => {
  let sync: typeof import("../../stripe.js").syncSubscription;
  let sub: any, invoice: any, localStatus: string;
  const written: Array<{ status: string }> = [];

  beforeAll(async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_activation_fixture");
    sync = (await import("../../stripe.js")).syncSubscription;
  });
  afterAll(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks(); written.length = 0; localStatus = "trialing";
    const now = Math.floor(Date.now() / 1000);
    sub = {
      id: "sub_activation", customer: "cus_activation", status: "active", trial_end: now, trial_start: now - 300,
      metadata: { userId: "fixture_user", plan: "standard", trialPaymentPolicy: TRIAL_PAYMENT_POLICY,
        trialCancellationPolicy: "retain_credit", trialActivationPolicy: "invoice-paid-v1" },
      items: { data: [{ id: "si_monthly", current_period_end: now + 2592000, price: { id: "price_standard", recurring: { interval: "month" } } }] },
      latest_invoice: "in_monthly", cancel_at_period_end: false, cancel_at: null,
    };
    invoice = { id: "in_monthly", status: "paid", amount_paid: 1900, amount_remaining: 0, customer: "cus_activation",
      parent: { subscription_details: { subscription: "sub_activation" } }, billing_reason: "subscription_cycle",
      lines: { data: [{ amount: 1999, parent: { subscription_item_details: { subscription: "sub_activation", subscription_item: "si_monthly", proration: false } },
        pricing: { price_details: { price: "price_standard" } }, period: { start: now, end: now + 2592000 } }] },
    };
    fixture.lock.mockImplementation(async (_user, work) => work(fixture));
    fixture.credit.mockResolvedValue({ required: true, paid: true, credited: true });
    fixture.invoice.mockImplementation(async () => structuredClone(invoice));
    fixture.select.mockImplementation(selection => {
      const rows = selection.policy ? [{ policy: TRIAL_PAYMENT_POLICY, userId: "fixture_user" }] :
        selection.status ? [{ status: localStatus }] : [{ id: "fixture_user" }];
      return { from: () => ({ where: () => ({ limit: async () => rows, orderBy: async () => [] }) }) };
    });
    fixture.update.mockImplementation(() => ({ set: () => ({ where: async () => undefined }) }));
    fixture.transaction.mockImplementation(async work => work(fixture));
    fixture.insert.mockImplementation(() => ({ values: (values: { status: string }) => ({ onConflictDoUpdate: () => ({ returning: async () => {
      written.push(values); localStatus = values.status; return [values];
    } }) }) }));
  });

  it.each(["draft", "open"])("retains preview when subscription.updated arrives before its %s invoice is paid", async status => {
    invoice.status = status;
    await sync(sub);
    expect(localStatus).toBe("trialing"); expect(written).toEqual([]);
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.email).not.toHaveBeenCalled();
    // Replaying current subscription after invoice.paid is the ONLY transition.
    invoice.status = "paid";
    await sync(sub);
    expect(written).toHaveLength(1); expect(localStatus).toBe("active");
  });

  it("does not let a paid 99-cent signup invoice stand in for the first month", async () => {
    invoice.billing_reason = "subscription_create"; invoice.amount_paid = 99;
    await sync(sub);
    expect(written).toEqual([]); expect(localStatus).toBe("trialing");
  });

  it("leaves passive day-three conversion unchanged even before invoice finalization", async () => {
    delete sub.metadata.trialActivationPolicy; invoice.status = "draft";
    await sync(sub);
    expect(localStatus).toBe("active"); expect(fixture.invoice).not.toHaveBeenCalled();
  });

  it("does not change recurring invoice handling once the same subscription already activated", async () => {
    localStatus = "active"; invoice.status = "draft";
    await sync(sub);
    expect(written[0].status).toBe("active"); expect(fixture.invoice).not.toHaveBeenCalled();
  });

  it("synchronizes failed activation to past_due through the existing path", async () => {
    sub.status = "past_due"; invoice.status = "open";
    await sync(sub, { invoiceAttentionEvent: true });
    expect(localStatus).toBe("past_due"); expect(fixture.invoice).not.toHaveBeenCalled();
  });

  it("still closes entitlement for reversed advance proof while monthly payment is pending", async () => {
    fixture.credit.mockResolvedValue({ required: true, paid: false, credited: false }); invoice.status = "open";
    await sync(sub);
    expect(localStatus).toBe("past_due");
  });
});
