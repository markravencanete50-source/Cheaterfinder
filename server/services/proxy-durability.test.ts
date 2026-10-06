import { describe, expect, it } from "vitest";

import {
  accountProxyDurabilityIssue,
  assertDurableAccountProxyAddress,
  isDurableAccountProxyUrl,
  isKnownEphemeralDataImpulseEndpoint,
  isKnownEphemeralDataImpulseProxyUrl,
  KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX,
  SHORT_LIVED_ACCOUNT_PROXY_SQL_REGEX,
} from "./proxy-durability.js";

describe("proxy durability classification", () => {
  it.each([
    ["http://user:pass@gw.dataimpulse.com:823", true],
    ["http://user__sessttl.120:pass@gw.dataimpulse.com:10000", true],
    ["http://user:pass@gw.dataimpulse.com:19999/", true],
    ["http://user:pass@gw.dataimpulse.com:20000", true],
    ["http://user:pass@gw.dataimpulse.com:9999", false],
    ["http://user:pass@gw.dataimpulse.com:20001", false],
    ["http://user:pass@fixed.example.com:10000", false],
    ["http://user:pass@notdataimpulse.com:10000", false],
    ["http://user:pass@dataimpulse.com.evil.example:10000", false],
  ])("reports short-lived assignments accurately: %s", (url, expected) => {
    expect(new RegExp(SHORT_LIVED_ACCOUNT_PROXY_SQL_REGEX, "i").test(url)).toBe(expected);
  });

  it.each([823])(
    "classifies DataImpulse port %i as ephemeral",
    (port) => {
      expect(
        isKnownEphemeralDataImpulseEndpoint("gw.dataimpulse.com", port),
      ).toBe(true);
      expect(
        isDurableAccountProxyUrl(
          `http://example-user:example-pass@gw.dataimpulse.com:${port}`,
        ),
      ).toBe(false);
    },
  );

  it.each([10_000, 15_432, 20_000])(
    "preserves existing admission for DataImpulse sticky port %i",
    (port) => {
      expect(
        isKnownEphemeralDataImpulseEndpoint("gw.dataimpulse.com", port),
      ).toBe(false);
      expect(
        isDurableAccountProxyUrl(
          `http://example-user:example-pass@gw.dataimpulse.com:${port}`,
        ),
      ).toBe(true);
    },
  );

  it.each([9_999, 20_001])(
    "does not infer undocumented DataImpulse port %i semantics",
    (port) => {
      expect(
        isKnownEphemeralDataImpulseEndpoint("gw.dataimpulse.com", port),
      ).toBe(false);
    },
  );

  it("does not classify another provider solely by the port number", () => {
    expect(
      isDurableAccountProxyUrl(
        "http://example-user:example-pass@fixed.example.com:10000",
      ),
    ).toBe(true);
  });

  it("keeps the legacy admission predicate separate from lifetime reporting", () => {
    expect(
      isKnownEphemeralDataImpulseProxyUrl(
        "http://example-user:example-pass@gw.dataimpulse.com:12000",
      ),
    ).toBe(false);
    expect(isKnownEphemeralDataImpulseProxyUrl("not a proxy")).toBe(false);
  });

  it("rejects malformed proxy URLs", () => {
    expect(accountProxyDurabilityIssue("not a proxy")).toMatch(/invalid/);
  });

  it("allows a sticky lane into the fixed proxy importer; gateway 823 still throws", () => {
    expect(() =>
      assertDurableAccountProxyAddress("gw.dataimpulse.com", 19_998),
    ).not.toThrow();
    expect(() =>
      assertDurableAccountProxyAddress("gw.dataimpulse.com", 823),
    ).toThrow(/cannot be imported as fixed account proxies/);
  });

  // Regression guard for the 2026-08-17 outage: the ephemeral rule lives in TWO
  // independently-maintained forms — the TS predicate (used by the runtime
  // guard) and KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX (used by leaseBot,
  // bot-manager, bot-warmer, admin counts, promotion scripts). They MUST agree.
  // The outage happened because the two encodings drifted. This test evaluates
  // the SQL regex as a JS RegExp against a matrix of real-world proxy URLs and
  // asserts it matches the TS predicate on every one. If someone edits one form
  // without the other, this fails.
  describe("SQL regex and TS predicate stay consistent", () => {
    const sql = new RegExp(KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX, "i");
    const cases: ReadonlyArray<[string, number]> = [
      ["gw.dataimpulse.com", 823],
      ["gw.dataimpulse.com", 10_000],
      ["gw.dataimpulse.com", 12_000],
      ["gw.dataimpulse.com", 19_998],
      ["gw.dataimpulse.com", 20_000],
      ["gw.dataimpulse.com", 9_999],
      ["gw.dataimpulse.com", 20_001],
      ["dataimpulse.com", 823],
      ["fixed.example.com", 823],
      ["fixed.example.com", 12_000],
    ];
    it.each(cases)(
      "agree on %s:%i",
      (host, port) => {
        const url = `http://example-user:example-pass@${host}:${port}`;
        expect(sql.test(url)).toBe(
          isKnownEphemeralDataImpulseEndpoint(host, port),
        );
      },
    );
  });
});
