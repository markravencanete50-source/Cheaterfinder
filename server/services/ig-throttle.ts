/** Instagram's localized soft-throttle envelope, not proof of session expiry. */
export function isIgWebThrottleBody(body: string): boolean {
  if (!body) return false;
  const normalized = body.toLowerCase();
  return normalized.includes("igweb_rollout") && normalized.includes("require_login");
}
