// The detailed body of a weekly/monthly report card.
//
// Replaces four bare numbers (New followers / Unfollows / Likes / Peak hour)
// with the full stored payload: a written summary, growth taken from Instagram's
// own follower count, publishing performance, activity, and interests.
//
// Two rules drive everything here:
//
//  1. NEVER print a number the client can disprove. reports.total_follows /
//     total_unfollows come from event tables that also record roster DISCOVERY,
//     which is why cards once claimed "+3,251 new followers" for an account with
//     674 followers. Growth is therefore read from profile snapshots
//     (`netFollowerChange`), and gross follow/unfollow counts are shown only
//     when the server vouches for them via the trustworthy flags.
//
//  2. Say what it MEANS, not just what it is. Every figure gets a plain-English
//     line, because a wall of digits is not a client report.

import { useEffect, useState } from "react";
import { proxyUrl } from "@/lib/img-proxy";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Heart,
  Clock,
  Image as ImageIcon,
  Users,
  Sparkles,
  Hash,
  AtSign,
  ChevronDown,
} from "lucide-react";

// ── Payload (mirrors ReportMetrics in server/services/report-data.ts) ────────

interface Counter {
  label: string;
  count: number;
}

interface ActivityAccount {
  username: string;
  displayName: string | null;
  detectedAt: string;
}

export interface ReportMetrics {
  summary: {
    totalLikes: number;
    followersDetected: number;
    followersLost: number;
    netFollowerChange: number | null;
    followerEventsTrustworthy: boolean;
    accountsFollowed: number;
    accountsUnfollowed: number;
    netFollowingChange: number | null;
    followingEventsTrustworthy: boolean;
  };
  profile: {
    followerCountStart: number | null;
    followerCountEnd: number | null;
    followingCountStart: number | null;
    followingCountEnd: number | null;
    postCountEnd: number | null;
  };
  ownPosts: {
    publishedInPeriod: number;
    totalOnProfile: number | null;
    avgLikes: number | null;
    avgComments: number | null;
    engagementRatePct: number | null;
  };
  content: { activeStories: number; highlights: number };
  previous: {
    totalLikes: number;
    netFollowerChange: number | null;
    accountsUnfollowed: number;
    accountsFollowed: number;
    followingEventsTrustworthy?: boolean;
  };
  peakActivityHour: number | null;
  topHashtags: Counter[];
  topInterests?: Counter[];
  interestBasis?: "hashtags" | "caption_keywords" | "post_formats";
  topLikedAccounts: Counter[];
  likesLeaderboard: { username: string; count: number; thumbnails: string[] }[];
  followedAccounts?: ActivityAccount[];
  unfollowedAccounts?: ActivityAccount[];
  dailySeries: { date: string; followers: number; following: number }[];
}

// ── Formatting helpers ──────────────────────────────────────────────────────

const n = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : v.toLocaleString();

const signed = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return "—";
  return v > 0 ? `+${v.toLocaleString()}` : v.toLocaleString();
};

function hourLabel(hour: number | null): string | null {
  if (hour === null || hour < 0 || hour > 23) return null;
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
}

/** Tone for a delta where up is good. */
function toneFor(v: number | null): "up" | "down" | "flat" {
  if (v === null || v === 0) return "flat";
  return v > 0 ? "up" : "down";
}

// ── The written summary ─────────────────────────────────────────────────────
//
// "kuch text bhi nahi" — a client should be able to read the week, not decode a
// grid. Composed from whatever is actually trustworthy, so it never asserts
// something the numbers don't support.
function buildNarrative(
  m: ReportMetrics,
  username: string,
  periodType: string,
): string {
  const parts: string[] = [];
  const net = m.summary.netFollowerChange;
  const end = m.profile.followerCountEnd;
  const periodLabel = periodType === "monthly" ? "this month" : "this week";
  const previousLabel = periodType === "monthly" ? "last month" : "last week";

  if (net === null) {
    parts.push(
      `We didn't capture enough profile snapshots ${periodLabel} to measure @${username}'s follower growth reliably.`,
    );
  } else if (net > 0) {
    parts.push(
      `@${username} grew by ${net.toLocaleString()} follower${net === 1 ? "" : "s"} ${periodLabel}${
        end !== null ? `, finishing at ${end.toLocaleString()}` : ""
      }.`,
    );
  } else if (net < 0) {
    parts.push(
      `@${username} lost ${Math.abs(net).toLocaleString()} follower${
        Math.abs(net) === 1 ? "" : "s"
      } ${periodLabel}${end !== null ? `, finishing at ${end.toLocaleString()}` : ""}.`,
    );
  } else {
    parts.push(
      `@${username}'s follower count held steady${
        end !== null ? ` at ${end.toLocaleString()}` : ""
      } ${periodLabel}.`,
    );
  }

  // Growth vs the previous period, only when both windows are measurable.
  const prevNet = m.previous.netFollowerChange;
  if (net !== null && prevNet !== null) {
    const diff = net - prevNet;
    if (diff > 0)
      parts.push(
        `That is ${diff.toLocaleString()} more follower${
          diff === 1 ? "" : "s"
        } than ${previousLabel}.`,
      );
    else if (diff < 0)
      parts.push(
        `That is ${Math.abs(diff).toLocaleString()} fewer follower${
          Math.abs(diff) === 1 ? "" : "s"
        } than ${previousLabel}.`,
      );
    else parts.push(`That matches ${previousLabel} exactly.`);
  }

  if (m.ownPosts.publishedInPeriod > 0) {
    const avg = m.ownPosts.avgLikes;
    parts.push(
      `They published ${m.ownPosts.publishedInPeriod} post${
        m.ownPosts.publishedInPeriod === 1 ? "" : "s"
      }${avg !== null ? `, averaging ${avg.toLocaleString()} likes each` : ""}.`,
    );
  } else {
    parts.push(`They didn't publish anything new ${periodLabel}.`);
  }

  if (m.summary.totalLikes > 0) {
    const peak = hourLabel(m.peakActivityHour);
    parts.push(
      `They liked ${m.summary.totalLikes.toLocaleString()} post${
        m.summary.totalLikes === 1 ? "" : "s"
      }${peak ? ` and were most active around ${peak}` : ""}.`,
    );
    const topAccount = m.topLikedAccounts[0];
    if (topAccount) {
      if (m.summary.totalLikes === 1) {
        parts.push(`The liked post was from @${topAccount.label}.`);
      } else {
        parts.push(
          `They liked @${topAccount.label}'s posts most often (${n(topAccount.count)} liked post${
            topAccount.count === 1 ? "" : "s"
          }).`,
        );
      }
    }
  } else {
    parts.push(
      `We did not detect any liked posts from this account ${periodLabel}.`,
    );
  }

  // Only speak about follow activity when the server vouches for it.
  if (m.summary.followingEventsTrustworthy) {
    parts.push(
      `They followed ${n(m.summary.accountsFollowed)} account${
        m.summary.accountsFollowed === 1 ? "" : "s"
      } and unfollowed ${n(m.summary.accountsUnfollowed)}${
        m.summary.accountsUnfollowed === 1 ? " account" : " accounts"
      }.`,
    );
  }

  return parts.join(" ");
}

// ── Small presentational pieces ─────────────────────────────────────────────

function DeltaChip({ value, tone }: { value: number | null; tone: "up" | "down" | "flat" }) {
  if (value === null) return null;
  const Icon = tone === "up" ? TrendingUp : tone === "down" ? TrendingDown : Minus;
  const cls =
    tone === "up"
      ? "bg-emerald-50 text-emerald-700"
      : tone === "down"
        ? "bg-rose-50 text-rose-700"
        : "bg-slate-100 text-slate-500";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${cls}`}>
      <Icon className="h-3 w-3" />
      {signed(value)}
    </span>
  );
}

function Metric({
  icon: Icon,
  iconBg,
  iconColor,
  label,
  value,
  sub,
  valueClass,
}: {
  icon: typeof Heart;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  sub?: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="group rounded-2xl border border-slate-200/70 bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,.04)] ring-1 ring-transparent transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_18px_rgba(15,23,42,.08)] hover:ring-slate-200/60">
      <div className={`mb-2.5 flex h-8 w-8 items-center justify-center rounded-xl ${iconBg} shadow-inner`}>
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </div>
      <p className={`text-[1.35rem] font-extrabold leading-none tracking-tight tabular-nums text-slate-900 ${valueClass ?? ""}`}>
        {value}
      </p>
      <p className="mt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      {sub ? <div className="mt-2">{sub}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <h4 className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
        <span className="h-3.5 w-1 rounded-full bg-gradient-to-b from-primary to-primary/40" />
        {title}
      </h4>
      {children}
    </div>
  );
}

/** Compact bar list — top hashtags / accounts, ranked by share of the leader. */
function RankedList({
  items,
  icon: Icon,
  empty,
  accent,
}: {
  items: Counter[];
  icon: typeof Hash;
  empty: string;
  accent: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-slate-400">{empty}</p>;
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ul className="space-y-1.5">
      {items.slice(0, 5).map((item) => (
        <li key={item.label} className="flex items-center gap-2.5">
          <Icon className="h-3 w-3 shrink-0 text-slate-300" />
          <span className="w-0 flex-1 truncate text-xs font-medium text-slate-600">
            {item.label}
          </span>
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100 sm:w-24">
            <div
              className={`h-full rounded-full ${accent}`}
              style={{ width: `${Math.max((item.count / max) * 100, 6)}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-[11px] font-semibold tabular-nums text-slate-500">
            {item.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Follower trend sparkline, drawn from snapshots (IG's own count). */
function Sparkline({ series }: { series: ReportMetrics["dailySeries"] }) {
  const points = series.filter((p) => typeof p.followers === "number");
  if (points.length < 2) return null;

  const values = points.map((p) => p.followers);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 100;
  const h = 28;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p.followers - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const rising = values[values.length - 1] >= values[0];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-full" preserveAspectRatio="none" aria-hidden>
      <path
        d={d}
        fill="none"
        stroke={rising ? "rgb(16 185 129)" : "rgb(244 63 94)"}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ReportThumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (failed) {
    return (
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-slate-100 ring-1 ring-slate-200">
        <ImageIcon className="h-3.5 w-3.5 text-slate-300" />
      </span>
    );
  }
  return (
    <img
      src={proxyUrl(src)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-9 w-9 rounded-md object-cover ring-1 ring-slate-200"
    />
  );
}

/** Who they engage with most — top liked accounts with post thumbnails. */
function LikesLeaderboard({ rows }: { rows: ReportMetrics["likesLeaderboard"] }) {
  if (!rows || rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <ol className="space-y-2">
      {rows.map((r, i) => (
        <li
          key={r.username}
          className="flex items-center gap-3 rounded-xl border border-slate-200/60 bg-slate-50/60 p-2.5"
        >
          <span className="w-5 shrink-0 text-center font-mono text-xs font-bold text-slate-400 tabular-nums">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <a
              href={`https://www.instagram.com/${r.username}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-sm font-semibold text-slate-800 hover:text-primary"
            >
              @{r.username}
            </a>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200/70">
              <div
                className="h-full rounded-full bg-pink-400"
                style={{ width: `${Math.max((r.count / max) * 100, 8)}%` }}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {r.thumbnails.slice(0, 3).map((src, k) => (
              <span key={`${src}-${k}`} className={k > 0 ? "hidden sm:block" : ""}>
                <ReportThumbnail src={src} />
              </span>
            ))}
          </div>
          <span className="w-12 shrink-0 text-right font-mono text-xs font-semibold tabular-nums text-slate-500 sm:w-14">
            {n(r.count)}
            <span className="block text-[9px] font-normal text-slate-400">
              {r.count === 1 ? "post" : "posts"}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function FollowActivity({
  followed,
  unfollowed,
  followedCount,
  unfollowedCount,
}: {
  followed: ActivityAccount[];
  unfollowed: ActivityAccount[];
  followedCount: number;
  unfollowedCount: number;
}) {
  const [open, setOpen] = useState<"followed" | "unfollowed" | null>(null);
  const rows = open === "followed" ? followed : unfollowed;
  const count = open === "followed" ? followedCount : unfollowedCount;
  const label = open === "followed" ? "followed" : "unfollowed";

  const card = (
    kind: "followed" | "unfollowed",
    value: number,
    icon: typeof TrendingUp,
    iconBg: string,
    iconColor: string,
  ) => {
    const Icon = icon;
    const active = open === kind;
    return (
      <button
        type="button"
        onClick={() => setOpen((current) => (current === kind ? null : kind))}
        aria-expanded={active}
        className={`group rounded-2xl border bg-white p-3.5 text-left shadow-[0_1px_2px_rgba(15,23,42,.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_18px_rgba(15,23,42,.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
          active ? "border-primary/30 ring-1 ring-primary/10" : "border-slate-200/70"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className={`mb-2.5 flex h-8 w-8 items-center justify-center rounded-xl ${iconBg} shadow-inner`}>
            <Icon className={`h-4 w-4 ${iconColor}`} />
          </div>
          <ChevronDown
            className={`mt-1 h-4 w-4 text-slate-400 transition-transform ${
              active ? "rotate-180" : ""
            }`}
          />
        </div>
        <p className="text-[1.35rem] font-extrabold leading-none tracking-tight tabular-nums text-slate-900">
          {n(value)}
        </p>
        <p className="mt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">
          Accounts {kind}
        </p>
        <p className="mt-2 text-[11px] font-medium text-primary">
          {active ? "Hide account list" : "View account list"}
        </p>
      </button>
    );
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {card("followed", followedCount, TrendingUp, "bg-emerald-50", "text-emerald-500")}
        {card("unfollowed", unfollowedCount, TrendingDown, "bg-amber-50", "text-amber-500")}
      </div>
      {open && (
        <div className="mt-3 overflow-hidden rounded-xl border border-slate-200/70 bg-slate-50/60">
          <div className="flex items-center justify-between border-b border-slate-200/70 bg-white px-3.5 py-2.5">
            <p className="text-xs font-semibold text-slate-700">
              Accounts {label}
            </p>
            <span className="text-[11px] tabular-nums text-slate-400">
              {n(count)}
            </span>
          </div>
          {rows.length > 0 ? (
            <ul className="max-h-64 divide-y divide-slate-200/60 overflow-y-auto">
              {rows.map((row, index) => (
                <li
                  key={`${row.username}-${row.detectedAt}-${index}`}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <a
                      href={`https://www.instagram.com/${row.username}/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sm font-semibold text-slate-800 hover:text-primary"
                    >
                      @{row.username}
                    </a>
                    {row.displayName && (
                      <p className="truncate text-[11px] text-slate-400">
                        {row.displayName}
                      </p>
                    )}
                  </div>
                  <time
                    dateTime={row.detectedAt}
                    className="shrink-0 text-[10px] tabular-nums text-slate-400"
                  >
                    {new Date(row.detectedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3.5 py-3 text-xs text-slate-400">
              {count > 0
                ? "Names were not stored in this older report. Generate a fresh report to see the full list."
                : `No accounts ${label} in this period.`}
            </p>
          )}
        </div>
      )}
    </>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export function ReportDetail({
  trialPreview = false,
  metrics,
  igUsername,
  periodType,
  totalLikesFallback,
  peakHourFallback,
}: {
  trialPreview?: boolean;
  metrics: ReportMetrics | null;
  igUsername: string;
  periodType: string;
  totalLikesFallback: number;
  peakHourFallback: number | null;
}) {
  // Reports generated before migration 0028 have no metrics blob. Rather than
  // print the legacy roster-discovery counters (the "+3,251 new followers"
  // problem), show the two figures that were always safe and say so.
  if (!metrics) {
    return (
      <>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Metric
            icon={Heart}
            iconBg="bg-pink-50"
            iconColor="text-pink-500"
            label="Likes recorded"
            value={n(totalLikesFallback)}
          />
          <Metric
            icon={Clock}
            iconBg="bg-blue-50"
            iconColor="text-blue-500"
            label="Peak hour"
            value={hourLabel(peakHourFallback) ?? "—"}
          />
        </div>
        <p className="mt-3 text-xs text-slate-400">
          This report predates the detailed format. The next report will include full
          growth, publishing and engagement detail.
        </p>
      </>
    );
  }

  const m = metrics;
  const peak = hourLabel(m.peakActivityHour);
  const likesDelta = m.summary.totalLikes - m.previous.totalLikes;

  return (
    <>
      {/* The period in words — a premium, branded summary card. */}
      <div className="relative mt-4 overflow-hidden rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/[0.07] via-white to-white px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,.04)]">
        <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-primary/10 blur-2xl" />
        <div className="relative">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-primary/80">
            <Sparkles className="h-3.5 w-3.5" />
            {periodType === "monthly" ? "The month in review" : "The week in review"}
          </div>
          <p className="text-[0.92rem] leading-relaxed text-slate-700">
            {trialPreview ? "Preview report. Activate your subscription to see real activity and insights." : buildNarrative(m, igUsername, periodType)}
          </p>
        </div>
      </div>

      <Section title="Audience">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            icon={Users}
            iconBg="bg-emerald-50"
            iconColor="text-emerald-500"
            label="Followers now"
            value={n(m.profile.followerCountEnd)}
            sub={
              <DeltaChip
                value={m.summary.netFollowerChange}
                tone={toneFor(m.summary.netFollowerChange)}
              />
            }
          />
          <Metric
            icon={TrendingUp}
            iconBg="bg-violet-50"
            iconColor="text-violet-500"
            label="Following"
            value={n(m.profile.followingCountEnd)}
            sub={
              <DeltaChip
                value={m.summary.netFollowingChange}
                tone={toneFor(m.summary.netFollowingChange)}
              />
            }
          />
          <Metric
            icon={Heart}
            iconBg="bg-pink-50"
            iconColor="text-pink-500"
            label="Likes recorded"
            value={n(m.summary.totalLikes)}
            sub={<DeltaChip value={likesDelta} tone={toneFor(likesDelta)} />}
          />
          <Metric
            icon={Clock}
            iconBg="bg-blue-50"
            iconColor="text-blue-500"
            label="Peak activity"
            value={peak ?? "—"}
          />
        </div>

        {m.dailySeries.length > 1 && (
          <div className="mt-3 rounded-xl border border-slate-200/60 bg-white px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-400">Follower trend</span>
              <span className="text-[11px] tabular-nums text-slate-400">
                {n(m.profile.followerCountStart)} → {n(m.profile.followerCountEnd)}
              </span>
            </div>
            <Sparkline series={m.dailySeries} />
          </div>
        )}
      </Section>

      <Section title="Publishing">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            icon={ImageIcon}
            iconBg="bg-indigo-50"
            iconColor="text-indigo-500"
            label={periodType === "monthly" ? "Posts this month" : "Posts this week"}
            value={n(m.ownPosts.publishedInPeriod)}
          />
          <Metric
            icon={Heart}
            iconBg="bg-rose-50"
            iconColor="text-rose-500"
            label="Avg likes / post"
            value={n(m.ownPosts.avgLikes)}
          />
          <Metric
            icon={Sparkles}
            iconBg="bg-amber-50"
            iconColor="text-amber-500"
            label="Avg interactions vs followers"
            value={
              m.ownPosts.engagementRatePct === null
                ? "—"
                : `${m.ownPosts.engagementRatePct?.toFixed(1) ?? "—"}%`
            }
          />
          <Metric
            icon={ImageIcon}
            iconBg="bg-slate-100"
            iconColor="text-slate-500"
            label="Posts on profile"
            value={n(m.ownPosts.totalOnProfile)}
          />
        </div>
      </Section>

      {/* Leaderboard gets full width — username + thumbnails + count need room. */}
      <Section title="All liked accounts">
        {m.likesLeaderboard && m.likesLeaderboard.length > 0 ? (
          <LikesLeaderboard rows={m.likesLeaderboard} />
        ) : (
          <RankedList
            items={m.topLikedAccounts}
            icon={AtSign}
            accent="bg-violet-400"
            empty={`No likes recorded ${periodType === "monthly" ? "this month" : "this week"}.`}
          />
        )}
      </Section>

      <Section title="Top interests">
        {m.interestBasis && m.interestBasis !== "hashtags" && (
          <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
            {m.interestBasis === "caption_keywords"
              ? "Based on recurring topics in the captions of liked posts."
              : "No hashtags or caption topics were available, so this shows the formats they engaged with."}
          </p>
        )}
        <RankedList
          items={
            m.topInterests && m.topInterests.length > 0
              ? m.topInterests
              : m.topHashtags
          }
          icon={Hash}
          accent="bg-emerald-400"
          empty={`No interest signals were available ${
            periodType === "monthly" ? "this month" : "this week"
          }.`}
        />
      </Section>

      {/* Gross follow/unfollow counts appear ONLY when the server vouches for
          them; otherwise the net change above is the honest figure. */}
      {m.summary.followingEventsTrustworthy && (
        <Section title="Follow activity">
          <FollowActivity
            followed={m.followedAccounts ?? []}
            unfollowed={m.unfollowedAccounts ?? []}
            followedCount={m.summary.accountsFollowed}
            unfollowedCount={m.summary.accountsUnfollowed}
          />
        </Section>
      )}
    </>
  );
}
