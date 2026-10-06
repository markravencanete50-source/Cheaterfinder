import { useTranslation } from "react-i18next";

/**
 * Age buckets for the liked-post gallery.
 *
 * Deliberately keyed on when the POST was published (`postTakenAt`), not on
 * when we detected the like. Detection time is an artefact of our scan
 * cadence — a post published in January can be detected today and would then
 * look "new" under a detection-time filter. The question a customer is asking
 * here is "what recent content is this person liking", which is a property of
 * the post.
 */
export type PostAgeFilter = "all" | "7d" | "30d" | "90d";

export const POST_AGE_DAYS: Record<Exclude<PostAgeFilter, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const TABS: PostAgeFilter[] = ["all", "7d", "30d", "90d"];

interface PostAgeFilterTabsProps {
  value: PostAgeFilter;
  onChange: (value: PostAgeFilter) => void;
  counts?: Partial<Record<PostAgeFilter, number>>;
}

export default function PostAgeFilterTabs({
  value,
  onChange,
  counts,
}: PostAgeFilterTabsProps) {
  const { t } = useTranslation();

  const labels: Record<PostAgeFilter, string> = {
    all: t("postAge.all", "All time"),
    "7d": t("postAge.7d", "7 days"),
    "30d": t("postAge.30d", "30 days"),
    "90d": t("postAge.90d", "90 days"),
  };

  return (
    <div
      role="tablist"
      aria-label={t("postAge.filter", "Filter by post date")}
      className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-slate-200/60 bg-slate-50 p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab) => {
        const active = value === tab;
        const count = counts?.[tab];
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
            {typeof count === "number" ? (
              <span
                className={`ml-1.5 tabular-nums ${
                  active ? "text-slate-400" : "text-slate-300"
                }`}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
