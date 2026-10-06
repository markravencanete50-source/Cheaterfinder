import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  Bot,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Activity,
  Send,
  Clock,
  RotateCcw,
  Power,
  PowerOff,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  adminFetch,
  formatDate,
  formatRelative,
  getBotStatusConfig,
  FR_STATUS_CONFIG,
  type BotAccount,
  type FollowRequest,
} from "./shared";
import { ForbiddenPanel } from "./ForbiddenPanel";
import { useToast } from "@/hooks/use-toast";

export default function AdminBots() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // Data
  const [bots, setBots] = useState<BotAccount[]>([]);
  const [followRequests, setFollowRequests] = useState<FollowRequest[]>([]);
  const [botsTotal, setBotsTotal] = useState(0);
  const [followRequestsTotal, setFollowRequestsTotal] = useState(0);
  const [botPage, setBotPage] = useState(1);
  const [frPage, setFrPage] = useState(1);
  const [botSearchInput, setBotSearchInput] = useState("");
  const [botSearchQuery, setBotSearchQuery] = useState("");
  const [botStatusFilter, setBotStatusFilter] = useState("all");
  const perPage = 20;

  // Loading
  const [botsLoading, setBotsLoading] = useState(true);
  const [frLoading, setFrLoading] = useState(true);

  // Errors / access
  const [botsError, setBotsError] = useState("");
  const [frError, setFrError] = useState("");
  const [forbidden, setForbidden] = useState(false);

  // Dialogs
  const [addBotOpen, setAddBotOpen] = useState(false);
  const [editBot, setEditBot] = useState<BotAccount | null>(null);
  const [deleteBot, setDeleteBot] = useState<BotAccount | null>(null);
  const [saving, setSaving] = useState(false);

  // Edit bot status (for shadcn Select)
  const [editBotStatus, setEditBotStatus] = useState("");

  // Filter
  const [frStatusFilter, setFrStatusFilter] = useState("all");

  // Action loading
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // ─── Fetchers ─────────────────────────────────────────────────────────
  const loadBots = useCallback(
    async (signal?: AbortSignal) => {
      setBotsLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(botPage),
          limit: String(perPage),
        });
        if (botSearchQuery) params.set("search", botSearchQuery);
        if (botStatusFilter !== "all") {
          params.set("status", botStatusFilter);
        }
        const res = await adminFetch(`/api/admin/bots?${params}`, { signal });
        if (res.status === 401) {
          setLocation("/auth");
          return;
        }
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) throw new Error("Failed to fetch bots");
        const json = await res.json();
        // Guard against a non-array payload: indexing `.map` on a non-array
        // (e.g. an error object) white-screens the page with no ErrorBoundary.
        const items = Array.isArray(json)
          ? json
          : Array.isArray(json?.items)
            ? json.items
            : [];
        setBots(items);
        setBotsTotal(
          typeof json?.total === "number" ? json.total : items.length,
        );
        setForbidden(false);
        setBotsError("");
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setBotsError("Failed to load bot accounts.");
      } finally {
        setBotsLoading(false);
      }
    },
    [botPage, botSearchQuery, botStatusFilter, setLocation]
  );

  const loadFollowRequests = useCallback(
    async (signal?: AbortSignal) => {
      setFrLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(frPage),
          limit: String(perPage),
        });
        if (frStatusFilter !== "all") {
          params.set("status", frStatusFilter);
        }
        const res = await adminFetch(`/api/admin/follow-requests?${params}`, {
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
        if (!res.ok) throw new Error("Failed to fetch follow requests");
        const json = await res.json();
        const items = Array.isArray(json)
          ? json
          : Array.isArray(json?.items)
            ? json.items
            : [];
        setFollowRequests(items);
        setFollowRequestsTotal(
          typeof json?.total === "number" ? json.total : items.length,
        );
        setForbidden(false);
        setFrError("");
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setFrError("Failed to load follow requests.");
      } finally {
        setFrLoading(false);
      }
    },
    [frPage, frStatusFilter, setLocation]
  );

  useEffect(() => {
    const controller = new AbortController();
    loadBots(controller.signal);
    loadFollowRequests(controller.signal);
    return () => controller.abort();
  }, [loadBots, loadFollowRequests]);

  // ─── Bot CRUD ─────────────────────────────────────────────────────────
  const handleAddBot = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    const body = {
      igUsername: form.get("igUsername") as string,
      sessionData: form.get("sessionData") as string,
      igUserId: (form.get("igUserId") as string) || undefined,
      displayName: (form.get("displayName") as string) || undefined,
      proxyUrl: (form.get("proxyUrl") as string) || undefined,
      maxFollows: parseInt(form.get("maxFollows") as string, 10) || 5,
    };
    try {
      const res = await adminFetch("/api/admin/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        // Keep the dialog open so the entered values aren't lost.
        toast({
          variant: "destructive",
          title: "Failed to add bot",
          description: errData.message || `Request failed (${res.status}).`,
        });
        return;
      }
      setAddBotOpen(false);
      if (botPage === 1) {
        loadBots();
      } else {
        setBotPage(1);
      }
      toast({
        title: "Bot added",
        description: `@${body.igUsername} was added to the pool.`,
      });
    } catch (err) {
      // Network failure or aborted request: surface it instead of leaving a
      // silent unhandled rejection, and keep the dialog open.
      toast({
        variant: "destructive",
        title: "Failed to add bot",
        description:
          err instanceof Error ? err.message : "Network error. Please retry.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleEditBot = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editBot) return;
    setSaving(true);
    const form = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {};
    const sessionData = form.get("sessionData") as string;
    if (sessionData) body.sessionData = sessionData;
    const proxyUrl = form.get("proxyUrl") as string;
    body.proxyUrl = proxyUrl || null;
    const displayName = form.get("displayName") as string;
    body.displayName = displayName || null;
    if (editBotStatus) body.status = editBotStatus;
    const maxFollows = form.get("maxFollows") as string;
    if (maxFollows) body.maxFollows = parseInt(maxFollows, 10);
    const igUsername = editBot.igUsername;
    try {
      // Expired sessions use the dedicated, rate-limited re-auth endpoint. A
      // normal PUT can store session data, but it does not perform the
      // deliberate reactivation/cooldown reset that operators expect.
      if (editBot.status === "session_expired" && sessionData) {
        const reauthRes = await adminFetch(
          `/api/admin/bots/${editBot.id}/session`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionData }),
          },
        );
        if (!reauthRes.ok) {
          const errData = await reauthRes.json().catch(() => ({}));
          toast({
            variant: "destructive",
            title: "Failed to re-authenticate bot",
            description:
              errData.message || `Request failed (${reauthRes.status}).`,
          });
          return;
        }
        delete body.sessionData;
        if (body.status === "session_expired") {
          body.status = "available";
        }
      }

      const res = await adminFetch(`/api/admin/bots/${editBot.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        // Keep the dialog open so edits aren't lost.
        toast({
          variant: "destructive",
          title: "Failed to update bot",
          description: errData.message || `Request failed (${res.status}).`,
        });
        return;
      }
      setEditBot(null);
      loadBots();
      toast({
        title: "Bot updated",
        description: `@${igUsername} was updated.`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to update bot",
        description:
          err instanceof Error ? err.message : "Network error. Please retry.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteBot = async () => {
    if (!deleteBot) return;
    setSaving(true);
    const igUsername = deleteBot.igUsername;
    try {
      const res = await adminFetch(`/api/admin/bots/${deleteBot.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        // Keep the confirmation dialog open so the user can retry.
        toast({
          variant: "destructive",
          title: "Failed to delete bot",
          description: errData.message || `Request failed (${res.status}).`,
        });
        return;
      }
      setDeleteBot(null);
      if (bots.length === 1 && botPage > 1) {
        setBotPage((page) => page - 1);
      } else {
        loadBots();
      }
      toast({
        title: "Bot deleted",
        description: `@${igUsername} was removed from the pool.`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to delete bot",
        description:
          err instanceof Error ? err.message : "Network error. Please retry.",
      });
    } finally {
      setSaving(false);
    }
  };

  // ─── Bot Actions ──────────────────────────────────────────────────────
  const handleBotAction = async (
    botId: string,
    action: "reset-cooldown" | "disable" | "enable"
  ) => {
    setActionLoading(botId);
    try {
      const res = await adminFetch(`/api/admin/bots/${botId}/${action}`, {
        method: "POST",
      });
      if (res.ok) {
        loadBots();
      } else {
        const errData = await res.json().catch(() => ({}));
        toast({
          variant: "destructive",
          title: "Bot action failed",
          description: errData.message || `Request failed (${res.status}).`,
        });
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Bot action failed",
        description:
          err instanceof Error ? err.message : "Network error. Please retry.",
      });
    } finally {
      setActionLoading(null);
    }
  };

  const botTotalPages = Math.max(1, Math.ceil(botsTotal / perPage));
  const followRequestTotalPages = Math.max(
    1,
    Math.ceil(followRequestsTotal / perPage),
  );
  const botStartItem = (botPage - 1) * perPage + 1;
  const botEndItem = Math.min(botPage * perPage, botsTotal);
  const frStartItem = (frPage - 1) * perPage + 1;
  const frEndItem = Math.min(frPage * perPage, followRequestsTotal);

  const handleFollowRequestFilter = (value: string) => {
    setFrStatusFilter(value);
    setFrPage(1);
  };

  const handleBotSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const query = botSearchInput.trim();
    if (query === botSearchQuery && botPage === 1) {
      loadBots();
      return;
    }
    setBotSearchQuery(query);
    setBotPage(1);
  };

  const handleBotStatusFilter = (value: string) => {
    setBotStatusFilter(value);
    setBotPage(1);
  };

  // A 403 on either feed means no access to the whole Bots section.
  if (forbidden && bots.length === 0 && followRequests.length === 0) {
    return <ForbiddenPanel />;
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.1 }}
    >
      <Tabs defaultValue="bot-pool" className="space-y-4">
        <TabsList className="bg-white border border-slate-200 shadow-sm h-auto p-1 rounded-xl grid grid-cols-2 w-full sm:inline-flex sm:w-auto">
          <TabsTrigger
            value="bot-pool"
            className="rounded-lg px-2 sm:px-4 data-[state=active]:bg-primary data-[state=active]:text-white text-xs sm:text-sm"
          >
            <Bot className="w-4 h-4 mr-2" />
            Bot Pool ({botsTotal})
          </TabsTrigger>
          <TabsTrigger
            value="follow-requests"
            className="rounded-lg px-2 sm:px-4 data-[state=active]:bg-primary data-[state=active]:text-white text-xs sm:text-sm"
          >
            <Send className="w-4 h-4 mr-2" />
            Follow Requests ({followRequestsTotal})
          </TabsTrigger>
        </TabsList>

        {/* ═══ Bot Pool ═══ */}
        <TabsContent value="bot-pool">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-900">
              Bot Accounts
            </h2>
            <Button
              onClick={() => setAddBotOpen(true)}
              className="bg-primary hover:bg-primary/90 text-white rounded-xl shadow-sm"
            >
              <Plus className="w-4 h-4 mr-2" /> Add Bot
            </Button>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <form
              onSubmit={handleBotSearch}
              className="relative flex-1 w-full"
            >
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                value={botSearchInput}
                onChange={(event) => setBotSearchInput(event.target.value)}
                placeholder="Search bot username or display name..."
                className="pl-10 h-10 rounded-xl"
              />
            </form>
            <Select
              value={botStatusFilter}
              onValueChange={handleBotStatusFilter}
            >
              <SelectTrigger className="w-full sm:w-[180px] rounded-xl h-10">
                <SelectValue placeholder="Bot status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="available">Available</SelectItem>
                <SelectItem value="in_use">In Use</SelectItem>
                <SelectItem value="cooldown">Cooldown</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
                <SelectItem value="banned">Banned</SelectItem>
                <SelectItem value="session_expired">
                  Session Expired
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Card className="border border-slate-200 shadow-sm">
            <CardContent className="p-0">
              {botsLoading ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : botsError && bots.length === 0 ? (
                <div className="p-10 text-center">
                  <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-amber-400" />
                  <p className="text-slate-500">{botsError}</p>
                </div>
              ) : bots.length === 0 ? (
                <div className="p-10 text-center text-slate-400">
                  <Bot className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                  <p>No bot accounts yet. Add one to get started.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        <TableHead className="font-semibold">
                          Username
                        </TableHead>
                        <TableHead className="font-semibold">Status</TableHead>
                        <TableHead className="font-semibold">
                          Follows
                        </TableHead>
                        <TableHead className="font-semibold">Proxy</TableHead>
                        <TableHead className="font-semibold">
                          Last Used
                        </TableHead>
                        <TableHead className="font-semibold text-right">
                          Actions
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bots.map((bot) => {
                        const cfg = getBotStatusConfig(bot.status);
                        const StatusIcon = cfg.icon;
                        const isActionLoading = actionLoading === bot.id;
                        return (
                          <TableRow
                            key={bot.id}
                            className="hover:bg-slate-50/50"
                          >
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                                  <Bot className="w-4 h-4 text-slate-500" />
                                </div>
                                <div>
                                  <p className="font-medium text-slate-800">
                                    @{bot.igUsername}
                                  </p>
                                  {bot.displayName && (
                                    <p className="text-xs text-slate-400">
                                      {bot.displayName}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <span
                                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold border ${cfg.className}`}
                              >
                                <StatusIcon className="w-3 h-3" />
                                {cfg.label}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="text-slate-700 font-medium">
                                {bot.currentFollows}
                              </span>
                              <span className="text-slate-400">
                                {" "}
                                / {bot.maxFollows}
                              </span>
                            </TableCell>
                            <TableCell>
                              {bot.proxyUrl ? (
                                <span className="text-xs text-slate-500 font-mono bg-slate-50 px-2 py-1 rounded">
                                  {bot.proxyUrl.length > 30
                                    ? bot.proxyUrl.slice(0, 30) + "..."
                                    : bot.proxyUrl}
                                </span>
                              ) : (
                                <span className="text-slate-300 text-sm">
                                  None
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-slate-500 text-sm">
                              {formatRelative(bot.lastUsedAt)}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                {/* Reset Cooldown */}
                                {bot.status === "cooldown" && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={isActionLoading}
                                    onClick={() =>
                                      handleBotAction(bot.id, "reset-cooldown")
                                    }
                                    className="h-8 px-2 text-amber-500 hover:text-amber-700 hover:bg-amber-50"
                                    title="Reset Cooldown"
                                  >
                                    <RotateCcw className="w-4 h-4" />
                                  </Button>
                                )}
                                {/* Disable */}
                                {(bot.status === "available" ||
                                  bot.status === "in_use") && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={isActionLoading}
                                    onClick={() =>
                                      handleBotAction(bot.id, "disable")
                                    }
                                    className="h-8 px-2 text-slate-400 hover:text-red-500 hover:bg-red-50"
                                    title="Disable Bot"
                                  >
                                    <PowerOff className="w-4 h-4" />
                                  </Button>
                                )}
                                {/* Enable */}
                                {bot.status === "disabled" && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={isActionLoading}
                                    onClick={() =>
                                      handleBotAction(bot.id, "enable")
                                    }
                                    className="h-8 px-2 text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50"
                                    title="Enable Bot"
                                  >
                                    <Power className="w-4 h-4" />
                                  </Button>
                                )}
                                {/* Edit */}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setEditBot(bot);
                                    setEditBotStatus(bot.status);
                                  }}
                                  className="h-8 w-8 p-0 text-slate-400 hover:text-primary"
                                  aria-label={`Edit @${bot.igUsername}`}
                                  title={`Edit @${bot.igUsername}`}
                                >
                                  <Pencil className="w-4 h-4" />
                                </Button>
                                {/* Delete */}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDeleteBot(bot)}
                                  className="h-8 w-8 p-0 text-slate-400 hover:text-red-500"
                                  aria-label={`Delete @${bot.igUsername}`}
                                  title={`Delete @${bot.igUsername}`}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
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
          {!botsLoading && bots.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-4">
              <p className="text-sm text-slate-500">
                Showing {botStartItem}–{botEndItem} of {botsTotal}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={botPage <= 1}
                  onClick={() => setBotPage((page) => page - 1)}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm text-slate-500">
                  Page {botPage} of {botTotalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={botPage >= botTotalPages}
                  onClick={() => setBotPage((page) => page + 1)}
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ═══ Follow Requests ═══ */}
        <TabsContent value="follow-requests">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-slate-900">
              Follow Requests ({followRequestsTotal})
            </h2>
            <Select
              value={frStatusFilter}
              onValueChange={handleFollowRequestFilter}
            >
              <SelectTrigger className="w-[160px] rounded-xl">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="accepted">Accepted</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Card className="border border-slate-200 shadow-sm">
            <CardContent className="p-0">
              {frLoading ? (
                <div className="p-6 space-y-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : frError && followRequests.length === 0 ? (
                <div className="p-10 text-center">
                  <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-amber-400" />
                  <p className="text-slate-500">{frError}</p>
                </div>
              ) : followRequests.length === 0 ? (
                <div className="p-10 text-center text-slate-400">
                  <Send className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                  <p>No follow requests found.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50">
                        <TableHead className="font-semibold">Bot</TableHead>
                        <TableHead className="font-semibold">
                          Target Account
                        </TableHead>
                        <TableHead className="font-semibold">Status</TableHead>
                        <TableHead className="font-semibold">
                          Queued At
                        </TableHead>
                        <TableHead className="font-semibold">
                          Sent At
                        </TableHead>
                        <TableHead className="font-semibold">
                          Resolved At
                        </TableHead>
                        <TableHead className="font-semibold">Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {followRequests.map((fr) => {
                        const cfg = FR_STATUS_CONFIG[fr.status];
                        return (
                          <TableRow
                            key={fr.id}
                            className="hover:bg-slate-50/50"
                          >
                            <TableCell className="font-medium text-slate-800">
                              @{fr.botUsername ?? "unknown"}
                            </TableCell>
                            <TableCell className="text-slate-600">
                              @{fr.targetUsername ?? "unknown"}
                            </TableCell>
                            <TableCell>
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold border ${cfg.className}`}
                              >
                                {cfg.label}
                              </span>
                            </TableCell>
                            <TableCell className="text-slate-500 text-sm">
                              {formatDate(fr.queuedAt)}
                            </TableCell>
                            <TableCell className="text-slate-500 text-sm">
                              {formatDate(fr.sentAt)}
                            </TableCell>
                            <TableCell className="text-slate-500 text-sm">
                              {formatDate(fr.resolvedAt)}
                            </TableCell>
                            <TableCell>
                              {fr.error ? (
                                <span className="text-xs text-red-500 font-mono bg-red-50 px-2 py-1 rounded max-w-[200px] truncate block">
                                  {fr.error}
                                </span>
                              ) : (
                                <span className="text-slate-300">--</span>
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
          {!frLoading && followRequests.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-4">
              <p className="text-sm text-slate-500">
                Showing {frStartItem}–{frEndItem} of {followRequestsTotal}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={frPage <= 1}
                  onClick={() => setFrPage((page) => page - 1)}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm text-slate-500">
                  Page {frPage} of {followRequestTotalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={frPage >= followRequestTotalPages}
                  onClick={() => setFrPage((page) => page + 1)}
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ═══ Dialogs ═══ */}

      {/* Add Bot */}
      <Dialog open={addBotOpen} onOpenChange={setAddBotOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" />
              Add Bot Account
            </DialogTitle>
            <DialogDescription>
              Add a new Instagram bot account for follow request management.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddBot} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-igUsername">IG Username *</Label>
              <Input
                id="add-igUsername"
                name="igUsername"
                placeholder="bot_account_1"
                maxLength={30}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-sessionData">Session Data *</Label>
              <Textarea
                id="add-sessionData"
                name="sessionData"
                placeholder="Paste session cookie / token JSON here..."
                rows={3}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="add-igUserId">IG User ID</Label>
                <Input
                  id="add-igUserId"
                  name="igUserId"
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-displayName">Display Name</Label>
                <Input
                  id="add-displayName"
                  name="displayName"
                  placeholder="Optional"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="add-proxyUrl">Proxy URL</Label>
                <Input
                  id="add-proxyUrl"
                  name="proxyUrl"
                  placeholder="socks5://..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-maxFollows">Max Follows</Label>
                <Input
                  id="add-maxFollows"
                  name="maxFollows"
                  type="number"
                  defaultValue={5}
                  min={1}
                  max={100}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddBotOpen(false)}
                className="rounded-xl"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-primary text-white"
              >
                {saving ? (
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4 mr-2" />
                )}
                Add Bot
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Bot */}
      <Dialog
        open={!!editBot}
        onOpenChange={(open) => !open && setEditBot(null)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-primary" />
              Edit Bot: @{editBot?.igUsername}
            </DialogTitle>
            <DialogDescription>
              {editBot?.status === "session_expired"
                ? "Paste a fresh session to re-authenticate and return this bot to the available pool."
                : "Update bot account settings. Leave session data empty to keep the current one."}
            </DialogDescription>
          </DialogHeader>
          {editBot && (
            <form onSubmit={handleEditBot} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-displayName">Display Name</Label>
                <Input
                  id="edit-displayName"
                  name="displayName"
                  defaultValue={editBot.displayName ?? ""}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-sessionData">
                  Session Data (leave empty to keep current)
                </Label>
                <Textarea
                  id="edit-sessionData"
                  name="sessionData"
                  placeholder="Paste new session data or leave empty..."
                  rows={3}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-status">Status</Label>
                  <Select value={editBotStatus} onValueChange={setEditBotStatus}>
                    <SelectTrigger id="edit-status" className="w-full">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="available">Available</SelectItem>
                      <SelectItem value="in_use">In Use</SelectItem>
                      <SelectItem value="cooldown">Cooldown</SelectItem>
                      <SelectItem value="disabled">Disabled</SelectItem>
                      <SelectItem value="banned">Banned</SelectItem>
                      <SelectItem value="session_expired" disabled>
                        Session Expired
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-maxFollows">Max Follows</Label>
                  <Input
                    id="edit-maxFollows"
                    name="maxFollows"
                    type="number"
                    defaultValue={editBot.maxFollows}
                    min={1}
                    max={100}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-proxyUrl">Proxy URL</Label>
                <Input
                  id="edit-proxyUrl"
                  name="proxyUrl"
                  defaultValue={editBot.proxyUrl ?? ""}
                  placeholder="socks5://..."
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditBot(null)}
                  className="rounded-xl"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-primary text-white"
                >
                  {saving ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                  )}
                  Save Changes
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Bot Confirmation */}
      <Dialog
        open={!!deleteBot}
        onOpenChange={(open) => !open && setDeleteBot(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" />
              Delete Bot Account
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <strong>@{deleteBot?.igUsername}</strong>? This action cannot be
              undone. All follow requests associated with this bot will also be
              deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteBot(null)}
              className="rounded-xl"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDeleteBot}
              disabled={saving}
              className="rounded-xl bg-red-600 hover:bg-red-700 text-white"
            >
              {saving ? (
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              Delete Bot
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
