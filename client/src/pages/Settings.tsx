import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, LogOut, Settings as SettingsIcon, BarChart2, Bell, User, CreditCard, Lock, Mail, FileBarChart } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { csrfHeaders } from "@/lib/csrf";
import { logoutAndClearCache } from "@/lib/logout";
import { MobileNav } from "@/components/MobileNav";
import { CancellationDialog } from "@/components/CancellationDialog";
import { formatBillingAmount } from "@/lib/billing-format";
import { parseTrialPayment, type TrialPaymentSummary } from "@/lib/checkout-offer";
import { authPath } from "@shared/auth-return";
import {
  BILLING_PLANS,
  CHECKOUT_PLAN_IDS,
  hasSubscriptionAccess,
  type CheckoutPlan,
  type SubscriptionPlan,
} from "@shared/billing-plans";

// Subscription payload returned by GET /api/billing/subscription.
// Mirrors the `subscriptions` table (shared/schema.ts); timestamps are
// serialized to ISO strings over the wire. The endpoint returns `null` when
// the authenticated user has no subscription row.
interface Subscription {
  id: string;
  userId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: "trialing" | "active" | "past_due" | "canceled";
  plan: SubscriptionPlan | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  createdAt: string;
  updatedAt: string;
  trialPayment?: TrialPaymentSummary;
}

// Distinguish "no subscription" (null) from "still loading" (undefined) and
// transient fetch errors. Returns null on 401 so an unauthenticated user (who
// is being redirected to /auth anyway) does not see a billing error flash.
async function fetchSubscription(signal?: AbortSignal): Promise<Subscription | null> {
  const res = await fetch("/api/billing/subscription", {
    credentials: "include",
    signal,
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`Failed to load subscription (${res.status})`);
  }
  return (await res.json()) as Subscription | null;
}

export default function Settings() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState(() =>
    new URLSearchParams(window.location.search).get("tab") === "billing"
      ? "billing"
      : "account",
  );
  const [accountSaved, setAccountSaved] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  // Preferences are server-authoritative (migration 0032). These defaults match
  // the server defaults and are replaced by the real values once /api/auth/me
  // resolves below.
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [pushNotifications, setPushNotifications] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan>("standard");
  const [showPlanChoices, setShowPlanChoices] = useState(false);
  const [billingLoading, setBillingLoading] = useState(false);
  const [showCancellation, setShowCancellation] = useState(false);
  const [billingError, setBillingError] = useState("");
  const [billingSuccess, setBillingSuccess] = useState("");

  const [user, setUser] = useState<{
    name: string;
    email: string;
    emailAlerts?: boolean;
    pushNotifications?: boolean;
  } | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const authController = new AbortController();

    fetch("/api/auth/me", { credentials: "include", signal: authController.signal })
      .then(r => {
        if (r.status === 401) { setLocation(authPath(window.location.pathname + window.location.search)); return null; }
        return r.ok ? r.json() : null;
      })
      .then(data => {
        if (data) {
          setUser(data);
          if (typeof data.emailAlerts === "boolean") setEmailAlerts(data.emailAlerts);
          if (typeof data.pushNotifications === "boolean")
            setPushNotifications(data.pushNotifications);
        }
        setAuthChecked(true);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setAuthChecked(true);
      });

    return () => {
      authController.abort();
    };
  }, []);

  // Subscription state via TanStack Query so loading, error, and "no
  // subscription" are distinct. Only enabled once auth is confirmed, so we
  // never flash billing UI to a user who is being redirected to /auth.
  const {
    data: subscription,
    isLoading: subscriptionLoading,
    isError: subscriptionError,
    refetch: refetchSubscription,
  } = useQuery<Subscription | null>({
    queryKey: ["billing", "subscription"],
    queryFn: ({ signal }) => fetchSubscription(signal),
    enabled: authChecked && user !== null,
    staleTime: 30_000,
    retry: 1,
  });

  // A disabled query reports isLoading=false with data=undefined. Treat that
  // (and the in-flight state) as "pending" so the empty "no subscription"
  // state is only shown once the fetch resolves with an explicit null.
  const subscriptionPending =
    subscriptionLoading || (subscription === undefined && !subscriptionError);
  const { data: invoicePreview } = useQuery<{ amount: number; currency: string; invoiceTotal?: number; creditApplied?: number; trialPayment?: TrialPaymentSummary }>({
    queryKey: ["billing", "invoice-preview", subscription?.updatedAt],
    enabled: !!subscription?.stripeSubscriptionId,
    queryFn: async () => { const r = await fetch("/api/billing/invoice-preview", { credentials: "include" }); if (!r.ok) throw new Error("Preview unavailable"); return r.json(); },
    retry: false,
  });
  const trialPayment = parseTrialPayment(subscription?.trialPayment);
  const checkoutConfirmedRef = useRef(false);

  useEffect(() => {
    if (!authChecked || !user || checkoutConfirmedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (params.get("checkout") !== "success" || !sessionId) return;

    checkoutConfirmedRef.current = true;
    const controller = new AbortController();
    fetch(`/api/billing/checkout-session/${encodeURIComponent(sessionId)}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.message ?? "Could not confirm checkout.");
        }
        setBillingSuccess(data.hasAccess ? "Your subscription is ready." : "Checkout is still processing. Refresh shortly to check your access.");
        await refetchSubscription();
        if (data.hasAccess && data.igUsername) {
          setLocation(`/members?username=${encodeURIComponent(data.igUsername)}`);
        }
        if (data.status === "complete" && data.hasAccess) {
          params.delete("checkout"); params.delete("session_id");
          if (!data.igUsername) window.history.replaceState({}, "", `/settings?${params.toString()}`);
        }
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setBillingError(
          err instanceof Error
            ? err.message
            : "Could not confirm checkout. Please refresh shortly.",
        );
      });

    return () => controller.abort();
  }, [authChecked, user, refetchSubscription]);

  const accountSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (accountSavedTimerRef.current) clearTimeout(accountSavedTimerRef.current);
      if (passwordSavedTimerRef.current) clearTimeout(passwordSavedTimerRef.current);
    };
  }, []);

  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  const handleSignOut = async () => {
    await logoutAndClearCache();
    setLocation("/");
  };

  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAccountError("");
    try {
      const res = await fetch("/api/account/profile", {
        method: "PUT",
        credentials: "include",
        headers: csrfHeaders({ "Content-Type": "application/json" }, "PUT"),
        body: JSON.stringify({
          name: nameRef.current?.value,
          email: emailRef.current?.value,
          emailAlerts,
          pushNotifications,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setAccountError(data.message ?? "Failed to save changes.");
        return;
      }
      setAccountSaved(true);
      accountSavedTimerRef.current = setTimeout(() => setAccountSaved(false), 3000);
    } catch {
      setAccountError("Network error. Please try again.");
    }
  };

  const handleUpdatePassword = async () => {
    setPasswordError("");
    const currentPassword = currentPasswordRef.current?.value ?? "";
    const newPassword = newPasswordRef.current?.value ?? "";
    const confirmPassword = confirmPasswordRef.current?.value ?? "";
    if (!currentPassword || !newPassword) {
      setPasswordError("Current and new password are required.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match.");
      return;
    }
    try {
      const res = await fetch("/api/account/password", {
        method: "PUT",
        credentials: "include",
        headers: csrfHeaders({ "Content-Type": "application/json" }, "PUT"),
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json();
        setPasswordError(data.message ?? "Failed to update password.");
        return;
      }
      setPasswordSaved(true);
      if (currentPasswordRef.current) currentPasswordRef.current.value = "";
      if (newPasswordRef.current) newPasswordRef.current.value = "";
      if (confirmPasswordRef.current) confirmPasswordRef.current.value = "";
      passwordSavedTimerRef.current = setTimeout(() => setPasswordSaved(false), 3000);
    } catch {
      setPasswordError("Network error. Please try again.");
    }
  };

  const handleDeleteAccount = async () => {
    if (!confirm("Permanently delete your account, cancel all subscriptions and remove saved payment details? This cannot be undone.")) return;
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        credentials: "include",
        headers: csrfHeaders(undefined, "DELETE"),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => null);
        alert(error?.message || "Failed to delete account. Please try again.");
        return;
      }
      setLocation("/auth");
    } catch {
      alert("Network error. Please try again.");
    }
  };

  const handleChangePlan = async (plan?: CheckoutPlan) => {
    setBillingLoading(true);
    setBillingError("");
    setBillingSuccess("");
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        credentials: "include",
        headers: csrfHeaders({ "Content-Type": "application/json" }, "POST"),
        body: JSON.stringify(plan ? { plan } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message ?? "Failed to open billing portal");
      }
      window.location.href = data.url;
    } catch (err) {
      setBillingError(
        err instanceof Error
          ? err.message
          : "Could not open billing portal. Please try again.",
      );
    } finally {
      setBillingLoading(false);
    }
  };

  const currentPlan = subscription?.plan
    ? BILLING_PLANS[subscription.plan]
    : null;

  if (!authChecked) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-slate-400">{t("settings.loading")}</div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      <title>Settings — CheaterFinder</title>
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
            <BarChart2 className="w-5 h-5" /> {t("settings.trackedAccounts")}
          </a>
          <a onClick={() => setLocation('/reports')} className="flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-50 rounded-xl font-medium transition-colors cursor-pointer">
            <FileBarChart className="w-5 h-5" /> {t("settings.reports", "Reports")}
          </a>
          <a onClick={() => setLocation('/notifications')} className="flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-50 rounded-xl font-medium transition-colors cursor-pointer">
            <Bell className="w-5 h-5" /> {t("settings.notifications")}
          </a>
          <a className="flex items-center gap-3 px-4 py-3 bg-primary/10 text-primary rounded-xl font-semibold cursor-default">
            <SettingsIcon className="w-5 h-5" /> {t("settings.title")}
          </a>
        </nav>

        <div className="p-4 border-t border-slate-100">
          <button onClick={handleSignOut} className="flex items-center gap-3 px-4 py-3 w-full text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-xl font-medium transition-colors">
            <LogOut className="w-5 h-5" /> {t("settings.signOut")}
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

          <div className="mb-10">
            <h1 className="text-3xl font-bold text-slate-900 mb-2">{t("settings.title")}</h1>
            <p className="text-slate-600">{t("settings.subtitle")}</p>
          </div>

          <div className="flex flex-col md:flex-row gap-8">
            {/* Settings Nav */}
            <div className="w-full md:w-64 flex-shrink-0 space-y-1">
              <button
                onClick={() => setActiveTab('account')}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-colors text-left ${activeTab === 'account' ? 'bg-white shadow-sm border border-slate-200 text-primary' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                <User className="w-5 h-5" /> {t("settings.accountDetails")}
              </button>
              <button
                onClick={() => setActiveTab('billing')}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-colors text-left ${activeTab === 'billing' ? 'bg-white shadow-sm border border-slate-200 text-primary' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                <CreditCard className="w-5 h-5" /> {t("settings.billing")}
              </button>
              <button
                onClick={() => setActiveTab('security')}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-colors text-left ${activeTab === 'security' ? 'bg-white shadow-sm border border-slate-200 text-primary' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                <Lock className="w-5 h-5" /> {t("settings.security")}
              </button>
            </div>

            {/* Settings Content */}
            <div className="flex-1 bg-white rounded-3xl p-6 md:p-8 border border-slate-200 shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
              {activeTab === 'account' && (
                <form onSubmit={handleSaveAccount} className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="border-b border-slate-100 pb-6 mb-6">
                    <h2 className="text-xl font-bold text-slate-900 mb-1">{t("settings.profileInfo")}</h2>
                    <p className="text-sm text-slate-500">{t("settings.profileSubtitle")}</p>
                  </div>

                  <div className="space-y-6">
                    <div className="grid gap-2">
                      <label className="text-sm font-semibold text-slate-700">{t("settings.fullName")}</label>
                      <input key={user?.name} ref={nameRef} type="text" defaultValue={user?.name ?? ""} className="w-full h-12 bg-slate-50 border border-slate-200 rounded-xl px-4 text-slate-900 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all" />
                    </div>

                    <div className="grid gap-2">
                      <label className="text-sm font-semibold text-slate-700">{t("settings.emailAddress")}</label>
                      <div className="relative">
                        <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                        <input key={user?.email} ref={emailRef} type="email" defaultValue={user?.email ?? ""} className="w-full h-12 bg-slate-50 border border-slate-200 rounded-xl pl-12 pr-4 text-slate-900 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all" />
                      </div>
                    </div>

                    <div className="grid gap-2">
                      <label className="text-sm font-semibold text-slate-700">{t("settings.notificationPrefs")}</label>
                      <div className="space-y-3 mt-2 bg-slate-50 p-4 rounded-xl border border-slate-200">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium text-slate-900">{t("settings.emailAlerts")}</p>
                            <p className="text-xs text-slate-500">{t("settings.emailAlertsDesc")}</p>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-label={t("settings.emailAlerts")}
                            aria-checked={emailAlerts}
                            onClick={() => setEmailAlerts(v => !v)}
                            className={`w-11 h-6 rounded-full relative cursor-pointer shadow-inner transition-colors ${emailAlerts ? 'bg-primary' : 'bg-slate-300'}`}
                          >
                            <div className={`w-4 h-4 bg-white rounded-full absolute top-1 shadow-sm transition-all ${emailAlerts ? 'right-1' : 'left-1'}`}></div>
                          </button>
                        </div>
                        <div className="flex items-center justify-between pt-3 border-t border-slate-200">
                          <div>
                            <p className="font-medium text-slate-900">{t("settings.pushNotifications")}</p>
                            <p className="text-xs text-slate-500">{t("settings.pushNotificationsDesc")}</p>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-label={t("settings.pushNotifications")}
                            aria-checked={pushNotifications}
                            onClick={() => setPushNotifications(v => !v)}
                            className={`w-11 h-6 rounded-full relative cursor-pointer shadow-inner transition-colors ${pushNotifications ? 'bg-primary' : 'bg-slate-300'}`}
                          >
                            <div className={`w-4 h-4 bg-white rounded-full absolute top-1 shadow-sm transition-all ${pushNotifications ? 'right-1' : 'left-1'}`}></div>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 flex justify-end items-center gap-4">
                    {accountSaved && (
                      <span className="text-emerald-600 text-sm font-medium">{t("settings.saved")}</span>
                    )}
                    {accountError && (
                      <span className="text-red-500 text-sm font-medium">{accountError}</span>
                    )}
                    <Button type="submit" className="bg-primary hover:bg-primary/90 text-white rounded-xl px-8 h-12">
                      {t("settings.saveChanges")}
                    </Button>
                  </div>
                </form>
              )}

              {activeTab === 'billing' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="border-b border-slate-100 pb-6 mb-6">
                    <h2 className="text-xl font-bold text-slate-900 mb-1">{t("settings.subscriptionBilling")}</h2>
                    <p className="text-sm text-slate-500">{t("settings.subscriptionSubtitle")}</p>
                  </div>

                  {billingError && (
                    <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                      {billingError}
                    </p>
                  )}
                  {billingSuccess && (
                    <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
                      {billingSuccess}
                    </p>
                  )}

                  {subscriptionPending ? (
                    /* Loading skeleton — distinct from the "no subscription"
                        empty state so paying customers never briefly see
                        "Subscribe now" while the request is in flight. */
                    <div className="animate-pulse space-y-4" aria-busy="true">
                      <div className="bg-slate-100 rounded-2xl h-32 border border-slate-200" />
                      <div className="bg-slate-100 rounded-2xl h-20 border border-slate-200" />
                    </div>
                  ) : subscriptionError ? (
                    /* Transient fetch error — offer a retry instead of silently
                        showing the empty state. */
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
                      <p className="text-amber-700 font-medium mb-1">
                        {t("settings.subscriptionLoadError", {
                          defaultValue: "We couldn't load your subscription details.",
                        })}
                      </p>
                      <p className="text-sm text-amber-600 mb-4">
                        {t("settings.subscriptionLoadErrorHint", {
                          defaultValue: "This is usually temporary. Please try again.",
                        })}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-lg border-amber-300 text-amber-700 hover:bg-amber-100"
                        onClick={() => refetchSubscription()}
                      >
                        {t("settings.retry", { defaultValue: "Retry" })}
                      </Button>
                    </div>
                  ) : subscription === null ? (
                    /* Fetch succeeded with no subscription row. */
                    <p className="text-slate-500">{t("settings.noSubscription")} <button onClick={() => setLocation("/payment")} className="text-primary underline">{t("settings.subscribeNow")}</button></p>
                  ) : (
                    <>
                      <div className="bg-slate-50 rounded-2xl p-6 border border-slate-200 mb-6">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                          <div>
                            <div className="flex items-center gap-3 mb-1">
                              <h3 className="text-lg font-bold text-slate-900">
                                {currentPlan
                                  ? `${currentPlan.name} Plan`
                                  : "No Active Plan"}
                              </h3>
                              {hasSubscriptionAccess(subscription) && (
                                <span className="bg-primary/10 text-primary text-xs font-bold px-2 py-1 rounded-full uppercase">{t("settings.active")}</span>
                              )}
                            </div>
                            <p className="text-slate-600">
                              {currentPlan
                                ? `Track up to ${currentPlan.accountLimit} Instagram account${
                                    currentPlan.accountLimit === 1 ? "" : "s"
                                  }.`
                                : t("settings.trackAccounts")}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-2xl font-bold text-slate-900">
                              {invoicePreview ? formatBillingAmount(invoicePreview.amount, invoicePreview.currency) : "See billing"}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-500">Estimated next amount due</p>
                          </div>
                        </div>
                        {invoicePreview && Number.isSafeInteger(invoicePreview.creditApplied) && invoicePreview.creditApplied! > 0 &&
                          Number.isSafeInteger(invoicePreview.invoiceTotal) && <dl className="mb-4 space-y-1 text-sm text-slate-600" data-testid="billing-credit-breakdown">
                            <div className="flex justify-between gap-4"><dt>Invoice before balance credit</dt><dd>{formatBillingAmount(invoicePreview.invoiceTotal!, invoicePreview.currency)}</dd></div>
                            <div className="flex justify-between gap-4"><dt>Balance credit applied</dt><dd>−{formatBillingAmount(invoicePreview.creditApplied!, invoicePreview.currency)}</dd></div>
                          </dl>}
                        {trialPayment && <p data-testid="billing-trial-payment" className="mb-4 rounded-xl border border-slate-200 bg-white p-3 text-sm leading-relaxed text-slate-600">
                          {trialPayment.creditStatus === "credited"
                            ? <>Your {formatBillingAmount(trialPayment.amount, trialPayment.currency)} advance was added once as invoice credit. It may already have been applied to an invoice. Billing shows the current balance and receipts.</>
                            : trialPayment.creditStatus === "refunded"
                              ? <>Your {formatBillingAmount(trialPayment.amount, trialPayment.currency)} advance refund is confirmed. The refunded amount is no longer available as invoice credit.</>
                              : <>Your advance payment or credit is still being confirmed. Review billing before making another payment.</>}
                        </p>}
                        <div className="flex items-center justify-between pt-4 border-t border-slate-200 text-sm">
                          <span className="text-slate-500">{t("settings.nextBilling")} <strong>{subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd).toLocaleDateString() : "—"}</strong></span>
                          <button
                            onClick={() => hasSubscriptionAccess(subscription) ? setShowPlanChoices(v => !v) : handleChangePlan()}
                            disabled={billingLoading}
                            className="text-primary font-medium hover:underline disabled:opacity-50"
                          >
                            {billingLoading ? t("settings.loading") : hasSubscriptionAccess(subscription) ? t("settings.changePlan") : "Review billing"}
                          </button>
                        </div>
                      </div>

                      {!hasSubscriptionAccess(subscription) && <p className="mb-4 text-amber-700">Tracking access is inactive. {subscription.status === "past_due"
                        ? <button className="underline" disabled={billingLoading} onClick={() => handleChangePlan()}>Review payment in billing</button>
                        : <button className="underline" onClick={() => setLocation("/payment")}>Choose a subscription</button>}</p>}
                      {showPlanChoices && hasSubscriptionAccess(subscription) && <div className="mb-6 rounded-2xl border p-6 space-y-4">
                        <label className="block">Choose a plan
                          <select className="block w-full rounded border p-3 mt-2" value={selectedPlan} onChange={e => setSelectedPlan(e.target.value as CheckoutPlan)}>
                            {CHECKOUT_PLAN_IDS.map(plan => <option key={plan} value={plan}>{BILLING_PLANS[plan].name} — {BILLING_PLANS[plan].priceLabel}/month</option>)}
                          </select>
                        </label>
                        <p className="text-sm text-slate-600">Stripe will show the discount, taxes and any prorated charge before you confirm. A downgrade keeps your oldest profiles within the new limit.</p>
                        <Button disabled={billingLoading || selectedPlan === subscription.plan} onClick={() => handleChangePlan(selectedPlan)}>Review plan change</Button>
                      </div>}

                      <div className="border border-slate-200 rounded-2xl p-6">
                        <h3 className="font-bold text-slate-900 mb-4">{t("settings.paymentMethod")}</h3>
                        <div className="flex items-center justify-between">
                          <p className="text-slate-500 text-sm">{t("settings.managePayment")}</p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-lg"
                            onClick={() => handleChangePlan()}
                            disabled={billingLoading}
                          >
                            {t("settings.manage")}
                          </Button>
                        </div>
                      </div>

                      <div className="mt-4 pt-6 border-t border-slate-100">
                        <h3 className="text-red-600 font-bold mb-2">{t("settings.cancelSubscription")}</h3>
                        {subscription.cancelAtPeriodEnd ? (
                          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                            Cancellation is scheduled.{hasSubscriptionAccess(subscription) ? <> Access remains active through{" "}<strong>
                              {(subscription.status === "trialing" ? subscription.trialEndsAt : subscription.currentPeriodEnd)
                                ? new Date((subscription.status === "trialing" ? subscription.trialEndsAt : subscription.currentPeriodEnd)!).toLocaleDateString()
                                : "the end of your billing period"}
                            </strong>.</> : " Tracking access is currently inactive. You can review any outstanding invoice in billing."}
                          </p>
                        ) : subscription.stripeSubscriptionId?.startsWith("sub_") && subscription.status !== "canceled" ? (
                          <>
                            <p className="text-sm text-slate-500 mb-4">{hasSubscriptionAccess(subscription) ? t("settings.cancelSubtitle") : "You can cancel future renewals even when tracking access is inactive."}</p>
                            <Button
                              variant="outline"
                              className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-300"
                              onClick={() => { setBillingError(""); setBillingSuccess(""); setShowCancellation(true); }}
                            >
                              {t("settings.cancelBtn")}
                            </Button>
                          </>
                        ) : <p className="text-sm text-slate-500">There is no renewable subscription to cancel. Open billing to review your subscription.</p>}
                      </div>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'security' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="border-b border-slate-100 pb-6 mb-6">
                    <h2 className="text-xl font-bold text-slate-900 mb-1">{t("settings.securityTitle")}</h2>
                    <p className="text-sm text-slate-500">{t("settings.securitySubtitle")}</p>
                  </div>

                  <div className="space-y-4">
                    <div className="grid gap-2">
                      <label className="text-sm font-semibold text-slate-700">{t("settings.currentPassword")}</label>
                      <input ref={currentPasswordRef} type="password" placeholder="••••••••" className="w-full h-12 bg-slate-50 border border-slate-200 rounded-xl px-4 text-slate-900 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
                    </div>

                    <div className="grid gap-2">
                      <label className="text-sm font-semibold text-slate-700">{t("settings.newPassword")}</label>
                      <input ref={newPasswordRef} type="password" placeholder="Enter new password" className="w-full h-12 bg-slate-50 border border-slate-200 rounded-xl px-4 text-slate-900 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
                    </div>

                    <div className="grid gap-2">
                      <label className="text-sm font-semibold text-slate-700">{t("settings.confirmPassword")}</label>
                      <input ref={confirmPasswordRef} type="password" placeholder="Confirm new password" className="w-full h-12 bg-slate-50 border border-slate-200 rounded-xl px-4 text-slate-900 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
                    </div>
                  </div>

                  <div className="pt-4 flex justify-end items-center gap-4">
                    {passwordSaved && (
                      <span className="text-emerald-600 text-sm font-medium">{t("settings.passwordUpdated")}</span>
                    )}
                    {passwordError && (
                      <span className="text-red-500 text-sm font-medium">{passwordError}</span>
                    )}
                    <Button onClick={handleUpdatePassword} className="bg-primary hover:bg-primary/90 text-white rounded-xl px-8 h-12">
                      {t("settings.updatePassword")}
                    </Button>
                  </div>

                  <div className="mt-8 pt-8 border-t border-slate-100">
                    <h3 className="text-red-600 font-bold mb-2">{t("settings.dangerZone")}</h3>
                    <p className="text-sm text-slate-500 mb-4">{t("settings.dangerDesc")}</p>
                    <Button onClick={handleDeleteAccount} variant="outline" className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-300">
                      {t("settings.deleteAccount")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
      {showCancellation && <CancellationDialog open onOpenChange={setShowCancellation}
        hasAccess={hasSubscriptionAccess(subscription)}
        endsAt={subscription?.status === "trialing" ? subscription.trialEndsAt : subscription?.currentPeriodEnd ?? null}
        trialPayment={subscription?.status === "trialing" ? trialPayment : null}
        onChanged={message => {
          setBillingSuccess(message); setBillingError("");
          void refetchSubscription();
          void queryClient.invalidateQueries({ queryKey: ["billing", "invoice-preview"] });
          void queryClient.invalidateQueries({ queryKey: ["billing", "access"] });
        }} />}
    </div>
  );
}
