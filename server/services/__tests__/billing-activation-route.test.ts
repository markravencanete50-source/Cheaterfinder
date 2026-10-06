// Exercise production registration + authentication over local HTTP. Extraction
// avoids importing routes.ts, which starts live queues and database connections.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import vm from "node:vm";
import express from "express";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function section(file: string, start: string, end: string): string {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw Error(`Missing production extraction boundary: ${start}`);
  return source.slice(from, to);
}
const code = transformSync([
  section("../../auth.ts", "export function isAuthenticated(", "export function isAdmin(").replace("export ", ""),
  section("../billing-activation.ts", "export class BillingActivationError", "function id(").replace("export ", ""),
  section("../billing-rescue-offer.ts", "export class RescueOfferError", "interface Claims").replace("export ", ""),
  section("../customer-billing-lifecycle.ts", "export class CustomerBillingBusyError", "/** Session-level advisory lock:").replaceAll("export ", ""),
  section("../../routes.ts", '  app.post("/api/billing/activate-now"', '  app.get("/api/billing/eligibility"'),
].join("\n"), { loader: "ts", format: "cjs" }).code;

describe("production activate-now HTTP registration", () => {
  let server: Server, base: string, ctx: any;
  let activate: ReturnType<typeof vi.fn>, sync: ReturnType<typeof vi.fn>, writes: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Session resolution is the fixture boundary; authorization below is the
      // unchanged production middleware and real route registration.
      req.isAuthenticated = (() => req.headers["x-fixture-session"] === "valid") as any;
      if (req.isAuthenticated()) req.user = { id: "session_owner" } as Express.User;
      next();
    });
    activate = vi.fn().mockResolvedValue({ status: "activating" });
    sync = vi.fn(); writes = vi.fn(() => { throw Error("Route must not mutate local membership"); });
    ctx = { app, stripe: { fixture: true }, activateTrialNow: activate, syncSubscription: sync,
      claimRescueOffer: vi.fn().mockResolvedValue({ eligible: false }), verifyRescueOfferToken: vi.fn(),
      db: { insert: writes, update: writes, delete: writes, execute: writes },
      logger: { error: vi.fn() }, Error };
    vm.createContext(ctx); vm.runInContext(code, ctx);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(Number(process.env.STRESS_FAULT_PORT ?? 0), "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  async function post(authenticated = true, body: unknown = {}) {
    return fetch(`${base}/api/billing/activate-now`, {
      method: "POST", headers: { Connection: "close", "Content-Type": "application/json", ...(authenticated ? { "x-fixture-session": "valid" } : {}) },
      body: JSON.stringify(body),
    });
  }
  function error(expression: string) { return vm.runInContext(expression, ctx); }

  it("rejects unauthenticated requests before reaching the billing service", async () => {
    const response = await post(false);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ message: "Unauthorized" });
    expect(activate).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });

  it("returns activating using only the session owner and never grants access or syncs locally", async () => {
    const response = await post(true, { userId: "other_user", status: "active", stripeSubscriptionId: "sub_other", plan: "pro" });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "activating" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(activate).toHaveBeenCalledExactlyOnceWith(ctx.stripe, "session_owner");
    expect(sync).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });

  it("resolves only a verified server coupon when an offer is supplied", async () => {
    const offer = { couponId: "server_coupon", sub: "session_owner", subscriptionId: "sub_owned" };
    ctx.verifyRescueOfferToken.mockReturnValue(offer);
    const response = await post(true, { offerId: "signed_offer", couponId: "attacker_coupon" });
    expect(response.status).toBe(200);
    expect(ctx.verifyRescueOfferToken).toHaveBeenCalledExactlyOnceWith("signed_offer", "session_owner");
    expect(activate).toHaveBeenCalledExactlyOnceWith(ctx.stripe, "session_owner", "server_coupon", offer);
  });

  it.each(["tampered", "expired", null, 12, ""])("rejects an invalid offer %s without activation", async offerId => {
    ctx.verifyRescueOfferToken.mockImplementation(() => { throw error("new RescueOfferError()"); });
    const response = await post(true, { offerId });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_rescue_offer" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("authenticates rescue claims and never trusts a body user or coupon", async () => {
    const claim = (authenticated: boolean) => fetch(`${base}/api/billing/rescue-offer/claim`, {
      method: "POST", headers: { Connection: "close", "Content-Type": "application/json", ...(authenticated ? { "x-fixture-session": "valid" } : {}) },
      body: JSON.stringify({ userId: "other_user", couponId: "attacker_coupon" }),
    });
    expect((await claim(false)).status).toBe(401);
    expect(ctx.claimRescueOffer).not.toHaveBeenCalled();
    ctx.claimRescueOffer.mockResolvedValueOnce({ eligible: true, offerId: "signed_offer", plan: "Starter", percentOff: 50 });
    const response = await claim(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ eligible: true, offerId: "signed_offer", plan: "Starter", percentOff: 50 });
    expect(ctx.claimRescueOffer).toHaveBeenCalledExactlyOnceWith(ctx.stripe, "session_owner");
    expect(await (await claim(true)).json()).toEqual({ eligible: false });
  });

  it.each([
    [409, "already_active", "Your subscription is already active."],
    [400, "no_trial", "An unexpired trial is required."],
    [400, "no_payment_method", "Add a card in billing."],
    [400, "billing_ownership", "Billing ownership could not be verified."],
  ])("preserves billing error %s/%s without local writes", async (status, code, message) => {
    const Constructor = error("BillingActivationError");
    activate.mockRejectedValueOnce(new Constructor(status, code, message));
    const response = await post();
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ code, message });
    expect(sync).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });

  it.each([
    [409, "CustomerBillingBusyError"], [401, "CustomerAccountMissingError"],
  ])("preserves lifecycle failure %s/%s", async (status, constructor) => {
    const failure = error(`new ${constructor}()`);
    activate.mockRejectedValueOnce(failure);
    const response = await post();
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ message: failure.message });
  });

  it("returns 503 before any service call when Stripe is unavailable", async () => {
    ctx.stripe = null;
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Billing is unavailable. Please retry shortly." });
    expect(activate).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 for an ambiguous provider failure without leaking provider details", async () => {
    activate.mockRejectedValueOnce(Error("private Stripe request detail"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Activation could not be confirmed. Please retry; your billing status will update after confirmation." });
    expect(ctx.logger.error).toHaveBeenCalledExactlyOnceWith({ errorType: "Error" }, "[billing activation] request failed");
    expect(sync).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });
});
