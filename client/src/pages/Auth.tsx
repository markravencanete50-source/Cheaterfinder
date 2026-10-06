import { useState } from "react";
import { useLocation, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { productAnalytics } from "@/lib/analytics";
import { queryClient } from "@/lib/queryClient";
import { authPath, safeReturnTo, signedInDestination } from "@shared/auth-return";

export default function Auth() {
  const [, setLocation] = useLocation();
  const { t } = useTranslation();
  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const returnTo = safeReturnTo(new URLSearchParams(window.location.search).get("returnTo"));

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const url = isLogin ? "/api/auth/login" : "/api/auth/register";
      const body = isLogin
        ? { email, password }
        : { name, email, password };
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        // Keep admin routing while resuming a validated customer email link.
        const user = (await res.json().catch(() => null)) as
          | { role?: unknown; id?: unknown }
          | null;
        productAnalytics.setUser(user);
        void productAnalytics.track("auth_succeeded", { method: isLogin ? "login" : "register", entry: "auth" });
        // Drop anonymous access results and any previous account's cached data.
        queryClient.clear();
        setLocation(signedInDestination(user?.role, returnTo));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.message || t("auth.authFailed"));
      }
    } catch {
      setError(t("auth.networkError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 pt-24 pb-8 relative overflow-hidden">
      <title>{isLogin ? "Sign In — CheaterFinder" : "Create Account — CheaterFinder"}</title>
      {/* Background Glows */}
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary/10 rounded-full blur-[100px] animate-pulse pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-pink-400/10 rounded-full blur-[100px] pointer-events-none animate-glow" />

      <button
        onClick={() => setLocation("/")}
        className="absolute top-8 left-8 text-slate-700 hover:text-slate-900 flex items-center gap-2 font-medium transition-colors"
      >
        <ArrowLeft className="w-5 h-5" /> {t("auth.backHome")}
      </button>

      <div className="w-full max-w-md relative z-10">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2">
            <ShieldCheck className="h-8 w-8 text-primary" />
            <span className="font-display font-bold text-3xl tracking-tight"><span className="text-foreground">Cheater</span><span className="text-primary">Finder</span></span>
          </div>
          <p className="text-slate-600">{t("auth.accessDashboard")}</p>
        </div>

        <div className="bg-white rounded-3xl p-8 shadow-[0_20px_50px_rgb(0,0,0,0.06)] border border-slate-100">
          <h2 className="text-2xl font-bold text-slate-900 mb-6 text-center">
            {isLogin ? t("auth.welcomeBack") : t("auth.createAccount")}
          </h2>

          <form onSubmit={handleAuth} className="space-y-5">
            {!isLogin && (
              <div className="space-y-2">
                <label htmlFor="auth-name" className="text-sm font-medium text-slate-700">{t("auth.fullName")}</label>
                <input
                  id="auth-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full h-12 px-4 rounded-xl border border-slate-200 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                  placeholder={t("auth.fullNamePlaceholder")}
                  required
                />
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="auth-email" className="text-sm font-medium text-slate-700">{t("auth.email")}</label>
              <input
                id="auth-email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-12 px-4 rounded-xl border border-slate-200 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                placeholder="you@example.com"
                required
              />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label htmlFor="auth-password" className="text-sm font-medium text-slate-700">{t("auth.password")}</label>
                {isLogin && (
                  <Link href={authPath(returnTo, "/forgot-password")}>
                    <span className="text-xs text-primary hover:underline cursor-pointer">
                      {t("auth.forgotPassword")}
                    </span>
                  </Link>
                )}
              </div>
              <input
                id="auth-password"
                name="password"
                type="password"
                autoComplete={isLogin ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-12 px-4 rounded-xl border border-slate-200 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                placeholder="••••••••"
                required
              />
            </div>

            {error && (
              <p className="text-red-500 text-sm">{error}</p>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-12 bg-primary hover:bg-primary/90 text-white rounded-xl font-bold text-lg shadow-lg shadow-primary/25 mt-6"
            >
              {loading ? t("auth.pleaseWait") : isLogin ? t("auth.signIn") : t("auth.createAccount")}
            </Button>
          </form>

          <p className="text-center mt-8 text-slate-600 text-sm">
            {isLogin ? t("auth.noAccount") + " " : t("auth.alreadyAccount") + " "}
            <button
              onClick={() => { setIsLogin(!isLogin); setError(""); }}
              className="text-primary font-bold hover:underline"
            >
              {isLogin ? t("auth.signUp") : t("auth.logIn")}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
