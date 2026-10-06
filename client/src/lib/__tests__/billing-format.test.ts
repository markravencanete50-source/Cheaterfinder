import { describe, expect, it } from "vitest";
import { formatBillingAmount } from "../billing-format";

describe("billing amount display", () => {
  it("formats cents for a currency with two decimal places", () => {
    expect(formatBillingAmount(1299, "usd", "en-US")).toBe("$12.99");
  });
  it("does not divide a zero-decimal currency by 100", () => {
    expect(formatBillingAmount(1200, "jpy", "en-US")).toBe("¥1,200");
  });
  it("preserves three-decimal currencies", () => {
    expect(formatBillingAmount(12345, "kwd", "en-US").replace(/\s/g, "")).toBe("KWD12.345");
  });
  it("displays a zero invoice amount instead of a missing amount", () => {
    expect(formatBillingAmount(0, "usd", "en-US")).toBe("$0.00");
  });
});
