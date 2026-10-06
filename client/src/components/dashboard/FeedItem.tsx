import { Heart, UserPlus, EyeOff, PlaySquare, Image, LayoutGrid, MessageCircle, Eye, MapPin } from "lucide-react";
import { useTranslation } from "react-i18next";
import MediaImage from "@/components/MediaImage";
import { ActivityEvent } from "./types";

function formatCount(n: number | undefined): string {
  if (n === null || n === undefined) return "—";
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return n.toString();
}

interface FeedItemProps {
  event: ActivityEvent;
}

// NOTE: This helper is intentionally duplicated (with a different output format)
// in LikedPostsGallery.tsx. The two cannot be hoisted into a shared module here
// without creating a new file outside the allowed edit scope — see task report.
export function formatEventTime(detectedAt: string | null | undefined): string {
  if (!detectedAt) return "—";
  const then = new Date(detectedAt).getTime();
  if (Number.isNaN(then)) return "—";

  // Clamp clock skew (then in the future) so we never render negative deltas.
  const diffMs = Math.max(0, Date.now() - then);
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} mins ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  return new Date(then).toLocaleDateString();
}

const POST_TYPE_CONFIG: Record<string, { icon: typeof Image; label: string; color: string }> = {
  reel: { icon: PlaySquare, label: "Reel", color: "bg-purple-50 text-purple-600" },
  video: { icon: PlaySquare, label: "Video", color: "bg-blue-50 text-blue-600" },
  photo: { icon: Image, label: "Photo", color: "bg-sky-50 text-sky-600" },
  carousel: { icon: LayoutGrid, label: "Carousel", color: "bg-indigo-50 text-indigo-600" },
};

function LikeEvent({ event }: FeedItemProps) {
  const { t } = useTranslation();
  const typeKey = (event.postType ?? "photo").toLowerCase();
  const config = POST_TYPE_CONFIG[typeKey] ?? POST_TYPE_CONFIG.photo;
  const TypeIcon = config.icon;

  const content = (
    <div className="flex items-center gap-3 sm:gap-3.5 w-full">
      <MediaImage src={event.thumbnailUrl} fallbackSrc={event.displayUrl}
        alt={`Post by @${event.ownerUsername ?? "unknown"}`}
        className="w-11 h-11 sm:w-12 sm:h-12 rounded-lg shrink-0 border border-slate-100" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-700 truncate">
          {t("dashboard.likedA")} {event.postType ?? "post"} {t("dashboard.by")}{" "}
          <span className="font-semibold text-slate-900">@{event.ownerUsername}</span>
        </p>
        {event.hashtags && event.hashtags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {event.hashtags.slice(0, 4).map((tag) => (
              <span key={tag} className="bg-slate-50 text-slate-500 text-[11px] px-1.5 py-0.5 rounded">
                #{tag}
              </span>
            ))}
          </div>
        )}
        {(event.likesCount || event.commentsCount || event.videoViewCount || event.locationName) && (
          <div className="text-[11px] text-slate-400 flex items-center flex-wrap gap-x-3 gap-y-0.5 mt-1">
            {event.likesCount != null && event.likesCount > 0 && (
              <span className="inline-flex items-center gap-1"><Heart className="w-3 h-3" />{formatCount(event.likesCount)}</span>
            )}
            {event.commentsCount != null && event.commentsCount > 0 && (
              <span className="inline-flex items-center gap-1"><MessageCircle className="w-3 h-3" />{formatCount(event.commentsCount)}</span>
            )}
            {event.videoViewCount != null && event.videoViewCount > 0 && (
              <span className="inline-flex items-center gap-1"><Eye className="w-3 h-3" />{formatCount(event.videoViewCount)}</span>
            )}
            {event.locationName && (
              <span className="inline-flex items-center gap-1 truncate max-w-[140px]"><MapPin className="w-3 h-3 shrink-0" /><span className="truncate">{event.locationName}</span></span>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${config.color}`}>
          <TypeIcon className="w-3 h-3" />
          <span className="hidden sm:inline">{config.label}</span>
        </span>
        <span className="text-[10px] sm:text-[11px] text-slate-400 tabular-nums whitespace-nowrap">{formatEventTime(event.detectedAt)}</span>
      </div>
    </div>
  );

  const wrapCls = "flex items-center gap-3 sm:gap-3.5 px-4 sm:px-5 py-3.5 sm:py-4 hover:bg-slate-50/60 transition-colors duration-150";

  if (event.postUrl) {
    return (
      <a href={event.postUrl} target="_blank" rel="noopener noreferrer" className={wrapCls}>
        {content}
      </a>
    );
  }

  return <div className={wrapCls}>{content}</div>;
}

function FollowEvent({ event }: FeedItemProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 sm:gap-3.5 px-4 sm:px-5 py-3.5 sm:py-4 hover:bg-slate-50/60 transition-colors duration-150">
      <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
        <UserPlus className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-emerald-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-700 truncate">
          {t("dashboard.startedFollowing")} <span className="font-semibold text-slate-900">@{event.followedUsername}</span>
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">
          Follow
        </span>
        <span className="text-[10px] sm:text-[11px] text-slate-400 tabular-nums whitespace-nowrap">{formatEventTime(event.detectedAt)}</span>
      </div>
    </div>
  );
}

function UnfollowEvent({ event }: FeedItemProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 sm:gap-3.5 px-4 sm:px-5 py-3.5 sm:py-4 hover:bg-slate-50/60 transition-colors duration-150">
      <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-amber-50 flex items-center justify-center shrink-0">
        <EyeOff className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-amber-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-700 truncate">
          {t("dashboard.unfollowed")} <span className="font-semibold text-slate-900">@{event.unfollowedUsername}</span>
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">
          Unfollow
        </span>
        <span className="text-[10px] sm:text-[11px] text-slate-400 tabular-nums whitespace-nowrap">{formatEventTime(event.detectedAt)}</span>
      </div>
    </div>
  );
}

export function FeedItem({ event }: FeedItemProps) {
  switch (event.eventType) {
    case "like":
      return <LikeEvent event={event} />;
    case "follow":
      return <FollowEvent event={event} />;
    case "unfollow":
      return <UnfollowEvent event={event} />;
    default:
      return null;
  }
}
