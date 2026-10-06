import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { PlayCircle, X, ChevronLeft, ChevronRight, Loader2, Film } from "lucide-react";
import { useTranslation } from "react-i18next";
import { proxyUrl } from "@/lib/img-proxy";
import MediaImage from "@/components/MediaImage";
import type { ViewerStory, ViewerDataSource } from "./types";

interface StoriesViewerProps {
  stories: ViewerStory[] | undefined;
  dataSource?: ViewerDataSource;
  cachedAt?: string;
  /**
   * True only when a fetch is actually in flight (driven by the parent's
   * real refresh state). When omitted, the component never fabricates a
   * "fetching" spinner — it shows the honest empty state instead.
   */
  isFetching?: boolean;
}

/**
 * Human-readable "x ago" for the moment we last checked Instagram.
 * Used to make the empty state honest instead of pretending to fetch.
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

function formatExpires(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1) return `${hours}h left`;
  const mins = Math.max(1, Math.floor(diff / 60_000));
  return `${mins}m left`;
}

function isVideo(story: ViewerStory): boolean {
  if (story.trialPreview) return false;
  const mt = (story.mediaType || "").toLowerCase();
  return mt === "video" || /\.mp4($|\?)/i.test(story.mediaUrl);
}

function StoryThumb({ story, onClick }: { story: ViewerStory; onClick: () => void }) {
  const video = isVideo(story);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={story.trialPreview === true}
      aria-label={`Open story from ${new Date(story.takenAt).toLocaleString()}`}
      className="group relative shrink-0 w-[104px] flex flex-col items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 rounded-xl"
    >
      <div className="relative h-[140px] w-[92px] overflow-hidden rounded-[18px] bg-slate-100 ring-1 ring-slate-200/80 transition-transform duration-200 group-hover:scale-[1.02]">
        <MediaImage src={story.thumbnailUrl} fallbackSrc={video ? undefined : story.mediaUrl}
          alt="Story preview" className="h-full w-full" fallback={<Film className="h-6 w-6" />} />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
        {video && (
          <span className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm">
            <PlayCircle className="h-3 w-3 text-white" strokeWidth={2.5} />
          </span>
        )}
        <span className="absolute bottom-1.5 left-1.5 right-1.5 truncate rounded-md bg-black/35 px-1.5 py-0.5 text-center text-[10px] font-medium text-white backdrop-blur-sm">
          {story.trialPreview ? "Preview" : formatExpires(story.expiresAt)}
        </span>
      </div>
    </button>
  );
}

function StoryModal({
  stories,
  openId,
  onClose,
  onNavigate,
}: {
  stories: ViewerStory[];
  openId: string;
  onClose: () => void;
  onNavigate: (nextId: string) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [mediaFailed, setMediaFailed] = useState(false);

  // Resolve the live position from the story id, not a frozen array index.
  // If an SSE refresh reorders or drops stories mid-viewing, we follow the
  // same story (or close cleanly when it disappears) instead of jumping.
  const index = stories.findIndex((s) => s.storyId === openId);
  const story = index >= 0 ? stories[index] : undefined;
  const missing = story === undefined;

  useEffect(() => setMediaFailed(false), [story?.storyId, story?.mediaUrl]);

  useEffect(() => {
    // The open story was removed by a refresh — close gracefully.
    if (missing) onClose();
  }, [missing, onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && index > 0) onNavigate(stories[index - 1].storyId);
      if (e.key === "ArrowRight" && index >= 0 && index < stories.length - 1) {
        onNavigate(stories[index + 1].storyId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onClose, onNavigate, stories]);

  if (!story) return null;
  const video = isVideo(story);

  return (
    <DialogPrimitive.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPrimitive.Portal>
    <DialogPrimitive.Content asChild aria-describedby={undefined}>
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Story viewer"
      onClick={onClose}
    >
      <DialogPrimitive.Title className="sr-only">Story viewer</DialogPrimitive.Title>
      <button
        ref={closeButtonRef}
        type="button"
        onClick={onClose}
        aria-label="Close story"
        className="absolute right-5 top-5 z-[61] inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <X className="h-5 w-5" />
      </button>

      {index > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(stories[index - 1].storyId);
          }}
          aria-label="Previous story"
          className="absolute left-5 z-[61] inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      {index < stories.length - 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(stories[index + 1].storyId);
          }}
          aria-label="Next story"
          className="absolute right-5 bottom-5 md:bottom-auto md:right-20 z-[61] inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}

      <motion.div
        key={story.storyId}
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.22 }}
        className="relative aspect-[9/16] max-h-[86vh] w-auto overflow-hidden rounded-2xl bg-black shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {mediaFailed ? (
          <div className="flex h-full w-full items-center justify-center bg-slate-900">
            <Film className="h-10 w-10 text-slate-500" />
          </div>
        ) : video ? (
          <video
            src={proxyUrl(story.mediaUrl)}
            controls
            autoPlay
            playsInline
            onError={() => setMediaFailed(true)}
            className="h-full w-full object-contain"
          />
        ) : (
          <MediaImage src={story.mediaUrl} fallbackSrc={story.thumbnailUrl} alt="Story media"
            loading="eager" className="h-full w-full bg-slate-900" imageClassName="object-contain" />
        )}
        <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between text-[11px] text-white/80">
          <span>{new Date(story.takenAt).toLocaleString()}</span>
          <span className="rounded-full bg-white/10 px-2 py-0.5 backdrop-blur-sm">{formatExpires(story.expiresAt)}</span>
        </div>
      </motion.div>
    </motion.div>
    </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SectionShell({ children }: { children: React.ReactNode }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="rounded-xl sm:rounded-2xl border border-slate-200/60 bg-white p-4 sm:p-5 md:p-6 shadow-[0_2px_8px_rgb(0,0,0,0.04)]"
      aria-label="Stories"
    >
      {children}
    </motion.section>
  );
}

export default function StoriesViewer({ stories, dataSource, cachedAt, isFetching }: StoriesViewerProps) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);

  const activeStories = useMemo(() => {
    if (!stories) return [];
    const now = Date.now();
    // Preview timestamps are deliberately synthetic. Preserve the server's
    // preview rows instead of treating their redacted expiry as real expiry.
    return stories.filter((s) => s.trialPreview || new Date(s.expiresAt).getTime() > now);
  }, [stories]);

  // Honest state model:
  // - `isLoading`: the whole viewer payload hasn't arrived yet → skeleton.
  // - `isFetching`: a refresh is genuinely in flight (parent-driven) → spinner.
  // - everything else with no stories → real empty state (with "last checked").
  const isLoading = stories === undefined || dataSource === undefined;
  const isEmpty = !isLoading && activeStories.length === 0;
  const checkedAgo = lastCheckedAgo(cachedAt);

  return (
    <>
      <SectionShell>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 font-display">
              {t("stories.title", "Active Stories")}
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {t("stories.subtitle", "Disappearing content from the last 24h")}
            </p>
          </div>
          {activeStories.length > 0 && (
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-500 tabular-nums">
              {activeStories.length}
            </span>
          )}
        </div>

        {isLoading || (isEmpty && isFetching) ? (
          <LoadingStrip label={t("stories.fetching", "Fetching fresh stories from Instagram…")} />
        ) : isEmpty ? (
          <div className="py-6 text-center">
            <p className="text-sm text-slate-400">
              {t("stories.cachedEmpty", "No active stories in the collected data.")}
            </p>
            {checkedAgo && (
              <p className="mt-1 text-[11px] text-slate-300 tabular-nums">
                {t("stories.cachedUpdated", "Cached data updated {{ago}}", { ago: checkedAgo })}
              </p>
            )}
          </div>
        ) : (
          <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
            {activeStories.map((story) => (
              <StoryThumb
                key={story.storyId}
                story={story}
                onClick={() => setOpenId(story.storyId)}
              />
            ))}
          </div>
        )}
      </SectionShell>

      <AnimatePresence>
        {openId !== null && (
          <StoryModal
            stories={activeStories}
            openId={openId}
            onClose={() => setOpenId(null)}
            onNavigate={setOpenId}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function LoadingStrip({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-6">
      <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
      <span className="text-sm text-slate-500">{label}</span>
      <div className="ml-auto flex gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-[140px] w-[92px] rounded-[18px] bg-gradient-to-br from-slate-100 to-slate-200"
          />
        ))}
      </div>
    </div>
  );
}
