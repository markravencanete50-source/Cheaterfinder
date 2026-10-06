import { useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Star,
  PlayCircle,
  Image as ImageIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { proxyUrl } from "@/lib/img-proxy";
import type { ViewerHighlight, ViewerHighlightItem } from "./types";

interface HighlightDetailModalProps {
  highlight: ViewerHighlight | null;
  onClose: () => void;
}

function isVideo(item: ViewerHighlightItem): boolean {
  if (item.trialPreview) return false;
  const mt = (item.mediaType || "").toLowerCase();
  if (mt === "video") return true;
  if (mt === "photo") return false;
  return /\.mp4($|\?)/i.test(item.mediaUrl);
}

function safeFormatTaken(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleString();
  } catch {
    return null;
  }
}

function HighlightCoverThumb({ coverUrl }: { coverUrl: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [coverUrl]);

  if (failed || !coverUrl) {
    return (
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-50 to-pink-50 ring-1 ring-slate-200">
        <Star className="h-4 w-4 text-slate-400" />
      </div>
    );
  }

  return (
    <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200">
      <img
        src={proxyUrl(coverUrl)}
        alt=""
        loading="lazy"
        decoding="async"
        width={40}
        height={40}
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function HighlightThumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (failed) {
    return (
      <div className="flex h-full w-full items-center justify-center text-white/40">
        <ImageIcon className="h-4 w-4" />
      </div>
    );
  }
  return (
    <img
      src={proxyUrl(src)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  );
}

function ProgressBar({
  count,
  activeIndex,
}: {
  count: number;
  activeIndex: number;
}) {
  if (count <= 1) return null;
  return (
    <div className="absolute left-3 right-3 top-3 z-10 flex gap-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`h-[2.5px] flex-1 rounded-full transition-colors duration-200 ${
            i === activeIndex
              ? "bg-white"
              : i < activeIndex
                ? "bg-white/70"
                : "bg-white/25"
          }`}
        />
      ))}
    </div>
  );
}

function ItemMedia({ item }: { item: ViewerHighlightItem }) {
  const video = isVideo(item);
  const [failed, setFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  const fallbackUrl =
    item.thumbnailUrl && item.thumbnailUrl !== item.mediaUrl
      ? item.thumbnailUrl
      : null;

  useEffect(() => {
    setFailed(false);
    setFallbackFailed(false);
  }, [item.storyId]);

  if ((!item.mediaUrl || failed) && fallbackUrl && !fallbackFailed) {
    return (
      <img
        key={`${item.storyId}-fallback`}
        src={proxyUrl(fallbackUrl)}
        alt=""
        decoding="async"
        onError={() => setFallbackFailed(true)}
        className="h-full w-full object-contain"
      />
    );
  }

  if (failed || !item.mediaUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-900 text-slate-400">
        <ImageIcon className="h-8 w-8" />
      </div>
    );
  }

  if (video) {
    return (
      <video
        key={item.storyId}
        src={proxyUrl(item.mediaUrl)}
        poster={fallbackUrl ? proxyUrl(fallbackUrl) : undefined}
        controls
        autoPlay
        muted
        playsInline
        onError={() => setFailed(true)}
        className="h-full w-full object-contain"
      />
    );
  }

  return (
    <img
      key={item.storyId}
      src={proxyUrl(item.mediaUrl)}
      alt=""
      decoding="async"
      onError={() => setFailed(true)}
      className="h-full w-full object-contain"
    />
  );
}

function ThumbStrip({
  items,
  activeIndex,
  onSelect,
}: {
  items: ReadonlyArray<ViewerHighlightItem>;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  if (items.length <= 1) return null;
  return (
    <div className="flex w-full gap-2 overflow-x-auto px-1 pb-1 pt-2 [scrollbar-width:thin]">
      {items.map((item, idx) => {
        const active = idx === activeIndex;
        const thumb = item.thumbnailUrl || item.mediaUrl;
        return (
          <button
            key={item.storyId}
            type="button"
            onClick={() => onSelect(idx)}
            aria-label={`Go to item ${idx + 1}`}
            aria-current={active ? "true" : undefined}
            className={`relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-md bg-slate-800 ring-1 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${
              active
                ? "ring-white scale-[1.05]"
                : "ring-white/20 hover:ring-white/50"
            }`}
          >
            {thumb ? (
              <HighlightThumb src={thumb} />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-white/40">
                <ImageIcon className="h-4 w-4" />
              </div>
            )}
            {isVideo(item) && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
                <PlayCircle
                  className="h-3.5 w-3.5 text-white"
                  strokeWidth={2.5}
                />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function EmptyItemsState({ message, hint }: { message: string; hint: string }) {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5 ring-1 ring-white/10">
        <Star className="h-5 w-5 text-white/60" />
      </div>
      <p className="text-sm font-medium text-white/85">{message}</p>
      <p className="max-w-xs text-xs leading-relaxed text-white/45">{hint}</p>
    </div>
  );
}

export default function HighlightDetailModal({
  highlight,
  onClose,
}: HighlightDetailModalProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const items = useMemo<ReadonlyArray<ViewerHighlightItem>>(
    () => highlight?.items ?? [],
    [highlight],
  );
  const hasItems = items.length > 0;

  // Reset to first item whenever a new highlight is opened.
  useEffect(() => {
    setActiveIndex(0);
  }, [highlight?.highlightId]);

  // ESC + arrow keys + body scroll lock + focus management.
  useEffect(() => {
    if (!highlight) return;

    const onKey = (event: KeyboardEvent) => {
      if (!hasItems) return;
      if (event.key === "ArrowLeft") {
        setActiveIndex((prev) => Math.max(0, prev - 1));
      } else if (event.key === "ArrowRight") {
        setActiveIndex((prev) => Math.min(items.length - 1, prev + 1));
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [highlight, onClose, hasItems, items.length]);

  if (typeof document === "undefined") return null;

  const activeItem = hasItems ? items[activeIndex] : null;
  const takenLabel = activeItem ? safeFormatTaken(activeItem.takenAt) : null;
  const canPrev = hasItems && activeIndex > 0;
  const canNext = hasItems && activeIndex < items.length - 1;

  return <DialogPrimitive.Root open={Boolean(highlight)} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPrimitive.Portal forceMount>
    <AnimatePresence>
      {highlight && (
        <DialogPrimitive.Content asChild aria-describedby={undefined}>
        <motion.div
          key="highlight-detail-modal"
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          aria-modal="true"
          role="dialog"
          aria-label={t("highlights.modalLabel", "Highlight: {{title}}", {
            title: highlight.title,
          })}
        >
          <DialogPrimitive.Title className="sr-only">{t("highlights.modalLabel", "Highlight: {{title}}", { title: highlight.title })}</DialogPrimitive.Title>
          {/* Backdrop */}
          <motion.button
            type="button"
            aria-label={t("highlights.modalClose", "Close")}
            onClick={onClose}
            className="absolute inset-0 h-full w-full cursor-default bg-black/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          />

          {/* Modal */}
          <motion.div
            className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-2xl bg-slate-950 shadow-2xl ring-1 ring-white/10"
            style={{ maxHeight: "min(86vh, 820px)" }}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {/* Header */}
            <div className="flex items-center gap-3 border-b border-white/10 bg-slate-900/60 px-4 py-3">
              <HighlightCoverThumb coverUrl={highlight.coverUrl} />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold text-white">
                  {highlight.title}
                </h2>
                <p className="text-[11px] text-white/55 tabular-nums">
                  {hasItems
                    ? t(
                        "highlights.itemPosition",
                        "Item {{current}} of {{total}}",
                        {
                          current: activeIndex + 1,
                          total: items.length,
                        },
                      )
                    : highlight.mediaCount == null ? "—" : t("highlights.itemCountLabel", "{{count}} items", {
                        count: highlight.mediaCount,
                      })}
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={onClose}
                aria-label={t("highlights.modalClose", "Close")}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-white/80 transition-colors hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="relative flex flex-1 flex-col overflow-hidden bg-black">
              <div
                className="relative flex w-full items-center justify-center bg-black"
                style={{ aspectRatio: "9 / 16", maxHeight: "70vh" }}
              >
                {hasItems ? (
                  <>
                    <ProgressBar
                      count={items.length}
                      activeIndex={activeIndex}
                    />

                    {activeItem && <ItemMedia item={activeItem} />}

                    {canPrev && (
                      <button
                        type="button"
                        onClick={() => setActiveIndex((p) => p - 1)}
                        aria-label={t("highlights.prevItem", "Previous item")}
                        className="absolute left-3 top-1/2 z-20 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                    )}
                    {canNext && (
                      <button
                        type="button"
                        onClick={() => setActiveIndex((p) => p + 1)}
                        aria-label={t("highlights.nextItem", "Next item")}
                        className="absolute right-3 top-1/2 z-20 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    )}

                    {takenLabel && (
                      <span className="pointer-events-none absolute bottom-3 left-3 right-3 truncate text-center text-[11px] font-medium text-white/80">
                        {takenLabel}
                      </span>
                    )}
                  </>
                ) : (
                  <EmptyItemsState
                    message={t(
                      "highlights.itemsEmpty",
                      "No story items cached yet",
                    )}
                    hint={t(
                      "highlights.itemsEmptyHint",
                      "We have this collection's cover and metadata, but the individual stories aren't fetched yet. They'll appear here after the next sync.",
                    )}
                  />
                )}
              </div>

              {hasItems && (
                <div className="border-t border-white/10 bg-slate-900/60 px-3">
                  <ThumbStrip
                    items={items}
                    activeIndex={activeIndex}
                    onSelect={setActiveIndex}
                  />
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
        </DialogPrimitive.Content>
      )}
    </AnimatePresence>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
