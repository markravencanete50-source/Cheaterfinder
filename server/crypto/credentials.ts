// ─── Bot credential envelope encryption ─────────────────────────────────────
//
// Wave 4: bot_accounts now stores raw IG passwords + email/IMAP passwords so
// the worker can re-login a bot whose session_data has expired. Storing those
// in plaintext is not OK — a DB leak would hand an attacker every bot in the
// pool. Wrap them in the same AES-256-GCM envelope we already use for
// session_data, so a single key unlock policy applies to all sensitive
// columns on the row.
//
// Format mirrors session-envelope so an operator can rotate one key without
// touching the other family of columns:
//   v1:<base64 iv>:<base64 auth tag>:<base64 ciphertext>
//
// Key material: BOT_CRED_KEY env var, 32 bytes base64. Falls back to
// SESSION_DATA_KEY for dev convenience so a fresh checkout doesn't need a
// second secret to boot — production deployments MUST set BOT_CRED_KEY
// explicitly to a *different* value than SESSION_DATA_KEY (separation of
// concerns: one key compromise should not cascade).
// ─────────────────────────────────────────────────────────────────────────────

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ENVELOPE_PREFIX = "v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.BOT_CRED_KEY ?? process.env.SESSION_DATA_KEY;
  if (!raw) {
    throw new Error(
      "[bot-cred-envelope] BOT_CRED_KEY (or SESSION_DATA_KEY) is not set",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `[bot-cred-envelope] key must decode to ${KEY_LEN} bytes, got ${buf.length}`,
    );
  }
  cachedKey = buf;
  return buf;
}

export function validateBotCredKey(): void {
  getKey();
}

export function isEncryptedCredential(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

export function encryptCredential(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("[bot-cred-envelope] refuse to encrypt empty plaintext");
  }
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptCredential(envelope: string): string {
  if (!isEncryptedCredential(envelope)) {
    throw new Error("[bot-cred-envelope] not a v1 envelope");
  }
  const [, ivB64, tagB64, ctB64] = envelope.split(":");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("[bot-cred-envelope] malformed envelope");
  }
  const key = getKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
