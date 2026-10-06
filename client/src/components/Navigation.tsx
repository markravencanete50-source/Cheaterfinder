import { useLocation } from "wouter";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Shield, Activity, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { logoutAndClearCache } from "@/lib/logout";
import { productAnalytics } from "@/lib/analytics";

// Known admin email(s). Matches server-side ADMIN_EMAIL env.
// Client-side check is purely a UX gate to decide whether to show the Admin
// button and whether to probe admin endpoints; the server enforces authorization.
const ADMIN_EMAILS = new Set<string>(["admin@cheaterfinder.com"]);

interface AuthUser {
  id?: string;
  email?: string;
  isAdmin?: boolean;
  role?: string;
}

function detectAdmin(user: AuthUser): boolean {
  if (user.isAdmin === true) return true;
  if (user.role === "admin") return true;
  if (user.email && ADMIN_EMAILS.has(user.email.toLowerCase())) return true;
  return false;
}

export function Navigation() {
  const { t } = useTranslation();
  const [, setLocation] = useLocation();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/me", { credentials: "include", signal: controller.signal })
      .then(async (r) => {
        if (r.status === 401) productAnalytics.setUser(null);
        if (!r.ok) return;
        setIsLoggedIn(true);
        const user = (await r.json().catch(() => ({}))) as AuthUser;
        productAnalytics.setUser(user);
        if (detectAdmin(user)) {
          setIsAdmin(true);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const handleLogOut = async () => {
    await logoutAndClearCache();
    setIsLoggedIn(false);
    setLocation("/auth");
  };

  return (
    <header className="fixed top-0 w-full z-50 bg-background/90 backdrop-blur-md border-b border-border">
      <div className="container mx-auto px-3 sm:px-4 h-16 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 group cursor-pointer shrink-0" onClick={() => setLocation("/")}>
          <Activity className="h-6 w-6 text-primary animate-pulse group-hover:animate-bounce" />
          <span className="font-display font-bold text-lg sm:text-xl tracking-tight"><span className="text-foreground">Cheater</span><span className="text-primary">Finder</span></span>
        </div>

        <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-600">
          <a href="/#features" className="hover:text-primary transition-colors">{t("nav.features")}</a>
          <a href="/#how-it-works" className="hover:text-primary transition-colors">{t("nav.howItWorks")}</a>
          <a href="/#pricing" className="hover:text-primary transition-colors">{t("nav.pricing")}</a>
        </nav>

        <div className="flex items-center gap-1.5 sm:gap-3 md:gap-4">
          <div className="flex items-center gap-1 sm:gap-1.5 text-sm text-slate-600 border border-slate-200 rounded-full pl-2 sm:pl-3 pr-1 sm:pr-2 py-1.5 bg-slate-50 hover:bg-slate-100 transition-colors">
            <Globe className="w-4 h-4 text-slate-400 shrink-0" />
            <select
              aria-label={t("nav.languageSelector", { defaultValue: "Select language" })}
              className="bg-transparent border-none focus:outline-none cursor-pointer appearance-none font-medium pr-1 sm:pr-2 text-slate-700 text-xs sm:text-sm"
              onChange={(e) => i18n.changeLanguage(e.target.value)}
              value={i18n.language}
            >
              <option value="en">EN</option>
              <option value="es">ES</option>
              <option value="pt">PT</option>
              <option value="ru">RU</option>
            </select>
          </div>

          {isLoggedIn ? (
            <>
              {isAdmin && (
                <Button
                  variant="ghost"
                  className="hidden sm:flex text-slate-600 hover:text-primary hover:bg-slate-50 gap-1.5"
                  onClick={() => setLocation("/admin")}
                >
                  <Shield className="w-4 h-4" />
                  Admin
                </Button>
              )}
              <Button
                variant="ghost"
                className="text-slate-600 hover:text-primary hover:bg-slate-50 px-2 sm:px-4 text-sm sm:text-base"
                onClick={() => setLocation("/members")}
              >
                {t("nav.dashboard")}
              </Button>
              <Button
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full px-3 sm:px-6 text-sm sm:text-base shadow-sm"
                onClick={handleLogOut}
              >
                {t("nav.logOut")}
              </Button>
            </>
          ) : (
            /* Outlined, not filled: signing in is the returning-user path, so it
               must not read as the page's primary action. That belongs to the
               hero's "Track Account" button. */
            <Button
              className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-full px-4 sm:px-6 text-sm sm:text-base shadow-sm"
              onClick={() => setLocation("/auth")}
            >
              {t("nav.signIn", { defaultValue: "Sign In" })}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
