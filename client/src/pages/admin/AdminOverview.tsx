import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { adminFetch, type AdminOverviewData } from "./shared";
import { ForbiddenPanel } from "./ForbiddenPanel";

const CARD =
  "rounded-xl border border-slate-200/60 bg-white shadow-[0_2px_8px_rgb(0,0,0,0.04)]";

// ─── Presentational primitives ───────────────────────────────────────────────

interface Segment {
  label: string;
  value: number;
  bar: string;
  alert?: boolean;
}

function KpiTile({
  label,
  value,
  caption,
  loading,
  edges,
}: {
  label: string;
  value: number;
  caption: string;
  loading: boolean;
  edges: string;
}) {
  return (
    <div className={`px-5 py-5 md:px-6 md:py-6 ${edges}`}>
      <p className="text-sm font-medium text-slate-500">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-20" />
      ) : (
        <p className="mt-1.5 font-display text-3xl font-bold leading-none tabular-nums text-slate-900">
          {value.toLocaleString()}
        </p>
      )}
      <p className="mt-2 text-xs text-slate-400">{caption}</p>
    </div>
  );
}

function SegmentBar({ segments }: { segments: readonly Segment[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const summary = segments
    .filter((s) => s.value > 0)
    .map((s) => `${s.label} ${s.value}`)
    .join(", ");

  if (total <= 0) {
    return <div className="h-2 w-full rounded-full bg-slate-100" />;
  }
  return (
    <div
      role="img"
      aria-label={summary}
      className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100"
    >
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.label}
            className={s.bar}
            style={{ width: `${(s.value / total) * 100}%` }}
          />
        ))}
    </div>
  );
}

function PoolBar({
  segments,
  loading,
}: {
  segments: readonly Segment[];
  loading: boolean;
}) {
  return (
    <div>
      <SegmentBar segments={segments} />
      <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2.5">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.bar}`} />
            <dt className="truncate text-xs text-slate-500">{s.label}</dt>
            <dd
              className={`ml-auto text-xs font-semibold tabular-nums ${
                s.alert && s.value > 0 ? "text-red-600" : "text-slate-800"
              }`}
            >
              {loading ? "—" : s.value.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Panel({
  title,
  meta,
  className = "",
  children,
}: {
  title: string;
  meta?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`${CARD} ${className}`}>
      <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <h2 className="font-display text-sm font-semibold text-slate-900">
          {title}
        </h2>
        {meta && (
          <span className="shrink-0 text-xs tabular-nums text-slate-400">
            {meta}
          </span>
        )}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1 px-4 first:pl-0 last:pr-0">
      <p className="font-display text-xl font-bold tabular-nums text-slate-900">
        {value}
      </p>
      <p className="mt-0.5 truncate text-xs text-slate-400">{label}</p>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AdminOverview() {
  const [, setLocation] = useLocation();
  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const requestSequence = useRef(0);

  const fetchData = async (signal?: AbortSignal) => {
    const request = ++requestSequence.current;
    const current = () => !signal?.aborted && request === requestSequence.current;
    try {
      setLoading(true);
      const res = await adminFetch("/api/admin/overview", { signal, cache: "no-store" });
      if (!current()) return;
      if (res.status === 401) {
        setLocation("/auth");
        return;
      }
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch overview");
      const json = (await res.json()) as AdminOverviewData;
      if (!current()) return;
      setData(json);
      setUpdatedAt(new Date());
      setForbidden(false);
      setError("");
    } catch (err) {
      if (!current()) return;
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Failed to load overview data.");
    } finally {
      if (current()) setLoading(false);
    }
  };

  useEffect(() => {
    const currentController = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await fetchData(currentController.signal);
      if (!currentController.signal.aborted) timer = setTimeout(poll, 15_000);
    };
    void poll();

    return () => {
      currentController.abort();
      clearTimeout(timer);
    };
  }, []);

  if (forbidden) return <ForbiddenPanel />;

  if (error && !data) {
    return (
      <div className={`${CARD} p-10 text-center`}>
        <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-400" />
        <p className="text-slate-500">{error}</p>
      </div>
    );
  }

  const d = data;
  // Skeletons only on the very first load. The 15s poll flips `loading` back
  // to true with `data` already populated — keep the real values on screen.
  const showSkeleton = loading && !data;

  const ev = d?.events;
  const bots = d?.bots;
  const subs = d?.subscriptions;
  const jobs = d?.jobs;
  const tracked = d?.trackedAccounts;
  const count = (value: number | undefined): string =>
    showSkeleton ? "—" : (value ?? 0).toLocaleString();

  const kpis = [
    { label: "Likes detected", value: ev?.likesLast24h ?? 0, caption: `${count(ev?.totalLikes)} all time` },
    { label: "Accounts followed", value: ev?.followsLast24h ?? 0, caption: `${count(ev?.totalFollows)} all time` },
    { label: "Accounts unfollowed", value: ev?.unfollowsLast24h ?? 0, caption: `${count(ev?.totalUnfollows)} all time` },
    { label: "Followers gained", value: ev?.followersLast24h ?? 0, caption: `${count(ev?.totalFollowers)} all time` },
    { label: "Followers lost", value: ev?.followerUnfollowsLast24h ?? 0, caption: `${count(ev?.totalFollowerUnfollows)} all time` },
    { label: "Active tracked", value: tracked?.active ?? 0, caption: `of ${count(tracked?.total)} accounts` },
  ] as const;

  const poolSegments: readonly Segment[] = [
    { label: "Available", value: bots?.available ?? 0, bar: "bg-emerald-500" },
    { label: "In use", value: bots?.inUse ?? 0, bar: "bg-primary" },
    { label: "Cooldown", value: bots?.cooldown ?? 0, bar: "bg-sky-400" },
    { label: "Session expired", value: bots?.sessionExpired ?? 0, bar: "bg-amber-400" },
    { label: "Banned", value: bots?.banned ?? 0, bar: "bg-red-500", alert: true },
    { label: "Disabled", value: bots?.disabled ?? 0, bar: "bg-slate-300" },
  ];

  const planSegments: readonly Segment[] = [
    { label: "Starter", value: subs?.starterPlan ?? 0, bar: "bg-slate-300" },
    { label: "Standard", value: subs?.standardPlan ?? 0, bar: "bg-sky-400" },
    { label: "Pro", value: subs?.proPlan ?? 0, bar: "bg-primary" },
    { label: "Legacy", value: subs?.legacyPlans ?? 0, bar: "bg-slate-200" },
  ];

  // Colour is semantic: amber = needs attention, red = failing, slate = inert.
  const warn = (value: number) => (value > 0 ? "text-amber-600" : "text-slate-900");
  const fail = (value: number) => (value > 0 ? "text-red-600" : "text-slate-900");

  const subsCells = [
    { label: "Active", value: count(subs?.active), tone: "text-slate-900" },
    { label: "Trialing", value: count(subs?.trialing), tone: "text-slate-900" },
    { label: "Past due", value: count(subs?.pastDue), tone: warn(subs?.pastDue ?? 0) },
    { label: "Canceled", value: count(subs?.canceled), tone: "text-slate-500" },
  ];

  const jobRows = [
    { label: "Running", value: count(jobs?.running), tone: "text-slate-900" },
    { label: "Pending", value: count(jobs?.pending), tone: "text-slate-900" },
    { label: "Failed (24h)", value: count(jobs?.failedLast24h), tone: fail(jobs?.failedLast24h ?? 0) },
    { label: "Completed", value: count(jobs?.completed), tone: "text-slate-500" },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      {error && data && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Overview refresh failed. Displayed data may be out of date.</p>}
      {/* The five Activity categories plus the number of active tracked rows. */}
      <section className="rounded-2xl border border-slate-200/60 bg-white shadow-[0_2px_8px_rgb(0,0,0,0.04)]">
        <div className="flex items-baseline justify-between gap-3 px-5 pt-4 md:px-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Detected in the last 24 hours
          </h2>
          <span className="shrink-0 text-xs tabular-nums text-slate-400">
            {updatedAt
              ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Loading"}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3">
          {kpis.map((kpi, index) => (
            <KpiTile
              key={kpi.label}
              label={kpi.label}
              value={kpi.value}
              caption={kpi.caption}
              loading={showSkeleton}
              edges={[
                "border-slate-200/70",
                index % 2 === 1 ? "border-l" : "",
                index >= 2 ? "border-t" : "",
                index >= 3 ? "md:border-t" : "md:border-t-0",
                index % 3 > 0 ? "md:border-l" : "md:border-l-0",
              ].join(" ")}
            />
          ))}
        </div>
      </section>

      {/* Bento row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Panel title="Bot pool" meta={`${count(bots?.total)} bots`} className="lg:col-span-5">
          <div className="mb-5 flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold tabular-nums text-slate-900">
              {count(bots?.available)}
            </span>
            <span className="text-sm text-slate-500">with available status</span>
          </div>
          <PoolBar segments={poolSegments} loading={showSkeleton} />
          <p className="mt-3 text-xs text-slate-400">Status counts include retired bots. Available status may still have a timed cooldown; System Health shows actual leaseable capacity.</p>
        </Panel>

        <Panel title="Subscriptions" meta={`${count(subs?.total)} total`} className="lg:col-span-4">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-slate-200/70">
            {subsCells.map((cell) => (
              <div key={cell.label} className="bg-white px-3.5 py-3">
                <p className={`font-display text-lg font-bold tabular-nums ${cell.tone}`}>
                  {cell.value}
                </p>
                <p className="text-xs text-slate-400">{cell.label}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400">
            Plan mix
          </p>
          <div className="mt-2">
            <SegmentBar segments={planSegments} />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1.5">
            {planSegments.map((plan) => (
              <span
                key={plan.label}
                className="inline-flex items-center gap-1.5 text-[11px] text-slate-500"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${plan.bar}`} />
                {plan.label}
                <b className="font-semibold tabular-nums text-slate-700">
                  {count(plan.value)}
                </b>
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="Jobs" className="lg:col-span-3">
          <dl className="divide-y divide-slate-100">
            {jobRows.map((row) => (
              <div
                key={row.label}
                className="flex items-baseline justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <dt className="text-sm text-slate-500">{row.label}</dt>
                <dd className={`font-display text-base font-semibold tabular-nums ${row.tone}`}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      {/* Secondary row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="Users">
          <div className="flex divide-x divide-slate-200/70">
            <StatCell label="Total" value={count(d?.users.total)} />
            <StatCell label="New this week" value={count(d?.users.newThisWeek)} />
            <StatCell label="Updated 30d" value={count(d?.users.activeThisMonth)} />
          </div>
        </Panel>

        <Panel title="Tracked accounts">
          <div className="flex divide-x divide-slate-200/70">
            <StatCell label="Total" value={count(tracked?.total)} />
            <StatCell label="Active" value={count(tracked?.active)} />
            <StatCell label="Private" value={count(tracked?.private)} />
            <StatCell label="Pending access" value={count(tracked?.pendingAccess)} />
          </div>
        </Panel>
      </div>
    </motion.div>
  );
}
