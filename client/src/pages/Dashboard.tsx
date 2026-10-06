import { useState, useEffect, useMemo, useRef } from "react";
import { TrialPreviewProvider, useTrialActivation } from "@/hooks/useTrialActivation";
import { TrialActivateBanner } from "@/components/TrialActivateBanner";
import { PreviewLockOverlay } from "@/components/PreviewLockOverlay";
import { Navigation } from "@/components/Navigation";
import { PrivateAccountBanner } from "@/components/PrivateAccountBanner";
import { Button } from "@/components/ui/button";
import { Lock, Activity, Instagram, Filter, BarChart3, Rss, Loader2, Users, PieChart, Radar, Grid3X3, CalendarDays, BadgeCheck, Link2, Info, FileBarChart } from "lucide-react";
import { proxyUrl } from "@/lib/img-proxy";
import { useLocation, useParams } from "wouter";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";

import AnalyticsCards from "@/components/dashboard/AnalyticsCards";
import ActivityHeatmap from "@/components/dashboard/ActivityHeatmap";
import { FeedItem } from "@/components/dashboard/FeedItem";
import InterestTags from "@/components/dashboard/InterestTags";
import CalendarHeatmap from "@/components/dashboard/CalendarHeatmap";
import TopInteractions from "@/components/dashboard/TopInteractions";
import PostTypeChart from "@/components/dashboard/PostTypeChart";
import CategoryRadar from "@/components/dashboard/CategoryRadar";
import LikedPostsGallery from "@/components/dashboard/LikedPostsGallery";
import StoriesViewer from "@/components/dashboard/StoriesViewer";
import HighlightsCarousel from "@/components/dashboard/HighlightsCarousel";
import OwnPostsGrid from "@/components/dashboard/OwnPostsGrid";
import FollowersTab from "@/components/dashboard/FollowersTab";
import RosterPanel from "@/components/dashboard/RosterPanel";
import RefreshIndicator from "@/components/dashboard/RefreshIndicator";
import ProfilePhotoLightbox from "@/components/dashboard/ProfilePhotoLightbox";
import type {
  ActivityEvent,
  PostTypeFilter,
  ViewerData,
} from "@/components/dashboard/types";
import { useTimezone } from "@/hooks/useTimezone";
import { useRealtimeEvents } from "@/hooks/useRealtimeEvents";
import { csrfHeaders } from "@/lib/csrf";
import { productAnalytics } from "@/lib/analytics";

type FollowersSubTab = "recent" | "all" | "following";

const FOLLOWERS_SUB_TABS: ReadonlyArray<{
  value: FollowersSubTab;
  i18nKey: string;
  fallback: string;
}> = [
  { value: "recent", i18nKey: "followers.tabRecent", fallback: "Recent activity" },
  { value: "all", i18nKey: "followers.tabAllFollowers", fallback: "All followers" },
  { value: "following", i18nKey: "followers.tabFollowing", fallback: "Following list" },
];

function ProfileAvatar({ profilePicUrl }: { profilePicUrl?: string }) {
  const { t } = useTranslation();
  const [imgFailed, setImgFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const hasImage = profilePicUrl && !imgFailed;
  useEffect(() => setImgFailed(false), [profilePicUrl]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => hasImage && setLightboxOpen(true)}
        aria-label={t("profile.viewPhoto", "View profile photo")}
        disabled={!hasImage}
        className="group block rounded-full transition-transform duration-200 hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 disabled:cursor-default disabled:hover:scale-100 enabled:cursor-pointer"
      >
        <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-primary to-pink-500 p-[2.5px]">
          <div className="w-full h-full rounded-full border-2 border-white bg-slate-100 overflow-hidden flex items-center justify-center">
            {hasImage ? (
              <img
                src={proxyUrl(profilePicUrl)}
                alt="Profile"
                className="w-full h-full object-cover transition-opacity duration-200 group-hover:opacity-90"
                onError={() => setImgFailed(true)}
              />
            ) : (
              <Instagram className="w-7 h-7 text-slate-400" />
            )}
          </div>
        </div>
      </button>
      <div className="pointer-events-none absolute -bottom-1.5 -right-1.5 bg-emerald-500 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full border-2 border-white">
        Tracking
      </div>
      <ProfilePhotoLightbox
        profilePicUrl={profilePicUrl}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
}

interface AccountReport {
  id: string;
  igUsername: string;
  displayName: string | null;
  isActive: boolean;
  isPrivate?: boolean;
  accessStatus?: "public" | "pending_access" | "has_access" | "access_denied";
  biography?: string;
  isVerified?: boolean;
  externalUrl?: string;
  profilePicUrl?: string;
  trackingStarted: string;
  profileSnapshots?: Array<{
    followerCount?: number;
    followingCount?: number;
    postCount?: number;
    snapshotAt: string;
  }>;
}

type FeedFilter = "all" | "like" | "follow" | "unfollow";

const FILTER_TABS: { value: FeedFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "like", label: "Likes" },
  { value: "follow", label: "Follows" },
  { value: "unfollow", label: "Unfollows" },
];

function readFeedItems(data: unknown): ActivityEvent[] {
  if (Array.isArray(data)) return data as ActivityEvent[];
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { items?: unknown }).items)
  ) {
    return (data as { items: ActivityEvent[] }).items;
  }
  return [];
}

export default function Dashboard() {
  return <TrialPreviewProvider><DashboardContent /></TrialPreviewProvider>;
}

function DashboardContent() {
  const { isPreview } = useTrialActivation();
  const previousPreview = useRef(isPreview);
  const [, setLocation] = useLocation();
  const { t } = useTranslation();
  const params = useParams<{ id?: string }>();
  const accountId = params.id;

  const [account, setAccount] = useState<AccountReport | null>(null);
  const [feed, setFeed] = useState<ActivityEvent[]>([]);
  const [accounts, setAccounts] = useState<AccountReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [authChecked, setAuthChecked] = useState(false);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("all");
  const [feedExpanded, setFeedExpanded] = useState(false);
  const [postType, setPostType] = useState<PostTypeFilter>("all");
  const [followersTab, setFollowersTab] = useState<FollowersSubTab>("recent");
  const [showNewAccountNotice, setShowNewAccountNotice] = useState(false);
  const [accessRetry, setAccessRetry] = useState<{ accountId: string; pending: boolean; error: string | null } | null>(null);
  const accessRetryInFlight = useRef(false);
  const queryClient = useQueryClient();
  const refreshAccount = useRef<() => Promise<void>>(async () => {});
  const [refreshError, setRefreshError] = useState(false);
  const {
    selected: selectedTz,
    resolved: resolvedTz,
    setTimezone,
  } = useTimezone();

  const buildViewerUrl = (username: string) => {
    const qs = new URLSearchParams();
    qs.set("tz", resolvedTz);
    if (postType !== "all") qs.set("postType", postType);
    return `/api/viewer/${encodeURIComponent(username)}?${qs.toString()}`;
  };

  const retryLoad = () => setLoadNonce((n) => n + 1);

  useEffect(() => {
    const controller = new AbortController();

    // Fetch report + feed for one account; throws on non-401 failures so the
    // caller can surface a real error state (E5) instead of falling through
    // to the empty "no tracked accounts" view.
    const loadAccount = async (id: string): Promise<boolean> => {
      const [reportRes, feedRes] = await Promise.all([
        fetch(`/api/tracking/accounts/${id}/report`, { credentials: "include", signal: controller.signal }),
        fetch(`/api/tracking/accounts/${id}/feed?limit=50`, { credentials: "include", signal: controller.signal }),
      ]);
      if (reportRes.status === 401 || feedRes.status === 401) {
        setLocation("/auth");
        return false;
      }
      if (!reportRes.ok) {
        throw new Error(`Failed to load account (${reportRes.status})`);
      }
      const reportData = await reportRes.json();
      setAccount(reportData);
      if (feedRes.ok) {
        const items = readFeedItems(await feedRes.json());
        setFeed(items);
      }
      return true;
    };

    const loadData = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        if (accountId) {
          const ok = await loadAccount(accountId);
          if (!ok) return; // redirected on 401
          setAuthChecked(true);
        } else {
          const res = await fetch("/api/tracking/accounts", { credentials: "include", signal: controller.signal });
          if (res.status === 401) { setLocation("/auth"); return; }
          if (!res.ok) {
            throw new Error(`Failed to load accounts (${res.status})`);
          }
          const data = (await res.json()) as AccountReport[];
          setAccounts(data);
          if (data.length > 0) {
            const ok = await loadAccount(data[0].id);
            if (!ok) return; // redirected on 401
          } else {
            // Successful fetch with zero accounts — this is the true empty
            // state, distinct from a failed load.
            setAccount(null);
          }
          setAuthChecked(true);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setAuthChecked(true);
        setLoadError(err instanceof Error ? err.message : "Something went wrong while loading your dashboard.");
      } finally {
        setLoading(false);
      }
    };

    loadData();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, loadNonce]);

  useEffect(() => {
    if (!account?.id) {
      setShowNewAccountNotice(false);
      return;
    }

    try {
      const key = `new-account-notice:${account.id}`;
      if (sessionStorage.getItem(key) === "1") {
        setShowNewAccountNotice(true);
        sessionStorage.removeItem(key);
      } else {
        setShowNewAccountNotice(false);
      }
    } catch {
      setShowNewAccountNotice(false);
    }
  }, [account?.id]);

  // E14: single source of truth for the viewer payload. Previously this data
  // was fetched imperatively in loadData *and* re-fetched in a separate effect
  // on every tz/postType change — two code paths hitting the same endpoint
  // (13 parallel DB queries each). One TanStack Query keyed by the inputs that
  // affect the response replaces both; SSE just invalidates this key.
  const viewerUsername = account?.igUsername;
  const {
    data: viewerData = null,
    isFetching: viewerFetching,
    isError: viewerError,
    isPlaceholderData: viewerPlaceholder,
  } = useQuery<ViewerData>({
    // Keyed by the tracked ROW, not the IG username. Two users tracking the
    // same account share a username; keyed on it, one user's cached viewer
    // payload was served to the other in the same tab (cache is never cleared
    // on logout), and its recentLikes merged into their feed — a gallery showed
    // 35 liked posts for a row that holds 23. The server scopes by userId, so
    // the row id is the only key that matches what it actually returns.
    queryKey: ["viewer", account?.id, viewerUsername, resolvedTz, postType],
    queryFn: async ({ signal }) => {
      const res = await fetch(buildViewerUrl(viewerUsername!), {
        credentials: "include",
        signal,
      });
      if (!res.ok) {
        throw new Error(`Failed to load viewer (${res.status})`);
      }
      return (await res.json()) as ViewerData;
    },
    enabled: Boolean(viewerUsername),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    // Keep the previous payload visible while a refetch (SSE invalidation or a
    // postType/tz key change) is in flight, so highlights + posts don't blank
    // out and visibly "reload" every time something upstream changes.
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === account?.id ? previous : undefined,
  });
  // viewer is supplementary — its background refresh state drives subtle UI
  // affordances only (skeletons / fetching badges), never the empty state.
  const viewerRefreshing = viewerFetching && viewerData !== null;

  // SSE can be interrupted or coalesced. A cache-only report/feed poll is the
  // backstop; single-flight and account guards prevent late responses from a
  // previous profile overwriting the selected customer's dashboard.
  useEffect(() => {
    if (!account?.id) return;
    const id = account.id;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const [reportRes, feedRes] = await Promise.all([
          fetch(`/api/tracking/accounts/${id}/report`, { credentials: "include", signal: controller.signal }),
          fetch(`/api/tracking/accounts/${id}/feed?limit=50`, { credentials: "include", signal: controller.signal }),
        ]);
        if (!reportRes.ok || !feedRes.ok) throw new Error("Dashboard refresh failed");
        const [report, items] = await Promise.all([reportRes.json(), feedRes.json()]);
        if (controller.signal.aborted) return;
        setAccount(previous => previous?.id === id ? { ...previous, ...report } : previous);
        setFeed(readFeedItems(items));
        setRefreshError(false);
      } catch {
        if (!controller.signal.aborted) setRefreshError(true);
      } finally { inFlight = false; }
    };
    refreshAccount.current = refresh;
    setRefreshError(false);
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => { controller.abort(); clearInterval(timer); refreshAccount.current = async () => {}; };
  }, [account?.id]);

  useEffect(() => {
    if (previousPreview.current && !isPreview) void refreshAccount.current();
    previousPreview.current = isPreview;
  }, [isPreview]);

  // Wave 4: live-update on backend push. The collector pipeline emits SSE
  // events whenever fresh data lands for any tracked account this user owns;
  // we re-fetch the viewer data for the *currently displayed* account when
  // its slice changes. Other accounts' events update the list but don't
  // disturb the active viewer.
  useRealtimeEvents((event) => {
    if (!account) return;
    if (event.trackedAccountId !== account.id) {
      // Account list itself may be affected (counts updated). Lightweight
      // refresh of the report endpoint keeps the sidebar accurate.
      return;
    }

    // Roster caches (full followers / following lists) are owned by
    // React Query — invalidate on the matching change kind so the
    // RosterPanel re-fetches the current cursor window.
    if (event.kind === "followers.changed" || event.kind === "following.changed") {
      // The viewer also owns recent follower/following activity and analytics.
      // Refresh it below without blanking the already rendered media.
      void queryClient.invalidateQueries({
        queryKey: [
          "tracking",
          "roster",
          account.id,
          event.kind === "followers.changed" ? "followers" : "following",
        ],
      });
    }
    void refreshAccount.current();
    void queryClient.invalidateQueries({ queryKey: ["viewer", account.id] });
    if (event.kind !== "followers.changed" && event.kind !== "following.changed") {
      void queryClient.invalidateQueries({ queryKey: ["viewer-all-types", account.id, resolvedTz] });
    }
  });

  const handleRetryAccess = async () => {
    if (!account || accessRetryInFlight.current) return;
    const id = account.id;
    accessRetryInFlight.current = true;
    setAccessRetry({ accountId: id, pending: true, error: null });
    try {
      const response = await fetch(`/api/tracking/accounts/${id}/retry-access`, {
        method: "POST",
        credentials: "include",
        headers: csrfHeaders(undefined, "POST"),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || t("privateAccount.retryFailed", "Access could not be requested. Please try again later."));
      if (result?.status !== "has_access" && result?.status !== "pending_access") {
        throw new Error(t("privateAccount.retryFailed", "Access could not be requested. Please try again later."));
      }
      setAccount(previous => previous?.id === id ? { ...previous, accessStatus: result.status } : previous);
      setAccessRetry({ accountId: id, pending: false, error: null });
      await queryClient.invalidateQueries({ queryKey: ["viewer", id] });
    } catch (error) {
      setAccessRetry({ accountId: id, pending: false, error: error instanceof Error ? error.message : t("privateAccount.retryFailed", "Access could not be requested. Please try again later.") });
    } finally {
      accessRetryInFlight.current = false;
    }
  };

  const filteredFeed = useMemo(
    () => (feedFilter === "all" ? feed : feed.filter((e) => e.eventType === feedFilter)),
    [feed, feedFilter],
  );

  const likedPosts = useMemo<ActivityEvent[]>(() => {
    const byPost = new Map<string, ActivityEvent>();
    for (const event of feed) {
      if (event.eventType === "like") byPost.set(event.postId ?? event.id, event);
    }
    for (const event of viewerData?.recentLikes ?? []) {
      const id = event.postId;
      if (byPost.has(id)) continue;
      byPost.set(id, {
        id,
        eventType: "like",
        detectedAt: event.detectedAt,
        postTakenAt: event.postTakenAt ?? null,
        ownerUsername: event.ownerUsername,
        postType: event.postType,
        postUrl: event.postUrl,
        thumbnailUrl: event.thumbnailUrl,
        hashtags: event.hashtags ?? [],
        likesCount: event.likesCount,
        commentsCount: event.commentsCount,
        videoViewCount: event.videoViewCount ?? undefined,
      });
    }
    return Array.from(byPost.values()).sort(
      // Newest POST first. detectedAt is only when we inferred the like, so
      // sorting by it floated older posts above ones published today. Rows
      // captured before the post date existed sort last: detection time is not
      // a defensible proxy for publication time.
      (a, b) =>
        (b.postTakenAt ? new Date(b.postTakenAt).getTime() : 0) -
        (a.postTakenAt ? new Date(a.postTakenAt).getTime() : 0),
    );
  }, [feed, viewerData?.recentLikes]);

  // The viewer returns full saved-cache totals independently of its preview.
  const postCounts = viewerData?.postCounts;

  const latestSnapshot = account?.profileSnapshots?.[0];

  if (!authChecked && loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-400">{t("dashboard.loading")}</div>
      </div>
    );
  }

  const accountTitle = account?.igUsername ? `@${account.igUsername} — CheaterFinder` : "Dashboard — CheaterFinder";

  return (
    <div className="min-h-screen bg-slate-50 selection:bg-primary/20 pb-20">
      <title>{accountTitle}</title>
      <Navigation />

      <main className="container mx-auto px-4 pt-32 max-w-6xl">
        <TrialActivateBanner />
        {(refreshError || viewerError) && <p role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{t("dashboard.refreshFailed", "Some data could not refresh. Showing the last available data; retrying automatically.")}</p>}
        {loading && (
          <div className="text-center py-20 text-slate-500 text-lg">{t("dashboard.loading")}</div>
        )}

        {/* E5: a failed load shows a real error + Retry, NOT the empty state —
            otherwise a transient 500/network error looks like the user's
            tracked accounts vanished. */}
        {!loading && loadError && (
          <div className="mx-auto max-w-md text-center py-20">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-rose-50">
              <Info className="h-6 w-6 text-rose-500" aria-hidden="true" />
            </div>
            <p className="text-slate-800 font-semibold text-base mb-1.5">
              {t("dashboard.loadErrorTitle", "Couldn't load your dashboard")}
            </p>
            <p className="text-slate-500 text-sm mb-5">
              {t(
                "dashboard.loadErrorBody",
                "We hit a problem fetching your tracked accounts. Your data is safe — please try again.",
              )}
            </p>
            <Button
              onClick={retryLoad}
              className="bg-primary text-white rounded-xl px-6 h-12"
            >
              {t("dashboard.retry", "Retry")}
            </Button>
          </div>
        )}

        {/* True empty state: only when the fetch SUCCEEDED with zero accounts. */}
        {!loading && !loadError && !account && (
          <div className="text-center py-20">
            <p className="text-slate-500 text-lg mb-4">{t("dashboard.noAccounts")}</p>
            <Button onClick={() => setLocation("/members")} className="bg-primary text-white rounded-xl px-6 h-12">
              {t("dashboard.goToMembers")}
            </Button>
          </div>
        )}

        {!loading && !loadError && account && (
          <>
            {/* Profile Header */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="bg-white rounded-2xl p-6 md:p-8 mb-12 border border-slate-200/60 shadow-[0_2px_8px_rgb(0,0,0,0.04)] flex flex-col md:flex-row items-center gap-6 md:gap-10"
            >
              <ProfileAvatar profilePicUrl={account.profilePicUrl} />


              <div className="flex-1 text-center md:text-left">
                <div className="flex items-center justify-center md:justify-start gap-3 mb-1.5">
                  <h1 className="text-2xl font-bold text-slate-900 tracking-tight font-display">@{account.igUsername}</h1>
                  {(viewerData?.isVerified || account.isVerified) && (
                    <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" aria-label="Verified">
                      <circle cx="12" cy="12" r="10" fill="#3B82F6" />
                      <path d="M9 12l2 2 4-4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  <span className="bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-full text-xs font-medium">
                    {account.isActive ? t("dashboard.active") : t("dashboard.inactive")}
                  </span>
                </div>
                {account.displayName && <p className="text-slate-600 mb-1 text-sm">{account.displayName}</p>}
                {(viewerData?.biography || account.biography) && (
                  <p className="text-sm text-slate-500 line-clamp-2 max-w-lg">{viewerData?.biography ?? account.biography}</p>
                )}
                {(viewerData?.externalUrl || account.externalUrl) && (
                  <a
                    href={viewerData?.externalUrl ?? account.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
                  >
                    <Link2 className="w-3 h-3" />
                    {(viewerData?.externalUrl ?? account.externalUrl ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "")}
                  </a>
                )}
                <p className="text-slate-400 text-sm mt-1">{t("dashboard.trackingStarted")} {new Date(account.trackingStarted).toLocaleDateString()}</p>

                <div className="flex flex-wrap items-center gap-2 justify-center md:justify-start mt-3">
                  <RefreshIndicator lastSnapshotAt={latestSnapshot?.snapshotAt} />
                  {!latestSnapshot && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {t("dashboard.syncPending", "Sync pending")}
                    </span>
                  )}
                </div>

                {latestSnapshot && (
                  <div className="flex justify-center md:justify-start items-center divide-x divide-slate-200 text-sm mt-4">
                    {latestSnapshot.postCount !== undefined && (
                      <div className="flex flex-col items-center md:items-start pr-8"><span className="text-xl font-bold text-slate-900 tabular-nums">{latestSnapshot.postCount?.toLocaleString() ?? "—"}</span> <span className="text-xs text-slate-400">{t("dashboard.posts")}</span></div>
                    )}
                    {latestSnapshot.followerCount !== undefined && (
                      <div className="flex flex-col items-center md:items-start px-8"><span className="text-xl font-bold text-slate-900 tabular-nums">{latestSnapshot.followerCount?.toLocaleString() ?? "—"}</span> <span className="text-xs text-slate-400">{t("dashboard.followers")}</span></div>
                    )}
                    {latestSnapshot.followingCount !== undefined && (
                      <div className="flex flex-col items-center md:items-start pl-8"><span className="text-xl font-bold text-slate-900 tabular-nums">{latestSnapshot.followingCount?.toLocaleString() ?? "—"}</span> <span className="text-xs text-slate-400">{t("dashboard.following")}</span></div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setLocation("/reports")}
                  className="bg-white border border-slate-200 hover:border-slate-300 text-slate-600 rounded-xl px-5 h-10 text-sm font-medium transition-colors duration-200"
                >
                  <FileBarChart className="w-4 h-4 mr-2" /> {t("dashboard.reports", "Reports")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setLocation("/members")}
                  className="bg-white border border-slate-200 hover:border-slate-300 text-slate-600 rounded-xl px-5 h-10 text-sm font-medium transition-colors duration-200"
                >
                  <Activity className="w-4 h-4 mr-2" /> {t("dashboard.allAccounts")}
                </Button>
              </div>
            </motion.div>

            <PrivateAccountBanner
              isPrivate={account.isPrivate ?? false}
              accessStatus={account.accessStatus ?? "public"}
              onRetry={account.isActive ? handleRetryAccess : undefined}
              retrying={accessRetry?.accountId === account.id && accessRetry.pending}
              retryError={accessRetry?.accountId === account.id ? accessRetry.error : null}
            />

            {(!account.isPrivate || account.accessStatus === "has_access") && (showNewAccountNotice || !latestSnapshot) && (
              <div className="mb-8 flex items-start gap-3 rounded-2xl border border-sky-200/70 bg-sky-50/80 p-4 text-sm text-sky-900">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {t("dashboard.newAccountNoticeTitle", "Preparing your data")}
                  </p>
                  <p className="mt-1 text-sky-800">
                    {latestSnapshot
                      ? t(
                          "dashboard.newAccountNoticeReady",
                          "We pulled the first profile data. Check back again soon while posts, followers, stories, and highlights finish loading.",
                        )
                      : t(
                          "dashboard.newAccountNoticePending",
                          "The first profile details are not available yet. Updates appear as collection succeeds; timing depends on access approval and service availability.",
                        )}
                  </p>
                </div>
                {showNewAccountNotice && latestSnapshot && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 rounded-lg px-2 text-sky-700 hover:bg-sky-100 hover:text-sky-900"
                    onClick={() => setShowNewAccountNotice(false)}
                  >
                    {t("common.dismiss", "Dismiss")}
                  </Button>
                )}
              </div>
            )}

            {/* Private + no-data disclaimer */}
            {(viewerData?.isPrivate ?? account.isPrivate) && account.accessStatus === "has_access" &&
              (viewerData?.dataSource === "none" ||
                (viewerData?.dataSource === "cached" &&
                  (viewerData?.stories?.length ?? 0) === 0 &&
                  (viewerData?.recentPosts?.length ?? 0) === 0)) && (
                <div className="mb-8 flex items-start gap-3 rounded-2xl border border-amber-200/70 bg-amber-50/70 p-4 text-sm text-amber-800">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <p>
                    {t(
                      "privateAccount.approvedCollectionPending",
                      "Access is approved, but no posts or stories are available yet. Collection can be delayed; this does not mean there is no activity. Check the latest sync status below.",
                    )}
                  </p>
                </div>
              )}

            {/* Stories strip */}
            <div className="mb-8">
              <PreviewLockOverlay><StoriesViewer
                stories={viewerData?.stories}
                dataSource={viewerData?.dataSource}
                cachedAt={viewerData?.contentCachedAt?.stories ?? undefined}
              /></PreviewLockOverlay>
            </div>

            {/* Highlights carousel */}
            <div className="mb-8">
              <PreviewLockOverlay><HighlightsCarousel
                highlights={viewerData?.highlights}
                dataSource={viewerData?.dataSource}
                cachedAt={viewerData?.contentCachedAt?.highlights ?? undefined}
              /></PreviewLockOverlay>
            </div>

            {/* Their own posts */}
            <div className="mb-12">
              <PreviewLockOverlay><OwnPostsGrid
                key={`${account.id}:${isPreview ? "preview" : "active"}`}
                posts={viewerPlaceholder ? undefined : viewerData?.recentPosts}
                postType={postType}
                onPostTypeChange={setPostType}
                dataSource={viewerData?.dataSource}
                cachedAt={viewerData?.contentCachedAt?.posts ?? undefined}
                isFetching={viewerRefreshing}
                postCounts={postCounts}
                collectionStatus={viewerData?.postsCollection}
                accountId={account.id}
              /></PreviewLockOverlay>
            </div>

            {/* Liked Posts Gallery (filterable) */}
            <div className="mb-12">
              <PreviewLockOverlay><LikedPostsGallery events={likedPosts} /></PreviewLockOverlay>
            </div>

            {/* Followers section — sub-tabbed: diff feed, full roster, following */}
            <div className="mb-12">
              <div
                role="tablist"
                aria-label="Followers view"
                className="mb-4 inline-flex items-center gap-1 rounded-lg border border-slate-200/60 bg-white p-1 shadow-[0_1px_3px_rgb(0,0,0,0.03)]"
              >
                {FOLLOWERS_SUB_TABS.map((tab) => {
                  const active = followersTab === tab.value;
                  return (
                    <button
                      key={tab.value}
                      role="tab"
                      aria-selected={active}
                      onClick={() => { setFollowersTab(tab.value); void productAnalytics.track("dashboard_tab_viewed", { tab: tab.value }); }}
                      className={`relative px-3 py-1.5 text-xs font-medium transition-colors duration-200 ${
                        active
                          ? "text-slate-900"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      {t(tab.i18nKey, tab.fallback)}
                      <span
                        className={`pointer-events-none absolute inset-x-2 -bottom-0.5 h-[2px] rounded-full transition-opacity duration-200 ${
                          active ? "bg-primary opacity-100" : "opacity-0"
                        }`}
                      />
                    </button>
                  );
                })}
              </div>

              <PreviewLockOverlay>
              {followersTab === "recent" && (
                <FollowersTab
                  followers={viewerData?.recentFollowers}
                  unfollows={viewerData?.recentUnfollows}
                  lostFollowers={viewerData?.recentFollowerUnfollows}
                  follows={viewerData?.recentFollows}
                  dataSource={viewerData?.dataSource}
                  cachedAt={viewerData?.cachedAt}
                  rosterStatus={viewerData?.rosterStatus}
                />
              )}

              {followersTab === "all" && (
                <RosterPanel
                  trackedAccountId={account.id}
                  mode="followers"
                  liveStatus={viewerData?.rosterStatus?.followers}
                />
              )}

              {followersTab === "following" && (
                <RosterPanel
                  trackedAccountId={account.id}
                  mode="following"
                  liveStatus={viewerData?.rosterStatus?.following}
                />
              )}
              </PreviewLockOverlay>
            </div>

            {/* Deep Analytics — Bento Grid (Calendar + Pattern moved to bottom) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
              <PreviewLockOverlay><PostTypeChart events={feed} /></PreviewLockOverlay>
              <PreviewLockOverlay><TopInteractions events={feed} /></PreviewLockOverlay>
              <PreviewLockOverlay><CategoryRadar events={feed} /></PreviewLockOverlay>
            </div>

            {/* Analytics Cards */}
            <div className="mb-12">
              <PreviewLockOverlay><AnalyticsCards viewerData={viewerData} /></PreviewLockOverlay>
            </div>

            {/* Activity Feed */}
            <PreviewLockOverlay><motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.35 }}
              className="bg-white rounded-2xl border border-slate-200/60 shadow-[0_2px_8px_rgb(0,0,0,0.04)] overflow-hidden"
            >
              {/* Feed Header with Filter Tabs */}
              <div className="p-5 md:p-6 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 font-display">{t("dashboard.activityFeed")}</h2>
                  <p className="text-xs text-slate-400 mt-0.5">{feed.length} events tracked</p>
                </div>
                <div className="flex items-center gap-1 bg-slate-50 rounded-lg border border-slate-200/60 p-1">
                  {FILTER_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      onClick={() => setFeedFilter(tab.value)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors duration-200 ${
                        feedFilter === tab.value
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      {tab.label}
                      {feedFilter === tab.value && filteredFeed.length > 0 && (
                        <span className="ml-1.5 text-slate-400 text-[10px] tabular-nums">
                          {filteredFeed.length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Interest Tags */}
              <div className="pt-4">
                <InterestTags events={feed} />
              </div>

              {/* Feed Items */}
              <div className="bg-white">
                {account.accessStatus === "pending_access" ? (
                  <div className="p-16 text-center">
                    <div className="w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4">
                      <Lock className="w-6 h-6 text-amber-500" />
                    </div>
                    <p className="text-slate-800 font-semibold text-base mb-1.5">
                      {t("privateAccount.gainingAccess", "Gaining access to this private account...")}
                    </p>
                    <p className="text-slate-400 text-sm">
                      {t("privateAccount.pendingFeedDesc", "Activity data will appear here once access to this private account is approved.")}
                    </p>
                  </div>
                ) : filteredFeed.length === 0 ? (
                  <div className="p-12 text-center text-slate-400">
                    {feedFilter === "all"
                      ? t("dashboard.noActivity")
                      : `No ${feedFilter} events found`}
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {filteredFeed.slice(0, feedExpanded ? filteredFeed.length : 10).map((event) => (
                      <FeedItem key={event.id} event={event} />
                    ))}
                  </div>
                )}
              </div>

              {filteredFeed.length > 10 && account.accessStatus !== "pending_access" && (
                <div className="p-4 border-t border-slate-100 text-center">
                  <button
                    onClick={() => setFeedExpanded((v) => !v)}
                    className="inline-flex items-center gap-2 px-5 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200/60 rounded-lg text-sm font-medium text-slate-600 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {feedExpanded
                      ? t("common.showLess", "Show less")
                      : `${t("common.viewMore", "View more")} (${filteredFeed.length - 10})`}
                  </button>
                </div>
              )}
            </motion.div></PreviewLockOverlay>

            {/* Activity Calendar — 2nd from bottom */}
            <div className="mt-12">
              <PreviewLockOverlay><CalendarHeatmap
                events={feed}
                activityByDate={viewerData?.activityByDate}
                timezone={selectedTz}
                onTimezoneChange={setTimezone}
                resolvedTimezone={resolvedTz}
              /></PreviewLockOverlay>
            </div>

            {/* Activity Pattern — absolute bottom */}
            <div className="mt-8">
              <PreviewLockOverlay><ActivityHeatmap
                activityByHour={viewerData?.activityByHour ?? null}
                timezone={selectedTz}
                onTimezoneChange={setTimezone}
                resolvedTimezone={resolvedTz}
              /></PreviewLockOverlay>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
