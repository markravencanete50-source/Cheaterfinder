import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowDownToLine,
  Gauge,
  RefreshCw,
  Loader2,
  Timer,
  Save,
  AlertTriangle,
  User,
  Instagram,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  adminFetch,
  formatBytes,
  formatDurationSec,
  formatRelative,
  type BandwidthReport,
  type BandwidthWindow,
  type RefreshIntervalConfig,
} from "./shared";
import { ForbiddenPanel } from "./ForbiddenPanel";

const WINDOWS: Array<{ value: BandwidthWindow; label: string }> = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

const INTERVAL_PRESETS: Array<{ label: string; sec: number }> = [
  { label: "2 min", sec: 120 },
  { label: "5 min", sec: 300 },
  { label: "15 min", sec: 900 },
  { label: "30 min", sec: 1800 },
  { label: "1 hour", sec: 3600 },
  { label: "6 hours", sec: 21600 },
];

// ─── Refresh cadence control ────────────────────────────────────────────────

function RefreshCadenceCard() {
  const [, setLocation] = useLocation();
  const [config, setConfig] = useState<RefreshIntervalConfig["current"] | null>(
    null,
  );
  const [draft, setDraft] = useState<number>(1800);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoading(true);
        const res = await adminFetch("/api/admin/refresh-interval", { signal });
        if (res.status === 401) {
          setLocation("/auth");
          return;
        }
        if (res.status === 403) return;
        if (!res.ok) throw new Error("Failed to load refresh interval");
        const body = (await res.json()) as RefreshIntervalConfig;
        setConfig(body.current);
        setDraft(body.current.intervalSec);
        setError("");
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError("Failed to load refresh interval.");
      } finally {
        setLoading(false);
      }
    },
    [setLocation],
  );

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const save = useCallback(
    async (intervalSec: number) => {
      if (!config) return;
      const clamped = Math.min(
        Math.max(Math.round(intervalSec), config.min),
        config.max,
      );
      try {
        setSaving(true);
        setSavedNote("");
        const res = await adminFetch("/api/admin/refresh-interval", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intervalSec: clamped }),
        });
        if (res.status === 401) {
          setLocation("/auth");
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            message?: string;
          };
          throw new Error(body.message ?? "Failed to update");
        }
        const body = (await res.json()) as RefreshIntervalConfig & {
          applied?: { rescheduled: number } | null;
        };
        setConfig(body.current);
        setDraft(body.current.intervalSec);
        setError("");
        setSavedNote(
          body.applied
            ? `Saved — applied to ${body.applied.rescheduled} active profile${body.applied.rescheduled === 1 ? "" : "s"}.`
            : "Saved.",
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update.");
      } finally {
        setSaving(false);
      }
    },
    [config, setLocation],
  );

  const tooAggressive = draft < 300;

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <Timer className="w-4 h-4 text-indigo-600" />
          Scraping refresh cadence
        </CardTitle>
        <p className="text-sm text-slate-500">
          Scheduler interval, not a guarantee that every feature refreshes each
          cycle. Feature cadences, active jobs, bot capacity and backoff still apply.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  Interval (seconds)
                </label>
                <Input
                  type="number"
                  value={draft}
                  min={config?.min ?? 60}
                  max={config?.max ?? 86400}
                  onChange={(e) => setDraft(Number(e.target.value))}
                  className="w-36"
                />
              </div>
              <div className="text-sm text-slate-600 pb-2">
                = <span className="font-semibold">{formatDurationSec(draft)}</span>
              </div>
              <Button
                onClick={() => save(draft)}
                disabled={saving || draft === config?.intervalSec}
                className="ml-auto"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                <span className="ml-1">Save</span>
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              {INTERVAL_PRESETS.map((p) => (
                <button
                  key={p.sec}
                  type="button"
                  onClick={() => setDraft(p.sec)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    draft === p.sec
                      ? "bg-indigo-600 text-white border-indigo-600"
                      : "bg-white text-slate-600 border-slate-200 hover:border-indigo-300"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {tooAggressive && (
              <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  Intervals under 5 minutes significantly increase Instagram
                  rate-limit / ban risk and scraping cost. Use with caution.
                </span>
              </div>
            )}

            <div className="flex items-center justify-between text-xs text-slate-400 pt-1 border-t border-slate-100">
              <span>
                Current:{" "}
                <span className="font-medium text-slate-600">
                  {config ? formatDurationSec(config.intervalSec) : "--"}
                </span>{" "}
                ({config?.source})
              </span>
              <span>Updated {formatRelative(config?.updatedAt ?? null)}</span>
            </div>
            {savedNote && (
              <p className="text-xs text-emerald-600">{savedNote}</p>
            )}
            {error && <p className="text-xs text-red-600">{error}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Summary stat tile ──────────────────────────────────────────────────────

interface StatTileProps {
  icon: typeof Gauge;
  label: string;
  value: string;
  sub?: string;
  /** Second line, for coverage caveats the headline number must not hide. */
  note?: string;
  tint: string;
}

function StatTile({ icon: Icon, label, value, sub, note, tint }: StatTileProps) {
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tint}`}>
            <Icon className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-500">{label}</p>
            <p className="text-xl font-bold text-slate-900 tabular-nums">
              {value}
            </p>
            {sub && <p className="text-xs text-slate-400">{sub}</p>}
            {note && <p className="text-xs text-slate-400">{note}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Short absolute stamp, e.g. "Sep 4, 2:05 PM". Used for measurement start. */
function formatShortDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AdminBandwidth() {
  const [, setLocation] = useLocation();
  const [report, setReport] = useState<BandwidthReport | null>(null);
  const [window, setWindow] = useState<BandwidthWindow>("24h");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(
    async (win: BandwidthWindow) => {
      const sequence = ++requestSequence.current;
      activeRequest.current?.abort();
      const controller = new AbortController();activeRequest.current = controller;
      const current = () => !controller.signal.aborted && sequence === requestSequence.current;
      try {
        setRefreshing(true);
        const res = await adminFetch(`/api/admin/bandwidth?window=${win}`, {
          signal: controller.signal,
        });
        if (!current()) return;
        if (res.status === 401) {
          setReport(null);
          setLocation("/auth");
          return;
        }
        if (res.status === 403) {
          setReport(null);
          setForbidden(true);
          return;
        }
        if (!res.ok) throw new Error("Failed to load bandwidth");
        const data = await res.json() as BandwidthReport;
        if (!current()) return;
        setReport(data);
        setForbidden(false);
        setError("");
      } catch (err) {
        if (!current()) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setError("Failed to load bandwidth report.");
      } finally {
        if (current()) { setLoading(false);setRefreshing(false);activeRequest.current = null; }
      }
    },
    [setLocation],
  );

  useEffect(() => {
    setReport(null);setLoading(true);void load(window);
    const timer = globalThis.setInterval(() => {
      if (!document.hidden && !activeRequest.current) void load(window);
    }, 30_000);
    return () => { globalThis.clearInterval(timer);++requestSequence.current;activeRequest.current?.abort();activeRequest.current=null; };
  }, [window, load]);

  const totals = report?.totals;
  const wire = report?.wire;
  // No samples yet = the kernel counter is installed but has not produced a
  // delta (first minute after boot, or the sampler could not start). Say that
  // instead of rendering a confident "0 B" the operator would read as "no
  // traffic".
  const wireMeasuring = (wire?.samples ?? 0) === 0;
  const wireUnavailable = wire?.available === false;
  const wireStale = !!wire?.lastSampleAt && Date.now() - new Date(wire.lastSampleAt).getTime() > 180_000;
  const windowSeconds = { "1h": 3600, "24h": 86400, "7d": 604800, "30d": 2592000 }[window];
  const coveragePercent = Math.min(100, Math.max(0, (wire?.coverageSeconds ?? 0) / windowSeconds * 100));
  const profileCount = report?.counts?.profilesWithTraffic ?? new Set(report?.byProfile.filter(row => row.trackedAccountId).map(row => row.igUsername?.toLowerCase() ?? row.trackedAccountId)).size;
  const customerCount = report?.counts?.customersWithTraffic ?? new Set(report?.byUser.filter(row => row.userId).map(row => row.userId)).size;
  const recordedTotal = report?.totals.totalBytes ?? 0;

  if (forbidden) {
    return <ForbiddenPanel />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Gauge className="w-5 h-5 text-indigo-600" />
            Bandwidth usage
          </h2>
          <p className="text-sm text-slate-500">
            Wire = kernel-measured gateway traffic, not an invoice reconciliation.
            Metered = per-request attribution: Firefox launches at real
            transfer size, HTTP/mobile JSON at decoded size.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                type="button"
                onClick={() => setWindow(w.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  window === w.value
                    ? "bg-indigo-600 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh bandwidth"
            onClick={() => load(window)}
            disabled={refreshing}
          >
            <RefreshCw
              className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </div>

      {/* Refresh cadence control */}
      <RefreshCadenceCard />

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
          {error}
        </div>
      )}
      {report && <p className="text-xs text-slate-500">Report updated {formatRelative(report.generatedAt)} · refreshes every 30s while visible</p>}
      {(wireUnavailable || wireStale || report?.meter?.lastErrorAt) && (
        <div role="status" className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
          {wireUnavailable ? "Wire measurement is unavailable. " : wireStale ? "Wire sampler has not updated recently. " : ""}
          {report?.meter?.lastErrorAt ? `Attribution writes are delayed; ${report.meter.retryBuckets + report.meter.pendingBuckets} buckets are waiting for retry. ` : ""}
          Displayed totals may be incomplete.
        </div>
      )}

      {/* Summary tiles */}
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <StatTile
            icon={Gauge}
            label="Proxy wire (measured)"
            value={!report || wireUnavailable ? "unavailable" : wireMeasuring ? "no samples" : formatBytes(wire?.totalBytes ?? 0)}
            sub={
              wireMeasuring
                ? "measurement not yet available"
                : `in ${formatBytes(wire?.bytesIn ?? 0)} · out ${formatBytes(
                    wire?.bytesOut ?? 0,
                  )}`
            }
            note={
              !wireMeasuring && wire?.firstSampleAt
                ? `${coveragePercent.toFixed(1)}% window coverage · latest ${wire.lastSampleAt ? formatShortDateTime(wire.lastSampleAt) : "unknown"}${coveragePercent < 99 ? " · partial total" : ""}`
                : undefined
            }
            tint="bg-indigo-50 text-indigo-600"
          />
          <StatTile
            icon={ArrowDownToLine}
            label="Request attribution (mixed units)"
            value={report ? formatBytes(totals?.totalBytes ?? 0) : "unavailable"}
            sub={`${(totals?.requests ?? 0).toLocaleString()} requests`}
            tint="bg-emerald-50 text-emerald-600"
          />
          <StatTile
            icon={Activity}
            label="Profiles with traffic"
            value={report ? String(profileCount) : "unavailable"}
            sub={`${customerCount} customers · excludes system buckets`}
            tint="bg-violet-50 text-violet-600"
          />
        </div>
      )}

      {/* By profile */}
      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Instagram className="w-4 h-4 text-pink-600" />
            By profile
          </CardTitle>
          {report?.breakdownCoverage && report.breakdownCoverage.profiles.totalGroups > report.breakdownCoverage.profiles.shownGroups && (
            <p className="text-sm text-slate-500" data-testid="profile-bandwidth-coverage">
              Showing top {report.breakdownCoverage.profiles.shownGroups} of {report.breakdownCoverage.profiles.totalGroups} profile/owner groups.
              {" "}{formatBytes(report.breakdownCoverage.profiles.omittedBytes)} across the remaining groups is included in the totals above.
            </p>
          )}
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : !report?.byProfile?.length ? (
            <p className="text-sm text-slate-400 py-6 text-center">
              No scrape traffic recorded in this window yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Profile</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">
                    In / Out
                  </TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="w-28 hidden md:table-cell">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.byProfile.map((row) => {
                  const share =
                    recordedTotal > 0
                      ? Math.round((row.totalBytes / recordedTotal) * 100)
                      : 0;
                  return (
                    <TableRow
                      key={`${row.trackedAccountId ?? "sys"}-${row.userId ?? "sys"}`}
                    >
                      <TableCell className="font-medium text-slate-900">
                        {row.igUsername ? `@${row.igUsername}` : "— system —"}
                      </TableCell>
                      <TableCell className="text-slate-500 text-sm">
                        {row.userEmail ?? (row.userId ? "Customer record unavailable" : "—")}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatBytes(row.totalBytes)}
                      </TableCell>
                      <TableCell className="text-right text-xs text-slate-500 tabular-nums hidden sm:table-cell">
                        {formatBytes(row.bytesIn)} / {formatBytes(row.bytesOut)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-slate-600">
                        {row.requests.toLocaleString()}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="h-2 rounded-full bg-slate-100 overflow-hidden" title={`${share}% of recorded traffic`}>
                          <div
                            className="h-full bg-gradient-to-r from-indigo-500 to-pink-500"
                            style={{ width: `${share}%` }}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* By user + by endpoint */}
      <div className="grid min-w-0 grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="min-w-0 border-slate-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <User className="w-4 h-4 text-indigo-600" />
              By customer
            </CardTitle>
            {report?.breakdownCoverage && report.breakdownCoverage.customers.totalGroups > report.breakdownCoverage.customers.shownGroups && (
              <p className="text-sm text-slate-500" data-testid="customer-bandwidth-coverage">
                Showing top {report.breakdownCoverage.customers.shownGroups} of {report.breakdownCoverage.customers.totalGroups} customer/system groups.
                {" "}{formatBytes(report.breakdownCoverage.customers.omittedBytes)} across the remaining groups is included in the totals above.
              </p>
            )}
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-40 w-full" />
            ) : !report?.byUser?.length ? (
              <p className="text-sm text-slate-400 py-6 text-center">
                No data.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Profiles</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.byUser.map((row) => (
                    <TableRow key={row.userId ?? "system"}>
                      <TableCell className="font-medium text-slate-800 text-sm">
                        {row.userEmail ?? (row.userId ? "Customer record unavailable" : "— system —")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-slate-600">
                        {row.profileCount}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatBytes(row.totalBytes)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-slate-600">
                        {row.requests.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <Activity className="w-4 h-4 text-emerald-600" />
              By endpoint
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-40 w-full" />
            ) : !report?.byEndpoint?.length ? (
              <p className="text-sm text-slate-400 py-6 text-center">
                No data.
              </p>
            ) : (
              <div className="space-y-2">
                {report.byEndpoint.map((row) => {
                  const max = report.byEndpoint[0]?.totalBytes || 1;
                  const pct = Math.round((row.totalBytes / max) * 100);
                  return (
                    <div key={row.endpoint}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-medium text-slate-700 capitalize">
                          {row.endpoint}
                        </span>
                        <span className="tabular-nums text-slate-500">
                          {formatBytes(row.totalBytes)} ·{" "}
                          {row.requests.toLocaleString()} req
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="text-xs text-slate-400 text-center"
      >
        Generated {formatRelative(report?.generatedAt ?? null)} · the tables
        below break down the metered figure, so they mix true browser-launch
        transfer with decoded JSON and will not add up to the measured wire
        total.
      </motion.p>
    </div>
  );
}
