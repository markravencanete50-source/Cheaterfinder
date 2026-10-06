import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { resultRows } from "./operation-lease.js";

type Executor = Pick<typeof db, "execute">;
export function refreshDigest(jti: string): string {
  return createHash("sha256").update(jti).digest("hex");
}

export async function createMobileSession(id: string, userId: string, jti: string, expiresAt: Date, executor: Executor = db): Promise<boolean> {
  const rows = resultRows(await executor.execute(sql`
    INSERT INTO mobile_auth_sessions (id, user_id, refresh_digest, expires_at)
    VALUES (${id}, ${userId}, ${refreshDigest(jti)}, ${expiresAt})
    ON CONFLICT (id) DO NOTHING RETURNING id
  `));
  return rows.length > 0;
}

export async function mobileSessionActive(id: string, userId: string, executor: Executor = db): Promise<boolean> {
  return resultRows(await executor.execute(sql`
    SELECT 1 FROM mobile_auth_sessions WHERE id = ${id} AND user_id = ${userId}
      AND revoked_at IS NULL AND expires_at > now()
  `)).length > 0;
}

export async function legacyMobileTokenActive(userId: string, issuedAt: number, executor: Executor = db): Promise<boolean> {
  return resultRows(await executor.execute(sql`
    SELECT 1 FROM mobile_legacy_revocations WHERE user_id = ${userId}
      AND revoked_before >= to_timestamp(${issuedAt})
  `)).length === 0;
}

export async function revokeMobileSession(id: string, userId: string, executor: Executor = db): Promise<void> {
  await executor.execute(sql`UPDATE mobile_auth_sessions SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${id} AND user_id = ${userId}`);
}

/** Atomic compare-and-swap: exactly one concurrent refresh wins. Reuse of a
 * valid old token revokes its family, including any newly issued access token.
 */
export async function rotateMobileSession(id: string, userId: string, oldJti: string, newJti: string, expiresAt: Date, executor: Executor = db): Promise<boolean> {
  const rows = resultRows(await executor.execute(sql`
    UPDATE mobile_auth_sessions SET refresh_digest = ${refreshDigest(newJti)}, expires_at = ${expiresAt}
    WHERE id = ${id} AND user_id = ${userId} AND refresh_digest = ${refreshDigest(oldJti)}
      AND revoked_at IS NULL AND expires_at > now() RETURNING id
  `));
  if (rows.length) return true;
  await revokeMobileSession(id, userId, executor);
  return false;
}

export async function revokeLegacyMobileTokens(userId: string, executor: Executor = db): Promise<void> {
  await executor.execute(sql`
    INSERT INTO mobile_legacy_revocations (user_id, revoked_before) VALUES (${userId}, now())
    ON CONFLICT (user_id) DO UPDATE SET revoked_before = EXCLUDED.revoked_before
  `);
  await executor.execute(sql`UPDATE mobile_auth_sessions SET revoked_at = COALESCE(revoked_at, now())
    WHERE user_id = ${userId} AND id LIKE 'legacy:%'`);
}
