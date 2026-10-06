import type Stripe from "stripe";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseTrialConfigurationArgs,
  prepareTrialConfiguration,
  webhookReadiness,
  type TrialConfigurationOptions,
} from "../configure-trial-payment.js";

// The operator entry point must never read local credentials or open a real
// provider client when this test imports it. All API responses below are fixtures.
vi.mock("dotenv/config", () => ({}));
vi.mock("stripe", () => ({ default: vi.fn(() => { throw new Error("Real Stripe clients are forbidden in this fixture"); }) }));

const POLICY = "trial-credit-usd-99-v1";
const PRODUCT = "prod_cheaterfinder_trial_advance_usd_99_v1";
const ORIGIN = "https://billing.example.test";
const TIERS = [
  { plan: "starter", anchor: 1699, discount: 500, recurring: 1199 },
  { plan: "standard", anchor: 2799, discount: 800, recurring: 1999 },
  { plan: "pro", anchor: 4499, discount: 1000, recurring: 3499 },
] as const;
const REQUIRED_EVENTS = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.trial_will_end",
  "invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.payment_action_required",
  "charge.refunded", "charge.dispute.created", "refund.created", "refund.updated", "refund.failed",
];
type FixtureObject = Record<string, any>;
const clone = <T,>(value: T): T => structuredClone(value);
const page = (data: FixtureObject[]) => ({ data: clone(data), has_more: false });
const missing = () => { throw Object.assign(new Error("Fixture resource not found"), { code: "resource_missing" }); };

function environment(): NodeJS.ProcessEnv {
  return {
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_EXPECTED_ACCOUNT_ID: "acct_fixture",
    APP_URL: ORIGIN, STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_STARTER_PRICE_ID: "price_starter", STRIPE_STANDARD_PRICE_ID: "price_standard", STRIPE_PRO_PRICE_ID: "price_pro",
  };
}

function endpoint(overrides: FixtureObject = {}): Stripe.WebhookEndpoint {
  return { id: "we_fixture", url: `${ORIGIN}/api/webhooks/stripe`, status: "enabled", livemode: false,
    application: null, enabled_events: [...REQUIRED_EVENTS], ...overrides } as Stripe.WebhookEndpoint;
}

function providerFixture(complete = true) {
  const products = new Map<string, FixtureObject>();
  const prices = new Map<string, FixtureObject>();
  const coupons = new Map<string, FixtureObject>();
  for (const tier of TIERS) {
    prices.set(`price_${tier.plan}`, { id: `price_${tier.plan}`, active: true, livemode: false, currency: "usd",
      unit_amount: tier.anchor, type: "recurring", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      product: { id: `prod_${tier.plan}`, active: true, livemode: false } });
    // Existing subscriptions keep their original unrestricted founder coupons.
    coupons.set(`legacy_${tier.plan}`, { id: `legacy_${tier.plan}`, currency: "usd", amount_off: tier.discount, duration: "forever" });
    if (complete) coupons.set(`cheaterfinder_trial_founders_${tier.plan}_v1`, {
      id: `cheaterfinder_trial_founders_${tier.plan}_v1`, valid: true, livemode: false, currency: "usd", amount_off: tier.discount,
      duration: "forever", percent_off: null, applies_to: { products: [`prod_${tier.plan}`] }, metadata: { trialPaymentPolicy: POLICY },
    });
  }
  if (complete) {
    products.set(PRODUCT, { id: PRODUCT, active: true, livemode: false, metadata: { trialPaymentPolicy: POLICY } });
    prices.set("price_advance", { id: "price_advance", active: true, livemode: false, currency: "usd", unit_amount: 99,
      type: "one_time", recurring: null, product: PRODUCT, lookup_key: "cheaterfinder_trial_advance_usd_99_v1", metadata: { trialPaymentPolicy: POLICY } });
  }
  const preference = (value: "on" | "off") => ({ available: true, display_preference: { preference: value, value } });
  const methods: FixtureObject[] = [{ id: "pmc_default", name: "Default", active: true, is_default: true, livemode: false,
    parent: null, application: null, card: preference("on"), us_bank_account: preference("on") }];
  if (complete) methods.push({ id: "pmc_advance", name: "CheaterFinder trial advance cards v1", active: true, is_default: false,
    livemode: false, parent: null, application: null, card: preference("on"), apple_pay: preference("on"),
    google_pay: preference("on"), us_bank_account: preference("off"), link: preference("off") });
  const portals: FixtureObject[] = [{ id: "bpc_default", is_default: true, livemode: false, features: {
    subscription_cancel: { enabled: true, mode: "at_period_end" }, subscription_update: { enabled: true },
  } }];
  const read = (map: Map<string, FixtureObject>, id: string) => clone(map.get(id) ?? missing());
  const forbidden = vi.fn(async () => { throw new Error("Existing objects and customer money must not be mutated by provisioning"); });
  const api = {
    accounts: { retrieve: vi.fn(async () => ({ id: "acct_fixture" })) },
    products: {
      retrieve: vi.fn(async (id: string) => read(products, id)), update: forbidden, del: forbidden,
      create: vi.fn(async (params: FixtureObject) => {
        const value = { active: true, livemode: false, ...clone(params) }; products.set(value.id, value); return clone(value);
      }),
    },
    prices: {
      retrieve: vi.fn(async (id: string) => read(prices, id)), update: forbidden,
      list: vi.fn(async (params: FixtureObject) => page([...prices.values()].filter(value => params.lookup_keys.includes(value.lookup_key)))),
      create: vi.fn(async (params: FixtureObject) => {
        const value = { id: "price_advance", active: true, livemode: false, type: "one_time", recurring: null, ...clone(params) };
        prices.set(value.id, value); return clone(value);
      }),
    },
    coupons: {
      retrieve: vi.fn(async (id: string, params?: Stripe.CouponRetrieveParams) => {
        const value = read(coupons, id);
        // The real provider includes product restrictions only on expansion.
        if (!params?.expand?.includes("applies_to")) delete value.applies_to;
        return value;
      }), update: forbidden, del: forbidden,
      create: vi.fn(async (params: FixtureObject) => {
        const value = { valid: true, livemode: false, percent_off: null, ...clone(params) }; coupons.set(value.id, value); return clone(value);
      }),
    },
    paymentMethodConfigurations: {
      list: vi.fn(async () => page(methods)), retrieve: vi.fn(async (id: string) => clone(methods.find(value => value.id === id) ?? missing())),
      update: forbidden,
      create: vi.fn(async (params: FixtureObject) => {
        const value: FixtureObject = { id: "pmc_advance", active: true, is_default: false, livemode: false, parent: null, application: null };
        for (const [key, setting] of Object.entries(params)) {
          value[key] = setting && typeof setting === "object" ? preference(setting.display_preference.preference) : setting;
        }
        methods.push(value); return clone(value);
      }),
    },
    billingPortal: { configurations: {
      list: vi.fn(async () => page(portals)), retrieve: vi.fn(async (id: string) => clone(portals.find(value => value.id === id) ?? missing())),
      update: forbidden,
      create: vi.fn(async (params: FixtureObject) => {
        const value = { id: "bpc_advance", active: true, is_default: false, livemode: false, application: null, ...clone(params) };
        portals.push(value); return clone(value);
      }),
    } },
    webhookEndpoints: { list: vi.fn(async () => page([endpoint()])), create: forbidden, update: forbidden, del: forbidden },
    customers: { create: forbidden, update: forbidden, del: forbidden, createBalanceTransaction: forbidden },
    subscriptions: { create: forbidden, update: forbidden, cancel: forbidden },
    checkout: { sessions: { create: forbidden, expire: forbidden } },
    paymentIntents: { create: forbidden, confirm: forbidden }, refunds: { create: forbidden },
  };
  const creates = [api.products.create, api.prices.create, api.coupons.create,
    api.paymentMethodConfigurations.create, api.billingPortal.configurations.create];
  return { api, stripe: api as unknown as Stripe, products, prices, coupons, methods, portals, forbidden, creates };
}

describe("trial catalog preparation — offline provider and real temporary output", () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    directory = await mkdtemp("/tmp/trial-configuration-test-");
    env = environment();
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
  const noMutations = (fixture: ReturnType<typeof providerFixture>) => {
    for (const create of fixture.creates) expect(create).not.toHaveBeenCalled();
    expect(fixture.forbidden).not.toHaveBeenCalled();
  };
  const options = (directory: string, extras: string[] = []): TrialConfigurationOptions => parseTrialConfigurationArgs([
    "--test", "--policy=retain_credit", `--output=${join(directory, "result.json")}`, ...extras,
  ]);

  it("defaults to discovery and reports missing resources without provisioning them", async () => {
    const fixture = providerFixture(false), opts = options(directory);
    expect(opts.provision).toBe(false);
    const result = await prepareTrialConfiguration(fixture.stripe, opts, env);
    expect(result).toMatchObject({ operation: "read_only", verified: false, enabled: false,
      missing: ["advance_product", "advance_price", "starter_coupon", "standard_coupon", "pro_coupon", "payment_method_configuration"] });
    expect(result.environment.STRIPE_TRIAL_ADVANCE_ENABLED).toBe("false");
    noMutations(fixture);
  });

  it("verifies existing configuration into a fresh private, secret-free output without enabling the process", async () => {
    const fixture = providerFixture(), opts = options(directory);
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_ENABLED", "false");
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_PRICE_ID", "price_original_process_value");
    env.RESEND_API_KEY = "fixture-unrelated-secret";
    const result = await prepareTrialConfiguration(fixture.stripe, opts, env);
    expect(result).toMatchObject({ verified: true, enabled: false, webhookReady: true, signatureDeliveryVerified: false, missing: [] });
    expect(process.env.STRIPE_TRIAL_ADVANCE_ENABLED).toBe("false");
    expect(process.env.STRIPE_TRIAL_ADVANCE_PRICE_ID).toBe("price_original_process_value");
    expect((await stat(opts.output)).mode & 0o777).toBe(0o600);
    const raw = await readFile(opts.output, "utf8");
    expect(JSON.parse(raw)).toEqual(result);
    for (const value of [env.STRIPE_SECRET_KEY!, env.STRIPE_WEBHOOK_SECRET!, env.RESEND_API_KEY!, "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
      expect(raw).not.toContain(value);
    }
    noMutations(fixture);
  });

  it("rediscovers all existing scoped coupons by expanding their hidden restrictions before provisioning", async () => {
    const fixture = providerFixture();
    const result = await prepareTrialConfiguration(fixture.stripe, options(directory, ["--provision"]), env);
    expect(result).toMatchObject({ verified: true, missing: [], enabled: false });
    for (const tier of TIERS) {
      expect(fixture.api.coupons.retrieve).toHaveBeenCalledWith(`cheaterfinder_trial_founders_${tier.plan}_v1`,
        { expand: ["applies_to"] }, expect.objectContaining({ timeout: 20_000 }));
    }
    noMutations(fixture);
  });

  it.each([
    { mode: "test" as const, key: "sk_live_fixture", expected: "acct_fixture" },
    { mode: "live" as const, key: "sk_test_fixture", expected: "acct_fixture" },
    { mode: "live" as const, key: "sk_live_fixture", expected: "" },
  ])("rejects $mode credentials/account omissions before any provider request ($key/$expected)", async ({ mode, key, expected }) => {
    const fixture = providerFixture();
    await expect(prepareTrialConfiguration(fixture.stripe, { ...options(directory, ["--provision"]), mode },
      { ...env, STRIPE_SECRET_KEY: key, STRIPE_EXPECTED_ACCOUNT_ID: expected })).rejects.toThrow(/STRIPE_SECRET_KEY|STRIPE_EXPECTED_ACCOUNT_ID/);
    expect(fixture.api.accounts.retrieve).not.toHaveBeenCalled();
    noMutations(fixture);
  });

  it("stops after account identity mismatch before reading or creating catalog resources", async () => {
    const fixture = providerFixture(false);
    await expect(prepareTrialConfiguration(fixture.stripe, options(directory, ["--provision"]),
      { ...env, STRIPE_EXPECTED_ACCOUNT_ID: "acct_other" })).rejects.toThrow("account identity");
    expect(fixture.api.accounts.retrieve).toHaveBeenCalledTimes(1);
    expect(fixture.api.prices.retrieve).not.toHaveBeenCalled();
    noMutations(fixture);
  });

  it("refuses test catalog responses during an explicitly live operation", async () => {
    const fixture = providerFixture(false);
    await expect(prepareTrialConfiguration(fixture.stripe, { ...options(directory, ["--provision"]), mode: "live" },
      { ...env, STRIPE_SECRET_KEY: "sk_live_fixture" })).rejects.toThrow("active USD monthly anchor/product");
    noMutations(fixture);
  });

  it.each(["retain_credit", "refund_during_trial"] as const)("provisions only a dedicated 99-cent catalog and selected %s configuration", async policy => {
    const fixture = providerFixture(false);
    const originals = clone({ defaultMethod: fixture.methods[0], defaultPortal: fixture.portals[0],
      recurring: TIERS.map(tier => fixture.prices.get(`price_${tier.plan}`)),
      legacyCoupons: TIERS.map(tier => fixture.coupons.get(`legacy_${tier.plan}`)) });
    const opts = { ...options(directory, ["--provision"]), policy };
    const result = await prepareTrialConfiguration(fixture.stripe, opts, env);
    expect(result).toMatchObject({ verified: true, operation: "provision", enabled: false, environment: { STRIPE_TRIAL_ADVANCE_ENABLED: "false" } });
    expect(fixture.api.products.create).toHaveBeenCalledTimes(1);
    expect(fixture.api.prices.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ product: PRODUCT, currency: "usd", unit_amount: 99 }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }));
    expect(fixture.api.prices.create.mock.calls[0][0]).not.toHaveProperty("recurring");
    expect(fixture.api.coupons.create).toHaveBeenCalledTimes(3);
    for (const tier of TIERS) {
      const coupon = fixture.coupons.get(`cheaterfinder_trial_founders_${tier.plan}_v1`)!;
      expect(coupon).toMatchObject({ amount_off: tier.discount, currency: "usd", duration: "forever", applies_to: { products: [`prod_${tier.plan}`] } });
      expect(coupon.applies_to.products).not.toContain(PRODUCT);
      expect(tier.anchor - coupon.amount_off).toBe(tier.recurring);
    }
    const methodParams = fixture.api.paymentMethodConfigurations.create.mock.calls[0][0];
    const enabled = Object.entries(methodParams).filter(([, value]) => value?.display_preference?.preference === "on").map(([key]) => key).sort();
    expect(enabled).toEqual(["apple_pay", "card", "google_pay"]);
    for (const method of ["us_bank_account", "sepa_debit", "acss_debit", "customer_balance", "link", "scalapay"]) {
      expect(methodParams[method]).toEqual({ display_preference: { preference: "off" } });
    }
    if (policy === "refund_during_trial") {
      expect(fixture.api.billingPortal.configurations.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        default_return_url: `${ORIGIN}/settings?tab=billing`,
        features: expect.objectContaining({ subscription_cancel: { enabled: true, mode: "immediately", proration_behavior: "none" },
          subscription_update: { enabled: false }, payment_method_update: { enabled: true, payment_method_configuration: "pmc_advance" } }),
      }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
      expect(result.environment.STRIPE_TRIAL_REFUND_PORTAL_CONFIG_ID).toBe("bpc_advance");
    } else {
      expect(fixture.api.billingPortal.configurations.create).not.toHaveBeenCalled();
      expect(result.environment.STRIPE_TRIAL_REFUND_PORTAL_CONFIG_ID).toBe("");
    }
    expect({ defaultMethod: fixture.methods[0], defaultPortal: fixture.portals[0],
      recurring: TIERS.map(tier => fixture.prices.get(`price_${tier.plan}`)),
      legacyCoupons: TIERS.map(tier => fixture.coupons.get(`legacy_${tier.plan}`)) }).toEqual(originals);
    expect(fixture.forbidden).not.toHaveBeenCalled();
    const writes = fixture.creates.map(create => create.mock.calls.length);
    await prepareTrialConfiguration(fixture.stripe, { ...opts, output: join(directory, "rerun.json") }, env);
    expect(fixture.creates.map(create => create.mock.calls.length)).toEqual(writes);
    expect(fixture.forbidden).not.toHaveBeenCalled();
  });

  it("rediscovers a configuration created before a lost response instead of creating another one", async () => {
    const fixture = providerFixture(false), create = fixture.api.paymentMethodConfigurations.create.getMockImplementation()!;
    fixture.api.paymentMethodConfigurations.create.mockImplementationOnce(async params => {
      await create(params); throw new Error("Provider response lost after creation");
    });
    const opts = options(directory, ["--provision"]);
    await expect(prepareTrialConfiguration(fixture.stripe, opts, env)).rejects.toThrow("response lost");
    await expect(stat(opts.output)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await prepareTrialConfiguration(fixture.stripe, opts, env);
    expect(result.verified).toBe(true);
    expect(fixture.api.products.create).toHaveBeenCalledTimes(1);
    expect(fixture.api.prices.create).toHaveBeenCalledTimes(1);
    expect(fixture.api.coupons.create).toHaveBeenCalledTimes(3);
    expect(fixture.api.paymentMethodConfigurations.create).toHaveBeenCalledTimes(1);
    expect(fixture.forbidden).not.toHaveBeenCalled();
  });

  it("accepts the additive Scalapay response only when the dedicated configuration explicitly disables it", async () => {
    const fixture = providerFixture();
    fixture.methods[0].scalapay = { available: false, display_preference: { preference: "none", value: "off" } };
    fixture.methods[1].scalapay = { available: false, display_preference: { preference: "off", value: "off" } };
    const result = await prepareTrialConfiguration(fixture.stripe, options(directory), env);
    expect(result.verified).toBe(true);
    noMutations(fixture);
  });

  it.each(["on", "none"] as const)("rejects a dedicated Scalapay preference of %s even when currently unavailable", async preference => {
    const fixture = providerFixture();
    fixture.methods[1].scalapay = { available: false, display_preference: { preference, value: "off" } };
    await expect(prepareTrialConfiguration(fixture.stripe, options(directory, ["--provision"]), env))
      .rejects.toThrow("every other method explicitly off");
    noMutations(fixture);
  });

  it.each([false, true])("fails on an unknown future method before writes even with a complete catalog=%s", async complete => {
    const fixture = providerFixture(complete);
    fixture.methods[0].future_bank_pay = { available: true, display_preference: { value: "off", preference: "off" } };
    await expect(prepareTrialConfiguration(fixture.stripe, options(directory, ["--provision"]), env)).rejects.toThrow("unknown to the reviewed configuration schema");
    noMutations(fixture);
  });

  it("does not repair or overwrite a dedicated identifier already owned by another configuration", async () => {
    const fixture = providerFixture();
    fixture.products.get(PRODUCT)!.metadata = { trialPaymentPolicy: "unrelated-policy" };
    await expect(prepareTrialConfiguration(fixture.stripe, options(directory, ["--provision"]), env)).rejects.toThrow("different or inactive product");
    noMutations(fixture);
  });

  it("does not treat authorization failures as missing resources to create", async () => {
    const fixture = providerFixture(false);
    fixture.api.coupons.retrieve.mockRejectedValueOnce(Object.assign(new Error("Fixture permission failure"), { code: "permission_denied" }));
    await expect(prepareTrialConfiguration(fixture.stripe, options(directory, ["--provision"]), env)).rejects.toThrow("permission failure");
    noMutations(fixture);
  });

  it("refuses ambiguous names and truncated configuration history before provisioning", async () => {
    const fixture = providerFixture();
    fixture.methods.push({ ...clone(fixture.methods[1]), id: "pmc_duplicate" });
    await expect(prepareTrialConfiguration(fixture.stripe, options(directory, ["--provision"]), env)).rejects.toThrow("names are ambiguous");
    noMutations(fixture);
    fixture.api.paymentMethodConfigurations.list.mockResolvedValueOnce({ data: [], has_more: true });
    await expect(prepareTrialConfiguration(fixture.stripe, options(directory, ["--provision"]), env)).rejects.toThrow("continuation");
    noMutations(fixture);
  });

  it("restores the original runtime environment even if final configuration verification fails", async () => {
    const fixture = providerFixture();
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_ENABLED", "false");
    vi.stubEnv("STRIPE_TRIAL_ADVANCE_PRICE_ID", "price_original_process_value");
    fixture.api.paymentMethodConfigurations.retrieve.mockRejectedValueOnce(new Error("Runtime verification unavailable"));
    await expect(prepareTrialConfiguration(fixture.stripe, options(directory), env)).rejects.toThrow("verification unavailable");
    expect(process.env.STRIPE_TRIAL_ADVANCE_ENABLED).toBe("false");
    expect(process.env.STRIPE_TRIAL_ADVANCE_PRICE_ID).toBe("price_original_process_value");
    await expect(stat(options(directory).output)).rejects.toMatchObject({ code: "ENOENT" });
    noMutations(fixture);
  });

  it.each(["existing file", "symlink"])("refuses an %s output before any provider request", async kind => {
    const fixture = providerFixture(false), opts = options(directory, ["--provision"]);
    const sentinel = kind === "existing file" ? opts.output : join(directory, "sentinel.json");
    await writeFile(sentinel, "keep this content", { mode: 0o600 });
    if (kind === "symlink") await symlink(sentinel, opts.output);
    await expect(prepareTrialConfiguration(fixture.stripe, opts, env)).rejects.toThrow("output file already exists");
    expect(await readFile(sentinel, "utf8")).toBe("keep this content");
    expect(fixture.api.accounts.retrieve).not.toHaveBeenCalled();
    noMutations(fixture);
  });

  it("rejects a /tmp output directory symlink that resolves outside /tmp", async () => {
    const fixture = providerFixture(false);
    await symlink(process.cwd(), join(directory, "outside"));
    const opts = { ...options(directory, ["--provision"]), output: join(directory, "outside", "fixture-output.json") };
    await expect(prepareTrialConfiguration(fixture.stripe, opts, env)).rejects.toThrow("resolve inside /tmp");
    expect(fixture.api.accounts.retrieve).not.toHaveBeenCalled();
    noMutations(fixture);
  });

  it.each([
    ["--policy=retain_credit", "--output=/tmp/result.json"],
    ["--test", "--live", "--policy=retain_credit", "--output=/tmp/result.json"],
    ["--test", "--test", "--policy=retain_credit", "--output=/tmp/result.json"],
    ["--test", "--policy=undecided", "--output=/tmp/result.json"],
    ["--test", "--policy=retain_credit", "--output=/root/result.json"],
    ["--test", "--policy=retain_credit", "--output=/tmp/../root/result.json"],
    ["--test", "--policy=retain_credit", "--output=/tmp/result.json", "--enable"],
  ])("rejects incomplete or unsafe operator arguments %j", (...args) => {
    expect(() => parseTrialConfigurationArgs(args)).toThrow();
  });
});

describe("trial webhook readiness — subscription coverage is not proof of signed delivery", () => {
  it("accepts explicit coverage or wildcard on the correct endpoint while recording delivery as unverified", () => {
    for (const enabled_events of [[...REQUIRED_EVENTS], ["*"]]) {
      expect(webhookReadiness([endpoint({ enabled_events })], false, ORIGIN, environment())).toMatchObject({
        ready: true, subscribed: true, signingSecretConfigured: true, signatureDeliveryVerified: false,
        endpointIds: ["we_fixture"], coverage: [{ id: "we_fixture", missingEvents: [] }],
      });
    }
  });

  it("requires late refund failures and refuses to borrow coverage from a foreign endpoint", () => {
    const result = webhookReadiness([
      endpoint({ enabled_events: REQUIRED_EVENTS.filter(event => event !== "refund.failed") }),
      endpoint({ id: "we_other", url: "https://other.example.test/api/webhooks/stripe", enabled_events: ["*"] }),
    ], false, ORIGIN, environment());
    expect(result).toMatchObject({ ready: false, subscribed: false, endpointIds: ["we_fixture"],
      coverage: [{ id: "we_fixture", missingEvents: ["refund.failed"] }] });
  });

  it.each([
    { livemode: true }, { status: "disabled" }, { application: "ca_other" },
    { url: `${ORIGIN}/wrong-path` }, { url: `${ORIGIN}/api/webhooks/stripe?other=true` },
    { url: "http://billing.example.test/api/webhooks/stripe" }, { url: "https://other.example.test/api/webhooks/stripe" },
  ])("ignores endpoints that do not match this account mode and application origin: %j", overrides => {
    expect(webhookReadiness([endpoint(overrides)], false, ORIGIN, environment())).toMatchObject({
      ready: false, subscribed: false, endpointIds: [], coverage: [],
    });
  });

  it.each([{ STRIPE_WEBHOOK_SECRET: "" }, { STRIPE_WEBHOOK_ALLOW_UNVERIFIED: "true" }])("rejects missing/disabled signature verification %j", overrides => {
    expect(webhookReadiness([endpoint()], false, ORIGIN, { ...environment(), ...overrides })).toMatchObject({
      ready: false, subscribed: true, signingSecretConfigured: false, signatureDeliveryVerified: false,
    });
  });
});
