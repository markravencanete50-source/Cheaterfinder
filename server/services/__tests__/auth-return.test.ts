import { describe, expect, it } from "vitest";
import { authPath, safeReturnTo, signedInDestination } from "../../../shared/auth-return.js";

describe("customer sign-in return destinations", () => {
  it("preserves billing queries, report pages, and internal dashboard IDs", () => {
    for (const path of ["/settings?tab=billing", "/reports", "/members?username=example", "/dashboard/account-123", "/notifications", "/payment?checkout=cancelled"]) {
      expect(safeReturnTo(path)).toBe(path);
      expect(new URLSearchParams(authPath(path).split("?")[1]).get("returnTo")).toBe(path);
    }
  });

  it("rejects external, protocol-relative, encoded, control-character and non-app destinations", () => {
    for (const path of [
      "https://example.invalid/settings", "https://cheaterfinder.com/reports", "//example.invalid/reports",
      "/\\example.invalid/reports", "/%5cexample.invalid/reports", "/%2fexample.invalid/reports",
      "javascript:alert(1)", "data:text/html,unsafe", " /reports", "/reports\n", "/reports?x=%0d%0a",
      "/reports?x=%", "/auth?returnTo=/reports", "/api/billing/portal", "/admin", "/unknown",
      "/foo/../reports", "/%72eports", "/dashboard/../../reports", "/reports?" + "x".repeat(2048),
    ]) {
      expect(safeReturnTo(path), path).toBeNull();
      expect(authPath(path), path).toBe("/auth");
      expect(signedInDestination("user", path), path).toBe("/members");
    }
  });

  it("preserves admin/default routing and the return link through the password-help page", () => {
    expect(signedInDestination("admin", "/settings?tab=billing")).toBe("/admin");
    expect(signedInDestination(undefined, null)).toBe("/members");
    expect(signedInDestination("user", "/reports")).toBe("/reports");
    expect(authPath(null, "/forgot-password")).toBe("/forgot-password");
    expect(authPath("/settings?tab=billing", "/forgot-password")).toBe("/forgot-password?returnTo=%2Fsettings%3Ftab%3Dbilling");
  });
});
