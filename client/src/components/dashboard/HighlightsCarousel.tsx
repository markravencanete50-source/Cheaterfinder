import { useState } from "react";
import { motion } from "framer-motion";
import { Star, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import MediaImage from "@/components/MediaImage";
import HighlightDetailModal from "./HighlightDetailModal";
import type { ViewerHighlight, ViewerDataSource } from "./types";

interface HighlightsCarouselProps {
  highlights: ViewerHighlight[] | undefined;
  dataSource?: ViewerDataSource;
  cachedAt?: string;
  /**
   * True only when a fetch is actually in flight (parent-driven). When
   * omitted, the component never fabricates a "fetching" spinner — it
   * shows the honest empty state instead.
   */
  isFetching?: boolean;
  /**
   * Optional external open handler. When provided, the carousel delegates
   * to the parent and skips its internal modal. When omitted, clicking a
   * highlight card opens the local in-app HighlightDetailModal.
   */
  onOpenHighlight?: (highlight: ViewerHighlight) => void;
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

function HighlightCover({ highlight }: { highlight: ViewerHighlight }) {
  return <MediaImage src={highlight.coverUrl} alt={`Highlight: ${highlight.title}`}
    className="h-full w-full" fallback={<Star className="h-6 w-6" />} />;
}

function HighlightItem({
  highlight,
  onOpen,
}: {
  highlight: ViewerHighlight;
  onOpen?: (highlight: ViewerHighlight) => void;
}) {
  const interactive = typeof onOpen === "function";
  const baseClass =
    "group flex w-[86px] shrink-0 flex-col items-center gap-2 rounded-lg";
  const interactiveClass =
    "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2";

  const inner = (
    <>
      <div className="relative">
        <div className="rounded-full bg-gradient-to-tr from-amber-300 via-pink-500 to-violet-500 p-[2px] transition-transform duration-200 group-hover:scale-[1.02]">
          <div className="rounded-full border-2 border-white bg-slate-100 p-[1px]">
            <div className="h-[72px] w-[72px] overflow-hidden rounded-full bg-slate-100">
              <HighlightCover highlight={highlight} />
            </div>
          </div>
        </div>
        <span className="absolute -right-0.5 -top-0.5 rounded-full bg-white px-1.5 py-[1px] text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200 tabular-nums">
          {highlight.mediaCount ?? "—"}
        </span>
      </div>
      <span className="w-full truncate text-center text-[11px] font-medium text-slate-700">
        {highlight.title}
      </span>
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        disabled={highlight.trialPreview === true}
        onClick={() => onOpen!(highlight)}
        aria-label={`View highlight details: ${highlight.title}`}
        className={`${baseClass} ${interactiveClass} bg-transparent p-0 text-inherit`}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      aria-label={`Highlight: ${highlight.title}`}
      className={baseClass}
    >
      {inner}
    </div>
  );
}

export default function HighlightsCarousel({
  highlights,
  dataSource,
  cachedAt,
  isFetching,
  onOpenHighlight,
}: HighlightsCarouselProps) {
  const { t } = useTranslation();
  const [selectedHighlight, setSelectedHighlight] =
    useState<ViewerHighlight | null>(null);

  // Honest state model — see StoriesViewer for the same logic:
  // load skeleton until the payload arrives; a real in-flight refresh shows
  // the spinner; otherwise an empty list is the genuine empty state.
  const isLoading = highlights === undefined || dataSource === undefined;
  const isEmpty = !isLoading && (highlights?.length ?? 0) === 0;
  const checkedAgo = lastCheckedAgo(cachedAt);

  // If the parent supplies its own open handler, defer to it. Otherwise we
  // manage the in-app modal locally so highlight cards are clickable by
  // default — never link out to Instagram.
  const handleOpen = (h: ViewerHighlight): void => {
    if (onOpenHighlight) {
      onOpenHighlight(h);
      return;
    }
    setSelectedHighlight(h);
  };

  return (
    <>
      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="rounded-xl sm:rounded-2xl border border-slate-200/60 bg-white p-4 sm:p-5 md:p-6 shadow-[0_2px_8px_rgb(0,0,0,0.04)]"
        aria-label="Highlights"
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 font-display">
              {t("highlights.title", "Highlights")}
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {t("highlights.subtitle", "Curated story collections")}
            </p>
          </div>
          {highlights && highlights.length > 0 && (
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-500 tabular-nums">
              {highlights.length}
            </span>
          )}
        </div>

        {isLoading || (isEmpty && isFetching) ? (
          <LoadingRing label={t("highlights.fetching", "Fetching highlights…")} />
        ) : isEmpty ? (
          <div className="py-6 text-center">
            <p className="text-sm text-slate-400">
              {t("highlights.cachedEmpty", "No highlights in the collected data yet.")}
            </p>
            {checkedAgo && (
              <p className="mt-1 text-[11px] text-slate-300 tabular-nums">
                {t("highlights.cachedUpdated", "Cached data updated {{ago}}", { ago: checkedAgo })}
              </p>
            )}
          </div>
        ) : (
          <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]">
            {highlights!.map((h) => (
              <HighlightItem
                key={h.highlightId}
                highlight={h}
                onOpen={handleOpen}
              />
            ))}
          </div>
        )}
      </motion.section>

      {/* In-app highlight detail modal — rendered once at the carousel
          level, controlled when no external open handler is provided. */}
      {!onOpenHighlight && (
        <HighlightDetailModal
          highlight={selectedHighlight}
          onClose={() => setSelectedHighlight(null)}
        />
      )}
    </>
  );
}

function LoadingRing({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-6">
      <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
      <span className="text-sm text-slate-500">{label}</span>
      <div className="ml-auto flex gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-[72px] w-[72px] rounded-full bg-gradient-to-br from-slate-100 to-slate-200"
          />
        ))}
      </div>
    </div>
  );
}
