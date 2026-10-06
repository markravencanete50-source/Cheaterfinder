import { useEffect, useState } from "react";
import { csrfHeaders } from "@/lib/csrf";
import { formatBillingAmount } from "@/lib/billing-format";
import type { TrialPaymentSummary } from "@/lib/checkout-offer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Offer = { eligible: true; offerId: string; currency: string; amount: number; regularAmount: number;
  recurringAmount?: number; creditApplied?: number; trial: boolean; expiresAt: string };
type Quote = Offer | { eligible: false; reason: string };

export function CancellationDialog({ open, onOpenChange, onChanged, hasAccess, endsAt, trialPayment }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onChanged(message: string): void;
  hasAccess: boolean;
  endsAt: string | null;
  trialPayment?: TrialPaymentSummary | null;
}) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"accept" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const refundEndsAccess = trialPayment?.cancellationPolicy === "refund_during_trial" &&
    !!endsAt && new Date(endsAt).getTime() > Date.now();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setQuote(null); setError(""); setLoading(true); setExpired(false);
    fetch("/api/billing/retention-offer", {
      method: "POST", credentials: "include", headers: csrfHeaders(undefined, "POST"), signal: controller.signal,
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message ?? "We could not check offer availability. You can still cancel.");
      if (data.eligible === true && (!Number.isSafeInteger(data.amount) || !Number.isSafeInteger(data.regularAmount) ||
        data.amount < 0 || data.regularAmount <= data.amount || !data.offerId || !/^[a-z]{3}$/i.test(data.currency ?? "") ||
        !Number.isFinite(Date.parse(data.expiresAt)) ||
        (data.recurringAmount !== undefined && (!Number.isSafeInteger(data.recurringAmount) || data.recurringAmount <= 0)) ||
        (data.creditApplied !== undefined && (!Number.isSafeInteger(data.creditApplied) || data.creditApplied < 0)))) throw new Error("We could not verify this offer. You can still cancel.");
      if (!controller.signal.aborted) setQuote(data);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Offer unavailable. You can still cancel.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!quote?.eligible) return;
    const delay = Date.parse(quote.expiresAt) - Date.now();
    setExpired(delay <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, delay));
    return () => clearTimeout(timer);
  }, [quote]);

  const submit = async (kind: "accept" | "cancel") => {
    if (action) return;
    if (kind === "accept" && (!quote?.eligible || Date.parse(quote.expiresAt) <= Date.now())) {
      setExpired(true); return;
    }
    setAction(kind); setError("");
    try {
      const response = await fetch(kind === "accept" ? "/api/billing/retention-accept" : "/api/billing/cancel", {
        method: "POST", credentials: "include", headers: csrfHeaders({ "Content-Type": "application/json" }, "POST"),
        body: kind === "accept" && quote?.eligible ? JSON.stringify({ offerId: quote.offerId }) : undefined,
        signal: AbortSignal.timeout(35_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (kind === "accept" && response.status === 409) setQuote(null);
        throw new Error(data.message ?? "We could not confirm that change. Please try again.");
      }
      onChanged(data.message ?? (kind === "accept" ? "Your one-time discount is confirmed." : "Your cancellation is confirmed."));
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== "TimeoutError"
        ? failure.message : "We could not confirm that change. Please retry or open billing to check your subscription.");
    } finally { setAction(null); }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!action) onOpenChange(next); }}>
      <DialogContent data-testid="cancellation-dialog" className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cancel your subscription?</DialogTitle>
          <DialogDescription className="pt-2 leading-relaxed">
            {hasAccess ? refundEndsAccess ? "If you cancel during this trial, access ends immediately. Any unused advance is refunded under your checkout terms."
              : `If you cancel, access continues until ${endsAt ? new Date(endsAt).toLocaleDateString() : "the end of your current billing period"}.`
              : "Tracking access is currently inactive. You can still cancel future renewals."}
          </DialogDescription>
        </DialogHeader>
        {trialPayment?.creditStatus === "credited" && <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-600">
          {trialPayment.cancellationPolicy === "refund_during_trial"
            ? "Cancel before your trial ends to end access and receive a refund of your unused advance under the terms accepted at checkout. Check billing for the refund status."
            : "If you cancel, any unused advance remains as invoice credit and is not automatically refunded."}
        </p>}
        {trialPayment?.creditStatus === "pending" && <p className="text-sm leading-relaxed text-slate-600">Your advance payment or credit is still being confirmed. You can still cancel future renewals and review the payment in billing.</p>}
        {loading && <p role="status" className="text-sm text-slate-600">Checking for an optional offer. You can continue cancellation now.</p>}
        {quote?.eligible && <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="font-semibold text-slate-900">50% off one monthly subscription payment</h3>
          <p className="text-sm leading-relaxed text-slate-600">
            {quote.trial ? "Your first paid month after this trial" : "Your next monthly payment"}: {formatBillingAmount(quote.amount, quote.currency)} estimated.
            {" "}Then {formatBillingAmount(quote.recurringAmount ?? quote.regularAmount, quote.currency)} per month, based on your current plan and existing discounts.
          </p>
          {!!quote.creditApplied && <p className="text-sm leading-relaxed text-slate-600">The estimate includes {formatBillingAmount(quote.creditApplied, quote.currency)} in balance credit. This credit is separate from the one-time subscription discount.</p>}
          <p className="text-sm leading-relaxed text-slate-600">This offer applies once. Your billing date stays the same. Taxes and billing changes can affect the final invoice.</p>
          {expired && <p role="status" className="text-sm text-amber-700">This quote expired. Reopen cancellation to check the current offer.</p>}
          <Button data-testid="retention-accept" variant="outline" className="h-auto min-h-11 w-full whitespace-normal border-slate-300"
            disabled={!!action || expired} onClick={() => submit("accept")}>
            {action === "accept" ? "Confirming offer…" : "Keep subscription with 50% off once"}
          </Button>
        </div>}
        {quote && !quote.eligible && <p className="text-sm text-slate-600">{quote.reason}</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <Button data-testid="cancellation-confirm" variant="outline" className="h-auto min-h-11 w-full whitespace-normal border-red-200 text-red-700 hover:bg-red-50"
          disabled={!!action} onClick={() => submit("cancel")}>
          {action === "cancel" ? "Cancelling…" : "Continue cancellation"}
        </Button>
        <Button data-testid="cancellation-back" variant="ghost" disabled={!!action} onClick={() => onOpenChange(false)}>Go back</Button>
      </DialogContent>
    </Dialog>
  );
}
