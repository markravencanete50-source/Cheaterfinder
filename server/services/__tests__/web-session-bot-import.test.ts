import { describe, it, expect } from "vitest";
import { parseWebSessionBotInput } from "../web-session-bot-import.js";

const cookies = "sessionid=fixture%3Atoken; csrftoken=fixture-csrf; ds_user_id=123456; rur=quoted=fixture";

describe("seller web session exports", () => {
  it("accepts the four-field session export without misreading cookies as a 2FA seed", () => {
    const [bot] = parseWebSessionBotInput(`Fixture.User|fixture-password|${cookies}|bot@example.invalid`);
    expect(bot.username).toBe("fixture.user");
    expect(bot.totp).toBeNull();
    expect(bot.email).toBe("bot@example.invalid");
    expect(bot.cookies.sessionid).toBe("fixture%3Atoken");
    expect(bot.cookies.rur).toBe("quoted=fixture");
  });
  it("preserves the older five-field TOTP export and optional trailing phone", () => {
    const [bot] = parseWebSessionBotInput(`fixture|fixture-password|JBSW Y3DP EHPK 3PXP|${cookies}|bot@example.invalid|fixture-phone`);
    expect(bot.totp).toBe("JBSWY3DPEHPK3PXP");
    expect(bot.cookies.csrftoken).toBe("fixture-csrf");
  });
  it("rejects duplicate usernames regardless of case before importing", () => {
    expect(() => parseWebSessionBotInput(`Fixture|password|${cookies}|a@example.invalid\nfixture|password|${cookies}|b@example.invalid`)).toThrow("line 2: duplicate username");
  });
  it("rejects incomplete sessions without including supplied credentials in the error", () => {
    expect(() => parseWebSessionBotInput("fixture|never-log-this-password|sessionid=never-log-this-session|a@example.invalid")).toThrow("line 1: missing csrftoken cookie");
  });
});
