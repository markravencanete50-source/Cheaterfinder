// Verify the ISSUE-1 fix: a roster that has been seeding past the deadline must
// settle even when its reads keep FAILING (previously only the success path
// could settle, so a permanently-failing large roster stayed silent forever).
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { recordRosterFetchFailure } from "../services/roster-store.js";

async function state(id: string) {
  const { rows } = (await db.execute(sql`
    SELECT settled_at, stable_reads, last_member_count, seeded_at
    FROM roster_sync_state WHERE tracked_account_id=${id} AND dimension='follower'`)) as any;
  return rows[0];
}

async function main() {
  const id = process.argv[2] ?? "6cb465e0-58c4-4491-ba31-1f2ce75dc31a";
  const before = await state(id);
  console.log(`[verify] BEFORE settled=${before?.settled_at ?? "NULL"} stable=${before?.stable_reads} members=${before?.last_member_count} seeded=${before?.seeded_at}`);

  // Exactly what the collector does when the followers walk fails.
  await recordRosterFetchFailure(
    id, "follower",
    "[ig-public-scraper] [ig-http] GET followers failed with status 400",
  );

  const after = await state(id);
  console.log(`[verify] AFTER  settled=${after?.settled_at ?? "NULL"} stable=${after?.stable_reads} members=${after?.last_member_count}`);
  console.log(after?.settled_at ? "[verify] PASS — roster settled via failure path" : "[verify] FAIL — still unsettled");
}
main().catch(e => console.error("[verify] ERR", e?.message ?? e))
  .finally(() => pool.end().catch(() => undefined));
