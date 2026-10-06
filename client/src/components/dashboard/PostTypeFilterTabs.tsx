import { useTranslation } from "react-i18next";
import type { PostTypeFilter } from "./types";

interface PostTypeFilterTabsProps {
  value: PostTypeFilter;
  onChange: (value: PostTypeFilter) => void;
  counts?: Partial<Record<PostTypeFilter, number>>;
}

const TABS: PostTypeFilter[] = ["all", "photo", "video", "reel", "carousel"];

export default function PostTypeFilterTabs({
  value,
  onChange,
  counts,
}: PostTypeFilterTabsProps) {
  const { t } = useTranslation();

  const labels: Record<PostTypeFilter, string> = {
    all: t("postTypes.all", "All"),
    photo: t("postTypes.photos", "Photos"),
    video: t("postTypes.videos", "Videos"),
    reel: t("postTypes.reels", "Reels"),
    carousel: t("postTypes.carousels", "Carousels"),
  };

  return (
    <div
      role="tablist"
      aria-label={t("postTypes.filter", "Filter by post type")}
      className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-slate-200/60 bg-slate-50 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab) => {
        const active = value === tab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab)}
            className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 sm:px-3 ${
              active
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {labels[tab]}
          </button>
        );
      })}
    </div>
  );
}
