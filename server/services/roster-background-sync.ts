import { customerAccessSql, customerHasAccess } from "./subscription-access.js";
import { sql } from "drizzle-orm";
import { setTimeout as pause } from "node:timers/promises";
import type { BackgroundRosterView } from "../../shared/roster-background.js";
import { db } from "../db.js";
import { logger } from "../observability/logger.js";
import { getAllUserFollowers, getAllUserFollowing } from "./public-data-service.js";
import { persistFollowerDiff, persistFollowingDiff } from "./public-data-persistence.js";
import { getRosterSyncHealth, loadRosterCursor, loadRosterViewer, copyRosterFromSibling, HEAD_WALK_LEG } from "./roster-store.js";
import { OperationBusyError, resultRows, withOperationLease } from "./operation-lease.js";
import { withOperationSignal } from "./operation-context.js";
import { withScrapeContext } from "./bandwidth-meter.js";
import { isShuttingDown } from "./shutdown-state.js";
import { structurallyEligibleBotSqlPredicate, publicReadTransportSqlPredicate } from "../ig-public-scraper.js";
import { parseAutomationIdentity } from "./automation-identity.js";
import { accountProxyDurabilityIssue } from "./proxy-durability.js";
import { proxyAgentUriForEndpoint } from "./proxy-provider.js";
import {
  backgroundRosterTargets, backgroundRosterTarget, managedRosterCompleteReadMinimum,
  BACKGROUND_ROSTER_BATCH_PAGES, BACKGROUND_ROSTER_BATCH_ITEMS,
  BACKGROUND_ROSTER_BATCH_BUDGET_MS, BACKGROUND_ROSTER_HEAD_INTERVAL_MS,
  BACKGROUND_ROSTER_HEAD_PAGES, nextBackgroundFullReadAt,
  backgroundRosterBoundaryPauseMs, nextBackgroundReadRetryAt,
  type BackgroundRosterDimension,
} from "./roster-background-policy.js";

export interface BackgroundRosterProgress {
  status: string; source: string; baselineCompleteAt: Date | null;
  expectedCount: number | null; seenCount: number; pages: number;
  lastProgressAt: Date | null; nextRunAt: Date; lastError: string | null;
  epochStartedAt: Date | null; lastHeadReadAt: Date | null;
  lastHeadCount: number; nextHeadRunAt: Date; headStatus: string;
}

export async function readBackgroundRosterProgress(id: string, dimension: BackgroundRosterDimension): Promise<BackgroundRosterProgress | null> {
  const rows = resultRows<BackgroundRosterProgress>(await db.execute(sql`
    SELECT b.status,b.source,b.baseline_complete_at AS "baselineCompleteAt",
      epoch_expected_count AS "expectedCount",epoch_seen_count AS "seenCount",
      pages_completed AS pages,last_progress_at AS "lastProgressAt",next_run_at AS "nextRunAt",b.last_error AS "lastError",
      r.epoch_started_at AS "epochStartedAt",b.last_head_read_at AS "lastHeadReadAt",
      b.last_head_count AS "lastHeadCount",b.next_head_run_at AS "nextHeadRunAt",b.head_status AS "headStatus"
    FROM roster_background_sync b LEFT JOIN roster_sync_state r
      ON r.tracked_account_id=b.tracked_account_id AND r.dimension=b.dimension
    WHERE b.tracked_account_id=${id} AND b.dimension=${dimension}
  `));
  return rows[0] ?? null;
}

export async function readBackgroundRosterView(id: string, username: string, dimension: BackgroundRosterDimension): Promise<BackgroundRosterView | null> {
  const row = await readBackgroundRosterProgress(id, dimension);
  if (!row) return null;
  const iso = (value: Date | null) => value == null ? null : new Date(value).toISOString();
  return {
    enabled: row.source === "auto" || backgroundRosterTarget(username, dimension)?.source === row.source,
    status: row.status, source: row.source, baselineCompleteAt: iso(row.baselineCompleteAt),
    expectedCount: row.expectedCount, seenCount: row.seenCount, pages: row.pages,
    lastProgressAt: iso(row.lastProgressAt), nextRunAt: new Date(row.nextRunAt).toISOString(),
    epochStartedAt: iso(row.epochStartedAt), lastHeadReadAt: iso(row.lastHeadReadAt),
    lastHeadCount: row.lastHeadCount, nextHeadRunAt: new Date(row.nextHeadRunAt).toISOString(), headStatus: row.headStatus,
  };
}

/** Explicit large rosters and unfinished normal public walks share the bounded
 * continuation worker. A saved cursor must not wait for the next profile job. */
export async function reconcileBackgroundRosters(): Promise<void> {
  const targets = backgroundRosterTargets();
  if (String(process.env.FOLLOW_GRAPH_ENABLED ?? "true").toLowerCase() !== "true") return;
  await db.execute(sql`
    WITH canonical AS (
      SELECT DISTINCT ON (COALESCE(NULLIF(ig_user_id,''),lower(ig_username))) *
      FROM tracked_accounts WHERE is_active AND is_private IS NOT TRUE AND ${customerAccessSql(sql`tracked_accounts.user_id`)}
      ORDER BY COALESCE(NULLIF(ig_user_id,''),lower(ig_username)),tracking_started,id
    ), configured AS (
      SELECT c.id,p.dimension,p.source FROM canonical c
      JOIN jsonb_to_recordset(${JSON.stringify(targets)}::jsonb) AS p(username text,dimension text,source text)
        ON lower(c.ig_username)=p.username
      WHERE NULLIF(c.ig_user_id,'') IS NOT NULL
    ), unfinished AS (
      SELECT c.id,r.dimension,'auto'::text AS source FROM canonical c
      JOIN roster_sync_state r ON r.tracked_account_id=c.id
      WHERE NULLIF(c.ig_user_id,'') IS NOT NULL AND NULLIF(r.next_cursor,'') IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM configured p WHERE p.id=c.id AND p.dimension=r.dimension)
    ) INSERT INTO roster_background_sync (tracked_account_id,dimension,source)
    SELECT * FROM configured UNION ALL SELECT * FROM unfinished
    ON CONFLICT (tracked_account_id,dimension) DO NOTHING
  `);
}

interface DueRoster {
  id: string; username: string; userId: string; igUserId: string;
  dimension: BackgroundRosterDimension; source: "auto" | "graphql";
  baselineCompleteAt: Date | null; expectedCount: number | null;
  reportedCount: number | null; snapshotAt: Date | null; pages: number;
  nextRunAt: Date; nextHeadRunAt: Date; lastProgressAt: Date | null;
  lastHeadReadAt: Date | null;
}

interface SavedRosterReader {
  eligible: boolean; transport: string; identity: unknown;
  proxyUrl: string | null; proxyEndpoint: string | null;
}

function savedReaderCredentialsValid(reader: SavedRosterReader, botId: string): boolean {
  if (reader.transport !== "mobile" && !parseAutomationIdentity(reader.identity, botId)) return false;
  try {
    const proxy = reader.proxyUrl ?? (reader.proxyEndpoint ? proxyAgentUriForEndpoint(reader.proxyEndpoint) : "");
    return accountProxyDurabilityIssue(proxy) == null;
  } catch {
    return false;
  }
}

export function dueBackgroundRosterQuery(selected?: { id: string; dimension: BackgroundRosterDimension }) {
  return sql`WITH canonical AS (
    SELECT DISTINCT ON (COALESCE(NULLIF(ig_user_id,''),lower(ig_username))) *
    FROM tracked_accounts WHERE is_active AND is_private IS NOT TRUE AND ${customerAccessSql(sql`tracked_accounts.user_id`)}
    ORDER BY COALESCE(NULLIF(ig_user_id,''),lower(ig_username)),tracking_started,id
  ) SELECT c.id,c.ig_username AS username,c.user_id AS "userId",c.ig_user_id AS "igUserId",
    b.dimension,b.source,b.baseline_complete_at AS "baselineCompleteAt",
    b.epoch_expected_count AS "expectedCount",b.pages_completed AS pages,
    b.next_run_at AS "nextRunAt",b.next_head_run_at AS "nextHeadRunAt",b.last_progress_at AS "lastProgressAt",
    b.last_head_read_at AS "lastHeadReadAt",
    CASE WHEN b.dimension='follower' THEN p.follower_count ELSE p.following_count END AS "reportedCount",
    p.snapshot_at AS "snapshotAt"
  FROM roster_background_sync b JOIN canonical c ON c.id=b.tracked_account_id
  LEFT JOIN jsonb_to_recordset(${JSON.stringify(backgroundRosterTargets())}::jsonb) AS config(username text,dimension text,source text)
    ON lower(c.ig_username)=config.username AND b.dimension=config.dimension AND b.source=config.source
  LEFT JOIN LATERAL(SELECT follower_count,following_count,snapshot_at FROM profile_snapshots
    WHERE tracked_account_id=c.id ORDER BY snapshot_at DESC LIMIT 1) p ON true
  WHERE (b.source='auto' OR config.username IS NOT NULL) AND (b.next_run_at<=now() OR b.next_head_run_at<=now())
    ${selected ? sql`AND c.id=${selected.id} AND b.dimension=${selected.dimension}` : sql``}
  ORDER BY least(b.next_run_at,b.next_head_run_at),c.id,b.dimension LIMIT 1`;
}

/** One <=5-page batch per job. BullMQ concurrency=1 plus a fenced DB operation
 * lease covers overlapping processes. Network calls never hold a DB transaction. */
export async function runBackgroundRosterBatch(): Promise<Record<string, unknown>> {
  if (isShuttingDown() || String(process.env.FOLLOW_GRAPH_ENABLED ?? "true").toLowerCase() !== "true") return { skipped: "disabled-or-draining" };
  await reconcileBackgroundRosters();
  const selected = resultRows<DueRoster>(await db.execute(dueBackgroundRosterQuery()))[0];
  if (!selected) return { skipped: "nothing-due" };
  try {
    return await withOperationLease(`roster-background:${selected.id}:${selected.dimension}`, async (signal, guard) => {
      // Selection is not ownership. Another process may have completed a batch
      // before we acquired the lease; never overwrite its checkpoint using the
      // old page count, expected count or baseline state.
      let target = resultRows<DueRoster>(await db.execute(dueBackgroundRosterQuery(selected)))[0];
      if (!target) return { skipped: "no-longer-due" };
      if (target.source !== "auto" && backgroundRosterTarget(target.username, target.dimension)?.source !== target.source) return { skipped: "disabled" };
      // Canonical ownership may move when a customer stops tracking a twin.
      // Adopt the richer saved epoch WITH its viewer and progress, never just
      // a cursor or a page count. The old writer's canonical guard prevents it
      // from committing after this handover.
      const donor = resultRows<{ id: string }>(await db.execute(sql`
        SELECT b.tracked_account_id AS id FROM roster_background_sync b
        JOIN tracked_accounts old ON old.id=b.tracked_account_id
        JOIN tracked_accounts current ON current.id=${target.id}
        JOIN roster_sync_state r ON r.tracked_account_id=old.id AND r.dimension=b.dimension
        JOIN roster_background_sync own ON own.tracked_account_id=current.id AND own.dimension=b.dimension
        WHERE old.id<>current.id AND b.dimension=${target.dimension} AND b.source=${target.source}
          AND old.is_private IS NOT TRUE AND current.is_private IS NOT TRUE
          AND COALESCE(NULLIF(old.ig_user_id,''),lower(old.ig_username))=COALESCE(NULLIF(current.ig_user_id,''),lower(current.ig_username))
          AND b.last_progress_at IS NOT NULL AND (own.last_progress_at IS NULL OR b.last_progress_at>own.last_progress_at)
        ORDER BY b.last_progress_at DESC LIMIT 1
      `))[0];
      if (donor) {
        await copyRosterFromSibling(donor.id,target.id,target.dimension,{
          transactionGuard: tx=>guard.assertOwned(tx), copyBackgroundProgress:true,
        });
        target=resultRows<DueRoster>(await db.execute(dueBackgroundRosterQuery(selected)))[0];
        if(!target) return {skipped:"inherited-checkpoint-not-due"};
      }
      const delay = async (status: string, next: Date, error: string | null, both = false) => db.transaction(async tx => {
        await guard.assertOwned(tx);
        await tx.execute(sql`UPDATE roster_background_sync SET status=${status},next_run_at=${next},last_error=${error},
          next_head_run_at=CASE WHEN ${both} THEN ${next} ELSE next_head_run_at END
          WHERE tracked_account_id=${target.id} AND dimension=${target.dimension}`);
      });
      const before = await getRosterSyncHealth(target.id, target.dimension);
      // The explicit large-roster worker replaces the old single-walk size cap,
      // not Instagram restrictions or reader cooldowns.
      if (before.failureKind !== "too_large" && before.nextRetryAt && before.nextRetryAt.getTime() > Date.now()) {
        await delay("cooldown", before.nextRetryAt, before.lastError, true);
        return { deferred: "target-backoff", username: target.username };
      }
      const savedCursor = await loadRosterCursor(target.id, target.dimension, { maxAgeHours: 72 });
      const savedViewerBotId = savedCursor ? await loadRosterViewer(target.id, target.dimension) : null;
      const rosterSource = target.source === "graphql" || savedCursor?.startsWith("gql:") ? "graphql" : "auto";
      const savedReader = savedViewerBotId ? resultRows<SavedRosterReader>(await db.execute(sql`
        SELECT (${structurallyEligibleBotSqlPredicate()} AND session_data IS NOT NULL
          AND ${publicReadTransportSqlPredicate(target.dimension === "follower" ? "followers" : "following", {rosterSource})}) AS eligible,
          transport,automation_identity AS identity,proxy_url AS "proxyUrl",proxy_endpoint AS "proxyEndpoint"
        FROM bot_accounts WHERE id=${savedViewerBotId}
      `))[0] : null;
      // A cursor belongs to its reader. Terminal readers cannot recover by
      // waiting another 15 minutes: begin a fresh epoch with an eligible saved
      // session instead. Never give their old cursor to the replacement, and
      // keep all durable evidence/checkpoints until that fresh read succeeds.
      // Cooldowns, daily budgets and busy operation leases are deliberately
      // excluded here: they must defer the same viewer, not rotate its cursor.
      const replaceReader = !!savedViewerBotId && (!savedReader || !savedReader.eligible ||
        !savedReaderCredentialsValid(savedReader, savedViewerBotId));
      const viewerBotId = replaceReader ? null : savedViewerBotId;
      const readerCooldown = async (readerId = viewerBotId): Promise<Date | null> => {
        if (!readerId) return null;
        const row = resultRows<{ until: Date }>(await db.execute(sql`
          SELECT cooldown_until AS until FROM bot_accounts WHERE id=${readerId} AND cooldown_until>now()
        `))[0];
        return row?.until ?? null;
      };
      const deferReader = async (cooldown: Date) => {
        const retryAt = nextBackgroundReadRetryAt(cooldown,Date.now());
        await db.transaction(async tx => {
          await guard.assertOwned(tx);
          await tx.execute(sql`UPDATE roster_background_sync SET
            status=CASE WHEN next_run_at<=now() AND status<>'source_limited' THEN 'cooldown' ELSE status END,
            next_run_at=GREATEST(next_run_at,${retryAt}),next_head_run_at=GREATEST(next_head_run_at,${retryAt}),
            head_status=CASE WHEN next_head_run_at<=now() THEN 'cooldown' ELSE head_status END,
            last_error='Pinned roster reader is cooling down; saved cursor and observations retained'
            WHERE tracked_account_id=${target.id} AND dimension=${target.dimension}`);
        });
      };
      const initialCooldown = await readerCooldown();
      if (initialCooldown) {
        await deferReader(initialCooldown);
        return {deferred:"reader-cooldown",username:target.username};
      }
      if (savedCursor && !replaceReader && target.source === "graphql" && (!savedCursor.startsWith("gql:") || !viewerBotId)) {
        await delay("source_mismatch", new Date(Date.now() + 60 * 60_000), "Saved cursor has another source or no pinned viewer; refusing an unsafe handoff", true);
        return { deferred: "cursor-context", username: target.username };
      }
      // Legacy public walks saved cursors without a viewer. Such a cursor
      // cannot safely move to another session; retain observations, but start
      // a new pinned epoch. Persistence resets the epoch only on success.
      const startCursor = viewerBotId ? savedCursor : null;
      const started = new Date();
      const captureSignal = AbortSignal.any([signal, AbortSignal.timeout(BACKGROUND_ROSTER_BATCH_BUDGET_MS)]);
      const lastReadAt=[target.lastProgressAt,target.lastHeadReadAt].filter((value):value is Date=>value!=null)
        .sort((a,b)=>+new Date(b)-+new Date(a))[0] ?? null;
      const boundaryPause=backgroundRosterBoundaryPauseMs(lastReadAt,Date.now());
      if (boundaryPause>0) await pause(boundaryPause,undefined,{signal:captureSignal}).catch(()=>{});
      if (captureSignal.aborted || isShuttingDown()) return {deferred:"batch-time-budget",username:target.username};
      type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
      const assertTarget = async (tx: Tx) => {
        await guard.assertOwned(tx);
        const current = resultRows(await tx.execute(sql`
          SELECT t.id FROM tracked_accounts t WHERE t.id=${target.id} AND t.is_active AND ${customerAccessSql(sql`t.user_id`)}
            AND t.is_private IS NOT TRUE AND NOT EXISTS (
              SELECT 1 FROM tracked_accounts older WHERE older.is_active AND older.is_private IS NOT TRUE AND ${customerAccessSql(sql`older.user_id`)}
                AND COALESCE(NULLIF(older.ig_user_id,''),lower(older.ig_username))=COALESCE(NULLIF(t.ig_user_id,''),lower(t.ig_username))
                AND (older.tracking_started,older.id)<(t.tracking_started,t.id)
            ) FOR SHARE OF t`));
        if (!current.length) throw new Error("Roster target is no longer the active public canonical account");
      };
      if (!await customerHasAccess(target.userId)) return { skipped: "subscription-required" };
      const capture = (opts: Parameters<typeof getAllUserFollowers>[2]) => withOperationSignal(captureSignal,
        () => withScrapeContext({userId:target.userId,trackedAccountId:target.id,username:target.username},
          () => target.dimension === "follower" ? getAllUserFollowers(target.username,target.igUserId,opts)
            : getAllUserFollowing(target.igUserId,opts)));
      const persist = target.dimension === "follower" ? persistFollowerDiff : persistFollowingDiff;
      const recentDue = !replaceReader && target.lastProgressAt != null && new Date(target.nextHeadRunAt).getTime() <= Date.now();
      let headStatus: string | undefined;
      if (recentDue) {
        let headReader = viewerBotId;
        try {
          const head = await capture({startCursor:null,viewerBotId,pinViewer:true,rosterSource,
            nativeOnly:true,savedSessionOnly:true,maxMidwalkRetries:0,maxPages:BACKGROUND_ROSTER_HEAD_PAGES,
            maxItems:BACKGROUND_ROSTER_BATCH_ITEMS,pageDelayMinMs:9_000,pageDelayMaxMs:16_000,
            fallbackUsername:target.username,shouldStop:()=>isShuttingDown() || captureSignal.aborted,
            stopReasonWhenRequested:"time_budget"});
          signal.throwIfAborted();
          if (!head.ok || head.source !== "bot" || (!head.data.length && target.reportedCount !== 0)) throw new Error("Recent roster read unavailable");
          headReader = head.viewerBotId ?? viewerBotId;
          headStatus = head.stopReason === "source_limited" ? "source_limited" : ["page_error","time_budget","shutdown"].includes(head.stopReason) ? "partial" : "checked";
          await persist(target.id,head.data,{baselineOnly:target.baselineCompleteAt == null,leg:HEAD_WALK_LEG,
            transactionGuard:assertTarget,transactionCheckpoint:async tx=>{
              await tx.execute(sql`UPDATE roster_background_sync SET last_head_read_at=now(),last_head_count=${head.data.length},
                head_status=${headStatus},next_head_run_at=now()+${BACKGROUND_ROSTER_HEAD_INTERVAL_MS}*interval '1 millisecond'
                WHERE tracked_account_id=${target.id} AND dimension=${target.dimension}`);
            }});
        } catch (error) {
          signal.throwIfAborted();
          headStatus = "retrying";
          await db.transaction(async tx=>{
            await assertTarget(tx);
            await tx.execute(sql`UPDATE roster_background_sync SET head_status='retrying',
              next_head_run_at=now()+${BACKGROUND_ROSTER_HEAD_INTERVAL_MS}*interval '1 millisecond'
              WHERE tracked_account_id=${target.id} AND dimension=${target.dimension}`);
          });
          logger.warn({username:target.username,dimension:target.dimension},"recent roster check deferred; full cursor and clock unchanged");
        }
        // A partial head can have succeeded before its last page caused a
        // cooldown. Never spend another request on that same reader this tick.
        const cooldown = await readerCooldown(headReader);
        if (cooldown) {
          await deferReader(cooldown);
          return {deferred:"reader-cooldown",username:target.username,recentCheck:headStatus};
        }
      }
      if (!replaceReader && new Date(target.nextRunAt).getTime() > Date.now()) return {username:target.username,recentCheck:headStatus ?? "not-due"};
      if (target.reportedCount == null || !target.snapshotAt || Date.now() - new Date(target.snapshotAt).getTime() > 6 * 3_600_000) {
        await delay("awaiting_profile", new Date(Date.now() + 20 * 60_000), "A current profile count is required before a full roster scan", replaceReader || target.lastProgressAt == null);
        return { deferred: "profile-count", username: target.username, recentCheck:headStatus };
      }
      const expected = startCursor && target.expectedCount != null ? target.expectedCount : target.reportedCount;
      // Head + deep share the SAME five-page/90s budget, including spacing at
      // the lane boundary. No retries may add calls beyond the page allowance.
      if (recentDue && !captureSignal.aborted && !isShuttingDown()) {
        await pause(9_000 + Math.random()*7_000,undefined,{signal:captureSignal}).catch(()=>{});
      }
      if (captureSignal.aborted || isShuttingDown()) return {deferred:"batch-time-budget",username:target.username,recentCheck:headStatus};
      try {
        const opts: Parameters<typeof getAllUserFollowers>[2] = { startCursor, viewerBotId, pinViewer: true, rosterSource,
          nativeOnly: true, savedSessionOnly: true, maxMidwalkRetries:0,
          maxPages: BACKGROUND_ROSTER_BATCH_PAGES - (recentDue ? BACKGROUND_ROSTER_HEAD_PAGES : 0), maxItems: BACKGROUND_ROSTER_BATCH_ITEMS,
          pageDelayMinMs: 9_000, pageDelayMaxMs: 16_000, fallbackUsername: target.username,
          shouldStop: () => isShuttingDown() || captureSignal.aborted,
          stopReasonWhenRequested: "time_budget" as const };
        const result = await capture(opts);
        signal.throwIfAborted();
        if (!result.ok) throw new Error(result.error);
        if (result.source !== "bot") throw new Error("Native-only roster batch returned another source");
        const startsEpoch = result.startedFromTop ?? !startCursor;
        const epochExpected = startsEpoch ? target.reportedCount : expected;
        const cooldown = await readerCooldown(result.viewerBotId ?? viewerBotId);
        let committedStatus = "syncing", verifiedAt: Date | null = null;
        const changes = await persist(target.id, result.data, {
          baselineOnly: target.baselineCompleteAt == null,
          minimumCompleteReadMembers: managedRosterCompleteReadMinimum(epochExpected),
          leg: { startsEpoch, endsEpoch: result.complete },
          cursor: { nextCursor: result.nextCursor ?? null, viewerBotId: result.viewerBotId },
          transactionGuard: assertTarget,
          transactionCheckpoint: async tx => {
            const current = resultRows<{ completeAt: Date | null; seen: number; epochStartedAt:Date | null }>(await tx.execute(sql`
              SELECT r.last_complete_read_at AS "completeAt",r.epoch_started_at AS "epochStartedAt",
                (SELECT count(*)::int FROM roster_members m WHERE m.tracked_account_id=r.tracked_account_id
                  AND m.dimension=r.dimension AND m.is_current AND m.last_seen_at>=r.epoch_started_at) AS seen
              FROM roster_sync_state r WHERE r.tracked_account_id=${target.id} AND r.dimension=${target.dimension}
            `))[0];
            const completed = result.complete && current?.completeAt != null &&
              new Date(current.completeAt).getTime() >= started.getTime();
            verifiedAt = completed ? current.completeAt : null;
            const cursorStalled = !!startCursor && result.nextCursor === startCursor;
            committedStatus = completed ? "complete" : result.complete || result.stopReason === "source_limited" || cursorStalled ? "source_limited" : "syncing";
            const nextRunAt = completed ? nextBackgroundFullReadAt(current?.epochStartedAt ?? null,Date.now())
              : committedStatus === "source_limited" ? new Date(Math.max(Date.now()+60*60_000,cooldown ? +new Date(cooldown)+1_000 : 0))
              : result.stopReason === "page_error" || cooldown ? nextBackgroundReadRetryAt(cooldown,Date.now()) : new Date();
            await tx.execute(sql`UPDATE roster_background_sync SET status=${committedStatus},
              baseline_complete_at=COALESCE(baseline_complete_at,${verifiedAt}),next_run_at=${nextRunAt},
              epoch_expected_count=${epochExpected},epoch_seen_count=${current?.seen ?? 0},
              pages_completed=${(startsEpoch ? 0 : target.pages) + (result.pagesSucceeded ?? result.pagesFetched ?? 0)},
              last_batch_count=${result.data.length},last_started_at=${started},last_progress_at=now(),
              last_error=${committedStatus === "source_limited" ? cursorStalled ? "Source repeated the saved cursor; observations retained but scan cannot advance" : "Source ended before a verified complete roster; no absence evidence accepted" : result.stopReason === "page_error" ? "Page read failed; saved partial progress will be retried" : null}
              WHERE tracked_account_id=${target.id} AND dimension=${target.dimension}`);
            // A fresh epoch already read the head: reuse those observations,
            // not another request. A continuation never advances the head clock.
            if (startsEpoch && (result.data.length || result.complete)) await tx.execute(sql`UPDATE roster_background_sync SET
              last_head_read_at=now(),last_head_count=${result.data.length},
              head_status=${result.stopReason === "source_limited" ? "source_limited" : ["page_error","time_budget","shutdown"].includes(result.stopReason) ? "partial" : "checked"},
              next_head_run_at=now()+${BACKGROUND_ROSTER_HEAD_INTERVAL_MS}*interval '1 millisecond'
              WHERE tracked_account_id=${target.id} AND dimension=${target.dimension}`);
            if (cooldown) await tx.execute(sql`UPDATE roster_background_sync SET
              next_head_run_at=GREATEST(next_head_run_at,${nextBackgroundReadRetryAt(cooldown,Date.now())})
              WHERE tracked_account_id=${target.id} AND dimension=${target.dimension}`);
          },
        });
        const outcome = { username: target.username, dimension: target.dimension, status: committedStatus,
          membersObserved: result.data.length, pages: result.pagesFetched, resumed: !startsEpoch,
          hasCursor: !!result.nextCursor, verifiedAt, recentCheck:headStatus, ...changes };
        logger.info(outcome, "background roster batch committed");
        return outcome;
      } catch (error) {
        signal.throwIfAborted();
        const message = error instanceof Error ? error.message : "Roster batch failed";
        // Keep the checkpoint due. A capacity deferral is not a successful
        // empty read and does not create a failed-queue storm every minute.
        const cooldown = await readerCooldown();
        const retryAt = nextBackgroundReadRetryAt(cooldown,Date.now());
        // A new roster has no head to refresh yet. Leaving its initial head
        // clock due would win every oldest-due selection while the full lane
        // waits, preventing other accounts from getting a batch.
        await delay("cooldown", retryAt, message.slice(0, 2_000), replaceReader || target.lastProgressAt == null);
        if (cooldown) await deferReader(cooldown);
        logger.warn({ username: target.username, dimension: target.dimension, error: message, retryAt }, "background roster batch deferred; saved cursor retained");
        return { deferred: "read-or-persistence", username: target.username };
      }
    });
  } catch (error) {
    if (error instanceof OperationBusyError) return { deferred: "operation-busy", username: selected.username };
    throw error;
  }
}
