// ─── Admin Health page ──────────────────────────────────────────────────────
//
// Real-time observability for the bot scraping pipeline. Polls
// /api/admin/health every 5s and renders:
//   - overall status pill (green / yellow / red)
//   - bot pool table with per-bot status + recent login state
//   - per-endpoint 24h success rate bars
//   - BullMQ queue depths
//   - integration health badges (stripe / resend / smartproxy)
//
// All data is read-only. Mutations live on the existing /admin pages.

import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { RosterSyncProgress } from "@/components/RosterSyncProgress";
import type { BackgroundRosterView } from "../../../shared/roster-background";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  Clock,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Shield,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Navigation } from "@/components/Navigation";
import { adminFetch, formatRelative } from "./admin/shared";

// ─── Types (mirror server response) ─────────────────────────────────────────

type IntegrationStatus = "live" | "placeholder" | "missing";
type OverallStatus = "green" | "yellow" | "red";
type ScrapeOutcomeKind = "success" | "failure" | "checkpoint" | "rate_limit";

interface BotHealthRow {
  id: string;
  igUsername: string;
  status: string;
  lastLoginAt: string | null;
  lastLoginError: string | null;
  cooldownUntil: string | null;
  loginAttemptCount: number;
  hasSessionData: boolean;
  proxyEndpoint: string | null;
  proxyExpiresAt: string | null;
}

interface EndpointSnapshot {
  endpoint: string;
  attempts: number;
  successes: number;
  failures: number;
  // Local skips (daily-cap / disabled). Not counted in attempts, so they never
  // drag down the success rate. Optional for backward compatibility with an
  // older server that predates the field.
  skips?: number;
  lastErrorKind: ScrapeOutcomeKind | null;
}

interface QueueDepth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  error?: string;
}

interface IntegrationsHealth {
  stripe: IntegrationStatus;
  resend: IntegrationStatus;
  smartproxy: IntegrationStatus;
}

interface ProxyHealth {
  lastFetchAt: string | null;
  lastBatchHealthy: string;
  quotaRemaining: string | null;
}

interface HealthSnapshot {
  status: OverallStatus;
  generatedAt: string;
  bots: ReadonlyArray<BotHealthRow>;
  endpoints: ReadonlyArray<EndpointSnapshot>;
  queues: ReadonlyArray<QueueDepth>;
  integrations: IntegrationsHealth;
  proxy: ProxyHealth;
  collection?: {
    activeProfiles: number; staleFollowerRosters: number; staleFollowingRosters: number;
    rosterEligibleProfiles: number; awaitingApprovalProfiles: number; accessDeniedProfiles: number;
    missingProfileBaselines: number; blockedPrivateReaders: number; providerBlockedProfiles: number;
    excludedSubscriptionTrackings: number;
    postSuccessesLastHour: number; postFailuresLastHour: number;
    profiles: Array<{ trackingId: string; username: string; isPrivate: boolean; state: string; rosterEligible: boolean;
      followersCompleteAt: string | null; followingCompleteAt: string | null;
      followersFailureKind: string | null; followingFailureKind: string | null;
      followersRetryAt: string | null; followingRetryAt: string | null;
      backgroundFollowers?: BackgroundRosterView | null; backgroundFollowing?: BackgroundRosterView | null }>;
  };
  summary: {
    totalBots: number;
    activePoolBots?: number;
    leaseableBots?: number;
    shortLivedProxyBots?: number;
    /** Accounts parked out of the pool on purpose (status='disabled'). */
    retiredBots?: number;
    availableBots: number;
    warmSessionBots: number;
    rateLimitedBots: number;
    recoverableNoSessionBots: number;
    cooldownBots: number;
    bannedBots: number;
    sessionExpiredBots: number;
    visibleBotRows: number;
  };
}

// ─── Status configs ─────────────────────────────────────────────────────────

interface StatusVisual {
  label: string;
  className: string;
  icon: typeof CheckCircle2;
}

const OVERALL_STATUS_VISUAL: Record<OverallStatus, StatusVisual> = {
  green: {
    label: "Healthy",
    className: "bg-emerald-100 text-emerald-700 border-emerald-200",
    icon: CheckCircle2,
  },
  yellow: {
    label: "Degraded",
    className: "bg-amber-100 text-amber-700 border-amber-200",
    icon: AlertTriangle,
  },
  red: {
    label: "Critical",
    className: "bg-red-100 text-red-700 border-red-200",
    icon: ShieldAlert,
  },
};

const BOT_STATUS_VISUAL: Record<string, StatusVisual> = {
  available: {
    label: "Available",
    className: "bg-emerald-100 text-emerald-700 border-emerald-200",
    icon: CheckCircle2,
  },
  in_use: {
    label: "In Use",
    className: "bg-blue-100 text-blue-700 border-blue-200",
    icon: Activity,
  },
  cooldown: {
    label: "Cooldown",
    className: "bg-amber-100 text-amber-700 border-amber-200",
    icon: Clock,
  },
  disabled: {
    label: "Disabled",
    className: "bg-slate-100 text-slate-500 border-slate-200",
    icon: EyeOff,
  },
  banned: {
    label: "Banned",
    className: "bg-red-100 text-red-700 border-red-200",
    icon: Ban,
  },
  session_expired: {
    label: "Session Expired",
    className: "bg-orange-100 text-orange-700 border-orange-200",
    icon: KeyRound,
  },
};

const INTEGRATION_VISUAL: Record<IntegrationStatus, StatusVisual> = {
  live: {
    label: "Configured",
    className: "bg-emerald-100 text-emerald-700 border-emerald-200",
    icon: CheckCircle2,
  },
  placeholder: {
    label: "Placeholder",
    className: "bg-amber-100 text-amber-700 border-amber-200",
    icon: AlertTriangle,
  },
  missing: {
    label: "Missing",
    className: "bg-red-100 text-red-700 border-red-200",
    icon: Ban,
  },
};

function getBotVisual(status: string): StatusVisual {
  return (
    BOT_STATUS_VISUAL[status] ?? {
      label: status,
      className: "bg-slate-100 text-slate-600 border-slate-200",
      icon: EyeOff,
    }
  );
}

function successRate(snap: EndpointSnapshot): number {
  if (snap.attempts === 0) return 1;
  return snap.successes / snap.attempts;
}

/**
 * Endpoint health verdict from the success ratio.
 *
 * Thresholds match rateColor so the bar and the pill can never disagree —
 * a green bar beside a red "FAILURE" chip is what made this panel untrustworthy.
 */
// A ratio over a handful of attempts is noise, not a health signal. Tagged at
// 1/3 and Highlights at 4/7 both rendered a red "FAILING" pill while the pool
// was demonstrably fine — one failure moves a 3-sample rate by 33 points. This
// bit hardest right after an outage, when the rolling window has barely any
// data in it and every low-volume endpoint lights up red at once.
//
// Below this floor we report LOW DATA instead of inventing a verdict.
const MIN_VERDICT_ATTEMPTS = 20;

function endpointVerdictLabel(rate: number, attempts: number): string {
  if (attempts < MIN_VERDICT_ATTEMPTS) return "LOW DATA";
  if (rate >= 0.9) return "OK";
  if (rate >= 0.7) return "DEGRADED";
  return "FAILING";
}

function endpointVerdictClass(rate: number, attempts: number): string {
  if (attempts < MIN_VERDICT_ATTEMPTS)
    return "bg-slate-50 text-slate-500 border-slate-200";
  if (rate >= 0.9) return "bg-emerald-50 text-emerald-700 border-emerald-100";
  if (rate >= 0.7) return "bg-amber-50 text-amber-700 border-amber-100";
  return "bg-red-50 text-red-600 border-red-100";
}

// The bar must agree with the pill beside it. It used to carry its own
// thresholds (0.95 / 0.8) and its own idea of "no data" (attempts === 0), so a
// row could read a grey "LOW DATA" pill next to a blood-red bar (Comments at
// 3/5), or an amber "DEGRADED" pill next to a red bar (Likers at 78%). Two
// controls describing the same number disagreed, and the louder one — colour —
// won. Same floor, same cutoffs as endpointVerdictLabel.
function rateColor(rate: number, attempts: number): string {
  if (attempts < MIN_VERDICT_ATTEMPTS) return "bg-slate-200";
  if (rate >= 0.9) return "bg-emerald-500";
  if (rate >= 0.7) return "bg-amber-400";
  return "bg-red-500";
}

// ─── Sub-components ─────────────────────────────────────────────────────────

interface OverallStatusCardProps {
  readonly snapshot: HealthSnapshot;
}

function OverallStatusCard({ snapshot }: OverallStatusCardProps) {
  const visual = OVERALL_STATUS_VISUAL[snapshot.status];
  const Icon = visual.icon;
  const generatedAt = new Date(snapshot.generatedAt);
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center border ${visual.className}`}>
              <Icon className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Pool status</p>
              <h2 className="text-3xl font-bold tracking-tight text-slate-900">
                {visual.label}
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Updated {generatedAt.toLocaleTimeString()}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {/*
              "Total" counted the ~747 accounts retired on purpose in August, so
              "1035 total / 91 available" read as a catastrophic pool failure.
              Show the ACTIVE pool as the headline and the retired archive
              separately, so the tiles actually add up.
            */}
            <SummaryStat
              label="Active pool"
              value={snapshot.summary.activePoolBots ?? snapshot.summary.totalBots - (snapshot.summary.retiredBots ?? 0)}
            />
            <SummaryStat
              label="Retired"
              value={snapshot.summary.retiredBots ?? 0}
            />
            <SummaryStat
              label="Available"
              value={snapshot.summary.availableBots}
              tone="emerald"
            />
            <SummaryStat
              label="Leaseable"
              value={snapshot.summary.leaseableBots ?? 0}
              tone="emerald"
            />
            <SummaryStat
              label="Session ready"
              value={snapshot.summary.warmSessionBots}
              tone="emerald"
            />
            <SummaryStat
              label="Recoverable"
              value={snapshot.summary.recoverableNoSessionBots}
              tone="amber"
            />
            <SummaryStat
              label="Rate Limited"
              value={snapshot.summary.rateLimitedBots}
              tone="red"
            />
            <SummaryStat
              label="Cooldown"
              value={snapshot.summary.cooldownBots}
              tone="amber"
            />
            <SummaryStat
              label="Session Exp."
              value={snapshot.summary.sessionExpiredBots}
              tone="orange"
            />
            <SummaryStat
              label="Banned"
              value={snapshot.summary.bannedBots}
              tone="red"
            />
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-4">Active pool means worker/canary tiers. Status subsets overlap; available does not mean leaseable. Endpoint caps and permissions still apply.</p>
        {(snapshot.summary.shortLivedProxyBots ?? 0) > 0 && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 mt-3">
            {snapshot.summary.shortLivedProxyBots} available bots use proxy gateways whose exit IP can change within 120 minutes. A saved proxy address does not guarantee a fixed IP. Review these assignments when investigating repeated session challenges.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface SummaryStatProps {
  readonly label: string;
  readonly value: number;
  readonly tone?: "emerald" | "amber" | "orange" | "red";
}

function SummaryStat({ label, value, tone }: SummaryStatProps) {
  const toneClass: Record<NonNullable<SummaryStatProps["tone"]>, string> = {
    emerald: "text-emerald-600",
    amber: "text-amber-600",
    orange: "text-orange-600",
    red: "text-red-600",
  };
  const valueClass = tone ? toneClass[tone] : "text-slate-900";
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2 border border-slate-100 text-center">
      <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

interface EndpointBarsProps {
  readonly endpoints: ReadonlyArray<EndpointSnapshot>;
}

function EndpointBars({ endpoints }: EndpointBarsProps) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-slate-500" />
          Endpoint Success Rate (24h)
        </CardTitle>
        <CardDescription>
          Rolling success ratio across the bot pool, per IG endpoint.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {endpoints.map((snap) => {
          const rate = successRate(snap);
          const pct = Math.round(rate * 100);
          return (
            <div key={snap.endpoint} className="grid grid-cols-12 items-center gap-3">
              <div className="col-span-3 text-sm font-medium text-slate-700 capitalize">
                {snap.endpoint}
              </div>
              <div className="col-span-6 h-3 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full ${rateColor(rate, snap.attempts)} transition-all duration-500`}
                  style={{ width: `${snap.attempts === 0 ? 0 : pct}%` }}
                />
              </div>
              <div className="col-span-3 flex items-center justify-end gap-2 text-xs text-slate-500">
                <span className="font-mono text-slate-700">
                  {snap.attempts === 0 ? "—" : `${pct}%`}
                </span>
                <span className="text-slate-400">
                  {snap.successes}/{snap.attempts}
                </span>
                {snap.skips ? (
                  <span
                    className="text-slate-400"
                    title="Local skips (daily-cap or disabled); no IG call made"
                  >
                    +{snap.skips} skip
                  </span>
                ) : null}
                {/*
                  Show a HEALTH VERDICT, not the last error's kind.
                  This pill used to render `lastErrorKind` verbatim, so an
                  endpoint at 92% (12/13) displayed a red "FAILURE" because its
                  single failure happened to be of kind "failure". Every healthy
                  endpoint looked broken and the dashboard cried wolf. The error
                  kind is still useful, but as a tooltip on a muted chip.
                */}
                {snap.attempts > 0 ? (
                  <span
                    className={`px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wide ${endpointVerdictClass(rate, snap.attempts)}`}
                    title={
                      snap.attempts < MIN_VERDICT_ATTEMPTS
                        ? `only ${snap.attempts} attempt(s) in window — too few to judge`
                        : snap.lastErrorKind
                          ? `last error: ${snap.lastErrorKind}`
                          : "no recent errors"
                    }
                  >
                    {endpointVerdictLabel(rate, snap.attempts)}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface QueueDepthsCardProps {
  readonly queues: ReadonlyArray<QueueDepth>;
}

function QueueDepthsCard({ queues }: QueueDepthsCardProps) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-slate-500" />
          Queue Depths
        </CardTitle>
        <CardDescription>BullMQ collection + follow-request queues.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {queues.map((q) => (
            <div
              key={q.name}
              className="rounded-xl border border-slate-100 bg-white p-4 hover:border-slate-200 transition"
            >
              <p className="text-xs uppercase tracking-wide text-slate-400">
                {q.name}
              </p>
              <p className="text-3xl font-bold text-slate-900 mt-1">
                {q.error ? "Unknown" : q.waiting + q.active}
              </p>
              {q.error ? <p className="mt-3 text-xs text-red-600" role="alert">{q.error}</p> : <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Waiting</span>
                  <span className="font-mono text-slate-700">{q.waiting}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Active</span>
                  <span className="font-mono text-blue-600">{q.active}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Delayed</span>
                  <span className="font-mono text-slate-700">{q.delayed}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Failed</span>
                  <span
                    className={`font-mono ${q.failed > 0 ? "text-red-600" : "text-slate-700"}`}
                  >
                    {q.failed}
                  </span>
                </div>
              </div>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface IntegrationsCardProps {
  readonly integrations: IntegrationsHealth;
  readonly proxy: ProxyHealth;
}

function IntegrationsCard({ integrations, proxy }: IntegrationsCardProps) {
  const rows: ReadonlyArray<{ key: string; label: string; status: IntegrationStatus }> = [
    { key: "stripe", label: "Stripe", status: integrations.stripe },
    { key: "resend", label: "Resend", status: integrations.resend },
    { key: "smartproxy", label: "Proxy provider", status: integrations.smartproxy },
  ];
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-slate-500" />
          Integrations
        </CardTitle>
        <CardDescription>External provider configuration state.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row) => {
          const visual = INTEGRATION_VISUAL[row.status];
          const Icon = visual.icon;
          return (
            <div
              key={row.key}
              className="flex items-center justify-between rounded-xl border border-slate-100 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <Icon className="w-4 h-4 text-slate-500" />
                <span className="font-medium text-slate-700">{row.label}</span>
              </div>
              <Badge variant="outline" className={visual.className}>
                {visual.label}
              </Badge>
            </div>
          );
        })}
        <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3 text-xs text-slate-600 space-y-1">
          <p className="font-medium text-slate-700">Proxy provider</p>
          {/* These three come back hardcoded null/"unknown": the provider exposes
              no quota or batch API to us (see the TODO in admin-routes.ts). The
              old labels rendered that as "Last fetch: Never" / "unknown", which
              reads like a provider outage rather than "we do not track this" —
              the same cry-wolf problem the endpoint pills had. Say not tracked. */}
          <p>
            Last fetch:{" "}
            <span className="font-mono">
              {proxy.lastFetchAt ? formatRelative(proxy.lastFetchAt) : "not tracked"}
            </span>
          </p>
          <p>
            Last batch healthy:{" "}
            <span className="font-mono">
              {proxy.lastBatchHealthy === "unknown"
                ? "not tracked"
                : proxy.lastBatchHealthy}
            </span>
          </p>
          <p>
            Quota remaining:{" "}
            <span className="font-mono">
              {proxy.quotaRemaining ?? "not tracked (no provider API)"}
            </span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

interface BotsTableProps {
  readonly bots: ReadonlyArray<BotHealthRow>;
  readonly totalBots: number;
}

function BotsTable({ bots, totalBots }: BotsTableProps) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingDown className="w-5 h-5 text-slate-500" />
          Bot Pool
        </CardTitle>
        <CardDescription>
          Showing newest {bots.length.toLocaleString()} of{" "}
          {totalBots.toLocaleString()} bot{totalBots === 1 ? "" : "s"} •
          updated live every 5s
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead>Login Attempts</TableHead>
                <TableHead>Cooldown</TableHead>
                <TableHead>Session</TableHead>
                <TableHead>Proxy</TableHead>
                <TableHead>Last Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bots.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-slate-400 py-8">
                    No bots in pool.
                  </TableCell>
                </TableRow>
              ) : (
                bots.map((bot) => {
                  const visual = getBotVisual(bot.status);
                  const Icon = visual.icon;
                  return (
                    <TableRow key={bot.id}>
                      <TableCell className="font-mono text-sm">@{bot.igUsername}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`${visual.className} gap-1`}>
                          <Icon className="w-3 h-3" />
                          {visual.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {formatRelative(bot.lastLoginAt)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span
                          className={
                            bot.loginAttemptCount > 3
                              ? "font-bold text-red-600"
                              : "text-slate-700"
                          }
                        >
                          {bot.loginAttemptCount}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {bot.cooldownUntil ? formatRelative(bot.cooldownUntil) : "—"}
                      </TableCell>
                      <TableCell>
                        {bot.hasSessionData ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        ) : (
                          <Ban className="w-4 h-4 text-red-500" />
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {bot.proxyEndpoint ? (
                          <div className="flex flex-col">
                            <span className="font-mono text-slate-700">
                              {bot.proxyEndpoint}
                            </span>
                            {bot.proxyExpiresAt ? (
                              <span className="text-[10px] text-slate-400">
                                expires {formatRelative(bot.proxyExpiresAt)}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate text-xs text-red-600">
                        {bot.lastLoginError ?? ""}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Page component ─────────────────────────────────────────────────────────

export default function AdminHealth() {
  const [, setLocation] = useLocation();
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const requestSequence = useRef(0);

  const fetchHealth = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++requestSequence.current;
      try {
        const res = await adminFetch("/api/admin/health", { signal });
        if (sequence !== requestSequence.current || signal?.aborted) return;
        if (res.status === 401) {
          setLocation("/auth");
          return;
        }
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as HealthSnapshot;
        if (sequence !== requestSequence.current || signal?.aborted) return;
        setSnapshot(json);
        setError("");
      } catch (err) {
        if (sequence !== requestSequence.current || signal?.aborted) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setError("Failed to refresh health. Displayed data may be out of date.");
      } finally {
        if (sequence === requestSequence.current && !signal?.aborted) setLoading(false);
      }
    },
    [setLocation],
  );

  useEffect(() => {
    // Once the user is known to be unauthorized (403), stop polling entirely.
    // A 401 redirects to /auth and the page unmounts; 403 renders the
    // "Access Denied" state below — in neither case should we keep hammering
    // /api/admin/health every 5s.
    if (forbidden) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await fetchHealth(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      controller.abort();
      requestSequence.current += 1;
      clearTimeout(timer);
    };
  }, [fetchHealth, forbidden]);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-slate-50">
        <Navigation />
        <main className="container mx-auto px-4 pt-32 text-center">
          <div className="max-w-md mx-auto">
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
              <Shield className="w-8 h-8 text-red-500" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Access Denied</h1>
            <p className="text-slate-500 mb-6">
              You do not have admin privileges to access this page.
            </p>
            <Button onClick={() => setLocation("/members")} className="rounded-xl">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back
            </Button>
          </div>
        </main>
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
          <p className="text-slate-400 text-sm">Loading health snapshot...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-20">
      <title>Health — CheaterFinder Admin</title>
      <Navigation />
      <main className="container mx-auto px-4 pt-24 max-w-7xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">
              System Health
            </h1>
            <p className="text-slate-500 mt-1">
              Real-time observability for the bot scraping pipeline.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchHealth()}
              className="rounded-xl"
            >
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLocation("/admin")}
              className="rounded-xl"
            >
              <ArrowLeft className="w-4 h-4 mr-2" /> Admin
            </Button>
          </div>
        </div>

        {error ? (
          <Card className="rounded-2xl border-red-200 bg-red-50 mb-6">
            <CardContent className="p-4 text-sm text-red-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </CardContent>
          </Card>
        ) : null}

        {snapshot ? (
          <div className="space-y-6">
            <OverallStatusCard snapshot={snapshot} />
            {snapshot.collection && <Card className="rounded-2xl" data-testid="roster-health">
              <CardHeader><CardTitle>Collection freshness</CardTitle>
                <CardDescription>Complete roster reads, not successful page requests. A recent health refresh is not proof that Instagram data is current.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className={snapshot.collection.staleFollowerRosters || snapshot.collection.staleFollowingRosters ? "text-amber-700" : "text-slate-600"}>
                  {snapshot.collection.staleFollowerRosters}/{snapshot.collection.rosterEligibleProfiles} eligible follower rosters and {snapshot.collection.staleFollowingRosters}/{snapshot.collection.rosterEligibleProfiles} eligible following rosters have no complete read within 48h.
                </p>
                <p className="text-sm text-slate-600">{snapshot.collection.activeProfiles} active collection targets with current subscription access. Private tracking is evaluated separately for each customer.</p>
                <ul className="text-sm text-amber-700 space-y-1" data-testid="collection-blockers">
                  {!!snapshot.collection.awaitingApprovalProfiles && <li>{snapshot.collection.awaitingApprovalProfiles} awaiting private-account approval.</li>}
                  {!!snapshot.collection.accessDeniedProfiles && <li>{snapshot.collection.accessDeniedProfiles} with private-account access denied.</li>}
                  {!!snapshot.collection.missingProfileBaselines && <li>{snapshot.collection.missingProfileBaselines} awaiting an initial profile baseline; roster collection cannot begin yet.</li>}
                  {!!snapshot.collection.blockedPrivateReaders && <li>{snapshot.collection.blockedPrivateReaders} with no healthy approved private reader available, including readers in cooldown.</li>}
                  {!!snapshot.collection.providerBlockedProfiles && <li>{snapshot.collection.providerBlockedProfiles} with unresolved roster provider failures or limits.</li>}
                </ul>
                <p className="text-xs text-slate-500">Waiting or blocked targets keep health degraded. Approved targets with a profile baseline remain in the freshness count during reader cooldowns; blocker counts can overlap.</p>
                {!!snapshot.collection.excludedSubscriptionTrackings && <p className="text-xs text-slate-500">{snapshot.collection.excludedSubscriptionTrackings} active tracking rows are excluded because their subscriptions do not currently grant collection access.</p>}
                <p className="text-sm text-slate-600">Posts reads in the last hour: {snapshot.collection.postSuccessesLastHour} successful / {snapshot.collection.postFailuresLastHour} failed.</p>
                <div className="overflow-x-auto"><table className="w-full text-sm text-left">
                  <thead><tr><th className="py-2 pr-4">Profile</th><th className="pr-4">Followers: last complete read</th><th>Following: last complete read</th></tr></thead>
                  <tbody>{snapshot.collection.profiles.map(p => <tr key={p.trackingId} className="border-t border-slate-100">
                    <td className="py-2 pr-4">@{p.username}<span className="block text-xs text-slate-500">{({awaiting_approval:"Awaiting private approval",access_denied:"Private access denied",awaiting_profile:"Initial profile baseline needed",reader_unavailable:"Approved reader unavailable or cooling",provider_blocked:"Provider failure or limit",eligible:"Eligible for collection"} as Record<string,string>)[p.state] ?? "Collection state unknown"}</span></td>
                    <td className="pr-4 py-2 min-w-64">{p.followersCompleteAt ? new Date(p.followersCompleteAt).toLocaleString() : p.rosterEligible ? "No complete read yet" : "Not available"}
                      {p.followersFailureKind && <p className="text-xs text-amber-700">Roster failure: {p.followersFailureKind.replaceAll("_", " ")}{p.followersRetryAt ? `; retry after ${new Date(p.followersRetryAt).toLocaleString()}` : ""}</p>}
                      <RosterSyncProgress label="Follower roster" progress={p.backgroundFollowers} /></td>
                    <td className="py-2 min-w-64">{p.followingCompleteAt ? new Date(p.followingCompleteAt).toLocaleString() : p.rosterEligible ? "No complete read yet" : "Not available"}
                      {p.followingFailureKind && <p className="text-xs text-amber-700">Roster failure: {p.followingFailureKind.replaceAll("_", " ")}{p.followingRetryAt ? `; retry after ${new Date(p.followingRetryAt).toLocaleString()}` : ""}</p>}
                      <RosterSyncProgress label="Following roster" progress={p.backgroundFollowing} /></td>
                  </tr>)}</tbody>
                </table></div>
              </CardContent>
            </Card>}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <EndpointBars endpoints={snapshot.endpoints} />
              </div>
              <IntegrationsCard
                integrations={snapshot.integrations}
                proxy={snapshot.proxy}
              />
            </div>
            <QueueDepthsCard queues={snapshot.queues} />
            <BotsTable
              bots={snapshot.bots}
              totalBots={snapshot.summary.totalBots}
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
