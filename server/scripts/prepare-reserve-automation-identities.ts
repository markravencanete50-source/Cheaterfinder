// Prepare the inactive reserve pool for the FastAPI Firefox migration.
//
// This script deliberately has no Instagram-facing request path. It only asks
// the localhost automation service to mint an opaque, persisted identity for
// each selected DB row. Login, proxy allocation, and tier promotion happen in
// activate-reserve-automation-bots.ts after this local-only prerequisite.
//
// Usage:
//   npx tsx server/scripts/prepare-reserve-automation-identities.ts --dry-run
//   npx tsx server/scripts/prepare-reserve-automation-identities.ts --apply
//   npx tsx server/scripts/prepare-reserve-automation-identities.ts --apply --limit=3
//
// Required environment: DATABASE_URL, AUTOMATION_API_TOKEN

import "dotenv/config";

import { sql } from "drizzle-orm";

import { db, pool } from "../db.js";
import { createAutomationClient } from "../services/automation-client.js";
import { parseAutomationIdentity } from "../services/automation-identity.js";

interface ReserveBotRow {
  id: string;
  locale: string | null;
  timezone: string | null;
  automation_identity: unknown;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function readLimit(): number | null {
  const flag = process.argv.slice(2).find((value) => value.startsWith("--limit="));
  if (!flag) return null;
  const parsed = Number(flag.slice("--limit=".length));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return parsed;
}

async function listReserveBots(limit: number | null): Promise<readonly ReserveBotRow[]> {
  const result = (await db.execute(sql`
    SELECT id, locale, timezone, automation_identity
    FROM bot_accounts
    WHERE tier = 'reserve'
      AND status = 'session_expired'
      AND ig_password_encrypted IS NOT NULL
    ORDER BY created_at ASC, ig_username ASC
    ${limit === null ? sql`` : sql`LIMIT ${limit}`}
  `)) as unknown as { rows: ReserveBotRow[] };
  return result.rows;
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run");
  if (apply === dryRun) {
    throw new Error("choose exactly one of --dry-run or --apply");
  }

  const limit = readLimit();
  const bots = await listReserveBots(limit);
  const existing = bots.filter((bot) => parseAutomationIdentity(bot.automation_identity, bot.id));
  const missing = bots.filter((bot) => !parseAutomationIdentity(bot.automation_identity, bot.id));

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      selected: bots.length,
      alreadyPrepared: existing.length,
      toPrepare: missing.length,
    }));
    return;
  }

  const automation = createAutomationClient({ timeoutMs: 10_000 });
  const health = await automation.health();
  if (
    health.status !== "ok" ||
    !health.loopback_only ||
    !health.runtime.browser_available ||
    !health.runtime.http_available
  ) {
    throw new Error("local automation service is not ready for identity preparation");
  }

  let prepared = 0;
  let failed = 0;
  for (const bot of missing) {
    try {
      const identity = await automation.createIdentity({
        bot_id: bot.id,
        locale: bot.locale ?? "en-US",
        timezone: bot.timezone ?? "America/New_York",
      });
      if (!parseAutomationIdentity(identity, bot.id)) {
        throw new Error("automation service returned an invalid identity");
      }
      await db.execute(sql`
        UPDATE bot_accounts SET
          automation_identity = ${JSON.stringify(identity)}::jsonb,
          updated_at = NOW()
        WHERE id = ${bot.id}
          AND tier = 'reserve'
          AND status = 'session_expired'
      `);
      prepared += 1;
    } catch {
      // Do not persist a transport error or an opaque service response; the
      // next run can retry the same unchanged reserve row.
      failed += 1;
    }
  }

  console.log(JSON.stringify({
    ok: failed === 0,
    selected: bots.length,
    alreadyPrepared: existing.length,
    prepared,
    failed,
  }));
  if (failed > 0) process.exitCode = 1;
}

void main()
  .catch((error: unknown) => {
    console.error(`[prepare-reserve-identities] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
