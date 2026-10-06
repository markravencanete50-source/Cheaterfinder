import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { provisionAutomationIdentity } from "../services/automation-identity-provision.js";

// Give every web bot that has a session but no automation identity one, so
// leaseBot can pick it up. No login, no Instagram call (see the service module).
//
// Usage:
//   npx tsx server/scripts/assign-automation-identities.ts [--tag order331725]... [--dry-run]
//   (no --tag = every web bot with session_data and a NULL identity)

interface Row {
  id: string;
  ig_username: string;
  locale: string | null;
  timezone: string | null;
  display_name: string | null;
}

function tags(argv: readonly string[]): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === "--tag" && argv[i + 1]) out.push(argv[i + 1].trim());
  });
  return out;
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  const wanted = tags(process.argv);
  const rows = (
    (await db.execute(sql`
      SELECT id, ig_username, locale, timezone, display_name
      FROM bot_accounts
      WHERE transport = 'web'
        AND session_data IS NOT NULL
        AND automation_identity IS NULL
        AND status = 'available'
        ${wanted.length > 0 ? sql`AND display_name IN (${sql.join(wanted.map((t) => sql`${t}`), sql`, `)})` : sql``}
      ORDER BY display_name, ig_username
    `)) as unknown as { rows: Row[] }
  ).rows;
  console.log(JSON.stringify({ candidates: rows.length, tags: wanted, dryRun: dry }));
  if (dry) return;
  let ok = 0;
  const failed: string[] = [];
  for (const row of rows) {
    try {
      const identity = await provisionAutomationIdentity(row);
      await db.execute(sql`
        UPDATE bot_accounts
        SET automation_identity = ${JSON.stringify(identity)}::jsonb, updated_at = NOW()
        WHERE id = ${row.id} AND automation_identity IS NULL
      `);
      ok++;
    } catch (err) {
      failed.push(`${row.ig_username}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(JSON.stringify({ ok: failed.length === 0, provisioned: ok, failed }));
}

main()
  .catch((err) => {
    console.error("[assign-automation-identities] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
