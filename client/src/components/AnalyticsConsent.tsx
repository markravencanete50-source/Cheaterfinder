import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useLocation } from "wouter";
import { productAnalytics } from "../lib/analytics";

export function AnalyticsConsent() {
  const [location] = useLocation();
  const inline = location === "/payment";
  const consent = useSyncExternalStore(productAnalytics.subscribe, productAnalytics.getConsent, () => "undecided");
  const [open, setOpen] = useState(false);
  useEffect(() => { void productAnalytics.page(); }, [location, consent]);
  if (!productAnalytics.configured || /^\/admin(?:\/|$)/.test(location)) return null;
  if (consent !== "undecided" && !open) return (
    <button type="button" onClick={() => setOpen(true)} className={`${inline ? "mx-auto my-4 block" : "fixed bottom-20 md:bottom-3 right-3 z-40"} rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 shadow-sm`}>
      Analytics preferences
    </button>
  );
  const choose = (next: "accepted" | "rejected") => { productAnalytics.setConsent(next); setOpen(false); };
  return (
    <section aria-label="Analytics preferences" className={`${inline ? "mx-3 my-4 md:mx-auto md:w-[440px]" : "fixed bottom-20 md:bottom-4 right-3 left-3 md:left-auto md:w-[440px] z-40"} rounded-2xl border border-slate-200 bg-white p-4 shadow-xl text-slate-700`}>
      <h2 className="font-semibold text-slate-900">Optional product analytics</h2>
      <p className="mt-2 text-sm leading-relaxed">Allow PostHog to measure pages and features used? We do not send passwords, form contents or tracked Instagram data, and session recording is off. Rejecting does not affect the app.</p>
      {productAnalytics.privacyBlocked() && <p className="mt-2 text-sm">Your browser privacy signal is enabled, so analytics remains off.</p>}
      <Link href="/privacy" className="mt-2 inline-block text-sm text-primary underline">Privacy policy</Link>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => choose("rejected")} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50">Reject analytics</button>
        <button type="button" onClick={() => choose("accepted")} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50">Allow analytics</button>
      </div>
    </section>
  );
}
