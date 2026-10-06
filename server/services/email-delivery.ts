import { applicationEmailFrom } from "./email-config.js";
import { isResendConfigured } from "../integrations.js";

export class EmailDeliveryError extends Error {
  constructor(readonly code: string) { super("Email provider did not confirm acceptance"); this.name = "EmailDeliveryError"; }
}

/** A resolved SDK call can contain an error. Queue completion means provider
 * acceptance, NOT proof of inbox delivery. Stable keys protect job retries.
 */
export async function sendApplicationEmail(
  message: { to: string; subject: string; html: string; text?: string; from?: string },
  idempotencyKey?: string,
): Promise<string> {
  if (!isResendConfigured()) throw new EmailDeliveryError("not_configured");
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    resend.emails.send({ ...message, from: message.from ?? applicationEmailFrom() },
      idempotencyKey ? { idempotencyKey } : undefined),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new EmailDeliveryError("acceptance_timeout")), 20_000);
      timeout.unref();
    }),
  ]).finally(() => { if (timeout) clearTimeout(timeout); });
  if (result.error || !result.data?.id) throw new EmailDeliveryError(result.error?.name ?? "missing_confirmation");
  return result.data.id;
}
