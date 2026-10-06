// Unit tests for server/services/bot-login.ts — inline-alert classification.
//
// Covers the fix for the dead bad-credentials detector (comma-joined `text=`
// selectors never match) and the alert classifier that decides whether a
// login alert parks the bot (bad credentials) or stays retryable (transient
// throttling / unrecognized copy). The Playwright flow itself is exercised
// live; these tests pin the pure classification logic.

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks: bot-login's module-level imports (no real IMAP/proxy/log I/O)
// ---------------------------------------------------------------------------

vi.mock("../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("./email-code-fetcher.js", () => ({
  fetchVerificationCode: vi.fn(),
}));

vi.mock("./proxy-provider.js", () => ({
  fetchHealthyEndpoints: vi.fn(),
  proxyEndpointLabel: vi.fn((endpoint: string | null | undefined) => endpoint ?? null),
  toPlaywrightProxy: vi.fn(),
}));

vi.mock("./totp.js", () => ({
  generateTotp: vi.fn(),
}));

import {
  classifyAlertText,
  BAD_CREDENTIALS_TEXT_RE,
  TRANSIENT_ALERT_TEXT_RE,
  LoginBadCredentialsError,
  LoginRateLimitedError,
  shouldUseTotpForChallenge,
} from "./bot-login.js";

// ---------------------------------------------------------------------------
// classifyAlertText — decision table
// ---------------------------------------------------------------------------

describe("classifyAlertText", () => {
  it.each([
    "Sorry, your password was incorrect. Please double-check your password.",
    "The password you entered is incorrect. Please try again.",
    "Your login information you entered is incorrect.",
    "We can help you find your account and log in.",
  ])("bad-credentials copy → bad_credentials: %s", (text) => {
    expect(classifyAlertText(text)).toBe("bad_credentials");
  });

  it.each([
    "Please wait a few minutes before you try again.",
    "There was a problem logging you into Instagram. Please try again later.",
    "Too many attempts. Wait a moment.",
  ])("transient throttling copy → rate_limited: %s", (text) => {
    expect(classifyAlertText(text)).toBe("rate_limited");
  });

  it.each([
    "Something went wrong. We're working on it.",
    "An unexpected error occurred.",
  ])("unrecognized copy stays retryable → alert: %s", (text) => {
    expect(classifyAlertText(text)).toBe("alert");
  });

  it("missing/empty text stays retryable → alert", () => {
    expect(classifyAlertText(undefined)).toBe("alert");
    expect(classifyAlertText("")).toBe("alert");
  });

  it("bad-credentials phrases win over transient phrases when both appear", () => {
    expect(
      classifyAlertText(
        "Sorry, your password was incorrect. Please try again later.",
      ),
    ).toBe("bad_credentials");
  });
});

// ---------------------------------------------------------------------------
// Regexes — single alternation, case-insensitive (the old comma-joined
// `text=` selector list was CSS-parsed by Playwright and never matched)
// ---------------------------------------------------------------------------

describe("alert text regexes", () => {
  it("BAD_CREDENTIALS_TEXT_RE matches all intended phrases, any case", () => {
    for (const phrase of [
      "login information you entered is incorrect",
      "password was incorrect",
      "incorrect password",
      "password you entered is incorrect",
      "find your account and log in",
    ]) {
      expect(BAD_CREDENTIALS_TEXT_RE.test(phrase)).toBe(true);
      expect(BAD_CREDENTIALS_TEXT_RE.test(phrase.toUpperCase())).toBe(true);
    }
  });

  it("BAD_CREDENTIALS_TEXT_RE does not match transient throttling copy", () => {
    expect(
      BAD_CREDENTIALS_TEXT_RE.test(
        "Please wait a few minutes before you try again.",
      ),
    ).toBe(false);
  });

  it("TRANSIENT_ALERT_TEXT_RE matches throttling copy only", () => {
    expect(TRANSIENT_ALERT_TEXT_RE.test("please wait a few minutes")).toBe(true);
    expect(TRANSIENT_ALERT_TEXT_RE.test("Try again later.")).toBe(true);
    expect(
      TRANSIENT_ALERT_TEXT_RE.test("Sorry, your password was incorrect."),
    ).toBe(false);
  });

  it("regexes are not stateful (no global flag re-entry bugs)", () => {
    // A /g flag would make .test() stateful across calls — guard against it.
    expect(BAD_CREDENTIALS_TEXT_RE.global).toBe(false);
    expect(TRANSIENT_ALERT_TEXT_RE.global).toBe(false);
    expect(BAD_CREDENTIALS_TEXT_RE.test("incorrect password")).toBe(true);
    expect(BAD_CREDENTIALS_TEXT_RE.test("incorrect password")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error classes — name + inheritance (instanceof drives retry/park decisions)
// ---------------------------------------------------------------------------

describe("login error classes", () => {
  it("LoginBadCredentialsError keeps the lease-exclusion phrase in messages", () => {
    const err = new LoginBadCredentialsError(
      "[bot-login] IG rejected username/password for testbot",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LoginBadCredentialsError");
    // workers.ts / ig-public-scraper.ts lease regexes match this phrase.
    expect(err.message).toMatch(/rejected username\/password/);
  });

  it("LoginRateLimitedError is a distinct, retryable error type", () => {
    const err = new LoginRateLimitedError(
      "[bot-login] IG throttled login for testbot: Please wait a few minutes before you try again.",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LoginBadCredentialsError);
    expect(err.name).toBe("LoginRateLimitedError");
  });
});

describe("shouldUseTotpForChallenge", () => {
  it.each([
    [{ isTotpPrompt: true, hasTotpSecret: true, hasEmailAddress: true }, true],
    [{ isTotpPrompt: true, hasTotpSecret: true, hasEmailAddress: false }, true],
    [{ isTotpPrompt: false, hasTotpSecret: true, hasEmailAddress: false }, true],
    [{ isTotpPrompt: false, hasTotpSecret: true, hasEmailAddress: true }, false],
    [{ isTotpPrompt: true, hasTotpSecret: false, hasEmailAddress: true }, false],
  ])("chooses TOTP for %#", (input, expected) => {
    expect(shouldUseTotpForChallenge(input)).toBe(expected);
  });
});
