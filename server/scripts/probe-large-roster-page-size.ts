// Three bounded existing-target reads, no roster/event persistence or login.
import "dotenv/config";
import { db, pool } from "../db.js";
import { buildLeaseCandidateQuery, scrapeUserFollowers } from "../ig-public-scraper.js";
import { withViewerAffinity } from "../services/viewer-affinity.js";
import { withScrapeContext, flushBandwidth } from "../services/bandwidth-meter.js";

const username = "tracked_user_4";
if (!process.argv.includes("--probe-jannat") || process.env.BOT_AUTO_LOGIN_ENABLED !== "false") {
  throw new Error("Explicit existing-target probe and isolated no-login setting required");
}
try {
  const target = (await pool.query("SELECT id,user_id,ig_user_id FROM tracked_accounts WHERE is_active AND ig_username=$1 ORDER BY tracking_started,id LIMIT 1", [username])).rows[0];
  if (!target?.ig_user_id) throw new Error("Existing active numeric target required");
  let botId: string | undefined;
  const candidates = (await pool.query("SELECT bot_id FROM scrape_outcome_log WHERE endpoint='followers' AND outcome='success' AND occurred_at>=now()-interval '3 hours' AND bot_id IS NOT NULL ORDER BY occurred_at DESC LIMIT 30")).rows;
  for (const id of new Set<string>(candidates.map(r => r.bot_id))) {
    const q = buildLeaseCandidateQuery(db, { label: "followers", viewer: { pin: true, botId: id } }).toSQL();
    if ((await pool.query(q.sql.replace(/\s+for update skip locked\s*$/i, ""), q.params)).rows.length) { botId = id; break; }
  }
  if (!botId) throw new Error("No eligible recently successful follower reader; no requests sent");
  const started = new Date().toISOString();
  const summaries: unknown[] = [];
  const seen = new Set<string>();
  let baseline: Set<string>;
  let nextCursor: string | undefined;
  await withScrapeContext({ userId: target.user_id, trackedAccountId: target.id, username }, async () => {
    for (const [index, count] of [50, 200, 200].entries()) {
      if (index === 2 && !nextCursor) break;
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 12_000));
      const page = await withViewerAffinity({ pin: true, botId, rosterPageSize: count }, () => scrapeUserFollowers(target.ig_user_id, index === 2 ? nextCursor : undefined));
      const names = new Set(page.users.map(r => r.username.toLowerCase()));
      if (index === 0) baseline = names;
      const repeated = [...names].filter(n => seen.has(n)).length;
      if (index > 0) for (const name of names) seen.add(name);
      summaries.push({ requested: count, continuation: index === 2, returned: page.users.length,
        distinct: names.size, repeatedFromPrior200: repeated,
        baseline50Overlap: [...baseline!].filter(n => names.has(n)).length,
        missingIds: page.users.filter(r => !r.igUserId).length,
        missingNames: page.users.filter(r => !r.username).length,
        hasNext: !!page.nextCursor });
      nextCursor = page.nextCursor;
    }
  });
  console.log(JSON.stringify({ started, ended: new Date().toISOString(), username, persisted: false, summaries, distinctAcross200Pages: seen.size }));
} finally { await flushBandwidth(); await pool.end(); }
process.exit(0);
