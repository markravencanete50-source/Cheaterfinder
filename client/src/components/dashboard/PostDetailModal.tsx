import { useEffect, useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  Heart,
  MessageCircle,
  Eye,
  Play,
  ExternalLink,
  Image as ImageIcon,
  LayoutGrid,
  Film,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { proxyUrl } from "@/lib/img-proxy";
import MediaImage from "@/components/MediaImage";
import type { ViewerRecentPost } from "./types";

interface PostDetailModalProps {
  post: ViewerRecentPost | null;
  onClose: () => void;
  /** Explicit scoped API for hosts such as the admin's cached-only viewer. */
  engagementBasePath?: string;
}

interface PostWithViews extends ViewerRecentPost {
  videoViewCount?: number | null;
}

interface LikerItem {
  username: string;
  displayName?: string | null;
  pfpUrl?: string | null;
  isVerified?: boolean;
}

interface CommentItem {
  author: string;
  displayName?: string | null;
  pfpUrl?: string | null;
  text: string;
  likeCount?: number | null;
  createdAt?: string | null;
}

interface LikersResponse {
  items: LikerItem[];
  total: number;
  expectedTotal?: number;
  isPartial?: boolean;
}

interface CommentsResponse {
  items: CommentItem[];
  total: number;
  expectedTotal?: number;
  isPartial?: boolean;
}

type TabKey = "likes" | "comments";

const STALE_MS = 60_000;

function formatCount(n: number | undefined | null): string {
  if (n === null || n === undefined) return "—";
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

function postTypeLabel(postType: string, t: TFunction): string {
  const lower = postType.toLowerCase();
  if (lower === "reel") return t("postTypes.reel", "Reel");
  if (lower === "video") return t("postTypes.video", "Video");
  if (lower === "carousel") return t("postTypes.carousel", "Carousel");
  return t("postTypes.photo", "Photo");
}

function badgeIcon(postType: string) {
  const lower = postType.toLowerCase();
  if (lower === "reel") return Film;
  if (lower === "video") return Play;
  if (lower === "carousel") return LayoutGrid;
  return ImageIcon;
}

function isPlayable(postType: string): boolean {
  const lower = postType.toLowerCase();
  return lower === "reel" || lower === "video";
}

function safeFormatDate(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return format(date, "MMM d, yyyy 'at' h:mm a");
  } catch {
    return date.toLocaleString();
  }
}

function safeRelative(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return formatDistanceToNowStrict(date, { addSuffix: true });
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

function igProfileUrl(username: string): string {
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

function AvatarFallback({ username }: { username: string }) {
  const initial = username?.[0]?.toUpperCase() ?? "?";
  return (
    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-xs font-semibold text-slate-600">
      {initial}
    </div>
  );
}

function PersonAvatar({
  src,
  username,
  linked = false,
}: {
  src?: string | null;
  username: string;
  linked?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  const image =
    src && !failed ? (
      <img
        src={proxyUrl(src)}
        alt=""
        className="h-9 w-9 flex-shrink-0 rounded-full bg-slate-100 object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    ) : (
      <AvatarFallback username={username} />
    );

  if (!linked) return image;
  return (
    <a
      href={igProfileUrl(username)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex-shrink-0"
      aria-label={`@${username}`}
    >
      {image}
    </a>
  );
}

function PostMediaImage({
  src,
  fallbackSrc,
  alt,
  className = "h-full w-full object-contain",
  onRatio,
}: {
  src: string;
  fallbackSrc?: string;
  alt: string;
  className?: string;
  onRatio?: (ratio: number) => void;
}) {
  return (
    <MediaImage
      src={src}
      fallbackSrc={fallbackSrc}
      alt={alt}
      onLoad={(e) => {
        const { naturalWidth, naturalHeight } = e.currentTarget;
        if (naturalWidth > 0 && naturalHeight > 0) {
          onRatio?.(naturalWidth / naturalHeight);
        }
      }}
      /*
       * object-contain (matching the <video> branch) now that the media column
       * stretches to the full modal height — object-cover would crop portrait
       * and landscape posts hard against a 512px-wide, ~810px-tall box.
       *
       * Carousels override this with intrinsic sizing (max-h/max-w, no
       * h-full/w-full) so the element box hugs the photo instead of the band,
       * which is what lets the overlays anchor to the photo's real edges.
       */
      className="h-full w-full bg-slate-900"
      imageClassName={className}
    />
  );
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5"
      aria-hidden="true"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="h-9 w-9 flex-shrink-0 animate-pulse rounded-full bg-slate-200" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-1/3 animate-pulse rounded bg-slate-200" />
        <div className="h-2.5 w-1/2 animate-pulse rounded bg-slate-100" />
      </div>
    </div>
  );
}

function ListErrorState({
  onRetry,
  failedLabel,
  retryLabel,
}: {
  onRetry: () => void;
  failedLabel: string;
  retryLabel: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <AlertCircle className="h-6 w-6 text-amber-500" aria-hidden="true" />
      <p className="text-xs text-slate-500">{failedLabel}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {retryLabel}
      </button>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center px-4 py-10 text-center text-xs text-slate-400">
      {message}
    </div>
  );
}

function LikerRow({ liker }: { liker: LikerItem }) {
  const username = liker.username || "";
  return (
    <a
      href={igProfileUrl(username)}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <PersonAvatar src={liker.pfpUrl} username={username} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-slate-900 group-hover:underline">
            @{username}
          </span>
          {liker.isVerified && (
            <span
              aria-label="verified"
              className="inline-block h-3.5 w-3.5 flex-shrink-0 rounded-full bg-sky-500 text-[8px] font-bold leading-[14px] text-white"
            >
              ✓
            </span>
          )}
        </div>
        {liker.displayName && (
          <div className="truncate text-xs text-slate-500">
            {liker.displayName}
          </div>
        )}
      </div>
    </a>
  );
}

function CommentRow({ comment }: { comment: CommentItem }) {
  const author = comment.author || "";
  const relative = safeRelative(comment.createdAt);
  return (
    <div className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-slate-50">
      <PersonAvatar src={comment.pfpUrl} username={author} linked />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <a
            href={igProfileUrl(author)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-slate-900 hover:underline"
          >
            @{author}
          </a>
          {comment.displayName && (
            <span className="truncate text-xs text-slate-500">
              {comment.displayName}
            </span>
          )}
          {relative && (
            <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">
              {relative}
            </span>
          )}
        </div>
        <p className="mt-0.5 whitespace-pre-line break-words text-sm leading-relaxed text-slate-700">
          {comment.text}
        </p>
        {typeof comment.likeCount === "number" && comment.likeCount > 0 && (
          <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-600">
            <Heart className="h-2.5 w-2.5 fill-rose-500 text-rose-500" />
            {formatCount(comment.likeCount)}
          </div>
        )}
      </div>
    </div>
  );
}

function EngagementCoverage({ kind, shown, expectedTotal, expectedCount, isPartial }: {
  kind: "likes" | "comments";
  shown: number;
  expectedTotal?: number;
  expectedCount: number;
  isPartial?: boolean;
}) {
  const { t } = useTranslation();
  const expected = typeof expectedTotal === "number" && Number.isFinite(expectedTotal) && expectedTotal >= 0
    ? expectedTotal : Number.isFinite(expectedCount) && expectedCount > 0 ? expectedCount : null;
  if (!isPartial && (expected === null || shown >= expected)) return null;
  const message = expected !== null && expected > shown
    ? kind === "likes"
      ? t("ownPosts.partialLikesCount", "Showing {{shown}} saved likes of {{expected}} reported. This list is incomplete.", { shown, expected })
      : t("ownPosts.partialCommentsCount", "Showing {{shown}} saved comments of {{expected}} reported. This list is incomplete.", { shown, expected })
    : kind === "likes"
      ? t("ownPosts.partialLikes", "Showing {{shown}} saved likes. This list is incomplete.", { shown })
      : t("ownPosts.partialComments", "Showing {{shown}} saved comments. This list is incomplete.", { shown });
  return <p role="status" className="mx-1 mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{message}</p>;
}

function LikersTabContent({
  shortcode,
  expectedCount,
  engagementBasePath,
}: {
  shortcode: string;
  expectedCount: number;
  engagementBasePath?: string;
}) {
  const { t } = useTranslation();
  const query = useQuery<LikersResponse>({
    queryKey: ["post-likers", engagementBasePath ?? "/api/tracking/posts", shortcode],
    queryFn: ({ signal }) =>
      fetchJson<LikersResponse>(
        `${engagementBasePath ?? "/api/tracking/posts"}/${encodeURIComponent(shortcode)}/likers${engagementBasePath ? "" : "?refresh=true"}`, signal,
      ),
    staleTime: STALE_MS,
  });

  if (query.isLoading) {
    return (
      <div className="space-y-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonRow key={i} index={i} />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <ListErrorState
        onRetry={() => query.refetch()}
        failedLabel={t("ownPosts.loadFailed", "Could not load — try again")}
        retryLabel={t("ownPosts.loadRetry", "Retry")}
      />
    );
  }

  const items = query.data?.items ?? [];
  return <>
    <EngagementCoverage kind="likes" shown={items.length} expectedCount={expectedCount}
      expectedTotal={query.data?.expectedTotal} isPartial={query.data?.isPartial} />
    {items.length === 0 ? (
      <EmptyState
        message={
          t("ownPosts.noLikeDetails", "No liker details have been captured yet.")
        }
      />
    ) : (
    <div className="space-y-0.5">
      {items.map((liker) => (
        <LikerRow key={liker.username} liker={liker} />
      ))}
    </div>
    )}
  </>;
}

function CommentsTabContent({
  shortcode,
  expectedCount,
  engagementBasePath,
}: {
  shortcode: string;
  expectedCount: number;
  engagementBasePath?: string;
}) {
  const { t } = useTranslation();
  const query = useQuery<CommentsResponse>({
    queryKey: ["post-comments", engagementBasePath ?? "/api/tracking/posts", shortcode],
    queryFn: ({ signal }) =>
      fetchJson<CommentsResponse>(
        `${engagementBasePath ?? "/api/tracking/posts"}/${encodeURIComponent(shortcode)}/comments${engagementBasePath ? "" : "?refresh=true"}`, signal,
      ),
    staleTime: STALE_MS,
  });

  if (query.isLoading) {
    return (
      <div className="space-y-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonRow key={i} index={i} />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <ListErrorState
        onRetry={() => query.refetch()}
        failedLabel={t("ownPosts.loadFailed", "Could not load — try again")}
        retryLabel={t("ownPosts.loadRetry", "Retry")}
      />
    );
  }

  const items = query.data?.items ?? [];
  return <>
    <EngagementCoverage kind="comments" shown={items.length} expectedCount={expectedCount}
      expectedTotal={query.data?.expectedTotal} isPartial={query.data?.isPartial} />
    {items.length === 0 ? (
      <EmptyState
        message={
          t("ownPosts.noCommentDetails", "No comment details have been captured yet.")
        }
      />
    ) : (
    <div className="space-y-0.5">
      {items.map((comment, idx) => (
        <CommentRow key={`${comment.author}-${idx}`} comment={comment} />
      ))}
    </div>
    )}
  </>;
}

export default function PostDetailModal({ post, onClose, engagementBasePath }: PostDetailModalProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabKey>("likes");
  const [carouselIndex, setCarouselIndex] = useState(0);
  /*
   * Aspect ratio of whatever media is on screen — a carousel child or the
   * single photo/video. The media box is sized to this so it hugs the picture
   * exactly. Two things depend on that: the carousel's counter, arrows and
   * dots anchor to the photo's real edges rather than floating out in a
   * letterbox bar, and the picture itself is free to draw as large as the band
   * allows instead of being squeezed by object-contain.
   *
   * 1 (square) is the opening assumption — Instagram's most common crop — and
   * it is corrected the moment the media reports its size. Deliberately NOT
   * reset between carousel slides: holding the previous ratio until the next
   * one loads avoids a snap through square on every swipe.
   */
  const [mediaRatio, setMediaRatio] = useState(1);
  /*
   * Phone-only: shrink the photo to a thumbnail strip so the likers/comments
   * list — the reason this pane is open — gets the height back. Collapsing to
   * a strip rather than hiding the media outright keeps the "which post am I
   * looking at?" context while scrolling a long list.
   *
   * Irrelevant on md+, where media and list are side-by-side columns and the
   * list is already full height; the toggle is hidden there.
   */
  const [mediaCollapsed, setMediaCollapsed] = useState(false);

  // Carousel children (non-empty array → render as a navigable carousel).
  const carousel = useMemo(() => {
    const media = post?.carouselMedia;
    return Array.isArray(media) && media.length > 0 ? media : null;
  }, [post?.carouselMedia]);
  const carouselCount = carousel?.length ?? 0;
  const hasCarousel = carouselCount > 1;
  const safeIndex = carousel
    ? Math.min(carouselIndex, carouselCount - 1)
    : 0;

  // ESC to close + arrow keys for carousel + body scroll lock.
  useEffect(() => {
    if (!post) return;

    const onKey = (event: KeyboardEvent) => {
      if (!hasCarousel) return;
      if (event.key === "ArrowLeft") {
        setCarouselIndex((i) => Math.max(0, i - 1));
      } else if (event.key === "ArrowRight") {
        setCarouselIndex((i) => Math.min(carouselCount - 1, i + 1));
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [post, onClose, hasCarousel, carouselCount]);

  // Reset to "likes" tab + carousel start whenever a new post is opened.
  useEffect(() => {
    if (post) {
      setActiveTab("likes");
      setCarouselIndex(0);
      setMediaRatio(1);
      setMediaCollapsed(false);
    }
  }, [post?.shortcode]);

  const igUrl = post ? `https://www.instagram.com/p/${post.shortcode}/` : "";
  const videoViewCount = useMemo<number | null>(() => {
    if (!post) return null;
    const extended = post as PostWithViews;
    const value = extended.videoViewCount;
    return typeof value === "number" && value > 0 ? value : null;
  }, [post]);

  const postedOn = post ? safeFormatDate(post.takenAt) : null;
  const Icon = post ? badgeIcon(post.postType) : ImageIcon;
  const playable = post && !post.trialPreview ? isPlayable(post.postType) : false;
  const likeCount = post?.likeCount ?? 0;
  const commentCount = post?.commentCount ?? 0;
  const videoUrl = post?.videoUrl ? proxyUrl(post.videoUrl) : null;
  const previewUrl = post ? proxyUrl(post.displayUrl?.trim() || post.thumbnailUrl) : "";

  /*
   * Source for the ambient backdrop behind the media. Follows the carousel to
   * whichever child is showing, so the surround recolours as you swipe.
   * Already-loaded bytes in every case — no extra request.
   */
  const backdropUrl = useMemo(() => {
    const child = carousel?.[safeIndex];
    return child?.displayUrl ? proxyUrl(child.displayUrl) : previewUrl;
  }, [carousel, safeIndex, previewUrl]);

  /*
   * Expanded, media is letterboxed (object-contain) so nothing is cropped.
   * Collapsed, it is cropped to fill the strip instead: at 64px tall a
   * contained 9:16 reel draws a ~36px slither marooned in a wide dark band,
   * which reads as broken rather than collapsed. A filled strip reads as a
   * deliberate banner, and cropping costs nothing when the photo is one tap
   * away from full size.
   */
  const mediaFitClass = mediaCollapsed
    ? "h-full w-full object-cover"
    : "h-full w-full object-contain";

  if (typeof document === "undefined") return null;

  return <DialogPrimitive.Root open={Boolean(post)} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPrimitive.Portal forceMount>
    <AnimatePresence>
      {post && (
        <DialogPrimitive.Content asChild aria-describedby={undefined}>
        <motion.div
          key="post-detail-modal"
          className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          aria-modal="true"
          role="dialog"
          aria-label={postTypeLabel(post.postType, t)}
        >
          <DialogPrimitive.Title className="sr-only">{postTypeLabel(post.postType, t)}</DialogPrimitive.Title>
          {/* Backdrop */}
          <motion.button
            type="button"
            aria-label={t("ownPosts.modalClose", "Close")}
            onClick={onClose}
            className="absolute inset-0 h-full w-full cursor-default bg-black/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          />

          {/* Modal */}
          <motion.div
            /*
             * h-[90vh] (not max-h) is deliberate: the panel must have a
             * DEFINITE height so the likers/comments list below can claim the
             * leftover space. With only a max-height the modal collapsed to the
             * media column's intrinsic size (~512px), leaving the list ~284px
             * — about five rows — and far fewer on short laptop screens.
             *
             * Phones get 92vh: stacked, every pixel the panel gives up comes
             * straight out of the likers/comments list, which is the payload.
             */
            className="relative z-10 flex h-[92vh] w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-2xl md:h-[90vh]"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {/*
              * Stacked (mobile): media takes its natural capped height, the
              * detail pane takes every remaining pixel (1fr) so the list stays
              * usable. Side-by-side (md+): two full-height columns.
              */}
            <div className="grid h-full w-full grid-rows-[auto_minmax(0,1fr)] md:grid-cols-2 md:grid-rows-1">
              {/* Left: media */}
              {/*
                * Stacked layout gives the media at most 30vh: the whole point
                * of this pane is the liker/commenter list, and a square hero on
                * a phone would starve it back down to a couple of rows.
                */}
              {/*
                * Stacked layout: a FIXED band, not aspect-square. Pairing
                * aspect-square with a height cap also shrinks the width (the
                * ratio wins), leaving dead space beside the media. object-contain
                * letterboxes against the dark surface instead.
                *
                * 30vh is a deliberate middle setting. Because the media is
                * object-contain in a band far wider than it is tall, band
                * HEIGHT is what governs how wide a square or portrait photo
                * can draw — at 20vh a 1:1 post rendered ~133px wide inside a
                * 351px band, i.e. mostly empty bar. 30vh buys back that width
                * while still leaving the likers/comments list its room.
                */}
              {/*
                * Collapsed height is a fixed 4rem strip rather than a vh
                * fraction: it is a context marker, not a viewing size, and it
                * should hand back the same amount of list on a tall phone as a
                * short one. Both states are definite heights, so the height
                * transition animates instead of snapping. md:h-full wins on
                * desktop in both states — the toggle never applies there.
                */}
              <div
                className={`relative flex w-full items-center justify-center overflow-hidden bg-slate-900 transition-[height] duration-300 ease-out md:h-full ${
                  mediaCollapsed ? "h-16" : "h-[30vh]"
                }`}
              >
                {/*
                  * Ambient backdrop. A square or portrait post cannot draw any
                  * wider than the band is tall, so it is always flanked by
                  * surround — a 9:16 reel leaves ~254px of it. Making that
                  * surround an over-scaled blur of the picture itself turns two
                  * dead black bars into a frame that belongs to the photo. It
                  * changes no geometry: the picture is the same size either
                  * way, it just stops looking broken.
                  *
                  * Decorative only (alt="" + aria-hidden), and it reuses bytes
                  * the browser has already fetched for the media itself.
                  */}
                {!mediaCollapsed && backdropUrl && (
                  <img
                    src={backdropUrl}
                    alt=""
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-50 blur-2xl"
                  />
                )}
                {carousel ? (
                  /*
                   * Overlays live INSIDE this box, not in the band. Sizing it
                   * to the media's own aspect ratio (height first, clamped by
                   * max-w) makes it the largest box of that shape that fits —
                   * so its edges ARE the picture's edges. Anchored to the band
                   * instead, the counter and arrows sat out in the letterbox
                   * bars, ~110px from the photo on a square post, which is what
                   * made them read as cropped and unaligned.
                   */
                  <div
                    className={`relative flex items-center justify-center ${
                      mediaCollapsed
                        ? "h-full w-full"
                        : "h-full max-h-full w-auto max-w-full"
                    }`}
                    /* Collapsed, the box spans the strip instead of hugging the
                       photo's shape — there is no overlay left to align to. */
                    style={mediaCollapsed ? undefined : { aspectRatio: mediaRatio }}
                  >
                    {(() => {
                      const child = carousel[safeIndex];
                      if (!post.trialPreview && !child.trialPreview && child.type === "video" && child.videoUrl) {
                        return (
                          <video
                            key={`${post.shortcode}-${safeIndex}`}
                            src={proxyUrl(child.videoUrl)}
                            controls
                            playsInline
                            onLoadedMetadata={(e) => {
                              const { videoWidth, videoHeight } = e.currentTarget;
                              if (videoWidth > 0 && videoHeight > 0) {
                                setMediaRatio(videoWidth / videoHeight);
                              }
                            }}
                            className={mediaFitClass}
                          />
                        );
                      }
                      return (
                        <PostMediaImage
                          key={`${post.shortcode}-${safeIndex}`}
                          src={child.displayUrl}
                          alt={
                            post.caption?.slice(0, 80) ??
                            postTypeLabel(post.postType, t)
                          }
                          className={mediaFitClass}
                          onRatio={setMediaRatio}
                        />
                      );
                    })()}

                    {/* Counter pill (top-left) */}
                    {/*
                      * All the carousel chrome below is suppressed while
                      * collapsed: inside a 64px strip the counter, arrows and
                      * dots would overlap each other and bury the thumbnail.
                      * Arrow-key navigation still works.
                      */}
                    {!mediaCollapsed && (
                      <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/40 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur">
                        {safeIndex + 1}/{carouselCount}
                      </div>
                    )}

                    {/* Prev */}
                    {!mediaCollapsed && safeIndex > 0 && (
                      <button
                        type="button"
                        aria-label={t("ownPosts.carouselPrev", "Previous")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCarouselIndex((i) => Math.max(0, i - 1));
                        }}
                        className="absolute left-3 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                      >
                        <ChevronLeft className="h-5 w-5" />
                      </button>
                    )}

                    {/* Next */}
                    {!mediaCollapsed && safeIndex < carouselCount - 1 && (
                      <button
                        type="button"
                        aria-label={t("ownPosts.carouselNext", "Next")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCarouselIndex((i) =>
                            Math.min(carouselCount - 1, i + 1),
                          );
                        }}
                        className="absolute right-3 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur transition-colors hover:bg-black/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                      >
                        <ChevronRight className="h-5 w-5" />
                      </button>
                    )}

                    {/* Dot indicators (bottom-center) */}
                    {/*
                      * Carried in the same black/40 pill the counter uses:
                      * bare white dots disappeared against light photos, and
                      * now that they sit ON the picture rather than on the
                      * dark bar below it they need their own ground.
                      */}
                    {!mediaCollapsed && carouselCount > 1 && (
                      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex items-center justify-center">
                        <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-2 py-1 backdrop-blur">
                          {carousel.map((_, i) => (
                            <span
                              key={i}
                              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                                i === safeIndex ? "bg-white" : "bg-white/40"
                              }`}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : playable && videoUrl ? (
                  /*
                   * No ratio-fitted box here, unlike the carousel branch. That
                   * box exists to give the counter/arrows/dots the photo's real
                   * edges to anchor to; it does not change how large the media
                   * draws. object-contain in a band already yields exactly the
                   * same rectangle at every aspect ratio, so wrapping single
                   * media in one would be dead weight. The dark surround is
                   * softened by the ambient backdrop above instead.
                   */
                  <video
                    src={videoUrl}
                    poster={previewUrl}
                    controls
                    autoPlay
                    muted
                    playsInline
                    className={mediaFitClass}
                  />
                ) : (
                  <PostMediaImage
                    src={previewUrl}
                    fallbackSrc={post.thumbnailUrl}
                    alt={post.caption?.slice(0, 80) ?? postTypeLabel(post.postType, t)}
                    className={mediaFitClass}
                  />
                )}

                {/* The play badge is a 64px circle — exactly the height of the
                    collapsed strip, so it would blot out the thumbnail. */}
                {!carousel && playable && !videoUrl && !mediaCollapsed && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 backdrop-blur-md ring-1 ring-white/30">
                      <Play className="h-7 w-7 fill-white text-white" />
                    </div>
                  </div>
                )}
              </div>

              {/* Right: metadata + tabs */}
              <div className="flex min-h-0 flex-col overflow-hidden bg-white md:h-full">
                {/*
                  * The Instagram link lives in the header rather than under the
                  * caption: as its own row it cost ~70px of vertical space
                  * (wrapping on a 512px column), which came straight out of the
                  * liker/comment list below.
                  */}
                <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                    <Icon className="h-3.5 w-3.5" />
                    {postTypeLabel(post.postType, t)}
                  </span>
                  <div className="flex items-center gap-2">
                    {/*
                      * Phone-only (md:hidden). On a stacked phone layout the
                      * photo owns 30vh above a list that only shows four or
                      * five rows; this hands that height to the list and back.
                      * On md+ the two are side-by-side columns, so there is no
                      * height to reclaim and the control would be noise.
                      */}
                    <button
                      type="button"
                      onClick={() => setMediaCollapsed((v) => !v)}
                      aria-expanded={!mediaCollapsed}
                      aria-label={
                        mediaCollapsed
                          ? t("ownPosts.modalExpandMedia", "Expand preview")
                          : t("ownPosts.modalCollapseMedia", "Collapse preview")
                      }
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 md:hidden"
                    >
                      {mediaCollapsed ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronUp className="h-4 w-4" />
                      )}
                    </button>
                    <a
                      href={igUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:bg-primary/90 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2"
                    >
                      <span className="hidden sm:inline">
                        {t("ownPosts.modalViewOnIG", "View on Instagram")}
                      </span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={onClose}
                      aria-label={t("ownPosts.modalClose", "Close")}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/*
                  * Top metadata block (caption / posted / link).
                  * The caption scrolls inside a tight cap: left at the old
                  * max-h-32 a long caption pushed the liker/comment list down
                  * to two or three rows — the caption is context here, the
                  * list is the payload.
                  */}
                <div className="flex-shrink-0 space-y-2 px-5 pb-3 pt-3 md:space-y-3 md:pb-4 md:pt-4">
                  {post.caption && (
                    <p className="max-h-12 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-slate-700 md:max-h-24">
                      {post.caption}
                    </p>
                  )}

                  {videoViewCount !== null && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                      <Eye className="h-3.5 w-3.5 text-emerald-500" />
                      <span className="font-semibold tabular-nums text-slate-700">
                        {formatCount(videoViewCount)}
                      </span>
                      {t("ownPosts.viewsCount", "views")}
                    </span>
                  )}

                  {postedOn && (
                    <span className="block text-xs text-slate-400">
                      {t("ownPosts.postedOn", "Posted on {{date}}", {
                        date: postedOn,
                      })}
                    </span>
                  )}
                </div>

                {/* Tab strip */}
                <div className="flex-shrink-0 border-y border-slate-100 bg-slate-50/60 px-4 py-2 md:px-5 md:py-2.5">
                  <div
                    role="tablist"
                    aria-label={postTypeLabel(post.postType, t)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200/60 bg-white p-1"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === "likes"}
                      onClick={() => setActiveTab("likes")}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                        activeTab === "likes"
                          ? "bg-slate-900 text-white shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      <Heart
                        className={`h-3.5 w-3.5 ${
                          activeTab === "likes"
                            ? "fill-rose-400 text-rose-400"
                            : "text-rose-400"
                        }`}
                      />
                      {t("ownPosts.likesTab", "Likes ({{count}})", {
                        count: likeCount,
                      })}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === "comments"}
                      onClick={() => setActiveTab("comments")}
                      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${
                        activeTab === "comments"
                          ? "bg-slate-900 text-white shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      <MessageCircle
                        className={`h-3.5 w-3.5 ${
                          activeTab === "comments"
                            ? "text-sky-300"
                            : "text-sky-500"
                        }`}
                      />
                      {t("ownPosts.commentsTab", "Comments ({{count}})", {
                        count: commentCount,
                      })}
                    </button>
                  </div>
                </div>

                {/* Tab content (scroll area) */}
                {/*
                  * pb-6 on phones: without it the last row sits 8px off the
                  * panel edge and reads as clipped mid-list rather than ended.
                  */}
                <div
                  className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 pt-2 md:pb-3"
                  role="tabpanel"
                  data-testid={
                    activeTab === "likes" ? "likers-list" : "comments-list"
                  }
                >
                  {activeTab === "likes" ? (
                    <LikersTabContent
                      shortcode={post.shortcode}
                      expectedCount={likeCount}
                      engagementBasePath={engagementBasePath}
                    />
                  ) : (
                    <CommentsTabContent
                      shortcode={post.shortcode}
                      expectedCount={commentCount}
                      engagementBasePath={engagementBasePath}
                    />
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
        </DialogPrimitive.Content>
      )}
    </AnimatePresence>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
