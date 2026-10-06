import { useMemo } from "react";
import {
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from "recharts";
import { motion } from "framer-motion";
import { ActivityEvent } from "./types";

interface CategoryRadarProps {
  events: ActivityEvent[];
}

const CATEGORY_MAP: Record<string, string> = {
  sports: "Sports",
  fitness: "Sports",
  gym: "Sports",
  workout: "Sports",
  travel: "Travel",
  adventure: "Travel",
  nature: "Travel",
  wanderlust: "Travel",
  food: "Food",
  cooking: "Food",
  recipe: "Food",
  foodie: "Food",
  fashion: "Fashion",
  style: "Fashion",
  beauty: "Fashion",
  ootd: "Fashion",
  music: "Creative",
  art: "Creative",
  photography: "Creative",
  design: "Creative",
  tech: "Tech",
  gaming: "Tech",
  code: "Tech",
  developer: "Tech",
  love: "Lifestyle",
  happy: "Lifestyle",
  life: "Lifestyle",
  lifestyle: "Lifestyle",
};

function resolveCategory(tag: string): string {
  const normalized = tag.replace(/^#/, "").toLowerCase();
  return CATEGORY_MAP[normalized] ?? "Other";
}

function CategoryRadar({ events }: CategoryRadarProps) {
  const data = useMemo(() => {
    const counts: Record<string, number> = {};

    for (const event of events) {
      if (event.eventType !== "like" || !event.hashtags?.length) continue;
      const seen = new Set<string>();
      for (const tag of event.hashtags) {
        const category = resolveCategory(tag);
        if (seen.has(category)) continue;
        seen.add(category);
        counts[category] = (counts[category] ?? 0) + 1;
      }
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([category, value]) => ({ category, value }));
  }, [events]);

  if (data.length < 3) return null;

  const maxValue = Math.max(...data.map((d) => d.value));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="rounded-xl sm:rounded-2xl bg-white border border-slate-200/60 shadow-[0_2px_8px_rgb(0,0,0,0.04)] p-4 sm:p-6"
    >
      <h3 className="text-sm font-semibold text-slate-900 font-display mb-3">Interest Radar</h3>

      <div className="aspect-square w-full max-w-[420px] mx-auto">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} cx="50%" cy="50%" outerRadius="72%">
          <PolarGrid gridType="polygon" stroke="#e2e8f0" />
          <PolarAngleAxis
            dataKey="category"
            tick={{ fontSize: 11, fill: "#64748b" }}
          />
          <Radar
            name="Interests"
            dataKey="value"
            stroke="#6366f1"
            fill="#6366f1"
            fillOpacity={0.2}
            dot={{ r: 3, fill: "#6366f1", strokeWidth: 0 }}
          />
        </RadarChart>
      </ResponsiveContainer>
      </div>
    </motion.div>
  );
}

export default CategoryRadar;
