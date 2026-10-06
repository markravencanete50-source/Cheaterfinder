import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { hasSubscriptionAccess, type SubscriptionAccess } from "@shared/billing-plans";
import { OnboardingNotice } from "@/components/OnboardingNotice";
import { authPath } from "@shared/auth-return";

export function PaidAccess({ children }: { children: ReactNode }) {
  const [, navigate] = useLocation();
  const access = useQuery({
    queryKey: ["billing", "access"], staleTime: 0, refetchInterval: 15_000,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/billing/subscription", { credentials: "include", signal });
      if (response.status === 401) return { signedIn: false, subscription: null };
      if (!response.ok) throw new Error("Could not check subscription access.");
      return { signedIn: true, subscription: await response.json() as SubscriptionAccess | null };
    }, retry: 1,
  });
  const allowed = hasSubscriptionAccess(access.data?.subscription);
  useEffect(() => {
    if (!access.data) return;
    if (!access.data.signedIn) navigate(authPath(window.location.pathname + window.location.search));
    else if (!allowed) navigate("/payment");
  }, [access.data, allowed, navigate]);
  if (access.isError) return <div className="min-h-screen flex flex-col items-center justify-center gap-4"><p>Could not check your subscription.</p><button onClick={() => access.refetch()}>Try again</button></div>;
  if (!allowed) return <div className="min-h-screen flex items-center justify-center">Checking access…</div>;
  return <>{children}<OnboardingNotice /></>;
}
