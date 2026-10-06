// Explicit, bounded repair of the already-tested small following roster.
// Uses real leases/caps + normal transactional persistence; never logs in,
// follows anyone, forces a baseline, or fabricates a completion timestamp.
import "dotenv/config";
import { db, pool } from "../db.js";
import { buildLeaseCandidateQuery } from "../ig-public-scraper.js";
import { getAllUserFollowing } from "../services/public-data-service.js";
import { persistFollowingDiff } from "../services/public-data-persistence.js";
import { getRosterSyncHealth, loadRosterCursor } from "../services/roster-store.js";
import { rosterViewerPinEnabled } from "../services/viewer-affinity.js";
import { withScrapeContext, flushBandwidth } from "../services/bandwidth-meter.js";
import { withOperationLease } from "../services/operation-lease.js";

const username = "sample_account";
if (!process.argv.includes("--apply-sample-following") ||
    process.env.BOT_AUTO_LOGIN_ENABLED !== "false" ||
    !rosterViewerPinEnabled(username, "following") || rosterViewerPinEnabled(username, "follower")) {
  throw new Error("Explicit bounded apply and following-only no-login configuration required");
}
try {
  const target = (await pool.query(`SELECT t.id,t.user_id,t.ig_user_id,
    (SELECT following_count FROM profile_snapshots WHERE tracked_account_id=t.id ORDER BY snapshot_at DESC LIMIT 1) reported
    FROM tracked_accounts t WHERE is_active AND ig_username=$1 ORDER BY tracking_started,id LIMIT 1`, [username])).rows[0];
  if (!target?.ig_user_id || !(target.reported > 0 && target.reported < 400)) throw new Error("Existing small active target required");
  if (await loadRosterCursor(target.id, "following")) throw new Error("Pending normal epoch must finish first; no restart allowed");
  const before = await getRosterSyncHealth(target.id, "following");
  if (before.nextRetryAt && before.nextRetryAt.getTime() > Date.now()) throw new Error("Target backoff active; no repair read sent");
  if (before.lastCompleteReadAt && Date.now() - before.lastCompleteReadAt.getTime() < 24 * 60 * 60 * 1_000) {
    throw new Error("Roster already verified fresh; skip duplicate spend");
  }
  const held = new Set<string>((await pool.query("SELECT username_lower FROM roster_members WHERE tracked_account_id=$1 AND dimension='following' AND is_current", [target.id])).rows.map(r => r.username_lower));
  let viewerBotId: string | undefined;
  const candidates = (await pool.query("SELECT bot_id FROM scrape_outcome_log WHERE endpoint='following' AND outcome='success' AND occurred_at>=now()-interval '1 hour' AND bot_id IS NOT NULL ORDER BY occurred_at DESC LIMIT 30")).rows;
  for (const id of new Set<string>(candidates.map(r => r.bot_id))) {
    const q = buildLeaseCandidateQuery(db, { label: "following", viewer: { pin: true, botId: id } }).toSQL();
    if ((await pool.query(q.sql.replace(/\s+for update skip locked\s*$/i, ""), q.params)).rows.length) { viewerBotId = id; break; }
  }
  if (!viewerBotId) throw new Error("No eligible recent-success reader; no IG request sent");
  const started = new Date().toISOString();
  await withOperationLease(`roster-repair:${target.id}:following`, async signal => {
    const result = await withScrapeContext({ userId: target.user_id, trackedAccountId: target.id, username }, () =>
      getAllUserFollowing(target.ig_user_id, { fallbackUsername: username, viewerBotId, maxPages: 8, maxItems: 400,
        pageDelayMinMs: 9000, pageDelayMaxMs: 16000, shouldStop: () => signal.aborted }));
    signal.throwIfAborted();
    if (!result.ok) throw new Error(`Canary capture failed; roster unchanged: ${result.error}`);
    // If a normal collector started while this read was in flight, leave its
    // epoch alone. No offline artifact is imported later as new evidence.
    const latest = await getRosterSyncHealth(target.id, "following");
    if (String(latest.lastAttemptAt) !== String(before.lastAttemptAt)) throw new Error("Normal collector updated this roster; repair not persisted");
    const changes = await persistFollowingDiff(target.id, result.data, {
      leg: { startsEpoch: result.startedFromTop !== false, endsEpoch: result.complete },
      cursor: { nextCursor: result.nextCursor ?? null, viewerBotId: result.viewerBotId },
    });
    const after = await getRosterSyncHealth(target.id, "following");
    const seen = new Set(result.data.map(r => r.username.toLowerCase()));
    const overlap = [...held].filter(name => seen.has(name)).length;
    console.log(JSON.stringify({ started, ended: new Date().toISOString(), username, trackedAccountId: target.id,
      dimension: "following", persisted: true, held: held.size, distinct: seen.size, overlap,
      heldCoverage: held.size ? overlap / held.size : null, reported: target.reported,
      raw: result.rawItemsFetched, pages: result.pagesFetched, exhausted: result.complete,
      beforeCompleteAt: before.lastCompleteReadAt, afterCompleteAt: after.lastCompleteReadAt, changes }));
  });
} finally { await flushBandwidth(); await pool.end(); }
process.exit(0);
