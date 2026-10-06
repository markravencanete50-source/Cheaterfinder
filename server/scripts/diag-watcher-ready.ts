// Does prepareWatcher's precondition chain actually pass for each watcher?
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";

async function main() {
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username, role, transport FROM bot_accounts
     WHERE role::text LIKE '%watcher%' ORDER BY ig_username`)) as any;
  for (const b of rows) {
    try {
      const r = await ensureBotReady(String(b.id));
      const proxy = (r as any).proxyEndpoint ?? null;
      const ai = (r as any).automationIdentity ?? null;
      const t = (r as any).transport ?? "web";
      const ok = proxy && (ai || t === "mobile");
      console.log(`  @${b.ig_username} [${b.role}] proxy=${proxy ? "yes" : "NO"} autoId=${ai ? "yes" : "NO"} transport=${t} -> ${ok ? "READY" : "WOULD THROW"}`);
    } catch (e: any) {
      console.log(`  @${b.ig_username} [${b.role}] ensureBotReady THREW: ${String(e?.message ?? e).slice(0,110)}`);
    }
  }
}
main().catch((e)=>console.error("[wr]",e?.message??e)).finally(()=>pool.end().catch(()=>{}));
