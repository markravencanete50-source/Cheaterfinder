import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  ExternalLink,
  Heart,
  Instagram,
  Lock,
  RotateCw,
  SearchX,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import MediaImage from "@/components/MediaImage";
import OwnPostsGrid from "@/components/dashboard/OwnPostsGrid";
import StoriesViewer from "@/components/dashboard/StoriesViewer";
import HighlightsCarousel from "@/components/dashboard/HighlightsCarousel";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { PostTypeFilter } from "@/components/dashboard/types";
import LikedPostsGallery from "@/components/dashboard/LikedPostsGallery";
import {
  adminFetch,
  formatDateShort,
  ACCESS_STATUS_CONFIG,
  type AdminTrackedAccountDetailData,
  type AdminTrackedAccountOwner,
  type LikedPostItem,
  type AdminTrackedContentResponse,
  type AdminTrackedPostsResponse,
  type AdminLikedPostsResponse,
  type AdminTrackedContentAccess,
  type AdminTrackedRosterResponse,
  type AdminTrackedActivityResponse,
} from "./shared";
import { ForbiddenPanel } from "./ForbiddenPanel";

const PAGE_SIZE = 200;
const CARD =
  "bg-white rounded-2xl border border-slate-200/60 shadow-[0_2px_8px_rgb(0,0,0,0.04)]";

type LoadState = "loading" | "ok" | "error" | "forbidden" | "notFound";

function Avatar({
  username,
  profilePicUrl,
}: {
  username: string;
  profilePicUrl: string | null;
}) {
  return <MediaImage src={profilePicUrl} alt={`@${username}`} loading="eager"
    className="h-16 w-16 shrink-0 rounded-full ring-1 ring-slate-200"
    fallback={<span className="text-xl font-semibold text-slate-400">{username.charAt(0).toUpperCase()}</span>} />;
}

function AccountHeader({
  account,
}: {
  account: AdminTrackedAccountDetailData["account"];
}) {
  const accessCfg =
    ACCESS_STATUS_CONFIG[account.accessStatus] ?? ACCESS_STATUS_CONFIG.public;
  return (
    <div className={`${CARD} p-5 flex items-start gap-4`}>
      <Avatar
        username={account.igUsername}
        profilePicUrl={account.profilePicUrl}
      />
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-2xl text-slate-900 truncate">
          @{account.igUsername}
        </h2>
        {account.displayName && (
          <p className="text-sm text-slate-500 truncate">
            {account.displayName}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${accessCfg.className}`}
          >
            {accessCfg.label}
          </span>
          {account.isPrivate && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
              <Lock className="h-3 w-3" /> Private
            </span>
          )}
          {!account.isActive && (
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
              Tracking paused
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-500 tabular-nums">
            <Users className="h-3 w-3" />
            {account.followerCount.toLocaleString()} followers
          </span>
        </div>
        <p className="mt-2.5 text-xs text-slate-400">
          Tracking since {formatDateShort(account.trackingStarted)}
        </p>
      </div>
    </div>
  );
}

function OwnersRow({ owners }: { owners: AdminTrackedAccountOwner[] }) {
  if (owners.length === 0) return null;
  return (
    <div className={`${CARD} p-5`}>
      <h3 className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
        Tracked by
      </h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {owners.map((owner) => (
          <span
            key={owner.trackedAccountId}
            className="inline-flex items-center gap-2 rounded-full border border-slate-200/70 bg-slate-50/60 px-3 py-1.5"
          >
            <span className="text-sm font-medium text-slate-700">
              {owner.userName || owner.userEmail}
            </span>
            <span className="text-xs text-slate-400">
              since {formatDateShort(owner.trackingStarted)}
            </span>
            {!owner.isActive && (
              <span className="text-xs font-medium text-slate-400">paused</span>
            )}
          </span>
        ))}
      </div>
      {owners.length > 1 && (
        <p className="mt-3 text-xs text-slate-400">
          Content below follows the selected account’s access and collection scope.
        </p>
      )}
    </div>
  );
}

function StatsStrip({
  stats,
}: {
  stats: AdminTrackedAccountDetailData["stats"];
}) {
  const cells: Array<{ label: string; value: number; tone: string }> = [
    { label: "Likes", value: stats.likeCount, tone: "text-rose-600" },
    { label: "Follows", value: stats.followCount, tone: "text-emerald-600" },
    { label: "Unfollows", value: stats.unfollowCount, tone: "text-amber-600" },
  ];
  return (
    <div className={`${CARD} flex divide-x divide-slate-200/70 px-5 py-4`}>
      {cells.map((cell, i) => (
        <div
          key={cell.label}
          className={`flex min-w-0 flex-1 flex-col ${i === 0 ? "pr-3" : "px-3"}`}
        >
          <span
            className={`text-2xl font-semibold tabular-nums ${
              cell.value > 0 ? cell.tone : "text-slate-300"
            }`}
          >
            {cell.value.toLocaleString()}
          </span>
          <span className="text-xs text-slate-400">{cell.label}</span>
        </div>
      ))}
    </div>
  );
}

function InlineState({
  icon,
  title,
  body,
  onRetry,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onRetry?: () => void;
}) {
  return (
    <div className={`${CARD} p-12 text-center`}>
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100">
        {icon}
      </div>
      <p className="font-medium text-slate-700">{title}</p>
      <p className="mt-1 text-sm text-slate-400">{body}</p>
      {onRetry && (
        <Button
          variant="outline"
          className="mt-5 rounded-full cursor-pointer"
          onClick={onRetry}
        >
          <RotateCw className="mr-2 h-4 w-4" /> Retry
        </Button>
      )}
    </div>
  );
}

/** Every request belongs to the current mounted account and latest retry. */
function useAdminResource<T>(url: string | null) {
  const [, setLocation] = useLocation();
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    controller.current?.abort();
    const current = ++generation.current;
    if (!url) { setData(null); return; }
    const request = new AbortController();
    controller.current = request;
    setState("loading"); setError("");
    try {
      const response = await adminFetch(url, { signal: request.signal });
      if (request.signal.aborted || current !== generation.current) return;
      if (response.status === 401) { setData(null); setState("forbidden"); setLocation("/auth"); return; }
      if (response.status === 403) { setData(null); setState("forbidden"); return; }
      if (response.status === 404) { setData(null); setState("notFound"); return; }
      if (!response.ok) throw new Error(`Request failed (${response.status}).`);
      const result = await response.json() as T;
      if (request.signal.aborted || current !== generation.current) return;
      setData(result); setState("ok");
    } catch (failure) {
      if (request.signal.aborted || current !== generation.current) return;
      setError(failure instanceof Error ? failure.message : "Network error. Please retry.");
      setState("error");
    }
  }, [url, setLocation]);
  useEffect(() => { void reload(); return () => { generation.current++; controller.current?.abort(); }; }, [reload]);
  return { state, data, error, reload };
}

function ResourceState({ resource, label }: {
  resource: { state: LoadState; error: string; reload: () => void };
  label: string;
}) {
  if (resource.state === "loading") return <div role="status" aria-label={`Loading ${label}`} className="space-y-3 p-4"><Skeleton className="h-24 w-full rounded-xl" /><Skeleton className="h-24 w-full rounded-xl" /></div>;
  if (resource.state === "forbidden") return <InlineState icon={<Lock className="h-5 w-5 text-slate-400" />} title="Content is unavailable" body="Current access is required to view this collected content." />;
  return <InlineState icon={<AlertTriangle className="h-5 w-5 text-amber-500" />}
    title={resource.state === "notFound" ? `${label} not found` : `Could not load ${label}`}
    body={resource.error || "The account or its collected content is no longer available."} onRetry={resource.reload} />;
}

function ContentAccessNotice({ access }: { access: AdminTrackedContentAccess }) {
  const message = access.reason === "tracking_inactive"
    ? "Tracking is paused. Private content is hidden until tracking and authorized access are active."
    : access.reason === "subscription_required"
      ? "The tracking owner needs current subscription access before private content can be viewed."
      : "The owner must approve a service account before private content can be viewed. Cached content does not establish current access.";
  return <div data-testid="admin-content-blocked"><InlineState icon={<Lock className="h-5 w-5 text-slate-400" />} title="Private content is unavailable" body={message} /></div>;
}

function PostsPane({ accountId, content }: { accountId: string; content: AdminTrackedContentResponse }) {
  const [postType, setPostType] = useState<PostTypeFilter>("all");
  const endpoint = `/api/admin/tracked-accounts/${encodeURIComponent(accountId)}/posts`;
  const filtered = useAdminResource<AdminTrackedPostsResponse>(postType === "all" ? null : `${endpoint}?offset=0&limit=24&postType=${postType}`);
  const viewer = content.viewer!;
  const posts = postType === "all" ? viewer.recentPosts ?? [] : filtered.data?.items;
  return <div className="space-y-3" data-testid="admin-content-posts">
    {!viewer.postsCollection && <p className="text-xs text-slate-500">{content.postsTotal.toLocaleString()} saved posts. {viewer.profileSnapshot === null ? "No profile count has been collected yet." : `Last recorded profile count: ${viewer.postCount.toLocaleString()} posts.`} Saved content may be incomplete.</p>}
    {postType !== "all" && filtered.state !== "ok" && filtered.state !== "loading"
      ? <><Button variant="outline" onClick={() => setPostType("all")}>Show all post types</Button><ResourceState resource={filtered} label="posts" /></>
      : <OwnPostsGrid key={postType} posts={posts} postType={postType} onPostTypeChange={setPostType}
        postCounts={content.postCounts} accountId={accountId} postsEndpoint={endpoint} engagementBasePath={endpoint}
        collectionStatus={filtered.data?.postsCollection ?? viewer.postsCollection}
        dataSource={viewer.dataSource ?? "cached"} cachedAt={viewer.contentCachedAt?.posts ?? undefined}
        isFetching={postType !== "all" && filtered.state === "loading"} />}
  </div>;
}

function LikedPostsPane({ accountId }: { accountId: string }) {
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<LikedPostItem[]>([]);
  const [total, setTotal] = useState(0);
  const resource = useAdminResource<AdminLikedPostsResponse>(`/api/admin/tracked-accounts/${encodeURIComponent(accountId)}/liked-posts?limit=${PAGE_SIZE}&offset=${offset}`);
  useEffect(() => {
    if (resource.state !== "ok" || !resource.data) return;
    setItems(previous => [...new Map([...(offset ? previous : []), ...resource.data!.items].map(item => [item.id, item])).values()]);
    setTotal(resource.data.total);
  }, [resource.data, resource.state, offset]);
  if (resource.state === "forbidden" || resource.state === "notFound" || (!items.length && resource.state !== "ok")) return <ResourceState resource={resource} label="liked posts" />;
  return <section className={`${CARD} p-4 sm:p-5`} data-testid="admin-content-liked-posts">
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-semibold text-slate-900">Liked posts</h3><span className="text-xs text-slate-500">{items.length} of {total} saved posts</span></div>
    {items.length ? <LikedPostsGallery events={items} showTitle={false} /> : <p className="py-8 text-center text-sm text-slate-500">No liked posts have been detected. This does not establish that there was no activity.</p>}
    <p className="mt-3 text-xs text-slate-500">Likes are inferred from observed liker lists. Filter counts reflect the loaded posts.</p>
    {resource.state === "error" ? <div role="alert" className="mt-3 text-sm text-amber-700">Could not load more liked posts. <Button variant="outline" onClick={() => void resource.reload()}>Retry liked posts</Button></div>
      : items.length < total && <Button className="mt-4" variant="outline" disabled={resource.state === "loading"}
        onClick={() => setOffset(items.length)}>{resource.state === "loading" ? "Loading…" : "Load more liked posts"}</Button>}
  </section>;
}

function CachedListPane({ accountId, section }: { accountId: string; section: "followers" | "following" | "activity" }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const roster = section !== "activity";
  const base = `/api/admin/tracked-accounts/${encodeURIComponent(accountId)}`;
  const suffix = roster ? `/roster?dimension=${section === "followers" ? "follower" : "following"}&` : "/activity?";
  const resource = useAdminResource<AdminTrackedRosterResponse | AdminTrackedActivityResponse>(`${base}${suffix}offset=${offset}&limit=100`);
  const label = section === "activity" ? "observed activity" : section;
  if (resource.state !== "ok" || !resource.data) return <ResourceState resource={resource} label={label} />;
  const page = resource.data;
  const query = search.trim().toLowerCase();
  const rosterPage = roster ? page as AdminTrackedRosterResponse : null;
  const rows = rosterPage?.items.filter(item => `${item.username} ${item.displayName ?? ""}`.toLowerCase().includes(query));
  return <section className={`${CARD} min-w-0 p-4 sm:p-5`} data-testid={`admin-content-${section}`}>
    <h3 className="text-sm font-semibold capitalize text-slate-900">{label}</h3>
    {rosterPage && <>
      <p className="mt-2 text-xs text-slate-500">{rosterPage.total.toLocaleString()} saved members. {rosterPage.expectedTotal === null ? "The profile total is not available yet." : `Profile reported ${rosterPage.expectedTotal.toLocaleString()}.`} {rosterPage.isPartial ? "Collection is incomplete." : "Saved member count matches the reported total."} {!rosterPage.baselineSettled && "The baseline is not yet settled."}</p>
      {(rosterPage.failureKind || rosterPage.nextRetryAt) && <p className="mt-2 text-xs text-amber-700">{rosterPage.failureKind ? `Collection status: ${rosterPage.failureKind.replaceAll("_", " ")}. ` : ""}{rosterPage.nextRetryAt ? `Next retry: ${new Date(rosterPage.nextRetryAt).toLocaleString()}.` : ""}</p>}
      {rosterPage.lastUpdatedAt && <p className="mt-1 text-xs text-slate-500">Last saved update: {new Date(rosterPage.lastUpdatedAt).toLocaleString()}</p>}
      <label className="mt-4 block text-xs text-slate-500">Search this page<input value={search} onChange={event => setSearch(event.target.value)} type="search" aria-label={`Search ${section} on this page`} className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900" /></label>
      <div className="mt-3 divide-y divide-slate-100">{rows?.map(item => <div key={item.igUserId ?? item.username} className="flex min-w-0 items-center gap-3 py-3">
        <MediaImage src={item.pfpUrl} alt={`@${item.username}`} className="h-10 w-10 shrink-0 rounded-full" fallback={<Users className="h-4 w-4 text-slate-400" />} />
        <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">@{item.username}</p>{item.displayName && <p className="truncate text-xs text-slate-500">{item.displayName}</p>}</div>
      </div>)}</div>
      {!rows?.length && <p className="py-8 text-center text-sm text-slate-500">{query ? "No saved members match on this page." : "No members have been collected for this roster yet."}</p>}
    </>}
    {!roster && <>
      <p className="mt-2 text-xs text-slate-500">Times show when a change was detected, not when the person acted. Only observed activity is shown.</p>
      <div className="mt-3 divide-y divide-slate-100">{(page as AdminTrackedActivityResponse).items.map(event => <div key={event.id} className="flex min-w-0 items-start gap-3 py-3">
        {event.eventType === "like" ? <MediaImage src={event.thumbnailUrl} alt="Observed liked post" className="h-12 w-12 shrink-0 rounded-lg" fallback={<Heart className="h-4 w-4 text-slate-400" />} /> : <Users className="mt-1 h-5 w-5 shrink-0 text-slate-400" />}
        <div className="min-w-0"><p className="break-words text-sm text-slate-800">{event.eventType === "like" ? `Liked a post by @${event.ownerUsername ?? "unknown"}` : event.eventType === "follow" ? `Followed @${event.followedUsername ?? "unknown"}` : event.eventType === "follower" ? `New follower: @${event.followerUsername ?? "unknown"}` : event.eventType === "follower_unfollow" ? `Lost follower: @${event.unfollowerUsername ?? "unknown"}` : `Unfollowed @${event.unfollowedUsername ?? "unknown"}`}</p><p className="mt-1 text-xs text-slate-500">Detected {new Date(event.detectedAt).toLocaleString()}</p>{event.caption && <p className="mt-1 line-clamp-2 break-words text-xs text-slate-500">{event.caption}</p>}</div>
      </div>)}</div>
      {!page.items.length && <p className="py-8 text-center text-sm text-slate-500">No activity has been observed in this tracking scope. This does not establish that there was no activity.</p>}
    </>}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-slate-500">{page.items.length ? offset + 1 : 0}–{offset + page.items.length} of {page.total}</span><div className="flex gap-2"><Button variant="outline" disabled={offset === 0} onClick={() => { setSearch(""); setOffset(Math.max(0, offset - page.limit)); }}>Previous {section}</Button><Button variant="outline" disabled={!page.hasMore || !page.items.length || !(page.limit > 0)} onClick={() => { setSearch(""); setOffset(offset + page.limit); }}>Next {section}</Button></div></div>
  </section>;
}

function CachedContent({ accountId, onProfilePicture }: { accountId: string; onProfilePicture: (url: string | null) => void }) {
  const resource = useAdminResource<AdminTrackedContentResponse>(`/api/admin/tracked-accounts/${encodeURIComponent(accountId)}/content`);
  useEffect(() => {
    const picture = resource.state === "ok" && resource.data?.access.allowed ? resource.data.viewer?.profilePicUrl : null;
    onProfilePicture(typeof picture === "string" && picture.trim() ? picture : null);
  }, [resource.state, resource.data, onProfilePicture]);
  if (resource.state !== "ok" || !resource.data) return <ResourceState resource={resource} label="collected content" />;
  const content = resource.data;
  if (!content.access.allowed) return <div className="space-y-3"><ContentAccessNotice access={content.access} /><Button variant="outline" onClick={() => void resource.reload()}>Refresh access status</Button></div>;
  if (!content.viewer) return <InlineState icon={<SearchX className="h-5 w-5 text-slate-400" />} title="No collected profile data" body="A successful collection is needed before content can be shown." />;
  const viewer = content.viewer;
  let website: string | null = null;
  try { const url = new URL(viewer.externalUrl ?? ""); if (["https:", "http:"].includes(url.protocol)) website = url.href; } catch { /* No usable profile website. */ }
  return <div className="min-w-0 space-y-4">
    <section className={`${CARD} p-4 sm:p-5`} aria-label="Collected profile information">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-600">{viewer.profileSnapshot === null ? <span>No profile snapshot has been collected yet.</span> : <><span>{viewer.followerCount.toLocaleString()} reported followers</span><span>{viewer.followingCount.toLocaleString()} reported following</span><span>{viewer.postCount.toLocaleString()} reported posts</span></>}{viewer.isVerified && <span>Verified profile</span>}{viewer.isBusinessAccount && <span>Business profile</span>}</div>
      {viewer.biography && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-600">{viewer.biography}</p>}
      {website && <a href={website} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1 break-all text-sm text-primary"><ExternalLink className="h-3 w-3 shrink-0" />{website}</a>}
      <p className="mt-3 text-xs text-slate-500">Saved content only. Opening this view does not start a new collection.{viewer.cachedAt ? ` Last cached update: ${formatDateShort(viewer.cachedAt)}.` : " No cache update time is available."}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={() => void resource.reload()}><RotateCw className="mr-2 h-3.5 w-3.5" />Refresh saved view</Button>
    </section>
    <Tabs defaultValue="posts" className="min-w-0">
      <div className="max-w-full overflow-x-auto pb-1"><TabsList aria-label="Collected content sections" className="w-max justify-start">
        <TabsTrigger value="posts" data-testid="admin-content-tab-posts">Posts</TabsTrigger>
        <TabsTrigger value="stories" data-testid="admin-content-tab-stories">Stories</TabsTrigger>
        <TabsTrigger value="highlights" data-testid="admin-content-tab-highlights">Highlights</TabsTrigger>
        <TabsTrigger value="liked" data-testid="admin-content-tab-liked">Liked posts</TabsTrigger>
        <TabsTrigger value="followers" data-testid="admin-content-tab-followers">Followers</TabsTrigger>
        <TabsTrigger value="following" data-testid="admin-content-tab-following">Following</TabsTrigger>
        <TabsTrigger value="activity" data-testid="admin-content-tab-activity">Activity</TabsTrigger>
      </TabsList></div>
      <TabsContent value="posts"><PostsPane accountId={accountId} content={content} /></TabsContent>
      <TabsContent value="stories"><StoriesViewer stories={viewer.stories ?? []} dataSource={viewer.dataSource ?? "cached"} cachedAt={viewer.contentCachedAt?.stories ?? undefined} /></TabsContent>
      <TabsContent value="highlights"><HighlightsCarousel highlights={viewer.highlights ?? []} dataSource={viewer.dataSource ?? "cached"} cachedAt={viewer.contentCachedAt?.highlights ?? undefined} /></TabsContent>
      <TabsContent value="liked"><LikedPostsPane accountId={accountId} /></TabsContent>
      <TabsContent value="followers"><CachedListPane accountId={accountId} section="followers" /></TabsContent>
      <TabsContent value="following"><CachedListPane accountId={accountId} section="following" /></TabsContent>
      <TabsContent value="activity"><CachedListPane accountId={accountId} section="activity" /></TabsContent>
    </Tabs>
  </div>;
}

function AccountDetail({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const resource = useAdminResource<AdminTrackedAccountDetailData>(`/api/admin/tracked-accounts/${encodeURIComponent(accountId)}`);
  const [contentProfilePicture, setContentProfilePicture] = useState<string | null>(null);
  const data = resource.data;
  return <Sheet open onOpenChange={open => !open && onClose()}>
    <SheetContent side="right" className="w-full sm:max-w-4xl overflow-y-auto p-4 sm:p-6" data-testid="admin-tracked-detail">
      <SheetHeader className="mb-6 pr-7"><SheetTitle className="flex items-center gap-2"><Instagram className="h-5 w-5 text-primary" />Tracked account</SheetTitle><SheetDescription>Profile information and collected content for the selected tracking account.</SheetDescription></SheetHeader>
      {resource.state === "forbidden" ? <ForbiddenPanel /> : resource.state !== "ok" || !data ? <ResourceState resource={resource} label="tracked account" /> : <div className="space-y-4">
        <AccountHeader account={{ ...data.account, profilePicUrl: contentProfilePicture ?? data.account.profilePicUrl }} /><OwnersRow owners={data.owners} /><StatsStrip stats={data.stats} />
        <CachedContent accountId={accountId} onProfilePicture={setContentProfilePicture} />
        <Button variant="outline" asChild className="rounded-full"><a href={`https://instagram.com/${encodeURIComponent(data.account.igUsername)}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="mr-2 h-4 w-4" />Open on Instagram</a></Button>
      </div>}
    </SheetContent>
  </Sheet>;
}

export default function AdminTrackedAccountDetail(props: { accountId: string; onClose: () => void }) {
  // Remount every child (including open viewers and cursor state) on a target
  // switch; a late response from the old account cannot populate the new one.
  return <AccountDetail key={props.accountId} {...props} />;
}
