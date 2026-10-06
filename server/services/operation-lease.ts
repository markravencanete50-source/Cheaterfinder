import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { logger } from "../observability/logger.js";
import { operationSignal, withOperationSignal } from "./operation-context.js";
export { operationSignal } from "./operation-context.js";

export function resultRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? [];
}

export class OperationBusyError extends Error {
  constructor() { super("operation already in progress; defer without consuming IG budget"); this.name = "OperationBusyError"; }
}

export interface OperationLeaseGuard {
  /** Use INSIDE the short persistence transaction, before changing data.
   * Locks this ownership row until commit so a successor cannot interleave.
   */
  assertOwned(transaction: Pick<typeof db, "execute">): Promise<void>;
}

/** Cross-process ownership without holding a transaction/connection during I/O.
 * Tokens fence both renewal and release; a stale owner cannot erase a newer lease.
 * Callers must propagate the signal to outbound requests and check it between steps.
 */
export async function withOperationLease<T>(
  key: string,
  work: (signal: AbortSignal, guard: OperationLeaseGuard) => Promise<T>,
  executor: Pick<typeof db, "execute"> = db,
): Promise<T> {
  const token = randomUUID();
  const ttlMs = 120_000;
  const acquired = resultRows(await executor.execute(sql`
    INSERT INTO backend_operation_leases (key, token, expires_at)
    VALUES (${key}, ${token}, clock_timestamp() + ${ttlMs} * interval '1 millisecond')
    ON CONFLICT (key) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
    WHERE backend_operation_leases.expires_at <= clock_timestamp()
    RETURNING token
  `));
  if (!acquired.length) throw new OperationBusyError();
  const controller = new AbortController();
  const parent = operationSignal();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let renewal: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (renewal || signal.aborted) return;
    renewal = (async () => {
      try {
        const renewed = resultRows(await executor.execute(sql`
          UPDATE backend_operation_leases
          SET expires_at = clock_timestamp() + ${ttlMs} * interval '1 millisecond'
          WHERE key = ${key} AND token = ${token} AND expires_at > clock_timestamp()
          RETURNING token
        `));
        if (!renewed.length) controller.abort(new Error("execution lease lost"));
      } catch {
        controller.abort(new Error("execution lease renewal failed"));
      }
    })().finally(() => { renewal = undefined; });
  }, ttlMs / 3);
  timer.unref();
  try {
    return await withOperationSignal(signal, async () => {
      signal.throwIfAborted();
      const guard: OperationLeaseGuard = {
        async assertOwned(transaction) {
          signal.throwIfAborted();
          const owned = resultRows(await transaction.execute(sql`
            SELECT token FROM backend_operation_leases
            WHERE key = ${key} AND token = ${token} AND expires_at > clock_timestamp()
            FOR UPDATE
          `));
          if (!owned.length) throw new Error("execution lease lost before persistence");
        },
      };
      const value = await work(signal, guard);
      signal.throwIfAborted();
      return value;
    });
  } finally {
    clearInterval(timer);
    await renewal;
    await executor.execute(sql`DELETE FROM backend_operation_leases WHERE key = ${key} AND token = ${token}`)
      .catch((err) => logger.warn({ err, operationKey: key }, "execution lease release failed; expires automatically"));
  }
}
