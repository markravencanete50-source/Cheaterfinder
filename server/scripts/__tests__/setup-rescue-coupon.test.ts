import { describe, expect, it, vi } from "vitest";
import { setupRescueCoupon } from "../setup-rescue-coupon";

const missing = () => Object.assign(new Error("Fixture missing coupon"), { code: "resource_missing" });
function fixture() {
  return {
    secretKey: "sk_test_fixture",
    api: { coupons: {
      retrieve: vi.fn().mockRejectedValue(missing()),
      create: vi.fn().mockResolvedValue({ id: "TRIAL_RESCUE_50" }),
    } },
    log: vi.fn(),
  };
}

describe("manual rescue coupon setup", () => {
  it("creates the requested one-time 50 percent USD coupon only when missing", async () => {
    const options = fixture();
    await expect(setupRescueCoupon(options)).resolves.toEqual({ couponId: "TRIAL_RESCUE_50", mode: "test", created: true });
    expect(options.api.coupons.retrieve).toHaveBeenCalledWith("TRIAL_RESCUE_50");
    expect(options.api.coupons.create).toHaveBeenCalledExactlyOnceWith({
      id: "TRIAL_RESCUE_50", name: "Trial Rescue 50", percent_off: 50, duration: "once", currency: "usd",
    });
    expect(options.log).toHaveBeenCalledWith("[rescue] stripe=TEST coupon=TRIAL_RESCUE_50");
  });

  it("skips an existing coupon without attempting any mutation", async () => {
    const options = fixture();
    options.api.coupons.retrieve.mockResolvedValue({ id: "TRIAL_RESCUE_50" });
    await expect(setupRescueCoupon(options)).resolves.toMatchObject({ created: false });
    expect(options.api.coupons.create).not.toHaveBeenCalled();
    expect(options.log).toHaveBeenLastCalledWith("[rescue] stripe=TEST TRIAL_RESCUE_50 already exists, skipping");
  });

  it.each([
    ["sk_test_fixture", "test"], ["sk_live_fixture", "live"],
    ["rk_test_fixture", "test"], ["rk_live_fixture", "live"],
  ])("reports the selected mode for %s without printing the key", async (secretKey, mode) => {
    const options = { ...fixture(), secretKey };
    await expect(setupRescueCoupon(options)).resolves.toMatchObject({ mode });
    expect(options.log).toHaveBeenCalledWith(`[rescue] stripe=${mode.toUpperCase()} coupon=TRIAL_RESCUE_50`);
    expect(options.log).toHaveBeenLastCalledWith(`[rescue] stripe=${mode.toUpperCase()} created TRIAL_RESCUE_50; set STRIPE_RESCUE_COUPON_ID=TRIAL_RESCUE_50`);
    expect(JSON.stringify(options.log.mock.calls)).not.toContain(secretKey);
  });

  it.each([undefined, "", "pk_test_fixture", "sk_live_", "sk_fixture", "sk_test_fixture\n"])(
    "rejects invalid keys before contacting Stripe (%s)", async secretKey => {
      const options = { ...fixture(), secretKey };
      await expect(setupRescueCoupon(options)).rejects.toThrow("STRIPE_SECRET_KEY");
      expect(options.api.coupons.retrieve).not.toHaveBeenCalled();
      expect(options.api.coupons.create).not.toHaveBeenCalled();
      expect(options.log).not.toHaveBeenCalled();
    },
  );

  it("does not create a coupon after a retrieve failure other than resource_missing", async () => {
    const options = fixture();
    options.api.coupons.retrieve.mockRejectedValue(new Error("Sensitive provider request: sk_test_fixture"));
    await expect(setupRescueCoupon(options)).rejects.toThrow("Stripe rescue coupon setup failed.");
    expect(options.api.coupons.create).not.toHaveBeenCalled();
    expect(JSON.stringify(options.log.mock.calls)).not.toContain("sk_test_fixture");
  });

  it("returns a sanitized failure when creation fails", async () => {
    const options = fixture();
    options.api.coupons.create.mockRejectedValue(new Error("Sensitive provider request: sk_test_fixture"));
    await expect(setupRescueCoupon(options)).rejects.toThrow(
      "Stripe rescue coupon setup failed. Check the selected Stripe mode, key permissions, and dashboard.",
    );
    expect(JSON.stringify(options.log.mock.calls)).not.toContain("sk_test_fixture");
  });

  it("confirms a concurrent creation and treats it as already present", async () => {
    const options = fixture();
    options.api.coupons.retrieve.mockRejectedValueOnce(missing()).mockResolvedValue({ id: "TRIAL_RESCUE_50" });
    options.api.coupons.create.mockRejectedValue(Object.assign(new Error("Already created"), { code: "resource_already_exists" }));
    await expect(setupRescueCoupon(options)).resolves.toMatchObject({ created: false });
    expect(options.api.coupons.retrieve).toHaveBeenCalledTimes(2);
    expect(options.log).toHaveBeenLastCalledWith("[rescue] stripe=TEST TRIAL_RESCUE_50 already exists, skipping");
  });

  it("does not claim success if a concurrent creation cannot be confirmed", async () => {
    const options = fixture();
    options.api.coupons.create.mockRejectedValue(Object.assign(new Error("Already created"), { code: "resource_already_exists" }));
    await expect(setupRescueCoupon(options)).rejects.toThrow("Stripe rescue coupon setup failed.");
    expect(options.log.mock.calls.flat().join(" ")).not.toContain("already exists, skipping");
  });
});
