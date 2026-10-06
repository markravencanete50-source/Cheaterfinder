import type Stripe from "stripe";

/** Current Billing API: invoice.payment_intent was replaced by InvoicePayment.
 * Expand payments.data.payment.payment_intent; never infer bank authorization
 * from a delayed event name or from an invoice merely remaining open.
 * https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices
 */
export function currentInvoiceAttention(invoice: Stripe.Invoice): "action_required" | "payment_failed" | null {
  if (invoice.status!=="open" || !(invoice.amount_remaining>0) || !invoice.payments || invoice.payments.has_more) return null;
  const defaults=invoice.payments.data.filter(payment=>payment.is_default && payment.status==="open");
  if (defaults.length!==1) return null;
  const payment=defaults[0], linked=typeof payment.invoice==="string"?payment.invoice:payment.invoice.id;
  const intent=payment.payment.type==="payment_intent"?payment.payment.payment_intent:null;
  if (linked!==invoice.id || !intent || typeof intent==="string") return null;
  const owner=typeof invoice.customer==="string"?invoice.customer:invoice.customer?.id;
  const customer=typeof intent.customer==="string"?intent.customer:intent.customer?.id;
  if (!owner || customer!==owner) return null;
  if (intent.status==="requires_action") return "action_required";
  if (intent.status==="requires_payment_method") return "payment_failed";
  return null;
}
