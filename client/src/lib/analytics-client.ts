import type { CaptureResult, PostHogConfig } from "posthog-js";
import { ANALYTICS_CONSENT_KEY, POSTHOG_API_HOST, UUID_PATTERN, analyticsPage,
  analyticsUser, productEventProperties, type AnalyticsConsent, type AnalyticsUser,
  type ProductEvent } from "../../../shared/product-analytics";

export interface AnalyticsSdk {
  init(key: string, config: Partial<PostHogConfig>): unknown;
  capture(event: string, properties?: Record<string, unknown>, options?: { send_instantly: true; transport: "sendBeacon" }): unknown;
  identify(id: string): unknown;
  get_distinct_id(): string;
  reset(resetDeviceId?: boolean): void;
  opt_in_capturing(options?: { captureEventName?: false }): void;
  opt_out_capturing(): void;
}
interface Dependencies {
  key: string;
  enabled: boolean;
  path(): string;
  readConsent(): string | null;
  writeConsent(consent: AnalyticsConsent): void;
  privacySignal(): boolean;
  loadSdk(): Promise<AnalyticsSdk>;
  fetchUser(): Promise<unknown>;
  sendNavigationEvent?(event: CaptureResult): void;
}

const IDENTIFIERS = new Set(["distinct_id", "$device_id", "$session_id", "$window_id", "$anon_distinct_id"]);
const NUMBERS = new Set(["$screen_height", "$screen_width", "$viewport_height", "$viewport_width"]);
const BOOLEAN_PROPERTIES = new Set(["$is_identified", "$process_person_profile"]);
const SDK_PROPERTIES = new Set(["$lib", "$lib_version", "$browser", "$browser_version", "$os", "$os_version", "$device_type"]);

/** Reconstruct the payload from an allowlist, including top-level person props.
 * Raw URLs/referrers, DOM text, errors, tokens and initial person properties do
 * not survive this boundary even if a future SDK default adds them. */
export function sanitizeAnalyticsEvent(event: CaptureResult | null, path: string, projectToken: string): CaptureResult | null {
  const page = analyticsPage(path);
  if (!event || !page || (event.event !== "$pageview" && event.event !== "$identify" && !productEventProperties(event.event))) return null;
  const properties: Record<string, unknown> = {
    // Required SDK protocol field, not an application/session token. Reinsert
    // the configured public project token rather than trusting event input.
    token: projectToken,
    ...productEventProperties(event.event, event.properties),
    page_name: page.name, $pathname: page.path, $current_url: `https://cheaterfinder.com${page.path}`,
  };
  for (const [key, value] of Object.entries(event.properties)) {
    if (IDENTIFIERS.has(key) && typeof value === "string" && UUID_PATTERN.test(value.replace(/^customer:/, ""))) properties[key] = value;
    else if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value)) properties[key] = value;
    else if (BOOLEAN_PROPERTIES.has(key) && typeof value === "boolean") properties[key] = value;
    else if (SDK_PROPERTIES.has(key) && (typeof value === "string" || typeof value === "number")) properties[key] = value;
  }
  // Missing/unsafe identity must not turn into an unscoped or email-identified event.
  if (!properties.distinct_id) return null;
  return { uuid: event.uuid, event: event.event, properties, ...(event.timestamp ? { timestamp: event.timestamp } : {}) };
}

export function createProductAnalytics(deps: Dependencies) {
  const configured = deps.enabled && /^phc_[A-Za-z0-9_-]{20,200}$/.test(deps.key);
  let consent: AnalyticsConsent = "undecided";
  let sdk: AnalyticsSdk | undefined;
  let loading: Promise<AnalyticsSdk | null> | undefined;
  let user: AnalyticsUser | undefined;
  let consentVersion = 0, identityVersion = 0;
  let lastPage: string | null = null;
  const listeners = new Set<() => void>();
  const readConsent = (): AnalyticsConsent => {
    try { const value = deps.readConsent(); return value === "accepted" || value === "rejected" ? value : "undecided"; }
    catch { return "undecided"; }
  };
  consent = readConsent();
  const permitted = () => configured && consent === "accepted" && !deps.privacySignal() && user !== "admin" && !!analyticsPage(deps.path());
  const stop = () => {
    consentVersion++; loading = undefined; lastPage = null;
    try { sdk?.opt_out_capturing(); sdk?.reset(true); } catch { /* Analytics never breaks the app. */ }
  };
  const syncIdentity = (client: AnalyticsSdk) => {
    const desired = user && user !== "admin" ? `customer:${user.id}` : null;
    const current = client.get_distinct_id();
    if (current.startsWith("customer:") && current !== desired) {
      client.opt_out_capturing(); client.reset(true);
    }
    // PostHog1.428 resets consent with identity: always opt in AFTER reset.
    client.opt_in_capturing({ captureEventName: false });
    if (desired && client.get_distinct_id() !== desired) client.identify(desired);
  };
  const ensure = (): Promise<AnalyticsSdk | null> => {
    if (!permitted()) return Promise.resolve(null);
    if (loading) return loading;
    const version = consentVersion;
    const promise = (async () => {
      try {
        if (user === undefined) {
          const identity = identityVersion;
          const value = await deps.fetchUser();
          if (version !== consentVersion || !permitted()) return null;
          if (identity === identityVersion) user = analyticsUser(value);
        }
        if (!permitted()) return null;
        if (!sdk) {
          const client = await deps.loadSdk();
          if (version !== consentVersion || !permitted()) return null;
          client.init(deps.key, {
            api_host: POSTHOG_API_HOST, defaults: "2026-05-30",
            capture_pageview: false, capture_pageleave: false, autocapture: false,
            capture_dead_clicks: false, capture_heatmaps: false, capture_exceptions: false,
            capture_performance: false, rageclick: false, disable_session_recording: true,
            disable_surveys: true, disable_external_dependency_loading: true,
            disable_web_experiments: true, disable_conversations: true, disable_product_tours: true,
            internal_or_test_user_hostname: null,
            advanced_disable_flags: true, remote_config_refresh_interval_ms: 0,
            enable_recording_console_log: false, mask_all_text: true, mask_all_element_attributes: true,
            save_referrer: false, save_campaign_params: false, disable_capture_url_hashes: true,
            mask_personal_data_properties: true, person_profiles: "identified_only",
            persistence: "localStorage", opt_out_capturing_by_default: true,
            opt_out_persistence_by_default: true, respect_dnt: true,
            request_batching: true, debug: false,
            before_send: event => permitted() ? sanitizeAnalyticsEvent(event, deps.path(), deps.key) : null,
          });
          sdk = client;
        }
        if (version !== consentVersion || !permitted()) return null;
        syncIdentity(sdk);
        return sdk;
      } catch { return null; } // Blocked SDK/network/storage cannot block product flows.
    })();
    loading = promise;
    void promise.finally(() => { if (loading === promise) loading = undefined; });
    return promise;
  };
  const page = async () => {
    try {
      if (!analyticsPage(deps.path())) { stop(); return; }
      const client = await ensure();
      const path = deps.path().split(/[?#]/, 1)[0];
      if (!client || !permitted() || lastPage === path) return;
      lastPage = path;
      client.capture("$pageview");
    } catch { /* No analytics error reaches a React event/effect. */ }
  };
  const updateConsent = (next: AnalyticsConsent, persist: boolean) => {
    if (next === consent) return;
    consent = next;
    if (persist) { try { deps.writeConsent(next); } catch { /* Session-only choice when storage is blocked. */ } }
    if (next !== "accepted") stop();
    for (const listener of listeners) listener();
    if (next === "accepted") void page();
  };
  return {
    configured, privacyBlocked: deps.privacySignal, getConsent: () => consent,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setConsent(next: AnalyticsConsent) { updateConsent(next, true); },
    refreshConsent() { updateConsent(readConsent(), false); },
    page,
    setUser(value: unknown) {
      const next = analyticsUser(value);
      if (next === user || (next && user && typeof next === "object" && typeof user === "object" && next.id === user.id)) return;
      user = next; identityVersion++;
      if (user === "admin") stop();
      else if (sdk && permitted()) { try { syncIdentity(sdk); } catch { /* Optional integration. */ } }
    },
    resetIdentity() { user = null; identityVersion++; stop(); },
    trackCheckoutBeforeNavigation(plan: string) {
      // A zero-latency checkout can unload the page before the lazy SDK import
      // resolves. Never hold payment hostage to analytics or enqueue a duplicate.
      if (!permitted() || !user || user === "admin") return;
      try {
        const properties = productEventProperties("checkout_started", { plan })!;
        if (sdk) { sdk.capture("checkout_started", properties, { send_instantly: true, transport: "sendBeacon" }); return; }
        const event = sanitizeAnalyticsEvent({ uuid: crypto.randomUUID(), event: "checkout_started", timestamp: new Date(),
          properties: { ...properties, distinct_id: `customer:${user.id}`, $is_identified: true, $process_person_profile: true },
        }, deps.path(), deps.key);
        if (event) deps.sendNavigationEvent?.(event);
      } catch { /* Checkout always proceeds, including blocked analytics. */ }
    },
    async track(event: ProductEvent, properties: Record<string, unknown> = {}) {
      const safe = productEventProperties(event, properties), identity = identityVersion;
      if (!safe || !permitted()) return;
      try {
        // Already initialized SDK captures synchronously before a successful
        // checkout navigates away. Never await analytics in the product flow.
        const client = sdk && user !== undefined ? sdk : await ensure();
        if (client && permitted() && identity === identityVersion) client.capture(event, safe);
      } catch { /* Never fail checkout/auth/tracking on analytics failure. */ }
    },
  };
}

export { ANALYTICS_CONSENT_KEY };
