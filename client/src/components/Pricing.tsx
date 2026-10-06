import { Activity, Check, Crown, Star, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import confetti from "canvas-confetti";
import { useTranslation } from "react-i18next";
import {
  BILLING_PLANS,
  CHECKOUT_PLAN_IDS,
  type CheckoutPlan,
} from "@shared/billing-plans";

const PLAN_STYLES = {
  starter: {
    icon: Zap,
    iconClass: "bg-blue-50 text-blue-600",
    checkClass: "bg-blue-50 text-blue-600",
  },
  standard: {
    icon: Activity,
    iconClass: "bg-primary/10 text-primary",
    checkClass: "bg-primary/10 text-primary",
  },
  pro: {
    icon: Crown,
    iconClass: "bg-fuchsia-50 text-fuchsia-600",
    checkClass: "bg-fuchsia-50 text-fuchsia-600",
  },
} as const;

export function Pricing() {
  const [, setLocation] = useLocation();
  const { t } = useTranslation();

  const handleStartTracking = (plan: CheckoutPlan) => {
    const end = Date.now() + 1600;
    const frame = () => {
      confetti({
        particleCount: 5,
        angle: 60,
        spread: 55,
        origin: { x: 0 },
        colors: ["#4f46e5", "#d946ef", "#10b981"],
      });
      confetti({
        particleCount: 5,
        angle: 120,
        spread: 55,
        origin: { x: 1 },
        colors: ["#4f46e5", "#d946ef", "#10b981"],
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
    setTimeout(() => setLocation(`/payment?plan=${plan}`), 400);
  };

  const sharedFeatures = [
    t("pricing.feature2"),
    t("pricing.feature3"),
    t("pricing.feature4"),
    t("pricing.feature5"),
    t("pricing.feature6"),
  ];

  return (
    <section id="pricing" className="py-32 relative overflow-hidden bg-white">
      <div className="absolute top-1/2 left-0 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[100px] -translate-y-1/2 -translate-x-1/2 animate-glow pointer-events-none" />
      <div
        className="absolute bottom-0 right-0 w-[800px] h-[800px] bg-pink-400/5 rounded-full blur-[120px] translate-y-1/3 translate-x-1/3 animate-glow pointer-events-none"
        style={{ animationDelay: "2s" }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-block px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-bold mb-6 tracking-wide uppercase">
            {t("pricing.badge")}
          </div>
          <h2 className="text-4xl md:text-5xl font-bold mb-6 text-slate-900">
            <span className="text-primary relative inline-block">
              {t("pricing.heading")}
              <svg
                className="absolute w-full h-3 -bottom-1 left-0 text-primary/20"
                viewBox="0 0 100 10"
                preserveAspectRatio="none"
              >
                <path
                  d="M0 5 Q 50 10 100 5"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
              </svg>
            </span>
          </h2>
          <p className="text-xl text-slate-600">
            {t("pricing.subheading")}
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-6 max-w-7xl mx-auto items-stretch">
          {CHECKOUT_PLAN_IDS.map((planId) => {
            const plan = BILLING_PLANS[planId];
            const style = PLAN_STYLES[planId];
            const Icon = style.icon;
            const popular = planId === "standard";
            const features = [plan.description, ...sharedFeatures];

            return (
              <div
                key={planId}
                className={`rounded-[2rem] p-8 relative flex flex-col transition-all duration-300 hover:-translate-y-2 ${
                  popular
                    ? "bg-slate-900 text-white border border-slate-700 shadow-2xl lg:scale-[1.03]"
                    : "bg-white border border-slate-200 shadow-[0_15px_40px_rgb(0,0,0,0.05)]"
                }`}
              >
                {popular ? (
                  <div className="absolute top-5 right-5 bg-gradient-to-r from-amber-400 to-orange-500 text-slate-900 text-xs font-black px-3 py-1.5 rounded-full uppercase tracking-wider flex items-center gap-1.5">
                    <Star className="w-3.5 h-3.5 fill-slate-900" /> Most popular
                  </div>
                ) : null}

                <div
                  className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-6 ${style.iconClass}`}
                >
                  <Icon className="w-7 h-7" />
                </div>
                <h3
                  className={`text-2xl font-bold ${
                    popular ? "text-white" : "text-slate-900"
                  }`}
                >
                  {plan.name}
                </h3>
                <div className="flex items-baseline gap-1 mt-4">
                  {plan.anchorLabel ? (
                    <span
                      className={`text-2xl font-semibold line-through ${
                        popular ? "text-slate-400" : "text-slate-600"
                      }`}
                    >
                      {plan.anchorLabel}
                    </span>
                  ) : null}
                  <span
                    className={`text-5xl font-black tracking-tight ${
                      popular ? "text-white" : "text-slate-900"
                    }`}
                  >
                    {plan.priceLabel}
                  </span>
                  <span
                    className={
                      popular ? "text-slate-400" : "text-slate-500"
                    }
                  >
                    {plan.cadence}
                  </span>
                </div>
                {plan.discountName ? (
                  <div
                    className={`mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${
                      popular ? "bg-rose-500/20 text-rose-300" : "bg-rose-50 text-rose-700"
                    }`}
                  >
                    <span>{plan.discountSaveLabel}</span>
                    <span className="tracking-wide">{plan.discountName}</span>
                  </div>
                ) : null}

                <div
                  className={`h-px w-full my-7 ${
                    popular ? "bg-slate-700" : "bg-slate-100"
                  }`}
                />
                <ul className="space-y-4 mb-8 flex-1">
                  {features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                      <span
                        className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${style.checkClass}`}
                      >
                        <Check className="w-4 h-4" />
                      </span>
                      <span
                        className={
                          popular ? "text-slate-200" : "text-slate-700"
                        }
                      >
                        {feature}
                      </span>
                    </li>
                  ))}
                </ul>

                <Button
                  variant={popular ? "default" : "outline"}
                  className={`w-full h-14 rounded-xl text-lg font-bold ${
                    popular
                      ? "bg-gradient-to-r from-primary to-fuchsia-600 text-white border-0"
                      : "border-2"
                  }`}
                  onClick={() => handleStartTracking(planId)}
                >
                  {t("pricing.choosePlan")}
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
