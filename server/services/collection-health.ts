import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { backgroundRosterTargets } from "./roster-background-policy.js";
import type { BackgroundRosterView } from "../../shared/roster-background.js";
import { customerAccessSql } from "./subscription-access.js";
import { healthyPrivateReaderTargetIds } from "./private-account-access.js";

export type CollectionProfileState = "awaiting_approval" | "access_denied" | "awaiting_profile" | "reader_unavailable" | "provider_blocked" | "eligible";

export interface CollectionHealth {
  verification: "verified" | "degraded" | "unverified";
  incompleteProfiles: number;
  features: Array<{ feature: string; successes: number; failures: number; lastSuccessAt: string | null; lastFailureAt: string | null }>;
  activeProfiles: number;
  rosterEligibleProfiles: number;
  awaitingApprovalProfiles: number;
  accessDeniedProfiles: number;
  missingProfileBaselines: number;
  blockedPrivateReaders: number;
  providerBlockedProfiles: number;
  excludedSubscriptionTrackings: number;
  staleFollowerRosters: number;
  staleFollowingRosters: number;
  postSuccessesLastHour: number;
  postFailuresLastHour: number;
  profiles: Array<{ trackingId: string; username: string; isPrivate: boolean; state: CollectionProfileState; rosterEligible: boolean;
    followersCompleteAt: string | null; followingCompleteAt: string | null;
    followersFailureKind: string | null; followingFailureKind: string | null;
    followersRetryAt: string | null; followingRetryAt: string | null;
    backgroundFollowers?: BackgroundRosterView | null; backgroundFollowing?: BackgroundRosterView | null }>;
}

function progressJson(aliasName: "fb" | "gb") {
  const b = sql.identifier(aliasName);
  return sql`CASE WHEN ${b}.tracked_account_id IS NULL THEN NULL ELSE jsonb_build_object(
    'enabled',${b}.source='auto' OR EXISTS(SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(backgroundRosterTargets())}::jsonb)
      AS config(username text,dimension text,source text) WHERE config.username=lower(c.ig_username)
      AND config.dimension=${b}.dimension AND config.source=${b}.source),
    'status',${b}.status,'source',${b}.source,'baselineCompleteAt',${b}.baseline_complete_at,
    'expectedCount',${b}.epoch_expected_count,'seenCount',${b}.epoch_seen_count,'pages',${b}.pages_completed,
    'lastProgressAt',${b}.last_progress_at,'nextRunAt',${b}.next_run_at,
    'epochStartedAt',${sql.identifier(aliasName === "fb" ? "f" : "g")}.epoch_started_at,
    'lastHeadReadAt',${b}.last_head_read_at,'lastHeadCount',${b}.last_head_count,
    'nextHeadRunAt',${b}.next_head_run_at,'headStatus',${b}.head_status) END`;
}

/** Read freshness from complete epochs, not recent attempts or a settled label. */
export function collectionHealthQuery(healthyPrivateTargets: readonly string[] = []) {
  return sql`WITH active AS (
    SELECT *,${customerAccessSql(sql`tracked_accounts.user_id`)} AS entitled FROM tracked_accounts WHERE is_active
  ), canonical AS (
    SELECT DISTINCT ON (CASE WHEN is_private THEN 'private:'||id ELSE 'public:'||COALESCE(NULLIF(ig_user_id,''),lower(ig_username)) END) *
    FROM active WHERE entitled
    ORDER BY CASE WHEN is_private THEN 'private:'||id ELSE 'public:'||COALESCE(NULLIF(ig_user_id,''),lower(ig_username)) END,tracking_started,id
  ), targets AS (
    SELECT c.*,
      (NOT c.is_private OR (c.access_status='has_access' AND EXISTS(
        SELECT 1 FROM bot_follow_requests WHERE tracked_account_id=c.id AND status='accepted'))) AS authorized,
      (COALESCE(c.ig_user_id,'') ~ '^[0-9]+$' AND EXISTS(
        SELECT 1 FROM profile_snapshots WHERE tracked_account_id=c.id)) AS has_baseline,
      (c.is_private AND c.access_status='has_access' AND NOT (c.id=ANY(${sql.param(healthyPrivateTargets)}::varchar[]))) AS reader_blocked
    FROM canonical c
  ), features AS (
    SELECT feature,
      count(l.id) FILTER (WHERE l.outcome='success') successes,
      count(l.id) FILTER (WHERE l.outcome<>'success') failures,
      max(l.occurred_at) FILTER (WHERE l.outcome='success') last_success_at,
      max(l.occurred_at) FILTER (WHERE l.outcome<>'success') last_failure_at
    FROM unnest(ARRAY['profile','posts','stories','highlights','likers','comments']) AS feature
    LEFT JOIN scrape_outcome_log l ON l.endpoint=feature AND l.occurred_at>=now()-interval '1 hour'
    GROUP BY feature
  ), incomplete AS (
    SELECT count(*) total FROM targets c
    JOIN LATERAL (
      SELECT status,error FROM collection_jobs WHERE tracked_account_id=c.id AND job_type='profile'
        AND status IN ('completed','failed') AND (error IS NULL OR error NOT LIKE 'skipped:%')
      ORDER BY started_at DESC NULLS LAST LIMIT 1
    ) j ON true
    WHERE c.authorized AND (j.status='failed' OR j.error LIKE 'partial %')
  ), rosters AS (
    SELECT c.id,c.ig_username,c.is_private,c.access_status,c.authorized,c.has_baseline,c.reader_blocked,
      (c.authorized AND c.has_baseline) AS roster_eligible,
      (c.authorized AND (f.failure_kind IS NOT NULL OR g.failure_kind IS NOT NULL
        OR (fb.status IN ('source_limited','source_mismatch','cooldown') AND (f.last_complete_read_at IS NULL OR fb.last_started_at>f.last_complete_read_at))
        OR (gb.status IN ('source_limited','source_mismatch','cooldown') AND (g.last_complete_read_at IS NULL OR gb.last_started_at>g.last_complete_read_at)))) AS provider_blocked,
      f.last_complete_read_at followers_at, g.last_complete_read_at following_at,
      f.failure_kind followers_failure,g.failure_kind following_failure,f.next_retry_at followers_retry,g.next_retry_at following_retry,
      ${progressJson("fb")} AS followers_progress,${progressJson("gb")} AS following_progress
    FROM targets c
    LEFT JOIN roster_sync_state f ON f.tracked_account_id=c.id AND f.dimension='follower'
    LEFT JOIN roster_sync_state g ON g.tracked_account_id=c.id AND g.dimension='following'
    LEFT JOIN roster_background_sync fb ON fb.tracked_account_id=c.id AND fb.dimension='follower'
    LEFT JOIN roster_background_sync gb ON gb.tracked_account_id=c.id AND gb.dimension='following'
  ) SELECT jsonb_build_object(
    'verification',CASE
      WHEN (SELECT total FROM incomplete)>0
        OR count(*) FILTER (WHERE NOT authorized OR NOT has_baseline OR reader_blocked OR provider_blocked)>0
        OR count(*) FILTER (WHERE roster_eligible AND (followers_at IS NULL OR following_at IS NULL
          OR followers_at<now()-interval '48 hours' OR following_at<now()-interval '48 hours'))>0
        OR EXISTS(SELECT 1 FROM features WHERE last_failure_at IS NOT NULL AND (last_success_at IS NULL OR last_failure_at>last_success_at)) THEN 'degraded'
      WHEN NOT EXISTS(SELECT 1 FROM features WHERE successes=0) AND count(*)>0 THEN 'verified'
      ELSE 'unverified' END,
    'incompleteProfiles',(SELECT total FROM incomplete),
    'features',(SELECT jsonb_agg(jsonb_build_object('feature',feature,'successes',successes,'failures',failures,'lastSuccessAt',last_success_at,'lastFailureAt',last_failure_at) ORDER BY feature) FROM features),
    'activeProfiles',count(*),
    'rosterEligibleProfiles',count(*) FILTER (WHERE roster_eligible),
    'awaitingApprovalProfiles',count(*) FILTER (WHERE is_private AND access_status NOT IN ('has_access','access_denied')),
    'accessDeniedProfiles',count(*) FILTER (WHERE is_private AND access_status='access_denied'),
    'missingProfileBaselines',count(*) FILTER (WHERE authorized AND NOT has_baseline),
    'blockedPrivateReaders',count(*) FILTER (WHERE reader_blocked),
    'providerBlockedProfiles',count(*) FILTER (WHERE provider_blocked),
    'excludedSubscriptionTrackings',(SELECT count(*) FROM active WHERE NOT entitled),
    'staleFollowerRosters',count(*) FILTER (WHERE roster_eligible AND (followers_at IS NULL OR followers_at<now()-interval '48 hours')),
    'staleFollowingRosters',count(*) FILTER (WHERE roster_eligible AND (following_at IS NULL OR following_at<now()-interval '48 hours')),
    'postSuccessesLastHour',(SELECT count(*) FROM scrape_outcome_log WHERE endpoint='posts' AND occurred_at>=now()-interval '1 hour' AND outcome='success'),
    'postFailuresLastHour',(SELECT count(*) FROM scrape_outcome_log WHERE endpoint='posts' AND occurred_at>=now()-interval '1 hour' AND outcome='failure'),
    'profiles',coalesce(jsonb_agg(jsonb_build_object('trackingId',id,'username',ig_username,'isPrivate',is_private,'rosterEligible',roster_eligible,
      'state',CASE WHEN is_private AND access_status NOT IN ('has_access','access_denied') THEN 'awaiting_approval'
        WHEN is_private AND access_status='access_denied' THEN 'access_denied'
        WHEN reader_blocked THEN 'reader_unavailable' WHEN NOT has_baseline THEN 'awaiting_profile'
        WHEN provider_blocked THEN 'provider_blocked' ELSE 'eligible' END,
      'followersCompleteAt',followers_at,'followingCompleteAt',following_at,
      'followersFailureKind',followers_failure,'followingFailureKind',following_failure,
      'followersRetryAt',followers_retry,'followingRetryAt',following_retry,
      'backgroundFollowers',followers_progress,'backgroundFollowing',following_progress) ORDER BY ig_username,id),'[]'::jsonb)
  ) AS health FROM rosters`;
}

export async function readCollectionHealth(): Promise<CollectionHealth> {
  const result = await db.execute(collectionHealthQuery(await healthyPrivateReaderTargetIds()));
  return result.rows[0].health as CollectionHealth;
}
