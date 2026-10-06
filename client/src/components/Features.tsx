import { Heart, UserPlus, UserMinus, Bell, FileText, Lock } from "lucide-react";
import analyticsChart from "@/assets/analytics-chart.webp";
import { useTranslation } from "react-i18next";

export function Features() {
  const { t } = useTranslation();

  const features = [
    {
      icon: <Heart className="w-6 h-6 text-pink-500" />,
      bgColor: "bg-pink-100",
      title: t("features.postLikes"),
      description: t("features.postLikesDesc")
    },
    {
      icon: <UserPlus className="w-6 h-6 text-emerald-500" />,
      bgColor: "bg-emerald-100",
      title: t("features.newFollows"),
      description: t("features.newFollowsDesc")
    },
    {
      icon: <UserMinus className="w-6 h-6 text-amber-500" />,
      bgColor: "bg-amber-100",
      title: t("features.unfollows"),
      description: t("features.unfollowsDesc")
    },
    {
      icon: <FileText className="w-6 h-6 text-blue-500" />,
      bgColor: "bg-blue-100",
      title: t("features.activityReports"),
      description: t("features.activityReportsDesc")
    },
    {
      icon: <Bell className="w-6 h-6 text-primary" />,
      bgColor: "bg-primary/10",
      title: t("features.followAnalysis"),
      description: t("features.followAnalysisDesc")
    },
    {
      icon: <Lock className="w-6 h-6 text-slate-700" />,
      bgColor: "bg-slate-200",
      title: t("features.reelLikes"),
      description: t("features.reelLikesDesc")
    }
  ];

  return (
    <section id="features" className="py-24 relative bg-white">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-5xl font-bold mb-6 text-slate-900">{t("features.heading")}</h2>
          <p className="text-lg text-slate-600">
            {t("features.subheading")}
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 mb-24">
          {features.map((feature, i) => (
            <div key={i} className="glass-card p-8 rounded-2xl hover:-translate-y-1 transition-all duration-300">
              <div className={`w-14 h-14 rounded-xl flex items-center justify-center mb-6 ${feature.bgColor}`}>
                {feature.icon}
              </div>
              <h3 className="text-xl font-bold mb-3 text-slate-900">{feature.title}</h3>
              <p className="text-slate-600 leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>

        <div className="bg-slate-50 rounded-3xl p-8 md:p-12 overflow-hidden border border-slate-200 shadow-sm relative">
          <div className="absolute top-0 right-0 w-1/2 h-full bg-gradient-to-l from-primary/5 to-transparent pointer-events-none" />
          <div className="grid md:grid-cols-2 gap-12 items-center relative z-10">
            <div>
              <div className="inline-block px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-bold mb-6 tracking-wide uppercase">
                {t("features.differentiatorBadge")}
              </div>
              <h3 className="text-3xl md:text-4xl font-bold mb-6 text-slate-900 leading-tight">{t("features.differentiatorTitle")}</h3>
              <p className="text-lg text-slate-600 mb-8">
                {t("features.differentiatorDesc")}
              </p>
              <ul className="space-y-4">
                {[t("features.differentiatorBullet1"), t("features.differentiatorBullet2"), t("features.differentiatorBullet3")].map((item, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-white shrink-0">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </div>
                    <span className="font-medium text-slate-700">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="relative rounded-2xl overflow-hidden border border-slate-200 shadow-xl">
              <img src={analyticsChart} alt="Analytics Dashboard" className="w-full h-auto object-cover" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
