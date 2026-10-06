import { logger } from "./observability/logger.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../shared/schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}

/**
 * Cap how long a single statement may run before Postgres aborts it, and how
 * long a session may sit idle inside an open transaction. Without these a
 * single runaway query (or a transaction left open by a crashed handler) pins
 * one of the pool's `max` connections indefinitely; enough of them and the
 * pool starves and every request blocks on `connect`. Both are applied at the
 * server side via pg's `options` parameter so they take effect on EVERY
 * connection the pool opens (including ones created after a backend restart),
 * not just the first.
 */
const STATEMENT_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? "30000") || 30000,
);
const IDLE_IN_TX_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.DB_IDLE_IN_TX_TIMEOUT_MS ?? "60000") || 60000,
);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // libpq-style startup options: space-separated `-c key=value` flags applied
  // to the backend the moment each connection is established.
  // TimeZone pinned: report hour/day-of-week buckets use EXTRACT()/TO_CHAR()
  // on timestamptz, which follow the SESSION zone. Unpinned, that was the host's
  // Europe/Berlin — every customer's "peak hour" was Berlin time and a
  // postgresql.conf change would silently shift every report. UTC matches the
  // PDF period header; per-user zones are applied in application code.
  options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${IDLE_IN_TX_TIMEOUT_MS} -c TimeZone=UTC`,
});

pool.on("error", (err) => {
  logger.error({ err }, "[db] Unexpected error on idle client");
});

export const db = drizzle(pool, { schema });
