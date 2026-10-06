import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import TimezoneSelect from "./TimezoneSelect";
import { ActivityEvent } from "./types";

interface CalendarHeatmapProps {
  events: ActivityEvent[];
  /** Optional server-provided counts keyed by ISO date (respects server tz). */
  activityByDate?: Array<{ date: string; count: number }>;
  timezone?: string;
  onTimezoneChange?: (value: string) => void;
  resolvedTimezone?: string;
}

function getColor(count: number): string {
  if (count === 0) return "bg-slate-100";
  if (count <= 2) return "bg-emerald-200";
  if (count <= 4) return "bg-emerald-400";
  return "bg-emerald-600";
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Build a YYYY-MM-DD key for `date` in the given IANA timezone, matching the
 * server which buckets activity with `Intl.DateTimeFormat("en-CA", { timeZone })`.
 * The "en-CA" locale yields ISO-ordered YYYY-MM-DD output. Without this, keying
 * by `toISOString().slice(0,10)` (UTC) shifts every cell by a day for positive
 * UTC offsets (e.g. Asia/Karachi, UTC+5), so today lands in yesterday's cell.
 */
function makeDateKeyFormatter(timezone?: string): (date: Date) => string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    });
    return (date: Date) => fmt.format(date);
  } catch {
    // Invalid/unsupported timezone — fall back to a local-date key (en-CA on
    // the host timezone) rather than UTC, which is still closer to the user's
    // wall-clock day than toISOString().
    const fallback = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return (date: Date) => fallback.format(date);
  }
}

export default function CalendarHeatmap({
  events,
  activityByDate,
  timezone,
  onTimezoneChange,
  resolvedTimezone,
}: CalendarHeatmapProps) {
  const [hovered, setHovered] = useState<{
    key: string;
    label: string;
    x: number;
    y: number;
  } | null>(null);

  const { grid, months } = useMemo(() => {
    // Key cells by the timezone the server bucketed by, so a click/hover cell
    // and the server's `activityByDate` entries line up on the same calendar
    // day (the user's timezone, not UTC). The dashboard sends `resolvedTz`
    // as the server's `tz` query param, so prefer that to match exactly;
    // fall back to the selected timezone when resolved is absent.
    const dateKey = makeDateKeyFormatter(resolvedTimezone ?? timezone);

    const countByDate = new Map<string, number>();
    if (activityByDate && activityByDate.length > 0) {
      for (const row of activityByDate) {
        countByDate.set(row.date, (countByDate.get(row.date) ?? 0) + row.count);
      }
    } else {
      for (const e of events) {
        // e.detectedAt is an ISO timestamp; bucket it by the same tz formatter
        // instead of slicing the UTC date prefix.
        const key = dateKey(new Date(e.detectedAt));
        countByDate.set(key, (countByDate.get(key) ?? 0) + 1);
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const totalDays = 84;
    const start = new Date(today);
    start.setDate(start.getDate() - totalDays + 1);

    const dayOfWeek = start.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    start.setDate(start.getDate() + mondayOffset);

    const days: { date: Date; key: string; count: number }[] = [];
    const cursor = new Date(start);
    while (cursor <= today) {
      const key = dateKey(cursor);
      days.push({ date: new Date(cursor), key, count: countByDate.get(key) ?? 0 });
      cursor.setDate(cursor.getDate() + 1);
    }

    const weeks: typeof days[] = [];
    for (let i = 0; i < days.length; i += 7) {
      weeks.push(days.slice(i, i + 7));
    }

    const monthLabels: { label: string; col: number }[] = [];
    let lastMonth = -1;
    for (let col = 0; col < weeks.length; col++) {
      const firstDay = weeks[col][0];
      const month = firstDay.date.getMonth();
      if (month !== lastMonth) {
        monthLabels.push({
          label: firstDay.date.toLocaleDateString("en-US", { month: "short" }),
          col,
        });
        lastMonth = month;
      }
    }

    return { grid: weeks, months: monthLabels };
  }, [events, activityByDate, timezone, resolvedTimezone]);

  const dayLabels = ["M", "", "W", "", "F", "", ""];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="rounded-xl sm:rounded-2xl border border-slate-200/60 bg-white p-4 sm:p-6 shadow-[0_2px_8px_rgb(0,0,0,0.04)]"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 font-display">Activity Calendar</h3>
          {resolvedTimezone && (
            <p className="mt-0.5 text-[11px] text-slate-400 truncate">{resolvedTimezone}</p>
          )}
        </div>
        {timezone && onTimezoneChange && (
          <TimezoneSelect
            value={timezone}
            onChange={onTimezoneChange}
            resolvedLabel={resolvedTimezone}
          />
        )}
      </div>

      <div className="relative flex gap-1 overflow-x-auto pb-1 [scrollbar-width:thin] [-webkit-overflow-scrolling:touch]">
        <div className="flex flex-col gap-1 pr-1">
          {dayLabels.map((label, i) => (
            <span key={i} className="flex h-3 w-4 items-center text-[10px] leading-none text-slate-400">
              {label}
            </span>
          ))}
        </div>

        <div>
          <div className="mb-1 flex gap-1">
            {grid.map((_, col) => {
              const monthEntry = months.find((m) => m.col === col);
              return (
                <span key={col} className="w-3 text-center text-[10px] leading-none text-slate-400">
                  {monthEntry?.label ?? ""}
                </span>
              );
            })}
          </div>

          {Array.from({ length: 7 }).map((_, row) => (
            <div key={row} className="flex gap-1">
              {grid.map((week, col) => {
                const day = week[row];
                if (!day) return <div key={col} className="h-3 w-3" />;
                return (
                  <div
                    key={day.key}
                    className={`h-3 w-3 rounded-sm ${getColor(day.count)} cursor-default`}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setHovered({
                        key: day.key,
                        label: `${formatDate(day.date)}: ${day.count} activit${day.count === 1 ? "y" : "ies"}`,
                        x: rect.left + rect.width / 2,
                        y: rect.top,
                      });
                    }}
                    onMouseLeave={() => setHovered(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {hovered && (
          <div
            className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md bg-slate-800 px-2 py-1 text-[11px] text-white shadow-lg"
            style={{ left: hovered.x, top: hovered.y - 6 }}
          >
            {hovered.label}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-1 text-[10px] text-slate-400">
        <span>less</span>
        <div className="h-3 w-3 rounded-sm bg-slate-100" />
        <div className="h-3 w-3 rounded-sm bg-emerald-200" />
        <div className="h-3 w-3 rounded-sm bg-emerald-400" />
        <div className="h-3 w-3 rounded-sm bg-emerald-600" />
        <span>more</span>
      </div>
    </motion.div>
  );
}
