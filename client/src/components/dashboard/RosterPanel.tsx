import { memo, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Instagram,
  Loader2,
  RefreshCw,
  Search,
  Users,
  UserCheck,
  ChevronDown,
  Info,
  Clock3,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery } from "@tanstack/react-query";
import { proxyUrl } from "@/lib/img-proxy";
import { RosterSyncProgress } from "../RosterSyncProgress";

// ─── Types ──────────────────────────────────────────────────────────────────
//
// The followers roster carries avatars and IG IDs (the `accounts` table
// references the IG side). Materialized following rows carry the same optional
// profile fields; legacy rows can still omit them and use the fallback.

export type RosterMode = "followers" | "following";

interface RosterFollowerItem {
  username: string;
  displayName: string | null;
  igUserId: string | null;
  pfpUrl: string | null;
  firstSeenAt: string;
}

interface RosterFollowingItem {
  username: string;
  displayName: string | null;
  igUserId?: string | null;
  pfpUrl?: string | null;
  firstSeenAt: string;
}

type RosterItem = RosterFollowerItem | RosterFollowingItem;

type RosterSyncState = "complete" | "capped" | "syncing" | "restricted";

const VALID_SYNC_STATES = new Set<RosterSyncState>([
  "complete",
  "capped",
  "syncing",
  "restricted",
]);

interface RosterPage {
  background?: import("../../../../shared/roster-background").BackgroundRosterView | null;
  lastCompleteReadAt?: string | null;
  items: RosterItem[];
  nextCursor: string | null;
  total: number;
  loadedTotal?: number;
  expectedTotal?: number;
  reachableTotal?: number;
  completionPct?: number | null;
  isPartial?: boolean;
  syncState?: RosterSyncState;
  lastUpdatedAt?: string | null;
  snapshotAt?: string | null;
  failureKind?: string | null;
  lastAttemptAt?: string | null;
  lastSuccessfulAt?: string | null;
  nextRetryAt?: string | null;
}

export interface RosterPanelProps {
  trackedAccountId: string;
  mode: RosterMode;
  liveStatus?: NonNullable<import("./types").ViewerData["rosterStatus"]>["followers"];
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Incremental render window: how many matched rows we paint at once. Avoids
// committing thousands of DOM nodes after a few "Load more" clicks. The user
// raises the window with a lightweight "Show more rows" control.
const RENDER_WINDOW = 200;

// Debounce for the search box so each keystroke doesn't re-filter and
// re-render the whole list synchronously.
const SEARCH_DEBOUNCE_MS = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Debounce a changing value. Returns the latest value only after it has
 * stayed unchanged for `delay` ms. No external dependency.
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

function daysAgo(detectedAt: string): string {
  const diff = Date.now() - new Date(detectedAt).getTime();
  if (Number.isNaN(diff)) return "";
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  if (days < 1) {
    const hrs = Math.max(1, Math.floor(diff / (60 * 60 * 1000)));
    return `${hrs}h ago`;
  }
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function getAvatar(item: RosterItem): string | null {
  return item.pfpUrl ?? null;
}

function formatShortDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fetchRosterPage(
  trackedAccountId: string,
  mode: RosterMode,
  cursor: string | null,
): Promise<RosterPage> {
  const params = new URLSearchParams();
  params.set("limit", "500");
  if (cursor) params.set("cursor", cursor);

  const url = `/api/tracking/accounts/${encodeURIComponent(
    trackedAccountId,
  )}/${mode}/roster?${params.toString()}`;

  return fetch(url, { credentials: "include" }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`${res.status}: ${res.statusText}`);
    }
    const json = (await res.json()) as RosterPage;
    return {
      items: Array.isArray(json.items) ? json.items : [],
      nextCursor: json.nextCursor ?? null,
      total: typeof json.total === "number" ? json.total : 0,
      loadedTotal:
        typeof json.loadedTotal === "number" ? json.loadedTotal : json.total,
      expectedTotal:
        typeof json.expectedTotal === "number" ? json.expectedTotal : json.total,
      reachableTotal:
        typeof json.reachableTotal === "number" ? json.reachableTotal : undefined,
      completionPct:
        typeof json.completionPct === "number" ? json.completionPct : null,
      isPartial: Boolean(json.isPartial),
      syncState: VALID_SYNC_STATES.has(json.syncState as RosterSyncState)
        ? json.syncState
        : undefined,
      lastUpdatedAt: json.lastUpdatedAt ?? null,
      snapshotAt: json.snapshotAt ?? null,
      failureKind: json.failureKind ?? null,
      lastAttemptAt: json.lastAttemptAt ?? null,
      lastSuccessfulAt: json.lastSuccessfulAt ?? null,
      nextRetryAt: json.nextRetryAt ?? null,
      background: json.background ?? null,
      lastCompleteReadAt: json.lastCompleteReadAt ?? null,
    };
  });
}

// ─── Avatar (matches FollowersTab fallback) ─────────────────────────────────

function Avatar({ src, alt }: { src: string | null; alt: string }) {
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

// ─── Row ────────────────────────────────────────────────────────────────────

// Memoized so re-filtering / re-rendering the list does not re-render every
// already-painted row. `item` references are stable across renders (they come
// straight from the React Query page cache), so the default shallow compare
// short-circuits unchanged rows.
const RosterRow = memo(function RosterRow({ item }: { item: RosterItem }) {
  const { t } = useTranslation();
  const url = `https://www.instagram.com/${item.username}/`;
  const ago = daysAgo(item.firstSeenAt);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open @${item.username} on Instagram`}
      className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <Avatar src={getAvatar(item)} alt={`@${item.username}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900">
          @{item.username}
        </p>
        {item.displayName && (
          <p className="truncate text-xs text-slate-500">{item.displayName}</p>
        )}
      </div>
      <span className="shrink-0 text-[11px] font-medium tabular-nums text-slate-400">
        {t("followers.firstSeenAgo", "first seen {{ago}}", { ago })}
      </span>
    </a>
  );
});

// ─── Skeleton (matches FollowersTab style) ──────────────────────────────────

function RosterSkeleton() {
  return (
    <div className="space-y-2 py-1">
      {Array.from({ length: 6 }).map((_, i) => (
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
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

export default function RosterPanel({
  trackedAccountId,
  mode,
  liveStatus,
}: RosterPanelProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  // Debounced query — search filtering keys off this, not the raw input, so
  // each keystroke doesn't re-filter and re-render the whole list.
  const debouncedFilter = useDebounce(filter, SEARCH_DEBOUNCE_MS);
  // How many matched rows we currently paint (incremental rendering).
  const [renderLimit, setRenderLimit] = useState(RENDER_WINDOW);

  const queryKey = useMemo(
    () => ["tracking", "roster", trackedAccountId, mode] as const,
    [trackedAccountId, mode],
  );

  const {
    data,
    isLoading,
    isError: queryIsError,
    isFetching,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<RosterPage, Error>({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      fetchRosterPage(trackedAccountId, mode, pageParam as string | null),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(trackedAccountId),
    // Keep the ordinary first page current without repeatedly downloading an
    // arbitrarily deep list the customer is reading. Multi-page views retain
    // their place and use live viewer metadata plus an explicit refresh notice.
    refetchInterval: query => (query.state.data?.pages.length ?? 0) <= 1 ? 30_000 : false,
    refetchIntervalInBackground: false,
  });

  const isError=queryIsError && !data;

  const allItems = useMemo<RosterItem[]>(
    () => data?.pages.flatMap((p) => p.items) ?? [],
    [data],
  );

  const pageStatus=data?.pages[0];
  const liveIsNewer=!!liveStatus?.lastSuccessfulAt && Date.parse(liveStatus.lastSuccessfulAt) > Date.parse(pageStatus?.lastSuccessfulAt ?? "1970-01-01");
  const status=liveIsNewer ? liveStatus : pageStatus;
  const total = data?.pages[0]?.total ?? 0;
  const loadedTotal = status?.loadedTotal ?? total;
  const expectedTotal = status?.expectedTotal ?? total;
  const completionPct = status?.completionPct ?? null;
  // Back-compat: older API responses had no syncState — derive one from the
  // legacy isPartial flag so the UI behaves sensibly during a rolling deploy.
  const syncState: RosterSyncState =
    status?.syncState ??
    (data?.pages[0]?.isPartial ? "syncing" : "complete");
  const isSyncing = syncState === "syncing";
  const isCapped = syncState === "capped";
  const isRestricted = syncState === "restricted";
  const lastUpdatedAt = status?.lastUpdatedAt ?? null;
  const snapshotAt = data?.pages[0]?.snapshotAt ?? null;
  const nextRetryAt = status?.nextRetryAt ?? null;

  const filteredItems = useMemo<RosterItem[]>(() => {
    const q = debouncedFilter.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((item) => {
      if (item.username.toLowerCase().includes(q)) return true;
      if (
        item.displayName &&
        item.displayName.toLowerCase().includes(q)
      ) {
        return true;
      }
      return false;
    });
  }, [allItems, debouncedFilter]);

  // Reset the incremental render window whenever the (debounced) search term
  // or the underlying result set changes, so a new search starts at the top.
  useEffect(() => {
    setRenderLimit(RENDER_WINDOW);
  }, [debouncedFilter, allItems.length]);

  // Only commit the first `renderLimit` matches to the DOM. The rest are
  // revealed on demand via "Show more rows" — keeps node count bounded.
  const visibleItems = useMemo<RosterItem[]>(
    () => filteredItems.slice(0, renderLimit),
    [filteredItems, renderLimit],
  );
  const hasMoreToRender = filteredItems.length > visibleItems.length;

  // Search only sees the pages we've actually loaded. Surface that honestly
  // when more pages exist on the server so an empty/short result isn't
  // mistaken for "this user doesn't follow X".
  const isSearching = debouncedFilter.trim().length > 0;
  const searchScopeIncomplete = isSearching && hasNextPage;

  const Icon = mode === "followers" ? Users : UserCheck;
  const accent =
    mode === "followers"
      ? "bg-emerald-50 text-emerald-600"
      : "bg-sky-50 text-sky-600";

  const title =
    mode === "followers"
      ? t("followers.rosterTitle", "All followers")
      : t("following.rosterTitle", "Following list");

  const emptyLabel =
    mode === "followers"
      ? t("followers.rosterEmpty", "No followers tracked yet")
      : t("following.rosterEmpty", "No following tracked yet");

  const totalLabel =
    mode === "followers"
      ? t("followers.totalCount", "{{count}} followers", { count: expectedTotal })
      : t("following.totalCount", "{{count}} following", { count: expectedTotal });
  const loadedLabel =
    mode === "followers"
      ? t("followers.loadedProgress", "{{loaded}} of {{total}} followers loaded", {
          loaded: loadedTotal.toLocaleString(),
          total: expectedTotal.toLocaleString(),
        })
      : t("following.loadedProgress", "{{loaded}} of {{total}} following loaded", {
          loaded: loadedTotal.toLocaleString(),
          total: expectedTotal.toLocaleString(),
        });
  const lastUpdatedLabel = formatShortDate(lastUpdatedAt ?? snapshotAt);

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="rounded-2xl border border-slate-200/60 bg-white p-5 shadow-[0_2px_8px_rgb(0,0,0,0.04)]"
      aria-label={mode === "followers" ? "All followers" : "Following list"}
    >
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex h-8 w-8 items-center justify-center rounded-xl ${accent}`}
          >
            <Icon className="h-4 w-4" />
          </span>
          <div>
            <h4 className="text-sm font-semibold text-slate-900 font-display">
              {title}
            </h4>
            {!isLoading && !isError && (
              <p className="flex items-center gap-1 text-[11px] text-slate-400 tabular-nums">
                <span>{totalLabel}</span>
                <span
                  tabIndex={0}
                  role="img"
                  aria-label={t(
                    "followers.trackingNote",
                    "Instagram does not provide per-follower follow times. We show when our system first saw each user.",
                  )}
                  title={t(
                    "followers.trackingNote",
                    "Instagram does not provide per-follower follow times. We show when our system first saw each user.",
                  )}
                  className="inline-flex shrink-0 cursor-help items-center text-slate-300 transition-colors hover:text-slate-500 focus:outline-none focus-visible:text-slate-500"
                >
                  <Info className="h-3 w-3" />
                </span>
              </p>
            )}
          </div>
        </div>

        <div className="relative sm:ml-auto sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t(
              "followers.searchPlaceholder",
              "Search by name or @username",
            )}
            className="w-full rounded-lg border border-slate-200/80 bg-slate-50/60 py-2 pl-8 pr-3 text-xs text-slate-700 placeholder:text-slate-400 focus:border-slate-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </header>

      {queryIsError && data && <p role="alert" className="mb-3 text-xs text-amber-800">Roster refresh failed. Showing previously loaded rows; they may be out of date.</p>}
      {!isLoading && status?.background && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800">
        <RosterSyncProgress label={mode === "followers" ? "Follower roster" : "Following roster"} progress={status.background} />
      </div>}
      {(data?.pages.length ?? 0)>1 && liveIsNewer && <p role="status" className="mb-3 text-xs text-amber-800">
        New roster observations are available. Your loaded pages are kept in place.
        <button type="button" className="ml-2 underline" disabled={isFetching} onClick={()=>void refetch()}>Refresh loaded pages</button>
      </p>}
      {!isLoading && !isError && !status?.background && isSyncing && expectedTotal > loadedTotal && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {t(
                  "followers.partialLoading",
                  "Loaded {{loaded}} of {{total}}. We're still syncing the rest in the background.",
                  {
                    loaded: loadedTotal.toLocaleString(),
                    total: expectedTotal.toLocaleString(),
                  },
                )}
                {lastUpdatedLabel && (
                  <span className="ml-1 text-amber-700">
                    {t("followers.lastUpdated", "Last updated {{time}}.", {
                      time: lastUpdatedLabel,
                    })}
                  </span>
                )}
              </p>
            </div>
            {completionPct !== null && (
              <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 font-semibold tabular-nums text-amber-700">
                {completionPct}%
              </span>
            )}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-amber-100">
            <div
              className="h-full rounded-full bg-amber-500 transition-all"
              style={{ width: `${Math.max(2, completionPct ?? 0)}%` }}
            />
          </div>
        </div>
      )}

      {!isLoading && !isError && isRestricted && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          <div className="flex items-start gap-2">
            <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {t(
                "followers.restrictedNote",
                "This list could not be refreshed right now. We kept the last successful data and will retry with another source{{retry}}.",
                {
                  retry: formatShortDate(nextRetryAt)
                    ? ` after ${formatShortDate(nextRetryAt)}`
                    : "",
                },
              )}
            </p>
          </div>
        </div>
      )}

      {!isLoading && !isError && isCapped && expectedTotal > loadedTotal && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            <p>
              {mode === "followers"
                ? t(
                    "followers.cappedNote",
                    "Showing the {{loaded}} {{label}} we've captured. Instagram limits how many we can pull for large accounts, so this is the set we track rather than the full {{total}}.",
                    {
                      loaded: loadedTotal.toLocaleString(),
                      label: "followers",
                      total: expectedTotal.toLocaleString(),
                    },
                  )
                : t(
                    "following.cappedNote",
                    "Showing the {{loaded}} {{label}} we've captured. Instagram limits how many we can pull for large accounts, so this is the set we track rather than the full {{total}}.",
                    {
                      loaded: loadedTotal.toLocaleString(),
                      label: "following",
                      total: expectedTotal.toLocaleString(),
                    },
                  )}
              {lastUpdatedLabel && (
                <span className="ml-1 text-slate-400">
                  {t("followers.lastUpdated", "Last updated {{time}}.", {
                    time: lastUpdatedLabel,
                  })}
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2 py-1">
          <div className="flex items-center gap-2 px-1 pb-1 text-xs text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("dashboard.loading", "Loading…")}
          </div>
          <RosterSkeleton />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-sm text-slate-400">
            {t(
              "followers.rosterError",
              "Roster temporarily unavailable. Try again in a moment.",
            )}
          </p>
          <button
            type="button"
            onClick={() => {
              void refetch();
            }}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200/60 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-600 transition-colors duration-200 hover:bg-slate-100 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {isFetching
              ? t("dashboard.loading", "Loading…")
              : t("followers.rosterRetry", "Retry")}
          </button>
        </div>
      ) : total === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">
          {isSyncing
            ? t(
                "followers.rosterSyncingEmpty",
                "Roster rows are still being imported. Check back soon.",
              )
            : emptyLabel}
        </p>
      ) : filteredItems.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-slate-400">
            {t("followers.noMatches", "No matches for \"{{q}}\".", {
              q: debouncedFilter.trim(),
            })}
          </p>
          {searchScopeIncomplete && (
            <p className="mt-1.5 text-[11px] text-slate-400 tabular-nums">
              {t(
                "followers.searchScope",
                "Searching {{loaded}} loaded of {{total}} total — load more to search all.",
                {
                  loaded: loadedTotal.toLocaleString(),
                  total: expectedTotal.toLocaleString(),
                },
              )}
            </p>
          )}
        </div>
      ) : (
        <>
          {searchScopeIncomplete && (
            <p className="mb-2 px-1 text-[11px] text-slate-400 tabular-nums">
              {t(
                "followers.searchScope",
                "Searching {{loaded}} loaded of {{total}} total — load more to search all.",
                {
                  loaded: loadedTotal.toLocaleString(),
                  total: expectedTotal.toLocaleString(),
                },
              )}
            </p>
          )}
          <div className="space-y-0.5">
            {visibleItems.map((item) => (
              <RosterRow key={item.username} item={item} />
            ))}
          </div>
          {hasMoreToRender && (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => setRenderLimit((n) => n + RENDER_WINDOW)}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-1.5 text-xs font-medium text-slate-500 transition-colors duration-150 hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <ChevronDown className="h-3.5 w-3.5" />
                {t("followers.showMoreRows", "Show more rows ({{shown}} of {{matched}})", {
                  shown: visibleItems.length.toLocaleString(),
                  matched: filteredItems.length.toLocaleString(),
                })}
              </button>
            </div>
          )}
        </>
      )}

      {hasNextPage && !isError && (
        <div className="mt-4 border-t border-slate-100 pt-4 text-center">
          <button
            type="button"
            onClick={() => {
              void fetchNextPage();
            }}
            disabled={isFetchingNextPage}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200/60 bg-slate-50 px-5 py-2 text-sm font-medium text-slate-600 transition-colors duration-200 hover:bg-slate-100 disabled:opacity-50"
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("dashboard.loading", "Loading…")}
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" />
                {t("followers.loadMore", "Load more")}
              </>
            )}
          </button>
        </div>
      )}

      {!isLoading && !isError && !isSyncing && !isCapped && total > 0 && (
        <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400 tabular-nums">
          <span>{loadedLabel}</span>
          {lastUpdatedLabel && (
            <span>
              {t("followers.lastUpdated", "Last updated {{time}}.", {
                time: lastUpdatedLabel,
              })}
            </span>
          )}
        </p>
      )}
    </motion.section>
  );
}
