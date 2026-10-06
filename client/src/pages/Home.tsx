import { Navigation } from "@/components/Navigation";
import { Hero } from "@/components/Hero";
import { Features } from "@/components/Features";
import { Pricing } from "@/components/Pricing";
import { LiveSamples } from "@/components/LiveSamples";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";

export default function Home() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-white selection:bg-primary/20">
      <title>CheaterFinder — Instagram Activity Tracking</title>
      {/* Kept identical to the static default in client/index.html so the raw
          HTML a crawler reads and the DOM React renders agree on one
          description. */}
      <meta name="description" content="Track any public Instagram account with CheaterFinder. See the posts they like, who they follow, and who they unfollow — no Instagram password needed." />
      <Navigation />
      <main>
        <Hero />
        <LiveSamples />
        <Features />

        {/* Enhanced How It Works Section */}
        <section id="how-it-works" className="py-32 bg-slate-50 border-y border-slate-100 relative overflow-hidden">
          {/* Animated background glows */}
          <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[100px] animate-pulse pointer-events-none" />
          <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-emerald-400/5 rounded-full blur-[100px] animate-pulse pointer-events-none" style={{ animationDelay: '2s' }} />

          <div className="container mx-auto px-4 relative z-10">
            <div className="text-center max-w-3xl mx-auto mb-20">
              <div className="inline-block px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-bold mb-6 tracking-wide uppercase">
                {t("home.simpleProcess")}
              </div>
              <h2 className="text-4xl md:text-5xl font-bold text-slate-900">{t("home.howItWorks")} <span className="text-primary relative inline-block">
                <svg className="absolute w-full h-3 -bottom-1 left-0 text-primary/20" viewBox="0 0 100 10" preserveAspectRatio="none">
                  <path d="M0 5 Q 50 10 100 5" stroke="currentColor" strokeWidth="4" fill="none" />
                </svg>
              </span></h2>
            </div>

            <div className="grid md:grid-cols-4 gap-8 max-w-6xl mx-auto relative">
              {/* Connecting Line */}
              <div className="hidden md:block absolute top-12 left-[10%] w-[80%] h-1 bg-gradient-to-r from-primary/10 via-primary/30 to-primary/10 rounded-full" />

              {[
                { step: "1", titleKey: "home.step1Title", descKey: "home.step1Desc", color: "text-blue-500", bg: "bg-blue-50", border: "border-blue-100", shadow: "shadow-blue-500/20" },
                { step: "2", titleKey: "home.step2Title", descKey: "home.step2Desc", color: "text-primary", bg: "bg-primary/10", border: "border-primary/20", shadow: "shadow-primary/20" },
                { step: "3", titleKey: "home.step3Title", descKey: "home.step3Desc", color: "text-amber-500", bg: "bg-amber-50", border: "border-amber-100", shadow: "shadow-amber-500/20" },
                { step: "4", titleKey: "home.step4Title", descKey: "home.step4Desc", color: "text-emerald-500", bg: "bg-emerald-50", border: "border-emerald-100", shadow: "shadow-emerald-500/20" }
              ].map((item, i) => (
                <div key={i} className="relative group">
                  <div className={`
                    bg-white rounded-3xl p-8 border ${item.border}
                    shadow-[0_15px_35px_rgb(0,0,0,0.04)]
                    transform transition-all duration-300
                    hover:-translate-y-2 hover:shadow-[0_25px_50px_rgb(0,0,0,0.08)]
                    relative overflow-hidden h-full z-10
                  `}>
                    {/* Inner 3D Highlight */}
                    <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />

                    <div className={`w-16 h-16 mx-auto ${item.bg} ${item.color} rounded-2xl flex items-center justify-center text-3xl font-bold font-display mb-6 shadow-lg ${item.shadow} transform transition-transform group-hover:scale-110 group-hover:rotate-3`}>
                      {item.step}
                    </div>

                    <h3 className="text-xl font-bold mb-3 text-slate-900 text-center">{t(item.titleKey)}</h3>
                    <p className="text-slate-600 text-center leading-relaxed">{t(item.descKey)}</p>

                    {/* Hover Glow Effect inside card */}
                    <div className={`absolute -bottom-10 -right-10 w-32 h-32 ${item.bg} rounded-full blur-[30px] opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none`} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <Pricing />
      </main>

      <footer className="border-t border-slate-200 pt-12 pb-32 md:pb-12 text-center text-slate-500 bg-white">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-lg bg-primary text-white flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
            </div>
            <span className="font-display font-bold text-2xl"><span className="text-foreground">Cheater</span><span className="text-primary">Finder</span></span>
          </div>
          <p className="mb-6 font-medium">{t("home.disclaimer")}</p>
          <div className="mx-auto mb-6 max-w-4xl space-y-2 text-xs leading-relaxed text-slate-600">
            <p>{t("home.dataAvailabilityNotice")}</p>
            <p>{t("home.accessNotice")}</p>
          </div>
          <div className="flex gap-6 justify-center text-sm font-medium">
            <Link href="/privacy" className="hover:text-primary transition-colors">{t("home.privacy")}</Link>
            <Link href="/terms" className="hover:text-primary transition-colors">{t("home.terms")}</Link>
            <a href="mailto:support@cheaterfinder.com" className="hover:text-primary transition-colors">{t("home.contact")}</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
