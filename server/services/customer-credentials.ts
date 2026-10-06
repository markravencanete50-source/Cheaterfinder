import { sql } from "drizzle-orm";
import { db } from "../db.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rows = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[];

async function revokeSessions(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM session
    WHERE sess::jsonb #>> '{passport,user}' = ${userId}
       OR sess::jsonb #>> '{passport,user,id}' = ${userId}`);
  await tx.execute(sql`UPDATE mobile_auth_sessions SET revoked_at=now()
    WHERE user_id=${userId} AND revoked_at IS NULL`);
}

/** Caller hashes outside the transaction. Lock USER first in both paths so a
 * password change racing a reset cannot deadlock on opposite lock orders. */
export async function applyCustomerPasswordReset(tokenDigest: string, hashedPassword: string): Promise<boolean> {
  const token = rows<{ userId: string }>(await db.execute(sql`
    SELECT user_id AS "userId" FROM password_reset_tokens WHERE token=${tokenDigest} LIMIT 1
  `))[0];
  if (!token) return false;
  return db.transaction(async tx => {
    const user = rows(await tx.execute(sql`SELECT id FROM users WHERE id=${token.userId} FOR UPDATE`))[0];
    if (!user) return false;
    const claimed = rows(await tx.execute(sql`UPDATE password_reset_tokens SET used_at=now()
      WHERE token=${tokenDigest} AND user_id=${token.userId} AND used_at IS NULL AND expires_at>now()
      RETURNING id`));
    if (!claimed.length) return false;
    await tx.execute(sql`UPDATE users SET hashed_password=${hashedPassword},session_version=session_version+1,updated_at=now()
      WHERE id=${token.userId}`);
    await revokeSessions(tx, token.userId);
    // Other outstanding links cannot later undo the newly chosen password.
    await tx.execute(sql`DELETE FROM password_reset_tokens WHERE user_id=${token.userId} AND token<>${tokenDigest}`);
    return true;
  });
}

/** Compare-and-swap preserves a concurrent password change/reset that happened
 * after the caller validated the old bcrypt hash. No blind last-writer wins. */
export async function changeCustomerPassword(userId: string, expectedHash: string, newHash: string): Promise<number | null> {
  return db.transaction(async tx => {
    const changed = rows<{ version: number }>(await tx.execute(sql`UPDATE users
      SET hashed_password=${newHash},session_version=session_version+1,updated_at=now()
      WHERE id=${userId} AND hashed_password=${expectedHash} RETURNING session_version AS version`));
    if (!changed.length) return null;
    await revokeSessions(tx, userId);
    await tx.execute(sql`DELETE FROM password_reset_tokens WHERE user_id=${userId}`);
    return changed[0].version;
  });
}
