import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  User,
  Mail,
  Calendar,
  CreditCard,
  Instagram,
  Bell,
  Heart,
  UserPlus,
  UserMinus,
  Trash2,
  AlertTriangle,
  X,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  adminFetch,
  formatDateShort,
  formatRelative,
  SUBSCRIPTION_STATUS_CONFIG,
  ACCESS_STATUS_CONFIG,
  type AdminUserDetail as AdminUserDetailType,
} from "./shared";

export default function AdminUserDetail({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const [, setLocation] = useLocation();
  const [data, setData] = useState<AdminUserDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const fetchDetail = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await adminFetch(`/api/admin/users/${userId}`, { signal });
      if (res.status === 401) {
        setLocation("/auth");
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch user details");
      setData(await res.json());
      setError("");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Failed to load user details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchDetail(controller.signal);
    return () => controller.abort();
  }, [userId]);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await adminFetch(`/api/admin/users/${userId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDeleteOpen(false);
        onClose();
      } else {
        const body = await res.json().catch(() => ({}));
        setDeleteError(
          body.message || `Failed to delete user (${res.status}).`,
        );
      }
    } catch {
      setDeleteError("Network error. Please try again.");
    } finally {
      setDeleting(false);
    }
  };

  const subStatus = data?.subscription?.status ?? "none";
  const subCfg =
    SUBSCRIPTION_STATUS_CONFIG[subStatus] ?? SUBSCRIPTION_STATUS_CONFIG.none;

  return (
    <>
      <Sheet open={true} onOpenChange={(open) => !open && onClose()}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-2xl overflow-y-auto"
        >
          <SheetHeader className="mb-6">
            <SheetTitle className="flex items-center gap-2">
              <User className="w-5 h-5 text-primary" />
              User Details
            </SheetTitle>
            <SheetDescription>
              View and manage user information.
            </SheetDescription>
          </SheetHeader>

          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-24 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
              <Skeleton className="h-32 w-full rounded-xl" />
            </div>
          ) : error ? (
            <div className="p-10 text-center">
              <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-amber-400" />
              <p className="text-slate-500">{error}</p>
            </div>
          ) : data ? (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              {/* User Info */}
              <Card className="border border-slate-200 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-white font-bold text-lg shrink-0">
                      {data.user.name?.charAt(0)?.toUpperCase() ?? "?"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-lg font-bold text-slate-900">
                        {data.user.name || "Unnamed"}
                      </h3>
                      {data.user.role === "admin" && (
                        <span className="inline-flex items-center gap-1 mt-1 text-xs font-bold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">
                          <ShieldCheck className="w-3 h-3" />
                          Administrator
                        </span>
                      )}
                      <div className="flex items-center gap-2 text-sm text-slate-500 mt-1">
                        <Mail className="w-3.5 h-3.5" />
                        {data.user.email}
                      </div>
                      <div className="flex items-center gap-2 text-sm text-slate-400 mt-1">
                        <Calendar className="w-3.5 h-3.5" />
                        Joined {formatDateShort(data.user.createdAt)}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Subscription */}
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                    <CreditCard className="w-4 h-4 text-primary" />
                    Subscription
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-5 pt-0">
                  {data.subscription ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-500">Status</span>
                        <span
                          className={`text-xs font-bold px-2.5 py-1 rounded-full ${subCfg.className}`}
                        >
                          {subCfg.label}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-500">Plan</span>
                        <span className="text-sm font-medium text-slate-700 capitalize">
                          {data.subscription.plan ?? "--"}
                        </span>
                      </div>
                      {data.subscription.currentPeriodEnd && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-slate-500">
                            Period End
                          </span>
                          <span className="text-sm text-slate-700">
                            {formatDateShort(data.subscription.currentPeriodEnd)}
                          </span>
                        </div>
                      )}
                      {data.subscription.trialEndsAt && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-slate-500">
                            Trial Ends
                          </span>
                          <span className="text-sm text-slate-700">
                            {formatDateShort(data.subscription.trialEndsAt)}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">No subscription</p>
                  )}
                </CardContent>
              </Card>

              {/* Stats Summary */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-red-50 rounded-xl p-4 text-center border border-red-100">
                  <Heart className="w-5 h-5 text-red-500 mx-auto mb-1" />
                  <p className="text-xl font-bold text-slate-900">
                    {data.stats.totalLikes.toLocaleString()}
                  </p>
                  <p className="text-xs text-slate-500">Likes</p>
                </div>
                <div className="bg-emerald-50 rounded-xl p-4 text-center border border-emerald-100">
                  <UserPlus className="w-5 h-5 text-emerald-500 mx-auto mb-1" />
                  <p className="text-xl font-bold text-slate-900">
                    {data.stats.totalFollows.toLocaleString()}
                  </p>
                  <p className="text-xs text-slate-500">Follows</p>
                </div>
                <div className="bg-orange-50 rounded-xl p-4 text-center border border-orange-100">
                  <UserMinus className="w-5 h-5 text-orange-500 mx-auto mb-1" />
                  <p className="text-xl font-bold text-slate-900">
                    {data.stats.totalUnfollows.toLocaleString()}
                  </p>
                  <p className="text-xs text-slate-500">Unfollows</p>
                </div>
              </div>

              {/* Tracked Accounts */}
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                    <Instagram className="w-4 h-4 text-primary" />
                    Tracked Accounts ({data.trackedAccounts.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-5 pt-0">
                  {data.trackedAccounts.length === 0 ? (
                    <p className="text-sm text-slate-400">
                      No tracked accounts.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {data.trackedAccounts.map((acc) => {
                        const accessCfg =
                          ACCESS_STATUS_CONFIG[acc.accessStatus] ??
                          ACCESS_STATUS_CONFIG.public;
                        return (
                          <div
                            key={acc.id}
                            className="bg-slate-50 rounded-xl p-4 border border-slate-100"
                          >
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-primary to-fuchsia-500 p-[2px]">
                                  <div className="w-full h-full rounded-full bg-white flex items-center justify-center">
                                    <span className="text-xs font-bold text-slate-500">
                                      {acc.igUsername.charAt(0).toUpperCase()}
                                    </span>
                                  </div>
                                </div>
                                <div>
                                  <p className="font-semibold text-slate-800 text-sm">
                                    @{acc.igUsername}
                                  </p>
                                  {acc.displayName && (
                                    <p className="text-xs text-slate-400">
                                      {acc.displayName}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <span
                                className={`text-xs font-bold px-2 py-0.5 rounded-full ${accessCfg.className}`}
                              >
                                {accessCfg.label}
                              </span>
                            </div>
                            <div className="grid grid-cols-4 gap-2 text-center">
                              <div>
                                <p className="text-xs text-slate-400">
                                  Followers
                                </p>
                                <p className="font-semibold text-sm text-slate-700">
                                  {acc.followerCount.toLocaleString()}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-slate-400">Likes</p>
                                <p className="font-semibold text-sm text-red-600">
                                  {acc.likeCount.toLocaleString()}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-slate-400">
                                  Follows
                                </p>
                                <p className="font-semibold text-sm text-emerald-600">
                                  {acc.followCount.toLocaleString()}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-slate-400">
                                  Unfollows
                                </p>
                                <p className="font-semibold text-sm text-orange-600">
                                  {acc.unfollowCount.toLocaleString()}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Recent Notifications */}
              <Card className="border border-slate-200 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                    <Bell className="w-4 h-4 text-primary" />
                    Recent Notifications ({data.recentNotifications.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-5 pt-0">
                  {data.recentNotifications.length === 0 ? (
                    <p className="text-sm text-slate-400">No notifications.</p>
                  ) : (
                    <div className="space-y-2 max-h-[300px] overflow-y-auto">
                      {data.recentNotifications.map((notif) => (
                        <div
                          key={notif.id}
                          className={`p-3 rounded-lg border ${
                            notif.isRead
                              ? "bg-white border-slate-100"
                              : "bg-blue-50/50 border-blue-100"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 uppercase">
                              {notif.type}
                            </span>
                            <span className="text-xs text-slate-400">
                              {formatRelative(notif.createdAt)}
                            </span>
                          </div>
                          <p className="text-sm font-medium text-slate-800">
                            {notif.title}
                          </p>
                          <p className="text-xs text-slate-500 line-clamp-2">
                            {notif.body}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Danger Zone */}
              {data.user.role === "admin" ? (
                <div className="border border-violet-200 rounded-xl p-5 bg-violet-50/40">
                  <h4 className="text-violet-700 font-bold mb-2 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4" />
                    Protected administrator
                  </h4>
                  <p className="text-sm text-slate-600">
                    Admin accounts cannot be deleted from this panel. Demote the
                    role through an audited operator workflow first.
                  </p>
                </div>
              ) : (
                <div className="border border-red-200 rounded-xl p-5 bg-red-50/30">
                  <h4 className="text-red-600 font-bold mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Danger Zone
                  </h4>
                  <p className="text-sm text-slate-500 mb-4">
                    Permanently delete this user and all their data. This cannot be
                    undone.
                  </p>
                  <Button
                    variant="outline"
                    className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-300 rounded-xl"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete User
                  </Button>
                </div>
              )}
            </motion.div>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" />
              Delete User
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <strong>{data?.user.email}</strong>? This will permanently remove
              all their data including tracked accounts, notifications, and
              subscription.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              className="rounded-xl"
            >
              Cancel
            </Button>
            <Button
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-xl bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? (
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              Delete User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
