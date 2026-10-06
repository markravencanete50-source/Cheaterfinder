import { describe, expect, it } from "vitest";
import { customerSessionIdentity, customerSessionMatches, customerSessionUserId } from "../customer-session-identity.js";

const user = { id: "customer-1", hashedPassword: "old-bcrypt-hash", sessionVersion: 0 };
describe("customer web session identity", () => {
  it("keeps never-revoked legacy sessions compatible", () => {
    expect(customerSessionMatches(user.id, user)).toBe(true);
  });
  it("rejects a resurrected legacy session after a password change", () => {
    expect(customerSessionMatches(user.id, { ...user, sessionVersion: 1 })).toBe(false);
  });
  it("binds new sessions to both password and revocation version", () => {
    const identity = customerSessionIdentity(user);
    expect(customerSessionMatches(identity, user)).toBe(true);
    expect(customerSessionMatches(identity, { ...user, hashedPassword: "new-hash" })).toBe(false);
    expect(customerSessionMatches(identity, { ...user, sessionVersion: 1 })).toBe(false);
    expect(customerSessionMatches(identity, { ...user, id: "another-customer" })).toBe(false);
    expect(JSON.stringify(identity)).not.toContain(user.hashedPassword);
  });
  it("fails closed on malformed session payloads", () => {
    for (const value of [null, [], {}, "", "x".repeat(37), { id: user.id },
      { ...customerSessionIdentity(user), version: -1 },
      { ...customerSessionIdentity(user), passwordVersion: "wrong" }]) {
      expect(customerSessionUserId(value)).toBeNull();
      expect(customerSessionMatches(value, user)).toBe(false);
    }
  });
});
