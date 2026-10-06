import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Search, ShieldCheck, Heart, UserPlus, UserMinus, PlaySquare, Image as ImageIcon } from "lucide-react";
import { useLocation } from "wouter";
import heroRadar from "@/assets/hero-radar.webp";
import { useTranslation } from "react-i18next";

const notificationSequence = [
  {
    id: 1,
    title: "New Like Detected",
    time: "Just now",
    icon: Heart,
    colorClass: "text-pink-500",
    bgClass: "bg-pink-100",
  },
  {
    id: 2,
    title: "New Follower",
    time: "1 min ago",
    icon: UserPlus,
    colorClass: "text-emerald-500",
    bgClass: "bg-emerald-100",
  },
  {
    id: 3,
    title: "Liked a Reel",
    time: "3 mins ago",
    icon: PlaySquare,
    colorClass: "text-blue-500",
    bgClass: "bg-blue-100",
  },
  {
    id: 4,
    title: "Account Unfollowed",
    time: "5 mins ago",
    icon: UserMinus,
    colorClass: "text-amber-500",
    bgClass: "bg-amber-100",
  },
  {
    id: 5,
    title: "Liked a Photo",
    time: "12 mins ago",
    icon: ImageIcon,
    colorClass: "text-purple-500",
    bgClass: "bg-purple-100",
  },
  {
    id: 6,
    title: "New Follower",
    time: "15 mins ago",
    icon: UserPlus,
    colorClass: "text-emerald-500",
    bgClass: "bg-emerald-100",
  }
];

export function Hero() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [, setLocation] = useLocation();
  const { t } = useTranslation();
  const [searchUsername, setSearchUsername] = useState("");

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % 3);
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const leftNotifs = [notificationSequence[0], notificationSequence[2], notificationSequence[4]];
  const rightNotifs = [notificationSequence[1], notificationSequence[3], notificationSequence[5]];

  return (
    <section className="relative pt-28 pb-12 md:pt-48 md:pb-32 overflow-hidden bg-slate-50">
      {/* Soft background shape */}
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[80px] -translate-y-1/2 translate-x-1/3 -z-10" />
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-blue-400/5 rounded-full blur-[80px] translate-y-1/3 -translate-x-1/3 -z-10" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-20">
          <div className="flex-1 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 md:px-4 md:py-2 rounded-full bg-white border border-slate-200 text-xs md:text-sm text-slate-600 mb-3 md:mb-8 shadow-sm">
              <ShieldCheck className="w-3.5 h-3.5 md:w-4 md:h-4 text-emerald-500" />
              <span className="font-medium">{t("home.heroTag")}</span>
            </div>

            {/*
              A fixed two-line lockup: black line over blue line. The break is
              hard rather than left to natural wrapping, and the phone size is
              fluid, so the long second line always fits its column instead of
              splintering into three or four lines and shoving the Track CTA
              under the fold. Measured at 2 lines from 320px up.
            */}
            <h1 className="text-[clamp(1.8rem,9vw,2.75rem)] sm:text-5xl md:text-6xl lg:text-[clamp(3.5rem,4.4vw,72px)] font-bold leading-[1.08] md:leading-[1.1] mb-3 md:mb-6 text-slate-900">
              {t("home.heroTitle1")}
              <br />
              <span className="text-primary inline-block">
                {t("home.heroTitle2")}
              </span>
            </h1>

            <p className="text-base md:text-xl text-slate-600 mb-5 md:mb-10 max-w-2xl mx-auto lg:mx-0 leading-relaxed">
              {t("home.heroDesc")}
            </p>

            {/* The whole point of the page is this box, so it states plainly what
                it does. Sign-in lives underneath as a quiet escape hatch for
                returning users rather than a second competing primary button. */}
            <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-4 justify-center lg:justify-start">
              <div className="relative w-full max-w-sm">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  aria-label={t("home.heroInputPlaceholder")}
                  placeholder={t("home.heroInputPlaceholder")}
                  value={searchUsername}
                  onChange={(e) => setSearchUsername(e.target.value)}
                  className="w-full h-14 bg-white border border-slate-200 rounded-full pl-12 pr-4 text-slate-900 shadow-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all text-base md:text-lg"
                />
              </div>
              <Button
                className="w-full sm:w-auto h-14 rounded-full px-8 bg-primary hover:bg-primary/90 text-white font-medium text-lg shadow-lg shadow-primary/25"
                onClick={() => setLocation(`/payment?username=${encodeURIComponent(searchUsername)}`)}
              >
                {t("home.trackAccount")}
              </Button>
            </div>

            <p className="mt-4 text-sm text-slate-500">
              {t("home.heroSignInPrompt")}{" "}
              <button
                type="button"
                onClick={() => setLocation("/auth")}
                className="font-semibold text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
              >
                {t("home.heroSignInLink")}
              </button>
            </p>

            <div className="hidden md:flex items-center justify-center lg:justify-start gap-8 text-sm font-medium text-slate-500 mt-8">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                {t("home.activeMonitoring")}
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-primary" />
                {t("home.instantAlerts")}
              </div>
            </div>
          </div>

          <div className="flex-1 w-full max-w-lg lg:max-w-none relative">
            {/* Glow effect behind the image */}
            <div className="absolute inset-0 bg-primary/40 blur-[80px] rounded-full transform -translate-y-4 animate-pulse scale-125 -z-10" />

            <div className="glass-card rounded-2xl overflow-hidden p-3 animate-float transition-transform duration-500 hover:scale-[1.02] relative z-10">
              <img
                src={heroRadar}
                alt="Tracking Dashboard Concept"
                className="w-full h-auto rounded-xl object-cover shadow-inner"
              />
            </div>

            {/* Floating indicator cards with CSS swiping animation */}
            <div className="absolute -left-8 top-12 z-20 hidden md:block w-64 overflow-hidden rounded-xl bg-white/90 backdrop-blur-sm border border-slate-200 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
              <div
                className="transition-transform duration-500 ease-in-out flex"
                style={{ transform: `translateX(-${(activeIndex % 3) * (100/3)}%)`, width: '300%' }}
              >
                {leftNotifs.map((notif) => (
                  <div key={notif.id} className="p-4 flex items-center gap-4 w-1/3 shrink-0">
                    <div className={`w-10 h-10 rounded-full ${notif.bgClass} flex items-center justify-center shrink-0`}>
                      <notif.icon className={`w-5 h-5 ${notif.colorClass}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-slate-900 leading-tight truncate">{notif.title}</p>
                      <p className="text-xs text-slate-500">{notif.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="absolute -right-6 bottom-20 z-20 hidden md:block w-64 overflow-hidden rounded-xl bg-white/90 backdrop-blur-sm border border-slate-200 shadow-[0_8px_30px_rgb(0,0,0,0.12)]">
              <div
                className="transition-transform duration-500 ease-in-out flex"
                style={{ transform: `translateX(-${(activeIndex % 3) * (100/3)}%)`, width: '300%' }}
              >
                {rightNotifs.map((notif) => (
                  <div key={notif.id} className="p-4 flex items-center gap-4 w-1/3 shrink-0">
                    <div className={`w-10 h-10 rounded-full ${notif.bgClass} flex items-center justify-center shrink-0`}>
                      <notif.icon className={`w-5 h-5 ${notif.colorClass}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-slate-900 leading-tight truncate">{notif.title}</p>
                      <p className="text-xs text-slate-500">{notif.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>
    </section>
  );
}
