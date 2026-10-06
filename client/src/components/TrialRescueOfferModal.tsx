import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function TrialRescueOfferModal({ open, planName, priceLabel, activating, error, onActivate, onDismiss }: {
  open: boolean;
  planName: string;
  priceLabel?: string;
  activating: boolean;
  error: string | null;
  onActivate(): void;
  onDismiss(): void;
}) {
  return <Dialog open={open} onOpenChange={next => { if (!next && !activating) onDismiss(); }}>
    <DialogContent data-testid="trial-rescue-offer-dialog" className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Wait — get 50% off your first month.</DialogTitle>
        <DialogDescription className="pt-2 leading-relaxed">
          Activate {planName} at half price this month, then {priceLabel ? `${priceLabel}/month` : "your regular monthly price"} after.
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm leading-relaxed text-slate-600">Any available invoice credit applies. Your existing discounts are preserved.</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <Button type="button" data-testid="rescue-activate" className="h-auto min-h-11 w-full whitespace-normal" disabled={activating} onClick={onActivate}>
        {activating && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        {activating ? "Activating…" : "Activate at 50% off"}
      </Button>
      <Button type="button" data-testid="rescue-decline" variant="outline" className="h-auto min-h-11 w-full whitespace-normal" disabled={activating} onClick={onDismiss}>
        No thanks
      </Button>
    </DialogContent>
  </Dialog>;
}
