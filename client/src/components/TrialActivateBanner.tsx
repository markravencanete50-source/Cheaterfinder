import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTrialActivation } from "@/hooks/useTrialActivation";

export function TrialActivateButton() {
  const { activating, requestActivation } = useTrialActivation();
  return <Button type="button" disabled={activating} onClick={requestActivation}>
    {activating && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
    {activating ? "Activating…" : "Activate now"}
  </Button>;
}

export function TrialActivateBanner({ sticky = true }: { sticky?: boolean }) {
  const { isPreview, planName, error } = useTrialActivation();
  if (!isPreview) return null;
  return <section aria-label="Trial preview" className={`${sticky ? "sticky top-16 z-40" : "relative"} mb-6 rounded-xl border border-primary/20 bg-white/95 p-4 shadow-sm backdrop-blur`}>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold text-slate-900">You're in preview mode. Activate your {planName} subscription to unlock real data.</p>
        <p className="mt-1 text-xs text-slate-500">Activating ends your trial and charges your card for your selected plan now. Any available invoice credit applies.</p>
      </div>
      <div className="shrink-0"><TrialActivateButton /></div>
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
  </section>;
}
