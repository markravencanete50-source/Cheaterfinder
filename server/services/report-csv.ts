// Chronological activity-log CSV for a report window.
//
// SnoopReport offers a "Download CSV" of all actions; this matches it with a
// cleaner, documented schema. The rows are the account's OUTBOUND activity in
// [periodStart, periodEnd) — what they did, newest first: likes, follows,
// unfollows. Inbound follower changes are deliberately excluded here (that's a
// different question — "who did things TO them" — and belongs in its own export)
// so the file reads as a single coherent activity stream.
//
// Every field is RFC-4180 escaped, so captions/usernames containing commas,
// quotes or newlines cannot corrupt the columns.

import { and, eq, gte, inArray, lt } from "drizzle-orm";

import { db } from "../db.js";
import {
  likeEvents,
  followEvents,
  trackedAccounts,
} from "../../shared/schema.js";
import { likedPostAfterTrackingStart } from "./like-event-policy.js";
import {
  canonicalTwinId,
  dedupeLikedPostsByPostId,
  twinTrackedAccountIds,
} from "./tracked-account-twins.js";
import {
  followActivityFilters,
  listRosterDepartures,
  visibleFollowEventsSql,
} from "./roster.js";

export interface ReportCsvRow {
  /** When we detected the action (ISO 8601, UTC). */
  readonly detectedAt: string;
  /** like | follow | unfollow */
  readonly action: "like" | "follow" | "unfollow";
  /** The account the action was directed at. */
  readonly targetUsername: string;
  /** Display name of the target, when known. */
  readonly targetName: string;
  /** For likes: the post's own publish time (ISO), else empty. */
  readonly postDate: string;
  /** photo | video | reel | carousel for likes, else empty. */
  readonly mediaType: string;
  /** Likes on the liked post, else empty. */
  readonly likeCount: string;
  /** Hashtags on the liked post (space-separated), else empty. */
  readonly hashtags: string;
  /** Link to the post (likes only), else empty. */
  readonly url: string;
}

const CSV_HEADER: ReadonlyArray<keyof ReportCsvRow> = [
  "detectedAt",
  "action",
  "targetUsername",
  "targetName",
  "postDate",
  "mediaType",
  "likeCount",
  "hashtags",
  "url",
];

const HEADER_LABELS: Record<keyof ReportCsvRow, string> = {
  detectedAt: "Detected At (UTC)",
  action: "Action",
  targetUsername: "Target Username",
  targetName: "Target Name",
  postDate: "Post Date (UTC)",
  mediaType: "Media Type",
  likeCount: "Post Likes",
  hashtags: "Hashtags",
  url: "URL",
};

/** RFC-4180: quote a field iff it contains a comma, quote, CR or LF; escape quotes by doubling. */
function csvField(value: string): string {
  if (value === "") return "";
  // Quoting alone does not stop spreadsheet formulas in external display names.
  // Preserve the value as text, including prefixes hidden behind whitespace.
  if (/^[\t\r\n]|^[\s\u0000-\u001f]*[=+\-@]/u.test(value)) value = `'${value}`;
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toIso(d: Date | null | undefined): string {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : "";
}

/**
 * Collect the account's activity in the window and render it as a CSV string
 * (newest action first). Bounded to [start, end), matching report aggregates.
 */
export async function buildReportCsv(
  trackedAccountId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<string> {
  const [account] = await db
    .select({ trackingStarted: trackedAccounts.trackingStarted })
    .from(trackedAccounts)
    .where(eq(trackedAccounts.id, trackedAccountId))
    .limit(1);
  if (!account) {
    throw new Error(`tracked account ${trackedAccountId} not found`);
  }

  // Liked-post evidence belongs to the IG user → twin union; rosters live on
  // the canonical twin; follow gates are per-row and shared with the viewer.
  const [twinIds, rosterAccountId, followFilters] = await Promise.all([
    twinTrackedAccountIds(trackedAccountId),
    canonicalTwinId(trackedAccountId),
    followActivityFilters(trackedAccountId),
  ]);

  const [likeRows, follows, unfollows] = await Promise.all([
    db
      .select()
      .from(likeEvents)
      .where(
        and(
          inArray(likeEvents.trackedAccountId, twinIds),
          gte(likeEvents.detectedAt, periodStart),
          lt(likeEvents.detectedAt, periodEnd),
          // Still keyed on THIS row's tracking start.
          likedPostAfterTrackingStart(account.trackingStarted),
        ),
      ),
    // Settled-roster boundary + flip-flop suppression + roster contradiction.
    db
      .select()
      .from(followEvents)
      .where(
        and(
          visibleFollowEventsSql({
            trackedAccountId,
            rosterAccountId,
            boundary: followFilters.boundary,
          }),
          gte(followEvents.detectedAt, periodStart),
          lt(followEvents.detectedAt, periodEnd),
        ),
      ),
    // Confirmed roster departures, gated by unfollow trust — not the raw log.
    listRosterDepartures({
      rosterAccountId,
      unfollowsTrusted: followFilters.unfollowsTrusted,
      start: new Date(Math.max(periodStart.getTime(), account.trackingStarted.getTime(), followFilters.boundary?.getTime() ?? 0)),
      end: periodEnd,
    }),
  ]);
  // One row per post across the twins.
  const likes = dedupeLikedPostsByPostId(likeRows);

  const rows: ReportCsvRow[] = [];

  for (const l of likes) {
    rows.push({
      detectedAt: toIso(l.detectedAt),
      action: "like",
      targetUsername: l.ownerUsername ?? "",
      targetName: "",
      postDate: toIso(l.postTakenAt),
      mediaType: l.postType ?? "",
      likeCount: l.likesCount != null ? String(l.likesCount) : "",
      hashtags: (l.hashtags ?? []).map((h) => `#${h}`).join(" "),
      url: l.postUrl ?? "",
    });
  }
  for (const f of follows) {
    rows.push({
      detectedAt: toIso(f.detectedAt),
      action: "follow",
      targetUsername: f.followedUsername ?? "",
      targetName: f.followedDisplayName ?? "",
      postDate: "",
      mediaType: "",
      likeCount: "",
      hashtags: "",
      url: f.followedUsername ? `https://www.instagram.com/${f.followedUsername}/` : "",
    });
  }
  for (const u of unfollows) {
    rows.push({
      detectedAt: toIso(u.leftAt),
      action: "unfollow",
      targetUsername: u.username,
      targetName: u.displayName ?? "",
      postDate: "",
      mediaType: "",
      likeCount: "",
      hashtags: "",
      url: u.username ? `https://www.instagram.com/${u.username}/` : "",
    });
  }

  return renderCsv(rows);
}

/**
 * Render rows to an RFC-4180 CSV string, newest action first. Pure (no I/O) so
 * the escaping and ordering — the parts that can silently corrupt a file — are
 * unit-testable without a database.
 */
export function renderCsv(rows: ReadonlyArray<ReportCsvRow>): string {
  const ordered = [...rows].sort((a, b) =>
    b.detectedAt.localeCompare(a.detectedAt),
  );
  const lines: string[] = [];
  lines.push(CSV_HEADER.map((k) => csvField(HEADER_LABELS[k])).join(","));
  for (const row of ordered) {
    lines.push(CSV_HEADER.map((k) => csvField(row[k])).join(","));
  }
  // Trailing newline so appends and POSIX tools behave; CRLF per RFC 4180.
  return lines.join("\r\n") + "\r\n";
}

export const __testing = { csvField };

/** Safe download filename, e.g. cheaterfinder-activity-example_account-2026-07-09.csv */
export function reportCsvFilename(
  igUsername: string,
  periodStart: Date,
): string {
  const safe = (igUsername || "account").replace(/[^a-z0-9_.-]/gi, "_");
  const day = toIso(periodStart).slice(0, 10) || "period";
  return `cheaterfinder-activity-${safe}-${day}.csv`;
}
