import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Heart, MessageCircle, PlaySquare, LayoutGrid, Image as ImageIcon, Loader2, Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import MediaImage from "@/components/MediaImage";
import PostTypeFilterTabs from "./PostTypeFilterTabs";
import PostDetailModal from "./PostDetailModal";
import type { PostTypeFilter, ViewerRecentPost, ViewerDataSource } from "./types";
import type { PostsCollectionState } from "../../../../shared/posts-collection-state";

interface OwnPostsGridProps {
  posts: ViewerRecentPost[] | undefined;
  postType: PostTypeFilter;
  onPostTypeChange: (value: PostTypeFilter) => void;
  dataSource?: ViewerDataSource;
  cachedAt?: string;
  isFetching?: boolean;
  collectionStatus?: PostsCollectionState;
  /**
   * The tracked account id. Enables scoped saved-post pagination. The All
   * view can also use the existing bounded older-history collection path.
   */
  accountId?: string;
  /** Explicit authorized route for hosts with a different access scope. */
  postsEndpoint?: string;
  engagementBasePath?: string;
  /**
   * Stable, unfiltered breakdown of post counts by type.
   * When provided, used to render the filter tab badges so they
   * remain accurate after the user picks a single post type
   * (which causes the server-filtered `posts` prop to collapse
   * to that type only). When omitted, falls back to deriving
   * counts from `posts`.
   */
  postCounts?: Partial<Record<PostTypeFilter, number>>;
}

function formatCount(n: number | undefined | null): string {
  if (n === null || n === undefined) return "—";
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

/**
 * Human-readable age of the saved cache write, not a fresh upstream check.
 */
function lastCheckedAgo(cachedAt: string | undefined): string | null {
  if (!cachedAt) return null;
  const ts = new Date(cachedAt).getTime();
  if (Number.isNaN(ts)) return null;
  const diff = Date.now() - ts;
  if (diff < 0) return null;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function typeIcon(postType: string) {
  const t = postType.toLowerCase();
  if (t === "reel" || t === "video") return PlaySquare;
  if (t === "carousel") return LayoutGrid;
  return ImageIcon;
}

/** Merge post lists, keeping first occurrence per shortcode (stable order). */
function dedupeByShortcode(posts: ViewerRecentPost[]): ViewerRecentPost[] {
  const seen = new Set<string>();
  const out: ViewerRecentPost[] = [];
  for (const p of posts) {
    if (seen.has(p.shortcode)) continue;
    seen.add(p.shortcode);
    out.push(p);
  }
  return out;
}

interface LoadMoreResponse {
  items: ViewerRecentPost[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

const LOAD_MORE_LIMIT = 12;
// How many posts the grid shows before the client asks for more. The data is
// already fetched/cached server-side; this only controls what is REVEALED.
const INITIAL_VISIBLE = 10;

interface PostCellProps {
  post: ViewerRecentPost;
  onOpen: (post: ViewerRecentPost) => void;
}

function PostCell({ post, onOpen }: PostCellProps) {
  const Icon = typeIcon(post.postType);

  return (
    <button
      type="button"
      onClick={() => { if (!post.trialPreview) onOpen(post); }}
      aria-label={`View post details for ${post.shortcode}`}
      className="group relative aspect-square overflow-hidden rounded-[14px] bg-slate-100 cursor-pointer transition-opacity duration-200 hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 text-left"
    >
      <MediaImage src={post.thumbnailUrl} fallbackSrc={post.displayUrl}
        alt={post.caption?.slice(0, 80) ?? "Post"} className="absolute inset-0 h-full w-full" />

      {post.isPinned && (
        <div className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-900 shadow-[0_2px_8px_rgb(0,0,0,0.04)] backdrop-blur-sm">
          <Pin className="h-3 w-3" />
        </div>
      )}

      <div className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm">
        <Icon className="h-3 w-3 text-white" />
      </div>

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {(post.likeCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium">
            <Heart className="h-3.5 w-3.5 fill-white" />
            {formatCount(post.likeCount)}
          </span>
        )}
        {(post.commentCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium">
            <MessageCircle className="h-3.5 w-3.5 fill-white" />
            {formatCount(post.commentCount)}
          </span>
        )}
      </div>
    </button>
  );
}

function SkeletonCell() {
  return (
    <div className="aspect-square animate-pulse rounded-[14px] bg-gradient-to-br from-slate-100 to-slate-200" />
  );
}

function PostsCollectionNotice({ status }: { status: PostsCollectionState }) {
  const { t } = useTranslation();
  const date = (value: string | null) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString() : null;
  const recordedAt = date(status.recordedProfileAt);
  const readAt = date(status.lastPostsReadAt);
  const attemptAt = date(status.lastAttemptAt);
  const retryAt = date(status.nextRetryAt);
  const message = {
    available: t("ownPosts.collectionAvailable", "Saved posts may not include every Instagram post."),
    waiting_for_access: t("ownPosts.collectionAccess", "Private posts require active, approved access."),
    not_collected: t("ownPosts.collectionPending", "Posts have not been collected yet."),
    collecting: t("ownPosts.collectionRunning", "Post collection is in progress."),
    delayed: t("ownPosts.collectionDelayed", "Post collection is delayed. Saved posts may be incomplete."),
    failed: t("ownPosts.collectionFailed", "The latest post collection could not complete. Saved posts may be incomplete."),
    empty_observed: t("ownPosts.collectionEmpty", "No posts are saved from the last collection."),
    unavailable: t("ownPosts.collectionUnknown", "Post collection status is unavailable."),
  }[status.state];
  return <div role="status" className="mb-4 space-y-1 text-xs text-slate-500" data-testid="posts-collection-status">
    {status.savedTotal !== null && <p>{t("ownPosts.savedTotal", "{{count}} saved posts.", { count: status.savedTotal })} {status.recordedProfileCount === null
      ? t("ownPosts.reportedUnknown", "Instagram's post count is not known yet.")
      : t("ownPosts.recordedTotal", "Last recorded profile count: {{count}} posts.", { count: status.recordedProfileCount })}
      {recordedAt && <> {t("ownPosts.profileRecordedAt", "Profile recorded {{date}}.", { date: recordedAt })}</>}
    </p>}
    <p>{message}</p>
    {!status.trackingActive && <p>{t("ownPosts.trackingPaused", "Tracking is paused. Showing saved history.")}</p>}
    {readAt && <p>{t("ownPosts.lastPostsRead", "Posts last saved/read: {{date}}.", { date: readAt })}</p>}
    {attemptAt && status.state !== "available" && status.state !== "empty_observed" && <p>{t("ownPosts.lastPostsAttempt", "Latest collection attempt: {{date}}.", { date: attemptAt })}</p>}
    {retryAt && <p>{t("ownPosts.postsRetryAt", "Scheduled check: {{date}}.", { date: retryAt })}</p>}
  </div>;
}

export default function OwnPostsGrid({
  posts,
  postType,
  onPostTypeChange,
  dataSource,
  cachedAt,
  isFetching,
  collectionStatus,
  postCounts,
  accountId,
  postsEndpoint,
  engagementBasePath,
}: OwnPostsGridProps) {
  const { t } = useTranslation();
  const [selectedPost, setSelectedPost] = useState<ViewerRecentPost | null>(null);

  // Pagination state for server-driven "Load more". `extra` holds posts fetched
  // beyond the initial `posts` prop; the rendered list is the deduped union.
  const [extra, setExtra] = useState<ViewerRecentPost[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  // Posts are fetched and cached ahead of time, but the grid opens with only
  // INITIAL_VISIBLE of them — the rest stay behind "Load more" so the profile
  // opens short and fast instead of dumping two dozen tiles (and their images)
  // on the client at once. Revealing already-held posts costs no request.
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const pendingRequest = useRef<AbortController | null>(null);

  // Reset pagination whenever the account or the active type filter changes.
  // (The server returns a fresh, differently-filtered base list in those cases.)
  useEffect(() => {
    pendingRequest.current?.abort();
    pendingRequest.current = null;
    setExtra([]);
    setHasMore(true);
    setLoadMoreFailed(false);
    setLoadingMore(false);
    setVisibleCount(INITIAL_VISIBLE);
    setSelectedPost(null);
    return () => { pendingRequest.current?.abort(); pendingRequest.current = null; };
  }, [accountId, postType, postsEndpoint]);

  const displayList = useMemo(
    () => dedupeByShortcode([...(posts ?? []), ...extra]),
    [posts, extra],
  );
  const visibleList = useMemo(
    () => displayList.slice(0, visibleCount),
    [displayList, visibleCount],
  );

  // Reveal the held page before requesting another page in the same type and
  // account scope. Filtered pages never ask the server to collect more history.
  const hasHiddenLoaded = visibleCount < displayList.length;
  const canLoadMore =
    hasHiddenLoaded || (Boolean(postsEndpoint || accountId) && hasMore &&
      (postType === "all" || postCounts?.[postType] === undefined || displayList.length < postCounts[postType]!));

  const handleLoadMore = async () => {
    // Reveal what we already hold first — instant, no request.
    if (hasHiddenLoaded) {
      setVisibleCount((v) => v + LOAD_MORE_LIMIT);
      return;
    }
    if ((!postsEndpoint && !accountId) || pendingRequest.current) return;
    const controller = new AbortController();
    pendingRequest.current = controller;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const res = await fetch(
        `${postsEndpoint ?? `/api/tracking/accounts/${encodeURIComponent(accountId!)}/posts`}?offset=${displayList.length}&limit=${LOAD_MORE_LIMIT}&postType=${encodeURIComponent(postType)}`,
        { credentials: "include", signal: controller.signal },
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as LoadMoreResponse;
      if (controller.signal.aborted || pendingRequest.current !== controller) return;
      if (!Array.isArray(data.items) || typeof data.hasMore !== "boolean") {
        throw new Error("Invalid posts pagination response");
      }
      const incoming = data.items;
      setExtra((prev) => dedupeByShortcode([...prev, ...incoming]));
      setHasMore(Boolean(data.hasMore));
      // Reveal what we just fetched — the click was the request to see more.
      setVisibleCount((v) => v + incoming.length);
    } catch {
      if (controller.signal.aborted || pendingRequest.current !== controller) return;
      // A service restart or a temporary proxy/transport failure must not make
      // the client conclude that Instagram has no older posts. Keep the
      // control visible as a retry; only the server's explicit hasMore=false
      // is allowed to retire pagination for this account.
      setLoadMoreFailed(true);
    } finally {
      if (pendingRequest.current === controller) {
        pendingRequest.current = null;
        setLoadingMore(false);
      }
    }
  };

  // HTTP loading and an empty saved cache are separate from the background
  // collection state. An empty preview alone says nothing about Instagram.
  const isLoading = posts === undefined || dataSource === undefined;
  const isEmpty = !isLoading && displayList.length === 0;
  const checkedAgo = lastCheckedAgo(cachedAt);

  // Fallback when `postCounts` is not provided: derive from the (potentially
  // server-filtered) `posts`. This preserves prior behavior, but produces
  // collapsed badges once a non-"all" filter is active. Callers that want
  // stable badges across filter changes should pass `postCounts` derived
  // from an unfiltered query.
  const fallbackCounts = useMemo(() => {
    if (!posts) return undefined;
    const c: Partial<Record<PostTypeFilter, number>> = { all: posts.length };
    for (const p of posts) {
      const key = p.postType.toLowerCase() as PostTypeFilter;
      if (key === "photo" || key === "video" || key === "reel" || key === "carousel") {
        c[key] = (c[key] ?? 0) + 1;
      }
    }
    return c;
  }, [posts]);

  const counts = postCounts ?? fallbackCounts;

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="rounded-2xl border border-slate-200/60 bg-white p-5 md:p-6 shadow-[0_2px_8px_rgb(0,0,0,0.04)]"
      aria-label="Their own posts"
    >
      <div className="mb-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 font-display">
            {t("ownPosts.title", "Their Posts")}
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {t("ownPosts.subtitle", "What they have been publishing")}
          </p>
        </div>
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          {isFetching && (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" aria-hidden="true" />
          )}
          <PostTypeFilterTabs value={postType} onChange={onPostTypeChange} counts={counts} />
        </div>
      </div>

      {collectionStatus && <PostsCollectionNotice status={collectionStatus} />}

      {isLoading || (isEmpty && isFetching) ? (
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 9 }).map((_, i) => (
            <SkeletonCell key={i} />
          ))}
        </div>
      ) : isEmpty ? (
        <div className="py-10 text-center">
          <p className="text-sm text-slate-400">
            {collectionStatus?.savedTotal === null
              ? t("ownPosts.accessUnavailable", "Posts are unavailable.")
              : postType === "all"
              ? t("ownPosts.noneSaved", "No posts saved yet.")
              : t("ownPosts.filterEmpty", "No saved posts match this filter.")}
          </p>
          {checkedAgo && (
            <p className="mt-1 text-[11px] text-slate-300 tabular-nums">
              {t("ownPosts.cachedUpdated", "Cached data updated {{ago}}", { ago: checkedAgo })}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {visibleList.map((p) => (
              <PostCell key={p.shortcode} post={p} onOpen={setSelectedPost} />
            ))}
          </div>

          {canLoadMore && (
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200/60 bg-slate-50 px-5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("ownPosts.loadingMore", "Loading…")}
                  </>
                ) : (
                  loadMoreFailed
                    ? t("ownPosts.retryLoadMore", "Retry loading posts")
                    : t("ownPosts.loadMore", "Load more")
                )}
              </button>
            </div>
          )}
        </>
      )}
      <PostDetailModal post={selectedPost} onClose={() => setSelectedPost(null)} engagementBasePath={engagementBasePath} />
    </motion.section>
  );
}
