import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  Server,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Play,
  XCircle,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Loader2,
  MonitorCog,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  adminFetch,
  formatDate,
  type QueueHealth,
  type CollectionJob,
  type ScraperReadTransport,
  type ScraperTransportConfig,
} from "./shared";
import { ForbiddenPanel } from "./ForbiddenPanel";
import { useToast } from "@/hooks/use-toast";

const TRANSPORT_COPY: Record<
  ScraperReadTransport,
  { title: string; detail: string; badge: string }
> = {
  http: {
    title: "HTTP",
    detail: "Fastest stable path. Uses bot cookies, device headers, proxy, endpoint budgets, and circuit breakers.",
    badge: "Production default",
  },
  browser: {
    title: "Browser",
    detail: "Runs reads inside Chromium with the bot session and proxy. Useful when Chrome network behavior is needed.",
    badge: "Chrome reads",
  },
  "browser-fallback": {
    title: "Browser fallback",
    detail: "Tries Chromium first and falls back to HTTP only on browser infrastructure failures, not IG rate limits.",
    badge: "Controlled fallback",
  },
};

function ScraperTransportSection() {
  const [, setLocation] = useLocation();
  const [config, setConfig] = useState<ScraperTransportConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);

  const fetchConfig = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoading(true);
        const res = await adminFetch("/api/admin/scraper-transport", { signal });
        if (res.status === 401) {
          setLocation("/auth");
          return;
        }
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) throw new Error("Failed to fetch scraper transport");
        setConfig((await res.json()) as ScraperTransportConfig);
        setForbidden(false);
        setError("");
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError("Failed to load scraper transport.");
      } finally {
        setLoading(false);
      }
    },
    [setLocation],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchConfig(controller.signal);
    return () => controller.abort();
  }, [fetchConfig]);

  const updateTransport = async (transport: ScraperReadTransport) => {
    if (!config || transport === config.current.value) return;
    setSaving(true);
    try {
      const res = await adminFetch("/api/admin/scraper-transport", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transport }),
      });
      if (!res.ok) throw new Error("Failed to update scraper transport");
      const json = (await res.json()) as Pick<ScraperTransportConfig, "current">;
      setConfig((prev) => (prev ? { ...prev, current: json.current } : prev));
      setError("");
    } catch {
      setError("Failed to update scraper transport.");
    } finally {
      setSaving(false);
    }
  };

  const current = config?.current.value ?? "http";
  const copy = TRANSPORT_COPY[current];

  if (forbidden) {
    return <ForbiddenPanel />;
  }

  return (
    <Card className="border border-slate-200 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
              <MonitorCog className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base text-slate-900">
                Scraper Read Transport
              </CardTitle>
              <p className="mt-1 max-w-2xl text-sm text-slate-500">
                Selects the backend transport used by background collection jobs.
                The user dashboard remains cache-first.
              </p>
            </div>
          </div>
          <Select
            value={current}
            disabled={loading || saving}
            onValueChange={(value) =>
              updateTransport(value as ScraperReadTransport)
            }
          >
            <SelectTrigger className="h-10 w-full rounded-lg md:w-[210px]">
              <SelectValue placeholder="Transport" />
            </SelectTrigger>
            <SelectContent>
              {(config?.options ?? [
                { value: "http", label: "HTTP" },
                { value: "browser", label: "Browser" },
                { value: "browser-fallback", label: "Browser fallback" },
              ]).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="grid gap-3 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-24 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {(Object.keys(TRANSPORT_COPY) as ScraperReadTransport[]).map(
              (value) => {
                const item = TRANSPORT_COPY[value];
                const active = value === current;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={saving}
                    onClick={() => updateTransport(value)}
                    className={`min-h-[116px] rounded-lg border p-4 text-left transition-colors ${
                      active
                        ? "border-slate-900 bg-slate-50"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900">
                        {item.title}
                      </span>
                      {active ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : null}
                    </div>
                    <span className="mt-2 inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      {item.badge}
                    </span>
                    <p className="mt-3 text-xs leading-5 text-slate-500">
                      {item.detail}
                    </p>
                  </button>
                );
              },
            )}
          </div>
        )}
        <div className="mt-3 flex min-h-5 items-center justify-between gap-3 text-xs text-slate-500">
          <span>
            Current source: {config?.current.source ?? "default"}
            {config?.current.updatedAt
              ? ` · Updated ${formatDate(config.current.updatedAt)}`
              : ""}
          </span>
          {saving ? (
            <span className="inline-flex items-center gap-1 text-blue-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving
            </span>
          ) : null}
        </div>
        {error ? (
          <p className="mt-2 text-sm text-red-600">{error}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── Queue Health Section ──────────────────────────────────────────────────

function QueueHealthSection() {
  const [, setLocation] = useLocation();
  const [queues, setQueues] = useState<QueueHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);

  const fetchQueues = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await adminFetch("/api/admin/queues", { signal });
      if (res.status === 401) {
        setLocation("/auth");
        return;
      }
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch queues");
      const json = await res.json();
      setQueues(Array.isArray(json) ? json : json.queues ?? []);
      setForbidden(false);
      setError("");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Failed to load queue health.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let currentController = new AbortController();
    fetchQueues(currentController.signal);

    const interval = setInterval(() => {
      currentController.abort();
      currentController = new AbortController();
      fetchQueues(currentController.signal);
    }, 30000);

    return () => {
      currentController.abort();
      clearInterval(interval);
    };
  }, []);

  if (forbidden) {
    return <ForbiddenPanel />;
  }

  if (error && queues.length === 0) {
    return (
      <div className="p-6 text-center">
        <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-amber-400" />
        <p className="text-sm text-slate-500">{error}</p>
      </div>
    );
  }

  // Skeletons only on the very first load. The 30s poll toggles `loading` true
  // again, but with queues already populated we keep the real cards rendered
  // instead of flashing skeletons every cycle.
  const showSkeleton = loading && queues.length === 0;

  const QUEUE_DISPLAY_NAMES: Record<string, string> = {
    "collection-profile": "Profile Collection",
    "collection-likes": "Likes Collection",
    "collection-follows": "Follows Collection",
    "report-generate": "Report Generation",
    "email-send": "Email Sending",
    "bot-follow-request": "Bot Follow Request",
    "bot-follow-check": "Bot Follow Check",
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Server className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
          Queue Health
        </h3>
      </div>

      {showSkeleton ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {queues.map((q, index) => {
            const hasFailed = q.failed > 0;
            return (
              <motion.div
                key={q.name}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
              >
                <Card
                  className={`border shadow-sm hover:shadow-md transition-shadow ${
                    hasFailed
                      ? "border-red-300 bg-red-50/30"
                      : "border-slate-200"
                  }`}
                >
                  <CardContent className="p-4">
                    <p className="text-sm font-semibold text-slate-800 mb-3 truncate">
                      {QUEUE_DISPLAY_NAMES[q.name] ?? q.name}
                    </p>
                    <div className="grid grid-cols-2 gap-2 text-center">
                      <div className="bg-amber-50 rounded-lg p-2 border border-amber-100">
                        <p className="text-lg font-bold text-amber-700">
                          {q.waiting}
                        </p>
                        <p className="text-[10px] font-medium text-amber-600 uppercase">
                          Waiting
                        </p>
                      </div>
                      <div className="bg-blue-50 rounded-lg p-2 border border-blue-100">
                        <p className="text-lg font-bold text-blue-700">
                          {q.active}
                        </p>
                        <p className="text-[10px] font-medium text-blue-600 uppercase">
                          Active
                        </p>
                      </div>
                      <div className="bg-emerald-50 rounded-lg p-2 border border-emerald-100">
                        <p className="text-lg font-bold text-emerald-700">
                          {q.completed}
                        </p>
                        <p className="text-[10px] font-medium text-emerald-600 uppercase">
                          Done
                        </p>
                      </div>
                      <div
                        className={`rounded-lg p-2 border ${
                          hasFailed
                            ? "bg-red-100 border-red-200"
                            : "bg-slate-50 border-slate-100"
                        }`}
                      >
                        <p
                          className={`text-lg font-bold ${
                            hasFailed ? "text-red-700" : "text-slate-400"
                          }`}
                        >
                          {q.failed}
                        </p>
                        <p
                          className={`text-[10px] font-medium uppercase ${
                            hasFailed ? "text-red-600" : "text-slate-400"
                          }`}
                        >
                          Failed
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Collection Jobs Section ───────────────────────────────────────────────

const JOB_STATUS_CONFIG: Record<
  string,
  { label: string; className: string; icon: React.ElementType }
> = {
  pending: {
    label: "Pending",
    className: "bg-slate-100 text-slate-600 border-slate-200",
    icon: Clock,
  },
  running: {
    label: "Running",
    className: "bg-blue-100 text-blue-700 border-blue-200",
    icon: Loader2,
  },
  completed: {
    label: "Completed",
    className: "bg-emerald-100 text-emerald-700 border-emerald-200",
    icon: CheckCircle2,
  },
  failed: {
    label: "Failed",
    className: "bg-red-100 text-red-700 border-red-200",
    icon: XCircle,
  },
};

const JOB_TYPE_CONFIG: Record<string, { label: string; className: string }> = {
  profile: { label: "Profile", className: "bg-violet-100 text-violet-700" },
  likes: { label: "Likes", className: "bg-red-100 text-red-700" },
  follows: { label: "Follows", className: "bg-emerald-100 text-emerald-700" },
  report: { label: "Report", className: "bg-blue-100 text-blue-700" },
};

function CollectionJobsSection() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [jobs, setJobs] = useState<CollectionJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  const perPage = 20;

  const fetchJobs = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("jobType", typeFilter);
      params.set("page", String(page));
      params.set("limit", String(perPage));

      const res = await adminFetch(`/api/admin/jobs?${params}`, { signal });
      if (res.status === 401) {
        setLocation("/auth");
        return;
      }
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch jobs");
      const json = await res.json();
      setJobs(json.items ?? []);
      setTotal(json.total ?? 0);
      setForbidden(false);
      setError("");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Failed to load collection jobs.");
    } finally {
      setLoading(false);
    }
  };

  // Reset to page 1 whenever a filter changes. Guarded so it does not trigger
  // an extra render (and thus no double fetch) when already on page 1.
  const handleStatusFilterChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };
  const handleTypeFilterChange = (value: string) => {
    setTypeFilter(value);
    setPage(1);
  };

  // Refetch on page OR filter change. When a filter changes off page 1, the
  // batched setPage(1) + filter update produce a single render, so this runs
  // exactly once. On page 1, setPage(1) is a no-op but the filter dep still
  // triggers the refetch — fixing the "filter does nothing on page 1" bug.
  useEffect(() => {
    const controller = new AbortController();
    fetchJobs(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter, typeFilter]);

  const handleRetry = async (jobId: string) => {
    setRetrying(jobId);
    try {
      const res = await adminFetch(`/api/admin/jobs/${jobId}/retry`, {
        method: "POST",
      });
      if (res.ok) {
        fetchJobs();
      } else {
        const errData = await res.json().catch(() => ({}));
        toast({
          variant: "destructive",
          title: "Retry failed",
          description: errData.message || `Request failed (${res.status}).`,
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Retry failed",
        description:
          err instanceof Error ? err.message : "Network error. Please retry.",
      });
    } finally {
      setRetrying(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const startItem = (page - 1) * perPage + 1;
  const endItem = Math.min(page * perPage, total);

  if (forbidden) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Play className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
            Collection Jobs
          </h3>
        </div>
        <ForbiddenPanel />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <Play className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
          Collection Jobs
        </h3>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <Select value={statusFilter} onValueChange={handleStatusFilterChange}>
          <SelectTrigger className="w-[150px] rounded-xl h-10">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={handleTypeFilterChange}>
          <SelectTrigger className="w-[150px] rounded-xl h-10">
            <SelectValue placeholder="Job Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="profile">Profile</SelectItem>
            <SelectItem value="likes">Likes</SelectItem>
            <SelectItem value="follows">Follows</SelectItem>
            <SelectItem value="report">Report</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card className="border border-slate-200 shadow-sm">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : error && jobs.length === 0 ? (
            <div className="p-10 text-center text-slate-400">
              <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-amber-300" />
              <p>{error}</p>
            </div>
          ) : jobs.length === 0 ? (
            <div className="p-10 text-center text-slate-400">
              <Server className="w-10 h-10 mx-auto mb-3 text-slate-300" />
              <p>No jobs found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="font-semibold">
                      IG Username
                    </TableHead>
                    <TableHead className="font-semibold">Job Type</TableHead>
                    <TableHead className="font-semibold">Status</TableHead>
                    <TableHead className="font-semibold">Started</TableHead>
                    <TableHead className="font-semibold">Completed</TableHead>
                    <TableHead className="font-semibold">Error</TableHead>
                    <TableHead className="font-semibold text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => {
                    const statusCfg = JOB_STATUS_CONFIG[job.status] ??
                      JOB_STATUS_CONFIG.pending;
                    const StatusIcon = statusCfg.icon;
                    const typeCfg = JOB_TYPE_CONFIG[job.jobType] ?? {
                      label: job.jobType,
                      className: "bg-slate-100 text-slate-600",
                    };
                    return (
                      <TableRow
                        key={job.id}
                        className="hover:bg-slate-50/50"
                      >
                        <TableCell className="font-medium text-slate-800">
                          @{job.igUsername}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`text-xs font-bold px-2.5 py-1 rounded-full ${typeCfg.className}`}
                          >
                            {typeCfg.label}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold border ${statusCfg.className}`}
                          >
                            <StatusIcon
                              className={`w-3 h-3 ${
                                job.status === "running" ? "animate-spin" : ""
                              }`}
                            />
                            {statusCfg.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-slate-500 text-sm">
                          {formatDate(job.startedAt)}
                        </TableCell>
                        <TableCell className="text-slate-500 text-sm">
                          {formatDate(job.completedAt)}
                        </TableCell>
                        <TableCell>
                          {job.error ? (
                            <span
                              className="text-xs text-red-500 font-mono bg-red-50 px-2 py-1 rounded max-w-[200px] truncate block"
                              title={job.error}
                            >
                              {job.error}
                            </span>
                          ) : (
                            <span className="text-slate-300">--</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {job.status === "failed" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={retrying === job.id}
                              onClick={() => handleRetry(job.id)}
                              className="h-8 px-3 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            >
                              {retrying === job.id ? (
                                <RefreshCw className="w-4 h-4 animate-spin" />
                              ) : (
                                <>
                                  <RotateCcw className="w-4 h-4 mr-1" />
                                  Retry
                                </>
                              )}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {!loading && jobs.length > 0 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-sm text-slate-500">
            Showing {startItem}–{endItem} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="w-4 h-4 mr-1" /> Previous
            </Button>
            <span className="text-sm text-slate-500">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────

export default function AdminSystem() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.1 }}
      className="space-y-10"
    >
      <ScraperTransportSection />
      <QueueHealthSection />
      <CollectionJobsSection />
    </motion.div>
  );
}
