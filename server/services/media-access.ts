import { createHmac, timingSafeEqual } from "node:crypto";

export interface MediaAccessScope {
  userId: string;
  /** The requesting customer's row, even when the asset belongs to a twin. */
  trackedAccountId: string;
}

const CACHE_KEY = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const SIGNING_PURPOSE = "cheaterfinder-media-access-v1";

function validString(value: unknown, pattern: RegExp): value is string {
  // JS's `$` can match before a final newline; require the entire input.
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}

function signingKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret?.trim()) return null;
  return createHmac("sha256", secret).update(SIGNING_PURPOSE).digest();
}

function signatureFor(
  key: Buffer,
  cacheKey: string,
  userId: string,
  trackedAccountId: string,
): Buffer {
  // A tuple avoids delimiter ambiguity between identifiers.
  return createHmac("sha256", key)
    .update(JSON.stringify([cacheKey, userId, trackedAccountId]))
    .digest();
}

/**
 * Call only when serializing media from an authorized tracked-account read.
 * The file cache stays shared; the browser URL is specific to this customer.
 */
export function signMediaUrl(cacheKey: string, scope: MediaAccessScope): string {
  if (
    !validString(cacheKey, CACHE_KEY) ||
    !validString(scope?.userId, IDENTIFIER) ||
    !validString(scope?.trackedAccountId, IDENTIFIER)
  ) {
    throw new Error("Invalid media access scope");
  }
  const key = signingKey();
  if (!key) throw new Error("SESSION_SECRET is required for media access");
  const signature = signatureFor(key, cacheKey, scope.userId, scope.trackedAccountId)
    .toString("hex");
  const query = new URLSearchParams({ trackedAccountId: scope.trackedAccountId, sig: signature });
  return `/api/media/${cacheKey}?${query.toString()}`;
}

/**
 * Verifies the signature only. Before reading any cached bytes, the HTTP route
 * must also check the authenticated customer's paid access and current active
 * ownership of the original row, including has_access for private accounts.
 * There is no expiry: those live checks revoke access without expiring open
 * galleries. Changing SESSION_SECRET invalidates all previously signed URLs.
 */
export function verifyMediaSignature(
  cacheKey: unknown,
  userId: unknown,
  trackedAccountId: unknown,
  signature: unknown,
): boolean {
  if (
    !validString(cacheKey, CACHE_KEY) ||
    !validString(userId, IDENTIFIER) ||
    !validString(trackedAccountId, IDENTIFIER) ||
    !validString(signature, SIGNATURE)
  ) return false;

  const key = signingKey();
  if (!key) return false;
  return timingSafeEqual(
    signatureFor(key, cacheKey, userId, trackedAccountId),
    Buffer.from(signature, "hex"),
  );
}
