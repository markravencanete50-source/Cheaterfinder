// Wave 7: tests for the TOTP generator used by bot-login when IG presents a
// Google Authenticator-style 2FA prompt.
//
// Coverage:
//   - returns the code produced by otplib's generateSync
//   - strips whitespace from the secret before calling otplib
//   - rejects empty/whitespace-only secrets
//   - rejects non-string secrets
//   - generates a real 6-digit code for a known secret (live otplib path)

import { describe, it, expect, vi, beforeEach } from "vitest";

const generateSyncMock = vi.fn<(opts: { secret: string; strategy?: string }) => string>();

vi.mock("otplib", () => ({
  generateSync: (opts: { secret: string; strategy?: string }) =>
    generateSyncMock(opts),
}));

// Imported after the mock so the module under test sees the stub.
import { generateTotp } from "../totp.js";
import { encryptCredential } from "../../crypto/credentials.js";

describe("generateTotp", () => {
  beforeEach(() => {
    generateSyncMock.mockReset();
    generateSyncMock.mockReturnValue("123456");
  });

  it("returns the 6-digit code produced by otplib generateSync", () => {
    const code = generateTotp("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(code).toBe("123456");
    expect(generateSyncMock).toHaveBeenCalledTimes(1);
    const opts = generateSyncMock.mock.calls[0]?.[0];
    expect(opts?.secret).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(opts?.strategy).toBe("totp");
  });

  it("strips whitespace from the secret before calling otplib", () => {
    generateTotp("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP");
    const opts = generateSyncMock.mock.calls[0]?.[0];
    expect(opts?.secret).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });

  it("decrypts an imported seed only when generating its code", () => {
    vi.stubEnv("BOT_CRED_KEY", Buffer.alloc(32, 21).toString("base64"));
    try {
      const seed = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
      expect(generateTotp(encryptCredential(seed))).toBe("123456");
      expect(generateSyncMock.mock.calls[0]?.[0].secret).toBe(seed);
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects a tampered encrypted seed before invoking the authenticator", () => {
    vi.stubEnv("BOT_CRED_KEY", Buffer.alloc(32, 21).toString("base64"));
    try {
      const parts = encryptCredential("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP").split(":");
      parts[2] = Buffer.alloc(16).toString("base64");
      expect(() => generateTotp(parts.join(":"))).toThrow();
      expect(generateSyncMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it("strips tabs and newlines from the secret", () => {
    generateTotp("JBSW\tY3DP\nEHPK\r\n3PXPJBSWY3DPEHPK3PXP");
    const opts = generateSyncMock.mock.calls[0]?.[0];
    expect(opts?.secret).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });

  it("normalizes Instagram/G2G OCR lookalike digits to valid Base32", () => {
    generateTotp("ICQ0 ZZ6K TUD8 S56D ZFTB EZCQ 2Y1M D9BK");
    const opts = generateSyncMock.mock.calls[0]?.[0];
    expect(opts?.secret).toBe("ICQOZZ6KTUDBS56DZFTBEZCQ2YLMDGBK");
  });

  it("throws on an empty secret", () => {
    expect(() => generateTotp("")).toThrow(/empty/i);
    expect(generateSyncMock).not.toHaveBeenCalled();
  });

  it("throws on a whitespace-only secret", () => {
    expect(() => generateTotp("    \t\n   ")).toThrow(/empty/i);
    expect(generateSyncMock).not.toHaveBeenCalled();
  });

  it("throws on a non-string secret", () => {
    // @ts-expect-error — exercising runtime guard for non-string input
    expect(() => generateTotp(undefined)).toThrow(/string/i);
    // @ts-expect-error — exercising runtime guard for non-string input
    expect(() => generateTotp(null)).toThrow(/string/i);
    // @ts-expect-error — exercising runtime guard for non-string input
    expect(() => generateTotp(123456)).toThrow(/string/i);
  });

  it("propagates whatever otplib returns (e.g. zero-padded code)", () => {
    generateSyncMock.mockReturnValueOnce("000042");
    expect(generateTotp("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")).toBe("000042");
  });
});

describe("generateTotp (integration with real otplib)", () => {
  // This block deliberately bypasses the mock for one path by calling otplib
  // directly through the production code path. We restore the mock above
  // automatically via beforeEach, but here we let the real impl run by
  // forwarding to the actual module.

  beforeEach(async () => {
    const real = await vi.importActual<typeof import("otplib")>("otplib");
    generateSyncMock.mockImplementation((opts) =>
      real.generateSync(opts as Parameters<typeof real.generateSync>[0]),
    );
  });

  it("produces a 6-digit numeric code for a known Base32 secret", () => {
    const code = generateTotp("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(code).toMatch(/^\d{6}$/);
  });

  it("produces a code for an Instagram grouped key with lookalike digits", () => {
    const code = generateTotp("ICQ0 ZZ6K TUD8 S56D ZFTB EZCQ 2Y1M D9BK");
    expect(code).toMatch(/^\d{6}$/);
  });

  it("returns the same code for the same secret within the 30s window", () => {
    const a = generateTotp("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    const b = generateTotp("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(a).toBe(b);
  });
});
