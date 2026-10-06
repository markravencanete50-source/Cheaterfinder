// Explicit, bounded existing-target read; no roster mutations or login.
import { pool } from "../db.js";
import { getAllUserFollowers } from "../services/public-data-service.js";
import { withScrapeContext, flushBandwidth } from "../services/bandwidth-meter.js";

const username = "tracked_user_3";
if (process.env.BOT_AUTO_LOGIN_ENABLED !== "false" || process.env.ROSTER_PIN_VIEWER_TARGETS !== username) {
  throw new Error("This canary requires auto-login disabled and the single explicit target allowlist");
}
try {
  const target = (await pool.query("SELECT id,ig_user_id FROM tracked_accounts WHERE is_active AND ig_username=$1 ORDER BY tracking_started,id LIMIT 1", [username])).rows[0];
  if (!target?.ig_user_id) throw new Error("Existing target required");
  const held = new Set<string>((await pool.query("SELECT username_lower FROM roster_members WHERE tracked_account_id=$1 AND dimension='follower' AND is_current", [target.id])).rows.map(r=>r.username_lower));
  const started = new Date().toISOString();
  const result = await withScrapeContext({userId:null,trackedAccountId:null,username:"canary:roster-viewer"}, () => getAllUserFollowers(username,target.ig_user_id,{
    maxPages:8,maxItems:500,pageDelayMinMs:9000,pageDelayMaxMs:16000,
  }));
  await flushBandwidth();
  const seen = new Set(result.ok ? result.data.map(u=>u.username.toLowerCase()) : []);
  const overlap = [...held].filter(u=>seen.has(u)).length;
  console.log("ROSTER_CANARY " + JSON.stringify({started,ended:new Date().toISOString(),username,ok:result.ok,
    ...(result.ok ? {complete:result.complete,stopReason:result.stopReason,pages:result.pagesFetched,raw:result.rawItemsFetched,distinct:seen.size,viewerBotId:result.viewerBotId,held:held.size,overlap,heldCoverage:held.size?overlap/held.size:null} : {error:result.error}),persisted:false}));
} finally { await pool.end(); }
process.exit(0);
