import { useMemo } from "react";
import { Hash } from "lucide-react";
import { ActivityEvent } from "./types";

interface InterestTagsProps {
  events: ActivityEvent[];
}

export default function InterestTags({ events }: InterestTagsProps) {
  const topTags = useMemo(() => {
    const counts = new Map<string, number>();

    for (const event of events) {
      if (event.eventType !== "like" || !event.hashtags) continue;
      for (const tag of event.hashtags) {
        const normalized = tag.toLowerCase().replace(/^#/, "");
        if (normalized) {
          counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
        }
      }
    }

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([tag, count]) => ({ tag, count }));
  }, [events]);

  if (topTags.length === 0) return null;

  const maxCount = topTags[0].count;

  return (
    <div className="bg-slate-50/80 rounded-xl p-4 sm:p-5 mx-3 sm:mx-5 mb-4">
      <div className="flex items-center gap-1.5 mb-3">
        <Hash className="h-3.5 w-3.5 text-slate-400" />
        <span className="text-xs font-medium text-slate-500">
          Top Interests
        </span>
        <span className="ml-auto text-[10px] text-slate-400 tabular-nums">{topTags.length} topics</span>
      </div>
      <div className="space-y-1.5">
        {topTags.map(({ tag, count }) => {
          const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
          return (
            <div key={tag} className="flex items-center gap-2 sm:gap-2.5">
              <span className="text-xs font-medium shrink-0 w-20 sm:w-24 truncate text-slate-600">
                #{tag}
              </span>
              <div className="flex-1 h-1.5 bg-slate-200/60 rounded-full overflow-hidden min-w-[32px]">
                <div
                  className="h-full rounded-full bg-primary/50 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-[10px] text-slate-400 tabular-nums font-medium w-6 text-right shrink-0">{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
