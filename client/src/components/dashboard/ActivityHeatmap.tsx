import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";
import TimezoneSelect from "./TimezoneSelect";

interface ActivityHeatmapProps {
  activityByHour: Array<{ hour: number; count: number }> | null;
  timezone?: string;
  onTimezoneChange?: (value: string) => void;
  resolvedTimezone?: string;
}

const PRIMARY = "url(#barGradient)";
const ACCENT = "url(#barGradientAccent)";

function formatHour(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour > 12 ? `${hour - 12}p` : `${hour}a`;
}

function formatHourLong(hour: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h} ${suffix}`;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { hour: number; count: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const { hour, count } = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-100 bg-white px-3 py-2 text-sm shadow-lg">
      <span className="font-semibold text-slate-900">{count} activities</span>{" "}
      <span className="text-slate-500">at {formatHourLong(hour)}</span>
    </div>
  );
}

function HeatmapSkeleton() {
  return (
    <div className="rounded-2xl border border-slate-200/60 bg-white p-6 shadow-[0_2px_8px_rgb(0,0,0,0.04)]">
      <div className="mb-6 flex items-center gap-3">
        <Skeleton className="h-5 w-36" />
      </div>
      <Skeleton className="h-[250px] w-full rounded-xl" />
    </div>
  );
}

export default function ActivityHeatmap({
  activityByHour,
  timezone,
  onTimezoneChange,
  resolvedTimezone,
}: ActivityHeatmapProps) {
  if (!activityByHour) return <HeatmapSkeleton />;

  const maxCount = Math.max(...activityByHour.map((d) => d.count));
  const peakEntry = activityByHour.find((d) => d.count === maxCount);

  const chartData = activityByHour.map((d) => ({
    ...d,
    label: formatHour(d.hour),
  }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="rounded-xl sm:rounded-2xl border border-slate-200/60 bg-white p-4 sm:p-6 shadow-[0_2px_8px_rgb(0,0,0,0.04)]"
    >
      <div className="mb-4 sm:mb-5 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 font-display">Activity Pattern</h3>
          <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5 truncate">
            When they&apos;re most active
            {resolvedTimezone && (
              <span className="ml-1 text-slate-400">· {resolvedTimezone}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {timezone && onTimezoneChange && (
            <TimezoneSelect
              value={timezone}
              onChange={onTimezoneChange}
              resolvedLabel={resolvedTimezone}
            />
          )}
          {peakEntry && (
            <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full">
              Peak: {formatHourLong(peakEntry.hour)}
            </span>
          )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220} className="sm:!h-[250px]">
        <BarChart data={chartData} barCategoryGap="18%" margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(240 100% 72%)" stopOpacity={0.85} />
              <stop offset="100%" stopColor="hsl(240 100% 64%)" stopOpacity={0.4} />
            </linearGradient>
            <linearGradient id="barGradientAccent" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(340 100% 65%)" stopOpacity={0.95} />
              <stop offset="100%" stopColor="hsl(340 100% 55%)" stopOpacity={0.6} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 11, fill: "#94a3b8" }}
            interval={2}
          />
          <YAxis hide />
          <Tooltip
            content={<CustomTooltip />}
            cursor={{ fill: "hsl(240 100% 64% / 0.06)" }}
          />
          <Bar dataKey="count" radius={[6, 6, 0, 0]}>
            {chartData.map((entry) => (
              <Cell
                key={entry.hour}
                fill={entry.count === maxCount ? ACCENT : PRIMARY}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </motion.div>
  );
}
