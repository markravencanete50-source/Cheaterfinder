import { IGHttpError } from "../ig-http-client.js";

/**
 * Is this error Instagram flagging THE BOT (checkpoint / challenge), as opposed
 * to a flaky request? The HTTP client throws `IGHttpError` whose *message* is the
 * generic "GET friendship_status failed with status 400" — the IG-side reason
 * lives in `igErrorCode`, so a message regex alone never matched it (the first
 * version of the squad guard was dead code for exactly that reason). Check the
 * typed field first; keep the message match as a fallback for wrapped errors.
 */
export function isCheckpointError(err: unknown): boolean {
  if (err instanceof IGHttpError) {
    if (err.igErrorCode === "checkpoint_required") return true;
    if (err.igErrorCode === "challenge_required") return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /checkpoint_required|challenge_required/i.test(message);
}
