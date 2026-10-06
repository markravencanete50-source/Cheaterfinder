import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const url=process.env.BACKEND_FIX_TEST_DATABASE_URL;
if(url){const parsed=new URL(url);if(parsed.pathname!=="/cheaterfinder_backend_fix_test_20260907"||!["127.0.0.1","localhost"].includes(parsed.hostname)||parsed.port==="5432")throw new Error("Guarded scratch DB required");process.env.DATABASE_URL=url;}
const mock=vi.hoisted(()=>({customers:{list:vi.fn(),create:vi.fn(),retrieve:vi.fn()},subscriptions:{list:vi.fn()},prices:{retrieve:vi.fn()},coupons:{retrieve:vi.fn()},paymentMethodConfigurations:{retrieve:vi.fn()},billingPortal:{configurations:{retrieve:vi.fn()}},checkout:{sessions:{list:vi.fn(),create:vi.fn(),expire:vi.fn()}}}));
vi.mock("stripe",()=>({default:class {constructor(){return mock;}}}));
const userId=randomUUID(),customerId="cus_checkout_fixture_"+userId;
(url?describe:describe.skip)("checkout lifecycle — actual PG and Stripe stub, no network",()=>{
  let pool:typeof import("../../db.js").pool,billing:typeof import("../../stripe.js");
  type Plan = "starter" | "standard" | "pro";
  const policy = "trial-credit-usd-99-v1";
  const acceptedVersion = (plan: Plan = "starter") => `${policy}:refund_during_trial:${plan}`;
  const trialSession = (plan: Plan = "starter") => ({
    id: "cs_paid_trial", url: "https://checkout.example/paid-trial", customer: customerId,
    client_reference_id: userId, status: "open", mode: "subscription", amount_total: 99, currency: "usd",
    metadata: { userId, plan, client: "web", trialEligible: "true", acceptedOfferVersion: acceptedVersion(plan),
      trialPaymentPolicy: policy, trialPaymentPriceId: "price_fixture_advance", trialCancellationPolicy: "refund_during_trial" },
  });
  const enablePaidTrial = (plan: Plan = "starter") => {
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_ENABLED", "true");
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_PRICE_ID", "price_fixture_advance");
    vi.stubEnv("STRIPE_TRIAL_PAYMENT_METHOD_CONFIG_ID", "pmc_immediate_fixture");
    vi.stubEnv("STRIPE_TRIAL_REFUND_PORTAL_CONFIG_ID", "bpc_immediate_refund_fixture");
    vi.stubEnv("STRIPE_TRIAL_CANCELLATION_POLICY", "refund_during_trial");
    for (const name of ["starter", "standard", "pro"] as const) vi.stubEnv(`STRIPE_TRIAL_FOUNDERS_COUPON_${name.toUpperCase()}`, `coupon_scoped_${name}`);
    mock.prices.retrieve.mockImplementation(async id => {
      if (id === "price_fixture_advance") return { id, active: true, currency: "usd", unit_amount: 99, type: "one_time", product: "prod_advance", recurring: null };
      const name = String(id).replace("price_fixture_", "") as Plan;
      return { id, active: true, currency: "usd", unit_amount: { starter: 1699, standard: 2799, pro: 4499 }[name], type: "recurring", product: `prod_${name}`, recurring: { interval: "month", interval_count: 1 } };
    });
    mock.coupons.retrieve.mockImplementation(async id => ({ id, valid: true, duration: "forever", currency: "usd", percent_off: null,
      amount_off: { starter: 500, standard: 800, pro: 1000 }[String(id).replace("coupon_scoped_", "") as Plan],
      applies_to: { products: ["prod_starter", "prod_standard", "prod_pro"] } }));
    mock.paymentMethodConfigurations.retrieve.mockResolvedValue({ id: "pmc_immediate_fixture", active: true,
      card: { available: true, display_preference: { value: "on" } }, apple_pay: { display_preference: { value: "on" } },
      google_pay: { display_preference: { value: "on" } }, us_bank_account: { display_preference: { value: "off" } } });
    mock.billingPortal.configurations.retrieve.mockResolvedValue({ id: "bpc_immediate_refund_fixture", active: true,
      features: { subscription_cancel: { enabled: true, mode: "immediately" } } });
    mock.customers.retrieve.mockResolvedValue({ id: customerId, metadata: { userId }, balance: 0, invoice_credit_balance: { usd: 0 } });
    mock.checkout.sessions.create.mockResolvedValue(trialSession(plan));
  };
  beforeAll(async()=>{
    vi.stubEnv("STRIPE_SECRET_KEY","sk_test_local_fixture_only");vi.stubEnv("STRIPE_STARTER_PRICE_ID","price_fixture_starter");vi.stubEnv("STRIPE_STANDARD_PRICE_ID","price_fixture_standard");vi.stubEnv("STRIPE_PRO_PRICE_ID","price_fixture_pro");vi.stubEnv("APP_URL","https://fixture.example");
    vi.stubEnv("STRIPE_FOUNDERS_COUPON_STARTER", "coupon_legacy_starter");
    vi.stubEnv("STRIPE_FOUNDERS_COUPON_STANDARD", "coupon_legacy_standard");
    vi.stubEnv("STRIPE_FOUNDERS_COUPON_PRO", "coupon_legacy_pro");
    pool=(await import("../../db.js")).pool;billing=await import("../../stripe.js");
  });
  beforeEach(async()=>{
    vi.resetAllMocks();vi.stubEnv("STRIPE_TRIAL_ADVANCE_ENABLED", "false");await pool.query("DELETE FROM users WHERE id=$1",[userId]);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Checkout Fixture')",[userId,userId+"@example.invalid"]);
    mock.customers.list.mockResolvedValue({data:[],has_more:false});mock.customers.create.mockResolvedValue({id:customerId});
    mock.subscriptions.list.mockResolvedValue({data:[],has_more:false});mock.checkout.sessions.list.mockResolvedValue({data:[],has_more:false});
    mock.checkout.sessions.create.mockResolvedValue({id:"cs_fixture",url:"https://checkout.example/fixture"});mock.checkout.sessions.expire.mockResolvedValue({status:"expired"});
  });
  afterAll(async()=>{vi.unstubAllEnvs();if(pool){await pool.query("DELETE FROM users WHERE id=$1",[userId]);await pool.end();}});
  const checkout=(plan:Plan="starter", version?:string)=>billing.createCheckoutSession(userId,"stale-input@example.invalid",plan,"web",undefined,version);
  const seedPendingCheckout = async (remoteStatus: "incomplete" | "trialing" = "incomplete", localRow = true) => {
    enablePaidTrial();
    const subscriptionId = "sub_pending_advance_fixture";
    await pool.query("INSERT INTO customer_billing_links(user_id,stripe_customer_id) VALUES($1,$2)", [userId, customerId]);
    if (localRow) await pool.query(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,trial_ends_at,trial_payment_policy,trial_cancellation_policy)
      VALUES($1,$2,$3,'past_due','starter',now()+interval '3 days',$4,'refund_during_trial')`, [userId, customerId, subscriptionId, policy]);
    const remote: any = { id: subscriptionId, customer: customerId, status: remoteStatus,
      trial_start: Math.floor(Date.now() / 1000), trial_end: Math.floor(Date.now() / 1000) + 3 * 86400,
      metadata: { userId, plan: "starter", trialPaymentPolicy: policy, trialCancellationPolicy: "refund_during_trial" } };
    const session: any = { ...trialSession(), subscription: subscriptionId, payment_status: "unpaid" };
    mock.subscriptions.list.mockResolvedValue({ data: [remote], has_more: false });
    mock.checkout.sessions.list.mockResolvedValue({ data: [session], has_more: false });
    return { remote, session };
  };
  it("persists customer ownership before issuing Checkout and uses the current stored email",async()=>{
    mock.checkout.sessions.create.mockImplementation(async()=>{
      expect((await pool.query("SELECT stripe_customer_id FROM customer_billing_links WHERE user_id=$1",[userId])).rows[0].stripe_customer_id).toBe(customerId);
      return{id:"cs_fixture",url:"https://checkout.example/fixture"};
    });
    await checkout();expect(mock.customers.create.mock.calls[0][0].email).toBe(userId+"@example.invalid");
    expect(mock.customers.create.mock.calls[0][1]).toEqual({idempotencyKey:"customer:"+userId});
    expect(mock.checkout.sessions.create.mock.calls[0][0]).toMatchObject({customer:customerId,metadata:{userId,plan:"starter",client:"web"}});
  });
  it("reuses a pending owned checkout without creating another Stripe customer or session",async()=>{
    await checkout();vi.clearAllMocks();
    mock.checkout.sessions.list.mockResolvedValue({data:[{id:"cs_open",url:"https://checkout.example/open",metadata:{userId,plan:"starter",client:"web",trialEligible:"true"}}],has_more:false});
    expect((await checkout()).id).toBe("cs_open");expect(mock.customers.create).not.toHaveBeenCalled();expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("rejects remote active billing even before its webhook updates the local subscription",async()=>{
    mock.subscriptions.list.mockResolvedValue({data:[{status:"active"}],has_more:false});
    await expect(checkout()).rejects.toBeInstanceOf(billing.ExistingSubscriptionError);expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("expires a previous owned plan checkout before creating a replacement, never a foreign session",async()=>{
    mock.checkout.sessions.list.mockResolvedValue({data:[{id:"cs_old",metadata:{userId,plan:"starter",client:"web"}},{id:"cs_foreign",metadata:{userId:"unrelated"}}],has_more:false});
    await checkout("standard");expect(mock.checkout.sessions.expire.mock.calls).toEqual([["cs_old"]]);
    expect(mock.checkout.sessions.expire.mock.invocationCallOrder[0]).toBeLessThan(mock.checkout.sessions.create.mock.invocationCallOrder[0]);
  });
  it("does not return a new payable link when expiring an old checkout fails",async()=>{
    mock.checkout.sessions.list.mockResolvedValue({data:[{id:"cs_old",metadata:{userId,plan:"standard",client:"web"}}],has_more:false});
    mock.checkout.sessions.expire.mockRejectedValue(new Error("provider timeout"));
    await expect(checkout()).rejects.toThrow();expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("refuses a stale authenticated request after its user was deleted",async()=>{
    await pool.query("DELETE FROM users WHERE id=$1",[userId]);await expect(checkout()).rejects.toThrow("Account no longer exists");expect(mock.customers.create).not.toHaveBeenCalled();
  });
  it("requires acceptance of the current 99-cent terms before creating a payable session", async () => {
    enablePaidTrial();
    await expect(checkout()).rejects.toThrow("Checkout terms changed");
    await expect(checkout("starter", "subscription-v1:starter:trial")).rejects.toThrow("Checkout terms changed");
    await expect(checkout("starter", acceptedVersion("standard"))).rejects.toThrow("Checkout terms changed");
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(mock.prices.retrieve).not.toHaveBeenCalled();
  });
  it.each(["starter", "standard", "pro"] as const)("collects exactly 99 cents for a new %s trial with a protected coupon and immediate payment configuration", async plan => {
    enablePaidTrial(plan);
    await expect(checkout(plan, acceptedVersion(plan))).resolves.toMatchObject({ amount_total: 99, currency: "usd" });
    expect(mock.checkout.sessions.create).toHaveBeenCalledTimes(1);
    const params = mock.checkout.sessions.create.mock.calls[0][0];
    expect(params).toMatchObject({ customer: customerId, client_reference_id: userId, mode: "subscription",
      line_items: [{ price: `price_fixture_${plan}`, quantity: 1 }, { price: "price_fixture_advance", quantity: 1 }],
      payment_method_collection: "always", payment_method_configuration: "pmc_immediate_fixture",
      discounts: [{ coupon: `coupon_scoped_${plan}` }], subscription_data: { trial_period_days: 3,
        metadata: { userId, plan, trialPaymentPolicy: policy, trialPaymentAmount: "99", acceptedOfferVersion: acceptedVersion(plan) } },
      metadata: { acceptedOfferVersion: acceptedVersion(plan), trialPaymentPolicy: policy, trialEligible: "true" } });
    expect(params).not.toHaveProperty("payment_method_types");
    expect(params.custom_text.submit.message).toContain("US$0.99 charged today");
    expect(params.custom_text.submit.message).toContain("credited once to your next invoice");
    expect(params.integration_identifier).toMatch(/^subscription_advance_[a-z]{8}$/);
  });
  it("expires an old zero-dollar trial checkout before issuing the accepted paid-trial checkout", async () => {
    enablePaidTrial();
    mock.checkout.sessions.list.mockResolvedValue({ data: [{ id: "cs_old_free", amount_total: 0,
      metadata: { userId, plan: "starter", client: "web", trialEligible: "true" } }], has_more: false });
    expect((await checkout("starter", acceptedVersion())).id).toBe("cs_paid_trial");
    expect(mock.checkout.sessions.expire).toHaveBeenCalledWith("cs_old_free");
    expect(mock.checkout.sessions.expire.mock.invocationCallOrder[0]).toBeLessThan(mock.checkout.sessions.create.mock.invocationCallOrder[0]);
  });
  it("reuses a valid pending 99-cent checkout only under the same accepted policy", async () => {
    enablePaidTrial();
    mock.checkout.sessions.list.mockResolvedValue({ data: [trialSession()], has_more: false });
    expect((await checkout("starter", acceptedVersion())).id).toBe("cs_paid_trial");
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
  });
  it.each([-99, 99])("refuses an existing USD invoice balance of %s before the trial checkout can collect a different amount", async balance => {
    enablePaidTrial();
    mock.customers.retrieve.mockResolvedValue({ id: customerId, metadata: { userId }, balance: 0, invoice_credit_balance: { usd: balance } });
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow("billing balance needs review");
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
  });
  it("checks the legacy balance field when a customer lacks per-currency invoice credit data", async () => {
    enablePaidTrial();
    mock.customers.retrieve.mockResolvedValue({ id: customerId, metadata: { userId }, balance: -99 });
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow("billing balance needs review");
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("rejects an unscoped founder coupon before issuing a zero-dollar checkout", async () => {
    enablePaidTrial();
    mock.coupons.retrieve.mockResolvedValue({ valid: true, duration: "forever", currency: "usd", amount_off: 500, percent_off: null });
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow("Trial payment setup is unavailable");
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("refuses delayed payment methods that could settle after the three-day trial", async () => {
    enablePaidTrial();
    mock.paymentMethodConfigurations.retrieve.mockResolvedValue({ active: true,
      card: { available: true, display_preference: { value: "on" } }, us_bank_account: { display_preference: { value: "on" } } });
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow("Trial payment setup is unavailable");
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it.each([0, 100])("does not return a newly created checkout whose provider total is %s cents", async amount => {
    enablePaidTrial();
    mock.checkout.sessions.create.mockResolvedValue({ ...trialSession(), amount_total: amount });
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow();
    expect(mock.checkout.sessions.expire).toHaveBeenCalledWith("cs_paid_trial");
  });
  it("does not return a 99-unit checkout in the wrong currency", async () => {
    enablePaidTrial();
    mock.checkout.sessions.create.mockResolvedValue({ ...trialSession(), currency: "eur" });
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow();
    expect(mock.checkout.sessions.expire).toHaveBeenCalledWith("cs_paid_trial");
  });
  it("does not return a payable provider session that lost the accepted terms marker", async () => {
    enablePaidTrial();
    const session = trialSession();
    mock.checkout.sessions.create.mockResolvedValue({ ...session, metadata: { ...session.metadata, acceptedOfferVersion: "stale-policy" } });
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow();
    expect(mock.checkout.sessions.expire).toHaveBeenCalledWith("cs_paid_trial");
  });
  it("never reuses a zero-dollar session even when its metadata claims the accepted 99-cent policy", async () => {
    enablePaidTrial();
    mock.checkout.sessions.list.mockResolvedValue({ data: [{ ...trialSession(), id: "cs_invalid_amount", amount_total: 0 }], has_more: false });
    let result;
    try { result = await checkout("starter", acceptedVersion()); } catch { /* Failing closed is also safe. */ }
    if (result) {
      expect(result.id).not.toBe("cs_invalid_amount");
      expect(result.amount_total).toBe(99);
    }
    expect(mock.checkout.sessions.expire).toHaveBeenCalledWith("cs_invalid_amount");
  });
  it("retains the old no-version client contract and free trial when the feature is disabled", async () => {
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_PRICE_ID", "malformed-disabled-config");
    await checkout();
    const params = mock.checkout.sessions.create.mock.calls[0][0];
    expect(params).toMatchObject({ line_items: [{ price: "price_fixture_starter", quantity: 1 }],
      subscription_data: { trial_period_days: 3 }, discounts: [{ coupon: "coupon_legacy_starter" }] });
    expect(params.metadata).not.toHaveProperty("trialPaymentPolicy");
    expect(params).not.toHaveProperty("payment_method_configuration");
    expect(mock.prices.retrieve).not.toHaveBeenCalled();
    expect(mock.customers.retrieve).not.toHaveBeenCalled();
    expect(mock.paymentMethodConfigurations.retrieve).not.toHaveBeenCalled();
  });
  it("never adds a second advance or trial to a returning customer who already used a trial", async () => {
    enablePaidTrial();
    await pool.query("UPDATE users SET trial_used_at=now() WHERE id=$1", [userId]);
    await checkout();
    const params = mock.checkout.sessions.create.mock.calls[0][0];
    expect(params.line_items).toEqual([{ price: "price_fixture_starter", quantity: 1 }]);
    expect(params.subscription_data).not.toHaveProperty("trial_period_days");
    expect(params.metadata).toMatchObject({ trialEligible: "false" });
    expect(params.metadata).not.toHaveProperty("trialPaymentPolicy");
    expect(params.discounts).toEqual([{ coupon: "coupon_legacy_starter" }]);
    expect(mock.prices.retrieve).not.toHaveBeenCalled();
  });
  it("never charges the new advance to an existing trial when the feature turns on", async () => {
    enablePaidTrial();
    mock.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_existing_free_trial", status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 86400 }], has_more: false });
    await expect(checkout("starter", acceptedVersion())).rejects.toBeInstanceOf(billing.ExistingSubscriptionError);
    expect(mock.prices.retrieve).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it.each(["incomplete", "trialing"] as const)("shows and resumes the same accepted 99-cent attempt for an unpaid %s subscription", async status => {
    const { session } = await seedPendingCheckout(status);
    const eligibility = await billing.getCheckoutEligibility(userId, "starter");
    expect(eligibility).toMatchObject({ trialEligible: true, hasAccess: false,
      offer: { version: acceptedVersion(), dueTodayAmount: 99, creditAmount: 99, recurringAmount: 1199, firstMonthlyAmount: 1100, requiresAcceptance: true } });
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect((await checkout("starter", eligibility.offer.version)).id).toBe(session.id);
    expect(mock.customers.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(mock.prices.retrieve).not.toHaveBeenCalled();
    const rows = await pool.query("SELECT stripe_subscription_id,status FROM subscriptions WHERE user_id=$1", [userId]);
    expect(rows.rows).toEqual([{ stripe_subscription_id: "sub_pending_advance_fixture", status: "past_due" }]);
  });
  it("resumes the owned initial payment before the subscription webhook has inserted a local row", async () => {
    const { session } = await seedPendingCheckout("incomplete", false);
    expect(await billing.getCheckoutEligibility(userId, "starter")).toMatchObject({ trialEligible: true, hasAccess: false, offer: { dueTodayAmount: 99 } });
    expect((await checkout("starter", acceptedVersion())).id).toBe(session.id);
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.customers.create).not.toHaveBeenCalled();
  });
  it("keeps the original accepted payment policy when new paid-trial signups are disabled", async () => {
    await seedPendingCheckout();
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_ENABLED", "false");
    vi.stubEnv("STRIPE_TRIAL_CANCELLATION_POLICY", "retain_credit");
    const eligibility = await billing.getCheckoutEligibility(userId, "starter");
    expect(eligibility.offer).toMatchObject({ version: acceptedVersion(), dueTodayAmount: 99, cancellationPolicy: "refund_during_trial" });
    await expect(checkout("starter", eligibility.offer.version)).resolves.toMatchObject({ id: "cs_paid_trial", amount_total: 99 });
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("does not resume a pending payment without renewed explicit acceptance of its stored terms", async () => {
    await seedPendingCheckout();
    await expect(checkout()).rejects.toThrow("Checkout terms changed");
    await expect(checkout("starter", "subscription-v1:starter:trial")).rejects.toThrow("Checkout terms changed");
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
  });
  it.each(["past_due", "active", "unpaid"])("does not treat a %s renewal as an initial 99-cent payment retry", async status => {
    const { remote } = await seedPendingCheckout();
    remote.status = status;
    expect(await billing.getCheckoutEligibility(userId, "starter")).toMatchObject({ trialEligible: false, hasAccess: false, offer: { creditAmount: 0, dueTodayAmount: 1199 } });
    await expect(checkout("starter", acceptedVersion())).rejects.toBeInstanceOf(billing.ExistingSubscriptionError);
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
  });
  it.each(["session owner", "subscription id", "subscription owner", "session plan", "session policy", "missing subscription"])("does not identify a resumable trial from an unrelated %s", async condition => {
    const { remote, session } = await seedPendingCheckout();
    if (condition === "session owner") session.metadata.userId = "another-user";
    if (condition === "subscription id") session.subscription = "sub_other";
    if (condition === "subscription owner") remote.metadata.userId = "another-user";
    if (condition === "session plan") session.metadata.plan = "standard";
    if (condition === "session policy") session.metadata.trialPaymentPolicy = "unrelated-policy";
    if (condition === "missing subscription") session.subscription = null;
    expect(await billing.getCheckoutEligibility(userId, "starter")).toMatchObject({ trialEligible: false, hasAccess: false });
    await expect(checkout("starter", acceptedVersion())).rejects.toBeInstanceOf(billing.ExistingSubscriptionError);
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
  });
  it.each(["customer", "client reference", "amount", "currency", "accepted terms", "cancellation policy", "paid status", "closed status", "mode"])("fails closed when a matching pending checkout has an invalid %s", async condition => {
    const { session } = await seedPendingCheckout();
    if (condition === "customer") session.customer = "cus_other";
    if (condition === "client reference") session.client_reference_id = "another-user";
    if (condition === "amount") session.amount_total = 0;
    if (condition === "currency") session.currency = "eur";
    if (condition === "accepted terms") delete session.metadata.acceptedOfferVersion;
    if (condition === "cancellation policy") session.metadata.trialCancellationPolicy = "retain_credit";
    if (condition === "paid status") session.payment_status = "paid";
    if (condition === "closed status") session.status = "complete";
    if (condition === "mode") session.mode = "payment";
    await expect(billing.getCheckoutEligibility(userId, "starter")).rejects.toThrow("needs reconciliation");
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow("needs reconciliation");
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
  });
  it("does not resume a native checkout from a web request", async () => {
    const { session } = await seedPendingCheckout();
    session.metadata.client = "mobile";
    await expect(checkout("starter", acceptedVersion())).rejects.toBeInstanceOf(billing.ExistingSubscriptionError);
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
  });
  it("does not resume a checkout for another tracked target", async () => {
    const { session } = await seedPendingCheckout();
    session.metadata.igUsername = "different.profile";
    await expect(checkout("starter", acceptedVersion())).rejects.toBeInstanceOf(billing.ExistingSubscriptionError);
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("does not trust a subscription belonging to a different Stripe customer", async () => {
    const { remote } = await seedPendingCheckout();
    remote.customer = "cus_other";
    let eligibility;
    try { eligibility = await billing.getCheckoutEligibility(userId, "starter"); } catch { /* Rejecting inconsistent provider ownership is safe. */ }
    if (eligibility) expect(eligibility.trialEligible).toBe(false);
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow();
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it("supports expanded customer and subscription references for the same owned pending attempt", async () => {
    const { remote, session } = await seedPendingCheckout();
    session.customer = { id: customerId };
    session.subscription = { id: remote.id };
    expect(await billing.getCheckoutEligibility(userId, "starter")).toMatchObject({ trialEligible: true, offer: { dueTodayAmount: 99 } });
    expect((await checkout("starter", acceptedVersion())).id).toBe(session.id);
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
  });
  it.each(["subscriptions", "sessions"])("refuses to infer a safe retry from truncated %s history", async source => {
    const { remote, session } = await seedPendingCheckout();
    if (source === "subscriptions") mock.subscriptions.list.mockResolvedValue({ data: [remote], has_more: true });
    else mock.checkout.sessions.list.mockResolvedValue({ data: [session], has_more: true });
    await expect(billing.getCheckoutEligibility(userId, "starter")).rejects.toThrow();
    await expect(checkout("starter", acceptedVersion())).rejects.toThrow();
    expect(mock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mock.checkout.sessions.expire).not.toHaveBeenCalled();
  });
});
