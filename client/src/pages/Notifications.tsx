import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, LogOut, Settings as SettingsIcon, BarChart2, Bell, UserPlus, Heart, EyeOff, CheckCircle2, FileBarChart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { csrfHeaders } from "@/lib/csrf";
import { logoutAndClearCache } from "@/lib/logout";
import { MobileNav } from "@/components/MobileNav";

interface Notification {
  id: number;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

function getNotificationIcon(type: string) {
  switch (type) {
    case "new_follow": return { Icon: UserPlus, iconBg: "bg-emerald-100", iconColor: "text-emerald-600" };
    case "like": return { Icon: Heart, iconBg: "bg-pink-100", iconColor: "text-pink-600" };
    case "unfollow": return { Icon: EyeOff, iconBg: "bg-amber-100", iconColor: "text-amber-600" };
    default: return { Icon: BarChart2, iconBg: "bg-primary/10", iconColor: "text-primary" };
  }
}

export default function Notifications() {
  const [, setLocation] = useLocation();
  const { t } = useTranslation();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);

  const fetchNotifications = async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/notifications?limit=50", { credentials: "include", signal });
      if (res.status === 401) { setLocation("/auth"); return; }
      if (res.ok) { const data = await res.json(); setNotifications(data.items ?? []); }
      setAuthChecked(true);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setAuthChecked(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchNotifications(controller.signal);
    return () => controller.abort();
  }, []);

  const markAllAsRead = async () => {
    try {
      await fetch("/api/notifications/read-all", { method: "PATCH", credentials: "include", headers: csrfHeaders(undefined, "PATCH") });
      await fetchNotifications();
    } catch {
      // ignore
    }
  };

  const markOneAsRead = async (id: number) => {
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "PATCH", credentials: "include", headers: csrfHeaders(undefined, "PATCH") });
      setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, isRead: true } : n));
    } catch {
      // ignore
    }
  };

  const handleSignOut = async () => {
    await logoutAndClearCache();
    setLocation("/");
  };

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  if (!authChecked && loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-slate-400">{t("notifications.loading")}</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      <title>Notifications — CheaterFinder</title>
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-white border-r border-slate-200 flex flex-col hidden md:flex min-h-screen">
        <div className="p-6 border-b border-slate-100">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setLocation("/")}>
            <ShieldCheck className="h-6 w-6 text-primary" />
            <span className="font-display font-bold text-xl tracking-tight"><span className="text-foreground">Cheater</span><span className="text-primary">Finder</span></span>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <a onClick={() => setLocation('/members')} className="flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-50 rounded-xl font-medium transition-colors cursor-pointer">
            <BarChart2 className="w-5 h-5" /> {t("notifications.trackedAccounts")}
          </a>
          <a onClick={() => setLocation('/reports')} className="flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-50 rounded-xl font-medium transition-colors cursor-pointer">
            <FileBarChart className="w-5 h-5" /> {t("notifications.reports", "Reports")}
          </a>
          <a className="flex items-center gap-3 px-4 py-3 bg-primary/10 text-primary rounded-xl font-semibold cursor-default">
            <Bell className="w-5 h-5" /> {t("notifications.title")}
            {unreadCount > 0 && (
              <span className="ml-auto bg-primary text-white text-xs font-bold px-2 py-0.5 rounded-full">{unreadCount}</span>
            )}
          </a>
          <a onClick={() => setLocation('/settings')} className="flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-50 rounded-xl font-medium transition-colors cursor-pointer">
            <SettingsIcon className="w-5 h-5" /> {t("members.settings")}
          </a>
        </nav>

        <div className="p-4 border-t border-slate-100">
          <button onClick={handleSignOut} className="flex items-center gap-3 px-4 py-3 w-full text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-xl font-medium transition-colors">
            <LogOut className="w-5 h-5" /> {t("members.signOut")}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-6 md:p-10 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[100px] pointer-events-none" />

        <div className="max-w-4xl mx-auto relative z-10">
          {/* Mobile Header */}
          <div className="md:hidden flex items-center justify-between mb-8 pb-4 border-b border-slate-200">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => setLocation("/")}>
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
              <h1 className="text-3xl font-bold text-slate-900 mb-2">{t("notifications.title")}</h1>
              <p className="text-slate-600">{t("notifications.subtitle")}</p>
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllAsRead}
                className="flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 bg-primary/5 hover:bg-primary/10 px-4 py-2 rounded-lg transition-colors"
              >
                <CheckCircle2 className="w-4 h-4" /> {t("notifications.markAllRead")}
              </button>
            )}
          </div>

          {loading ? (
            <div className="text-center py-16 text-slate-500">{t("notifications.loading")}</div>
          ) : (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden">
              {notifications.length > 0 ? (
                <div className="divide-y divide-slate-100">
                  {notifications.map((notification) => {
                    const { Icon, iconBg, iconColor } = getNotificationIcon(notification.type);
                    return (
                      <div
                        key={notification.id}
                        onClick={() => !notification.isRead && markOneAsRead(notification.id)}
                        className={`p-6 flex items-start gap-4 transition-colors hover:bg-slate-50 ${!notification.isRead ? 'bg-primary/[0.02] cursor-pointer' : ''}`}
                      >
                        <div className={`w-12 h-12 rounded-full ${iconBg} flex items-center justify-center shrink-0 border border-white shadow-sm relative`}>
                          <Icon className={`w-5 h-5 ${iconColor}`} />
                          {!notification.isRead && (
                            <span className="absolute -top-1 -right-1 w-3 h-3 bg-primary rounded-full border-2 border-white"></span>
                          )}
                        </div>

                        <div className="flex-1">
                          {notification.title && (
                            <p className="font-semibold text-slate-900 mb-0.5">{notification.title}</p>
                          )}
                          <p className="text-slate-700">{notification.body}</p>
                          <p className="text-sm text-slate-500 mt-1">{new Date(notification.createdAt).toLocaleString()}</p>
                        </div>

                        {!notification.isRead && (
                          <div className="shrink-0 flex items-center justify-center">
                            <div className="w-2 h-2 bg-primary rounded-full" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-12 text-center flex flex-col items-center justify-center">
                  <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                    <Bell className="w-8 h-8 text-slate-400" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 mb-1">{t("notifications.noNotifications")}</h3>
                  <p className="text-slate-500">{t("notifications.noNotificationsDesc")}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
