import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  Search,
  Heart,
  UserPlus,
  UserMinus,
  AlertTriangle,
  Activity,
  Image,
  Film,
  ChevronLeft,
  ChevronRight, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { adminFetch, formatRelative, type AdminActivityItem } from "./shared";
import { ForbiddenPanel } from "./ForbiddenPanel";
import { LikedPostLightbox } from "./LikedPostLightbox";
import MediaImage from "@/components/MediaImage";
import { useAdminSession } from "./AdminShell";

const EVENT_CONFIG = {
  like: {
    icon: Heart,
    color: "text-red-500",
    bg: "bg-red-100",
    label: "Liked",
  },
  follow: {
    icon: UserPlus,
    color: "text-emerald-500",
    bg: "bg-emerald-100",
    label: "Followed",
  },
  unfollow: {
    icon: UserMinus,
    color: "text-orange-500",
    bg: "bg-orange-100",
    label: "Unfollowed",
  },
  follower: { icon: UserPlus, color: "text-emerald-500", bg: "bg-emerald-100", label: "New follower" },
  follower_unfollow: { icon: UserMinus, color: "text-orange-500", bg: "bg-orange-100", label: "Lost follower" },
} as const;

const POST_TYPE_CONFIG: Record<string, { icon: React.ElementType; label: string }> = {
  photo: { icon: Image, label: "Photo" },
  video: { icon: Film, label: "Video" },
  reel: { icon: Film, label: "Reel" },
  carousel: { icon: Image, label: "Carousel" },
};

export default function AdminActivityFeed() {
  const [, setLocation] = useLocation();
  const session = useAdminSession();
  const [forbidden, setForbidden] = useState(false);
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<AdminActivityItem | null>(null);
  const perPage = 30;

  const activity = useQuery<{ items: AdminActivityItem[]; total: number; asOf: string;
    collectionHealth: { staleFollowerRosters: number; activeProfiles: number; postSuccessesLastHour: number; postFailuresLastHour: number } }>({
    queryKey: ["admin-activity", session?.id, typeFilter, appliedSearch, page],
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("v", "2");
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (appliedSearch) params.set("search", appliedSearch);
      params.set("page", String(page));
      params.set("limit", String(perPage));

      const res = await adminFetch(`/api/admin/activity?${params}`, { signal, cache: "no-store" });
      if (res.status === 401) {
        setLocation("/auth");
        throw new Error("Session expired");
      }
      if (res.status === 403) {
        setForbidden(true);
        throw new Error("Admin access denied");
      }
      if (!res.ok) throw new Error("Failed to fetch activity");
      const json = await res.json();
      if (!Array.isArray(json.items) || !Number.isSafeInteger(json.total) || json.total < 0 ||
          typeof json.asOf !== "string" || !Number.isFinite(Date.parse(json.asOf))) {
        throw new Error("Invalid activity response");
      }
      setForbidden(false);
      return json;
    },
  });
  const items = activity.data?.items ?? [];
  const total = activity.data?.total ?? 0;
  const loading = activity.isPending;
  const error = activity.isError ? "Activity refresh failed. Displayed data may be out of date." : "";
  useEffect(() => {
    if (activity.data) setPage(p => Math.min(p, Math.max(1, Math.ceil(activity.data.total / perPage))));
  }, [activity.data]);

  const handleTypeFilterChange = (value: string) => {
    setTypeFilter(value);
    setPage(1);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const next = search.trim();
    setAppliedSearch(next);
    setPage(1);
    if (page === 1 && next === appliedSearch) void activity.refetch();
  };

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const startItem = (page - 1) * perPage + 1;
  const endItem = Math.min(page * perPage, total);

  const getDetail = (item: AdminActivityItem) => {
    switch (item.eventType) {
      case "follower":
        return <span>gained follower <span className="font-medium text-slate-700">@{item.followerUsername ?? "unknown"}</span></span>;
      case "follower_unfollow":
        return <span>lost follower <span className="font-medium text-slate-700">@{item.unfollowerUsername ?? "unknown"}</span></span>;
      case "like":
        return item.thumbnailUrl || item.postUrl ? (
          <button
            type="button"
            onClick={() => setPreview(item)}
            className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 break-words hover:text-indigo-600 transition-colors text-left"
            title="Preview the post"
          >
            liked a post by{" "}
            <span className="min-w-0 max-w-full break-words font-medium text-slate-700">@{item.ownerUsername ?? "unknown"}</span>
            <ExternalLink className="w-3 h-3 opacity-60" />
          </button>
        ) : (
          <span>
            liked a post by{" "}
            <span className="font-medium text-slate-700">@{item.ownerUsername ?? "unknown"}</span>
          </span>
        );
      case "follow":
        return (
          <span>
            followed{" "}
            {item.followedUsername ? (
              <a
                href={`https://www.instagram.com/${item.followedUsername}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-slate-700 hover:text-indigo-600 transition-colors"
                title="Open the profile on Instagram"
              >
                @{item.followedUsername}
              </a>
            ) : (
              <span className="font-medium text-slate-700">@unknown</span>
            )}
          </span>
        );
      case "unfollow":
        return (
          <span>
            unfollowed{" "}
            {item.unfollowedUsername ? (
              <a
                href={`https://www.instagram.com/${item.unfollowedUsername}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-slate-700 hover:text-indigo-600 transition-colors"
                title="Open the profile on Instagram"
              >
                @{item.unfollowedUsername}
              </a>
            ) : (
              <span className="font-medium text-slate-700">@unknown</span>
            )}
          </span>
        );
    }
  };

  if (forbidden) {
    return <ForbiddenPanel />;
  }

  if (error && items.length === 0) {
    return (
      <div className="p-10 text-center">
        <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-amber-400" />
        <p className="text-slate-500">{error}</p>
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>Observed activity · timestamps show detection, not the exact Instagram action time.</span>
        <Button variant="outline" size="sm" onClick={() => void activity.refetch()} disabled={activity.isFetching}>
          {activity.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
        <span>{activity.data ? `Feed checked ${new Date(activity.data.asOf).toLocaleTimeString()}` : "Checking feed…"} · auto-refresh 15s. Collection may still have gaps.</span>
      </div>
      {error && <p role="alert" className="text-sm text-amber-700">{error}</p>}
      {activity.data?.collectionHealth && <p className="text-xs text-slate-600" data-testid="collection-health">
        Platform collection: {activity.data.collectionHealth.postSuccessesLastHour} successful / {activity.data.collectionHealth.postFailuresLastHour} failed posts reads in the last hour.
        {" "}{activity.data.collectionHealth.staleFollowerRosters}/{activity.data.collectionHealth.activeProfiles} profiles have no complete follower read within 48h.
        {" "}Refreshing this feed reads saved evidence; it does not refresh Instagram.
      </p>}
      {/* Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <form onSubmit={handleSearch} className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by IG username..."
            className="pl-10 h-11 bg-slate-50 border-slate-200 rounded-xl focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </form>
        <Select value={typeFilter} onValueChange={handleTypeFilterChange}>
          <SelectTrigger className="w-[160px] rounded-xl h-11">
            <SelectValue placeholder="Event type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Events</SelectItem>
            <SelectItem value="like">Likes</SelectItem>
            <SelectItem value="follow">Follows</SelectItem>
            <SelectItem value="unfollow">Unfollows</SelectItem>
            <SelectItem value="follower">New followers</SelectItem>
            <SelectItem value="follower_unfollow">Lost followers</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Feed */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Card className="border border-slate-200 shadow-sm">
          <CardContent className="p-10 text-center text-slate-400">
            <Activity className="w-10 h-10 mx-auto mb-3 text-slate-300" />
            <p>No activity found.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => {
            const cfg = EVENT_CONFIG[item.eventType];
            const EventIcon = cfg.icon;
            const postTypeCfg = item.postType
              ? POST_TYPE_CONFIG[item.postType]
              : null;

            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.02 }}
              >
                <Card className="border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                  <CardContent className="p-4">
                    <div className="flex min-w-0 items-start gap-3">
                      {/* Event icon */}
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${cfg.bg}`}
                      >
                        <EventIcon className={`w-4 h-4 ${cfg.color}`} />
                      </div>

                      {/* Post thumbnail opens the saved in-app preview. */}

                      {item.eventType === "like" && item.thumbnailUrl && (

                        <button

                          type="button"

                          onClick={() => setPreview(item)}

                          className="shrink-0 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"

                          title={item.caption ? item.caption.slice(0, 140) : "Preview the post"}

                        >

                          <MediaImage src={item.thumbnailUrl}
                            alt={`Post by @${item.ownerUsername ?? "unknown"}`}
                            className="w-11 h-11 rounded-lg" />

                        </button>

                      )}

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex min-w-0 items-center gap-2 flex-wrap">
                          <span className="min-w-0 max-w-full break-words font-semibold text-slate-800 text-sm">
                            @{item.igUsername}
                          </span>
                          <span className="min-w-0 max-w-full break-words text-sm text-slate-500">
                            {getDetail(item)}
                          </span>
                          {item.eventType === "like" && postTypeCfg && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 inline-flex items-center gap-1">
                              <postTypeCfg.icon className="w-3 h-3" />
                              {postTypeCfg.label}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="min-w-0 max-w-full break-words text-xs text-slate-400">
                            <time dateTime={item.detectedAt} title={new Date(item.detectedAt).toLocaleString()}>Detected {formatRelative(item.detectedAt)}</time>
                          </span>
                          <span className="text-xs text-slate-300">|</span>
                          <span className="min-w-0 max-w-full break-all text-xs text-slate-400">
                            {item.userEmail}
                          </span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      <LikedPostLightbox item={preview} onClose={() => setPreview(null)} />


      {/* Pagination */}
      {!loading && items.length > 0 && (
        <div className="flex items-center justify-between">
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
    </motion.div>
  );
}
