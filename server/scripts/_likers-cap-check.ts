import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { endpointDailyCap } from "../behavior/daily-budget.js";
async function main() {
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username, created_at FROM bot_accounts
    WHERE transport='web' AND tier IN ('worker','canary') AND status='available' AND session_data IS NOT NULL LIMIT 3
  `)) as any;
  for (const r of rows) {
    const cap = endpointDailyCap(new Date(r.created_at), "likers", new Date(), "web");
    console.log(`[cap] @${r.ig_username} web likers cap=${cap}`);
  }
  await pool.end().catch(()=>{});
}
main();
