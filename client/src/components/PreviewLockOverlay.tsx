import type { ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { useTrialActivation } from "@/hooks/useTrialActivation";
import { TrialActivateButton } from "@/components/TrialActivateBanner";

export function PreviewLockOverlay({ children }: { children: ReactNode }) {
  const { isPreview } = useTrialActivation();
  if (!isPreview) return <>{children}</>;
  return <div className="relative min-h-44 overflow-hidden rounded-2xl" data-trial-preview="true">
    <div inert aria-hidden="true" className="pointer-events-none select-none blur-[3px] opacity-60">{children}</div>
    <div className="absolute inset-0 flex items-center justify-center bg-white/35 p-4">
      <div className="rounded-xl border border-slate-200 bg-white/95 px-5 py-4 text-center shadow-sm">
        <p className="mb-3 flex items-center justify-center gap-2 text-sm font-medium text-slate-700"><LockKeyhole className="h-4 w-4" />Activate to unlock real data</p>
        <TrialActivateButton />
      </div>
    </div>
  </div>;
}
