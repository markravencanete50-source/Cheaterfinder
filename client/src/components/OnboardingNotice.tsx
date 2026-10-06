import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { csrfHeaders } from "@/lib/csrf";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type OnboardingUser = { id: string; role?: string; onboardingAcknowledgedAt?: string | null };
const userKey = ["auth", "onboarding"] as const;

/** Shown after subscription access is verified; acknowledgement follows the account. */
export function OnboardingNotice() {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const acknowledgement = useRef<AbortController | null>(null);
  useEffect(() => () => acknowledgement.current?.abort(), []);
  const { data: user } = useQuery<OnboardingUser | null>({
    queryKey: userKey,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/auth/me", { credentials: "include", signal });
      if (response.status === 401) return null;
      if (!response.ok) throw new Error("Could not check welcome preferences.");
      return response.json();
    },
    staleTime: 30_000,
    retry: 1,
  });

  const acknowledge = async () => {
    if (saving || !user) return;
    const controller = new AbortController();
    acknowledgement.current = controller;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/auth/onboarding-ack", {
        method: "POST", credentials: "include", headers: csrfHeaders(undefined, "POST"),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      const data = await response.json().catch(() => ({}));
      if (controller.signal.aborted) return;
      if (!response.ok || !data.acknowledgedAt) throw new Error(data.message ?? "Could not save this preference. Please try again.");
      queryClient.setQueryData<OnboardingUser>(userKey, { ...user, onboardingAcknowledgedAt: data.acknowledgedAt });
      setDismissed(true);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error && failure.name !== "TimeoutError"
        ? failure.message : "Could not save this preference. Please try again.");
    } finally { if (!controller.signal.aborted) setSaving(false); }
  };

  return (
    <Dialog open={!dismissed && user?.role !== "admin" && user?.onboardingAcknowledgedAt === null}
      onOpenChange={open => { if (!open && !saving) void acknowledge(); }}>
      <DialogContent data-testid="onboarding-notice" className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Welcome to your workspace</DialogTitle>
          <DialogDescription className="pt-3 leading-relaxed">
            Initial data collection can take a few days. New updates appear as they are observed.
            Private profiles require approval before collection can begin.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-relaxed text-slate-600">
          Add a profile to start tracking, then check its collection status for progress.
          This does not change your trial or billing dates.
        </p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <Button data-testid="onboarding-ack" onClick={acknowledge} disabled={saving} className="h-auto min-h-11 whitespace-normal">
          {saving ? "Saving…" : "Got it — start exploring"}
        </Button>
        {error && <Button variant="outline" onClick={() => setDismissed(true)} disabled={saving}>
          Continue for now
        </Button>}
      </DialogContent>
    </Dialog>
  );
}
