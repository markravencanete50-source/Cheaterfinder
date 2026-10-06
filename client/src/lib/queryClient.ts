import { QueryClient, QueryFunction } from "@tanstack/react-query";
import {
  CSRF_HEADER_NAME,
  getCsrfToken,
  isUnsafeMethod,
} from "./csrf";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

/**
 * Extract the HTTP status code from a thrown query error.
 *
 * The fetchers in this file throw `new Error(`${status}: ${text}`)`, so the
 * status is the leading integer before the first colon. Returns null when the
 * error is not a status-prefixed `Error` (e.g. a network failure where `fetch`
 * itself rejects with a `TypeError`).
 */
function getErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const match = /^(\d{3}):/.exec(error.message);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

// Client-error statuses that must never be retried: retrying an auth,
// permission, or not-found failure cannot succeed and only wastes requests.
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

const MAX_QUERY_RETRIES = 2;

/**
 * Bounded retry policy for queries.
 *
 * - Never retries non-retryable client errors (401/403/404, etc.).
 * - Retries other failures (5xx, 408/429, and network errors where status is
 *   unknown) up to `MAX_QUERY_RETRIES` times.
 */
function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) {
    return false;
  }
  const status = getErrorStatus(error);
  if (status !== null && NON_RETRYABLE_STATUSES.has(status)) {
    return false;
  }
  return true;
}

// Exponential backoff with a 30s ceiling: 1s, 2s, 4s, ... capped at 30s.
function queryRetryDelay(attemptIndex: number): number {
  return Math.min(1000 * 2 ** attemptIndex, 30_000);
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    "X-Requested-With": "XMLHttpRequest",
  };
  if (data) {
    headers["Content-Type"] = "application/json";
  }
  if (isUnsafeMethod(method)) {
    const token = getCsrfToken();
    if (token) {
      headers[CSRF_HEADER_NAME] = token;
    }
  }
  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      // staleTime is intentionally left at Infinity: queries refresh via
      // explicit invalidation (see Dashboard.tsx invalidateQueries) and on
      // mount, not on a timer. Lowering it would change refetch behavior that
      // existing manual-invalidation flows rely on.
      staleTime: Infinity,
      // Bounded retries for transient failures (5xx / network), but never for
      // auth, permission, or not-found errors. See shouldRetryQuery.
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
    },
    mutations: {
      // Mutations stay non-retrying: they are often non-idempotent, so a blind
      // retry could double-apply a side effect.
      retry: false,
    },
  },
});
