// Client-facing weekly/monthly report → PDF.
//
// Rendered as HTML then printed by Chromium (Playwright is already a dependency
// for the scraper, so this adds no new one). HTML→PDF keeps the report styled
// with the product's own design language instead of a generic PDF-library grid.
//
// Everything is inlined (no network, no remote fonts/images) so rendering is
// deterministic, offline, and can't leak the client's data to a CDN. Thumbnails
// are embedded as data: URIs read from the local media cache.

import fsp from "node:fs/promises";
import path from "node:path";
import { logger as baseLogger } from "../observability/logger.js";
import { cacheMediaUrl, mediaCacheKey, readCachedMediaAsset } from "./media-cache.js";
import type { ReportData, ReportCounter } from "./report-data.js";

const logger = baseLogger.child({ module: "report-pdf" });

const BRAND_INK = "#0B1220";
const BRAND_BLUE = "#2563EB";
const MUTED = "#64748B";
const HAIRLINE = "#E2E8F0";

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US");
}

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function fmtHour(h: number | null): string {
  if (h === null) return "—";
  const period = h < 12 ? "AM" : "PM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${period}`;
}

function signed(n: number | null): string {
  if (n === null) return "—";
  return n > 0 ? `+${fmtInt(n)}` : fmtInt(n);
}

/**
 * Inline a thumbnail as a data: URI, fetching it if we don't hold it yet.
 *
 * The on-demand fetch matters: Instagram issues a NEW signed URL on every
 * scrape, so each posts refresh rotates thumbnail_url and instantly orphans the
 * previously cached copy. Relying on the cache alone therefore produced a report
 * full of "no image" boxes right after a refresh. Bounded work — at most ~18
 * images per report — and a miss degrades to a placeholder rather than failing.
 */
async function inlineThumb(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    // Local proxy URLs (/api/media/<key>) already carry the cache key.
    const key = url.startsWith("/api/media/")
      ? url.slice("/api/media/".length)
      : mediaCacheKey(url);
    let asset = await readCachedMediaAsset(key);
    if (!asset && !url.startsWith("/api/media/")) {
      const cached = await cacheMediaUrl(url).catch(() => null);
      if (cached?.status === "cached") asset = await readCachedMediaAsset(key);
    }
    if (!asset) return null;
    return `data:${asset.contentType};base64,${asset.body.toString("base64")}`;
  } catch {
    return null;
  }
}

function barRow(items: ReadonlyArray<{ label: string; count: number }>): string {
  const max = Math.max(1, ...items.map((i) => i.count));
  return items
    .map(
      (i) => `
      <div class="bar">
        <div class="bar-label">${esc(i.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(
          (i.count / max) * 100,
        )}%"></div></div>
        <div class="bar-val">${fmtInt(i.count)}</div>
      </div>`,
    )
    .join("");
}

function chips(items: ReadonlyArray<ReportCounter>, prefix = ""): string {
  if (items.length === 0) return `<p class="empty">No data for this period.</p>`;
  return `<div class="chips">${items
    .map(
      (i) =>
        `<span class="chip">${prefix}${esc(i.label)}<b>${fmtInt(i.count)}</b></span>`,
    )
    .join("")}</div>`;
}

function nameList(names: ReadonlyArray<string>): string {
  if (names.length === 0) return `<p class="empty">None in this period.</p>`;
  return `<div class="names">${names
    .map((n) => `<span class="name">@${esc(n)}</span>`)
    .join("")}</div>`;
}

/** "vs last period" chip. Null prior => no chip (never invent a baseline). */
function deltaChip(current: number | null, previous: number | null): string {
  if (current === null || current === undefined || previous === null || previous === undefined) return "";
  const diff = current - previous;
  if (diff === 0) return `<span class="delta flat">no change vs last</span>`;
  const cls = diff > 0 ? "up" : "down";
  const arrow = diff > 0 ? "▲" : "▼";
  return `<span class="delta ${cls}">${arrow} ${fmtInt(Math.abs(diff))} vs last</span>`;
}

/** Inline SVG line chart of the daily follower series. */
function growthChart(
  points: ReadonlyArray<{ date: string; followers: number }>,
): string {
  if (points.length < 2) {
    return `<p class="empty">Not enough daily snapshots yet to chart growth.</p>`;
  }
  const W = 640;
  const H = 120;
  const PAD = 8;
  const values = points.map((p) => p.followers);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (W - PAD * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = PAD + i * stepX;
    const y = PAD + (H - PAD * 2) * (1 - (p.followers - min) / span);
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1]![0].toFixed(1)},${H - PAD} L${coords[0]![0].toFixed(1)},${H - PAD} Z`;
  const dots = coords
    .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${BRAND_BLUE}"/>`)
    .join("");
  const labels = points
    .map((p, i) => {
      const x = PAD + i * stepX;
      return `<text x="${x.toFixed(1)}" y="${H - 1}" font-size="7" fill="${MUTED}" text-anchor="middle">${esc(
        p.date.slice(5),
      )}</text>`;
    })
    .join("");
  return `
    <svg viewBox="0 0 ${W} ${H + 8}" width="100%" height="132" preserveAspectRatio="none" role="img">
      <path d="${area}" fill="${BRAND_BLUE}" opacity="0.08"/>
      <path d="${line}" fill="none" stroke="${BRAND_BLUE}" stroke-width="2" stroke-linejoin="round"/>
      ${dots}${labels}
    </svg>
    <div class="chart-scale"><span>${fmtInt(min)}</span><span>${fmtInt(max)}</span></div>`;
}

function ownPostRow(p: {
  shortcode: string;
  postType: string;
  caption: string | null;
  likeCount: number;
  commentCount: number;
  dataUri: string | null;
}): string {
  const cap = (p.caption ?? "").replace(/\s+/g, " ").trim().slice(0, 70);
  return `<div class="opost">
    ${p.dataUri ? `<img src="${p.dataUri}" alt="">` : `<div class="ph">no image</div>`}
    <div class="opost-body">
      <div class="opost-cap">${cap ? esc(cap) : `<i>No caption</i>`}</div>
      <div class="opost-meta">${esc(p.postType)} · ♥ ${fmtInt(p.likeCount)} · 💬 ${fmtInt(
        p.commentCount,
      )}</div>
    </div>
  </div>`;
}

export async function renderReportHtml(data: ReportData): Promise<string> {
  const thumbs = await Promise.all(
    data.likedPosts.map(async (p) => ({
      ...p,
      dataUri: await inlineThumb(p.thumbnailUrl),
    })),
  );
  const ownThumbs = await Promise.all(
    data.ownPosts.topPosts.map(async (p) => ({
      ...p,
      dataUri: await inlineThumb(p.thumbnailUrl),
    })),
  );

  const hourMax = Math.max(1, ...data.activityByHour.map((h) => h.count));
  const hourBars = Array.from({ length: 24 }, (_, h) => {
    const found = data.activityByHour.find((x) => x.hour === h);
    const c = found?.count ?? 0;
    const pct = Math.round((c / hourMax) * 100);
    return `<div class="hcol" title="${h}:00 — ${c}">
      <div class="hbar" style="height:${Math.max(2, pct)}%"></div>
      <div class="hlab">${h % 6 === 0 ? h : ""}</div>
    </div>`;
  }).join("");

  const dayMax = Math.max(1, ...data.activityByDay.map((d) => d.count));
  const dayBars = data.activityByDay
    .map(
      (d) => `<div class="dcol">
        <div class="dbar" style="height:${Math.max(
          2,
          Math.round((d.count / dayMax) * 100),
        )}%"></div>
        <div class="dnum">${d.count}</div>
        <div class="dlab">${esc(d.day)}</div>
      </div>`,
    )
    .join("");

  // Growth is the ONLY honest follower headline: the event tables count roster
  // discovery, so on a backfill week they read in the thousands for an account
  // that gained ~20. Show detected/lost only when the roster earns it.
  const growth = data.summary.netFollowerChange;
  const trust = data.summary.followerEventsTrustworthy;
  // Gross follow/unfollow counts are only shown when they survive the sanity
  // check — otherwise they are re-enumeration churn (e.g. "1,264 followed" for
  // an account that follows 209) and we show the snapshot delta instead.
  const followTrust = data.summary.followingEventsTrustworthy;
  const followingDelta = data.summary.netFollowingChange;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Report — @${esc(
    data.account.igUsername,
  )}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:${BRAND_INK};background:#fff}
  .page{padding:34px 40px}
  .page + .page header{margin-top:24px}
  header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${BRAND_INK};padding-bottom:14px;margin-bottom:22px}
  .wordmark{font-size:19px;font-weight:800;letter-spacing:-.5px}
  .wordmark .see{color:${BRAND_BLUE}}
  .sub{color:${MUTED};font-size:11px;margin-top:3px}
  h1{font-size:25px;letter-spacing:-.7px;margin-bottom:2px;overflow-wrap:anywhere;max-width:440px}
  .period{color:${MUTED};font-size:12px}
  .right{text-align:right}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.9px;color:${MUTED};margin:24px 0 10px;font-weight:700}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .kpi{border:1px solid ${HAIRLINE};border-radius:12px;padding:12px 14px;background:#fff}
  .kpi .k{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:${MUTED};font-weight:700}
  .kpi .v{font-size:25px;font-weight:800;letter-spacing:-1px;margin-top:5px}
  .kpi .n{font-size:10px;color:${MUTED};margin-top:2px}
  .pos{color:#059669}.neg{color:#DC2626}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .card{border:1px solid ${HAIRLINE};border-radius:12px;padding:14px}
  .bar{display:grid;grid-template-columns:120px 1fr 40px;gap:8px;align-items:center;margin-bottom:6px;font-size:11px}
  .bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${BRAND_INK}}
  .bar-track{background:#F1F5F9;border-radius:5px;height:8px;overflow:hidden}
  .bar-fill{background:${BRAND_BLUE};height:100%;border-radius:5px}
  .bar-val{text-align:right;color:${MUTED};font-variant-numeric:tabular-nums}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{border:1px solid ${HAIRLINE};border-radius:999px;padding:4px 9px;font-size:11px;color:#334155}
  .chip b{margin-left:5px;color:${BRAND_BLUE}}
  .hours{display:flex;align-items:flex-end;gap:2px;height:88px;margin-top:6px}
  .hcol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
  .hbar{width:100%;background:${BRAND_BLUE};opacity:.85;border-radius:2px 2px 0 0}
  .hlab{font-size:8px;color:${MUTED};margin-top:3px;height:9px}
  .days{display:flex;align-items:flex-end;gap:10px;height:96px;margin-top:6px}
  .dcol{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
  .dbar{width:70%;background:${BRAND_INK};border-radius:3px 3px 0 0}
  .dnum{font-size:10px;font-weight:700;margin-top:3px}
  .dlab{font-size:9px;color:${MUTED}}
  .posts{display:grid;grid-template-columns:repeat(6,1fr);gap:7px}
  .post{border:1px solid ${HAIRLINE};border-radius:9px;overflow:hidden}
  .post img{width:100%;height:74px;object-fit:cover;display:block}
  .ph{width:100%;height:74px;background:#F1F5F9;display:flex;align-items:center;justify-content:center;color:#94A3B8;font-size:9px}
  .post .m{padding:4px 5px;font-size:8px;color:${MUTED};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .names{display:flex;flex-wrap:wrap;gap:5px}
  .name{font-size:10px;color:#334155;background:#F8FAFC;border:1px solid ${HAIRLINE};border-radius:5px;padding:2px 6px}
  .empty{color:#94A3B8;font-size:11px;font-style:italic}
  .note{background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;border-radius:9px;padding:8px 11px;font-size:10px;margin-top:8px}
  .delta{display:block;font-size:9px;margin-top:3px;font-weight:600}
  .delta.up{color:#059669}.delta.down{color:#DC2626}.delta.flat{color:#94A3B8}
  .chart-scale{display:flex;justify-content:space-between;font-size:8px;color:#94A3B8;margin-top:-4px}
  .opost{display:flex;gap:9px;align-items:center;border:1px solid ${HAIRLINE};border-radius:9px;padding:6px;margin-bottom:6px}
  .opost img{width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0}
  .opost .ph{width:44px;height:44px;border-radius:6px;background:#F1F5F9;display:flex;align-items:center;justify-content:center;font-size:7px;color:#94A3B8;flex-shrink:0}
  .opost-body{min-width:0;flex:1}
  .opost-cap{font-size:10px;color:#1E293B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .opost-meta{font-size:9px;color:#64748B;margin-top:2px}
  footer{margin-top:26px;border-top:1px solid ${HAIRLINE};padding-top:9px;color:#94A3B8;font-size:9px;display:flex;justify-content:space-between}
  @page{size:A4;margin:34px 40px 54px}
  @media print{
    .page{padding:0}
    header,h2{break-after:avoid}
    h2 + p{break-after:avoid}
    .card,.kpi,.opost,.post,.note,.grid,.two,.posts{break-inside:avoid}
    p{orphans:3;widows:3}
    footer{display:none}
  }
</style></head><body>
<div class="page">
  <header>
    <div>
      <div class="wordmark">Like<span class="see">See</span>.AI</div>
      <div class="sub">Instagram Activity Report</div>
    </div>
    <div class="right">
      <h1>@${esc(data.account.igUsername)}</h1>
      <div class="period">${fmtDate(data.period.start)} — ${fmtDate(
        data.period.end,
      )} · ${esc(data.period.type)}</div>
    </div>
  </header>

  <h2>Summary</h2>
  <p class="empty" style="margin-bottom:10px">Counts describe observed activity. Incomplete collection may leave some posts and actions unobserved.</p>
  <div class="grid">
    <div class="kpi"><div class="k">Follower Growth</div>
      <div class="v ${
        growth !== null && growth > 0 ? "pos" : growth !== null && growth < 0 ? "neg" : ""
      }">${signed(growth)}</div>
      <div class="n">${fmtInt(data.profile.followerCountStart)} → ${fmtInt(
        data.profile.followerCountEnd,
      )}</div>${deltaChip(growth, data.previous.netFollowerChange)}</div>
    <div class="kpi"><div class="k">Likes Detected</div><div class="v">${fmtInt(
      data.summary.totalLikes,
    )}</div><div class="n">posts they liked</div>${deltaChip(
      data.summary.totalLikes,
      data.previous.totalLikes,
    )}</div>
    ${
      followTrust
        ? `<div class="kpi"><div class="k">Accounts Followed</div><div class="v">${fmtInt(
            data.summary.accountsFollowed,
          )}</div><div class="n">they started following</div>${deltaChip(
            data.summary.accountsFollowed,
            data.previous.followingEventsTrustworthy
              ? data.previous.accountsFollowed
              : null,
          )}</div>
    <div class="kpi"><div class="k">Accounts Unfollowed</div><div class="v">${fmtInt(
      data.summary.accountsUnfollowed,
    )}</div><div class="n">they stopped following</div>${deltaChip(
      data.summary.accountsUnfollowed,
      data.previous.followingEventsTrustworthy
        ? data.previous.accountsUnfollowed
        : null,
    )}</div>`
        : `<div class="kpi"><div class="k">Following Change</div>
      <div class="v ${
        followingDelta !== null && followingDelta > 0
          ? "pos"
          : followingDelta !== null && followingDelta < 0
            ? "neg"
            : ""
      }">${signed(followingDelta)}</div>
      <div class="n">${fmtInt(data.profile.followingCountStart)} → ${fmtInt(
        data.profile.followingCountEnd,
      )}</div></div>
    <div class="kpi"><div class="k">Following</div><div class="v">${fmtInt(
      data.profile.followingCountEnd,
    )}</div><div class="n">accounts total</div></div>`
    }
  </div>
  ${
    trust
      ? `<div class="grid" style="margin-top:10px">
    <div class="kpi"><div class="k">New Followers</div><div class="v pos">${fmtInt(
      data.summary.followersDetected,
    )}</div><div class="n">gained this period</div></div>
    <div class="kpi"><div class="k">Lost Followers</div><div class="v neg">${fmtInt(
      data.summary.followersLost,
    )}</div><div class="n">unfollowed them</div></div>
    <div class="kpi"><div class="k">Peak Activity</div><div class="v">${fmtHour(
      data.peakActivityHour,
    )}</div><div class="n">most active hour</div></div>
    <div class="kpi"><div class="k">Following</div><div class="v">${fmtInt(
      data.profile.followingCountEnd,
    )}</div><div class="n">accounts</div></div>
  </div>`
      : `<div class="grid" style="margin-top:10px">
    <div class="kpi"><div class="k">Peak Activity</div><div class="v">${fmtHour(
      data.peakActivityHour,
    )}</div><div class="n">most active hour</div></div>
    <div class="kpi"><div class="k">Following</div><div class="v">${fmtInt(
      data.profile.followingCountEnd,
    )}</div><div class="n">accounts</div></div>
    <div class="kpi"><div class="k">Posts</div><div class="v">${fmtInt(
      data.profile.postCountEnd,
    )}</div><div class="n">total on profile</div></div>
    <div class="kpi"><div class="k">Followers</div><div class="v">${fmtInt(
      data.profile.followerCountEnd,
    )}</div><div class="n">at period end</div></div>
  </div>
  <div class="note"><b>Note on follower detail.</b> This profile's follower list is
  larger than Instagram lets us enumerate, so we report growth from Instagram's own
  follower count (accurate) and omit per-person new/lost follower lists rather than
  show partial data as if it were complete.</div>`
  }

  ${
    followTrust
      ? ""
      : `<div class="note">
    <b>Note on follow/unfollow detail.</b> We detected more follow/unfollow events
    than this account even follows in total, which means an earlier roster read was
    partial and the next full read diffed the gap as "activity". Rather than print a
    number we know is wrong, we report the following change from Instagram's own
    count and omit the per-event totals for this period.</div>`
  }

  <h2>Follower Growth</h2>
  <div class="card">${growthChart(data.dailySeries)}</div>

  <h2>Account Health</h2>
  <div class="grid">
    <div class="kpi"><div class="k">Avg Likes / Post</div><div class="v">${fmtInt(
      data.ownPosts.avgLikes,
    )}</div><div class="n">across cached posts</div></div>
    <div class="kpi"><div class="k">Avg Comments / Post</div><div class="v">${fmtInt(
      data.ownPosts.avgComments,
    )}</div><div class="n">across cached posts</div></div>
    <div class="kpi"><div class="k">Posted This Period</div><div class="v">${fmtInt(
      data.ownPosts.publishedInPeriod,
    )}</div><div class="n">of ${fmtInt(data.ownPosts.totalOnProfile)} total</div></div>
    <div class="kpi"><div class="k">Posts on Profile</div><div class="v">${fmtInt(
      data.ownPosts.totalOnProfile,
    )}</div><div class="n">at period end</div></div>
  </div>
  ${
    data.ownPosts.engagementRatePct !== null
      ? `<div class="note" style="background:#F8FAFC;border-color:${HAIRLINE};color:${MUTED}">
      <b>Avg interactions vs followers: ${data.ownPosts.engagementRatePct}%</b> —
      (avg likes + comments) ÷ followers. Reels reach well beyond the follower
      base, so this can exceed 100% and is <i>not</i> a follower-only engagement rate.</div>`
      : ""
  }

  <h2>Engagement Focus</h2>
  <div class="two">
    <div class="card"><div class="k" style="font-size:10px;color:${MUTED};font-weight:700;margin-bottom:7px">TOP INTERESTS</div>
      ${chips(data.topInterests, data.interestBasis === "hashtags" ? "#" : "")}</div>
    <div class="card"><div class="k" style="font-size:10px;color:${MUTED};font-weight:700;margin-bottom:7px">ALL LIKED ACCOUNTS</div>
      ${
        data.topLikedAccounts.length
          ? barRow(
              data.topLikedAccounts.map((a) => ({
                label: `@${a.label}`,
                count: a.count,
              })),
            )
          : `<p class="empty">No likes detected in this period.</p>`
      }</div>
  </div>

  <h2>Activity Pattern</h2>
  <div class="two">
    <div class="card"><div class="k" style="font-size:10px;color:${MUTED};font-weight:700">BY HOUR (UTC)</div>
      <div class="hours">${hourBars}</div></div>
    <div class="card"><div class="k" style="font-size:10px;color:${MUTED};font-weight:700">BY DAY</div>
      <div class="days">${dayBars}</div></div>
  </div>

</div>

<div class="page">
  <header><div><div class="wordmark">Like<span class="see">See</span>.AI</div>
  <div class="sub">Detail — @${esc(data.account.igUsername)}</div></div>
  <div class="right"><div class="period">${fmtDate(
    data.period.start,
  )} — ${fmtDate(data.period.end)}</div></div></header>

  <h2>Their Top Performing Posts</h2>
  ${
    ownThumbs.length
      ? ownThumbs.map((p) => ownPostRow(p)).join("")
      : `<p class="empty">No posts cached for this period.</p>`
  }

  <h2>Posts They Liked (${data.likedPosts.length})</h2>
  ${
    thumbs.length
      ? `<div class="posts">${thumbs
          .map(
            (p) => `<div class="post">${
              p.dataUri
                ? `<img src="${p.dataUri}" alt="">`
                : `<div class="ph">no image</div>`
            }<div class="m">@${esc(p.ownerUsername)}</div></div>`,
          )
          .join("")}</div>`
      : `<p class="empty">No liked posts detected in this period.</p>`
  }

  <h2>Post Types Liked</h2>
  ${chips(data.postTypeBreakdown)}

  ${
    followTrust
      ? `<h2>Accounts They Followed (${data.summary.accountsFollowed})</h2>
  ${nameList(data.followedAccounts.map((account) => account.username))}
  <h2>Accounts They Unfollowed (${data.summary.accountsUnfollowed})</h2>
  ${nameList(data.unfollowedAccounts.map((account) => account.username))}`
      : `<h2>Recently Unfollowed (sample)</h2>
  <p class="empty" style="margin-bottom:6px">A total is withheld for this period —
  see the follow/unfollow note in the summary. These are the most recent unfollows we saw.</p>
  ${nameList(data.unfollowedSample.slice(0, 15))}`
  }

  ${
    trust
      ? `<h2>New Followers</h2>${nameList(data.newFollowerSample)}
         <h2>Lost Followers</h2>${nameList(data.lostFollowerSample)}`
      : ""
  }

  <footer><span>CheaterFinder · Confidential — prepared for the account owner</span>
  <span>Generated ${fmtDate(data.generatedAt)}</span></footer>
</div>
</body></html>`;
}

/**
 * Render the report HTML to a PDF buffer with Chromium.
 *
 * Uses the same Playwright install the scraper already depends on. Launched
 * WITHOUT a proxy and with no network access needed — the HTML inlines every
 * asset — so this never touches the residential proxy or IG.
 */
export async function renderReportPdf(data: ReportData): Promise<Buffer> {
  const html = await renderReportHtml(data);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "34px", bottom: "54px", left: "40px", right: "40px" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;margin:0 40px;border-top:1px solid ${HAIRLINE};padding-top:7px;font:9px sans-serif;color:#94A3B8;display:flex;justify-content:space-between"><span>CheaterFinder · Confidential — prepared for the account owner</span><span>Generated ${fmtDate(data.generatedAt)} · <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
    logger.info(
      { igUsername: data.account.igUsername, bytes: pdf.length },
      "report pdf rendered",
    );
    return pdf;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function reportPdfFilename(data: ReportData): string {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const safe = data.account.igUsername.replace(/[^a-zA-Z0-9._-]/g, "");
  return `cheaterfinder-${safe}-${data.period.type}-${d(data.period.start)}_${d(
    data.period.end,
  )}.pdf`;
}

export const __testing = { esc, fmtInt, signed, fmtHour, reportPdfFilename, deltaChip };
