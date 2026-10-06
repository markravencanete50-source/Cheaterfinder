/** Shared account emails with escaped HTML, plain text and first-party links. */
export type ApplicationEmail = { subject: string; html: string; text: string };
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

import { emailAppUrl } from "./email-config.js";
export { emailAppUrl } from "./email-config.js";

function compose(args: {
  subject: string; title: string; name: string; intro: string; action: string; path: string;
  details?: Array<[string, string]>; note?: string; secondary?: { label: string; url: string };
  preference?: boolean;
}): ApplicationEmail {
  const url = emailAppUrl(args.path), settings = emailAppUrl("/settings");
  const details = args.details ?? [];
  const footer = args.preference
    ? `You can change report emails in <a href="${escape(settings)}" style="color:#6366f1">notification settings</a>.`
    : "This is an account email from CheaterFinder.";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(args.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f8;color:#1e293b;font-family:Arial,Helvetica,sans-serif;overflow-wrap:anywhere;word-break:break-word">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(args.intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #e2e8f0;border-radius:18px"><tr><td style="height:6px;background:#6366f1;border-radius:18px 18px 0 0"></td></tr><tr><td style="padding:32px">
<a href="${escape(emailAppUrl("/"))}" style="color:#6366f1;text-decoration:none;font-size:24px;font-weight:bold">CheaterFinder</a>
<h1 style="font-size:28px;line-height:1.3;margin:24px 0">${escape(args.title)}</h1>
<p style="color:#475569;line-height:1.7">Hi ${escape(args.name)},</p>
<p style="color:#475569;line-height:1.7">${escape(args.intro)}</p>
${details.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;table-layout:fixed">${details.map(([label, value]) => `<tr><td style="width:46%;overflow-wrap:anywhere;word-break:break-word;padding:12px 8px 12px 0;border-bottom:1px solid #e2e8f0;color:#475569">${escape(label)}</td><td align="right" style="width:54%;overflow-wrap:anywhere;word-break:break-word;padding:12px 0 12px 8px;border-bottom:1px solid #e2e8f0;font-weight:bold">${escape(value)}</td></tr>`).join("")}</table>` : ""}
<a href="${escape(url)}" style="display:inline-block;background:#6366f1;color:white;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">${escape(args.action)}</a>
${args.note ? `<p style="color:#64748b;font-size:14px;line-height:1.7">${escape(args.note)}</p>` : ""}
${args.secondary ? `<p><a href="${escape(args.secondary.url)}" style="color:#6366f1">${escape(args.secondary.label)}</a></p>` : ""}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
<p style="font-size:13px;color:#64748b;line-height:1.7">${footer}</p>
<p style="font-size:12px;color:#64748b">CheaterFinder — Instagram Activity Tracking</p>
<p style="font-size:13px"><a href="${escape(emailAppUrl("/privacy"))}" style="color:#6366f1">Privacy</a> · <a href="${escape(emailAppUrl("/terms"))}" style="color:#6366f1">Terms</a></p>
</td></tr></table></td></tr></table></body></html>`;
  const text = ["CheaterFinder", args.title, `Hi ${args.name},`, args.intro,
    ...details.map(([label, value]) => `${label}: ${value}`), `${args.action}: ${url}`, args.note,
    args.secondary ? `${args.secondary.label}: ${args.secondary.url}` : null,
    args.preference ? `Notification settings: ${settings}` : "This is an account email from CheaterFinder.",
  ].filter(Boolean).join("\n\n");
  return { subject: args.subject, html, text };
}

export function welcomeEmail(name: string): ApplicationEmail {
  return compose({subject:"Welcome to CheaterFinder", title:"Make yourself at home.", name,
    intro:"Your account is ready. Choose your membership, then add an Instagram profile to get started.",
    action:"Open your account", path:"/members",
    note:"Creating an account does not start a paid membership. Your plan, trial eligibility and renewal details are confirmed in Stripe Checkout."});
}

export function passwordResetEmail(name: string, token: string): ApplicationEmail {
  const encoded = encodeURIComponent(token);
  return compose({subject:"Reset your CheaterFinder password",title:"A fresh start.",name,
    intro:"Use the button below to choose a new password for your account.",action:"Choose a new password",path:`/reset-password?token=${encoded}`,
    note:"This link expires in 1 hour and works once. If you did not request a reset, you can ignore this email. Your password has not changed.",
    secondary:{label:"Open in the companion app",url:emailAppUrl(`/app/reset-password?token=${encoded}`)}});
}

export type BillingEmailState = {
  stripeSubscriptionId: string; status: string; plan: string | null;
  currentPeriodEnd: string | null; trialEndsAt: string | null; cancelAtPeriodEnd: boolean;
  trialPayment?: {
    amount: number; currency: string; creditStatus: "credited" | "refunded" | "pending";
    cancellationPolicy: "refund_during_trial" | "retain_credit";
  };
};
const dateLabel = (date: string | null) => date ? new Intl.DateTimeFormat("en-GB", {day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(date)) : "See billing details";
export function subscriptionEmail(name: string, state: BillingEmailState): ApplicationEmail {
  const plan = ({starter:"Starter",standard:"Standard",pro:"Pro",weekly:"Weekly",monthly:"Monthly"} as Record<string,string>)[state.plan ?? ""] ?? "Membership";
  let title = "Your membership is active.", intro = "Your membership has been confirmed. Open your workspace to manage the profiles you track.", action = "Open your workspace", path = "/members";
  let details: Array<[string,string]> = [["Plan",plan],["Next renewal",dateLabel(state.currentPeriodEnd)]];
  let note = "Your membership renews automatically unless you cancel. Review the exact amount, taxes and billing interval in your billing settings.";
  if(state.status === "canceled") {
    title="Your membership has ended.";intro="Automatic renewal has stopped. You can review your account and available plans whenever you are ready.";
    details=[["Plan",plan],["Membership","Ended"]];note="No new renewal is scheduled for this subscription. Existing invoices and receipts remain available in billing.";action="Review your account";path="/settings?tab=billing";
  } else if(state.cancelAtPeriodEnd) {
    title="Renewal is switched off.";
    intro=state.status === "past_due" ? "Your cancellation is confirmed. Automatic renewal has stopped; any outstanding invoice remains available in billing." : "Your cancellation is confirmed. Your membership remains available until the date below.";
    details=[["Plan",plan], state.status === "past_due" ? ["Automatic renewal","Off"] : ["Access until (UTC)",dateLabel(state.status === "trialing" ? state.trialEndsAt : state.currentPeriodEnd)]];
    note="This subscription will not renew. Review your current access, invoices and cancellation details in billing.";action="Manage membership";path="/settings?tab=billing";
  } else if(state.status === "past_due") {
    title="Your billing needs attention.";intro="Your membership is not currently active. Review your payment details in billing to restore access.";
    details=[["Plan",plan],["Membership","Action required"]];note="Check your invoice and payment method for the current amount and next steps.";action="Review billing";path="/settings?tab=billing";
  } else if(state.status === "trialing") {
    title="Your trial starts here.";intro="Your trial membership is confirmed. You can now add a profile and explore your workspace.";
    details=[["Plan",plan],["Subscription renewal","Starts after your trial"],["Trial ends (UTC)",dateLabel(state.trialEndsAt)]];
    note="Your paid membership starts automatically when the trial ends, at the price and interval shown in Stripe Checkout. Cancel in billing before the trial ends to avoid the renewal charge.";
  }
  if (state.trialPayment) {
    const payment = state.trialPayment;
    if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0 || payment.currency !== "usd" ||
      !["credited", "refunded", "pending"].includes(payment.creditStatus) ||
      !["refund_during_trial", "retain_credit"].includes(payment.cancellationPolicy)) throw new Error("Invalid advance payment state");
    const amount = new Intl.NumberFormat("en", { style: "currency", currency: payment.currency }).format(payment.amount / 100);
    if (payment.creditStatus === "credited") {
      details.push(["Advance payment", amount], ["Invoice credit", `${amount} issued once`]);
      note += " The advance was added as credit toward your next invoice. It may already have been applied; billing shows the current balance and invoice amounts.";
      if (state.status === "trialing" && !state.cancelAtPeriodEnd) {
        note += payment.cancellationPolicy === "refund_during_trial"
          ? " If you cancel before your trial expires, access ends immediately and the unused advance is refunded under your checkout terms."
          : " If you cancel, any unused advance remains as invoice credit and is not automatically refunded.";
      }
    } else if (payment.creditStatus === "refunded") {
      details.push(["Advance refund", `${amount} confirmed`]);
      note += " The refunded advance is no longer available as invoice credit. Your payment provider determines when the refund appears on your statement.";
    } else {
      details.push(["Advance payment and credit", "Confirmation pending — review billing"]);
      if (state.status === "trialing" && !state.cancelAtPeriodEnd) {
        title = "Your payment is still processing.";
        intro = "We are confirming your upfront payment and invoice credit. Review billing before trying another payment.";
        action = "Review billing"; path = "/settings?tab=billing";
      }
    }
  }
  return compose({subject:`CheaterFinder — ${title}`,title,name,intro,action,path,details,note});
}

export function reportReadyEmail(args: {name:string;username:string;period:"weekly"|"monthly";netFollowerChange:number|null;observedLikes:number;peakHour?:string|null;periodStart?:string;periodEnd?:string}): ApplicationEmail {
  const span = args.period === "monthly" ? "month" : "week";
  const details: Array<[string,string]> = [["Profile",`@${args.username}`],["Net follower change",args.netFollowerChange == null ? "Unavailable" : `${args.netFollowerChange>0?"+":""}${args.netFollowerChange}`],["Observed likes",String(args.observedLikes)]];
  if(args.periodStart && args.periodEnd)details.push(["Reporting window (UTC)",`${dateLabel(args.periodStart)} – ${dateLabel(args.periodEnd)}`]);
  if(args.peakHour)details.push(["Most active around",args.peakHour]);
  return compose({subject:`Your ${args.period} report for @${args.username}`,title:"Your report is ready.",name:args.name,
    intro:`Here is the activity recorded for @${args.username} ${args.periodStart ? "during the reporting window below" : `this ${span}`}. Open your report for the full breakdown and downloads.`,
    action:"Read your report",path:"/reports",details,preference:true,
    note:"Reports show activity we could observe during the reporting period. Unavailable data does not mean there was no activity."});
}


export function trialEndingEmail(name: string, trialEndsAt: string): ApplicationEmail {
  return compose({ subject: "Your CheaterFinder trial ends soon", title: "Your trial is ending soon.", name,
    intro: "Your membership will renew automatically when your trial ends. Review your plan, payment method and next invoice before then.",
    action: "Review your membership", path: "/settings?tab=billing", details: [["Trial ends (UTC)", dateLabel(trialEndsAt)]],
    note: "The exact amount and billing interval are shown in billing. You can cancel before the trial ends to stop the renewal charge." });
}

export function invoiceAttentionEmail(name: string, actionRequired: boolean): ApplicationEmail {
  return compose({ subject: actionRequired ? "Authorize your CheaterFinder payment" : "Your CheaterFinder payment needs attention",
    title: actionRequired ? "Your bank needs your approval." : "Your payment did not complete.", name,
    intro: actionRequired ? "Your bank requires an additional authorization step for your latest subscription invoice. Open billing to review the invoice and complete the required steps."
      : "We could not confirm payment for your latest subscription invoice. Open billing to review the invoice and update your payment details.",
    action: actionRequired ? "Review payment authorization" : "Review your payment", path: "/settings?tab=billing",
    note: "Your invoice shows the current amount and available next steps. Updating your details does not by itself confirm payment; your membership updates when payment is confirmed." });
}

export function retentionConfirmedEmail(name: string, offer: { amount: number; regularAmount: number; recurringAmount?: number; creditApplied?: number; currency: string; trial: boolean }): ApplicationEmail {
  const formatter = new Intl.NumberFormat("en", { style: "currency", currency: offer.currency });
  const decimals = formatter.resolvedOptions().maximumFractionDigits;
  if (typeof decimals !== "number") throw new Error("Currency precision unavailable");
  const divisor = 10 ** decimals;
  return compose({ subject: "Your CheaterFinder one-time offer is confirmed", title: "Your next monthly payment has an offer.", name,
    intro: `Your one-time 50% subscription discount is confirmed for ${offer.trial ? "your first paid month after the trial" : "your next monthly subscription payment"}. Your billing date is unchanged.`,
    action: "Review your next invoice", path: "/settings?tab=billing",
    details: [["Estimated next monthly invoice", formatter.format(offer.amount / divisor)], ["Estimated regular monthly invoice", formatter.format((offer.recurringAmount ?? offer.regularAmount) / divisor)],
      ...(offer.creditApplied ? [["Balance credit in estimate", formatter.format(offer.creditApplied / divisor)] as [string, string]] : []), ["Offer duration", "One monthly payment"]],
    note: "The one-time discount then ends and your existing recurring discounts remain in place. Taxes or later billing changes can affect the final invoice. You can still cancel in billing." });
}
