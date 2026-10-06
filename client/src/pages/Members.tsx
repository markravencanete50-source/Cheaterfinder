import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, Plus, Search, LogOut, Settings, BarChart2, Bell, X, Lock, Sparkles, AlertCircle, Loader2, FileBarChart, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { csrfHeaders } from "@/lib/csrf";
import { logoutAndClearCache } from "@/lib/logout";
import { proxyUrl } from "@/lib/img-proxy";
import { productAnalytics } from "@/lib/analytics";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { MobileNav } from "@/components/MobileNav";

interface TrackedAccount {
  id: string;
  igUsername: string;
  displayName: string | null;
  isActive: boolean;
  isPrivate: boolean;
  accessStatus: "public" | "pending_access" | "has_access" | "access_denied";
  trackingStarted: string;
  profilePicUrl?: string | null;
  igUserId?: string | null;
  followerCount?: number | null;
  _profileSync?: {
    status: "pending" | "ready";
    reason: string;
    initialDelayMs: number;
  };
  profileSnapshots?: unknown[];
  reports?: unknown[];
}

function MemberAvatar({ account }: { account: TrackedAccount }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [account.profilePicUrl]);

  if (!account.profilePicUrl || failed) {
    return (
      <span className="text-lg font-bold text-slate-400">
        {account.igUsername.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={proxyUrl(account.profilePicUrl)}
      alt={`@${account.igUsername}`}
      className="h-full w-full object-cover"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export default function Members() {
  const [, setLocation] = useLocation();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<TrackedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [roleChecked, setRoleChecked] = useState(false);
  const [redirectingToAdmin, setRedirectingToAdmin] = useState(false);
  const [error, setError] = useState("");
  const initialTarget = new URLSearchParams(window.location.search).get("username") ?? "";
  const validTarget = /^@?[a-zA-Z0-9._]{1,30}$/.test(initialTarget) ? initialTarget : "";
  const [showAddModal, setShowAddModal] = useState(!!validTarget);
  const [newUsername, setNewUsername] = useState(validTarget);
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState("");
  const [addLimitReached, setAddLimitReached] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingRemove, setPendingRemove] = useState<TrackedAccount | null>(null);
  const [removing, setRemoving] = useState(false);
  const accountReadSequence = useRef(0);

  const fetchAccounts = async (signal?: AbortSignal, background = false) => {
    const sequence = ++accountReadSequence.current;
    try {
      if (!background) setLoading(true);
      const res = await fetch("/api/tracking/accounts", { credentials: "include", signal });
      if (signal?.aborted || sequence !== accountReadSequence.current) return;
      if (res.status === 401) {
        setLocation("/auth");
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch accounts");
      const data = await res.json();
      if (signal?.aborted || sequence !== accountReadSequence.current) return;
      setAccounts(data);
      setError("");
      setAuthChecked(true);
    } catch (err) {
      if (signal?.aborted || sequence !== accountReadSequence.current || (err instanceof Error && err.name === "AbortError")) return;
      if (!background) setError("Failed to load accounts.");
      setAuthChecked(true);
    } finally {
      if (!signal?.aborted && sequence === accountReadSequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchAccounts(controller.signal);
    // Approval can arrive while the member list stays open. Refresh its stored
    // state quietly; this endpoint does not trigger an Instagram operation.
    const timer = setInterval(() => {
      if (!document.hidden) void fetchAccounts(controller.signal, true);
    }, 30_000);
    return () => { controller.abort(); clearInterval(timer); accountReadSequence.current++; };
  }, []);

  // Admins belong in the operations console, not the member dashboard. The
  // render is gated on this probe so an admin never sees a flash of the
  // members UI before the redirect lands.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/auth/me", {
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest" },
          signal: controller.signal,
        });
        if (res.ok) {
          const user = (await res.json().catch(() => null)) as
            | { role?: unknown; id?: unknown }
            | null;
          productAnalytics.setUser(user);
          if (user && user.role === "admin") {
            setRedirectingToAdmin(true);
            setLocation("/admin");
            return;
          }
        }
        // A 401 here is handled by the accounts fetch, which redirects to /auth.
        setRoleChecked(true);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setRoleChecked(true);
      }
    })();
    return () => controller.abort();
  }, [setLocation]);

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim()) return;
    setAddLoading(true);
    setAddError("");
    setAddLimitReached(false);
    try {
      const res = await fetch("/api/tracking/accounts", {
        method: "POST",
        credentials: "include",
        headers: csrfHeaders({ "Content-Type": "application/json" }, "POST"),
        body: JSON.stringify({ igUsername: newUsername.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 402) {
          const limitMsg = t("members.planLimitReached", {
            defaultValue: "You've reached your tracking plan's account limit.",
          });
          setAddLimitReached(true);
          setAddError(data.message || limitMsg);
          toast({
            variant: "destructive",
            title: t("members.upgradeNeeded", { defaultValue: "Plan limit reached" }),
            description: data.message || limitMsg,
            action: (
              <ToastAction
                altText={t("members.upgradePlan", { defaultValue: "Upgrade plan" })}
                onClick={() => setLocation("/payment")}
              >
                {t("members.upgradePlan", { defaultValue: "Upgrade" })}
              </ToastAction>
            ),
          });
          return;
        }
        setAddError(data.message || t("members.addFailed", { defaultValue: "Failed to add account." }));
        return;
      }
      const created = (await res.json()) as TrackedAccount;
      try { sessionStorage.removeItem("checkout-target"); } catch {}
      void productAnalytics.track("tracking_account_added");
      setAccounts((prev) => [created, ...prev.filter((a) => a.id !== created.id)]);
      setNewUsername("");
      setShowAddModal(false);
      toast({
        title: t("members.syncQueued", { defaultValue: "Tracking queued" }),
        description: t("members.syncQueuedDesc", {
          defaultValue: "The dashboard will update automatically as soon as the first sync finishes.",
        }),
      });
      try {
        sessionStorage.setItem(`new-account-notice:${created.id}`, "1");
      } catch {
        // Ignore storage failures; the dashboard still shows its sync-pending state.
      }
      await fetchAccounts();
      setLocation(`/dashboard/${created.id}`);
    } catch {
      setAddError(t("members.networkErrorRetry", { defaultValue: "Network error. Please try again." }));
    } finally {
      setAddLoading(false);
    }
  };

  const confirmRemove = async () => {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/tracking/accounts/${pendingRemove.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: csrfHeaders(undefined, "DELETE"),
      });
      if (!res.ok) throw new Error("Delete failed");
      setPendingRemove(null);
      await fetchAccounts();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      toast({
        variant: "destructive",
        title: t("members.removeFailed", { defaultValue: "Couldn't remove account" }),
        description: t("members.removeFailedDesc", { defaultValue: "Please try again." }),
      });
    } finally {
      setRemoving(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await logoutAndClearCache();
    } catch {
      // The session cookie is already unusable client-side and the server
      // session expires on its own; still return the visitor to the site.
    } finally {
      setLocation("/");
    }
  };

  const filteredAccounts = accounts.filter((a) =>
    a.igUsername.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (a.displayName || "").toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (redirectingToAdmin || !roleChecked || (!authChecked && loading)) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-slate-400">{t("members.loading")}</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      <title>Tracked Accounts — CheaterFinder</title>
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-white border-r border-slate-200 flex flex-col hidden md:flex min-h-screen">
        <div className="p-6 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <span className="font-display font-bold text-xl tracking-tight"><span className="text-foreground">Cheater</span><span className="text-primary">Finder</span></span>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <div className="flex items-center gap-3 px-4 py-3 bg-primary/10 text-primary rounded-xl font-semibold">
            <BarChart2 className="w-5 h-5" /> {t("members.trackedAccounts")}
          </div>
          <a onClick={() => setLocation('/reports')} className="flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-50 rounded-xl font-medium transition-colors cursor-pointer">
            <FileBarChart className="w-5 h-5" /> {t("members.reports", "Reports")}
          </a>
          <a onClick={() => setLocation('/notifications')} className="flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-50 rounded-xl font-medium transition-colors cursor-pointer">
            <Bell className="w-5 h-5" /> {t("members.notifications")}
          </a>
          <a onClick={() => setLocation('/settings')} className="flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-50 rounded-xl font-medium transition-colors cursor-pointer">
            <Settings className="w-5 h-5" /> {t("members.settings")}
          </a>
        </nav>

        <div className="p-4 border-t border-slate-100">
          <div className="bg-slate-50 p-4 rounded-xl mb-4 border border-slate-200">
            <p className="text-xs text-slate-500 font-medium mb-1">{t("members.accountsTracked")}</p>
            <p className="text-sm font-bold text-slate-900 mb-2">{accounts.length} account{accounts.length !== 1 ? "s" : ""}</p>
          </div>

          <button onClick={handleSignOut} className="flex items-center gap-3 px-4 py-3 w-full text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-xl font-medium transition-colors">
            <LogOut className="w-5 h-5" /> {t("members.signOut")}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-6 md:p-10 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[100px] pointer-events-none" />

        <div className="max-w-5xl mx-auto relative z-10">
          {/* Mobile Header */}
          <div className="md:hidden flex items-center justify-between mb-8 pb-4 border-b border-slate-200">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-6 w-6 text-primary" />
              <span className="font-display font-bold text-xl tracking-tight"><span className="text-foreground">Cheater</span><span className="text-primary">Finder</span></span>
            </div>
            <div className="flex items-center gap-4">
              <MobileNav />
              <button onClick={handleSignOut} className="text-slate-500"><LogOut className="w-5 h-5" /></button>
            </div>
          </div>

          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-10">
            <div>
              <h1 className="text-3xl font-bold text-slate-900 mb-2">{t("members.title")}</h1>
              <p className="text-slate-600">{t("members.subtitle")}</p>
            </div>
            <Button
              onClick={() => { setShowAddModal(true); setAddError(""); setNewUsername(""); }}
              className="bg-primary hover:bg-primary/90 text-white rounded-xl px-6 h-12 shadow-md"
            >
              <Plus className="w-5 h-5 mr-2" /> {t("members.addNew")}
            </Button>
          </div>

          <div className="relative mb-8">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("members.search")}
              className="w-full h-14 bg-white border border-slate-200 rounded-xl pl-12 pr-4 text-slate-900 shadow-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
            />
          </div>

          {loading && (
            <div className="text-center py-16 text-slate-500">{t("members.loadingAccounts")}</div>
          )}

          {!loading && error && (
            <div className="text-center py-16 text-red-500">{error}</div>
          )}

          {!loading && !error && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredAccounts.map((account) => {
                // With instant onboarding the basics (igUserId + pic) land in
                // the add response, so only show "pending" when the instant
                // fetch genuinely failed and we have no header data yet.
                const syncPending = account.isActive && (!account.isPrivate || account.accessStatus === "has_access") && (
                  account._profileSync?.status === "pending" ||
                  (!account.igUserId && !account.profilePicUrl));
                return (
                <div
                  key={account.id}
                  onClick={() => setLocation(`/dashboard/${account.id}`)}
                  className="bg-white rounded-3xl p-6 border border-slate-200 shadow-[0_8px_30px_rgb(0,0,0,0.04)] hover:shadow-[0_20px_40px_rgb(0,0,0,0.08)] transform hover:-translate-y-1 transition-all duration-300 cursor-pointer group relative"
                >
                  <button
                    aria-label={t("members.removeAccount", { defaultValue: "Remove @{{username}}", username: account.igUsername })}
                    onClick={(e) => { e.stopPropagation(); setPendingRemove(account); }}
                    className="absolute top-4 right-4 w-7 h-7 rounded-full bg-slate-100 hover:bg-red-100 hover:text-red-600 flex items-center justify-center text-slate-400 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>

                  <div className="flex justify-between items-start mb-6">
                    <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-primary to-fuchsia-500 p-[2px]">
                      <div className="w-full h-full rounded-full border-2 border-white bg-slate-100 flex items-center justify-center overflow-hidden">
                        <MemberAvatar account={account} />
                      </div>
                    </div>
                    {!account.isActive ? (
                      <div className="bg-slate-100 text-slate-600 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                        {t("members.inactive")}
                      </div>
                    ) : syncPending ? (
                      <div className="bg-amber-100 text-amber-700 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {t("members.syncPending", { defaultValue: "Sync pending" })}
                      </div>
                    ) : account.isPrivate && account.accessStatus === "pending_access" ? (
                      <div className="bg-amber-100 text-amber-700 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider flex items-center gap-1.5">
                        <Lock className="w-3 h-3" />
                        {t("privateAccount.pendingAccess", "Pending Access")}
                      </div>
                    ) : account.isPrivate && account.accessStatus === "has_access" ? (
                      <div className="bg-emerald-100 text-emerald-700 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider flex items-center gap-1.5">
                        <Lock className="w-3 h-3" />
                        {t("privateAccount.privateActive", "Private - Active")}
                      </div>
                    ) : account.isPrivate && account.accessStatus === "access_denied" ? (
                      <div className="bg-red-100 text-red-700 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider flex items-center gap-1.5">
                        <Lock className="w-3 h-3" />
                        {t("privateAccount.accessDenied", "Access Denied")}
                      </div>
                    ) : (
                      <div className={`${account.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'} text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider flex items-center gap-1.5`}>
                        {account.isActive && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>}
                        {account.isActive ? t("members.active") : t("members.inactive")}
                      </div>
                    )}
                  </div>

                  <div className="mb-6">
                    <h3 className="text-xl font-bold text-slate-900 group-hover:text-primary transition-colors">@{account.igUsername}</h3>
                    {account.displayName && <p className="text-slate-500 text-sm">{account.displayName}</p>}
                  </div>

                  <div className="border-t border-slate-100 pt-4 flex justify-between items-center text-sm">
                    {syncPending ? (
                      <>
                        <span className="text-slate-500">{t("members.syncStatus", { defaultValue: "Status" })}</span>
                        <span className="font-semibold text-amber-700">{t("members.queued", { defaultValue: "Queued" })}</span>
                      </>
                    ) : (
                      <>
                        <span className="text-slate-500">{t("members.trackingStarted")}</span>
                        <span className="font-semibold text-slate-700">{new Date(account.trackingStarted).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                </div>
                );
              })}

              {/* Empty Slot for adding an account */}
              <div
                onClick={() => { setShowAddModal(true); setAddError(""); setNewUsername(""); }}
                className="bg-slate-50 rounded-3xl p-6 border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-center h-full min-h-[300px] hover:border-primary/50 hover:bg-primary/5 transition-colors cursor-pointer group"
              >
                <div className="w-16 h-16 rounded-full bg-white flex items-center justify-center mb-4 shadow-sm group-hover:scale-110 transition-transform">
                  <Plus className="w-8 h-8 text-slate-400 group-hover:text-primary transition-colors" />
                </div>
                <h3 className="font-bold text-slate-700 mb-1">{t("members.addTarget")}</h3>
                <p className="text-sm text-slate-500">{t("members.trackNew")}</p>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-900">{t("members.addTarget")}</h2>
              <button
                onClick={() => setShowAddModal(false)}
                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleAddAccount} className="space-y-4">
              <div>
                <label className="text-sm font-semibold text-slate-700 block mb-2">{t("members.igUsername")}</label>
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder={t("members.usernamePlaceholder")}
                  className="w-full h-12 bg-slate-50 border border-slate-200 rounded-xl px-4 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
                  required
                  autoFocus
                />
              </div>
              {addError && !addLimitReached && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{addError}</span>
                </div>
              )}
              {addLimitReached && (
                <div
                  role="alert"
                  className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-rose-50 p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white shadow-sm">
                      <Sparkles className="h-4 w-4 text-amber-600" aria-hidden="true" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-slate-900">
                        {t("members.upgradeNeeded", { defaultValue: "Plan limit reached" })}
                      </p>
                      <p className="mt-0.5 text-sm text-slate-600">{addError}</p>
                      <button
                        type="button"
                        onClick={() => { setShowAddModal(false); setLocation("/payment"); }}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-transform hover:-translate-y-px hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
                      >
                        {t("members.upgradePlan", { defaultValue: "Upgrade plan" })}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <Button
                type="submit"
                disabled={addLoading}
                className="w-full h-12 bg-primary hover:bg-primary/90 text-white rounded-xl font-bold"
              >
                {addLoading ? t("members.adding") : t("members.startTracking")}
              </Button>
            </form>
          </div>
        </div>
      )}

      <AlertDialog
        open={!!pendingRemove}
        onOpenChange={(open) => { if (!open && !removing) setPendingRemove(null); }}
      >
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <div className="mx-auto mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
              <Trash2 className="h-5 w-5 text-red-500" />
            </div>
            <AlertDialogTitle className="text-center">
              {t("members.removeTitle", { defaultValue: "Remove this account?" })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-center">
              {t("members.removeDesc", {
                defaultValue:
                  "@{{username}} will be removed from your tracked accounts and tracking will stop. You can add it again anytime.",
                username: pendingRemove?.igUsername ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:justify-center gap-2">
            <AlertDialogCancel disabled={removing} className="mt-0">
              {t("members.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <Button
              onClick={confirmRemove}
              disabled={removing}
              className="bg-red-600 hover:bg-red-700 text-white rounded-lg"
            >
              {removing ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("members.removing", { defaultValue: "Removing…" })}</>
              ) : (
                t("members.remove", { defaultValue: "Remove" })
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
