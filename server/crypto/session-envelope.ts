// ─── Session data envelope encryption ──────────────────────────────────────
//
// Wave 2 (task E): bot_accounts.session_data contains the full Playwright
// storage-state blob (sessionid, csrftoken, ds_user_id...). On plaintext
// read from Postgres that is total impersonation of the bot. Envelope with
// AES-256-GCM so a DB leak alone doesn't give the attacker working bots.
//
// Envelope format (string):
//   v1:<base64 iv>:<base64 auth tag>:<base64 ciphertext>
//
// Key material: SESSION_DATA_KEY env var, 32 bytes base64. Rotation is
// handled by re-writing rows with a new key (see docs/session-encryption.md).
// ─────────────────────────────────────────────────────────────────────────────

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENVELOPE_PREFIX = "v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.SESSION_DATA_KEY;
  if (!raw) {
    throw new Error(
      "[session-envelope] SESSION_DATA_KEY is not set — refusing to encrypt/decrypt session data",
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch (err) {
    throw new Error(
      `[session-envelope] SESSION_DATA_KEY is not valid base64: ${err instanceof Error ? err.message : "parse error"}`,
    );
  }
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `[session-envelope] SESSION_DATA_KEY must decode to ${KEY_LEN} bytes, got ${buf.length}`,
    );
  }
  cachedKey = buf;
  return buf;
}

/**
 * Validate that the env var is present and well-formed. Call once on boot;
 * in production, missing/invalid key should fail startup.
 */
export function validateSessionDataKey(): void {
  getKey();
}

export function isEncryptedEnvelope(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

export function encryptSessionData(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Decrypt a stored session value. If the stored value is plaintext (no v1:
 * prefix), return as-is — this is the lazy migration fallback documented in
 * docs/session-encryption.md. Callers using this for read SHOULD re-write
 * the row to the encrypted form so plaintext is burned down over time.
 */
export function decryptSessionData(envelope: string): string {
  if (!isEncryptedEnvelope(envelope)) {
    // Legacy plaintext row — do not throw. Fallback lets running bots keep
    // working during the one-time migration. Controlled via lazy re-encrypt.
    return envelope;
  }

  const body = envelope.slice(ENVELOPE_PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    throw new Error(
      `[session-envelope] malformed v1 envelope: expected 3 parts, got ${parts.length}`,
    );
  }
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error(
      `[session-envelope] malformed v1 envelope: iv=${iv.length}B tag=${tag.length}B`,
    );
  }
  // timingSafeEqual is not strictly needed here (GCM tag check runs inside
  // final()), but importing it keeps the intent documented and prevents
  // tree-shaking from dropping it if we add tag-format checks later.
  void timingSafeEqual;

  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Encrypt only if the input is currently plaintext. Idempotent — useful for
 * admin writes that may receive either form.
 */
export function ensureEncrypted(value: string): string {
  return isEncryptedEnvelope(value) ? value : encryptSessionData(value);
}
