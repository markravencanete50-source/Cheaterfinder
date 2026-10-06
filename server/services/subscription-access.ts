import { sql, type SQLWrapper } from "drizzle-orm";
import { db } from "../db.js";
import { resultRows } from "./operation-lease.js";

/** Same conditions as shared hasSubscriptionAccess; EXISTS uses the unique
 * subscriptions.user_id index and cannot multiply tracked-account rows. */
export function customerAccessSql(userId: SQLWrapper) {
  return sql`EXISTS (SELECT 1 FROM subscriptions entitlement
    WHERE entitlement.user_id = ${userId}
      AND left(entitlement.stripe_customer_id, 4) = 'cus_'
      AND left(entitlement.stripe_subscription_id, 4) = 'sub_'
      AND ((entitlement.status = 'active' AND entitlement.current_period_end > now())
        OR (entitlement.status = 'trialing' AND entitlement.trial_ends_at > now())))`;
}

export async function customerHasAccess(userId: string): Promise<boolean> {
  const rows = resultRows(await db.execute(sql`SELECT 1 WHERE ${customerAccessSql(sql`${userId}`)}`));
  return rows.length > 0;
}

export async function trackedAccountHasAccess(accountId: string): Promise<boolean> {
  const rows = resultRows(await db.execute(sql`SELECT 1 FROM tracked_accounts t
    WHERE t.id = ${accountId} AND t.is_active AND ${customerAccessSql(sql`t.user_id`)}`));
  return rows.length > 0;
}
