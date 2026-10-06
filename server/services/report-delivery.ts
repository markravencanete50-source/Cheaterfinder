import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { notifications, reports } from "../../shared/schema.js";
import { recordReportEmail, reportEmailKey } from "./transactional-emails.js";
import { customerAccessSql } from "./subscription-access.js";
import type { ReportMetrics } from "./report-data.js";

export type ReadyReportStats = {
  totalLikes:number;totalFollows:number;totalUnfollows:number;peakActivityHour:number|null;
  topNiche:string|null;metrics:ReportMetrics;
};

/** Readiness, notification and email intent commit together; Redis loss cannot
 * leave a successful report without a durable delivery record. */
export async function persistReadyReport(reportId:string, stats:ReadyReportStats, deliver:boolean) {
  return db.transaction(async tx => {
    const rows = await tx.execute(sql`SELECT r.type,r.status,t.user_id,t.ig_username,u.email_alerts FROM reports r
      JOIN tracked_accounts t ON t.id=r.tracked_account_id JOIN users u ON u.id=t.user_id
      WHERE r.id=${reportId} AND t.is_active AND (NOT t.is_private OR t.access_status='has_access')
        AND ${customerAccessSql(sql`t.user_id`)} FOR UPDATE OF r,t`);
    const row = (rows as unknown as {rows:Array<any>}).rows[0];
    if (!row) {
      await tx.update(reports).set({status:"failed"}).where(eq(reports.id,reportId));
      return {};
    }
    if (row.status==="ready") {
      // A pre-existing ready report may have been delivered by an older
      // release. Never create a fresh intent simply because generation retries.
      const existing = await tx.execute(sql`SELECT id FROM transactional_emails WHERE id=${reportEmailKey(reportId)}
        AND user_id=${row.user_id} AND accepted_at IS NULL AND skipped_at IS NULL`);
      return {emailId:(existing as unknown as {rows:Array<{id:string}>}).rows[0]?.id};
    }
    await tx.update(reports).set({status:"ready",...stats}).where(eq(reports.id,reportId));
    if (!deliver) return {};
    const net = stats.metrics.summary.netFollowerChange;
    const growth = net===null ? "follower change unavailable" : net===0 ? "no follower change" : `${net>0?"+":""}${net} followers`;
    const notice = {userId:row.user_id as string,type:"report_ready" as const,title:`${row.type==="monthly"?"Monthly":"Weekly"} report ready`,
      body:`@${row.ig_username} — ${growth}, ${stats.totalLikes} observed likes.`,dedupeKey:`report:${reportId}`};
    const inserted = await tx.insert(notifications).values(notice).onConflictDoNothing({target:notifications.dedupeKey}).returning({id:notifications.id});
    const emailId = row.email_alerts ? await recordReportEmail(tx,row.user_id,reportId) : undefined;
    return {emailId,notification:inserted.length ? notice : undefined};
  });
}

const WEEK_MS=7*86_400_000;
/** BullMQ prevMillis is the scheduled occurrence; retries keep this window. */
export function scheduledWeeklyWindow(timestamp:number, scheduledAt?:number, offset=0) {
  const end = scheduledAt==null ? timestamp : scheduledAt+offset;
  if (!Number.isFinite(end) || end<=0) throw new Error("Invalid weekly report occurrence");
  return {periodStart:new Date(end-WEEK_MS),periodEnd:new Date(end)};
}

export function scheduledReportId(accountId:string, periodEnd:Date):string {
  return createHash("sha256").update(`weekly:${accountId}:${periodEnd.toISOString()}`).digest("hex").slice(0,36);
}
