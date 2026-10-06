import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function TrialActivateConfirmationModal({ open, planName, priceLabel, cadence, activating, onActivate, onDismiss }: {
  open: boolean;
  planName: string;
  priceLabel?: string;
  cadence: "/month" | "/week";
  activating: boolean;
  onActivate(): void;
  onDismiss(): void;
}) {
  return <Dialog open={open} onOpenChange={next => { if (!next && !activating) onDismiss(); }}>
    <DialogContent data-testid="trial-activate-confirmation-dialog" className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Activate subscription</DialogTitle>
        <DialogDescription className="pt-2 leading-relaxed">
          Activate your {planName} subscription for {priceLabel ? `${priceLabel}${cadence}` : "your current plan price"}? You'll be charged now and unlock full access immediately.
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm leading-relaxed text-slate-600">Any available invoice credit applies.</p>
      <Button type="button" data-testid="confirmation-activate" className="h-auto min-h-11 w-full whitespace-normal" disabled={activating} onClick={onActivate}>
        Yes, activate
      </Button>
      <Button type="button" data-testid="confirmation-cancel" variant="outline" className="h-auto min-h-11 w-full whitespace-normal" disabled={activating} onClick={onDismiss}>
        Cancel
      </Button>
    </DialogContent>
  </Dialog>;
}
