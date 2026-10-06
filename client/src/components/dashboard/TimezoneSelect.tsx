import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TIMEZONE_OPTIONS } from "@/hooks/useTimezone";

interface TimezoneSelectProps {
  value: string;
  onChange: (value: string) => void;
  resolvedLabel?: string;
  size?: "sm" | "md";
}

export default function TimezoneSelect({
  value,
  onChange,
  resolvedLabel,
  size = "sm",
}: TimezoneSelectProps) {
  const { t } = useTranslation();

  const sizeCls =
    size === "sm"
      ? "h-8 text-[11px] pl-7 pr-6"
      : "h-9 text-xs pl-8 pr-7";

  return (
    <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
      <span className="sr-only">{t("timezone.label", "Timezone")}</span>
      <div className="relative">
        <Globe
          className={`pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 ${
            size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"
          } text-slate-400`}
          aria-hidden="true"
        />
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={t("timezone.label", "Timezone")}
          className={`appearance-none rounded-lg border border-slate-200 bg-white font-medium text-slate-700 transition-colors duration-150 hover:border-slate-300 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 ${sizeCls}`}
        >
          {TIMEZONE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400">
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      {resolvedLabel && value === "auto" && (
        <span className="hidden text-slate-400 sm:inline">{resolvedLabel}</span>
      )}
    </label>
  );
}
