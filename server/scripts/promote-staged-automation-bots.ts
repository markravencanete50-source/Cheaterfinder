// Promote a deliberately bounded set of authenticated reserve bots into the
// production worker tier. Only encrypted, automation-owned sessions on an
// explicitly assigned durable proxy qualify; failed, partially prepared, or
// provider-ephemeral rows cannot be selected.
//
// `--allow-short-lived-proxy` waives ONLY the two proxy-durability predicates
// (the multi-day proxy_expires_at floor and the known-ephemeral proxy_url
// regex). It exists because the pool now runs on a rotating provider gateway
// whose sticky lease is minutes long by design, so no row can ever satisfy a
// multi-day floor and the durable-lane path would leave the worker tier empty
// forever. Every other guarantee still holds: the bot must be an available
// reserve with an encrypted v1 session, a parsed automation identity, an
// ops-assigned proxy_url, and a clean last login. Mirrors the same flag on
// activate-reserve-automation-bots.ts.
//
// Usage:
//   npx tsx server/scripts/promote-staged-automation-bots.ts --dry-run --created-after=2026-08-15T17:00:00Z --limit=3
//   npx tsx server/scripts/promote-staged-automation-bots.ts --apply --created-after=2026-08-15T17:00:00Z --limit=3
//   npx tsx server/scripts/promote-staged-automation-bots.ts --apply --allow-short-lived-proxy --created-after=2026-08-15T17:00:00Z --limit=10

import "dotenv/config";

import { sql } from "drizzle-orm";

import { db, pool } from "../db.js";
import {
  DURABLE_ACCOUNT_PROXY_MIN_VALIDITY_DAYS,
  KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX,
} from "../services/proxy-durability.js";

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function requireLimit(): number {
  const flag = process.argv.slice(2).find((value) => value.startsWith("--limit="));
  const parsed = flag ? Number(flag.slice("--limit=".length)) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error("--limit must be an integer from 1 to 20");
  }
  return parsed;
}

function requireCreatedAfter(): Date {
  const flag = process.argv.slice(2).find((value) => value.startsWith("--created-after="));
  const value = flag?.slice("--created-after=".length) ?? "";
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new Error("--created-after=<ISO-8601 timestamp> is required");
  }
  return parsed;
}

/**
 * The proxy-durability half of the eligibility predicate. Returns an empty
 * fragment when the operator has explicitly waived it, so the remaining
 * (identity, session, login-health) guarantees stay untouched either way.
 */
function proxyDurabilityGuard(allowShortLivedProxy: boolean) {
  if (allowShortLivedProxy) return sql``;
  return sql`
      AND proxy_expires_at > NOW()
        + (${DURABLE_ACCOUNT_PROXY_MIN_VALIDITY_DAYS} * INTERVAL '1 day')
      AND NOT (proxy_url ~* ${KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX})`;
}

async function countEligible(
  createdAfter: Date,
  allowShortLivedProxy: boolean,
): Promise<number> {
  const result = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM bot_accounts
    WHERE created_at >= ${createdAfter}
      AND tier = 'reserve'
      AND status = 'available'
      AND session_data LIKE 'v1:%'
      AND automation_identity IS NOT NULL
      AND NULLIF(BTRIM(proxy_url), '') IS NOT NULL
      ${proxyDurabilityGuard(allowShortLivedProxy)}
      AND last_login_at IS NOT NULL
      AND last_login_error IS NULL
  `)) as unknown as { rows: Array<{ count: number }> };
  return result.rows[0]?.count ?? 0;
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run");
  if (apply === dryRun) {
    throw new Error("choose exactly one of --dry-run or --apply");
  }

  const limit = requireLimit();
  const createdAfter = requireCreatedAfter();
  const allowShortLivedProxy = hasFlag("--allow-short-lived-proxy");
  const eligible = await countEligible(createdAfter, allowShortLivedProxy);

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      eligible,
      selected: Math.min(eligible, limit),
      promoteTo: "worker",
      allowShortLivedProxy,
      createdAfter: createdAfter.toISOString(),
    }));
    return;
  }

  const result = await db.execute(sql`
    WITH selected AS (
      SELECT id
      FROM bot_accounts
      WHERE created_at >= ${createdAfter}
        AND tier = 'reserve'
        AND status = 'available'
        AND session_data LIKE 'v1:%'
        AND automation_identity IS NOT NULL
        AND NULLIF(BTRIM(proxy_url), '') IS NOT NULL
        ${proxyDurabilityGuard(allowShortLivedProxy)}
        AND last_login_at IS NOT NULL
        AND last_login_error IS NULL
      ORDER BY last_login_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE bot_accounts AS bot
    SET tier = 'worker'::bot_tier,
        updated_at = NOW()
    FROM selected
    WHERE bot.id = selected.id
    RETURNING bot.id
  `);
  const promoted = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  console.log(JSON.stringify({
    ok: promoted > 0,
    eligible,
    promoted,
    promoteTo: "worker",
    allowShortLivedProxy,
    createdAfter: createdAfter.toISOString(),
  }));
  if (promoted === 0) process.exitCode = 1;
}

void main()
  .catch((error: unknown) => {
    console.error(
      `[promote-staged-bots] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
