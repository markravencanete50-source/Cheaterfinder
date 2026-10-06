import "dotenv/config";
import { pool } from "../db.js";
import { scrapeUserStories } from "../ig-public-scraper.js";
async function main() {
  const id = process.argv[2]; const label = process.argv[3] ?? id;
  for (let i = 1; i <= 3; i++) {
    try {
      const s = await scrapeUserStories(id);
      console.log(`[rep] ${label} try${i}: OK items=${s.length}`);
    } catch (e: any) {
      console.log(`[rep] ${label} try${i}: FAIL ${String(e?.cause?.message ?? e?.message ?? e).slice(0,90)}`);
    }
    await new Promise(r => setTimeout(r, 4000));
  }
}
main().catch(e=>console.error("[rep] ERR", e?.message??e)).finally(()=>pool.end().catch(()=>{}));
