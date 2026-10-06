import { useEffect, useMemo, useState } from "react";
import MediaImage from "@/components/MediaImage";
import {
  Heart,
  PlaySquare,
  Image as ImageIcon,
  LayoutGrid,
} from "lucide-react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import PostTypeFilterTabs from "./PostTypeFilterTabs";
import PostAgeFilterTabs, {
  POST_AGE_DAYS,
  type PostAgeFilter,
} from "./PostAgeFilterTabs";
import type { ActivityEvent, PostTypeFilter } from "./types";

function formatCount(n: number | undefined): string {
  if (n === null || n === undefined) return "—";
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

interface LikedPostsGalleryProps {
  events: ActivityEvent[];
  /**
   * Render the "Posts liked by this person" title + count. Hosts that already
   * frame the gallery under their own heading (the admin detail sheet) pass
   * false, otherwise the section reads twice and the inner title wraps in a
   * narrow column beside the filter tabs.
   */
  showTitle?: boolean;
}

const postTypeIcon: Record<string, typeof Heart> = {
  video: PlaySquare,
  reel: PlaySquare,
  image: ImageIcon,
  photo: ImageIcon,
  carousel: LayoutGrid,
};

// NOTE: This helper is intentionally duplicated (with a shorter output format)
// from FeedItem.tsx's formatEventTime. Hoisting it into a shared module would
// require a new file outside the allowed edit scope — see task report.
function formatTimeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return "—";

  // Clamp clock skew (then in the future) so negative deltas read "just now".
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Is this post within `days` of now, judged by its PUBLICATION date?
 *
 * Uses postTakenAt, never detectedAt: detection time reflects our scan
 * cadence, so a months-old post first seen today would wrongly count as
 * recent. A post with no usable publication date is excluded from every
 * bounded bucket rather than defaulting into all of them — the same
 * fail-closed rule the liked-post scan uses for undateable posts.
 */
function isPostWithinDays(
  event: ActivityEvent,
  days: number,
  nowMs: number,
): boolean {
  const raw = event.postTakenAt;
  if (!raw) return false;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t) || t <= 0) return false;
  return nowMs - t <= days * 86_400_000;
}

function GalleryCell({ event }: { event: ActivityEvent }) {
  const Icon = postTypeIcon[(event.postType ?? "").toLowerCase()] ?? Heart;

  return (
    <a
      href={event.postUrl ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative aspect-square overflow-hidden rounded-lg sm:rounded-xl cursor-pointer transition-opacity duration-200 hover:opacity-90 bg-slate-100"
    >
      <MediaImage src={event.displayUrl} fallbackSrc={event.thumbnailUrl}
        alt={`Post by @${event.ownerUsername ?? "unknown"}`}
        className="absolute inset-0 w-full h-full" />

      <div className="absolute inset-0 bg-black/45 flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-2 text-center">
        <Icon className="w-4 h-4 text-white shrink-0" />
        <span className="text-white text-[11px] sm:text-xs font-medium truncate max-w-full">
          @{event.ownerUsername}
        </span>
        {event.likesCount != null && event.likesCount > 0 && (
          <span className="inline-flex items-center gap-1 text-white/90 text-[10px]">
            <Heart className="w-3 h-3" /> {formatCount(event.likesCount)}
          </span>
        )}
        <span className="text-white/70 text-[10px]">
          {formatTimeAgo(event.postTakenAt)}
        </span>
      </div>
    </a>
  );
}

// The gallery holds every detected like, but shows this many until the client
// clicks "Load more" (data is already downloaded — this only reveals it).
const INITIAL_VISIBLE = 10;
const LOAD_MORE_STEP = 12;

function normalizeType(postType: string | undefined): PostTypeFilter | null {
  const t = (postType ?? "").toLowerCase();
  if (t === "photo" || t === "image") return "photo";
  if (t === "video") return "video";
  if (t === "reel") return "reel";
  if (t === "carousel") return "carousel";
  return null;
}

export default function LikedPostsGallery({
  events,
  showTitle = true,
}: LikedPostsGalleryProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<PostTypeFilter>("all");
  const [ageFilter, setAgeFilter] = useState<PostAgeFilter>("all");

  // Surface every detected like, not only those that happen to carry a
  // thumbnail. The free DB cross-reference records real likes whose cached post
  // may lack a display image; GalleryCell renders an unavailable image for those,
  // so filtering them out here silently hid genuine liked-post evidence.
  const likedItems = useMemo(
    () => events.filter((e) => e.eventType === "like"),
    [events],
  );

  const counts = useMemo(() => {
    const c: Partial<Record<PostTypeFilter, number>> = { all: likedItems.length };
    for (const e of likedItems) {
      const key = normalizeType(e.postType);
      if (key) c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [likedItems]);

  // Counts are computed on the full liked set so each bucket always shows how
  // much it holds, independent of the post-type tab currently selected.
  const ageCounts = useMemo(() => {
    const now = Date.now();
    const c: Partial<Record<PostAgeFilter, number>> = { all: likedItems.length };
    for (const key of Object.keys(POST_AGE_DAYS) as Array<
      keyof typeof POST_AGE_DAYS
    >) {
      c[key] = likedItems.filter((e) =>
        isPostWithinDays(e, POST_AGE_DAYS[key], now),
      ).length;
    }
    return c;
  }, [likedItems]);

  const filtered = useMemo(() => {
    const now = Date.now();
    let next = likedItems;
    if (ageFilter !== "all") {
      const days = POST_AGE_DAYS[ageFilter];
      next = next.filter((e) => isPostWithinDays(e, days, now));
    }
    if (filter !== "all") {
      next = next.filter((e) => normalizeType(e.postType) === filter);
    }
    return next;
  }, [likedItems, filter, ageFilter]);

  // Same model as the posts grid: everything is already fetched and cached, but
  // the gallery opens with INITIAL_VISIBLE tiles and reveals the rest only when
  // the client asks. Revealing costs no request — it just un-slices data we hold.
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
  }, [filter, ageFilter, likedItems.length]);

  const items = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="rounded-xl sm:rounded-2xl bg-white border border-slate-200/60 shadow-[0_2px_8px_rgb(0,0,0,0.04)] p-4 sm:p-6"
    >
      <div
        className={`flex flex-col gap-3 mb-4 ${
          showTitle ? "sm:flex-row sm:items-center sm:justify-between" : ""
        }`}
      >
        {showTitle && (
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 font-display">
              {t("likedPosts.title", "Posts liked by this person")}
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-400 tabular-nums">
              {likedItems.length > 0
                ? `${items.length} / ${filtered.length}`
                : t("likedPosts.unavailable", "No liked-post data captured")}
            </p>
          </div>
        )}
        {likedItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <PostAgeFilterTabs
              value={ageFilter}
              onChange={setAgeFilter}
              counts={ageCounts}
            />
            <PostTypeFilterTabs value={filter} onChange={setFilter} counts={counts} />
          </div>
        )}
      </div>

      {likedItems.length === 0 ? (
        <div className="py-10 text-center">
          <Heart className="mx-auto mb-3 h-7 w-7 text-slate-300" />
          <p className="text-sm font-medium text-slate-500">
            {t("likedPosts.noDataTitle", "Liked-post history is not available yet.")}
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">
            {t(
              "likedPosts.noDataHint",
              "Instagram does not expose liked-post history for public profiles. We'll show this here if an authorized source captures that activity.",
            )}
          </p>
        </div>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">
          {t("likedPosts.empty", "No liked posts matching this filter.")}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
            {items.map((event) => (
              <GalleryCell key={event.id} event={event} />
            ))}
          </div>
          {hasMore && (
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={() => setVisibleCount((v) => v + LOAD_MORE_STEP)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200/60 bg-slate-50 px-5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100"
              >
                {t("likedPosts.loadMore", "Load more")}
              </button>
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}
