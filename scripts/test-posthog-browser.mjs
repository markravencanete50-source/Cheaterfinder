// Actual compiled app + installed SDK. ALL APIs synthetic, PostHog ingestion
// intercepted, all other outbound requests blocked. No real login/payment/IG.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import express from "express";
import { chromium } from "playwright";
const root = process.env.POSTHOG_TEST_BUILD;
if (!root?.startsWith("/tmp/cheaterfinder-posthog-build-")) throw new Error("Explicit temporary fixture build required");
const KEY = "phc_fixture_project_token_not_a_real_project";
const CONSENT = "cheaterfinder.analytics-consent.v1";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sensitive = ["SECRET_PASSWORD", "SECRET_TOKEN", "private@example.invalid", "private_instagram_target", ACCOUNT];
let user = null, accountAdded = false, ingestStatus = 200, sdkDelayMs = 0;
const now = new Date().toISOString();
const account = () => ({ id: ACCOUNT, igUsername: "private_instagram_target", displayName: "Private fixture", isActive: true,
  isPrivate: false, trackingStarted: now, accessStatus: "public", profileSnapshots: [{ snapshotAt: now, followerCount: 300, followingCount: 100, postCount: 0 }] });
const viewer = () => ({ igUsername: "private_instagram_target", displayName: "Private fixture", followerCount: 300, followingCount: 100,
  topNiche: "general", peakActivityHour: 12,
  postCount: 0, recentLikes: [], recentPosts: [], stories: [], highlights: [], recentFollows: [], recentUnfollows: [],
  recentFollowers: [], recentFollowerUnfollows: [], weeklyStats: { totalLikes: 0, totalFollows: 0, totalUnfollows: 0, totalPosts: 0 }, activityByHour: [], activityByDate: [],
  dataSource: "cached", cachedAt: now, rosterStatus: {
    followers: { loadedTotal: 300, expectedTotal: 300, isPartial: false, syncState: "complete", unfollowDetectionTrusted: true, lastCompleteReadAt: now },
    following: { loadedTotal: 100, expectedTotal: 100, isPartial: false, syncState: "complete", unfollowDetectionTrusted: true, lastCompleteReadAt: now },
  } });
const app = express();
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; connect-src 'self' https://us.i.posthog.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; media-src 'self' blob:; object-src 'none'");
  res.setHeader("Referrer-Policy", "no-referrer"); next();
});
app.use(express.static(root));
const shell = await readFile(root + "/index.html", "utf8");
app.use((_req, res) => res.type("html").send(shell));
const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const checks = [], observations = [];
const wait = async (condition, label, ms = 12_000) => {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await new Promise(r => setTimeout(r, 50)); }
};
const decode = buffer => {
  if (!buffer) throw new Error("Missing PostHog body");
  let data = buffer;
  if (data[0] === 31 && data[1] === 139) data = gunzipSync(data);
  let text = data.toString("utf8");
  if (text.startsWith("data=")) text = Buffer.from(new URLSearchParams(text).get("data"), "base64").toString("utf8");
  const value = JSON.parse(text);
  // Current SDK batches use an envelope; old SDKs sent a bare array/event.
  return Array.isArray(value) ? value : Array.isArray(value.batch) ? value.batch : [value];
};
async function session({ consent, gpc = false, blockedSdk = false, bot = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    ...(!bot ? { userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36` } : {}) });
  // The SDK deliberately drops navigator.webdriver events. Model an ordinary
  // customer here; separately verify the real automated-browser exclusion.
  // Do not disable PostHog's production bot filter to make a test pass.
  if (!bot) await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    if (navigator.userAgentData) Object.defineProperty(Object.getPrototypeOf(navigator.userAgentData), "brands", { get: () => [{ brand: "Chromium", version: "147" }] });
  });
  if (consent) await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: CONSENT, value: consent });
  if (gpc) await context.addInitScript(() => Object.defineProperty(navigator, "globalPrivacyControl", { get: () => true }));
  const page = await context.newPage(), events = [], requests = [], errors = [], failures = [], consoleMessages = [], sdkRequests = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) consoleMessages.push(message.text()); });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === "https://us.i.posthog.com") {
      requests.push({ path: url.pathname, method: request.method() });
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" } });
      try { events.push(...decode(request.postDataBuffer())); }
      catch (error) { failures.push(error.message); }
      return route.fulfill({ status: ingestStatus, contentType: "application/json", body: ingestStatus === 200 ? '{"status":1}' : '{"error":"fixture unavailable"}', headers: { "Access-Control-Allow-Origin": origin } });
    }
    if (url.origin !== origin) return route.abort();
    if (/\/assets\/vendor-posthog-/.test(url.pathname)) {
      sdkRequests.push(url.pathname);
      if (blockedSdk) return route.abort("blockedbyclient");
      if (sdkDelayMs) { await new Promise(resolve => setTimeout(resolve, sdkDelayMs)); return route.continue().catch(() => undefined); }
    }
    if (url.pathname === "/checkout-fixture") return route.fulfill({ contentType: "text/html", body: "<h1>Local checkout fixture</h1>" });
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/auth/me") return route.fulfill({ status: user ? 200 : 401, json: user ?? { message: "Not signed in" } });
    if (["/api/auth/login", "/api/auth/register"].includes(url.pathname)) {
      const body = request.postDataJSON();
      user = { id: body.email === "second@example.invalid" ? USER_B : USER_A, name: "Fixture customer", email: body.email, role: "user" };
      return route.fulfill({ json: user });
    }
    if (url.pathname === "/api/auth/logout") { user = null; return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === "/api/tracking/accounts") {
      if (request.method() === "POST") { accountAdded = true; return route.fulfill({ json: account() }); }
      return route.fulfill({ json: accountAdded ? [account()] : [] });
    }
    if (url.pathname.endsWith("/report/generate")) return route.fulfill({ status: 202, json: { status: "generating" } });
    if (url.pathname.endsWith("/report")) return route.fulfill({ json: account() });
    if (url.pathname.startsWith("/api/viewer/")) return route.fulfill({ json: viewer() });
    if (url.pathname.endsWith("/followers/roster") || url.pathname.endsWith("/following/roster")) return route.fulfill({ json: { items: [], total: 0, nextCursor: null, syncState: "pending" } });
    if (url.pathname.endsWith("/feed")) return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/billing/checkout") return route.fulfill({ json: { url: origin + "/checkout-fixture" } });
    if (url.pathname === "/api/billing/subscription") return route.fulfill({ json: null });
    if (url.pathname === "/api/reports") return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget { static CLOSED = 2; readyState = 1; close() { this.readyState = 2; } };
  });
  const result = { context, page, events, requests, errors, failures, consoleMessages, sdkRequests }; observations.push(result); return result;
}
try {
  const s = await session();
  await s.page.goto(origin + "/auth?token=SECRET_TOKEN&email=private@example.invalid#SECRET_TOKEN");
  await s.page.locator("#auth-email").fill("private@example.invalid");
  await s.page.locator("#auth-password").fill("SECRET_PASSWORD");
  await s.page.waitForTimeout(800);
  assert.equal(s.requests.length, 0); assert.equal(s.sdkRequests.length, 0); checks.push("no SDK/network analytics before consent, including form typing");
  await s.page.getByRole("button", { name: "Reject analytics", exact: true }).click();
  await s.page.reload(); await s.page.getByRole("button", { name: "Analytics preferences", exact: true }).waitFor();
  assert.equal(s.requests.length, 0); checks.push("rejection survives reload");
  await s.page.getByRole("button", { name: "Analytics preferences", exact: true }).click();
  await s.page.getByRole("button", { name: "Allow analytics", exact: true }).click();
  await wait(() => s.events.some(e => e.event === "$pageview"), "consented actual SDK pageview");
  assert.equal(s.events.filter(e => e.event === "$pageview").length, 1);
  assert.equal(s.events[0].properties.$current_url, "https://cheaterfinder.com/auth");
  assert.equal(s.events[0].properties.token, KEY); checks.push("actual SDK encoded ingestion with sanitized URL and correct protocol token");
  await s.page.locator("#auth-email").fill("private@example.invalid");
  await s.page.locator("#auth-password").fill("SECRET_PASSWORD");
  await s.page.getByRole("button", { name: "Sign In", exact: true }).click();
  await wait(() => s.page.url().endsWith("/members"), "login navigation");
  await wait(() => s.events.some(e => e.event === "auth_succeeded"), "real success event");
  assert(s.events.some(e => e.event === "$identify" && e.properties.distinct_id === "customer:" + USER_A));
  checks.push("successful login identifies opaque UUID and emits success, without contact data");
  accountAdded = true;
  await s.page.goto(origin + "/dashboard/" + ACCOUNT + "?username=private_instagram_target");
  await s.page.getByRole("tab", { name: "All followers", exact: true }).click();
  await wait(() => s.events.some(e => e.event === "dashboard_tab_viewed"), "roster tab event");
  assert(s.events.some(e => e.event === "$pageview" && e.properties.$pathname === "/dashboard/:id"));
  checks.push("customer roster UI remains usable; only enum tab and template route captured");
  await s.page.getByRole("button", { name: "Log Out", exact: true }).click();
  await s.page.locator("#auth-email").fill("second@example.invalid");
  await s.page.locator("#auth-password").fill("SECRET_PASSWORD");
  await s.page.getByRole("button", { name: "Sign In", exact: true }).click();
  await wait(() => s.events.some(e => e.event === "auth_succeeded" && e.properties.distinct_id === "customer:" + USER_B), "second identity");
  checks.push("logout/login account switch uses a different customer identity");
  sdkDelayMs = 2500; // Deterministically force checkout before SDK import resolves.
  await s.page.goto(origin + "/payment?username=private_instagram_target&session_id=SECRET_TOKEN");
  await s.page.getByRole("button", { name: "Start 3-Day Free Trial", exact: true }).click();
  await wait(() => s.page.url().includes("/checkout-fixture"), "local hosted checkout redirect");
  await wait(() => s.events.some(e => e.event === "checkout_started"), "checkout event survives navigation");
  assert.equal(s.events.filter(e => e.event === "checkout_started").length, 1);
  assert.equal(s.events.find(e => e.event === "checkout_started").properties.$lib, undefined, "Cold checkout did not exercise the SDK-independent fallback");
  assert(s.requests.some(r => r.path === "/i/v0/e/"));
  checks.push("cold-SDK checkout event survives immediate full navigation exactly once; no Stripe request/charge");
  sdkDelayMs = 0;
  await s.page.goto(origin + "/payment");
  await wait(() => s.events.some(e => e.event === "$pageview" && e.properties.$pathname === "/payment"), "initialized payment analytics");
  const checkoutCount = s.events.filter(e => e.event === "checkout_started").length;
  await s.page.getByRole("button", { name: "Start 3-Day Free Trial", exact: true }).click();
  await wait(() => s.page.url().includes("/checkout-fixture"), "initialized checkout navigation");
  await wait(() => s.events.filter(e => e.event === "checkout_started").length > checkoutCount, "initialized SDK checkout beacon");
  assert.equal(s.events.filter(e => e.event === "checkout_started").length, checkoutCount + 1);
  checks.push("initialized SDK checkout sends one immediate event before redirect");
  await s.page.goto(origin + "/privacy");
  await wait(() => s.events.some(e => e.event === "$pageview" && e.properties.$pathname === "/privacy"), "privacy view");
  await s.page.getByRole("button", { name: "Analytics preferences", exact: true }).click();
  await s.page.setViewportSize({ width: 390, height: 844 });
  await s.page.screenshot({ path: root + "/posthog-consent-mobile.png" });
  assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await s.page.getByRole("button", { name: "Reject analytics", exact: true }).click();
  const before = s.events.length;
  await s.page.goto(origin + "/payment"); await s.page.waitForTimeout(1000);
  assert.equal(s.events.length, before); checks.push("withdrawal stops future collection; mobile preferences fit viewport");
  assert.deepEqual(s.errors, []); assert.deepEqual(s.failures, []);
  for (const secret of [...sensitive, "second@example.invalid"]) assert(!JSON.stringify(s.events).includes(secret), "Telemetry leaked " + secret);
  assert(s.requests.every(r => /\/e\/?$/.test(r.path)));
  assert(!s.events.some(e => ["$autocapture", "$snapshot", "$exception", "$set"].includes(e.event)));
  checks.push("wire payloads exclude passwords/tokens/contact details/Instagram data; no flags/replay requests");
  await s.context.close();

  user = null;
  const bot = await session({ consent: "accepted", bot: true }); await bot.page.goto(origin + "/auth");
  await wait(() => bot.sdkRequests.length > 0, "bot SDK initialized");
  await bot.page.waitForTimeout(4000); assert.equal(bot.requests.length, 0); await bot.context.close(); checks.push("production bot filter excludes automated browser events");
  const g = await session({ consent: "accepted", gpc: true }); await g.page.goto(origin + "/");
  await g.page.waitForTimeout(800); assert.equal(g.requests.length, 0); await g.context.close(); checks.push("GPC overrides stored opt-in");
  user = { id: USER_A, role: "admin" };
  const a = await session({ consent: "accepted" }); await a.page.goto(origin + "/");
  await a.page.waitForTimeout(800); assert.equal(a.requests.length, 0); await a.page.goto(origin + "/admin/health");
  await a.page.waitForTimeout(500); assert.equal(a.requests.length, 0); await a.context.close(); checks.push("admin users and admin routes excluded");
  user = null;
  const b = await session({ consent: "accepted", blockedSdk: true }); await b.page.goto(origin + "/auth");
  await b.page.locator("#auth-email").fill("private@example.invalid"); await b.page.locator("#auth-password").fill("SECRET_PASSWORD");
  await b.page.getByRole("button", { name: "Sign In", exact: true }).click();
  await wait(() => b.page.url().endsWith("/members"), "login despite blocked SDK");
  assert.deepEqual(b.errors, []); assert.equal(b.requests.length, 0); await b.context.close(); checks.push("ad-blocked SDK cannot break login/navigation");
  user = null; ingestStatus = 503;
  const f = await session({ consent: "accepted" }); await f.page.goto(origin + "/auth");
  await wait(() => f.requests.length > 0, "fixture analytics outage");
  await f.page.locator("#auth-email").fill("private@example.invalid"); await f.page.locator("#auth-password").fill("SECRET_PASSWORD");
  await f.page.getByRole("button", { name: "Sign In", exact: true }).click();
  await wait(() => f.page.url().endsWith("/members"), "login despite analytics outage");
  assert.deepEqual(f.errors, []); await f.context.close(); checks.push("ingestion503 does not block product success");
  const entry = shell.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
  const report = { at: new Date().toISOString(), source: "compiled fixture app + actual posthog-js SDK + CSP; all ingestion intercepted, all other outbound blocked", checks,
    frontendEntry: entry, frontendSha256: createHash("sha256").update(await readFile(root + entry)).digest("hex"),
    events: s.events.map(e => ({ event: e.event, properties: e.properties })), screenshots: [root + "/posthog-consent-mobile.png"], productionWrites: 0 };
  await writeFile(root + "/posthog-browser-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: checks.length, checks, report: root + "/posthog-browser-report.json" }, null, 2));
} catch (error) {
  for (const s of observations) if (!s.page.isClosed() && s.sdkRequests.length) {
    s.sdkState = await s.page.evaluate(async path => {
      const { default: sdk } = await import(path);
      return { loaded: sdk.__loaded, capturing: sdk.is_capturing(), optedOut: sdk.has_opted_out_capturing(),
        bot: sdk._is_bot(), distinctId: sdk.get_distinct_id(), consent: localStorage.getItem("cheaterfinder.analytics-consent.v1"),
        ua: navigator.userAgent, uaBrands: navigator.userAgentData?.brands, webdriver: navigator.webdriver,
        capture: sdk.capture("$pageview") };
    }, s.sdkRequests[0]).catch(e => ({ diagnosticError: e.message }));
  }
  console.log(JSON.stringify({ checks, diagnostic: observations.map(s => ({ events: s.events, requests: s.requests, errors: s.errors, failures: s.failures, console: s.consoleMessages, sdkRequests: s.sdkRequests, sdkState: s.sdkState })) }, null, 2));
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
