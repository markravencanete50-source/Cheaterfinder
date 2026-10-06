import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { UserPlus, UserMinus, UserCheck, Loader2, Instagram, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { proxyUrl } from "@/lib/img-proxy";
import { RosterSyncProgress } from "../RosterSyncProgress";
import type {
  ViewerFollower,
  ViewerUnfollow,
  ViewerFollowerUnfollow,
  ViewerDataSource,
  ViewerData,
} from "./types";

interface FollowersTabProps {
  followers: ViewerFollower[] | undefined;
  /** Accounts THIS profile unfollowed (unfollow_events), not people who left. */
  unfollows: ViewerUnfollow[] | undefined;
  lostFollowers?: ViewerFollowerUnfollow[];
  follows?: Array<{
    followedUsername: string;
    followedDisplayName?: string | null;
    /** Enriched from roster_members (follow_events itself stores no picture). */
    followedPfpUrl?: string | null;
    detectedAt: string;
  }>;
  dataSource?: ViewerDataSource;
  cachedAt?: string;
  rosterStatus?: ViewerData["rosterStatus"];
}

// NO relative timestamp is shown on these rows, deliberately.
//
// `detected_at` is when WE noticed a change, never when the person acted — and
// the gap is neither small nor knowable. Instagram gives no unfollow time, the
// roster is enumerated on a cycle, and a departure is only confirmed after a
// member is missing from repeated complete reads (roster-store.ts). So an
// account that unfollowed days ago could legitimately surface as "1h ago".
//
// Rather than dress a detection time up as an event time, the rows show the
// action and let the column heading and ordering carry the rest.

function isStale(cachedAt: string | undefined): boolean {
  if (!cachedAt) return true;
  const age = Date.now() - new Date(cachedAt).getTime();
  return age > 10 * 60 * 1000;
}

function Avatar({ src, alt }: { src?: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 ring-1 ring-slate-200">
        <Instagram className="h-4 w-4 text-slate-400" />
      </div>
    );
  }
  return (
    <img
      src={proxyUrl(src)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-slate-200"
    />
  );
}

interface RowEntry {
  username: string;
  displayName?: string | null;
  avatar?: string | null;
  detectedAt: string;
}

function FollowerRow({
  entry,
  variant,
}: {
  entry: RowEntry;
  variant: "new" | "lost" | "followed" | "follower_lost";
}) {
  const { t } = useTranslation();
  const url = `https://www.instagram.com/${entry.username}/`;
  const label = variant === "follower_lost" ? t("followers.lostFollowerTag", "Lost follower") : variant === "lost"
    ? t("followers.unfollowedTag", "Unfollowed")
    : variant === "followed"
      ? t("following.followedTag", "Followed")
      : t("followers.newTag", "New follower");

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open @${entry.username} on Instagram`}
      className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <Avatar src={entry.avatar} alt={`@${entry.username}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900">@{entry.username}</p>
        {entry.displayName && (
          <p className="truncate text-xs text-slate-500">{entry.displayName}</p>
        )}
      </div>
      <span
        className={`shrink-0 text-[11px] font-medium tabular-nums ${
          variant === "lost" || variant === "follower_lost" ? "text-amber-600" : variant === "followed" ? "text-sky-600" : "text-emerald-600"
        }`}
      >
        {label}
      </span>
    </a>
  );
}

interface ColumnProps {
  title: string;
  subtitle: string;
  icon: typeof UserPlus;
  accent: string;
  entries: RowEntry[];
  isLoading: boolean;
  stale: boolean;
  emptyLabel: string;
  fetchingLabel: string;
  headerNote?: string;
  variant: "new" | "lost" | "followed" | "follower_lost";
}

function Column({
  title,
  subtitle,
  icon: Icon,
  accent,
  entries,
  isLoading,
  emptyLabel,
  fetchingLabel,
  stale,
  headerNote,
  variant,
}: ColumnProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED = 10;
  const visibleEntries = expanded ? entries : entries.slice(0, COLLAPSED);
  return (
    <div className="rounded-2xl border border-slate-200/60 bg-white p-5 shadow-[0_2px_8px_rgb(0,0,0,0.04)]">
      <header className="mb-3 flex items-center gap-2">
        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-xl ${accent}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-slate-900 font-display">{title}</h4>
          <p className="flex items-center gap-1 text-[11px] text-slate-400">
            <span className="truncate">{subtitle}</span>
            {headerNote && (
              <span
                tabIndex={0}
                role="img"
                aria-label={headerNote}
                title={headerNote}
                className="inline-flex shrink-0 cursor-help items-center text-slate-300 transition-colors hover:text-slate-500 focus:outline-none focus-visible:text-slate-500"
              >
                <Info className="h-3 w-3" />
              </span>
            )}
          </p>
        </div>
        {!isLoading && entries.length > 0 && (
          <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 tabular-nums">
            {entries.length}
          </span>
        )}
      </header>

      {isLoading || stale ? (
        <div className="space-y-2 py-1">
          <div className="flex items-center gap-2 px-1 pb-1 text-xs text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {fetchingLabel}
          </div>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5"
            >
              <div className="h-10 w-10 animate-pulse rounded-full bg-gradient-to-br from-slate-100 to-slate-200" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
                <div className="h-2.5 w-1/3 animate-pulse rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">{emptyLabel}</p>
      ) : (
        <>
          <div className="space-y-0.5">
            {visibleEntries.map((entry) => (
              <FollowerRow key={entry.username + entry.detectedAt} entry={entry} variant={variant} />
            ))}
          </div>
          {entries.length > COLLAPSED && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 w-full rounded-lg py-2 text-xs font-medium text-slate-500 transition-colors duration-150 hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {expanded
                ? t("common.showLess", "Show less")
                : `${t("common.viewMore", "View more")} (${entries.length - COLLAPSED})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function FollowersTab({
  followers,
  unfollows,
  lostFollowers,
  follows,
  dataSource,
  cachedAt,
  rosterStatus,
}: FollowersTabProps) {
  const { t } = useTranslation();

  const newFollowersLoading = followers === undefined;
  const unfollowsLoading = unfollows === undefined;
  const followsLoading = follows === undefined;
  const staleGate = dataSource === undefined;

  const newFollowerRows: RowEntry[] = (followers ?? []).map((f) => ({
    username: f.followerUsername,
    displayName: f.followerDisplayName,
    avatar: f.followerPfpUrl,
    detectedAt: f.detectedAt,
  }));

  // Accounts THIS profile unfollowed. unfollow_events stores only a username,
  // but roster_members keeps the member row (name + picture) after they leave,
  // so these rows are no longer faceless.
  const unfollowRows: RowEntry[] = (unfollows ?? []).map((u) => ({
    username: u.unfollowedUsername,
    displayName: u.unfollowedDisplayName ?? null,
    avatar: u.unfollowedPfpUrl ?? null,
    detectedAt: u.detectedAt,
  }));

  const followRows: RowEntry[] = (follows ?? []).map((f) => ({
    username: f.followedUsername,
    displayName: f.followedDisplayName,
    avatar: f.followedPfpUrl ?? null,
    detectedAt: f.detectedAt,
  }));
  const partialFollowers =
    rosterStatus?.followers?.isPartial &&
    rosterStatus.followers.syncState !== "restricted"
    ? rosterStatus.followers
    : null;
  const partialFollowing =
    rosterStatus?.following?.isPartial &&
    rosterStatus.following.syncState !== "restricted"
    ? rosterStatus.following
    : null;
  const partialSummary = [partialFollowers, partialFollowing].find(status => status && !status.background) ?? null;
  const restrictedSummary =
    rosterStatus?.followers?.syncState === "restricted"
      ? rosterStatus.followers
      : rosterStatus?.following?.syncState === "restricted"
        ? rosterStatus.following
        : null;
  const cappedSummary =
    rosterStatus?.followers?.syncState === "capped"
      ? rosterStatus.followers
      : rosterStatus?.following?.syncState === "capped"
        ? rosterStatus.following
        : null;
  const unfollowsTrusted =
    rosterStatus?.following?.unfollowDetectionTrusted !== false;
  const lostFollowerRows: RowEntry[] = (lostFollowers ?? []).map(f => ({
    username: f.unfollowerUsername, displayName: f.unfollowerDisplayName,
    avatar: f.unfollowerPfpUrl, detectedAt: f.detectedAt,
  }));

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      aria-label="Follower and following activity"
    >
      {rosterStatus && [rosterStatus.followers, rosterStatus.following].some(status => status &&
        (!status.lastCompleteReadAt || Date.now() - Date.parse(status.lastCompleteReadAt) > 48 * 60 * 60 * 1000)) && (
        <p role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          {t("followers.completeRefreshStale", "A complete follower or following refresh is over 48 hours old or not yet verified. Showing confirmed data; recent changes may be missing.")}
        </p>
      )}
      {(rosterStatus?.followers?.background || rosterStatus?.following?.background) && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800">
        <RosterSyncProgress label="Follower roster" progress={rosterStatus?.followers?.background} />
        <RosterSyncProgress label="Following roster" progress={rosterStatus?.following?.background} />
      </div>}
      {partialSummary && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          {t(
            "followers.recentPartialNote",
            "Recent activity is based on the data loaded so far. Loaded {{loaded}} of {{total}}; the rest is still syncing in the background.",
            {
              loaded: partialSummary.loadedTotal.toLocaleString(),
              total: partialSummary.expectedTotal.toLocaleString(),
            },
          )}
        </div>
      )}
      {restrictedSummary && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          {t(
            "followers.restrictedVerifiedNote",
            "Instagram is limiting roster visibility. A full refresh is not verified; only confirmed observed activity is shown.",
          )}
        </div>
      )}
      {cappedSummary && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <p>
            {t(
              "followers.recentCappedNote",
              "This account's follower network is too large to pull completely. Showing activity from {{loaded}} captured accounts out of {{total}}; the full list is unavailable.",
              {
                loaded: cappedSummary.loadedTotal.toLocaleString(),
                total: cappedSummary.expectedTotal.toLocaleString(),
              },
            )}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Column
          title={t("followers.newTitle", "New followers")}
          subtitle={t("followers.newSubtitle", "People who started following")}
          icon={UserPlus}
          accent="bg-emerald-50 text-emerald-600"
          entries={newFollowerRows}
          isLoading={newFollowersLoading}
          stale={!newFollowersLoading && newFollowerRows.length === 0 && staleGate}
          emptyLabel={t("followers.newEmpty", "No new followers in the tracked window.")}
          fetchingLabel={t("followers.fetchingNew", "Fetching new followers…")}
          variant="new"
          headerNote={t(
            "followers.trackingNote",
            "Instagram does not provide per-follower follow times. We show when our system first saw each user.",
          )}
        />

        <Column
          title={t("following.unfollowedTitle", "Accounts unfollowed")}
          subtitle={t("following.unfollowedSubtitle", "Accounts this profile stopped following")}
          icon={UserMinus}
          accent="bg-amber-50 text-amber-600"
          entries={unfollowRows}
          isLoading={unfollowsLoading}
          stale={!unfollowsLoading && unfollowRows.length === 0 && staleGate}
          emptyLabel={
            unfollowsTrusted
              ? t("followers.lostEmpty", "No unfollows detected.")
              : t(
                  "followers.lostSyncing",
                  "Unfollow detection is paused until enough of the following roster is loaded.",
                )
          }
          fetchingLabel={t("followers.fetchingLost", "Fetching unfollows…")}
          variant="lost"
        />

        <Column
          title={t("following.recentTitle", "Recently followed")}
          subtitle={t("following.recentSubtitle", "Accounts this profile followed")}
          icon={UserCheck}
          accent="bg-sky-50 text-sky-600"
          entries={followRows}
          isLoading={followsLoading}
          stale={!followsLoading && followRows.length === 0 && staleGate}
          emptyLabel={t("following.recentEmpty", "No new follows in the tracked window.")}
          fetchingLabel={t("following.fetchingRecent", "Fetching recent follows…")}
          variant="followed"
        />
        <Column
          title={t("followers.departedTitle", "Lost followers")}
          subtitle={t("followers.departedSubtitle", "People who stopped following this profile")}
          icon={UserMinus}
          accent="bg-amber-50 text-amber-600"
          entries={lostFollowerRows}
          isLoading={lostFollowers === undefined}
          stale={false}
          emptyLabel={rosterStatus?.followers?.unfollowDetectionTrusted === false
            ? t("followers.departedSyncing", "Lost-follower detection is paused until the follower roster is trusted.")
            : t("followers.departedEmpty", "No confirmed lost followers in the tracked window.")}
          fetchingLabel={t("followers.departedLoading", "Loading lost followers…")}
          variant="follower_lost"
        />
      </div>
    </motion.section>
  );
}
