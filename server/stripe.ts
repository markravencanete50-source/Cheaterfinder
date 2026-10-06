import { chooseCurrentSubscription } from "./services/stripe-webhook-safety.js";
import { withOperationLease } from "./services/operation-lease.js";
import { recordSubscriptionEmail } from "./services/transactional-emails.js";
import Stripe from "stripe";
import { randomBytes } from "node:crypto";
import { checkoutOffer, requireCurrentCheckoutOffer, verifyTrialPaymentConfiguration, checkoutTrialDisclosure } from "./services/trial-payment-offer.js";
import { TRIAL_PAYMENT_POLICY, type CheckoutOffer } from "../shared/trial-payment.js";
import { reconcileTrialPaymentCredit, reconcileTrialPaymentCancellation } from "./services/trial-payment-credit.js";
import { readTrialPaymentSummary, pendingTrialPaymentSummary } from "./services/trial-payment-state.js";
import { activationPaymentVerified, TRIAL_ACTIVATION_POLICY } from "./services/billing-activation.js";
import { db } from "./db.js";
import { operationSignal } from "./services/operation-lease.js";
import {
  subscriptions,
  trackedAccounts,
  users,
} from "../shared/schema.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { isStripeConfigured } from "./integrations.js";
import { linkedStripeCustomer, requireBillingUser, saveStripeCustomerLink, withCustomerBillingLock, type BillingDatabase } from "./services/customer-billing-lifecycle.js";
import {
  BILLING_PLANS,
  hasSubscriptionAccess,
  accountLimitForSubscription,
  isSubscriptionPlan,
  type CheckoutPlan,
  type SubscriptionPlan,
} from "../shared/billing-plans.js";

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripeReady = isStripeConfigured();

if (!stripeReady) {
  console.warn("[stripe] STRIPE_SECRET_KEY not set — Stripe features disabled");
}

export const stripe = stripeReady && stripeKey
  ? new Stripe(stripeKey, { apiVersion: "2026-03-25.dahlia" })
  : null;

const PLAN_PRICE_IDS: Record<SubscriptionPlan, string> = {
  starter: process.env.STRIPE_STARTER_PRICE_ID ?? "",
  standard: process.env.STRIPE_STANDARD_PRICE_ID ?? "",
  pro: process.env.STRIPE_PRO_PRICE_ID ?? "",
  weekly: process.env.STRIPE_WEEKLY_PRICE_ID ?? "",
  monthly: process.env.STRIPE_MONTHLY_PRICE_ID ?? "",
};

// Founders-discount coupon per checkout plan (forever duration). Applied at
// checkout so Stripe renders the strike-through + "FOUNDERS −$X" on the anchor
// price. Empty → no discount applied (the plan checks out at the anchor price).
// Rename the discount for a season by editing the coupon `name` in Stripe;
// pull it entirely by clearing these env vars.
const PLAN_FOUNDER_COUPONS: Record<CheckoutPlan, string> = {
  starter: process.env.STRIPE_FOUNDERS_COUPON_STARTER ?? "",
  standard: process.env.STRIPE_FOUNDERS_COUPON_STANDARD ?? "",
  pro: process.env.STRIPE_FOUNDERS_COUPON_PRO ?? "",
};

function founderCouponFor(plan: CheckoutPlan): string | null {
  const coupon = PLAN_FOUNDER_COUPONS[plan];
  return coupon && coupon.trim().length > 0 ? coupon.trim() : null;
}

export class StripeConfigurationError extends Error {
  constructor(public readonly publicMessage: string) {
    super(publicMessage);
    this.name = "StripeConfigurationError";
  }
}

export class ExistingSubscriptionError extends Error {
  constructor() {
    super("This account already has a subscription");
    this.name = "ExistingSubscriptionError";
  }
}

export class CheckoutSessionOwnershipError extends Error {
  constructor() {
    super("Checkout session does not belong to this account");
    this.name = "CheckoutSessionOwnershipError";
  }
}

function configuredPriceId(plan: CheckoutPlan): string {
  const priceId = PLAN_PRICE_IDS[plan];
  if (!priceId || !priceId.startsWith("price_") || priceId.includes("plan_id")) {
    throw new StripeConfigurationError(
      `The ${plan} Stripe price is not configured yet.`,
    );
  }
  return priceId;
}

function appUrl(): string {
  const raw = process.env.APP_URL ?? "http://localhost:5000";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StripeConfigurationError(
      "APP_URL must be a valid absolute URL before billing can start.",
    );
  }
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new StripeConfigurationError(
      "APP_URL must use HTTPS in production before billing can start.",
    );
  }
  return parsed.toString().replace(/\/$/u, "");
}

/** Which client started checkout; selects the post-checkout redirect pair. */
export type CheckoutClient = "web" | "mobile";

/**
 * Post-checkout redirects.
 *
 * Stripe requires an http(s) `success_url`, so a native app cannot be sent a
 * custom scheme directly. Mobile therefore returns to `/billing/return`, which
 * 302s to the app scheme — the standard hop, and the only thing that lets
 * `WebBrowser.openAuthSessionAsync` observe the redirect and hand control back.
 */
function checkoutRedirects(
  baseUrl: string,
  client: CheckoutClient,
): { success_url: string; cancel_url: string } {
  if (client === "mobile") {
    return {
      success_url:
        `${baseUrl}/billing/return?checkout=success` +
        "&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: `${baseUrl}/billing/return?checkout=cancelled`,
    };
  }
  return {
    success_url:
      `${baseUrl}/settings?tab=billing&checkout=success` +
      "&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: `${baseUrl}/payment?checkout=cancelled`,
  };
}

export async function createCheckoutSession(
  userId: string,
  email: string,
  plan: CheckoutPlan,
  client: CheckoutClient = "web",
  igUsername?: string,
  acceptedOfferVersion?: string,
): Promise<Stripe.Checkout.Session> {
  return withCustomerBillingLock(userId, async billingDb => {
    // Authentication may have loaded before a concurrent deletion completed.
    const currentUser = await requireBillingUser(userId, billingDb);
    return createCheckoutSessionLocked(userId, currentUser.email, plan, client, billingDb, igUsername, acceptedOfferVersion);
  });
}

export async function getCheckoutEligibility(userId: string, plan: CheckoutPlan) {
  const [user] = await db.select({ usedAt: users.trialUsedAt }).from(users).where(eq(users.id, userId)).limit(1);
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  let trialEligible: boolean = !!user && !user.usedAt && !sub;
  const customerId = await linkedStripeCustomer(userId);
  if (customerId && stripe && (!sub || (sub.trialPaymentPolicy === TRIAL_PAYMENT_POLICY && sub.status === "past_due"))) {
    const resumable = await resumableTrialCheckout(userId, customerId, plan);
    if (resumable) return { trialEligible: true, hasAccess: false, offer: resumable.offer };
  }
  if (trialEligible && customerId && stripe) {
    const history = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    if (history.has_more) throw new StripeConfigurationError("Billing history needs reconciliation. Please contact support.");
    trialEligible = !history.data.some(remote => remote.trial_start != null || remote.trial_end != null || !["canceled", "incomplete_expired"].includes(remote.status));
  }
  return { trialEligible, hasAccess: hasSubscriptionAccess(sub), offer: checkoutOffer(plan, trialEligible) };
}

/** Resume the original payment attempt without creating a second subscription
 * or silently replacing a 99-cent offer with a full-price checkout.
 */
async function resumableTrialCheckout(userId: string, customerId: string, plan: CheckoutPlan,
  client?: CheckoutClient, target?: string): Promise<{ session: Stripe.Checkout.Session; offer: CheckoutOffer } | null> {
  if (!stripe) return null;
  const history = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
  if (history.has_more) throw new StripeConfigurationError("Billing history needs reconciliation. Please contact support.");
  const current = history.data.filter(sub => !["canceled", "incomplete_expired"].includes(sub.status));
  if (current.length !== 1 || !["incomplete", "trialing"].includes(current[0].status) || current[0].metadata?.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY || current[0].metadata.userId !== userId) return null;
  const subscriptionCustomer = typeof current[0].customer === "string" ? current[0].customer : current[0].customer?.id;
  if (subscriptionCustomer !== customerId) throw new CheckoutSessionOwnershipError();
  const sessions = await stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 100 });
  if (sessions.has_more) throw new StripeConfigurationError("Too many open checkouts. Please contact support.");
  const session = sessions.data.find(candidate => {
    const subId = typeof candidate.subscription === "string" ? candidate.subscription : candidate.subscription?.id;
    return subId === current[0].id && candidate.metadata?.userId === userId && candidate.metadata.plan === plan &&
      candidate.metadata.trialPaymentPolicy === TRIAL_PAYMENT_POLICY && (!client || candidate.metadata.client === client) &&
      (target == null || (candidate.metadata.igUsername ?? "") === target);
  });
  if (!session) return null;
  const cancellationPolicy = session.metadata?.trialCancellationPolicy;
  const version = `${TRIAL_PAYMENT_POLICY}:${cancellationPolicy}:${plan}`;
  if (session.status !== "open" || session.mode !== "subscription" || session.payment_status !== "unpaid" ||
    session.client_reference_id !== userId || (typeof session.customer === "string" ? session.customer : session.customer?.id) !== customerId ||
    session.amount_total !== 99 || session.currency !== "usd" || session.metadata?.acceptedOfferVersion !== version ||
    !["refund_during_trial", "retain_credit"].includes(cancellationPolicy ?? "") || cancellationPolicy !== current[0].metadata.trialCancellationPolicy) {
    throw new StripeConfigurationError("Your existing trial checkout needs reconciliation. Please open billing or contact support.");
  }
  const recurringAmount = Math.round(BILLING_PLANS[plan].price * 100);
  return { session, offer: { version, plan, currency: "usd", trialDays: 3, dueTodayAmount: 99, creditAmount: 99,
    recurringAmount, firstMonthlyAmount: recurringAmount - 99, requiresAcceptance: true,
    cancellationPolicy: cancellationPolicy as "refund_during_trial" | "retain_credit" } };
}

async function createCheckoutSessionLocked(
  userId: string, email: string, plan: CheckoutPlan, client: CheckoutClient, billingDb: BillingDatabase, igUsername?: string, acceptedOfferVersion?: string,
): Promise<Stripe.Checkout.Session> {
  if (!stripe) {
    throw new StripeConfigurationError(
      "Billing is not configured yet. Please contact support.",
    );
  }

  const priceId = configuredPriceId(plan);
  const baseUrl = appUrl();

  // Retrieve or create Stripe customer. Do not let Checkout create a second
  // subscription for an account that already has one; plan changes belong in
  // the customer portal.
  let customerId: string | undefined;
  const [existingSub] = await billingDb
    .select({
      stripeCustomerId: subscriptions.stripeCustomerId,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      status: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
      trialPaymentPolicy: subscriptions.trialPaymentPolicy,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  const linkedCustomerId = await linkedStripeCustomer(userId, billingDb);
  if (linkedCustomerId && (!existingSub || (existingSub.status === "past_due" && existingSub.trialPaymentPolicy === TRIAL_PAYMENT_POLICY))) {
    const resumable = await resumableTrialCheckout(userId, linkedCustomerId, plan, client, igUsername?.toLowerCase().replace(/^@/, "") ?? "");
    if (resumable) { requireCurrentCheckoutOffer(resumable.offer, acceptedOfferVersion); return resumable.session; }
  }
  if (
    existingSub?.stripeSubscriptionId &&
    ["trialing", "active", "past_due"].includes(existingSub.status)
  ) {
    throw new ExistingSubscriptionError();
  }

  if (linkedCustomerId || existingSub?.stripeCustomerId) {
    customerId = linkedCustomerId ?? existingSub!.stripeCustomerId!;
  } else {
    // A canceled/expired Checkout session does not create a local
    // subscription row, so a retry would otherwise create another Stripe
    // Customer for the same app user. Reuse only a customer explicitly tagged
    // with this userId; matching by email alone is not a safe ownership check.
    const candidates = await stripe.customers.list({ email, limit: 100 });
    if (candidates.has_more) throw new StripeConfigurationError("Billing history needs reconciliation. Please contact support.");
    const reusableCustomer = candidates.data.find(
      (customer) => customer.metadata?.userId === userId,
    );

    if (reusableCustomer) {
      customerId = reusableCustomer.id;
    } else {
      const customer = await stripe.customers.create({
        email,
        metadata: { userId },
      }, { idempotencyKey: `customer:${userId}` });
      customerId = customer.id;
    }
  }

  // Persist BEFORE returning a checkout URL, including trials/abandoned carts.
  await saveStripeCustomerLink(userId, customerId, billingDb);
  const remoteSubscriptions = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
  if (remoteSubscriptions.has_more || remoteSubscriptions.data.some(sub => !["canceled", "incomplete_expired"].includes(sub.status))) {
    throw new ExistingSubscriptionError();
  }
  const [trialHistory] = await billingDb.select({ usedAt: users.trialUsedAt }).from(users).where(eq(users.id, userId)).limit(1);
  const trialEligible = !trialHistory?.usedAt && !existingSub &&
    !remoteSubscriptions.data.some(sub => sub.trial_start != null || sub.trial_end != null);
  const offer = checkoutOffer(plan, trialEligible);
  requireCurrentCheckoutOffer(offer, acceptedOfferVersion);
  const advance = offer.creditAmount ? await verifyTrialPaymentConfiguration(stripe, plan, priceId) : null;
  if (advance) {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted || (customer.metadata.userId && customer.metadata.userId !== userId) ||
      (customer.invoice_credit_balance?.usd ?? customer.balance) !== 0) {
      throw new StripeConfigurationError("Your existing billing balance needs review before this trial payment. Please contact support.");
    }
  }
  const target = igUsername?.toLowerCase().replace(/^@/, "") ?? "";
  const openSessions = await stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 100 });
  if (openSessions.has_more) throw new StripeConfigurationError("Too many open checkouts. Please contact support.");
  const reusable = openSessions.data.find(session => session.metadata?.userId === userId && session.metadata?.plan === plan && session.metadata?.client === client && (session.metadata?.igUsername ?? "") === target && session.metadata?.trialEligible === String(trialEligible) &&
    (advance ? session.metadata?.acceptedOfferVersion === offer.version && session.metadata?.trialPaymentPolicy === TRIAL_PAYMENT_POLICY : !session.metadata?.trialPaymentPolicy));
  for (const pending of openSessions.data) {
    // Ignore sessions owned by another app; do not mutate unverified targets.
    if (pending.id !== reusable?.id && pending.metadata?.userId === userId) await stripe.checkout.sessions.expire(pending.id);
  }
  if (reusable) {
    if (advance && (reusable.currency !== "usd" || reusable.amount_total !== 99)) {
      await stripe.checkout.sessions.expire(reusable.id);
      throw new StripeConfigurationError("Checkout amount changed. Please reopen checkout to review the current terms.");
    }
    return reusable;
  }

  const founderCoupon = advance ? advance.coupons[plan] : founderCouponFor(plan);
  const paymentMetadata: Record<string, string> = advance ? { trialPaymentPolicy: TRIAL_PAYMENT_POLICY, trialPaymentAmount: "99", trialPaymentCurrency: "usd",
    trialPaymentPriceId: advance.priceId, trialCancellationPolicy: advance.cancellationPolicy, acceptedOfferVersion: offer.version } : {};

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    client_reference_id: userId,
    mode: "subscription",
    integration_identifier: `subscription_${advance ? "advance" : "standard"}_${Array.from(randomBytes(8), b => String.fromCharCode(97 + b % 26)).join("")}`,
    line_items: [{ price: priceId, quantity: 1 }, ...(advance ? [{ price: advance.priceId, quantity: 1 }] : [])],
    payment_method_collection: "always",
    ...(advance ? { payment_method_configuration: advance.paymentMethodConfiguration } : {}),
    // Auto-apply the founders discount so Stripe shows the anchor price struck
    // through with the "FOUNDERS −$X" line at checkout AND on the subscription
    // (forever coupon). `discounts` is mutually exclusive with promotion codes.
    ...(founderCoupon ? { discounts: [{ coupon: founderCoupon }] } : {}),
    subscription_data: {
      ...(trialEligible ? { trial_period_days: 3 } : {}),
      metadata: { userId, plan, ...paymentMetadata },
    },
    ...checkoutRedirects(baseUrl, client),
    ...(client === "web" ? { cancel_url: `${baseUrl}/payment?checkout=cancelled&plan=${plan}${target ? `&username=${encodeURIComponent(target)}` : ""}` } : {}),
    ...(advance ? { custom_text: { submit: { message: checkoutTrialDisclosure(offer) } } } : {}),
    metadata: { userId, plan, client, igUsername: target, trialEligible: String(trialEligible), acceptedOfferVersion: offer.version, ...paymentMetadata },
  });

  if (advance && (session.currency !== "usd" || session.amount_total !== 99 || session.metadata?.acceptedOfferVersion !== offer.version)) {
    // Do not send a customer to a provider checkout for a different amount.
    // Capture is independently verified later; this is a pre-payment check.
    if (session.status === "open") await stripe.checkout.sessions.expire(session.id);
    throw new StripeConfigurationError("Checkout amount could not be verified. Please retry or contact support.");
  }
  return session;
}

export async function createPortalSession(
  customerId: string,
  change?: { subscriptionId: string; plan: CheckoutPlan },
  currentSubscriptionId?: string,
): Promise<Stripe.BillingPortal.Session> {
  if (!stripe) {
    throw new StripeConfigurationError(
      "Billing is not configured yet. Please contact support.",
    );
  }

  const baseUrl = appUrl();
  let configuration = change ? process.env.STRIPE_PLAN_PORTAL_CONFIG_ID : process.env.STRIPE_MANAGE_PORTAL_CONFIG_ID;
  if (!change && currentSubscriptionId) {
    const current = await stripe.subscriptions.retrieve(currentSubscriptionId);
    if ((typeof current.customer === "string" ? current.customer : current.customer.id) !== customerId) throw new CheckoutSessionOwnershipError();
    if (current.status === "trialing" && current.metadata.trialPaymentPolicy === TRIAL_PAYMENT_POLICY && current.metadata.trialCancellationPolicy === "refund_during_trial") {
      configuration = process.env.STRIPE_TRIAL_REFUND_PORTAL_CONFIG_ID;
      if (!configuration?.startsWith("bpc_")) throw new StripeConfigurationError("Trial cancellation portal needs configuration. You can still cancel in account settings.");
      const portal = await stripe.billingPortal.configurations.retrieve(configuration);
      if (!portal.active || !portal.features.subscription_cancel.enabled || portal.features.subscription_cancel.mode !== "immediately") throw new StripeConfigurationError("Trial cancellation portal needs configuration. You can still cancel in account settings.");
    }
  }
  if (!configuration?.startsWith("bpc_")) throw new StripeConfigurationError("Secure billing portal is not configured. Please contact support.");
  let flow_data: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined;
  if (change) {
    const current = await stripe.subscriptions.retrieve(change.subscriptionId);
    const owner = typeof current.customer === "string" ? current.customer : current.customer.id;
    if (owner !== customerId || !["active", "trialing"].includes(current.status) || current.items.data.length !== 1) {
      throw new StripeConfigurationError("This subscription cannot be changed here. Please contact support.");
    }
    const coupon = founderCouponFor(change.plan);
    if (!coupon) throw new StripeConfigurationError("The selected plan discount is not configured. Please contact support.");
    flow_data = {
      type: "subscription_update_confirm",
      subscription_update_confirm: {
        subscription: current.id,
        items: [{ id: current.items.data[0].id, price: configuredPriceId(change.plan), quantity: 1 }],
        discounts: [{ coupon }],
      },
      after_completion: { type: "redirect", redirect: { return_url: `${baseUrl}/settings?tab=billing&portal=returned` } },
    };
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId, configuration, flow_data,
    return_url: `${baseUrl}/settings?tab=billing&portal=returned`,
  });

  return session;
}

export async function confirmCheckoutSession(
  userId: string,
  sessionId: string,
): Promise<{
  status: Stripe.Checkout.Session.Status | null;
  paymentStatus: Stripe.Checkout.Session.PaymentStatus;
  igUsername: string | null;
  hasAccess: boolean;
}> {
  if (!stripe) {
    throw new StripeConfigurationError(
      "Billing is not configured yet. Please contact support.",
    );
  }
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9]+$/u.test(sessionId)) {
    throw new CheckoutSessionOwnershipError();
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["subscription"],
  });
  const ownerId = session.metadata?.userId ?? session.client_reference_id;
  if (ownerId !== userId) {
    throw new CheckoutSessionOwnershipError();
  }

  if (session.status === "complete" && session.subscription) {
    const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
    if (!customerId) throw new CheckoutSessionOwnershipError();
    // Use the same customer lease/current-state rule as webhooks: replaying an
    // old completed checkout cannot overwrite a newer paid subscription.
    await withOperationLease(`stripe:${customerId}`, async () => {
      const candidates = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
      if (candidates.has_more) throw new StripeConfigurationError("Billing history needs reconciliation. Please contact support.");
      const current = chooseCurrentSubscription(candidates.data);
      if (current) await syncSubscription(current);
    });
  }

  return {
    status: session.status,
    paymentStatus: session.payment_status,
    igUsername: session.status === "complete" && /^[a-z0-9._]{1,30}$/.test(session.metadata?.igUsername ?? "") ? session.metadata!.igUsername : null,
    hasAccess: hasSubscriptionAccess((await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1))[0]),
  };
}

export async function syncSubscription(
  stripeSub: Stripe.Subscription,
  options: { invoiceAttentionEvent?: boolean } = {},
): Promise<void> {
  const [persisted] = await db.select({ policy: subscriptions.trialPaymentPolicy, userId: subscriptions.userId })
    .from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, stripeSub.id)).limit(1);
  if (persisted?.policy && (stripeSub.metadata.trialPaymentPolicy !== persisted.policy || stripeSub.metadata.userId !== persisted.userId)) {
    throw new StripeConfigurationError("Trial payment ownership or policy needs reconciliation.");
  }
  if (stripeSub.metadata.trialPaymentPolicy) {
    if (stripeSub.metadata.trialPaymentPolicy !== TRIAL_PAYMENT_POLICY || !stripeSub.metadata.userId) {
      throw new StripeConfigurationError("Trial payment policy needs reconciliation.");
    }
    // Share checkout/cancellation/deletion's session lock. All enclosed DB work
    // uses this connection, including the short subscription/email transaction.
    return withCustomerBillingLock(stripeSub.metadata.userId,
      executor => syncSubscriptionLocked(stripeSub, options, executor));
  }
  return syncSubscriptionLocked(stripeSub, options, db);
}

async function syncSubscriptionLocked(
  stripeSub: Stripe.Subscription,
  options: { invoiceAttentionEvent?: boolean },
  executor: BillingDatabase,
): Promise<void> {
  if (!stripe) {
    throw new Error("Stripe is not configured — set STRIPE_SECRET_KEY to enable payments");
  }

  const userId =
    (stripeSub.metadata?.userId as string) ??
    (typeof stripeSub.customer === "string"
      ? await getUserIdByCustomer(stripeSub.customer)
      : undefined);

  if (!userId) {
    console.warn("[stripe] syncSubscription: could not resolve userId for", stripeSub.id);
    return;
  }

  // Defense-in-depth: metadata.userId originates from Stripe metadata, which
  // can be stale (deleted user) or attacker-controlled if signature
  // verification were ever misconfigured. Only upsert for users that exist.
  const [existingUser] = await executor
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!existingUser) {
    console.warn(
      `[stripe] syncSubscription: userId "${userId}" on subscription ${stripeSub.id} does not match any existing user — skipping sync`,
    );
    return;
  }

  const subscriptionPriceId = stripeSub.items.data[0]?.price?.id;
  const planFromPrice =
    (Object.entries(PLAN_PRICE_IDS) as Array<[SubscriptionPlan, string]>).find(
      ([, priceId]) => priceId && subscriptionPriceId === priceId,
    )?.[0] ?? null;
  const metadataPlan = isSubscriptionPlan(stripeSub.metadata?.plan)
    ? stripeSub.metadata.plan
    : null;
  // The portal can change the subscription item without rewriting metadata, so
  // the actual Stripe price is the source of truth for the displayed plan.
  const plan: SubscriptionPlan | null = planFromPrice ?? metadataPlan;
  const customerId =
    typeof stripeSub.customer === "string"
      ? stripeSub.customer
      : stripeSub.customer.id;

  const statusMap: Record<string, "trialing" | "active" | "past_due" | "canceled"> = {
    trialing: "trialing",
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    incomplete: "past_due",
    incomplete_expired: "canceled",
    unpaid: "past_due",
    paused: "past_due",
  };

  if (stripeSub.metadata.trialPaymentPolicy === TRIAL_PAYMENT_POLICY && ["canceled", "incomplete_expired"].includes(stripeSub.status)) {
    // A confirmed provider cancellation closes existing access even if its
    // separate credit/refund reconciliation is temporarily unavailable.
    const ended = await executor.update(subscriptions).set({ status: "canceled", cancelAtPeriodEnd: false, updatedAt: new Date() })
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.stripeSubscriptionId, stripeSub.id), eq(subscriptions.stripeCustomerId, customerId)))
      .returning({ id: subscriptions.id });
    if (ended.length) await executor.update(trackedAccounts).set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(trackedAccounts.userId, userId), eq(trackedAccounts.isActive, true)));
  }
  const trialPayment = await reconcileTrialPaymentCredit(stripe, stripeSub, executor);
  if (trialPayment.required && stripeSub.metadata.trialCancellationPolicy === "refund_during_trial") {
    if (stripeSub.status === "trialing" && (stripeSub.cancel_at_period_end || stripeSub.cancel_at) && stripeSub.trial_end &&
      stripeSub.canceled_at != null && stripeSub.canceled_at < stripeSub.trial_end) {
      const canceled = await stripe.subscriptions.cancel(stripeSub.id, { invoice_now: false, prorate: false });
      const canceledCustomer = typeof canceled.customer === "string" ? canceled.customer : canceled.customer.id;
      if (canceled.id !== stripeSub.id || canceledCustomer !== customerId || canceled.metadata.userId !== userId || canceled.status !== "canceled") {
        throw new StripeConfigurationError("Trial cancellation is awaiting confirmation.");
      }
      stripeSub = canceled;
    }
    await reconcileTrialPaymentCancellation(stripe, stripeSub, executor);
  }
  let verifiedTrialPayment = !trialPayment.required || trialPayment.paid;
  // A refunded trial advance must not revoke a later fully paid membership.
  // The initial 99-cent invoice alone never qualifies as a monthly renewal.
  if (!verifiedTrialPayment && stripeSub.status === "active" && stripeSub.latest_invoice) {
    const invoiceId = typeof stripeSub.latest_invoice === "string" ? stripeSub.latest_invoice : stripeSub.latest_invoice.id;
    const invoice = await stripe.invoices.retrieve(invoiceId);
    const invoiceCustomer = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
    const invoiceSub = invoice.parent?.subscription_details?.subscription;
    verifiedTrialPayment = invoice.id === invoiceId && invoice.status === "paid" && invoice.amount_paid > 0 && invoice.amount_remaining === 0 &&
      ["subscription_cycle", "subscription_update"].includes(invoice.billing_reason ?? "") && invoiceCustomer === customerId &&
      (typeof invoiceSub === "string" ? invoiceSub : invoiceSub?.id) === stripeSub.id;
  }
  if (verifiedTrialPayment && stripeSub.status === "active" && stripeSub.metadata.trialActivationPolicy === TRIAL_ACTIVATION_POLICY) {
    const [local] = await executor.select({ status: subscriptions.status }).from(subscriptions).where(and(
      eq(subscriptions.userId, userId), eq(subscriptions.stripeSubscriptionId, stripeSub.id),
      eq(subscriptions.stripeCustomerId, customerId),
    )).limit(1);
    // Ending a trial can emit active before the new invoice is paid. Preserve
    // preview until invoice.paid reaches this same sync path. Once activated,
    // ordinary renewals keep their existing behavior; passive trials bypass it.
    if (local?.status !== "active" && !(await activationPaymentVerified(stripe, stripeSub))) return;
  }
  const status = !verifiedTrialPayment && ["trialing", "active"].includes(stripeSub.status)
    ? "past_due" : statusMap[stripeSub.status] ?? "canceled";
  const paymentSummary = trialPayment.required ? (await readTrialPaymentSummary(userId, stripeSub.id, executor) ??
    pendingTrialPaymentSummary(stripeSub.metadata.trialPaymentPolicy, stripeSub.metadata.trialCancellationPolicy)) : undefined;
  const trialPaymentPolicy = trialPayment.required ? TRIAL_PAYMENT_POLICY : null;
  const trialCancellationPolicy = trialPayment.required ? stripeSub.metadata.trialCancellationPolicy : null;

  const currentPeriodEnd = stripeSub.items.data[0]?.current_period_end
    ? new Date(Math.min(stripeSub.items.data[0].current_period_end, stripeSub.cancel_at ?? Infinity) * 1000)
    : null;

  const trialEnd = stripeSub.trial_end
    ? new Date(Math.min(stripeSub.trial_end, stripeSub.cancel_at ?? Infinity) * 1000)
    : null;

  if (verifiedTrialPayment && (stripeSub.trial_start != null || stripeSub.trial_end != null)) {
    await executor.update(users).set({ trialUsedAt: sql`COALESCE(${users.trialUsedAt}, now())` }).where(eq(users.id, userId));
  }

  // Upsert the subscription record
  operationSignal()?.throwIfAborted();
  await executor.transaction(async tx => {
    const [synced] = await tx
      .insert(subscriptions)
      .values({
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: stripeSub.id,
        status,
        plan: plan ?? undefined,
        currentPeriodEnd,
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end || !!stripeSub.cancel_at,
        trialEndsAt: trialEnd,
        trialPaymentPolicy, trialCancellationPolicy,
      })
      .onConflictDoUpdate({
        target: subscriptions.userId,
        set: {
          stripeCustomerId: customerId,
          stripeSubscriptionId: stripeSub.id,
          status,
          plan: plan ?? undefined,
          currentPeriodEnd,
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end || !!stripeSub.cancel_at,
          trialEndsAt: trialEnd,
          trialPaymentPolicy, trialCancellationPolicy,
          updatedAt: new Date(),
        },
      }).returning();
    if ((verifiedTrialPayment || status === "canceled") && !(options.invoiceAttentionEvent && status === "past_due")) await recordSubscriptionEmail(tx, userId, {
      stripeSubscriptionId:stripeSub.id,status,plan:synced.plan,
      currentPeriodEnd:currentPeriodEnd?.toISOString() ?? null,
      trialEndsAt:trialEnd?.toISOString() ?? null,cancelAtPeriodEnd:stripeSub.cancel_at_period_end || !!stripeSub.cancel_at,
      ...(paymentSummary ? { trialPayment: paymentSummary } : {}),
    });
  });

  // A plan downgrade/cancellation must change actual access, not just the
  // label shown in Settings. Keep the oldest tracked accounts active and stop
  // any overflow rows. Existing history remains available, and the scheduler's
  // active-account reconciliation removes their recurring refresh jobs.
  const accountLimit = accountLimitForSubscription({
    plan,
    status,
    trialEndsAt: trialEnd,
    currentPeriodEnd,
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSub.id,
  });
  const activeAccounts = await executor
    .select({ id: trackedAccounts.id })
    .from(trackedAccounts)
    .where(
      and(
        eq(trackedAccounts.userId, userId),
        eq(trackedAccounts.isActive, true),
      ),
    )
    .orderBy(asc(trackedAccounts.trackingStarted));
  const overflowIds = activeAccounts
    .slice(accountLimit)
    .map((account) => account.id);
  if (overflowIds.length > 0) {
    operationSignal()?.throwIfAborted();
    await executor
      .update(trackedAccounts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(trackedAccounts.id, overflowIds));
  }
}

async function getUserIdByCustomer(customerId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(eq(subscriptions.stripeCustomerId, customerId))
    .limit(1);
  return row?.userId;
}
