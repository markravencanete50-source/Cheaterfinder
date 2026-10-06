import { Heart, UserPlus, UserMinus, TrendingUp, Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import { ViewerData } from "./types";

interface AnalyticsCardsProps {
  viewerData: ViewerData | null;
}

const cards = [
  {
    key: "likes",
    label: "Weekly Posts",
    icon: Heart,
    iconBg: "bg-pink-50",
    iconColor: "text-pink-500",
    getValue: (d: ViewerData) => d.weeklyStats.totalPosts?.toLocaleString() ?? "—",
  },
  {
    key: "follows",
    label: "Weekly Follows",
    icon: UserPlus,
    iconBg: "bg-emerald-50",
    iconColor: "text-emerald-500",
    getValue: (d: ViewerData) => d.weeklyStats.totalFollows?.toLocaleString() ?? "—",
  },
  {
    key: "unfollows",
    label: "Weekly Unfollows",
    icon: UserMinus,
    iconBg: "bg-amber-50",
    iconColor: "text-amber-500",
    getValue: (d: ViewerData) => d.weeklyStats.totalUnfollows?.toLocaleString() ?? "—",
  },
  {
    key: "niche",
    label: "Top Niche",
    icon: TrendingUp,
    iconBg: "bg-violet-50",
    iconColor: "text-violet-500",
    getValue: (d: ViewerData) =>
      d.topNiche ? d.topNiche.charAt(0).toUpperCase() + d.topNiche.slice(1) : "—",
  },
  {
    key: "peak",
    label: "Peak Hour",
    icon: Clock,
    iconBg: "bg-blue-50",
    iconColor: "text-blue-500",
    getValue: (d: ViewerData) => {
      const h = d.peakActivityHour;
      if (h === null || h === undefined) return "—";
      if (h === 0) return "12 AM";
      if (h === 12) return "12 PM";
      return h > 12 ? `${h - 12} PM` : `${h} AM`;
    },
  },
] as const;

function AnalyticsCardSkeleton() {
  return (
    <div className="rounded-xl sm:rounded-2xl border border-slate-200/60 bg-white p-4 sm:p-5 shadow-[0_2px_8px_rgb(0,0,0,0.04)]">
      <Skeleton className="mb-3 sm:mb-4 h-9 w-9 rounded-xl" />
      <Skeleton className="mb-2 h-6 sm:h-7 w-14 sm:w-16" />
      <Skeleton className="h-3 w-20 sm:w-24" />
    </div>
  );
}

export default function AnalyticsCards({ viewerData }: AnalyticsCardsProps) {
  if (!viewerData) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <AnalyticsCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <motion.div
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.key}
            className="rounded-xl sm:rounded-2xl border border-slate-200/60 bg-white p-4 sm:p-5 shadow-[0_2px_8px_rgb(0,0,0,0.04)] transition-shadow duration-200 hover:shadow-[0_4px_12px_rgb(0,0,0,0.06)]"
          >
            <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${card.iconBg} mb-3 sm:mb-4`}>
              <Icon className={`h-[18px] w-[18px] ${card.iconColor}`} />
            </div>
            <p className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 truncate">
              {card.getValue(viewerData)}
            </p>
            <p className="mt-1 text-[11px] sm:text-xs text-slate-400 font-medium truncate">
              {card.label}
            </p>
          </div>
        );
      })}
    </motion.div>
  );
}
