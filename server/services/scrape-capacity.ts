import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { resultRows } from "./operation-lease.js";
import { logger } from "../observability/logger.js";

export function recordLeaseUnavailable(endpoint: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const reason = /no (?:available|eligible) bot/i.test(message) ? "no_bot" :
    /daily cap/i.test(message) ? "daily_cap" : /in progress|locked/i.test(message) ? "busy" : "preparation_failed";
  void db.execute(sql`INSERT INTO scrape_capacity_log (endpoint, reason) VALUES (${endpoint}, ${reason})`)
    .catch(err => logger.warn({ err, endpoint }, "capacity diagnostic write failed"));
}

export async function readCapacityDiagnostics() {
  return resultRows(await db.execute(sql`
    SELECT endpoint, reason, count(*)::int AS count FROM scrape_capacity_log
    WHERE occurred_at > now() - interval '24 hours' GROUP BY endpoint, reason
  `));
}
