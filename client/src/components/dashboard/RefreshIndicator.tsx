import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

interface RefreshConfigResponse {
  refreshSweepSec: number;
  onboardingInitialDelayMs?: number;
  tiers: {
    profileMin: number;
    contentMin: number;
    graphHours: number;
  };
}

interface RefreshIndicatorProps {
  /** ISO timestamp of the most recent profile snapshot. */
  lastSnapshotAt?: string;
}

/**
 * Tick interval for "Updated Xs ago" recomputation. 30s gives near-realtime
 * feedback without burning render cycles.
 */
const TICK_MS = 30_000;

async function fetchRefreshConfig(): Promise<RefreshConfigResponse> {
  const response = await fetch("/api/config/refresh", {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`Failed to load refresh config: ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { refreshSweepSec?: unknown }).refreshSweepSec !== "number"
  ) {
    throw new Error("Malformed refresh config payload");
  }

  return payload as RefreshConfigResponse;
}

function formatRelative(
  isoTimestamp: string,
  now: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const then = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(then)) {
    return t("refresh.updatedNever");
  }

  const diffSec = Math.max(0, Math.round((now - then) / 1000));

  if (diffSec < 60) {
    return t("refresh.secondsAgo", { count: diffSec });
  }
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) {
    return t("refresh.minutesAgo", { count: diffMin });
  }
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) {
    return t("refresh.hoursAgo", { count: diffHour });
  }
  const diffDay = Math.round(diffHour / 24);
  return t("refresh.daysAgo", { count: diffDay });
}

export default function RefreshIndicator({ lastSnapshotAt }: RefreshIndicatorProps) {
  const { t } = useTranslation();

  const { data: config } = useQuery({
    queryKey: ["config", "refresh"],
    queryFn: fetchRefreshConfig,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });

  // Recompute the relative time every TICK_MS so the label stays fresh
  // without a full re-fetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const cadenceMin = config ? Math.max(1, Math.round(config.refreshSweepSec / 60)) : null;
  // Deliberately NO interval in the label. "Recurring sync every 240 min" made
  // the reader do maths, and even "every 4 hours" is a promise we shouldn't
  // make: the real gap depends on the bot pool, daily budgets and IG throttling,
  // so a fixed number would often be wrong. "Auto-syncing" states the behaviour;
  // the adjacent "Updated Xs ago" is the honest, factual signal.
  const cadenceLabel = t("refresh.autoSyncing", {
    defaultValue: "Auto-syncing",
  });
  const updatedLabel = lastSnapshotAt
    ? t("refresh.updatedAgo", { ago: formatRelative(lastSnapshotAt, now, t) })
    : t("refresh.updatedNever");

  return (
    <div
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 bg-slate-50 border border-slate-200/60 rounded-full px-3 py-1.5"
      aria-live="polite"
    >
      {cadenceMin !== null && (
        <span className="inline-flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
          <span>
            {lastSnapshotAt
              ? cadenceLabel
              : t("refresh.awaitingFirstSync", "Waiting for first sync")}
          </span>
        </span>
      )}
      {cadenceMin !== null && (
        <span aria-hidden="true" className="w-1 h-1 rounded-full bg-slate-300" />
      )}
      <span className="text-slate-500">{updatedLabel}</span>
    </div>
  );
}
