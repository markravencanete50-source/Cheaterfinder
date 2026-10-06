import { useMemo } from "react";
import { motion } from "framer-motion";
import { ActivityEvent } from "./types";

interface TopInteractionsProps {
  events: ActivityEvent[];
}

function TopInteractions({ events }: TopInteractionsProps) {
  const leaderboard = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      if (e.eventType === "like" && e.ownerUsername) {
        counts.set(e.ownerUsername, (counts.get(e.ownerUsername) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([username, count]) => ({ username, count }));
  }, [events]);

  if (leaderboard.length === 0) return null;

  const maxCount = leaderboard[0].count;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="rounded-xl sm:rounded-2xl bg-white border border-slate-200/60 shadow-[0_2px_8px_rgb(0,0,0,0.04)] p-4 sm:p-6"
    >
      <h3 className="text-sm font-semibold text-slate-900 font-display mb-3 sm:mb-4">
        Top Accounts
      </h3>

      <div className="space-y-0.5">
        {leaderboard.map(({ username, count }, i) => {
          const rank = i + 1;
          const pct = (count / maxCount) * 100;
          const isTop3 = rank <= 3;

          return (
            <div
              key={username}
              className="flex items-center gap-2 sm:gap-3 min-h-[44px] py-2 px-1.5 rounded-lg hover:bg-slate-50/60 transition-colors duration-150"
            >
              <span className={`w-5 text-center text-xs tabular-nums shrink-0 ${isTop3 ? "font-semibold text-slate-700" : "text-slate-400"}`}>
                {rank}
              </span>

              <span className="text-sm font-medium text-slate-700 truncate w-20 sm:w-28">
                @{username}
              </span>

              <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden min-w-[40px]">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    isTop3
                      ? "bg-primary/60"
                      : "bg-slate-200"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>

              <span className="text-xs text-slate-400 tabular-nums w-8 text-right shrink-0">
                {count}
              </span>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

export default TopInteractions;
