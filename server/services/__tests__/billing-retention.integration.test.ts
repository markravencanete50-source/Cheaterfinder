import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || !["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.port === "5432") throw new Error("Private scratch database required");
  process.env.DATABASE_URL = url;
}
const userId = randomUUID(), otherId = randomUUID();
(url ? describe : describe.skip)("one-time retention — real ledger and locks, simulated Stripe", () => {
  let pool: typeof import("../../db.js").pool, service: typeof import("../billing-retention.js");
  const api = { subscriptions: { retrieve: vi.fn(), update: vi.fn() }, coupons: { retrieve: vi.fn(), create: vi.fn() }, invoices: { createPreview: vi.fn() } };
  const stripe = api as unknown as Stripe;
  let sub: any, coupon: any;
  const ledger = async () => (await pool.query("SELECT * FROM billing_retention_offers WHERE user_id=$1", [userId])).rows[0];
  beforeAll(async () => { pool = (await import("../../db.js")).pool; service = await import("../billing-retention.js"); });
  beforeEach(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [[userId, otherId]]);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Retention fixture'),($3,$4,'Other fixture')", [userId, userId + "@example.invalid", otherId, otherId + "@example.invalid"]);
    await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES($1,'cus_retention_fixture','sub_retention_fixture','trialing')", [userId]);
    sub = { id: "sub_retention_fixture", customer: "cus_retention_fixture", status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 86400,
      metadata: { userId }, cancel_at_period_end: false, cancel_at: null, collection_method: "charge_automatically", schedule: null,
      items: { has_more: false, data: [{ id: "si_fixture", quantity: 1, current_period_end: 1800000000, price: { id: "price_fixture", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] },
      discounts: [{ id: "di_founder", source: { coupon: { id: "founder", duration: "forever" } } }] };
    vi.resetAllMocks();
    api.subscriptions.retrieve.mockImplementation(async () => structuredClone(sub));
    api.subscriptions.update.mockImplementation(async (_id, params) => {
      expect((await ledger())?.state ?? "none").toBe(params.discounts ? "pending" : "none");
      sub = { ...sub, ...params, metadata: { ...sub.metadata, ...params.metadata } }; return structuredClone(sub);
    });
    coupon = { id: "cheaterfinder_retention_50_once_v1", valid: true, percent_off: 50, duration: "once" };
    api.coupons.retrieve.mockImplementation(async (_id, params?: Stripe.CouponRetrieveParams) => {
      const result = structuredClone(coupon);
      if (!params?.expand?.includes("applies_to")) delete result.applies_to;
      return result;
    });
    api.invoices.createPreview.mockImplementation(async params => ({ currency: "usd", discounts: ["di_founder"], total: params.discounts ? 1750 : 3500, amount_due: params.discounts ? 1750 : 3500,
      lines:{has_more:false,data:[{quantity:1,parent:{type:"subscription_item_details",subscription_item_details:{subscription:sub.id,subscription_item:"si_fixture",proration:false}},pricing:{price_details:{price:"price_fixture"}},period:{start:sub.trial_end,end:sub.trial_end+2592000}}]} }));
  });
  afterAll(async () => { if (pool) { await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [[userId, otherId]]); await pool.end(); } });
  it("quotes without changing subscription; preserves founder order; one verified redemption per account", async () => {
    const offer = await service.quoteRetentionOffer(stripe, userId); expect(offer).toMatchObject({ eligible: true, amount: 1750, regularAmount: 3500, trial: true });
    expect(api.subscriptions.update).not.toHaveBeenCalled(); if (!offer.eligible) throw Error("Expected offer");
    await service.acceptRetentionOffer(stripe, userId, offer.offerId);
    expect(api.subscriptions.update).toHaveBeenCalledWith(sub.id, { discounts: [{ discount: "di_founder" }, { coupon: "cheaterfinder_retention_50_once_v1" }], proration_behavior: "none", metadata: { retentionOfferId: offer.offerId } }, expect.objectContaining({ idempotencyKey: "retention:" + offer.offerId }));
    await service.acceptRetentionOffer(stripe, userId, offer.offerId); expect(api.subscriptions.update).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT count(*)::int n FROM transactional_emails WHERE user_id=$1 AND kind='retention'",[userId])).rows[0].n).toBe(1);
    expect((await ledger()).state).toBe("applied"); expect(await service.quoteRetentionOffer(stripe, userId)).toMatchObject({ eligible: false });
    expect(sub.trial_end).toBeGreaterThan(Date.now() / 1000); expect(sub.cancel_at_period_end).toBe(false);
  });
  it("reconciles provider success after a lost response without applying twice", async () => {
    const offer = await service.quoteRetentionOffer(stripe, userId); if (!offer.eligible) throw Error("Expected offer");
    api.subscriptions.update.mockImplementationOnce(async (_id, params) => { sub.metadata = { ...sub.metadata, ...params.metadata }; throw Error("response lost"); });
    await expect(service.acceptRetentionOffer(stripe, userId, offer.offerId)).rejects.toThrow("response lost");
    expect((await ledger()).state).toBe("pending");
    await service.acceptRetentionOffer(stripe, userId, offer.offerId);
    expect(api.subscriptions.update).toHaveBeenCalledTimes(1); expect((await ledger()).state).toBe("applied");
  });
  it("retries pending writes with frozen parameters and key, not a new offer", async () => {
    const offer = await service.quoteRetentionOffer(stripe, userId); if (!offer.eligible) throw Error("Expected offer");
    api.subscriptions.update.mockRejectedValueOnce(Error("timeout before delivery"));
    await expect(service.acceptRetentionOffer(stripe, userId, offer.offerId)).rejects.toThrow();
    expect(await service.quoteRetentionOffer(stripe, userId)).toMatchObject({offerId:offer.offerId,amount:offer.amount});
    await service.acceptRetentionOffer(stripe, userId, offer.offerId);
    expect(api.subscriptions.update.mock.calls[1]).toEqual(api.subscriptions.update.mock.calls[0]);
  });
  it("rejects changed plans, expired quotes and another account's offer", async () => {
    const offer = await service.quoteRetentionOffer(stripe, userId); if (!offer.eligible) throw Error("Expected offer");
    sub.items.data[0].price.id = "price_changed";
    await expect(service.acceptRetentionOffer(stripe, userId, offer.offerId)).rejects.toThrow("billing changed");
    sub.items.data[0].price.id = "price_fixture";
    await pool.query("UPDATE billing_retention_offers SET expires_at=now()-interval '1 second' WHERE user_id=$1", [userId]);
    await expect(service.acceptRetentionOffer(stripe, userId, offer.offerId)).rejects.toThrow("expired");
    await expect(service.acceptRetentionOffer(stripe, otherId, offer.offerId)).rejects.toThrow();
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });
  it("never repeats an ambiguous request beyond the provider idempotency window", async () => {
    const offer = await service.quoteRetentionOffer(stripe, userId); if (!offer.eligible) throw Error("Expected offer");
    await pool.query("UPDATE billing_retention_offers SET state='pending',requested_at=now()-interval '24 hours' WHERE user_id=$1", [userId]);
    await expect(service.acceptRetentionOffer(stripe, userId, offer.offerId)).rejects.toThrow("earlier request");
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });
  it.each(["past_due", "canceled", "unpaid", "incomplete"])("does not discount %s debt or revive canceled subscriptions", async status => {
    sub.status = status; expect(await service.quoteRetentionOffer(stripe, userId)).toMatchObject({ eligible: false });
    expect(api.coupons.retrieve).not.toHaveBeenCalled(); expect(api.subscriptions.update).not.toHaveBeenCalled();
  });
  it("does not replace temporary discounts or offer monthly terms to weekly plans", async () => {
    sub.discounts[0].source.coupon.duration = "once"; expect(await service.quoteRetentionOffer(stripe, userId)).toMatchObject({ eligible: false });
    sub.discounts = []; sub.items.data[0].price.recurring.interval = "week";
    expect(await service.quoteRetentionOffer(stripe, userId)).toMatchObject({ eligible: false });
  });
  it("fails closed for foreign customers and invalid coupon configuration", async () => {
    sub.customer = "cus_other"; await expect(service.quoteRetentionOffer(stripe, userId)).rejects.toThrow("ownership");
    sub.customer = "cus_retention_fixture"; api.coupons.retrieve.mockResolvedValue({ valid: true, percent_off: 100, duration: "forever" });
    await expect(service.quoteRetentionOffer(stripe, userId)).rejects.toThrow("unavailable"); expect(await ledger()).toBeUndefined();
  });
  it.each([false, true])("rejects hidden coupon product restrictions before quoting, including creation race=%s", async creationRace => {
    coupon.applies_to = { products: ["prod_other"] };
    if (creationRace) {
      api.coupons.retrieve.mockRejectedValueOnce(Object.assign(new Error("Coupon missing"), { code: "resource_missing" }));
      api.coupons.create.mockRejectedValueOnce(Object.assign(new Error("Coupon already exists"), { code: "resource_already_exists" }));
    }
    await expect(service.quoteRetentionOffer(stripe, userId)).rejects.toThrow("unavailable");
    expect(api.coupons.retrieve).toHaveBeenCalledTimes(creationRace ? 2 : 1);
    for (const call of api.coupons.retrieve.mock.calls) expect(call[1]).toEqual({ expand: ["applies_to"] });
    expect(api.invoices.createPreview).not.toHaveBeenCalled();
    expect(api.subscriptions.update).not.toHaveBeenCalled();
    expect(await ledger()).toBeUndefined();
  });
  it("cancellation remains available after an offer and never reverses a scheduled cancellation", async () => {
    await service.quoteRetentionOffer(stripe, userId);
    api.subscriptions.update.mockImplementation(async (_id, params) => { sub = { ...sub, ...params }; return sub; });
    await service.cancelCustomerSubscription(stripe, userId); await service.cancelCustomerSubscription(stripe, userId);
    expect(api.subscriptions.update).toHaveBeenCalledTimes(1); expect(api.subscriptions.update.mock.calls[0][1]).toEqual({ cancel_at_period_end: true });
    const offer = await ledger(); await expect(service.acceptRetentionOffer(stripe, userId, offer.offer_id)).rejects.toThrow("billing changed");
    expect((await pool.query("SELECT cancel_at_period_end FROM subscriptions WHERE user_id=$1", [userId])).rows[0].cancel_at_period_end).toBe(true);
  });
  it("uses the shared customer lock during provider requests", async () => {
    const lifecycle = await import("../customer-billing-lifecycle.js");
    const offer = await service.quoteRetentionOffer(stripe, userId); if (!offer.eligible) throw Error("Expected offer");
    await lifecycle.withCustomerBillingLock(userId, async () => {
      await expect(service.acceptRetentionOffer(stripe, userId,offer.offerId)).rejects.toBeInstanceOf(lifecycle.CustomerBillingBusyError);
      await expect(service.cancelCustomerSubscription(stripe, userId)).rejects.toBeInstanceOf(lifecycle.CustomerBillingBusyError);
    });
  });
  it("does not block cancellation while an optional preview is slow", async () => {
    let resume!:()=>void, reached!:()=>void;
    const started=new Promise<void>(resolve=>{reached=resolve;});const pause=new Promise<void>(resolve=>{resume=resolve;});
    const original=api.invoices.createPreview.getMockImplementation()!;
    api.invoices.createPreview.mockImplementationOnce(async params=>{reached();await pause;return original(params);});
    const quote=service.quoteRetentionOffer(stripe,userId);await started;
    try { await service.cancelCustomerSubscription(stripe,userId);expect(sub.cancel_at_period_end).toBe(true); }
    finally { resume(); }
    const offer=await quote;
    if(offer.eligible)await expect(service.acceptRetentionOffer(stripe,userId,offer.offerId)).rejects.toThrow("billing changed");
  });
  it("rejects mixed invoices, partial lines and changed quoted amounts",async()=>{
    const original=api.invoices.createPreview.getMockImplementation()!;
    api.invoices.createPreview.mockImplementation(async params=>{const value=await original(params);return{...value,lines:{...value.lines,has_more:true}};});
    expect(await service.quoteRetentionOffer(stripe,userId)).toMatchObject({eligible:false});
    api.invoices.createPreview.mockImplementation(original);
    const offer=await service.quoteRetentionOffer(stripe,userId);if(!offer.eligible)throw Error("Expected offer");
    api.invoices.createPreview.mockImplementation(async params=>({...await original(params),total:params.discounts?2000:4000,amount_due:params.discounts?2000:4000}));
    await expect(service.acceptRetentionOffer(stripe,userId,offer.offerId)).rejects.toThrow("invoice changed");
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });
  it("cannot accept an old quote while a concurrent newer quote replaces it",async()=>{
    const old=await service.quoteRetentionOffer(stripe,userId);if(!old.eligible)throw Error("Expected offer");
    api.subscriptions.retrieve.mockImplementationOnce(async()=>{
      const newer=await service.quoteRetentionOffer(stripe,userId);expect(newer.eligible).toBe(true);
      return structuredClone(sub);
    });
    await expect(service.acceptRetentionOffer(stripe,userId,old.offerId)).rejects.toThrow("newer offer");
    expect(api.subscriptions.update).not.toHaveBeenCalled();expect((await ledger()).state).toBe('quoted');
    expect((await ledger()).offer_id).not.toBe(old.offerId);
  });
  it("does not replace an inherited customer discount with a smaller effective saving",async()=>{
    const original=api.invoices.createPreview.getMockImplementation()!;
    api.invoices.createPreview.mockImplementation(async params=>({...await original(params),discounts:['di_customer_inherited']}));
    expect(await service.quoteRetentionOffer(stripe,userId)).toMatchObject({eligible:false});
    expect(api.subscriptions.update).not.toHaveBeenCalled();expect(await ledger()).toBeUndefined();
  });
  it("quotes the amount payable after the 99-cent credit, preserving the full credit after the subscription discount", async () => {
    const original = api.invoices.createPreview.getMockImplementation()!;
    api.invoices.createPreview.mockImplementation(async params => ({
      ...await original(params), amount_due: (params.discounts ? 1750 : 3500) - 99,
    }));
    const offer = await service.quoteRetentionOffer(stripe, userId);
    expect(offer).toMatchObject({ eligible: true, amount: 1651, regularAmount: 3401, recurringAmount: 3500, creditApplied: 99, currency: "usd" });
    if (!offer.eligible) throw Error("Expected offer");
    expect((await ledger()).amount).toBe(1651);
    expect((await ledger()).regular_amount).toBe(3401);
    expect((await ledger()).regular_invoice_total).toBe(3500);
    expect((await ledger()).offer_credit_applied).toBe(99);
    await service.acceptRetentionOffer(stripe, userId, offer.offerId);
    expect(api.subscriptions.update.mock.calls[0][1].discounts).toEqual([
      { discount: "di_founder" }, { coupon: "cheaterfinder_retention_50_once_v1" },
    ]);
    expect(api.subscriptions.update).toHaveBeenCalledTimes(1);
  });
  it("uses Stripe's rounded discounted amount before applying the full credit", async () => {
    const original = api.invoices.createPreview.getMockImplementation()!;
    api.invoices.createPreview.mockImplementation(async params => ({
      ...await original(params), total: params.discounts ? 1000 : 1999, amount_due: params.discounts ? 901 : 1900,
    }));
    expect(await service.quoteRetentionOffer(stripe, userId)).toMatchObject({ eligible: true, amount: 901, regularAmount: 1900,
      recurringAmount: 1999, creditApplied: 99 });
    expect(api.subscriptions.update).not.toHaveBeenCalled();
  });
  it("refuses a stale quote when account credit changes without changing the subscription or invoice subtotal", async () => {
    const original = api.invoices.createPreview.getMockImplementation()!;
    let credit = 99;
    api.invoices.createPreview.mockImplementation(async params => ({
      ...await original(params), amount_due: (params.discounts ? 1750 : 3500) - credit,
    }));
    const offer = await service.quoteRetentionOffer(stripe, userId);
    if (!offer.eligible) throw Error("Expected offer");
    const fingerprint = service.retentionFingerprint(sub);
    credit = 0;
    expect(service.retentionFingerprint(sub)).toBe(fingerprint);
    await expect(service.acceptRetentionOffer(stripe, userId, offer.offerId)).rejects.toThrow("invoice changed");
    expect(api.subscriptions.update).not.toHaveBeenCalled();
    expect((await ledger()).state).toBe("quoted");
  });
  it("does not offer a one-time reduction when credit already covers the full next invoice", async () => {
    const original = api.invoices.createPreview.getMockImplementation()!;
    api.invoices.createPreview.mockImplementation(async params => ({ ...await original(params), amount_due: 0 }));
    expect(await service.quoteRetentionOffer(stripe, userId)).toMatchObject({ eligible: false });
    expect(api.subscriptions.update).not.toHaveBeenCalled();
    expect(await ledger()).toBeUndefined();
  });
  it.each([undefined, null, -1, 10.5, NaN])("fails closed for invalid payable amount %s even when subtotal looks valid", async amountDue => {
    const original = api.invoices.createPreview.getMockImplementation()!;
    api.invoices.createPreview.mockImplementation(async params => ({ ...await original(params), amount_due: amountDue }));
    expect(await service.quoteRetentionOffer(stripe, userId)).toMatchObject({ eligible: false });
    expect(api.subscriptions.update).not.toHaveBeenCalled();
    expect(await ledger()).toBeUndefined();
  });
  it("preserves an earlier provider cancellation date instead of extending the subscription", async () => {
    sub.cancel_at = Math.floor(Date.now() / 1000) + 3600;
    await pool.query("UPDATE subscriptions SET current_period_end=now()+interval '1 day',trial_ends_at=now()+interval '1 day' WHERE user_id=$1", [userId]);
    await service.cancelCustomerSubscription(stripe, userId);
    expect(api.subscriptions.update).not.toHaveBeenCalled();
    const row = (await pool.query("SELECT cancel_at_period_end,current_period_end,trial_ends_at FROM subscriptions WHERE user_id=$1", [userId])).rows[0];
    expect(row.cancel_at_period_end).toBe(true);
    const mail=(await pool.query("SELECT payload FROM transactional_emails WHERE user_id=$1 AND kind='membership'",[userId])).rows;
    expect(mail).toHaveLength(1);expect(mail[0].payload.state.cancelAtPeriodEnd).toBe(true);
    expect(new Date(row.current_period_end).getTime()).toBe(sub.cancel_at * 1000);
    expect(new Date(row.trial_ends_at).getTime()).toBe(sub.cancel_at * 1000);
  });
});
