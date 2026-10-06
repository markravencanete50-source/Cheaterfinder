import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  Users,
  Search,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  UserX,
} from "lucide-react";
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
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import {
  adminFetch,
  formatDateShort,
  SUBSCRIPTION_STATUS_CONFIG,
  type AdminUser,
} from "./shared";
import { ForbiddenPanel } from "./ForbiddenPanel";

export default function AdminUsers({
  onSelectUser,
}: {
  onSelectUser: (userId: string) => void;
}) {
  const [, setLocation] = useLocation();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const perPage = 20;

  const fetchUsers = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("limit", String(perPage));

      const res = await adminFetch(`/api/admin/users?${params}`, { signal });
      if (res.status === 401) {
        setLocation("/auth");
        return;
      }
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch users");
      const json = await res.json();
      setUsers(json.items ?? []);
      setTotal(json.total ?? 0);
      setForbidden(false);
      setError("");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Failed to load users.");
    } finally {
      setLoading(false);
    }
  };

  // Refetch on page OR status-filter change. When the status filter changes off
  // page 1, the batched setPage(1) + filter update render once, so this runs
  // exactly once. On page 1, setPage(1) is a no-op but the statusFilter dep
  // still triggers the refetch — fixing the "filter does nothing on page 1"
  // bug. `search` is intentionally excluded: it is applied via the form submit
  // (handleSearch) so we don't fetch on every keystroke.
  useEffect(() => {
    const controller = new AbortController();
    fetchUsers(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter]);

  const handleStatusFilterChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (page !== 1) {
      // setPage(1) re-runs the fetch effect with the new search applied.
      // Fetching here too would use the stale page from this closure and
      // double-fetch, so let the effect do it.
      setPage(1);
      return;
    }
    // Already on page 1: the effect won't re-run (page unchanged and search is
    // not a dep), so fetch the updated search query directly.
    fetchUsers();
  };

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const startItem = (page - 1) * perPage + 1;
  const endItem = Math.min(page * perPage, total);

  if (forbidden) {
    return <ForbiddenPanel />;
  }

  if (error && users.length === 0) {
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
      {/* Header / Filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <form onSubmit={handleSearch} className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email..."
            className="pl-10 h-11 bg-slate-50 border-slate-200 rounded-xl focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </form>
        <Select value={statusFilter} onValueChange={handleStatusFilterChange}>
          <SelectTrigger className="w-[180px] rounded-xl h-11">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="trialing">Trialing</SelectItem>
            <SelectItem value="past_due">Past Due</SelectItem>
            <SelectItem value="canceled">Canceled</SelectItem>
            <SelectItem value="no_subscription">No Subscription</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card className="border border-slate-200 shadow-sm">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="p-10 text-center text-slate-400">
              <UserX className="w-10 h-10 mx-auto mb-3 text-slate-300" />
              <p>No users found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="font-semibold">Name</TableHead>
                    <TableHead className="font-semibold">Email</TableHead>
                    <TableHead className="font-semibold">Role</TableHead>
                    <TableHead className="font-semibold">Subscription</TableHead>
                    <TableHead className="font-semibold">Plan</TableHead>
                    <TableHead className="font-semibold text-center">Tracked</TableHead>
                    <TableHead className="font-semibold">Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => {
                    const subStatus = user.subscription?.status ?? "none";
                    const cfg = SUBSCRIPTION_STATUS_CONFIG[subStatus] ?? SUBSCRIPTION_STATUS_CONFIG.none;
                    return (
                      <TableRow
                        key={user.id}
                        className="hover:bg-slate-50/50 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                        onClick={() => onSelectUser(user.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelectUser(user.id);
                          }
                        }}
                        tabIndex={0}
                        aria-label={`Open details for ${user.name || user.email}`}
                      >
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-white text-xs font-bold">
                              {user.name?.charAt(0)?.toUpperCase() ?? "?"}
                            </div>
                            <span className="font-medium text-slate-800">
                              {user.name || "Unnamed"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-slate-600">{user.email}</TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center text-xs font-bold px-2.5 py-1 rounded-full ${
                              user.role === "admin"
                                ? "bg-violet-100 text-violet-700"
                                : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {user.role === "admin" ? "Admin" : "User"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center text-xs font-bold px-2.5 py-1 rounded-full ${cfg.className}`}
                          >
                            {cfg.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-slate-600 capitalize">
                          {user.subscription?.plan ?? "--"}
                        </TableCell>
                        <TableCell className="text-center">
                          <span className="font-semibold text-slate-700">
                            {user.trackedAccountCount}
                          </span>
                        </TableCell>
                        <TableCell className="text-slate-500 text-sm">
                          {formatDateShort(user.createdAt)}
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
      {!loading && users.length > 0 && (
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
