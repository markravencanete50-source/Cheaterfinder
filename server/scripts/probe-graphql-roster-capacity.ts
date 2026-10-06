// Explicit four-request capacity canary. Uses normal saved-session eligibility,
// bot leases, budget, cooldown, transport and telemetry. No roster/event writes,
// no login, and excludes ALL readers holding an unfinished roster checkpoint.
import "dotenv/config";
import { createHash } from "node:crypto";
import { db, pool } from "../db.js";
import { buildLeaseCandidateQuery, scrapeUserFollowers } from "../ig-public-scraper.js";
import { withViewerAffinity } from "../services/viewer-affinity.js";
import { withOperationSignal } from "../services/operation-context.js";
import { withScrapeContext, flushBandwidth } from "../services/bandwidth-meter.js";

const username = "tracked_user_4";
if (!process.argv.includes("--probe-jannat") || process.env.BOT_AUTO_LOGIN_ENABLED !== "false") {
  throw new Error("Explicit existing-target probe with auto-login disabled required");
}
const started = new Date().toISOString();
const summaries: Record<string, unknown>[] = [];
try {
  const target = (await pool.query(`SELECT id,user_id,ig_user_id FROM tracked_accounts
    WHERE is_active AND is_private IS NOT TRUE AND ig_username=$1 ORDER BY tracking_started,id LIMIT 1`, [username])).rows[0];
  if (!target?.ig_user_id) throw new Error("Existing active public numeric target required");
  const reservedReaders = new Set<string>((await pool.query(`SELECT DISTINCT viewer_bot_id FROM roster_sync_state
    WHERE next_cursor IS NOT NULL AND viewer_bot_id IS NOT NULL`)).rows.map(r => r.viewer_bot_id));
  const candidates = (await pool.query(`SELECT bot_id,max(occurred_at) latest FROM scrape_outcome_log
    WHERE endpoint='followers' AND outcome='success' AND occurred_at>=now()-interval '24 hours' AND bot_id IS NOT NULL
    GROUP BY bot_id ORDER BY latest DESC LIMIT 100`)).rows;
  let botId: string | undefined;
  for (const { bot_id: id } of candidates) {
    if (reservedReaders.has(id)) continue;
    const query = buildLeaseCandidateQuery(db, { label: "followers", viewer: {
      pin: true, botId: id, rosterSource: "graphql", savedSessionOnly: true,
    } }).toSQL();
    if ((await pool.query(query.sql.replace(/\s+for update skip locked\s*$/i, ""), query.params)).rows.length) {
      botId = id; break;
    }
  }
  if (!botId) throw new Error("No eligible recently successful unreserved reader; no requests sent");
  const signal = AbortSignal.timeout(150_000);
  let baseline = new Set<string>(), first200 = new Set<string>();
  let continuation: string | undefined;
  await withOperationSignal(signal, () => withScrapeContext({userId: target.user_id,
    trackedAccountId: target.id, username}, async () => {
    for (const [index, count] of [50, 100, 200, 200].entries()) {
      if (index === 3 && !continuation) throw new Error("No 200-page cursor; continuation unproven");
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 12_000));
      signal.throwIfAborted();
      // Check again immediately before the normal per-page lease, in case a
      // new background epoch pinned this reader since the initial selection.
      if ((await pool.query(`SELECT 1 FROM roster_sync_state WHERE viewer_bot_id=$1 AND next_cursor IS NOT NULL LIMIT 1`, [botId])).rows.length) {
        throw new Error("Reader now owns an active roster; preserving live scan");
      }
      const page = await withViewerAffinity({pin:true,botId,rosterSource:"graphql",rosterPageSize:count,savedSessionOnly:true},
        () => scrapeUserFollowers(target.ig_user_id, index === 3 ? continuation : undefined));
      const ids = new Set(page.users.map(u => u.igUserId || u.username.toLowerCase()));
      if (index === 0) baseline = ids;
      if (index === 2) first200 = ids;
      const summary = {requested:count,continuation:index === 3,returned:page.users.length,distinct:ids.size,
        baseline50Overlap:[...baseline].filter(id => ids.has(id)).length,
        overlapWithFirst200:index === 3 ? [...first200].filter(id => ids.has(id)).length : null,
        missingIds:page.users.filter(u=>!u.igUserId).length,missingNames:page.users.filter(u=>!u.username).length,
        missingProfileFields:page.users.filter(u=>!u.profilePicUrl || u.isPrivate == null || u.isVerified == null).length,
        hasNext:!!page.nextCursor,sourceLimited:!!page.sourceLimited};
      summaries.push(summary);
      console.log(JSON.stringify({checkpoint:true,...summary}));
      if (page.sourceLimited || !page.users.length) throw new Error("Source limited/empty; no page-size promotion");
      continuation = page.nextCursor ?? undefined;
    }
  }));
  console.log(JSON.stringify({started,ended:new Date().toISOString(),username,persisted:false,
    viewerFingerprint:createHash("sha256").update(botId).digest("hex").slice(0,12),summaries}));
} catch (error) {
  console.error(JSON.stringify({started,ended:new Date().toISOString(),persisted:false,summaries,
    error:error instanceof Error ? error.message : "Capacity probe failed"}));
  process.exitCode = 1;
} finally { await flushBandwidth(); await pool.end(); }
process.exit(process.exitCode ?? 0);
