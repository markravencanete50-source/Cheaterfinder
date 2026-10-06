import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";
const NEW = ['aaqking487','ziouser18','jjocool470','qsohub262','lkmzone917','qujpro334','esnsmart701','ggrsmart371','jfgninja816','vzbstar430','vdrzone787','mpkapp631','hddapp143','ldlapp343','bdqstar941','rtuhub720','hgwsmart631','vrpapp698','syxzone209','ngxninja164'];
async function main() {
  const { rows: t } = (await db.execute(sql`
    SELECT ig_user_id, ig_username FROM tracked_accounts WHERE is_active=true AND ig_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)) as any;
  const target = t[0];
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE ig_username IN ('aaqking487','ziouser18','jjocool470','qsohub262','lkmzone917','qujpro334','esnsmart701','ggrsmart371','jfgninja816','vzbstar430','vdrzone787','mpkapp631','hddapp143','ldlapp343','bdqstar941','rtuhub720','hgwsmart631','vrpapp698','syxzone209','ngxninja164') AND session_data IS NOT NULL AND automation_identity IS NOT NULL
    LIMIT 3`)) as any;
  console.log(`[nf] target=@${target.ig_username} LIKERS test on ${rows.length} NEW bots`);
  let ok=0, wall=0;
  for (const b of rows) {
    try {
      const ready = await ensureBotReady(b.id);
      const c = createHttpBotClientWithFingerprint(ready.sessionData, null, b.ig_username, ready.proxyEndpoint, b.id, ready.automationIdentity);
      try {
        const page: any = await c.fetchMediaLikers("3958042443021183429");
        console.log(`[nf] @${b.ig_username}: LIKERS OK users=${page.users.length}`); ok++;
      } catch (e: any) {
        const m = String(e?.message||e);
        if (m.includes("not JSON")) wall++;
        console.log(`[nf] @${b.ig_username}: FAIL ${m.slice(0,60)}`);
      } finally { await c.close(); }
    } catch (e: any) { console.log(`[nf] @${b.ig_username}: ready FAIL ${String(e?.message||e).slice(0,60)}`); }
    await new Promise(r=>setTimeout(r,4000));
  }
  console.log(`[nf] SUMMARY follow_ok=${ok} login_wall=${wall} of ${rows.length}`);
}
main().catch(e=>console.error("[nf] ERR", e?.message||e)).finally(()=>pool.end().catch(()=>{}));
