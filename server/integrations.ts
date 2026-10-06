// ─── Integration status + assertions ─────────────────────────────────────────
//
// Wave 5 task A: a single source of truth for "is integration X configured?".
//
// Three external integrations are optional features in dev / staging:
//
//   • Stripe   (STRIPE_SECRET_KEY) — billing checkout + portal + cancel.
//   • Resend   (RESEND_API_KEY)    — transactional email (password reset, alerts).
//   • Smartproxy (SMARTPROXY_API_URL) — residential proxy provider for bots.
//
// Previously the same placeholder check was duplicated in 4 sites with subtly
// different rules. This module collapses them into a small typed API:
//
//   getIntegrationStatus()        — non-throwing snapshot for boot-time logging
//                                   and admin status pages.
//   assertStripeConfigured()      — throw IntegrationMissingError if Stripe
//   assertResendConfigured()      — throw IntegrationMissingError if Resend
//
// The server intentionally does NOT crash when integrations are missing — these
// are optional features. Callers that hit them route around the failure
// gracefully (Stripe checkout returns 503 + json message; email worker mocks).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Possible states of any third-party integration.
 *
 * - `live`        — env var set to a non-placeholder, non-test value (e.g. sk_live_*)
 * - `test`        — env var set to a real provider TEST key (e.g. sk_test_X) but NOT a
 *                   placeholder. Stripe is the only integration that distinguishes this.
 * - `placeholder` — env var holds a known sentinel like `sk_test_placeholder` /
 *                   `re_placeholder` / `<your-key-here>` from the seeded `.env`.
 *                   The integration is intentionally disabled.
 * - `missing`     — env var is unset entirely.
 */
export type IntegrationStatus = "live" | "test" | "placeholder" | "missing";

export interface IntegrationStatusSnapshot {
  stripe: IntegrationStatus;
  resend: IntegrationStatus;
  smartproxy: IntegrationStatus;
}

/**
 * Thrown by `assertStripeConfigured` / `assertResendConfigured` when the caller
 * tries to use an integration whose env var is unset or holds a placeholder.
 *
 * Routes catch this and translate it to `503 { error: "Billing not configured" }`
 * (or equivalent). It's a typed error so we can `instanceof`-check without
 * matching on string messages.
 */
export class IntegrationMissingError extends Error {
  public readonly integration: "stripe" | "resend" | "smartproxy";
  public readonly status: IntegrationStatus;

  constructor(
    integration: "stripe" | "resend" | "smartproxy",
    status: IntegrationStatus,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationMissingError";
    this.integration = integration;
    this.status = status;
  }
}

// ─── Per-integration classification helpers ──────────────────────────────────

const STRIPE_PLACEHOLDER_PREFIXES = ["sk_placeholder", "sk_test_placeholder"];
const STRIPE_PLACEHOLDER_LITERALS = new Set([
  "your_stripe_secret_key_here",
  "sk_test_your_key_here",
]);

function classifyStripe(value: string | undefined): IntegrationStatus {
  if (!value || value.length === 0) return "missing";
  if (STRIPE_PLACEHOLDER_LITERALS.has(value)) return "placeholder";
  if (STRIPE_PLACEHOLDER_PREFIXES.some((p) => value.startsWith(p))) {
    return "placeholder";
  }
  if (/^(sk|rk)_live_/.test(value)) return "live";
  if (/^(sk|rk)_test_/.test(value)) return "test";
  // Anything else is treated as live — we don't want to silently disable a
  // production key just because the prefix changed in some future Stripe
  // rotation.
  return "live";
}

const RESEND_PLACEHOLDER_PREFIXES = ["re_placeholder"];
const RESEND_PLACEHOLDER_LITERALS = new Set(["re_your_api_key_here"]);

function classifyResend(value: string | undefined): IntegrationStatus {
  if (!value || value.length === 0) return "missing";
  if (RESEND_PLACEHOLDER_LITERALS.has(value)) return "placeholder";
  if (RESEND_PLACEHOLDER_PREFIXES.some((p) => value.startsWith(p))) {
    return "placeholder";
  }
  // Resend uses a single live key prefix; treat anything non-placeholder as live.
  return "live";
}

function classifySmartproxy(value: string | undefined): IntegrationStatus {
  if (
    process.env.STATIC_PROXY_HOST &&
    process.env.STATIC_PROXY_PORT_START &&
    process.env.STATIC_PROXY_PORT_END &&
    process.env.STATIC_PROXY_USERNAME &&
    process.env.STATIC_PROXY_PASSWORD
  ) {
    return "live";
  }
  if (!value || value.length === 0) return "missing";
  if (value.includes("<your-key-here>")) return "placeholder";
  // The provider URL must contain `app_key=` for the sticky-port API to work.
  // If it's set but the auth param is missing we treat it as placeholder so
  // operators see a clear signal in the boot log.
  if (!value.includes("app_key=")) return "placeholder";
  return "live";
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Read all three integration env vars and return their classified status.
 * Pure / non-throwing — safe to call on every request or at boot.
 */
export function getIntegrationStatus(): IntegrationStatusSnapshot {
  return {
    stripe: classifyStripe(process.env.STRIPE_SECRET_KEY),
    resend: classifyResend(process.env.RESEND_API_KEY),
    smartproxy: classifySmartproxy(process.env.SMARTPROXY_API_URL),
  };
}

/**
 * Convenience: true when Stripe is callable (`live` or `test`). `test` is
 * still callable — Stripe's test mode is a real network call to api.stripe.com,
 * just against the sandbox.
 */
export function isStripeConfigured(): boolean {
  const s = classifyStripe(process.env.STRIPE_SECRET_KEY);
  return s === "live" || s === "test";
}

/** Convenience: true when Resend is callable. */
export function isResendConfigured(): boolean {
  return classifyResend(process.env.RESEND_API_KEY) === "live";
}

/** Convenience: true when Smartproxy URL is callable. */
export function isSmartproxyConfigured(): boolean {
  return classifySmartproxy(process.env.SMARTPROXY_API_URL) === "live";
}

/**
 * Throw `IntegrationMissingError` if Stripe is not callable. Routes call this
 * at the top of billing handlers and catch the error to return a 503 response.
 */
export function assertStripeConfigured(): void {
  const status = classifyStripe(process.env.STRIPE_SECRET_KEY);
  if (status === "live" || status === "test") return;
  throw new IntegrationMissingError(
    "stripe",
    status,
    status === "missing"
      ? "STRIPE_SECRET_KEY is not set; set STRIPE_SECRET_KEY=sk_live_... to enable billing"
      : "STRIPE_SECRET_KEY is a placeholder; set STRIPE_SECRET_KEY=sk_live_... to enable billing",
  );
}

/**
 * Throw `IntegrationMissingError` if Resend is not callable. Email senders
 * call this and fall back to logging the message body locally on failure.
 */
export function assertResendConfigured(): void {
  const status = classifyResend(process.env.RESEND_API_KEY);
  if (status === "live") return;
  throw new IntegrationMissingError(
    "resend",
    status,
    status === "missing"
      ? "RESEND_API_KEY is not set; set RESEND_API_KEY=re_... to enable transactional email"
      : "RESEND_API_KEY is a placeholder; set RESEND_API_KEY=re_... to enable transactional email",
  );
}

/**
 * Format the status snapshot as a single boot-time log line. Keeping the
 * format here (instead of inline in `index.ts`) means tests can pin the
 * exact serialization.
 */
export function formatIntegrationStatusLine(
  snapshot: IntegrationStatusSnapshot,
): string {
  return `integrations: stripe=${snapshot.stripe} resend=${snapshot.resend} smartproxy=${snapshot.smartproxy}`;
}
