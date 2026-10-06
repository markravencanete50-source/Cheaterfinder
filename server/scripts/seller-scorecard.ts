// Head-to-head seller evaluation. For each batch (tagged in display_name) test
// the three capabilities that decide an account's worth to us:
//   1. SESSION  — can it read a profile at all (is the session live?)
//   2. LIKERS   — /media/<id>/likers/  (the ONLY liked-posts lane we have)
//   3. FOLLOW   — friendships/create   (unlocks the 10x-cheaper facepile squad)
// Usage: npx tsx server/scripts/seller-scorecard.ts <tag> [sampleSize]
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

const PUBLIC_MEDIA = "3958042443021183429"; // known-live public post

async function main(): Promise<void> {
  const tag = process.argv[2];
  const size = Number(process.argv[3] ?? "3");
  if (!tag) throw new Error("usage: seller-scorecard.ts <tag> [n]");

  const { rows: t } = (await db.execute(sql`
    SELECT ig_user_id, ig_username FROM tracked_accounts
    WHERE is_active=true AND ig_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1`)) as any;
  const { rows } = (await db.execute(sql`
    SELECT id, ig_username FROM bot_accounts
    WHERE display_name = ${tag} AND session_data IS NOT NULL
    ORDER BY ig_username LIMIT ${size}`)) as any;

  console.log(`[sc] === ${tag} === testing ${rows.length} accounts`);
  let live = 0, likers = 0, follow = 0, dead = 0;

  for (const b of rows) {
    let tagline = `[sc] @${b.ig_username}:`;
    try {
      const ready = await ensureBotReady(b.id);
      const c = createHttpBotClientWithFingerprint(
        ready.sessionData, null, b.ig_username, ready.proxyEndpoint, b.id, ready.automationIdentity);
      // 1+2. likers doubles as the session probe: it needs a valid authed
      // session AND is the capability we actually care about. web_profile_info
      // is far more throttled and was 429-ing every account regardless of health.
      try {
        const l: any = await c.fetchMediaLikers(PUBLIC_MEDIA);
        tagline += ` SESSION=OK | LIKERS=OK(${l.users.length})`; live++; likers++;
      } catch (e: any) {
        const m = String(e?.message||e);
        if (/rate limited|429/i.test(m)) { tagline += ` THROTTLED(inconclusive)`; await c.close(); console.log(tagline); continue; }
        if (/not JSON|auth rejected|login/i.test(m)) { tagline += ` SESSION=DEAD(login-wall)`; dead++; await c.close(); console.log(tagline); continue; }
        tagline += ` LIKERS=NO(${m.slice(0,26)})`;
      }
      await new Promise(r=>setTimeout(r,2500));
      // 3. follow
      try {
        const r: any = await c.fetchRaw!(`/api/v1/friendships/create/${t[0].ig_user_id}/`, { method:"POST", body:"" });
        const ok = !!(r?.friendship_status?.following || r?.friendship_status?.outgoing_request || r?.status === "ok");
        tagline += ` | FOLLOW=${ok?"OK ***":"resp?"}`; if (ok) follow++;
      } catch (e: any) { tagline += ` | FOLLOW=NO`; }
      await c.close();
    } catch (e: any) { tagline += ` ready FAIL ${String(e?.message||e).slice(0,40)}`; dead++; }
    console.log(tagline);
    await new Promise(r=>setTimeout(r,3000));
  }
  console.log(`[sc] SCORE ${tag}: live=${live}/${rows.length} likers=${likers} follow=${follow} dead=${dead}`);
}
main().catch(e=>console.error("[sc] ERR", e?.message||e)).finally(()=>pool.end().catch(()=>{}));
