import { describe, expect, it, vi } from "vitest";
import type { CaptureResult, PostHogConfig } from "posthog-js";
import { createProductAnalytics, sanitizeAnalyticsEvent, type AnalyticsSdk } from "../analytics-client";
import { analyticsPage, analyticsUser, productEventProperties } from "../../../../shared/product-analytics";

const KEY = "phc_fixture_project_token_not_a_real_project";
const ANON = "01992345-6789-7abc-8def-012345678901";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

function fixture(options: { consent?: string; path?: string; enabled?: boolean; key?: string } = {}) {
  const state = { consent: options.consent ?? null, path: options.path ?? "/", blocked: false };
  let id = ANON, config: Partial<PostHogConfig> = {};
  const sent: CaptureResult[] = [];
  const sdk: AnalyticsSdk = {
    init: vi.fn((_key, next) => { config = next; }),
    get_distinct_id: vi.fn(() => id),
    identify: vi.fn(next => { id = next; sdk.capture("$identify", { $anon_distinct_id: ANON }); }),
    reset: vi.fn(() => { id = ANON; }), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(),
    capture: vi.fn((event, properties = {}) => {
      const hook = config.before_send as (value: CaptureResult) => CaptureResult | null;
      const value = hook({ uuid: ANON, event, properties: {
        token: KEY, distinct_id: id, $current_url: "https://cheaterfinder.com/reset-password?token=SECRET",
        $referrer: "https://source.invalid/?email=private@example.invalid", ...properties,
      } });
      if (value) sent.push(value);
    }),
  };
  const deps = {
    key: options.key ?? KEY, enabled: options.enabled ?? true,
    path: () => state.path, privacySignal: () => state.blocked,
    readConsent: vi.fn(() => state.consent), writeConsent: vi.fn(value => { state.consent = value; }),
    loadSdk: vi.fn(async () => sdk), fetchUser: vi.fn(async (): Promise<unknown> => null),
    sendNavigationEvent: vi.fn(),
  };
  return { analytics: createProductAnalytics(deps), deps, state, sdk, sent, config: () => config };
}

describe("PostHog data boundary", () => {
  it.each(["/admin", "/admin/health", "/admin/users?email=secret", "/unknown/secret", "//evil.invalid", "/__proto__"])("excludes %s", path => {
    expect(analyticsPage(path)).toBeNull();
  });
  it("templates tracked-row routes and strips all URL parameters", () => {
    expect(analyticsPage("/dashboard/secret-row?username=private#token")).toEqual({ path: "/dashboard/:id", name: "dashboard" });
    expect(analyticsPage("/reset-password?token=SECRET#private")).toEqual({ path: "/reset-password", name: "reset_password" });
  });
  it("limits product fields to known enums, never arbitrary payloads", () => {
    expect(productEventProperties("checkout_started", { plan: "pro", email: "private", token: "secret" })).toEqual({ plan: "pro" });
    expect(productEventProperties("checkout_started", { plan: "private@example.invalid" })).toEqual({});
    expect(productEventProperties("arbitrary_event", {})).toBeNull();
  });
  it("uses only opaque customer UUIDs and excludes admins", () => {
    expect(analyticsUser({ id: USER_A, email: "private@example.invalid" })).toEqual({ id: USER_A });
    expect(analyticsUser({ id: "private@example.invalid" })).toBeNull();
    expect(analyticsUser({ id: USER_A, role: "admin" })).toBe("admin");
    expect(analyticsUser({ id: USER_A, isAdmin: true })).toBe("admin");
  });
  it("preserves ingestion protocol but removes both levels of person/URL/DOM data", () => {
    const result = sanitizeAnalyticsEvent({ uuid: ANON, event: "$identify", $set: { email: "SECRET" }, $set_once: { name: "SECRET" }, properties: {
      token: "untrusted", distinct_id: `customer:${USER_A}`, $anon_distinct_id: ANON,
      $set: { email: "SECRET" }, $set_once: { $initial_current_url: "SECRET" },
      $current_url: "SECRET", $pathname: "SECRET", $referrer: "SECRET", $elements: ["SECRET"],
      password: "SECRET", session_id: "SECRET", username: "SECRET", $browser: "Chrome", $screen_height: 844,
    } }, "/dashboard/private-id?token=SECRET", KEY);
    expect(result?.properties.token).toBe(KEY);
    expect(result?.properties.distinct_id).toBe(`customer:${USER_A}`);
    expect(result?.properties.$anon_distinct_id).toBe(ANON);
    expect(result?.properties.$current_url).toBe("https://cheaterfinder.com/dashboard/:id");
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private-id|untrusted|\$set|\$elements/);
  });
  it.each(["$autocapture", "$snapshot", "$exception", "$set", "$opt_in", "unknown"])("rejects unexpected event %s", event => {
    expect(sanitizeAnalyticsEvent({ uuid: ANON, event, properties: { distinct_id: ANON } }, "/", KEY)).toBeNull();
  });
  it("drops missing or unsafe identities", () => {
    for (const id of [undefined, "person@example.invalid", "admin"]) expect(sanitizeAnalyticsEvent({ uuid: ANON, event: "$pageview", properties: { distinct_id: id } }, "/", KEY)).toBeNull();
  });
});

describe("consent, identity and failure lifecycle", () => {
  it.each([undefined, "rejected", "garbage"])("sends/loads nothing without explicit consent: %s", async consent => {
    const f = fixture({ consent }); await f.analytics.page(); await f.analytics.track("tracking_account_added");
    expect(f.deps.loadSdk).not.toHaveBeenCalled(); expect(f.deps.fetchUser).not.toHaveBeenCalled();
  });
  it.each([{ enabled: false }, { key: "" }, { key: "phx_personal_key" }])("fails closed for disabled/unconfigured builds %j", async options => {
    const f = fixture({ ...options, consent: "accepted" }); await f.analytics.page();
    expect(f.analytics.configured).toBe(false); expect(f.deps.loadSdk).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent setup/page effects and disables risky automatic features", async () => {
    const f = fixture(); f.analytics.setConsent("accepted"); await Promise.all([f.analytics.page(), f.analytics.page()]);
    expect(f.deps.loadSdk).toHaveBeenCalledTimes(1); expect(f.deps.fetchUser).toHaveBeenCalledTimes(1);
    expect(f.sent.filter(e => e.event === "$pageview")).toHaveLength(1);
    expect(f.config()).toMatchObject({ api_host: "https://us.i.posthog.com", capture_pageview: false, autocapture: false,
      disable_session_recording: true, capture_exceptions: false, capture_performance: false,
      advanced_disable_flags: true, disable_external_dependency_loading: true, opt_out_capturing_by_default: true });
  });
  it("captures SPA navigation once without raw IDs, query tokens or duplicate views", async () => {
    const f = fixture({ consent: "accepted" }); await f.analytics.page();
    f.state.path = "/dashboard/private?token=SECRET"; await f.analytics.page(); await f.analytics.page();
    f.state.path = "/dashboard/second"; await f.analytics.page();
    expect(f.sent).toHaveLength(3); expect(JSON.stringify(f.sent)).not.toMatch(/private|SECRET|second/);
  });
  it("honors browser privacy signals even with accepted storage", async () => {
    const f = fixture({ consent: "accepted" }); f.state.blocked = true; await f.analytics.page();
    expect(f.deps.loadSdk).not.toHaveBeenCalled();
  });
  it("excludes admin routes without even probing identity", async () => {
    const f = fixture({ consent: "accepted", path: "/admin/health" }); await f.analytics.page();
    expect(f.deps.fetchUser).not.toHaveBeenCalled(); expect(f.deps.loadSdk).not.toHaveBeenCalled();
  });
  it("excludes signed-in admins on otherwise public pages", async () => {
    const f = fixture({ consent: "accepted" }); f.deps.fetchUser.mockResolvedValue({ id: USER_A, role: "admin" });
    await f.analytics.page(); expect(f.deps.loadSdk).not.toHaveBeenCalled();
  });
  it("identifies consented customers without any contact/person properties", async () => {
    const f = fixture({ consent: "accepted" }); f.deps.fetchUser.mockResolvedValue({ id: USER_A, name: "SECRET", email: "SECRET" });
    await f.analytics.page(); expect(f.sdk.identify).toHaveBeenCalledWith(`customer:${USER_A}`);
    expect(JSON.stringify(f.sent)).not.toContain("SECRET");
  });
  it("resets identity before opting back in on logout/account switch", async () => {
    const f = fixture({ consent: "accepted" }); f.analytics.setUser({ id: USER_A }); await f.analytics.page();
    f.analytics.resetIdentity(); f.state.path = "/auth"; await f.analytics.page();
    expect(f.sdk.reset).toHaveBeenCalledWith(true);
    expect(f.sent.at(-1)?.properties.distinct_id).toBe(ANON);
    f.analytics.setUser({ id: USER_B }); await f.analytics.track("auth_succeeded", { method: "login", entry: "auth" });
    expect(f.sent.at(-1)?.properties.distinct_id).toBe(`customer:${USER_B}`);
    expect(f.sdk.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
  });
  it("withdraws consent immediately and ignores subsequent events", async () => {
    const f = fixture({ consent: "accepted" }); await f.analytics.page(); const before = f.sent.length;
    f.analytics.setConsent("rejected"); await f.analytics.track("tracking_account_added"); await f.analytics.page();
    expect(f.sent).toHaveLength(before); expect(f.sdk.opt_out_capturing).toHaveBeenCalled();
  });
  it("revocation during lazy import cannot initialize/capture afterwards", async () => {
    const f = fixture({ consent: "accepted" }), pending = deferred<AnalyticsSdk>();
    f.deps.loadSdk.mockReturnValue(pending.promise); const run = f.analytics.page(); await tick();
    f.analytics.setConsent("rejected"); pending.resolve(f.sdk); await run;
    expect(f.sdk.init).not.toHaveBeenCalled(); expect(f.sent).toHaveLength(0);
  });
  it("an old auth probe cannot re-identify a customer after logout", async () => {
    const f = fixture({ consent: "accepted" }), pending = deferred<unknown>();
    f.deps.fetchUser.mockReturnValue(pending.promise); const run = f.analytics.page();
    f.analytics.resetIdentity(); pending.resolve({ id: USER_A }); await run;
    await f.analytics.page(); expect(f.sdk.identify).not.toHaveBeenCalled();
  });
  it("navigation to admin while loading cannot capture the previous public page", async () => {
    const f = fixture({ consent: "accepted" }), pending = deferred<AnalyticsSdk>();
    f.deps.loadSdk.mockReturnValue(pending.promise); const run = f.analytics.page(); await tick();
    f.state.path = "/admin"; pending.resolve(f.sdk); await run;
    expect(f.sdk.init).not.toHaveBeenCalled();
  });
  it("reflects opt-out from another tab", async () => {
    const f = fixture({ consent: "accepted" }); await f.analytics.page();
    f.state.consent = "rejected"; f.analytics.refreshConsent(); await f.analytics.track("report_requested", { period: "weekly" });
    expect(f.analytics.getConsent()).toBe("rejected"); expect(f.sent).toHaveLength(1);
  });
  it("storage denial still permits an in-tab choice without throwing", async () => {
    const f = fixture(); f.deps.writeConsent.mockImplementation(() => { throw new Error("denied"); });
    expect(() => f.analytics.setConsent("accepted")).not.toThrow(); await f.analytics.page();
    expect(f.sent).toHaveLength(1);
  });
  it("blocked SDK/auth requests do not fail the app or permanently poison a retry", async () => {
    const f = fixture({ consent: "accepted" }); f.deps.loadSdk.mockRejectedValueOnce(new Error("blocked"));
    await expect(f.analytics.page()).resolves.toBeUndefined(); expect(f.sent).toHaveLength(0);
    await f.analytics.page(); expect(f.sent).toHaveLength(1);
  });
  it("auth lookup failure does not mislabel an unknown session as anonymous", async () => {
    const f = fixture({ consent: "accepted" }); f.deps.fetchUser.mockRejectedValueOnce(new Error("503"));
    await f.analytics.page(); expect(f.deps.loadSdk).not.toHaveBeenCalled();
    await f.analytics.page(); expect(f.sent).toHaveLength(1);
  });
  it("SDK exceptions never escape a successful product action", async () => {
    const f = fixture({ consent: "accepted" }); await f.analytics.page();
    vi.mocked(f.sdk.capture).mockImplementation(() => { throw new Error("SDK error"); });
    await expect(f.analytics.track("checkout_started", { plan: "pro" })).resolves.toBeUndefined();
  });
  it("captures cold-SDK checkout synchronously without loading or awaiting analytics", () => {
    const f = fixture({ consent: "accepted", path: "/payment?token=SECRET" });
    f.analytics.setUser({ id: USER_A, email: "SECRET" }); f.analytics.trackCheckoutBeforeNavigation("pro");
    expect(f.deps.loadSdk).not.toHaveBeenCalled(); expect(f.deps.sendNavigationEvent).toHaveBeenCalledTimes(1);
    const event = f.deps.sendNavigationEvent.mock.calls[0][0] as CaptureResult;
    expect(event.event).toBe("checkout_started");
    expect(event.properties).toMatchObject({ distinct_id: `customer:${USER_A}`, plan: "pro", $pathname: "/payment" });
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });
  it("uses one immediate SDK beacon, not a second fallback, when initialized", async () => {
    const f = fixture({ consent: "accepted", path: "/payment" }); f.analytics.setUser({ id: USER_A });
    await f.analytics.page(); f.analytics.trackCheckoutBeforeNavigation("standard");
    expect(f.sdk.capture).toHaveBeenLastCalledWith("checkout_started", { plan: "standard" }, { send_instantly: true, transport: "sendBeacon" });
    expect(f.deps.sendNavigationEvent).not.toHaveBeenCalled();
  });
  it.each(["rejected", "undecided"])("never beacons checkout without consent: %s", consent => {
    const f = fixture({ consent }); f.analytics.setUser({ id: USER_A }); f.analytics.trackCheckoutBeforeNavigation("pro");
    expect(f.deps.sendNavigationEvent).not.toHaveBeenCalled();
  });
  it("requires a known non-admin customer and no privacy signal for cold checkout", () => {
    const f = fixture({ consent: "accepted" }); f.analytics.trackCheckoutBeforeNavigation("pro");
    f.analytics.setUser({ id: USER_A, role: "admin" }); f.analytics.trackCheckoutBeforeNavigation("pro");
    f.analytics.setUser({ id: USER_A }); f.state.blocked = true; f.analytics.trackCheckoutBeforeNavigation("pro");
    expect(f.deps.sendNavigationEvent).not.toHaveBeenCalled();
  });
  it("a failing cold-SDK beacon never interrupts payment", () => {
    const f = fixture({ consent: "accepted" }); f.analytics.setUser({ id: USER_A });
    f.deps.sendNavigationEvent.mockImplementation(() => { throw new Error("blocked"); });
    expect(() => f.analytics.trackCheckoutBeforeNavigation("pro")).not.toThrow();
  });
});
