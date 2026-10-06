import { createHash } from "node:crypto";

export interface SessionUser {
  id: string;
  hashedPassword: string | null;
  sessionVersion?: number;
}
export interface CustomerSessionIdentity { id: string; version: number; passwordVersion: string }

export function customerSessionIdentity(user: SessionUser): CustomerSessionIdentity {
  return { id: user.id, version: user.sessionVersion ?? 0,
    passwordVersion: createHash("sha256").update(user.hashedPassword ?? "no-password").digest("hex") };
}

export function customerSessionUserId(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 && value.length <= 36 ? value : null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && v.id.length > 0 && v.id.length <= 36 &&
    Number.isSafeInteger(v.version) && Number(v.version) >= 0 &&
    typeof v.passwordVersion === "string" && /^[a-f0-9]{64}$/.test(v.passwordVersion) ? v.id : null;
}

export function customerSessionMatches(value: unknown, user: SessionUser): boolean {
  if (customerSessionUserId(value) !== user.id) return false;
  // Only never-revoked accounts accept the pre-migration id-only session format.
  if (typeof value === "string") return (user.sessionVersion ?? 0) === 0;
  const supplied = value as CustomerSessionIdentity, current = customerSessionIdentity(user);
  return supplied.version === current.version && supplied.passwordVersion === current.passwordVersion;
}
