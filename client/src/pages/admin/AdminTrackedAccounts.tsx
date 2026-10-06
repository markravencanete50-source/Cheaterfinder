import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Instagram,
  RotateCw,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { proxyUrl } from "@/lib/img-proxy";
import {
  adminFetch,
  formatDateShort,
  ACCESS_STATUS_CONFIG,
  type AdminTrackedAccountRow,
} from "./shared";
import { useAdminSession } from "./AdminShell";
import { ForbiddenPanel } from "./ForbiddenPanel";
import { useToast } from "@/hooks/use-toast";

const PER_PAGE = 20;
const PANEL =
  "bg-white rounded-2xl border border-slate-200/60 shadow-[0_2px_8px_rgb(0,0,0,0.04)]";
const TH =
  "px-4 py-3 text-xs uppercase tracking-wider text-slate-500 font-semibold";

/** Real profile picture with a letter fallback when the CDN URL 404s. */
function AccountAvatar({
  username,
  profilePicUrl,
  size = "h-9 w-9",
}: {
  username: string;
  profilePicUrl?: string | null;
  size?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [profilePicUrl]);

  const shell = `${size} shrink-0 rounded-full overflow-hidden ring-1 ring-slate-200 bg-slate-100 flex items-center justify-center`;

  if (!profilePicUrl || failed) {
    return (
      <div className={shell}>
        <span className="text-xs font-semibold text-slate-400">
          {username.charAt(0).toUpperCase()}
        </span>
      </div>
    );
  }
  return (
    <div className={shell}>
      <img
        src={proxyUrl(profilePicUrl)}
        alt={`@${username}`}
        className="h-full w-full object-cover"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/** Quiet, semantically-coloured metric cell. Zeroes recede. */
function MetricCell({ value, tone }: { value: number; tone: string }) {
  return (
    <td
      className={`px-4 py-3 text-right text-sm tabular-nums ${
        value > 0 ? tone : "text-slate-300"
      }`}
    >
      {value.toLocaleString()}
    </td>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="border-t border-slate-100">
          <td className="px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-full bg-slate-100" />
              <div className="space-y-1.5">
                <div className="h-3 w-28 rounded bg-slate-100" />
                <div className="h-2.5 w-20 rounded bg-slate-50" />
              </div>
            </div>
          </td>
          <td className="px-4 py-3">
            <div className="h-3 w-40 rounded bg-slate-100" />
          </td>
          <td className="px-4 py-3">
            <div className="ml-auto h-3 w-14 rounded bg-slate-100" />
          </td>
          <td className="px-4 py-3">
            <div className="mx-auto h-5 w-9 rounded-full bg-slate-100" />
          </td>
          <td className="px-4 py-3">
            <div className="h-5 w-16 rounded-full bg-slate-100" />
          </td>
          {[0, 1, 2].map((n) => (
            <td key={n} className="px-4 py-3">
              <div className="ml-auto h-3 w-8 rounded bg-slate-100" />
            </td>
          ))}
          <td className="px-4 py-3">
            <div className="h-3 w-20 rounded bg-slate-100" />
          </td>
        </tr>
      ))}
    </>
  );
}

/** Horizontal strip of the signed-in admin's own tracked accounts. */
function YourAccountsStrip({
  accounts,
  onSelectAccount,
}: {
  accounts: AdminTrackedAccountRow[];
  onSelectAccount: (id: string) => void;
}) {
  if (accounts.length === 0) return null;
  return (
    <section className={`${PANEL} p-4`} aria-label="Your tracked accounts">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
          Your accounts
        </h2>
        <span className="text-xs text-slate-400 tabular-nums">
          {accounts.length} on this page
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {accounts.map((acc) => (
          <button
            key={acc.id}
            type="button"
            onClick={() => onSelectAccount(acc.id)}
            aria-label={`Open details for @${acc.igUsername}`}
            className="group flex shrink-0 items-center gap-3 rounded-xl border border-slate-200/70 bg-slate-50/60 px-3 py-2 text-left cursor-pointer transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
          >
            <AccountAvatar
              username={acc.igUsername}
              profilePicUrl={acc.profilePicUrl}
              size="h-8 w-8"
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-slate-800">
                @{acc.igUsername}
              </span>
              <span className="block text-xs tabular-nums text-slate-400">
                <span className="text-rose-600">
                  {acc.likeCount.toLocaleString()}
                </span>
                {" likes · "}
                <span className="text-emerald-600">
                  {acc.followCount.toLocaleString()}
                </span>
                {" follows"}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default function AdminTrackedAccounts({
  onSelectAccount,
}: {
  onSelectAccount: (id: string) => void;
}) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const session = useAdminSession();
  // `useAdminSession()` is null while the probe is in flight, so every
  // "is this mine?" check keys off this nullable id rather than the session.
  const myUserId = session?.id ?? null;
  const [accounts, setAccounts] = useState<AdminTrackedAccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [accessFilter, setAccessFilter] = useState("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchAccounts = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (activeFilter !== "all") params.set("status", activeFilter);
      if (accessFilter !== "all") params.set("access", accessFilter);
      // Server-side, so "Mine" spans every page — a client filter on the loaded
      // page silently missed the admin's accounts on page 2+.
      if (mineOnly) params.set("owner", "me");
      params.set("page", String(page));
      params.set("limit", String(PER_PAGE));

      const res = await adminFetch(`/api/admin/tracked-accounts?${params}`, {
        signal,
      });
      if (res.status === 401) {
        setLocation("/auth");
        return;
      }
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch tracked accounts");
      const json = await res.json();
      setAccounts(json.items ?? []);
      setTotal(json.total ?? 0);
      setForbidden(false);
      setError("");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Failed to load tracked accounts.");
    } finally {
      setLoading(false);
    }
  };

  // Refetch on page OR filter change. When a filter changes off page 1, the
  // batched setPage(1) + filter update render once, so this runs exactly once.
  // On page 1, setPage(1) is a no-op but the filter dep still triggers the
  // refetch. `search` is intentionally excluded: it is applied on form submit.
  useEffect(() => {
    const controller = new AbortController();
    fetchAccounts(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, activeFilter, accessFilter, mineOnly]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (page !== 1) {
      // setPage(1) re-runs the fetch effect with the new search applied.
      setPage(1);
      return;
    }
    fetchAccounts();
  };

  const handleToggle = async (id: string, isActive: boolean) => {
    setToggling(id);
    try {
      const res = await adminFetch(`/api/admin/tracked-accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !isActive }),
      });
      if (res.ok) {
        setAccounts((prev) =>
          prev.map((a) => (a.id === id ? { ...a, isActive: !isActive } : a)),
        );
      } else {
        // Switch never flipped (state unchanged), so it visibly reverts.
        const errData = await res.json().catch(() => ({}));
        toast({
          variant: "destructive",
          title: "Failed to update tracking",
          description: errData.message || `Request failed (${res.status}).`,
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to update tracking",
        description:
          err instanceof Error ? err.message : "Network error. Please retry.",
      });
      fetchAccounts(); // refetch to show correct state
    } finally {
      setToggling(null);
    }
  };

  const myAccounts = useMemo(
    () => (myUserId ? accounts.filter((a) => a.userId === myUserId) : []),
    [accounts, myUserId],
  );

  /**
   * @username -> how many ACTIVE loaded rows track it (two owners on one IG
   * user). Inactive rows are excluded so the pill agrees with the detail
   * sheet's "Tracked by", which lists active twins only — @tracked_user_1 read ×3
   * here while the sheet correctly said 2.
   */
  const ownersByUsername = useMemo(() => {
    const counts = new Map<string, number>();
    for (const acc of accounts) {
      if (!acc.isActive) continue;
      const key = acc.igUsername.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [accounts]);

  const visible = accounts;

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const startItem = (page - 1) * PER_PAGE + 1;
  const endItem = Math.min(page * PER_PAGE, total);

  if (forbidden) {
    return <ForbiddenPanel />;
  }

  if (error && accounts.length === 0) {
    return (
      <div className={`${PANEL} p-12 text-center`}>
        <AlertTriangle className="w-9 h-9 mx-auto mb-3 text-amber-400" />
        <p className="text-slate-600 font-medium">{error}</p>
        <p className="text-sm text-slate-400 mt-1">
          The request did not complete. Check your connection and retry.
        </p>
        <Button
          variant="outline"
          className="mt-5 rounded-full cursor-pointer"
          onClick={() => fetchAccounts()}
        >
          <RotateCw className="w-4 h-4 mr-2" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.1 }}
      className="space-y-4"
    >
      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
        <form onSubmit={handleSearch} className="relative flex-1 w-full">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by IG username or owner…"
            aria-label="Search tracked accounts"
            className="pl-10 h-11 bg-white border-slate-200 rounded-xl focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </form>

        <button
          type="button"
          onClick={() => {
            setMineOnly((v) => !v);
            setPage(1);
          }}
          disabled={!myUserId}
          aria-pressed={mineOnly}
          title={myUserId ? "Show only accounts you own" : "Sign-in details unavailable"}
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 ${
            mineOnly
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          Mine
          {mineOnly && (
            <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-xs tabular-nums">
              {total}
            </span>
          )}
        </button>

        <Select
          value={activeFilter}
          onValueChange={(v) => {
            setActiveFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-[130px] rounded-xl h-11 bg-white cursor-pointer">
            <SelectValue placeholder="Active" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={accessFilter}
          onValueChange={(v) => {
            setAccessFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-[150px] rounded-xl h-11 bg-white cursor-pointer">
            <SelectValue placeholder="Access" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All access</SelectItem>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="pending_access">Pending</SelectItem>
            <SelectItem value="has_access">Has access</SelectItem>
            <SelectItem value="access_denied">Denied</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!mineOnly && !loading && (
        <YourAccountsStrip
          accounts={myAccounts}
          onSelectAccount={onSelectAccount}
        />
      )}

      {/* Table */}
      <div className={`${PANEL} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/70">
                <th className={TH}>Account</th>
                <th className={TH}>Owner</th>
                <th className={`${TH} text-right`}>Followers</th>
                <th className={`${TH} text-center`}>Tracking</th>
                <th className={TH}>Access</th>
                <th className={`${TH} text-right`}>Likes</th>
                <th className={`${TH} text-right`}>Follows</th>
                <th className={`${TH} text-right`}>Unfollows</th>
                <th className={TH}>Since</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows />
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center">
                    <Instagram className="w-9 h-9 mx-auto mb-3 text-slate-300" />
                    <p className="text-slate-600 font-medium">
                      {mineOnly
                        ? "You don't track any accounts yet"
                        : "No tracked accounts found"}
                    </p>
                    <p className="text-sm text-slate-400 mt-1">
                      {mineOnly
                        ? "Add one from the Dashboard and it will appear here."
                        : "Try a different search term or loosen the filters."}
                    </p>
                  </td>
                </tr>
              ) : (
                visible.map((acc) => {
                  const accessCfg =
                    ACCESS_STATUS_CONFIG[acc.accessStatus] ??
                    ACCESS_STATUS_CONFIG.public;
                  const ownerCount =
                    ownersByUsername.get(acc.igUsername.toLowerCase()) ?? 1;
                  const isMine = !!myUserId && acc.userId === myUserId;
                  return (
                    <tr
                      key={acc.id}
                      onClick={() => onSelectAccount(acc.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelectAccount(acc.id);
                        }
                      }}
                      tabIndex={0}
                      aria-label={`Open details for @${acc.igUsername}`}
                      className="border-t border-slate-100 cursor-pointer transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <AccountAvatar
                            username={acc.igUsername}
                            profilePicUrl={acc.profilePicUrl}
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-slate-900 truncate">
                                @{acc.igUsername}
                              </span>
                              {ownerCount > 1 && (
                                <span
                                  title={`Tracked by ${ownerCount} owners`}
                                  className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-500"
                                >
                                  ×{ownerCount}
                                </span>
                              )}
                              {isMine && (
                                <span
                                  title="You track this account"
                                  className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                                >
                                  You
                                </span>
                              )}
                            </div>
                            {acc.displayName && (
                              <p className="text-xs text-slate-400 truncate">
                                {acc.displayName}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-sm text-slate-700 truncate">
                          {acc.userEmail}
                        </p>
                        {acc.userName && (
                          <p className="text-xs text-slate-400 truncate">
                            {acc.userName}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm tabular-nums text-slate-700">
                        {acc.followerCount.toLocaleString()}
                      </td>
                      <td
                        className="px-4 py-3 text-center"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <Switch
                          checked={acc.isActive}
                          disabled={toggling === acc.id}
                          aria-label={`${acc.isActive ? "Pause" : "Resume"} tracking for @${acc.igUsername}`}
                          className="cursor-pointer"
                          onCheckedChange={() =>
                            handleToggle(acc.id, acc.isActive)
                          }
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${accessCfg.className}`}
                        >
                          {accessCfg.label}
                        </span>
                        {acc.isPrivate && (
                          <span className="ml-1.5 inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                            Private
                          </span>
                        )}
                      </td>
                      <MetricCell value={acc.likeCount} tone="text-rose-600" />
                      <MetricCell
                        value={acc.followCount}
                        tone="text-emerald-600"
                      />
                      <MetricCell
                        value={acc.unfollowCount}
                        tone="text-amber-600"
                      />
                      <td className="px-4 py-3 text-sm text-slate-500 whitespace-nowrap">
                        {formatDateShort(acc.trackingStarted)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {!loading && accounts.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="text-sm text-slate-500 tabular-nums">
            Showing {startItem}–{endItem} of {total}
            {mineOnly && ` · ${visible.length} yours on this page`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full cursor-pointer"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="w-4 h-4 mr-1" /> Previous
            </Button>
            <span className="text-sm text-slate-500 tabular-nums">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full cursor-pointer"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
