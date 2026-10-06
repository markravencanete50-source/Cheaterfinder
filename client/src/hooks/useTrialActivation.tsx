import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BILLING_PLANS, type SubscriptionAccess } from "@shared/billing-plans";
import { csrfHeaders } from "@/lib/csrf";
import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { TrialActivateConfirmationModal } from "@/components/TrialActivateConfirmationModal";
import { TrialRescueOfferModal } from "@/components/TrialRescueOfferModal";

interface BillingAccess { signedIn: boolean; subscription: SubscriptionAccess | null }
interface TrialActivation {
  isPreview: boolean;
  activating: boolean;
  planName: string;
  error: string | null;
  requestActivation(): void;
  activate(options?: { offerId: string }): Promise<void>;
}
type ActivationModal = { kind: "confirmation" } | { kind: "rescue"; offerId: string } | null;
const TrialContext = createContext<TrialActivation | null>(null);

async function openBillingPortal() {
  try {
    const response = await fetch("/api/billing/portal", {
      method: "POST", credentials: "include", headers: csrfHeaders(undefined, "POST"),
    });
    const data = await response.json();
    if (!response.ok || !data.url) throw new Error(data.message || "Could not open billing settings.");
    window.location.assign(data.url);
  } catch (error) {
    toast({ variant: "destructive", title: "Could not open billing settings", description: error instanceof Error ? error.message : "Please try again." });
  }
}

function paymentFailed() {
  toast({ variant: "destructive", title: "Payment failed — update card",
    description: "Update your payment method in the billing portal to restore access.",
    action: <ToastAction altText="Update card in Stripe" onClick={() => void openBillingPortal()}>Update card</ToastAction>,
  });
}

export function TrialPreviewProvider({ children, onActivated }: { children: ReactNode; onActivated?: () => void }) {
  const queryClient = useQueryClient();
  // PaidAccess owns this query's polling and routing. Observe its exact cache
  // shape without introducing another access decision or changing that guard.
  const { data } = useQuery<BillingAccess>({ queryKey: ["billing", "access"], enabled: false,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/billing/subscription", { credentials: "include", signal });
      if (response.status === 401) return { signedIn: false, subscription: null };
      if (!response.ok) throw new Error("Could not check subscription access.");
      return { signedIn: true, subscription: await response.json() as SubscriptionAccess | null };
    },
  });
  const subscription = data?.subscription;
  const plan = subscription?.plan ? BILLING_PLANS[subscription.plan] : undefined;
  const planName = plan?.name ?? "selected";
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ActivationModal>(null);
  const modalRef = useRef<ActivationModal>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const claimRequest = useRef<AbortController | null>(null);
  const activationRequest = useRef<AbortController | null>(null);
  const currentSubscription = useRef(subscription);
  currentSubscription.current = subscription;
  const previousStatus = useRef(subscription?.status);
  const previousIdentity = useRef(`${subscription?.stripeSubscriptionId}:${subscription?.plan}`);
  const activatedCallback = useRef(onActivated);
  activatedCallback.current = onActivated;

  const changeModal = (next: ActivationModal) => {
    modalRef.current = next;
    setModal(next);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      claimRequest.current?.abort();
      activationRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    const identity = `${subscription?.stripeSubscriptionId}:${subscription?.plan}`;
    if (previousIdentity.current !== identity) {
      activationRequest.current?.abort();
      activationRequest.current = null;
      pending.current = false;
      setActivating(false);
      setError(null);
    }
    if (subscription?.status !== "trialing" || previousIdentity.current !== identity) {
      claimRequest.current?.abort();
      claimRequest.current = null;
      if (modalRef.current) changeModal(null);
    }
    previousIdentity.current = identity;
    if (previousStatus.current === "trialing" && subscription?.status === "active") {
      pending.current = false;
      setActivating(false);
      setError(null);
      // Preview cursors contain aliases. Discard infinite pages before any
      // active refetch so they cannot be replayed into the real roster API.
      void queryClient.resetQueries({ queryKey: ["tracking", "roster"] });
      // Includes inactive engagement/roster queries so their next mount cannot
      // reuse a preview result. Imperative page data refreshes separately.
      void queryClient.invalidateQueries();
      activatedCallback.current?.();
    } else if (activating && subscription?.status === "past_due") {
      pending.current = false;
      setActivating(false);
      paymentFailed();
    }
    previousStatus.current = subscription?.status;
  }, [subscription?.status, subscription?.stripeSubscriptionId, subscription?.plan, activating, queryClient]);

  useEffect(() => {
    if (!activating) return;
    const timer = window.setInterval(() => {
      void queryClient.refetchQueries({ queryKey: ["billing", "access"], exact: true, type: "active" });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [activating, queryClient]);

  const requestActivation = () => {
    if (pending.current || currentSubscription.current?.status !== "trialing" || modalRef.current) return;
    // A fresh user action supersedes a slow offer response from an earlier dismissal.
    claimRequest.current?.abort();
    claimRequest.current = null;
    setError(null);
    changeModal({ kind: "confirmation" });
  };

  const dismissConfirmation = async () => {
    if (pending.current || modalRef.current?.kind !== "confirmation") return;
    changeModal(null);
    const claimedSubscription = currentSubscription.current;
    const claimedPlan = claimedSubscription?.plan ? BILLING_PLANS[claimedSubscription.plan] : undefined;
    if (claimedSubscription?.status !== "trialing" || claimedPlan?.cadence !== "/month") return;
    const controller = new AbortController();
    claimRequest.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/api/billing/rescue-offer/claim", {
        method: "POST", credentials: "include", headers: csrfHeaders(undefined, "POST"), signal: controller.signal,
      });
      if (!response.ok) return;
      const offer = await response.json();
      const latest = currentSubscription.current;
      if (!mounted.current || controller.signal.aborted || claimRequest.current !== controller ||
          pending.current || modalRef.current || latest?.status !== "trialing" ||
          latest.stripeSubscriptionId !== claimedSubscription.stripeSubscriptionId || latest.plan !== claimedSubscription.plan) return;
      if (offer.eligible === true && typeof offer.offerId === "string" && offer.offerId &&
          offer.percentOff === 50 && offer.plan === claimedPlan.name) {
        changeModal({ kind: "rescue", offerId: offer.offerId });
      }
    } catch {
      // An optional rescue offer must not make dismissing confirmation fail.
    } finally {
      window.clearTimeout(timer);
      if (claimRequest.current === controller) claimRequest.current = null;
    }
  };

  const dismissRescue = () => {
    if (!pending.current && modalRef.current?.kind === "rescue") changeModal(null);
  };

  const activate = async (options?: { offerId: string }) => {
    if (pending.current || currentSubscription.current?.status !== "trialing") return;
    if (options && (modalRef.current?.kind !== "rescue" || modalRef.current.offerId !== options.offerId)) return;
    pending.current = true;
    claimRequest.current?.abort();
    claimRequest.current = null;
    // Programmatic confirmation closure must never run its cancellation handler.
    // Keep rescue open so a failed request can retry the same signed offer.
    if (!options) changeModal(null);
    setActivating(true);
    setError(null);
    const controller = new AbortController();
    activationRequest.current = controller;
    const requestedSubscription = currentSubscription.current;
    const isCurrentRequest = () => mounted.current && !controller.signal.aborted &&
      activationRequest.current === controller && currentSubscription.current?.status === "trialing" &&
      currentSubscription.current.stripeSubscriptionId === requestedSubscription?.stripeSubscriptionId &&
      currentSubscription.current.plan === requestedSubscription?.plan;
    try {
      const response = await fetch("/api/billing/activate-now", {
        method: "POST", credentials: "include",
        headers: csrfHeaders(options ? { "Content-Type": "application/json" } : undefined, "POST"),
        body: options ? JSON.stringify({ offerId: options.offerId }) : undefined,
        signal: controller.signal,
      });
      const result = await response.json();
      if (!isCurrentRequest()) return;
      if (result.status === "payment_failed") {
        pending.current = false;
        setActivating(false);
        paymentFailed();
      } else if (response.status === 409 && result.code === "already_active") {
        // Still wait for the authoritative local subscription, never unlock
        // data optimistically based on this mutation response.
      } else if (!response.ok || result.status !== "activating") {
        throw new Error(result.message || "Could not activate your subscription. Please try again.");
      }
      await queryClient.refetchQueries({ queryKey: ["billing", "access"], exact: true, type: "active" });
    } catch (failure) {
      if (!isCurrentRequest()) return;
      pending.current = false;
      setActivating(false);
      const message = failure instanceof Error ? failure.message : "Could not activate your subscription.";
      setError(message);
      toast({ variant: "destructive", title: "Activation could not complete", description: message });
    } finally {
      if (activationRequest.current === controller) activationRequest.current = null;
    }
  };

  return <TrialContext.Provider value={{ isPreview: subscription?.status === "trialing", activating,
    planName, error, requestActivation, activate }}>
    {children}
    <TrialActivateConfirmationModal open={modal?.kind === "confirmation"} planName={planName} priceLabel={plan?.priceLabel}
      cadence={plan?.cadence ?? "/month"} activating={activating} onActivate={() => void activate()} onDismiss={() => void dismissConfirmation()} />
    <TrialRescueOfferModal open={modal?.kind === "rescue"} planName={planName} priceLabel={plan?.priceLabel}
      activating={activating} error={error} onActivate={() => { if (modalRef.current?.kind === "rescue") void activate({ offerId: modalRef.current.offerId }); }}
      onDismiss={dismissRescue} />
  </TrialContext.Provider>;
}

export function useTrialActivation() {
  const context = useContext(TrialContext);
  if (!context) throw new Error("Trial activation requires TrialPreviewProvider");
  return context;
}
