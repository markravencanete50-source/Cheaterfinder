import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  if (new URL(url).pathname !== "/cheaterfinder_backend_fix_test_20260907") throw new Error("Guarded scratch database required");
  process.env.DATABASE_URL = url;
}
const userId = randomUUID(), otherId = randomUUID();
const customerId = "cus_fixture_" + userId;
(url ? describe : describe.skip)("customer billing/deletion lifecycle — scratch DB, mocked Stripe only", () => {
  let pool: typeof import("../../db.js").pool;
  let lifecycle: typeof import("../customer-billing-lifecycle.js");
  const api = {customers:{search:vi.fn(),retrieve:vi.fn(),del:vi.fn()},subscriptions:{list:vi.fn()}};
  const stripe = api as unknown as Stripe;
  beforeAll(async () => { pool=(await import("../../db.js")).pool; lifecycle=await import("../customer-billing-lifecycle.js"); });
  beforeEach(async () => {
    await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])",[[userId,otherId]]);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Billing fixture'),($3,$4,'Other billing fixture')",[userId,userId+"@example.invalid",otherId,otherId+"@example.invalid"]);
    await lifecycle.saveStripeCustomerLink(userId,customerId);
    await pool.query("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES($1,$2,$3,'active')",[userId,customerId,"sub_fixture_"+userId]);
    vi.resetAllMocks();
    api.customers.search.mockResolvedValue({data:[],has_more:false});
    api.subscriptions.list.mockResolvedValue({data:[],has_more:false});
    api.customers.retrieve.mockImplementation(async (id:string) => ({id,metadata:{userId}}));
    api.customers.del.mockImplementation(async (id:string)=>({id,deleted:true}));
  });
  afterAll(async () => { if(pool){await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])",[[userId,otherId]]);await pool.end();} });
  const exists = async(id=userId)=>(await pool.query("SELECT id FROM users WHERE id=$1",[id])).rowCount===1;
  it("preserves local account/subscription when Stripe is unavailable or errors", async()=>{
    await expect(lifecycle.deleteCustomerAccount(userId,null)).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    api.customers.del.mockRejectedValue(new Error("simulated Stripe outage"));
    await expect(lifecycle.deleteCustomerAccount(userId,stripe)).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(await exists()).toBe(true);
    expect((await pool.query("SELECT status FROM subscriptions WHERE user_id=$1",[userId])).rows[0].status).toBe("active");
  });
  it("does not delete a mismatched Stripe owner or truncated result set", async()=>{
    api.customers.retrieve.mockResolvedValue({id:customerId,metadata:{userId:otherId}});
    await expect(lifecycle.deleteCustomerAccount(userId,stripe)).rejects.toThrow();
    expect(api.customers.del).not.toHaveBeenCalled();
    api.customers.search.mockResolvedValue({data:[],has_more:true});
    await expect(lifecycle.deleteCustomerAccount(userId,stripe)).rejects.toThrow();
    expect(await exists()).toBe(true);
  });
  it("closes linked and owned pre-subscription customers before atomic local cleanup", async()=>{
    const legacy="cus_legacy_fixture";
    api.customers.search.mockResolvedValue({data:[{id:legacy,metadata:{userId}},{id:"cus_foreign",metadata:{userId:otherId}}],has_more:false});
    api.customers.del.mockImplementation(async(id:string)=>{expect(await exists()).toBe(true);return{id,deleted:true};});
    await lifecycle.deleteCustomerAccount(userId,stripe);
    expect(api.customers.del.mock.calls.map(call=>call[0]).sort()).toEqual([customerId,legacy].sort());
    expect(await exists()).toBe(false); expect(await exists(otherId)).toBe(true);
    expect((await pool.query("SELECT user_id FROM customer_billing_links WHERE user_id=$1",[userId])).rowCount).toBe(0);
  });
  it("safely retries if Stripe was already deleted but the app account remains", async()=>{
    api.customers.retrieve.mockResolvedValue({id:customerId,deleted:true});
    await lifecycle.deleteCustomerAccount(userId,stripe);
    expect(api.customers.del).not.toHaveBeenCalled();expect(await exists()).toBe(false);
  });
  it("fails closed on an unconfirmed Stripe deletion response", async()=>{
    api.customers.del.mockResolvedValue({id:customerId,deleted:false});
    await expect(lifecycle.deleteCustomerAccount(userId,stripe)).rejects.toThrow();
    expect(await exists()).toBe(true);
  });
  it("serializes checkout/account requests across independent database connections", async()=>{
    await lifecycle.withCustomerBillingLock(userId,async()=>{
      await expect(lifecycle.withCustomerBillingLock(userId,async()=>"must not run")).rejects.toBeInstanceOf(lifecycle.CustomerBillingBusyError);
      await expect(lifecycle.withCustomerBillingLock(otherId,async()=>"independent")).resolves.toBe("independent");
    });
    await expect(lifecycle.withCustomerBillingLock(userId,async()=>"released")).resolves.toBe("released");
    await lifecycle.deleteCustomerAccount(userId,stripe);
    await expect(lifecycle.withCustomerBillingLock(userId,()=>lifecycle.requireBillingUser(userId))).rejects.toBeInstanceOf(lifecycle.CustomerAccountMissingError);
  });
  it("does not delete the account if a concurrent webhook changed the billing owner", async()=>{
    api.customers.del.mockImplementation(async(id:string)=>{
      await pool.query("UPDATE subscriptions SET stripe_customer_id=$1 WHERE user_id=$2",["cus_changed_fixture",userId]);
      return{id,deleted:true};
    });
    await expect(lifecycle.deleteCustomerAccount(userId,stripe)).rejects.toBeInstanceOf(lifecycle.CustomerDeletionBillingError);
    expect(await exists()).toBe(true);
  });
});
