import { sql } from "drizzle-orm";
import type { db } from "../db.js";
export const FOLLOWING_DIFF_LOCK_NS = 0x4c4b0001;
export const FOLLOWER_DIFF_LOCK_NS = 0x4c4b0002;
/** Same deployed namespace/hash as ordinary diff persistence. */
export async function lockAccountForDiff(tx: Pick<typeof db,"execute">, namespace: number, id: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${namespace}, hashtext(${id}))`);
}
