// Bounded existing-target read. Never persists a roster or performs login/follow.
import "dotenv/config";
import { db,pool } from "../db.js";
import { buildLeaseCandidateQuery } from "../ig-public-scraper.js";
import { getAllUserFollowers,getAllUserFollowing } from "../services/public-data-service.js";
import { withScrapeContext,flushBandwidth } from "../services/bandwidth-meter.js";
const arg=(key:string)=>process.argv.find(s=>s.startsWith(`--${key}=`))?.slice(key.length+3);
const username=arg("username"),dimension=arg("dimension");
if(!username||!['follower','following'].includes(dimension??'')||process.env.BOT_AUTO_LOGIN_ENABLED!=="false"||process.env.ROSTER_PIN_VIEWER_TARGETS!==username)throw new Error("Explicit target/dimension and isolated no-login pinned-viewer configuration required");
try {
  const target=(await pool.query("SELECT id,user_id,ig_user_id FROM tracked_accounts WHERE is_active AND ig_username=$1 ORDER BY tracking_started,id LIMIT 1",[username])).rows[0];
  if(!target?.ig_user_id)throw new Error("Existing active target with numeric ID required");
  const held=new Set<string>((await pool.query("SELECT username_lower FROM roster_members WHERE tracked_account_id=$1 AND dimension=$2 AND is_current",[target.id,dimension])).rows.map(r=>r.username_lower));
  let viewerBotId:string|undefined;
  if(arg("reader")==="recent-success") {
    const label=dimension==='follower'?'followers':'following';
    const candidates=(await pool.query("SELECT bot_id FROM scrape_outcome_log WHERE endpoint=$1 AND outcome='success' AND occurred_at>=now()-interval '1 hour' AND bot_id IS NOT NULL ORDER BY occurred_at DESC LIMIT 20",[label])).rows;
    for(const id of new Set<string>(candidates.map(r=>r.bot_id))) {
      const q=buildLeaseCandidateQuery(db,{label,viewer:{pin:true,botId:id}}).toSQL();
      // Read eligibility only; the real scraper subsequently acquires its lease.
      const candidate=(await pool.query(q.sql.replace(/\s+for update skip locked\s*$/i,''),q.params)).rows[0];
      if(candidate){viewerBotId=id;break;}
    }
    if(!viewerBotId)throw new Error("No eligible recent-success reader; no IG request sent");
  }
  const started=new Date().toISOString();
  const opts={maxPages:8,maxItems:500,pageDelayMinMs:9000,pageDelayMaxMs:16000,fallbackUsername:username,viewerBotId};
  const result=await withScrapeContext({userId:target.user_id,trackedAccountId:target.id,username},()=>
    dimension==='follower'?getAllUserFollowers(username,target.ig_user_id,opts):getAllUserFollowing(target.ig_user_id,opts));
  await flushBandwidth();
  const seen=new Set(result.ok?result.data.map(r=>r.username.toLowerCase()):[]);
  const overlap=[...held].filter(name=>seen.has(name)).length;
  console.log(JSON.stringify({started,ended:new Date().toISOString(),username,dimension,trackedAccountId:target.id,
    persisted:false,held:held.size,distinct:seen.size,overlap,coverage:held.size?overlap/held.size:null,
    result: result.ok ? { ...result, data: undefined } : result}));
} finally {await pool.end();}
process.exit(0);
