// ─── TOTP (Time-based One-Time Password) generator ──────────────────────────
//
// Wave 7: support Google Authenticator-style 2FA on bot logins. ~20+ new bots
// were provisioned with TOTP-based 2FA instead of email OTP. The bot-login
// flow detects the 2FA prompt and calls into here to generate the current
// 6-digit code from the bot's stored TOTP secret.
//
// The secret is a Base32-encoded shared secret (the same string the user
// scans into Google Authenticator at provisioning time). We strip whitespace
// because users routinely paste secrets with spaces between every 4 chars.
//
// Window: 30s (RFC 6238 default). Digits: 6.
//
// Surface is intentionally minimal — the bot-login module needs exactly one
// call: "give me the current code for this secret". Verification is the
// remote IG server's job, not ours.
// ─────────────────────────────────────────────────────────────────────────────

import { generateSync } from "otplib";
import { decryptCredential, isEncryptedCredential } from "../crypto/credentials.js";

/**
 * Generate the current 6-digit TOTP code for the given Base32 secret.
 *
 * Whitespace is stripped from the secret before use — users frequently paste
 * authenticator secrets with spaces (e.g. "JBSW Y3DP EHPK 3PXP") and we want
 * to accept that gracefully rather than fail with an opaque base32 decode
 * error from the underlying library.
 *
 * Uses TOTP strategy (default) with a 30-second time step, matching Google
 * Authenticator and the RFC 6238 baseline.
 *
 * @param secret Base32-encoded TOTP secret (whitespace tolerated)
 * @returns 6-digit code as a string (zero-padded)
 * @throws if the secret is empty after whitespace stripping
 */
export function generateTotp(secret: string): string {
  if (typeof secret !== "string") {
    throw new Error("[totp] secret must be a string");
  }
  // Instagram displays setup keys as eight human-readable groups. Some G2G
  // exports preserve OCR-style lookalike numerals even though RFC 4648 Base32
  // excludes them. Tolerant authenticator decoders interpret those glyphs as
  // their intended letters; normalize the same way before handing the key to
  // otplib: 0→O, 1→L, 8→B, 9→G.
  const plaintext = isEncryptedCredential(secret) ? decryptCredential(secret) : secret;
  const normalized = plaintext
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "L")
    .replace(/8/g, "B")
    .replace(/9/g, "G");
  if (normalized.length === 0) {
    throw new Error("[totp] secret is empty after stripping whitespace");
  }
  return generateSync({ secret: normalized, strategy: "totp" });
}
