/** Prepare isolated Stripe catalog/settings for the 99-cent trial advance.
 * Read-only unless --provision is explicit. This script never creates a
 * customer, Checkout Session, subscription, payment, credit, or refund, and
 * never edits an existing Stripe object or a runtime environment file.
 *
 * npx tsx server/scripts/configure-trial-payment.ts --test --policy=retain_credit --output=/tmp/trial-readonly.json
 * npx tsx server/scripts/configure-trial-payment.ts --provision --test --policy=refund_during_trial --output=/tmp/trial-provisioned.json
 * Live additionally requires --live and STRIPE_EXPECTED_ACCOUNT_ID.
 *
 * References: https://docs.stripe.com/payments/payment-method-configurations
 * https://docs.stripe.com/api/payment_method_configurations/create
 * https://docs.stripe.com/api/customer_portal/configurations/create
 */
import "dotenv/config";
import Stripe from "stripe";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BILLING_PLANS, CHECKOUT_PLAN_IDS, type CheckoutPlan } from "../../shared/billing-plans.js";
import { TRIAL_PAYMENT_AMOUNT, TRIAL_PAYMENT_POLICY, type TrialCancellationPolicy } from "../../shared/trial-payment.js";
import { verifyTrialPaymentConfiguration } from "../services/trial-payment-offer.js";

const PRODUCT_ID = "prod_cheaterfinder_trial_advance_usd_99_v1";
const PRICE_LOOKUP = "cheaterfinder_trial_advance_usd_99_v1";
const METHODS_NAME = "CheaterFinder trial advance cards v1";
const PORTAL_NAME = "CheaterFinder refundable trial cancellation v1";
const API_VERSION = "2026-03-25.dahlia" as const;
const WEBHOOK_PATH = "/api/webhooks/stripe";
const REQUIRED_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.trial_will_end",
  "invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.payment_action_required",
  "charge.refunded", "charge.dispute.created", "refund.created", "refund.updated", "refund.failed"] as const;
const request = { timeout: 20_000, maxNetworkRetries: 1 } as const;
const IMMEDIATE_METHODS = new Set(["card", "apple_pay", "google_pay"]);
// Stripe returns Scalapay on the pinned API, but SDK 21.0.1 omits this field.
// Keep the documented additive shape local to this operator; actual creation
// on the pinned API still requires provider verification before activation.
// https://docs.stripe.com/api/payment_method_configurations/create?query=scalapay
type TrialPaymentMethodCreateParams = Stripe.PaymentMethodConfigurationCreateParams & {
  scalapay?: { display_preference?: { preference?: "none" | "off" | "on" } };
};
// Reviewed SDK fields plus the documented compatibility field above. Any
// further provider field fails preflight instead of being implicitly enabled.
const METHOD_FIELDS = [
  "acss_debit", "affirm", "afterpay_clearpay", "alipay", "alma", "amazon_pay", "apple_pay", "apple_pay_later",
  "au_becs_debit", "bacs_debit", "bancontact", "billie", "blik", "boleto", "card", "cartes_bancaires", "cashapp",
  "crypto", "customer_balance", "eps", "fpx", "fr_meal_voucher_conecs", "giropay", "google_pay", "grabpay", "ideal",
  "jcb", "kakao_pay", "klarna", "konbini", "kr_card", "link", "mb_way", "mobilepay", "multibanco", "naver_pay",
  "nz_bank_account", "oxxo", "p24", "pay_by_bank", "payco", "paynow", "paypal", "payto", "pix", "promptpay",
  "revolut_pay", "samsung_pay", "satispay", "scalapay", "sepa_debit", "sofort", "swish", "twint", "upi", "us_bank_account", "wechat_pay", "zip",
] as const satisfies ReadonlyArray<keyof TrialPaymentMethodCreateParams>;

export type TrialConfigurationOptions = { provision: boolean; mode: "test" | "live"; policy: TrialCancellationPolicy; output: string };
class SetupError extends Error {}
let phase = "argument validation";
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new SetupError(message); }
const objectId = (value: string | { id: string }) => typeof value === "string" ? value : value.id;

export function parseTrialConfigurationArgs(args: string[]): TrialConfigurationOptions {
  const known = new Set<string>();
  let provision = false, mode: "test" | "live" | undefined, policy: TrialCancellationPolicy | undefined, output: string | undefined;
  for (const argument of args) {
    const name = argument.split("=", 1)[0];
    assert(!known.has(name), "Duplicate arguments are not allowed."); known.add(name);
    if (argument === "--provision") provision = true;
    else if (argument === "--test" || argument === "--live") {
      assert(!mode, "Choose exactly one of --test or --live."); mode = argument === "--test" ? "test" : "live";
    } else if (argument.startsWith("--policy=")) {
      const value = argument.slice("--policy=".length);
      assert(value === "refund_during_trial" || value === "retain_credit", "Choose an explicit supported cancellation policy."); policy = value;
    } else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else throw new SetupError("Unknown argument. Use --help for the supported options.");
  }
  assert(mode && policy && output, "Supply --test or --live, --policy, and a fresh --output=/tmp/...json path. Omit --provision for read-only verification.");
  assert(isAbsolute(output) && resolve(output).startsWith("/tmp/") && /^[A-Za-z0-9._-]+\.json$/u.test(basename(output)), "Output must be a new JSON file inside /tmp.");
  return { provision, mode, policy, output: resolve(output) };
}

function validateEnvironment(options: TrialConfigurationOptions, env: NodeJS.ProcessEnv): string {
  const key = env.STRIPE_SECRET_KEY ?? "";
  const keyMode = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/u.exec(key)?.[1];
  assert(keyMode === options.mode, "STRIPE_SECRET_KEY must match the explicit --test/--live mode.");
  if (options.mode === "live") assert(/^acct_[A-Za-z0-9]+$/u.test(env.STRIPE_EXPECTED_ACCOUNT_ID ?? ""), "Live access requires STRIPE_EXPECTED_ACCOUNT_ID.");
  for (const plan of CHECKOUT_PLAN_IDS) assert(/^price_[A-Za-z0-9_]+$/u.test(env[`STRIPE_${plan.toUpperCase()}_PRICE_ID`] ?? ""), `Configure the ${plan} recurring price before running this script.`);
  return key;
}

async function validateOutput(path: string): Promise<void> {
  const parent = await realpath(dirname(path));
  assert(parent === "/tmp" || parent.startsWith("/tmp/"), "The output directory must resolve inside /tmp.");
  try { await lstat(path); throw new SetupError("The output file already exists. Choose a fresh output path."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function optionalResource<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); }
  catch (error) { if ((error as { code?: string }).code === "resource_missing") return undefined; throw error; }
}

async function fullList<T extends { id: string }>(read: (cursor?: string) => Promise<Stripe.ApiList<T>>): Promise<T[]> {
  const values: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await read(cursor);
    assert(Array.isArray(result.data) && typeof result.has_more === "boolean", "A provider configuration list was incomplete.");
    for (const value of result.data) { assert(!seen.has(value.id), "Provider pagination repeated an object."); seen.add(value.id); values.push(value); }
    if (!result.has_more) return values;
    cursor = result.data.at(-1)?.id; assert(cursor, "Provider pagination did not supply a continuation.");
  }
  throw new SetupError("Provider configuration history exceeded the bounded preflight. Review it before provisioning.");
}

function knownMethodSchema(configuration: Stripe.PaymentMethodConfiguration): void {
  for (const [name, value] of Object.entries(configuration)) {
    if (value && typeof value === "object" && "display_preference" in value) {
      assert((METHOD_FIELDS as readonly string[]).includes(name), "The provider exposes a payment method unknown to the reviewed configuration schema. Review it before provisioning.");
    }
  }
}

export function trialPaymentMethodCreateParams(): TrialPaymentMethodCreateParams {
  const params: TrialPaymentMethodCreateParams = { name: METHODS_NAME };
  for (const field of METHOD_FIELDS) params[field] = { display_preference: { preference: IMMEDIATE_METHODS.has(field) ? "on" : "off" } };
  return params;
}

function verifyMethods(methods: Stripe.PaymentMethodConfiguration, live: boolean): void {
  knownMethodSchema(methods);
  assert(methods.name === METHODS_NAME && methods.active && methods.livemode === live && !methods.is_default && !methods.parent && !methods.application,
    "The dedicated payment method configuration is not isolated or does not match this mode.");
  assert(methods.card?.available && methods.card.display_preference.value === "on", "Card payments must be available and enabled for this account.");
  for (const [name, value] of Object.entries(methods)) {
    if (!value || typeof value !== "object" || !("display_preference" in value)) continue;
    const preference = value.display_preference as { value?: string; preference?: string };
    assert(IMMEDIATE_METHODS.has(name) ? preference.preference === "on" : preference.value === "off" && preference.preference === "off",
      "The dedicated configuration must enable only card, Apple Pay, and Google Pay, with every other method explicitly off.");
  }
}

function applicationOrigin(env: NodeJS.ProcessEnv): string {
  let url: URL;
  try { url = new URL(env.APP_URL ?? ""); } catch { throw new SetupError("APP_URL must be the public HTTPS application origin."); }
  assert(url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
    url.hostname.includes(".") && !url.hostname.endsWith(".localhost") && !/^\d+(?:\.\d+){3}$/u.test(url.hostname), "APP_URL must be the public HTTPS application origin.");
  return url.origin;
}

function verifyPortal(portal: Stripe.BillingPortal.Configuration, live: boolean, origin: string, methodsId: string): void {
  assert(portal.name === PORTAL_NAME && portal.active && portal.livemode === live && !portal.is_default && !portal.application &&
    portal.metadata?.trialPaymentPolicy === TRIAL_PAYMENT_POLICY && portal.metadata.trialCancellationPolicy === "refund_during_trial" &&
    portal.features.subscription_cancel.enabled && portal.features.subscription_cancel.mode === "immediately" &&
    portal.features.subscription_cancel.proration_behavior === "none" && !portal.features.subscription_update.enabled &&
    portal.features.payment_method_update.enabled && portal.features.payment_method_update.payment_method_configuration === methodsId &&
    portal.default_return_url === `${origin}/settings?tab=billing` && portal.business_profile.terms_of_service_url === `${origin}/terms` &&
    portal.business_profile.privacy_policy_url === `${origin}/privacy`, "The dedicated refund portal does not match the required cancellation/payment settings.");
}

export function webhookReadiness(endpoints: Stripe.WebhookEndpoint[], live: boolean, origin: string, env: NodeJS.ProcessEnv) {
  const matching = endpoints.filter(endpoint => {
    try {
      const url = new URL(endpoint.url);
      return endpoint.status === "enabled" && endpoint.livemode === live && !endpoint.application &&
        url.origin === origin && url.pathname === WEBHOOK_PATH && !url.search && !url.hash;
    } catch { return false; }
  });
  const coverage = matching.map(endpoint => ({ id: endpoint.id,
    missingEvents: REQUIRED_EVENTS.filter(event => !endpoint.enabled_events.includes("*") && !endpoint.enabled_events.includes(event)) }));
  const subscribed = coverage.some(endpoint => endpoint.missingEvents.length === 0);
  const signingSecretConfigured = /^whsec_[A-Za-z0-9]+$/u.test(env.STRIPE_WEBHOOK_SECRET ?? "") && env.STRIPE_WEBHOOK_ALLOW_UNVERIFIED !== "true";
  return { ready: subscribed && signingSecretConfigured, subscribed, signingSecretConfigured, signatureDeliveryVerified: false,
    endpointIds: matching.map(endpoint => endpoint.id), coverage,
    requiredEvents: [...REQUIRED_EVENTS] };
}

async function runtimeVerification(api: Stripe, environment: Record<string, string>, priceIds: Record<CheckoutPlan, string>): Promise<void> {
  // This is only this short-lived script process. Never write these temporary
  // validation values to .env, the process manager, or the prepared output.
  const values = { ...environment, STRIPE_TRIAL_ADVANCE_ENABLED: "true" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    for (const plan of CHECKOUT_PLAN_IDS) await verifyTrialPaymentConfiguration(api, plan, priceIds[plan]);
  } finally {
    for (const key of Object.keys(values)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
}

export async function prepareTrialConfiguration(api: Stripe, options: TrialConfigurationOptions, env: NodeJS.ProcessEnv = process.env) {
  validateEnvironment(options, env);
  await validateOutput(options.output);
  const live = options.mode === "live", origin = applicationOrigin(env);
  phase = "account and recurring catalog preflight";
  const account = await api.accounts.retrieve({}, request);
  assert(/^acct_[A-Za-z0-9]+$/u.test(account.id) && (!env.STRIPE_EXPECTED_ACCOUNT_ID || account.id === env.STRIPE_EXPECTED_ACCOUNT_ID), "Stripe account identity did not match the expected account.");
  const priceIds = Object.fromEntries(CHECKOUT_PLAN_IDS.map(plan => [plan, env[`STRIPE_${plan.toUpperCase()}_PRICE_ID`]!])) as Record<CheckoutPlan, string>;
  const recurring = Object.fromEntries(await Promise.all(CHECKOUT_PLAN_IDS.map(async (plan): Promise<readonly [CheckoutPlan, Stripe.Price]> => {
    const price = await api.prices.retrieve(priceIds[plan], { expand: ["product"] }, request);
    const product = price.product;
    assert(price.livemode === live && price.active && price.currency === "usd" && price.unit_amount === Math.round(BILLING_PLANS[plan].anchorPrice! * 100) &&
      price.type === "recurring" && price.recurring?.interval === "month" && price.recurring.interval_count === 1 && price.recurring.usage_type === "licensed" &&
      typeof product !== "string" && !("deleted" in product) && product.active && product.livemode === live,
    `The configured ${plan} price does not match its active USD monthly anchor/product.`);
    return [plan, price] as const;
  }))) as Record<CheckoutPlan, Stripe.Price>;
  assert(new Set(Object.values(recurring).map(price => objectId(price.product))).size === CHECKOUT_PLAN_IDS.length, "Each monthly plan must have its own product.");

  phase = "read-only dedicated resource discovery";
  const couponIds = Object.fromEntries(CHECKOUT_PLAN_IDS.map(plan => [plan, `cheaterfinder_trial_founders_${plan}_v1`])) as Record<CheckoutPlan, string>;
  const [existingProduct, priceList, couponList, methodList, portalList, endpoints] = await Promise.all([
    optionalResource(() => api.products.retrieve(PRODUCT_ID, {}, request)),
    api.prices.list({ lookup_keys: [PRICE_LOOKUP], limit: 100 }, request),
    Promise.all(CHECKOUT_PLAN_IDS.map(plan => optionalResource(() => api.coupons.retrieve(couponIds[plan], { expand: ["applies_to"] }, request)))),
    fullList(cursor => api.paymentMethodConfigurations.list({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, request)),
    options.policy === "refund_during_trial" ? fullList(cursor => api.billingPortal.configurations.list({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, request)) : Promise.resolve([]),
    fullList(cursor => api.webhookEndpoints.list({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, request)),
  ]);
  assert(priceList.has_more === false && priceList.data.length <= 1, "The dedicated advance price lookup is ambiguous.");
  let product = existingProduct, advance = priceList.data[0];
  const coupons = Object.fromEntries(CHECKOUT_PLAN_IDS.map((plan, index) => [plan, couponList[index]])) as Record<CheckoutPlan, Stripe.Coupon | undefined>;
  const namedMethods = methodList.filter(value => value.name === METHODS_NAME);
  const namedPortals = portalList.filter(value => value.name === PORTAL_NAME || value.metadata?.trialPaymentPolicy === TRIAL_PAYMENT_POLICY);
  assert(namedMethods.length <= 1 && namedPortals.length <= 1, "Dedicated configuration names are ambiguous. Review existing objects before proceeding.");
  let methods = namedMethods[0], portal = namedPortals[0];
  if (product) assert(product.id === PRODUCT_ID && product.active && product.livemode === live && product.metadata.trialPaymentPolicy === TRIAL_PAYMENT_POLICY,
    "The dedicated product identifier is already used by a different or inactive product.");
  if (advance) assert(product && objectId(advance.product) === PRODUCT_ID && advance.active && advance.livemode === live && advance.type === "one_time" &&
    !advance.recurring && advance.currency === "usd" && advance.unit_amount === TRIAL_PAYMENT_AMOUNT && advance.lookup_key === PRICE_LOOKUP &&
    advance.metadata.trialPaymentPolicy === TRIAL_PAYMENT_POLICY, "The advance price lookup already points to an incompatible price.");
  for (const plan of CHECKOUT_PLAN_IDS) {
    const coupon = coupons[plan], recurringProduct = objectId(recurring[plan].product);
    if (coupon) assert(coupon.valid && coupon.livemode === live && coupon.currency === "usd" && coupon.duration === "forever" && coupon.percent_off == null &&
      coupon.amount_off === Math.round((BILLING_PLANS[plan].anchorPrice! - BILLING_PLANS[plan].price) * 100) &&
      coupon.applies_to?.products.length === 1 && coupon.applies_to.products[0] === recurringProduct &&
      !coupon.max_redemptions && !coupon.redeem_by && coupon.metadata?.trialPaymentPolicy === TRIAL_PAYMENT_POLICY,
    `The dedicated ${plan} coupon does not match the restricted founders discount.`);
  }
  const defaults = methodList.filter(value => value.is_default && !value.parent && !value.application && value.livemode === live);
  assert(defaults.length === 1 && defaults[0].card?.available, "A direct default configuration with available card payments is required before provisioning an isolated trial configuration.");
  for (const value of methodList) knownMethodSchema(value);
  if (methods) verifyMethods(methods, live);
  if (portal) { assert(methods && origin, "The existing refund portal has no matching dedicated payment configuration."); verifyPortal(portal, live, origin, methods.id); }
  if (options.policy === "refund_during_trial" && !portal) {
    assert(portalList.some(value => value.is_default && value.livemode === live), "Configure the account's standard billing portal first; this script will only add a separate refundable-trial portal.");
  }

  const missing = [!product && "advance_product", !advance && "advance_price", ...CHECKOUT_PLAN_IDS.map(plan => !coupons[plan] && `${plan}_coupon`),
    !methods && "payment_method_configuration", options.policy === "refund_during_trial" && !portal && "refund_portal_configuration"].filter(Boolean) as string[];
  if (options.provision) {
    phase = "dedicated catalog provisioning";
    if (!product) product = await api.products.create({ id: PRODUCT_ID, name: "CheaterFinder trial advance", description: "99-cent advance credited to the next invoice",
      metadata: { trialPaymentPolicy: TRIAL_PAYMENT_POLICY } }, { ...request, idempotencyKey: `${account.id}:${TRIAL_PAYMENT_POLICY}:product` });
    if (!advance) advance = await api.prices.create({ product: product.id, currency: "usd", unit_amount: TRIAL_PAYMENT_AMOUNT,
      lookup_key: PRICE_LOOKUP, metadata: { trialPaymentPolicy: TRIAL_PAYMENT_POLICY } }, { ...request, idempotencyKey: `${account.id}:${TRIAL_PAYMENT_POLICY}:price` });
    for (const plan of CHECKOUT_PLAN_IDS) if (!coupons[plan]) coupons[plan] = await api.coupons.create({ id: couponIds[plan], name: "FOUNDERS", currency: "usd", duration: "forever",
      amount_off: Math.round((BILLING_PLANS[plan].anchorPrice! - BILLING_PLANS[plan].price) * 100), applies_to: { products: [objectId(recurring[plan].product)] },
      metadata: { trialPaymentPolicy: TRIAL_PAYMENT_POLICY, plan } }, { ...request, idempotencyKey: `${account.id}:${TRIAL_PAYMENT_POLICY}:coupon:${plan}` });
    phase = "dedicated payment method configuration provisioning";
    if (!methods) methods = await api.paymentMethodConfigurations.create(trialPaymentMethodCreateParams(), { ...request, idempotencyKey: `${account.id}:${TRIAL_PAYMENT_POLICY}:methods` });
    verifyMethods(methods, live);
    phase = "dedicated refund portal provisioning";
    if (options.policy === "refund_during_trial" && !portal) portal = await api.billingPortal.configurations.create({
      name: PORTAL_NAME, metadata: { trialPaymentPolicy: TRIAL_PAYMENT_POLICY, trialCancellationPolicy: "refund_during_trial" },
      business_profile: { headline: "CheaterFinder billing", terms_of_service_url: `${origin}/terms`, privacy_policy_url: `${origin}/privacy` },
      default_return_url: `${origin}/settings?tab=billing`, login_page: { enabled: false },
      features: { customer_update: { enabled: false }, invoice_history: { enabled: true }, subscription_update: { enabled: false },
        payment_method_update: { enabled: true, payment_method_configuration: methods.id },
        subscription_cancel: { enabled: true, mode: "immediately", proration_behavior: "none" } },
    }, { ...request, idempotencyKey: `${account.id}:${TRIAL_PAYMENT_POLICY}:refund-portal` });
    if (portal) verifyPortal(portal, live, origin!, methods.id);
  }
  const environment: Record<string, string> = {
    STRIPE_TRIAL_ADVANCE_ENABLED: "false", STRIPE_TRIAL_CANCELLATION_POLICY: options.policy,
    STRIPE_TRIAL_ADVANCE_PRICE_ID: advance?.id ?? "", STRIPE_TRIAL_PAYMENT_METHOD_CONFIG_ID: methods?.id ?? "",
    STRIPE_TRIAL_REFUND_PORTAL_CONFIG_ID: portal?.id ?? "",
    ...Object.fromEntries(CHECKOUT_PLAN_IDS.map(plan => [`STRIPE_TRIAL_FOUNDERS_COUPON_${plan.toUpperCase()}`, coupons[plan]?.id ?? ""])),
  };
  const complete = !!(product && advance && methods && CHECKOUT_PLAN_IDS.every(plan => coupons[plan]) && (options.policy !== "refund_during_trial" || portal));
  phase = "application configuration verification";
  if (complete) await runtimeVerification(api, environment, priceIds);
  const webhooks = webhookReadiness(endpoints, live, origin, env);
  const result = { mode: options.mode, operation: options.provision ? "provision" : "read_only", accountId: account.id,
    verified: complete, enabled: false, webhookReady: webhooks.ready, signatureDeliveryVerified: false,
    missing: complete ? [] : missing, webhooks, environment };
  phase = "disabled configuration output";
  const file = await open(options.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(result, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  return result;
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--help")) {
    console.log("Usage: configure-trial-payment.ts [--provision] (--test|--live) --policy=(refund_during_trial|retain_credit) --output=/tmp/new-file.json\nDefaults to read-only verification. Live requires STRIPE_EXPECTED_ACCOUNT_ID. Prepared output always keeps STRIPE_TRIAL_ADVANCE_ENABLED=false.");
    return;
  }
  const options = parseTrialConfigurationArgs(process.argv.slice(2));
  const key = validateEnvironment(options, process.env);
  const api = new Stripe(key, { apiVersion: API_VERSION, timeout: request.timeout, maxNetworkRetries: request.maxNetworkRetries });
  const result = await prepareTrialConfiguration(api, options);
  console.log(JSON.stringify({ operation: result.operation, mode: result.mode, verified: result.verified, enabled: false,
    webhookReady: result.webhookReady, signatureDeliveryVerified: false, missing: result.missing, output: options.output }));
  if (!result.verified || !result.webhookReady) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    // Provider messages can include request arguments or merchant details.
    // Only emit our own fixed validation messages, never raw Stripe errors.
    console.error(JSON.stringify({ error: error instanceof SetupError ? error.message : "Stripe configuration preparation failed. Review account permissions and retry read-only verification.", phase, enabled: false }));
    process.exitCode = 1;
  });
}
