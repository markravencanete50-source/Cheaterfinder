import { ExternalLink, Heart, MessageCircle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import MediaImage from "@/components/MediaImage";
import { formatRelative, type AdminActivityItem } from "./shared";

interface LikedPostLightboxProps {
  item: AdminActivityItem | null;
  onClose: () => void;
}

/**
 * In-app preview for a liked post in the admin activity feed: the stored
 * thumbnail at full size, owner, type, counts and caption. Instagram stays one
 * explicit link away instead of being where every click lands.
 */
export function LikedPostLightbox({ item, onClose }: LikedPostLightboxProps) {
  const open = Boolean(item && item.eventType === "like");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined} className="w-[calc(100vw-2rem)] max-w-3xl max-h-[calc(100dvh-2rem)] min-w-0 p-0 overflow-hidden bg-white border border-slate-200 rounded-2xl [&>button]:rounded-full [&>button]:bg-white/90 [&>button]:p-2 [&>button]:text-slate-700 [&>button]:opacity-100">
        {item && (
          <div data-testid="liked-post-preview-scroll" className="min-h-0 min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
          <div className="grid min-w-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 bg-slate-950 flex items-center justify-center min-h-[280px] max-h-[80vh]">
              <MediaImage src={item.thumbnailUrl} alt={`Post by @${item.ownerUsername ?? "unknown"}`}
                className="flex min-h-[280px] w-full items-center justify-center bg-slate-950"
                imageClassName="max-h-[80vh] object-contain" loading="eager"
                fallback={<span className="p-8 text-sm text-slate-400">Preview unavailable. The recorded like is still shown.</span>} />
            </div>
            <div className="min-w-0 p-5 flex flex-col gap-3">
              <DialogTitle className="min-w-0 break-words text-base font-semibold text-slate-800 leading-snug">
                @{item.igUsername} liked a post by @{item.ownerUsername ?? "unknown"}
              </DialogTitle>
              <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                {item.postType && (
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 font-bold uppercase tracking-wide">
                    {item.postType}
                  </span>
                )}
                <span>detected {formatRelative(item.detectedAt)}</span>
              </div>
              {(item.likesCount != null || item.commentsCount != null) && (
                <div className="flex items-center gap-4 text-sm text-slate-600 tabular-nums">
                  {item.likesCount != null && (
                    <span className="inline-flex items-center gap-1">
                      <Heart className="w-4 h-4" />
                      {item.likesCount.toLocaleString()}
                    </span>
                  )}
                  {item.commentsCount != null && (
                    <span className="inline-flex items-center gap-1">
                      <MessageCircle className="w-4 h-4" />
                      {item.commentsCount.toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              {item.postTakenAt && (
                <div className="text-xs text-slate-400">
                  posted {new Date(item.postTakenAt).toLocaleString()}
                </div>
              )}
              {item.caption && (
                <p className="min-w-0 text-sm text-slate-700 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                  {item.caption}
                </p>
              )}
              {item.postUrl && (
                <a
                  href={item.postUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
                >
                  Open on Instagram <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
