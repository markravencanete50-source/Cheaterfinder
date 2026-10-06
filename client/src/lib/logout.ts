import { csrfHeaders } from "@/lib/csrf";
import { queryClient } from "@/lib/queryClient";
import { productAnalytics } from "@/lib/analytics";

/**
 * End the session AND drop every cached query.
 *
 * React Query's cache lives for the life of the tab and is never keyed by
 * user. Without this, logging out and back in as someone else served the
 * previous user's cached payloads (viewer data, rosters, reports) until each
 * key happened to refetch — including another user's liked posts. Clearing
 * here is the only place that reliably runs on every sign-out path.
 */
export async function logoutAndClearCache(): Promise<void> {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: csrfHeaders(undefined, "POST"),
    });
  } finally {
    productAnalytics.resetIdentity();
    queryClient.clear();
  }
}
