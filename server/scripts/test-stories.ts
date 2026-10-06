import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { scrapeUserStories } from "../ig-public-scraper.js";
async function main() {
  const { rows } = (await db.execute(sql`
    SELECT ig_username, ig_user_id FROM tracked_accounts
    WHERE is_active AND ig_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 4`)) as any;
  for (const t of rows) {
    try {
      const s = await scrapeUserStories(t.ig_user_id);
      console.log(`[st] @${t.ig_username}: OK items=${s.length}`);
    } catch (e: any) {
      console.log(`[st] @${t.ig_username}: FAIL ${String(e?.message ?? e).slice(0,110)}`);
      if (e?.cause) console.log(`[st]    cause: ${String(e.cause?.message ?? e.cause).slice(0,110)}`);
    }
    await new Promise(r => setTimeout(r, 2500));
  }
}
main().catch(e=>console.error("[st] ERR", e?.message??e)).finally(()=>pool.end().catch(()=>{}));
