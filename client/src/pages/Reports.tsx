import { TrialPreviewProvider, useTrialActivation } from "@/hooks/useTrialActivation";
import { TrialActivateBanner, TrialActivateButton } from "@/components/TrialActivateBanner";
import { PreviewLockOverlay } from "@/components/PreviewLockOverlay";
import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { authPath } from "@shared/auth-return";
import {
  ShieldCheck,
  LogOut,
  Settings as SettingsIcon,
  BarChart2,
  Bell,
  FileBarChart,
  UserPlus,
  UserMinus,
  Heart,
  Clock,
  TrendingUp,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Sparkles,
  ChevronDown,
  Download,
  FileSpreadsheet,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { csrfHeaders } from "@/lib/csrf";
import { logoutAndClearCache } from "@/lib/logout";
import { productAnalytics } from "@/lib/analytics";
import { MobileNav } from "@/components/MobileNav";
import { ReportDetail, type ReportMetrics } from "@/components/reports/ReportDetail";

type ReportStatus = "generating" | "ready" | "failed";

interface WeeklyReport {
  trialPreview?: boolean;
  id: string;
  igUsername: string;
  type: string;
  status: ReportStatus;
  periodStart: string;
  periodEnd: string;
  totalLikes: number;
  /**
   * Legacy roster-DISCOVERY counters. They also count re-enumeration, so they
   * once claimed "+3,251 new followers" for a 674-follower account. Never
   * render these — `metrics` carries the honest payload. Kept only because old
   * rows have nothing else.
   */
  totalFollows: number;
  totalUnfollows: number;
  topNiche: string | null;
  peakActivityHour: number | null;
  metrics: ReportMetrics | null;
  createdAt: string;
}

interface TrackedAccountSummary {
  id: string;
  igUsername: string;
}

// Format a 0-23 hour into a friendly "11 AM" style label. Mirrors the helper
// used in AnalyticsCards so the two surfaces read identically.
function formatHour(hour: number | null): string | null {
  if (hour === null || hour < 0 || hour > 23) return null;
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
}

// "Jun 9 – Jun 16" — locale-aware month/day with an en dash separator.
function formatPeriod(start: string, end: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const s = new Date(start).toLocaleDateString(undefined, opts);
  const e = new Date(end).toLocaleDateString(undefined, opts);
  return `${s} – ${e}`;
}

// "x days ago" relative label from an ISO timestamp.
function formatRelative(iso: string, t: (k: string, d: string) => string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return t("reports.justNow", "just now");
  if (mins < 60) return t("reports.minutesAgo", "{{n}}m ago").replace("{{n}}", String(mins));
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("reports.hoursAgo", "{{n}}h ago").replace("{{n}}", String(hours));
  const days = Math.round(hours / 24);
  if (days === 1) return t("reports.oneDayAgo", "1 day ago");
  if (days < 7) return t("reports.daysAgo", "{{n}} days ago").replace("{{n}}", String(days));
  const weeks = Math.round(days / 7);
  if (weeks === 1) return t("reports.oneWeekAgo", "1 week ago");
  return t("reports.weeksAgo", "{{n}} weeks ago").replace("{{n}}", String(weeks));
}

function StatusBadge({ status, t }: { status: ReportStatus; t: (k: string, d: string) => string }) {
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/10">
        <CheckCircle2 className="h-3.5 w-3.5" /> {t("reports.statusReady", "Ready")}
      </span>
    );
  }
  if (status === "generating") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/10">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("reports.statusGenerating", "Generating")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-600/10">
      <AlertTriangle className="h-3.5 w-3.5" /> {t("reports.statusFailed", "Failed")}
    </span>
  );
}

interface StatCellProps {
  icon: typeof Heart;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  valueClass?: string;
}

function StatCell({ icon: Icon, iconBg, iconColor, label, value, valueClass }: StatCellProps) {
  return (
    <div className="rounded-xl border border-slate-200/60 bg-slate-50/70 p-3">
      <div className={`mb-2 flex h-7 w-7 items-center justify-center rounded-lg ${iconBg}`}>
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </div>
      <p className={`text-lg font-bold tracking-tight tabular-nums text-slate-900 ${valueClass ?? ""}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] font-medium text-slate-400">{label}</p>
    </div>
  );
}

function ReportCard({
  report,
  t,
  defaultExpanded,
}: {
  report: WeeklyReport;
  t: (k: string, d: string) => string;
  defaultExpanded: boolean;
}) {
  const { isPreview } = useTrialActivation();
  const preview = isPreview || report.trialPreview === true;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const peak = formatHour(report.peakActivityHour);
  const generating = report.status === "generating";
  const failed = report.status === "failed";

  return (
    <PreviewLockOverlay><div className="relative overflow-hidden rounded-2xl border border-slate-200/70 bg-white p-5 sm:p-6 shadow-[0_1px_3px_rgba(15,23,42,.05),0_10px_30px_-12px_rgba(15,23,42,.12)] transition-all duration-200 hover:shadow-[0_2px_6px_rgba(15,23,42,.06),0_16px_40px_-14px_rgba(15,23,42,.18)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary via-primary/50 to-transparent" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold tracking-tight text-slate-900">@{report.igUsername}</h3>
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              {report.type === "monthly"
                ? t("reports.monthlyBadge", "Monthly")
                : t("reports.weeklyBadge", "Weekly")}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            {formatPeriod(report.periodStart, report.periodEnd)}
            <span className="mx-1.5 text-slate-300">·</span>
            <span className="text-slate-400">{formatRelative(report.createdAt, t)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={report.status} t={t} />
          {!generating && !failed && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {expanded ? "Collapse" : "View report"}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>
      </div>

      {generating ? (
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-amber-200/70 bg-amber-50/60 px-4 py-3.5">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-600" />
          <p className="text-sm font-medium text-amber-700">
            {t("reports.generatingBody", "Generating this week's report. It'll appear here shortly.")}
          </p>
        </div>
      ) : failed ? (
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-red-200/70 bg-red-50/60 px-4 py-3.5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
          <p className="text-sm font-medium text-red-700">
            {t("reports.failedBody", "Couldn't generate this report. We'll retry on the next cycle.")}
          </p>
        </div>
      ) : expanded ? (
        <ReportDetail
          trialPreview={preview}
          metrics={report.metrics}
          igUsername={report.igUsername}
          periodType={report.type}
          totalLikesFallback={report.totalLikes}
          peakHourFallback={report.peakActivityHour}
        />
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCell
            icon={UserPlus}
            iconBg="bg-emerald-50"
            iconColor="text-emerald-500"
            label="Followers"
            value={report.metrics?.profile.followerCountEnd?.toLocaleString() ?? "—"}
          />
          <StatCell
            icon={Heart}
            iconBg="bg-pink-50"
            iconColor="text-pink-500"
            label="Likes recorded"
            value={(report.metrics?.summary.totalLikes ?? report.totalLikes)?.toLocaleString() ?? "—"}
          />
          <StatCell
            icon={Sparkles}
            iconBg="bg-indigo-50"
            iconColor="text-indigo-500"
            label={report.type === "monthly" ? "Posts this month" : "Posts this week"}
            value={report.metrics?.ownPosts.publishedInPeriod?.toLocaleString() ?? "—"}
          />
          <StatCell
            icon={Clock}
            iconBg="bg-blue-50"
            iconColor="text-blue-500"
            label="Peak activity"
            value={peak ?? "—"}
          />
        </div>
      )}

      {!generating && !failed && expanded && report.topNiche && (
        <div className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700">
          <TrendingUp className="h-3.5 w-3.5" />
          {t("reports.topNiche", "Top niche")}:{" "}
          <span className="font-semibold">
            {report.topNiche.charAt(0).toUpperCase() + report.topNiche.slice(1)}
          </span>
        </div>
      )}

      {!generating && !failed && (
        <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-relaxed text-slate-400">
            {t("reports.pdfHint", "Share-ready PDF with the full breakdown.")}
          </p>
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
            {preview ? <TrialActivateButton /> : <><a
              href={`/api/reports/${report.id}/csv`}
              download
              className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:py-1.5"
              data-testid={`download-report-csv-${report.id}`}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {t("reports.downloadCsv", "CSV")}
            </a>
            <a
              href={`/api/reports/${report.id}/pdf`}
              download
              className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:py-1.5"
              data-testid={`download-report-${report.id}`}
            >
              <Download className="h-3.5 w-3.5" />
              {t("reports.downloadPdf", "Download PDF")}
            </a></>}
          </div>
        </div>
      )}
    </div></PreviewLockOverlay>
  );
}

function ReportSkeleton() {
  return (
    <div className="rounded-2xl border border-slate-200/60 bg-white p-5 sm:p-6 shadow-[0_2px_8px_rgb(0,0,0,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="h-5 w-32 rounded-md bg-slate-100" />
          <div className="h-3.5 w-40 rounded bg-slate-100" />
        </div>
        <div className="h-6 w-20 rounded-full bg-slate-100" />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-200/60 bg-slate-50/70 p-3">
            <div className="mb-2 h-7 w-7 rounded-lg bg-slate-100" />
            <div className="mb-2 h-5 w-12 rounded bg-slate-100" />
            <div className="h-3 w-16 rounded bg-slate-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Reports() {
  return <TrialPreviewProvider><ReportsContent /></TrialPreviewProvider>;
}

function ReportsContent() {
  const { isPreview } = useTrialActivation();
  const previousPreview = useRef(isPreview);
  const [, setLocation] = useLocation();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [reports, setReports] = useState<WeeklyReport[]>([]);
  const [accounts, setAccounts] = useState<TrackedAccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [generating, setGenerating] = useState(false);

  const fetchReports = async (signal?: AbortSignal, silent = false) => {
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const res = await fetch("/api/reports?limit=50", { credentials: "include", signal });
      if (res.status === 401) {
        setLocation(authPath(window.location.pathname + window.location.search));
        return;
      }
      if (!res.ok) throw new Error(`Failed to load reports (${res.status})`);
      const data = await res.json();
      setReports(Array.isArray(data.items) ? data.items : []);
      setAuthChecked(true);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setLoadError(
        err instanceof Error ? err.message : "Something went wrong loading reports",
      );
      setAuthChecked(true);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const fetchAccounts = async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/tracking/accounts", { credentials: "include", signal });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setAccounts(data.map((a: TrackedAccountSummary) => ({ id: a.id, igUsername: a.igUsername })));
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      // Non-fatal: the page still renders without the "Generate" affordance.
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchReports(controller.signal);
    fetchAccounts(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (previousPreview.current && !isPreview) void fetchReports(undefined, true);
    previousPreview.current = isPreview;
  }, [isPreview]);

  const hasGeneratingReport = reports.some(
    (report) => report.status === "generating",
  );
  useEffect(() => {
    if (!hasGeneratingReport) return;
    const timer = window.setInterval(() => {
      void fetchReports(undefined, true);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [hasGeneratingReport]);

  const handleSignOut = async () => {
    await logoutAndClearCache();
    setLocation("/");
  };

  const generateFor = async (
    account: TrackedAccountSummary,
    period: "weekly" | "monthly" = "weekly",
  ) => {
    if (generating || isPreview) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/tracking/accounts/${account.id}/report/generate`, {
        method: "POST",
        credentials: "include",
        headers: csrfHeaders({ "Content-Type": "application/json" }, "POST"),
        body: JSON.stringify({ period }),
      });
      if (res.status === 401) {
        setLocation(authPath(window.location.pathname + window.location.search));
        return;
      }
      if (res.status !== 202 && !res.ok) {
        throw new Error(`Generate failed (${res.status})`);
      }
      void productAnalytics.track("report_requested", { period });
      toast({
        title: t("reports.generateQueued", "Report queued"),
        description: t(
          "reports.generateQueuedDesc",
          "We're building a fresh report for @{{name}}. It'll appear here in a moment.",
        ).replace("{{name}}", account.igUsername),
      });
      // Fetch the newly-created row; the generating-state poll above keeps
      // refreshing quietly until the worker marks it ready or failed.
      setTimeout(() => {
        void fetchReports();
      }, 750);
    } catch {
      toast({
        variant: "destructive",
        title: t("reports.generateFailed", "Couldn't start report"),
        description: t("reports.generateFailedDesc", "Something went wrong. Please try again."),
      });
    } finally {
      setGenerating(false);
    }
  };

  if (!authChecked && loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-slate-400">{t("reports.loading", "Loading reports…")}</div>
      </div>
    );
  }

  const hasAccounts = accounts.length > 0;
  const singleAccount = accounts.length === 1 ? accounts[0] : null;

  const generateButton = !hasAccounts ? null : isPreview ? <TrialActivateButton /> : (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={generating}
        className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-white shadow-[0_2px_8px_rgb(0,0,0,0.06)] transition-colors hover:bg-primary/90 disabled:opacity-60 focus:outline-none"
      >
        {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {t("reports.generateNow", "Generate report")}
        <ChevronDown className="h-4 w-4 opacity-80" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {singleAccount
          ? (["weekly", "monthly"] as const).map((period) => (
              <DropdownMenuItem
                key={period}
                onClick={() => generateFor(singleAccount, period)}
                className="cursor-pointer font-medium capitalize"
              >
                {period === "weekly"
                  ? t("reports.weeklyReport", "Weekly report")
                  : t("reports.monthlyReport", "Monthly report")}
              </DropdownMenuItem>
            ))
          : accounts.flatMap((acc) =>
              (["weekly", "monthly"] as const).map((period) => (
                <DropdownMenuItem
                  key={acc.id + period}
                  onClick={() => generateFor(acc, period)}
                  className="cursor-pointer font-medium"
                >
                  @{acc.igUsername}
                  <span className="ml-auto text-xs capitalize text-slate-400">
                    {period}
                  </span>
                </DropdownMenuItem>
              )),
            )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 md:flex-row">
      <title>Reports — CheaterFinder</title>
      {/* Sidebar */}
      <aside className="hidden min-h-screen w-full flex-col border-r border-slate-200 bg-white md:flex md:w-64">
        <div className="border-b border-slate-100 p-6">
          <div className="flex cursor-pointer items-center gap-2" onClick={() => setLocation("/")}>
            <ShieldCheck className="h-6 w-6 text-primary" />
            <span className="font-display text-xl font-bold tracking-tight">
              <span className="text-foreground">Cheater</span><span className="text-primary">Finder</span>
            </span>
          </div>
        </div>

        <nav className="flex-1 space-y-2 p-4">
          <a
            onClick={() => setLocation("/members")}
            className="flex cursor-pointer items-center gap-3 rounded-xl px-4 py-3 font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            <BarChart2 className="h-5 w-5" /> {t("reports.trackedAccounts", "Tracked accounts")}
          </a>
          <a className="flex cursor-default items-center gap-3 rounded-xl bg-primary/10 px-4 py-3 font-semibold text-primary">
            <FileBarChart className="h-5 w-5" /> {t("reports.title", "Reports")}
          </a>
          <a
            onClick={() => setLocation("/notifications")}
            className="flex cursor-pointer items-center gap-3 rounded-xl px-4 py-3 font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            <Bell className="h-5 w-5" /> {t("reports.notifications", "Notifications")}
          </a>
          <a
            onClick={() => setLocation("/settings")}
            className="flex cursor-pointer items-center gap-3 rounded-xl px-4 py-3 font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            <SettingsIcon className="h-5 w-5" /> {t("reports.settings", "Settings")}
          </a>
        </nav>

        <div className="border-t border-slate-100 p-4">
          <button
            onClick={handleSignOut}
            className="flex w-full items-center gap-3 rounded-xl px-4 py-3 font-medium text-slate-600 transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <LogOut className="h-5 w-5" /> {t("reports.signOut", "Sign out")}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="relative flex-1 overflow-hidden p-6 md:p-10">
        <div className="pointer-events-none absolute right-0 top-0 h-[600px] w-[600px] rounded-full bg-primary/5 blur-[100px]" />

        <div className="relative z-10 mx-auto max-w-4xl">
          <TrialActivateBanner sticky={false} />
          {/* Mobile Header */}
          <div className="mb-8 flex items-center justify-between border-b border-slate-200 pb-4 md:hidden">
            <div className="flex cursor-pointer items-center gap-2" onClick={() => setLocation("/")}>
              <ShieldCheck className="h-6 w-6 text-primary" />
              <span className="font-display text-xl font-bold tracking-tight">
                <span className="text-foreground">Cheater</span><span className="text-primary">Finder</span>
              </span>
            </div>
            <div className="flex items-center gap-4">
              <MobileNav />
              <button onClick={handleSignOut} className="text-slate-500">
                <LogOut className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="mb-10 flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
            <div>
              <h1 className="mb-2 text-3xl font-bold text-slate-900">{t("reports.title", "Reports")}</h1>
              <p className="text-slate-600">
                {t("reports.subtitle", "Your weekly intelligence digest for every tracked account.")}
              </p>
            </div>
            {generateButton}
          </div>

          {loading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <ReportSkeleton key={i} />
              ))}
            </div>
          ) : loadError ? (
            <div className="rounded-2xl border border-red-200/70 bg-white p-10 text-center shadow-[0_2px_8px_rgb(0,0,0,0.04)]">
              <AlertTriangle className="mx-auto mb-3 h-7 w-7 text-red-500" />
              <h3 className="text-base font-bold text-slate-900">
                {t("reports.loadFailed", "Couldn't load reports")}
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                {t("reports.loadFailedBody", "Your reports are safe. Please try loading them again.")}
              </p>
              <button
                type="button"
                onClick={() => void fetchReports()}
                className="mt-5 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary/90"
              >
                {t("reports.retry", "Retry")}
              </button>
            </div>
          ) : reports.length > 0 ? (
            <div className="space-y-4">
              {reports.map((report, index) => (
                <ReportCard
                  key={report.id}
                  report={report}
                  t={t}
                  defaultExpanded={index === 0}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200/60 bg-white p-12 text-center shadow-[0_2px_8px_rgb(0,0,0,0.04)]">
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                <FileBarChart className="h-7 w-7 text-primary" />
              </div>
              <h3 className="mb-1.5 text-lg font-bold text-slate-900">
                {t("reports.emptyTitle", "No reports yet")}
              </h3>
              <p className="mx-auto max-w-md text-sm text-slate-500">
                {t(
                  "reports.emptyBody",
                  "Your weekly report is generated automatically every week. Once your first one is ready, it'll show up here.",
                )}
              </p>
              {generateButton && <div className="mt-6 flex justify-center">{generateButton}</div>}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
