// Stamp a current proxy endpoint onto bot rows so every bot can egress
// authenticated (follow / private-collect / feed) traffic — the bot-session
// paths refuse to run without bot_accounts.proxy_endpoint set.
//
// Uses the app's own provider to generate the endpoint (rotating gateway), so
// no raw credentials appear here. By default stamps ALL bots; pass --missing to
// only fill rows that currently have no endpoint.
//
//   npx tsx server/scripts/assign-proxy-to-bots.ts [--missing]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { fetchEndpoints, proxyEndpointLabel } from "../services/proxy-provider.js";

async function main(): Promise<void> {
  const onlyMissing = process.argv.includes("--missing");

  const [ep] = await fetchEndpoints({ count: 1, country: "US" });
  if (!ep) throw new Error("provider returned no endpoint");

  const where = onlyMissing ? sql`WHERE proxy_endpoint IS NULL` : sql``;
  const result = (await db.execute(sql`
    UPDATE bot_accounts
    SET proxy_endpoint = ${ep.endpoint},
        proxy_session_id = ${ep.sessionId},
        proxy_expires_at = ${ep.expiresAt},
        updated_at = NOW()
    ${where}
    RETURNING id
  `)) as unknown as { rows: Array<{ id: string }>; rowCount?: number };

  const count = result.rows?.length ?? result.rowCount ?? 0;
  console.log(
    `[assign-proxy] stamped ${count} bot(s) with endpoint ${proxyEndpointLabel(ep.endpoint)} (expires ${ep.expiresAt.toISOString()})`,
  );

  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
