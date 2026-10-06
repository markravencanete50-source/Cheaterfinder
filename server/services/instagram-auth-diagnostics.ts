/** Safe recovery metadata: never include upstream text, contact details or challenge URLs. */
export interface InstagramAuthDiagnostics {
  reason: "checkpoint_required" | "challenge_required" | "login_required"
    | "feedback_required" | "rate_limited" | "request_rejected" | "response_error";
  challengeKind: "native" | "bloks" | "legacy" | "captcha" | "selfie"
    | "suspended" | "manual_review" | "unknown" | null;
  codeMethod: "email" | "sms" | "totp" | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Inspect the complete envelope before truncating it for an error object. */
export function inspectInstagramAuthResponse(status: number, body: string): InstagramAuthDiagnostics | null {
  let data: Record<string, unknown> = {};
  try { data = record(JSON.parse(body)); } catch { /* An HTML block is not proof of expired credentials. */ }
  const challenge = record(data.challenge);
  const message = data.message ?? data.error_type;
  const base = { challengeKind: null, codeMethod: null } as const;
  if (status === 429) return { reason: "rate_limited", ...base };
  const checkpoint = message === "checkpoint_required" || message === "challenge_required"
    || Object.keys(challenge).length > 0;
  if (checkpoint) {
    const step = data.step_name ?? challenge.step_name;
    const action = data.bloks_action ?? challenge.bloks_action;
    const path = [data.checkpoint_url, challenge.url, challenge.api_path]
      .filter((value): value is string => typeof value === "string").join(" ");
    let challengeKind: InstagramAuthDiagnostics["challengeKind"] = "unknown";
    let codeMethod: InstagramAuthDiagnostics["codeMethod"] = null;
    if (/\/accounts\/(?:suspended|disabled)(?:\/|\?|$)/.test(path)) challengeKind = "suspended";
    else if (/captcha/i.test(String(step ?? "")) || /\/recaptcha(?:\/|\?|$)/.test(path)) challengeKind = "captcha";
    else if (step === "submit_selfie" || step === "selfie" || step === "selfie_captcha") challengeKind = "selfie";
    else if (step === "review_contact_point" || step === "review_submit_phone") challengeKind = "manual_review";
    else if (challenge.native_flow === true) challengeKind = "native";
    else if (action === "com.bloks.www.ig.challenge.redirect.async" || step === "STEP_NAME"
      || /\/auth_platform(?:\/|\?)/.test(path)) challengeKind = "bloks";
    else if (step === "verify_email") { challengeKind = "legacy"; codeMethod = "email"; }
    else if (step === "verify_sms") { challengeKind = "legacy"; codeMethod = "sms"; }
    else if (step === "verify_totp" || step === "totp") { challengeKind = "legacy"; codeMethod = "totp"; }
    else if (step === "select_verify_method" || step === "change_password") challengeKind = "legacy";
    return { reason: message === "checkpoint_required" ? "checkpoint_required" : "challenge_required", challengeKind, codeMethod };
  }
  if (message === "login_required") return { reason: "login_required", ...base };
  if (message === "feedback_required") return { reason: "feedback_required", ...base };
  if (status === 401 || status === 403) return { reason: "request_rejected", ...base };
  if (data.status === "fail") return { reason: "response_error", ...base };
  return null;
}
