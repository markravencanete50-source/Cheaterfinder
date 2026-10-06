import { useMemo } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { motion } from "framer-motion";
import { ActivityEvent } from "./types";

interface PostTypeChartProps {
  events: ActivityEvent[];
}

const TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  reel: { label: "Reels", color: "hsl(270 70% 60%)" },
  video: { label: "Videos", color: "hsl(210 90% 55%)" },
  photo: { label: "Photos", color: "hsl(195 85% 50%)" },
  carousel: { label: "Carousels", color: "hsl(240 70% 60%)" },
};

const TYPE_KEYS = Object.keys(TYPE_CONFIG);

interface SlicePayload {
  name: string;
  value: number;
  label: string;
  color: string;
}

function CustomTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: Array<{ payload: SlicePayload }>;
  total: number;
}) {
  if (!active || !payload?.length) return null;
  const { label, value } = payload[0].payload;
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-lg bg-white px-3 py-2 text-sm shadow-lg border border-slate-100">
      <span className="font-medium text-slate-900">
        {label}: {value} ({pct}%)
      </span>
    </div>
  );
}

export default function PostTypeChart({ events }: PostTypeChartProps) {
  const { data, total } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events) {
      if (e.eventType !== "like" || !e.postType) continue;
      const key = e.postType.toLowerCase();
      if (TYPE_KEYS.includes(key)) {
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    const slices: SlicePayload[] = TYPE_KEYS
      .filter((k) => (counts[k] ?? 0) > 0)
      .map((k) => ({
        name: k,
        value: counts[k],
        label: TYPE_CONFIG[k].label,
        color: TYPE_CONFIG[k].color,
      }));
    return {
      data: slices,
      total: slices.reduce((s, d) => s + d.value, 0),
    };
  }, [events]);

  if (total === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="rounded-xl sm:rounded-2xl bg-white border border-slate-200/60 shadow-[0_2px_8px_rgb(0,0,0,0.04)] p-4 sm:p-6"
    >
      <h3 className="text-sm font-semibold text-slate-900 font-display mb-4">Post Types</h3>

      <div className="relative mx-auto aspect-square w-[160px] sm:w-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={3}
              stroke="none"
            >
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip total={total} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-2xl font-bold text-slate-900">{total}</span>
          <span className="text-xs text-slate-400">Posts</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 mt-4">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-2 text-sm">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: d.color }}
            />
            <span className="text-slate-500">{d.label}</span>
            <span className="ml-auto font-medium text-slate-900 tabular-nums">{d.value}</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
