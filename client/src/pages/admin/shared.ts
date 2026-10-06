import { type LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  Activity,
  Clock,
  EyeOff,
  Ban,
  HelpCircle,
  KeyRound,
} from "lucide-react";
import {
  CSRF_HEADER_NAME,
  getCsrfToken,
  isCsrfErrorBody,
  isUnsafeMethod,
  probeSessionAfterCsrfFailure,
} from "@/lib/csrf";
import type { ActivityEvent, ViewerData, PostTypeFilter, ViewerRecentPost } from "@/components/dashboard/types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BotAccount {
  id: string;
  igUsername: string;
  igUserId: string | null;
  displayName: string | null;
  proxyUrl: string | null;
  status:
    | "available"
    | "in_use"
    | "cooldown"
    | "disabled"
    | "banned"
    | "session_expired";
  maxFollows: number;
  currentFollows: number;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FollowRequest {
  id: string;
  botAccountId: string;
  trackedAccountId: string;
  status: "queued" | "pending" | "accepted" | "rejected" | "expired" | "failed";
  queuedAt: string;
  sentAt: string | null;
  resolvedAt: string | null;
  retryCount: number;
  error: string | null;
  expiresAt: string | null;
  botUsername: string | null;
  targetUsername: string | null;
}

export interface AdminStats {
  totalBots: number;
  availableBots: number;
  activeBots: number;
  disabledBots: number;
  cooldownBots: number;
  totalFollowRequests: number;
  pendingRequests: number;
  acceptedRequests: number;
  failedRequests: number;
  totalTrackedAccounts: number;
  privateAccounts: number;
  publicAccounts: number;
}

export interface AdminOverviewData {
  users: { total: number; newThisWeek: number; activeThisMonth: number };
  subscriptions: {
    total: number;
    trialing: number;
    active: number;
    pastDue: number;
    canceled: number;
    starterPlan: number;
    standardPlan: number;
    proPlan: number;
    legacyPlans: number;
  };
  trackedAccounts: {
    total: number;
    active: number;
    inactive: number;
    private: number;
    public: number;
    pendingAccess: number;
  };
  events: {
    totalLikes: number;
    totalFollows: number;
    totalUnfollows: number;
    likesLast24h: number;
    followsLast24h: number;
    unfollowsLast24h: number;
    totalFollowers?: number;
    totalFollowerUnfollows?: number;
    followersLast24h?: number;
    followerUnfollowsLast24h?: number;
  };
  bots: {
    total: number;
    available: number;
    inUse: number;
    cooldown: number;
    disabled: number;
    banned: number;
    sessionExpired: number;
  };
  jobs: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    failedLast24h: number;
  };
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  subscription: {
    status: string;
    plan: string | null;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
  } | null;
  trackedAccountCount: number;
}

export interface AdminUserDetail {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  };
  subscription: {
    status: string;
    plan: string | null;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  trackedAccounts: Array<{
    id: string;
    igUsername: string;
    displayName: string | null;
    isActive: boolean;
    isPrivate: boolean;
    accessStatus: string;
    followerCount: number;
    trackingStarted: string;
    likeCount: number;
    followCount: number;
    unfollowCount: number;
  }>;
  recentNotifications: Array<{
    id: string;
    type: string;
    title: string;
    body: string;
    isRead: boolean;
    createdAt: string;
  }>;
  stats: {
    totalLikes: number;
    totalFollows: number;
    totalUnfollows: number;
  };
}

export interface AdminTrackedAccount {
  id: string;
  igUsername: string;
  displayName: string | null;
  followerCount: number;
  isActive: boolean;
  isPrivate: boolean;
  accessStatus: string;
  trackingStarted: string;
  userId: string;
  userEmail: string;
  userName: string;
  likeCount: number;
  followCount: number;
  unfollowCount: number;
}

export interface AdminActivityItem {
  eventType: "like" | "follow" | "unfollow" | "follower" | "follower_unfollow";
  id: string;
  detectedAt: string;
  igUsername: string;
  userId: string;
  userEmail: string;
  postId?: string;
  ownerUsername?: string;
  postType?: string;
  postUrl?: string | null;
  caption?: string | null;
  likesCount?: number | null;
  commentsCount?: number | null;
  postTakenAt?: string | null;
  thumbnailUrl?: string;
  followedUsername?: string;
  unfollowedUsername?: string;
  followerUsername?: string;
  unfollowerUsername?: string;
}

export interface QueueHealth {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface CollectionJob {
  id: string;
  trackedAccountId: string;
  igUsername: string;
  jobType: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export type ScraperReadTransport = "http" | "browser" | "browser-fallback";

export interface ScraperTransportConfig {
  current: {
    value: ScraperReadTransport;
    source: "db" | "env" | "default";
    updatedAt: string | null;
  };
  options: Array<{
    value: ScraperReadTransport;
    label: string;
  }>;
}

// ─── Bandwidth ─────────────────────────────────────────────────────────────

export type BandwidthWindow = "1h" | "24h" | "7d" | "30d";

export interface BandwidthTotals {
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  requests: number;
}

export interface ProfileBandwidthRow {
  trackedAccountId: string | null;
  igUsername: string | null;
  userId: string | null;
  userEmail: string | null;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  requests: number;
}

export interface UserBandwidthRow {
  userId: string | null;
  userEmail: string | null;
  profileCount: number;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  requests: number;
}

export interface EndpointBandwidthRow {
  endpoint: string;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  requests: number;
}

/**
 * Kernel-measured transfer to the proxy gateway for the window — the billable
 * figure. Mirrors `WireBandwidthTotals` in server/services/bandwidth-meter.ts.
 * Unrelated to `totals`, which is per-request attribution measured inside Node.
 */
export interface WireBandwidthTotals {
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  /** Sample rows in the window. 0 = the sampler has not produced a delta yet. */
  samples: number;
  /** Wall seconds covered; below the window length the total is a floor. */
  coverageSeconds: number;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  available: boolean;
}

export interface BandwidthReport {
  window: BandwidthWindow;
  generatedAt: string;
  totals: BandwidthTotals;
  wire: WireBandwidthTotals;
  byProfile: ProfileBandwidthRow[];
  byUser: UserBandwidthRow[];
  byEndpoint: EndpointBandwidthRow[];
  meter?: { pendingBuckets: number; retryBuckets: number; lastErrorAt: string | null; lastSuccessAt: string | null };
  counts?: { profilesWithTraffic: number; customersWithTraffic: number };
  breakdownCoverage?: {
    profiles: { shownGroups: number; totalGroups: number; omittedBytes: number; omittedRequests: number };
    customers: { shownGroups: number; totalGroups: number; omittedBytes: number; omittedRequests: number };
  };
}

export interface RefreshIntervalConfig {
  current: {
    intervalSec: number;
    source: "db" | "env" | "default";
    updatedAt: string | null;
    min: number;
    max: number;
  };
}

/** Human-readable bytes (1024-based). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Human-readable duration from seconds (e.g. 90 -> "1m 30s"). */
export function formatDurationSec(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0s";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Centralized fetch for admin endpoints.
 *
 * - Always sends session cookies via `credentials: "include"`.
 * - Adds `X-Requested-With` for the server's anti-CSRF origin checks.
 * - For non-GET methods (POST/PUT/PATCH/DELETE), echoes the `csrf_token`
 *   cookie back via `X-CSRF-Token` so server's double-submit middleware
 *   (server/auth.ts `requireCsrfToken`) accepts the request.
 * - On a 403 CSRF failure, probes `/api/auth/me`:
 *     - session dead -> redirect to /auth
 *     - session alive -> reload CSRF cookie and retry the request once.
 */
export async function adminFetch(url: string, opts?: RequestInit) {
  const method = (opts?.method ?? "GET").toUpperCase();
  const headers = new Headers(opts?.headers);
  if (!headers.has("X-Requested-With")) {
    headers.set("X-Requested-With", "XMLHttpRequest");
  }
  if (isUnsafeMethod(method)) {
    const token = getCsrfToken();
    if (token && !headers.has(CSRF_HEADER_NAME)) {
      headers.set(CSRF_HEADER_NAME, token);
    }
  }

  const doFetch = () =>
    fetch(url, { credentials: "include", ...opts, headers });

  const res = await doFetch();

  // Only inspect 403s on mutations; GET 403s are normal permission errors.
  if (res.status !== 403 || !isUnsafeMethod(method)) {
    return res;
  }

  // Peek at the body to confirm it's a CSRF failure. Clone so callers can
  // still read it if it wasn't CSRF-related.
  let csrfFailure = false;
  try {
    const clone = res.clone();
    const body = await clone.json();
    csrfFailure = isCsrfErrorBody(body);
  } catch {
    csrfFailure = false;
  }
  if (!csrfFailure) {
    return res;
  }

  // Probe the session. If it's dead, send the user to /auth; otherwise pick
  // up the fresh cookie and retry the original request once.
  const sessionState = await probeSessionAfterCsrfFailure();
  if (sessionState === "session-dead") {
    try {
      window.sessionStorage.setItem(
        "cheaterfinder.sessionExpired",
        "Session expired — please log in again",
      );
    } catch {
      // sessionStorage may be unavailable; ignore.
    }
    window.location.assign("/auth");
    return res;
  }
  if (sessionState === "network-error") {
    return res;
  }

  // Session alive — rebuild headers with the (possibly refreshed) token and
  // retry exactly once.
  const retryHeaders = new Headers(opts?.headers);
  if (!retryHeaders.has("X-Requested-With")) {
    retryHeaders.set("X-Requested-With", "XMLHttpRequest");
  }
  const freshToken = getCsrfToken();
  if (freshToken) {
    retryHeaders.set(CSRF_HEADER_NAME, freshToken);
  }
  return fetch(url, { credentials: "include", ...opts, headers: retryHeaders });
}

export function formatDate(d: string | null): string {
  if (!d) return "--";
  const date = new Date(d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(d: string | null): string {
  if (!d) return "Never";
  const now = Date.now();
  const then = new Date(d).getTime();
  const diff = now - then;

  // Future dates (e.g. cooldownUntil)
  if (diff < 0) {
    const absDiff = Math.abs(diff);
    const mins = Math.floor(absDiff / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `in ${hrs}h`;
    return `in ${Math.floor(hrs / 24)}d`;
  }

  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatDateShort(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Status Configs ──────────────────────────────────────────────────────────

export interface BotStatusConfig {
  label: string;
  className: string;
  icon: LucideIcon;
}

export const BOT_STATUS_CONFIG: Record<BotAccount["status"], BotStatusConfig> = {
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

/**
 * Safe accessor for bot status display config.
 *
 * The server can send statuses that are not in `BOT_STATUS_CONFIG`
 * (e.g. `session_expired`, added by the bot-login work as a parked status).
 * Indexing the map directly for an unknown status returns `undefined`, and
 * reading `.icon` off it throws during render — which, with no ErrorBoundary,
 * white-screens the whole admin SPA. This always returns a renderable config,
 * falling back to a neutral "unknown" badge that surfaces the raw status.
 */
export function getBotStatusConfig(status: string): BotStatusConfig {
  return (
    BOT_STATUS_CONFIG[status as BotAccount["status"]] ?? {
      label: status || "Unknown",
      className: "bg-slate-100 text-slate-600 border-slate-200",
      icon: HelpCircle,
    }
  );
}

export const FR_STATUS_CONFIG: Record<
  FollowRequest["status"],
  { label: string; className: string }
> = {
  queued: { label: "Queued", className: "bg-slate-100 text-slate-600 border-slate-200" },
  pending: { label: "Pending", className: "bg-blue-100 text-blue-700 border-blue-200" },
  accepted: { label: "Accepted", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-700 border-red-200" },
  expired: { label: "Expired", className: "bg-amber-100 text-amber-700 border-amber-200" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700 border-red-200" },
};

export const SUBSCRIPTION_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-emerald-100 text-emerald-700" },
  trialing: { label: "Trialing", className: "bg-blue-100 text-blue-700" },
  past_due: { label: "Past Due", className: "bg-amber-100 text-amber-700" },
  canceled: { label: "Canceled", className: "bg-red-100 text-red-700" },
  none: { label: "No Sub", className: "bg-slate-100 text-slate-500" },
};

export const ACCESS_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  public: { label: "Public", className: "bg-emerald-100 text-emerald-700" },
  pending_access: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  has_access: { label: "Has Access", className: "bg-blue-100 text-blue-700" },
  access_denied: { label: "Denied", className: "bg-red-100 text-red-700" },
};

// ─── Tracked account detail (admin) ──────────────────────────────────────────
// Appended for the tracked-account drill-down. `AdminTrackedAccount` above is
// left untouched so existing consumers keep compiling; the row type below just
// widens it with the avatar the list endpoint already returns.

// Import placed here (rather than at the head of the file) to keep this block
// purely additive while another agent edits the admin surface concurrently.
// ES modules hoist import declarations, so position is irrelevant at runtime.

/** A liked post as rendered by `LikedPostsGallery`. */
export type LikedPostItem = ActivityEvent;

/** List row: `AdminTrackedAccount` plus the profile picture the API returns. */
export type AdminTrackedAccountRow = AdminTrackedAccount & {
  profilePicUrl?: string | null;
};

/** One user tracking a given IG account. Several users may track the same one. */
export interface AdminTrackedAccountOwner {
  trackedAccountId: string;
  userId: string;
  userEmail: string;
  userName: string;
  trackingStarted: string;
  isActive: boolean;
}

/** Response of `GET /api/admin/tracked-accounts/:id`. */
export interface AdminTrackedAccountDetailData {
  account: {
    id: string;
    igUsername: string;
    igUserId: string | null;
    displayName: string | null;
    profilePicUrl: string | null;
    followerCount: number;
    isActive: boolean;
    isPrivate: boolean;
    accessStatus: string;
    trackingStarted: string;
    userId: string;
    userEmail: string;
    userName: string;
  };
  /** Tracking owners visible to this administrative account scope. */
  owners: AdminTrackedAccountOwner[];
  /** Activity totals for the authorized account scope. */
  stats: {
    likeCount: number;
    followCount: number;
    unfollowCount: number;
  };
}

/** Response of `GET /api/admin/tracked-accounts/:id/liked-posts`. */
export interface AdminLikedPostsResponse {
  items: LikedPostItem[];
  total: number;
}

export interface AdminTrackedContentAccess {
  allowed: boolean;
  reason: null | "private_access_required" | "tracking_inactive" | "subscription_required";
}

/** Cached customer media without synthesizing analytics from missing evidence. */
export type AdminTrackedContentViewer = Pick<ViewerData,
  "igUsername" | "displayName" | "isVerified" | "isPrivate" |
  "followerCount" | "followingCount" | "postCount" | "recentPosts" |
  "stories" | "highlights" | "contentCachedAt" | "dataSource" | "postsCollection"
> & {
  profilePicUrl: string | null;
  biography?: string | null;
  externalUrl?: string | null;
  cachedAt?: string | null;
  isBusinessAccount?: boolean;
  profileSnapshot?: { snapshotAt?: string; followerCount?: number; followingCount?: number; postCount?: number } | null;
};

export interface AdminTrackedContentResponse {
  access: AdminTrackedContentAccess;
  viewer: AdminTrackedContentViewer | null;
  postsTotal: number;
  postCounts: Record<PostTypeFilter, number>;
}

export interface AdminTrackedPostsResponse {
  postsCollection?: import("../../../../shared/posts-collection-state").PostsCollectionState;
  items: ViewerRecentPost[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface AdminTrackedRosterResponse {
  items: Array<{ username: string; displayName: string | null; pfpUrl: string | null; igUserId: string | null }>;
  total: number;
  expectedTotal: number | null;
  offset: number;
  limit: number;
  hasMore: boolean;
  baselineSettled: boolean;
  lastUpdatedAt: string | null;
  syncState: string;
  isPartial: boolean;
  failureKind: string | null;
  nextRetryAt: string | null;
}

export interface AdminTrackedActivityResponse {
  items: Array<Omit<AdminActivityItem, "userId" | "userEmail" | "igUsername"> & { igUsername?: string; trackedAccountId?: string }>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}
