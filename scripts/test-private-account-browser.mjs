#!/usr/bin/env node
// Compiled UI regressions with synthetic API responses. No provider or live DB.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { chromium } from "playwright";

const build = resolve(process.argv[2] ?? "dist");
const evidence = resolve(process.argv[3] ?? "/tmp/private-account-browser");
const origin = "https://private-flow.example.invalid";
const now = new Date().toISOString();
const account = { id: "fixture-private", igUsername: "private_fixture", displayName: "Private fixture", isActive: true,
  isPrivate: true, accessStatus: "access_denied", igUserId: "12345", trackingStarted: now, profileSnapshots: [] };
const viewer = { igUsername: account.igUsername, isPrivate: true, dataSource: "none", cachedAt: null,
  topNiche: null, peakActivityHour: null, recentPosts: [], stories: [], highlights: [], recentLikes: [],
  recentFollows: [], recentFollowers: [], recentUnfollows: [], recentFollowerUnfollows: [],
  activityByHour: [], activityByDate: [], weeklyStats: { totalPosts: 0, totalLikes: 0, totalFollows: 0, totalUnfollows: 0 },
  contentCachedAt: { posts: null, stories: null, highlights: null } };
const user = { id: "fixture-user", name: "Fixture", email: "fixture@example.invalid", role: "user", onboardingAcknowledgedAt: now };
const subscription = { status: "active", plan: "pro", stripeCustomerId: "cus_fixture", stripeSubscriptionId: "sub_fixture",
  currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() };
const mime = { ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webp": "image/webp" };
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const checks = [];
async function waitForRequest(state) {
  for (let i = 0; i < 100; i++) {
    if (state.releaseRetry) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error("Access request did not reach the fixture server");
}
async function scenario(name, fn) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const state = { account: { ...account }, retryCalls: 0, responseStatus: 503, releaseRetry: null, accountReads: 0, navigations: 0 };
  const errors = [];
  await context.addInitScript(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("cheaterfinder.analytics-consent.v1", "rejected"); });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) return route.abort();
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/auth/me") return json(user);
    if (path === "/api/billing/subscription") return json(subscription);
    if (path === "/api/tracking/accounts") { state.accountReads++; return json([state.account]); }
    if (path === "/api/tracking/accounts/fixture-private/report") return json(state.account);
    if (path.endsWith("/retry-access") && request.method() === "POST") {
      state.retryCalls++;
      await new Promise(resolveRetry => { state.releaseRetry = resolveRetry; });
      if (state.responseStatus === 200) state.account.accessStatus = "pending_access";
      return json(state.responseStatus === 200 ? { status: "pending_access" } : { message: "No service account is ready. Please try again later." }, state.responseStatus);
    }
    if (path.startsWith("/api/viewer/")) return json(viewer);
    if (path.endsWith("/posts")) return json({ posts: [], total: 0, counts: { all: 0, image: 0, video: 0, carousel: 0 }, hasMore: false });
    if (path.endsWith("/feed")) return json([]);
    if (path === "/api/config/refresh") return json({ refreshSweepSec: 240, tiers: { profileMin: 30, contentMin: 60, graphHours: 3 } });
    if (path === "/api/notifications/unread-count") return json({ count: 0 });
    if (path === "/api/notifications") return json([]);
    if (path === "/api/realtime/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": fixture\n\n" });
    if (path.startsWith("/api/")) { errors.push("Unexpected fixture API: " + path); return json({}, 404); }
    if (request.resourceType() === "document") { state.navigations++; return route.fulfill({ contentType: "text/html", body: await readFile(join(build, "app-shell.html")) }); }
    const file = resolve(build, "public", "." + path);
    if (!file.startsWith(join(build, "public") + "/")) return route.abort();
    try { return await route.fulfill({ contentType: mime[extname(file)] ?? "application/octet-stream", body: await readFile(file) }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  try { await fn(page, state); assert.deepEqual(errors, []); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, reason: error.message }); }
  finally { await context.close(); }
}
try {
  await scenario("failed access retry is visible, single-flight and does not reload", async (page, state) => {
    await page.goto(origin + "/dashboard/fixture-private");
    const button = page.getByRole("button", { name: "Retry Access", exact: true }); await button.click();
    await page.getByRole("button", { name: "Requesting access…", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Requesting access…", exact: true }).isDisabled(), true);
    await waitForRequest(state); assert.equal(state.retryCalls, 1); state.releaseRetry();
    await page.getByRole("alert").filter({ hasText: "No service account is ready" }).waitFor();
    assert.equal(state.navigations, 1); assert.equal(await button.isEnabled(), true);
    await page.screenshot({ path: join(evidence, "private-retry-error-mobile.png"), fullPage: true });
    state.responseStatus = 200; state.releaseRetry = null; await button.click();
    await waitForRequest(state);
    // The response stays pending until explicitly released; double clicks cannot send another request.
    assert.equal(state.retryCalls, 2); state.releaseRetry();
    await page.getByText("The owner must accept a follow request", { exact: false }).waitFor();
    assert.equal(await button.count(), 0); assert.equal(await page.getByText("Preparing your data", { exact: true }).count(), 0);
    assert.equal(state.navigations, 1);
  });
  await scenario("approved empty collection is distinguished from waiting for approval", async (page, state) => {
    state.account.accessStatus = "has_access";
    await page.goto(origin + "/dashboard/fixture-private");
    await page.getByText("Access is approved, but no posts or stories", { exact: false }).waitFor();
    assert.equal(await page.getByText("The owner must accept a follow request", { exact: false }).count(), 0);
    assert.equal(await page.getByText("11 PM", { exact: true }).count(), 0);
    assert.equal(await page.getByText("General", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(evidence, "private-approved-empty-mobile.png"), fullPage: true });
  });
  await scenario("inactive private account does not claim active collection", async (page, state) => {
    state.account.isActive = false; state.account.accessStatus = "has_access";
    await page.goto(origin + "/members");
    await page.getByText("Inactive", { exact: true }).waitFor();
    assert.equal(await page.getByText("Private - Active", { exact: true }).count(), 0);
  });
  await scenario("pending approval refreshes without reloading or replacing the account list", async (page, state) => {
    state.account.accessStatus = "pending_access";
    await page.clock.install(); await page.goto(origin + "/members");
    await page.getByText("Pending Access", { exact: true }).waitFor();
    const prior = state.accountReads; state.account.accessStatus = "has_access";
    await page.clock.runFor(30001);
    await page.getByText("Private - Active", { exact: true }).waitFor();
    assert(state.accountReads > prior); assert.equal(state.navigations, 1);
  });
} finally {
  await browser.close();
  const report = { at: new Date().toISOString(), scope: "Compiled UI with synthetic API fixtures; no real authentication, database or provider calls", checks,
    passed: checks.length === 4 && checks.every(check => check.passed) };
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
}
