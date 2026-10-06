import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ShieldCheck, Lock, ArrowRight, CheckCircle2, LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { csrfHeaders } from "@/lib/csrf";
import { logoutAndClearCache } from "@/lib/logout";
import { productAnalytics } from "@/lib/analytics";
import { formatBillingAmount } from "@/lib/billing-format";
import { parseCheckoutOffer, type CheckoutOffer } from "@/lib/checkout-offer";
import {
  BILLING_PLANS,
  CHECKOUT_PLAN_IDS,
  isCheckoutPlan,
  type CheckoutPlan,
} from "@shared/billing-plans";

interface AuthUser {
  id?: string;
  role?: string;
  name?: string;
  email?: string;
}

const celebs = [
  { handle: "kimkardashian", name: "Kim Kardashian", image: "/celebs/kim.webp" },
  { handle: "justinbieber", name: "Justin Bieber", image: "/celebs/justin.webp" },
  { handle: "selenagomez", name: "Selena Gomez", image: "/celebs/selena.webp" },
  { handle: "cristiano", name: "Cristiano Ronaldo", image: "/celebs/cristiano.webp" },
  { handle: "taylorswift", name: "Taylor Swift", image: "/celebs/taylor.webp" },
];

export default function Payment() {
  const [, setLocation] = useLocation();
  const { t, i18n } = useTranslation();
  // Read username from query string (from Hero search)
  const trackedUsername = new URLSearchParams(window.location.search).get("username") ?? (() => { try { return sessionStorage.getItem("checkout-target") ?? ""; } catch { return ""; } })();
  const [trialEligible, setTrialEligible] = useState<boolean | null>(null);
  useEffect(() => { if (/^@?[a-zA-Z0-9._]{1,30}$/.test(trackedUsername)) { try { sessionStorage.setItem("checkout-target", trackedUsername); } catch {} } }, [trackedUsername]);
  const [step, setStep] = useState(1);
  const [activeIndex, setActiveIndex] = useState(0);

  // Auth state — logged-in users (sent here to upgrade from Members/Settings)
  // skip the registration step and go straight to plan selection.
  const [authChecked, setAuthChecked] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);

  // Step 1 form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registerError, setRegisterError] = useState("");
  const [registerFailed, setRegisterFailed] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);

  // Step 2 plan selection
  const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan>(() => {
    const requested = new URLSearchParams(window.location.search).get("plan");
    return isCheckoutPlan(requested) ? requested : "standard";
  });
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [offer, setOffer] = useState<CheckoutOffer | null>(null);
  const [offerLoading, setOfferLoading] = useState(false);
  const [offerFailed, setOfferFailed] = useState(false);
  const [offerRefresh, setOfferRefresh] = useState(0);
  const [acceptedOfferVersion, setAcceptedOfferVersion] = useState<string | null>(null);
  const selectedPlanDetails = BILLING_PLANS[selectedPlan];
  const currentOffer = offer?.plan === selectedPlan ? offer : null;
  const hasTrial = !!currentOffer && currentOffer.trialDays > 0;
  const hasAdvance = !!currentOffer && currentOffer.creditAmount > 0;
  const beforeExistingCredit = !!currentOffer && !hasTrial && !hasAdvance && !currentOffer.requiresAcceptance;
  const dueTodayLabel = t(beforeExistingCredit ? "payment.estimateBeforeCredit" : "payment.dueToday");
  const money = (amount: number) => formatBillingAmount(amount, currentOffer?.currency ?? "usd", i18n.language);
  const checkoutReady = !!authUser && !!currentOffer && trialEligible !== null && !offerLoading &&
    (!currentOffer.requiresAcceptance || acceptedOfferVersion === currentOffer.version);

  useEffect(() => {
    setTrialEligible(null);
    setOffer(null);
    setAcceptedOfferVersion(null);
    setOfferFailed(false);
    if (!authUser) return;
    const controller = new AbortController();
    setOfferLoading(true);
    fetch(`/api/billing/eligibility?plan=${selectedPlan}`, { credentials: "include", signal: controller.signal })
      .then(async r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        if (controller.signal.aborted) return;
        if (data.hasAccess) { setLocation("/settings?tab=billing"); return; }
        const parsed = parseCheckoutOffer(data.offer, selectedPlan);
        if (typeof data.trialEligible !== "boolean" || !parsed ||
          (parsed.trialDays > 0) !== data.trialEligible) throw new Error("Invalid billing offer");
        setTrialEligible(data.trialEligible);
        setOffer(parsed);
      })
      .catch(() => { if (!controller.signal.aborted) { setTrialEligible(null); setOfferFailed(true); } })
      .finally(() => { if (!controller.signal.aborted) setOfferLoading(false); });
    return () => controller.abort();
  }, [authUser, selectedPlan, offerRefresh, setLocation]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") !== "cancelled") return;
    setCheckoutError(t("payment.checkoutCancelled"));
    params.delete("checkout");
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, []);

  // E21: drive the decorative pointer glow via a CSS variable on a ref + rAF
  // throttle instead of setState at pointer frequency (which re-rendered the
  // whole page on every mouse move).
  const glowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let frame = 0;
    const handleMouseMove = (e: MouseEvent) => {
      if (frame) return;
      const { clientX, clientY } = e;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const el = glowRef.current;
        if (el) {
          el.style.setProperty("--glow-x", `${clientX}px`);
          el.style.setProperty("--glow-y", `${clientY}px`);
        }
      });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // On mount, check whether the visitor is already logged in. If so, skip the
  // registration step entirely and take them to plan selection — otherwise the
  // paid-upgrade funnel dead-ends on a duplicate-email registration error.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/me", { credentials: "include", signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AuthUser | null) => {
        productAnalytics.setUser(data);
        if (data) {
          setAuthUser(data);
          setStep(2);
        }
        setAuthChecked(true);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        // Treat any failure as "not logged in" — keep the normal anon flow.
        setAuthChecked(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % celebs.length);
    }, 2500);
    return () => clearInterval(timer);
  }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !password.trim()) {
      setRegisterError(t("payment.allFieldsRequired", { defaultValue: "All fields are required." }));
      setRegisterFailed(true);
      return;
    }
    setRegisterLoading(true);
    setRegisterError("");
    setRegisterFailed(false);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: csrfHeaders({ "Content-Type": "application/json" }, "POST"),
        body: JSON.stringify({ name, email, password }),
      });
      if (res.ok) {
        // Registration auto-logs the user in server-side; reflect that locally.
        const data = (await res.json().catch(() => null)) as AuthUser | null;
        productAnalytics.setUser(data);
        void productAnalytics.track("auth_succeeded", { method: "register", entry: "payment" });
        if (data) setAuthUser(data);
        setStep(2);
      } else {
        // Surface the API message verbatim. The server intentionally returns a
        // generic, non-enumerable message for duplicate emails, so we pair it
        // with a "sign in instead" CTA via the registerFailed flag below.
        const data = await res.json().catch(() => ({}));
        setRegisterError(
          data.message ||
            t("payment.registerFailed", { defaultValue: "Registration failed. Please try again." }),
        );
        setRegisterFailed(true);
      }
    } catch {
      setRegisterError(t("payment.networkError", { defaultValue: "Network error. Please try again." }));
      setRegisterFailed(true);
    } finally {
      setRegisterLoading(false);
    }
  };

  const handleLogOut = async () => {
    try {
      await logoutAndClearCache();
    } catch {
      // Ignore network errors on logout — fall through to resetting local state.
    }
    setAuthUser(null);
    setOffer(null);
    setAcceptedOfferVersion(null);
    setStep(1);
  };

  const handleCheckout = async () => {
    if (!checkoutReady || !currentOffer || checkoutLoading) return;
    setCheckoutLoading(true);
    setCheckoutError("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "include",
        headers: csrfHeaders({ "Content-Type": "application/json" }, "POST"),
        body: JSON.stringify({ plan: selectedPlan, acceptedOfferVersion: currentOffer.version,
          ...(trackedUsername ? { igUsername: trackedUsername } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          setOffer(null);
          setAcceptedOfferVersion(null);
          setOfferRefresh(value => value + 1);
        }
        throw new Error(
          data.message ?? "Could not start secure checkout. Please try again.",
        );
      }
      if (data.url) {
        productAnalytics.trackCheckoutBeforeNavigation(selectedPlan);
        window.location.href = data.url;
      } else {
        throw new Error(data.message ?? "Stripe is not configured. Please contact support.");
      }
    } catch (err: any) {
      setCheckoutError(err?.message ?? "Could not start checkout. Please try again.");
    } finally {
      setCheckoutLoading(false);
    }
  };

  // Avoid flashing the registration form to an already-logged-in user while the
  // auth check is in flight.
  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <title>Upgrade — CheaterFinder</title>
        <div className="text-slate-400">{t("payment.loading", { defaultValue: "Loading…" })}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <title>Upgrade — CheaterFinder</title>
      {/* Interactive Purple Particle Effect — position is driven by CSS
          variables updated via rAF (see effect above) to avoid re-rendering
          the page on every pointer move. */}
      <div
        ref={glowRef}
        className="fixed pointer-events-none z-50 w-64 h-64 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform duration-75 ease-out"
        style={{
          left: "var(--glow-x, -100px)",
          top: "var(--glow-y, -100px)",
          background: 'radial-gradient(circle, rgba(168, 85, 247, 0.15) 0%, rgba(168, 85, 247, 0) 70%)',
          filter: 'blur(20px)',
        }}
      />

      {/* Background shapes */}
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-primary/10 rounded-full blur-[100px] -translate-y-1/2 translate-x-1/3 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-emerald-400/10 rounded-full blur-[100px] translate-y-1/3 -translate-x-1/3 pointer-events-none" />

      {/* Header */}
      <div
        className="self-start mb-4 md:mb-0 md:absolute md:top-8 md:left-8 cursor-pointer flex items-center gap-2 group z-20"
        onClick={() => setLocation("/")}
      >
        <ShieldCheck className="h-6 w-6 text-primary group-hover:scale-110 transition-transform" />
        <span className="font-display font-bold text-xl tracking-tight"><span className="text-foreground">Cheater</span><span className="text-primary">Finder</span></span>
      </div>

      <div className="w-full max-w-4xl bg-white rounded-3xl shadow-[0_20px_60px_rgb(0,0,0,0.08)] border border-slate-200 overflow-hidden flex flex-col md:flex-row relative z-10">

        {/* Order Summary (Left side on desktop) */}
        <div className="w-full md:w-5/12 bg-slate-900 text-white p-8 md:p-10 flex flex-col relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-transparent opacity-50" />

          <div className="relative z-10 flex-1">
            <h2 className="text-2xl font-bold mb-6 text-white">Order Summary</h2>

            <div className="bg-white/10 rounded-2xl p-5 backdrop-blur-md border border-white/10 mb-6">
              <div className="mb-2 flex flex-col gap-2">
                <div>
                  <h3 className="font-bold text-lg text-white">
                    {selectedPlanDetails.name}
                  </h3>
                  <p className="text-slate-300 text-sm">
                    {selectedPlanDetails.description}
                  </p>
                </div>
                <span className="text-right font-bold text-lg text-white">
                  {hasTrial ? t("payment.amountToday", { amount: money(currentOffer!.dueTodayAmount) }) : (
                    <>
                      {selectedPlanDetails.anchorLabel ? (
                        <span className="mr-1.5 align-middle text-sm font-normal text-slate-400 line-through">
                          {selectedPlanDetails.anchorLabel}
                        </span>
                      ) : null}
                      {selectedPlanDetails.priceLabel}
                      <span className="ml-0.5 text-xs font-normal text-slate-300">
                        {selectedPlanDetails.cadence}
                      </span>
                      {selectedPlanDetails.discountName ? (
                        <span className="mt-0.5 block text-xs font-semibold text-rose-400">
                          {selectedPlanDetails.discountSaveLabel} {selectedPlanDetails.discountName}
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-4 text-emerald-400 text-sm font-semibold bg-emerald-400/10 w-fit px-3 py-1.5 rounded-full">
                <CheckCircle2 className="w-4 h-4" /> {hasTrial ? t("payment.trialDays", { days: currentOffer!.trialDays }) : t("payment.secureCheckout")}
              </div>
            </div>

            <ul className="space-y-4 text-slate-300 text-sm mb-8">
              <li className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-3 h-3 text-white" />
                </div>
                Post & Reel likes tracking
              </li>
              <li className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-3 h-3 text-white" />
                </div>
                New follows & unfollows
              </li>
              <li className="flex items-center gap-3">
                <div className="w-5 h-5 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                  <CheckCircle2 className="w-3 h-3 text-white" />
                </div>
                {t("pricing.feature6")}
              </li>
            </ul>

            <p className="text-sm text-slate-300 mb-6">{t("home.accessNotice")}</p>

            {/* Animated Tracked Accounts Demo */}
            <div className="relative mt-4 flex-1 min-h-[140px] flex items-center justify-center">
              <div className="absolute inset-0 bg-primary/30 blur-[60px] rounded-full animate-pulse" style={{ animationDuration: '3s' }} />
              <div className="absolute inset-0 bg-fuchsia-500/20 blur-[50px] rounded-full animate-pulse" style={{ animationDuration: '4s', animationDelay: '1s' }} />

              <div className="w-full relative h-[80px]">
                {celebs.map((celeb, index) => {
                  const isActive = index === activeIndex;
                  const isPrev = index === (activeIndex - 1 + celebs.length) % celebs.length;

                  return (
                    <div
                      key={celeb.handle}
                      className={`absolute inset-0 w-full transition-all duration-700 ease-in-out flex justify-center ${
                        isActive
                          ? "opacity-100 translate-y-0 scale-100 z-20"
                          : isPrev
                            ? "opacity-0 -translate-y-8 scale-95 z-10"
                            : "opacity-0 translate-y-8 scale-95 z-10"
                      }`}
                    >
                      <div className="w-full max-w-[280px] bg-slate-800/80 backdrop-blur-xl border border-white/10 rounded-2xl p-4 flex items-center gap-4 shadow-[0_0_40px_rgba(79,70,229,0.5)]">
                        <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-primary to-fuchsia-500 p-[2px] shrink-0 shadow-lg shadow-primary/30">
                          <div className="w-full h-full rounded-full overflow-hidden border-2 border-slate-800">
                            <img src={celeb.image} alt={celeb.name} className="w-full h-full object-cover" />
                          </div>
                        </div>
                        <div>
                          <p className="font-bold text-white text-sm tracking-wide">@{celeb.handle}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            <p className="text-xs text-emerald-400 font-medium">Tracking Active</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="relative z-10 pt-6 border-t border-white/10">
            <div className="flex justify-between items-center mb-2">
              <span className="text-slate-300">{dueTodayLabel}</span>
              <span data-testid="checkout-due-today" className="text-2xl font-bold">{currentOffer ? money(currentOffer.dueTodayAmount) : t("payment.shownAtCheckout")}</span>
            </div>
            <p className="text-xs text-slate-400">{hasAdvance
              ? t("payment.advanceSummary", { amount: money(currentOffer!.creditAmount) })
              : hasTrial ? t("payment.freeTrialSummary", { days: currentOffer!.trialDays })
              : beforeExistingCredit ? t("payment.existingCreditNote") : t("payment.checkoutSummary")}</p>
          </div>
        </div>

        {/* Action Area (Right side) */}
        <div className="order-first md:order-last w-full md:w-7/12 p-6 sm:p-8 md:p-10">

          {/* Stepper */}
          <div className="flex items-center gap-4 mb-8">
            <div className={`flex items-center gap-2 ${step >= 1 ? 'text-primary' : 'text-slate-600'}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step >= 1 ? 'bg-primary text-white' : 'bg-slate-100'}`}>1</div>
              <span className="font-semibold text-sm">{t("payment.account")}</span>
            </div>
            <div className="h-px w-8 bg-slate-200" />
            <div className={`flex items-center gap-2 ${step >= 2 ? 'text-primary' : 'text-slate-600'}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step >= 2 ? 'bg-primary text-white' : 'bg-slate-100'}`}>2</div>
              <span className="font-semibold text-sm">{t("payment.payment_step")}</span>
            </div>
          </div>

          {step === 1 ? (
            <div className="animate-in fade-in slide-in-from-right-4 duration-500">
              <h2 className="text-3xl font-bold text-slate-900 mb-2">{t("payment.createAccountTitle")}</h2>
              <p className="text-slate-500 mb-8">{t("payment.createAccountSubtitle")}</p>

              <form onSubmit={handleRegister} className="space-y-4 mb-8">
                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-1 block">{t("payment.fullName")}</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("payment.fullNamePlaceholder")}
                    className="w-full h-12 bg-slate-50 border border-slate-200 rounded-xl px-4 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
                    required
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-1 block">{t("payment.email")}</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full h-12 bg-slate-50 border border-slate-200 rounded-xl px-4 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
                    required
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-1 block">{t("payment.password")}</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("payment.passwordPlaceholder")}
                    className="w-full h-12 bg-slate-50 border border-slate-200 rounded-xl px-4 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
                    required
                  />
                </div>

                {trackedUsername && (
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-sm text-slate-600">
                    <span className="font-medium">Tracking: </span>
                    <span className="font-mono text-primary">@{trackedUsername}</span>
                  </div>
                )}

                {registerError && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm">
                    {/* Render the API message verbatim — the server returns a
                        generic, non-enumerable message for duplicate emails. */}
                    <p className="text-red-600">{registerError}</p>
                    {registerFailed && (
                      <p className="mt-2 text-slate-600">
                        {t("payment.alreadyHaveAccount")}{" "}
                        <span
                          className="text-primary font-bold cursor-pointer hover:underline"
                          onClick={() => setLocation("/auth")}
                        >
                          {t("payment.signIn", { defaultValue: "Sign in" })}
                        </span>
                      </p>
                    )}
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={registerLoading}
                  className="w-full h-14 bg-primary hover:bg-primary/90 text-white rounded-xl font-bold text-lg flex items-center justify-center gap-2 shadow-lg shadow-primary/20"
                >
                  {registerLoading ? t("payment.creatingAccount") : <><span>{t("payment.continueToPayment")}</span><ArrowRight className="w-5 h-5" /></>}
                </Button>
              </form>

              <p className="text-center text-sm text-slate-500 mt-6">
                {t("payment.alreadyHaveAccount")} <span className="text-primary font-bold cursor-pointer hover:underline" onClick={() => setLocation("/auth")}>{t("payment.logIn")}</span>
              </p>
            </div>
          ) : (
            <div className="animate-in fade-in slide-in-from-right-4 duration-500">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center">
                  <Lock className="w-5 h-5 text-slate-700" />
                </div>
                <h2 className="text-3xl font-bold text-slate-900">{t("payment.choosePlan")}</h2>
              </div>
              <p className="text-slate-500 mb-8">{hasTrial ? t("payment.chooseTrialPlan", { days: currentOffer!.trialDays }) : t("payment.chooseSubscriptionPlan")}</p>

              {authUser && (
                <div className="flex items-center justify-between gap-3 mb-6 p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-500">
                      {t("payment.loggedInAs", { defaultValue: "Signed in as" })}
                    </p>
                    <p className="text-sm font-semibold text-slate-900 truncate">
                      {authUser.name || authUser.email}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleLogOut}
                    className="shrink-0 flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-red-600 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    {t("payment.notYouLogOut", { defaultValue: "Not you? Log out" })}
                  </button>
                </div>
              )}

              <div className="space-y-3 mb-8">
                {CHECKOUT_PLAN_IDS.map((planId) => {
                  const plan = BILLING_PLANS[planId];
                  const selected = selectedPlan === planId;
                  return (
                    <button
                      key={planId}
                      type="button"
                      disabled={checkoutLoading}
                      onClick={() => { setAcceptedOfferVersion(null); setSelectedPlan(planId); }}
                      aria-pressed={selected}
                      className={`w-full text-left border-2 rounded-2xl p-4 cursor-pointer transition-all ${
                        selected
                          ? "border-primary bg-primary/5"
                          : "border-slate-200 hover:border-slate-300"
                      }`}
                    >
                      <span className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center sm:gap-4">
                        <span>
                          <span className="flex items-center gap-2">
                            <span className="font-bold text-slate-900">
                              {plan.name}
                            </span>
                            {planId === "standard" ? (
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                                Popular
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-sm text-slate-500">
                            {plan.description}
                          </span>
                        </span>
                        <span className="shrink-0 text-left sm:text-right font-bold text-slate-900">
                          {plan.anchorLabel ? (
                            <span className="mr-1.5 align-middle text-sm font-normal text-slate-600 line-through">
                              {plan.anchorLabel}
                            </span>
                          ) : null}
                          {plan.priceLabel}
                          <span className="text-sm font-normal text-slate-500">
                            {plan.cadence}
                          </span>
                          {plan.discountName ? (
                            <span className="mt-0.5 block text-[11px] font-semibold text-rose-700">
                              {plan.discountSaveLabel} {plan.discountName}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {offerLoading && <p role="status" className="mb-4 text-sm text-slate-600">{t("payment.loadingOffer")}</p>}
              {offerFailed && <div role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <p>{t("payment.offerUnavailable")}</p>
                <Button type="button" variant="outline" className="mt-3" onClick={() => setOfferRefresh(value => value + 1)}>
                  {t("payment.retryOffer")}
                </Button>
              </div>}
              {currentOffer && <div data-testid="checkout-offer" className="mb-5 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
                <dl className="space-y-2">
                  <div className="flex justify-between gap-4"><dt>{dueTodayLabel}</dt><dd className="font-semibold">{money(currentOffer.dueTodayAmount)}</dd></div>
                  {hasAdvance && <div className="flex justify-between gap-4"><dt>{t("payment.invoiceCredit")}</dt><dd className="font-semibold">{money(currentOffer.creditAmount)}</dd></div>}
                  {hasTrial && <div className="flex justify-between gap-4"><dt>{t("payment.firstMonthlyEstimate")}</dt><dd className="font-semibold">{money(currentOffer.firstMonthlyAmount)}</dd></div>}
                  <div className="flex justify-between gap-4"><dt>{hasTrial ? t("payment.thenMonthly") : t("payment.monthlyPrice")}</dt><dd className="font-semibold">{money(currentOffer.recurringAmount)}{t("payment.perMonth")}</dd></div>
                </dl>
                {hasAdvance && <p>{t("payment.advanceDetails", { amount: money(currentOffer.creditAmount), days: currentOffer.trialDays })}</p>}
                {hasTrial && <p>{t("payment.renewalDetails", { days: currentOffer.trialDays })}</p>}
                {beforeExistingCredit && <p>{t("payment.existingCreditNote")}</p>}
                <p className="text-slate-600">{t("payment.estimateNote")}</p>
                {hasAdvance && currentOffer.cancellationPolicy === "refund_during_trial" && <p>{t("payment.refundDuringTrial", { amount: money(currentOffer.creditAmount) })}</p>}
                {hasAdvance && currentOffer.cancellationPolicy === "retain_credit" && <p>{t("payment.retainCredit")}</p>}
                <a className="font-medium text-primary underline" href="/terms" target="_blank" rel="noreferrer">{t("payment.viewTerms")}</a>
              </div>}
              {currentOffer?.requiresAcceptance && <label className="mb-5 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 text-sm leading-relaxed text-slate-700">
                <input type="checkbox" data-testid="checkout-offer-accept" className="mt-1 h-4 w-4 shrink-0 accent-primary"
                  checked={acceptedOfferVersion === currentOffer.version} disabled={checkoutLoading}
                  onChange={event => setAcceptedOfferVersion(event.target.checked ? currentOffer.version : null)} />
                <span>{t("payment.acceptAdvance", { amount: money(currentOffer.dueTodayAmount) })}</span>
              </label>}
              {checkoutError && <p role="alert" className="text-red-500 text-sm mb-4">{checkoutError}</p>}

              <Button
                className="w-full min-h-14 h-auto py-3 whitespace-normal bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-bold text-base sm:text-lg shadow-xl shadow-slate-900/20 mb-4"
                onClick={handleCheckout}
                data-testid="checkout-continue"
                disabled={checkoutLoading || !checkoutReady}
              >
                {checkoutLoading ? t("payment.redirecting") : hasAdvance
                  ? t("payment.continueWithAmount", { amount: money(currentOffer!.dueTodayAmount) }) : t("payment.continueSecureCheckout")}
              </Button>

              <div className="flex items-center justify-center gap-2 text-xs text-slate-500 font-medium">
                <Lock className="w-3 h-3" /> {t("payment.securePayment")}
              </div>

              {/* The "Back" affordance returns to the registration step, which
                  only exists for anonymous visitors. Logged-in users use the
                  "Not you? Log out" control above instead. */}
              {!authUser && (
                <div className="mt-8 pt-6 border-t border-slate-100 flex items-center gap-4">
                  <Button variant="ghost" className="text-slate-500 hover:text-slate-700" onClick={() => setStep(1)}>
                    {t("payment.back")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
