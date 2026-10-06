// Source UI with synthetic HTTP fixtures only. No Stripe or production requests.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const origin = 'https://trial-preview.example.invalid';
const compiled = await build({ stdin: { contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{useLocation}from'wouter';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import './client/src/i18n';import Dashboard from './client/src/pages/Dashboard';import Reports from './client/src/pages/Reports';
import{PaidAccess}from'./client/src/components/PaidAccess';import{Toaster}from'./client/src/components/ui/toaster';
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});window.fixtureClient=client;
function Fixture(){const[location]=useLocation();return <>{location==='/payment'?<p>Fixture payment recovery</p>:location==='/portal'?<p>Fixture Stripe portal</p>:<PaidAccess>{location==='/reports'?<Reports/>:<Dashboard/>}</PaidAccess>}<Toaster/></>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>);`, resolveDir: repo, loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env.PROD': 'false', 'import.meta.env.VITE_POSTHOG_KEY': '""' } });
const now = new Date().toISOString(), future = new Date(Date.now() + 3 * 86400000).toISOString();
const syntheticPast = '2000-01-02T03:04:05.000Z';
const image = '/assets/preview-blur.png';
const account = { id: 'fixture-account', igUsername: 'tracked_fixture', displayName: 'Tracked Fixture', isActive: true, isPrivate: false,
  accessStatus: 'public', trackingStarted: now, profilePicUrl: '/avatar.png', profileSnapshots: [{ followerCount: 1234, followingCount: 123, postCount: 12, snapshotAt: now }] };
const metrics = { summary: { totalLikes: null, followersDetected: null, followersLost: null, netFollowerChange: null, followerEventsTrustworthy: false,
  accountsFollowed: null, accountsUnfollowed: null, netFollowingChange: null, followingEventsTrustworthy: false },
  profile: { followerCountStart: null, followerCountEnd: null, followingCountStart: null, followingCountEnd: null, postCountEnd: null },
  ownPosts: { publishedInPeriod: null, totalOnProfile: null, avgLikes: null, avgComments: null, engagementRatePct: null },
  content: { activeStories: null, highlights: null }, previous: { totalLikes: null, netFollowerChange: null, accountsUnfollowed: null, accountsFollowed: null }, peakActivityHour: null,
  topHashtags: [{ label: 'preview', count: null }], topLikedAccounts: [{ label: 'user_aaaa', count: null }],
  likesLeaderboard: [{ username: 'user_aaaa', count: null, thumbnails: [image] }], followedAccounts: [], unfollowedAccounts: [], dailySeries: [{ date: now.slice(0, 10), followers: null, following: null }] };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
const checks = [];
async function scenario(name, run) {
  const state = { status: 'trialing', empty: false, fail: false, activationCalls: 0, activationBodies: [], claimCalls: 0, offered: false, claimFail: false, claimDelay: 0, activationDelay: 0, retryFail: false, subscriptionId: 'sub_fixture', feedCalls: 0, engagementCalls: 0, reportMutations: 0, portalCalls: 0 };
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'csrf_token', value: 'fixture-token', url: origin }]);
  await context.addInitScript(() => { localStorage.setItem('i18nextLng', 'en'); window.EventSource = class { addEventListener() {} close() {} }; });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (url.origin !== origin) { errors.push(`External request: ${url.origin}`); return route.abort(); }
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const preview = state.status === 'trialing';
    if (p === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: compiled.outputFiles[0].text });
    if (p.endsWith('.png')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path fill="#ddd6fe" d="M0 0h40v40H0z"/></svg>' });
    if (p === '/api/auth/me') return json({ id: 'fixture-user', role: 'user', onboardingAcknowledgedAt: now });
    if (p === '/api/config/refresh') return json({ refreshSweepSec: 1800, tiers: { profileMin: 30, contentMin: 30, graphHours: 6 } });
    if (p === '/api/billing/subscription') return json({ status: state.status, plan: 'standard', stripeCustomerId: 'cus_fixture', stripeSubscriptionId: state.subscriptionId, trialEndsAt: future, currentPeriodEnd: future });
    if (p === '/api/billing/activate-now') {
      assert.equal(req.method(), 'POST'); assert.equal(req.headers()['x-csrf-token'], 'fixture-token'); state.activationCalls++; state.activationBodies.push(req.postData() ? req.postDataJSON() : null);
      if (state.activationDelay) await new Promise(resolve => setTimeout(resolve, state.activationDelay));
      if (state.retryFail) return json({ message: 'Fixture retryable failure' }, 503);
      if (state.fail) { state.status = 'past_due'; return json({ status: 'payment_failed', message: 'Fixture declined card' }); }
      return json({ status: 'activating' });
    }
    if (p === '/api/billing/rescue-offer/claim') {
      assert.equal(req.method(), 'POST'); assert.equal(req.headers()['x-csrf-token'], 'fixture-token'); state.claimCalls++;
      if (state.claimFail) return json({ message: 'Fixture unavailable' }, 503);
      const eligible = !state.offered; state.offered = true;
      if (state.claimDelay) await new Promise(resolve => setTimeout(resolve, state.claimDelay));
      return json(eligible ? { eligible: true, offerId: 'fixture-signed-offer', plan: 'Standard', percentOff: 50 } : { eligible: false });
    }
    if (p === '/api/billing/portal') { state.portalCalls++; return json({ url: `${origin}/portal` }); }
    if (p === '/api/tracking/accounts') return json(state.empty ? [] : [account]);
    if (p.endsWith('/report/generate') || /\/api\/reports\/.*\/(pdf|csv)/.test(p)) { state.reportMutations++; return json({ code: 'trial_preview' }, 402); }
    if (p.endsWith('/report')) return json(account);
    if (p.endsWith('/feed')) { state.feedCalls++; return json({ items: [
      { id: 'event-1', trialPreview: preview, eventType: 'follow', followedUsername: preview ? 'user_aaaa' : 'real_fixture_follow', followedDisplayName: preview ? 'Instagram User' : 'Real Fixture', detectedAt: preview ? syntheticPast : now },
      { id: 'event-2', trialPreview: preview, eventType: 'like', ownerUsername: preview ? 'user_bbbb' : 'real_fixture_like', postId: 'liked-1', postType: 'photo', thumbnailUrl: image, displayUrl: image, postUrl: '#', likesCount: preview ? null : 8, commentsCount: preview ? null : 2, postTakenAt: preview ? syntheticPast : now, detectedAt: preview ? syntheticPast : now },
    ], limit: 50, offset: 0 }); }
    if (p.startsWith('/api/viewer/')) return json({ ...account, trialPreview: preview, dataSource: 'cached', cachedAt: now,
      followerCount: 1234, followingCount: 123, postCount: 12, topNiche: null, peakActivityHour: null,
      weeklyStats: { totalLikes: preview ? null : 7, totalFollows: preview ? null : 8, totalUnfollows: preview ? null : 1, totalPosts: preview ? null : 3 },
      recentLikes: [], recentFollows: [], recentFollowers: [], recentUnfollows: [], recentFollowerUnfollows: [], activityByHour: [{ hour: 10, count: preview ? null : 7 }], activityByDate: [{ date: now.slice(0, 10), count: preview ? null : 7 }],
      stories: [{ trialPreview: preview, storyId: 'story-1', mediaType: 'video', mediaUrl: image, thumbnailUrl: image, takenAt: preview ? syntheticPast : now, expiresAt: preview ? syntheticPast : future }],
      highlights: [{ trialPreview: preview, highlightId: 'highlight-1', title: 'Preview', coverUrl: image, mediaCount: null, items: [] }],
      recentPosts: [{ trialPreview: preview, shortcode: 'fixturepost', postType: 'video', thumbnailUrl: image, displayUrl: image, videoUrl: image, caption: 'Preview caption', likeCount: preview ? null : 4, commentCount: preview ? null : 2, takenAt: now }],
      postsTotal: 1, postCounts: { all: 1, video: 1 }, contentCachedAt: { posts: now, stories: now, highlights: now } });
    if (/\/(likers|comments)$/.test(p)) { state.engagementCalls++; return json({ items: [], total: 0, expectedTotal: 0, isPartial: false }); }
    if (p === '/api/reports') return json({ trialPreview: preview, items: [{ id: 'report-1', igUsername: 'tracked_fixture', type: 'weekly', status: 'ready', periodStart: now, periodEnd: future, createdAt: now, totalLikes: null, totalFollows: null, totalUnfollows: null, topNiche: null, peakActivityHour: null, trialPreview: preview, metrics }], limit: 50, offset: 0 });
    if (p.startsWith('/api/')) { errors.push(`Unhandled API: ${p}`); return json({}, 404); }
    return route.fulfill({ contentType: 'text/html', body: '<html><head><style>[inert]{pointer-events:none}body{font-family:sans-serif}button{min-height:35px}[role="dialog"][data-testid]{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:440px;max-width:90vw;padding:24px;background:white;z-index:51}[data-radix-popper-content-wrapper]{z-index:60}body>div[data-state="open"]:not([role="dialog"]){position:fixed;inset:0;background:#0008;z-index:50}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try { await run(page, state); assert.deepEqual(errors, []); checks.push(name); }
  finally { await context.close(); }
}
try {
  await scenario('trial preview keeps public profile and locks all tool interactions; activation waits for sync then refreshes real data', async (page, state) => {
    await page.goto(`${origin}/dashboard`);
    await page.getByRole('heading', { name: '@tracked_fixture', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Trial preview' }).waitFor();
    assert.equal(await page.getByText('1,234', { exact: true }).count(), 1);
    assert.equal(await page.locator('img[src="/avatar.png"]').count(), 1);
    assert.equal(await page.locator('[data-trial-preview]').count(), 12);
    assert.equal(await page.locator('[data-trial-preview] > [inert]').count(), 12);
    const storyTile = page.locator('button[aria-label^="Open story from"]');
    assert.equal(await storyTile.count(), 1, 'Synthetic past expiry must retain the preview story tile');
    assert.equal(await storyTile.isDisabled(), true);
    assert.equal(await storyTile.locator('img').count(), 1);
    assert.equal(await storyTile.locator('video').count(), 0);
    const likedGallery = page.locator('[data-trial-preview]').nth(3);
    assert.equal(await likedGallery.locator('img[alt="Post by @user_bbbb"]').count(), 1, 'Default all-time liked gallery must retain synthetic old preview posts');
    assert.equal(await page.locator('button[aria-label="View post details for fixturepost"]').evaluate(el => !!el.closest('[inert]')), true);
    assert.equal(state.engagementCalls, 0);
    await page.evaluate(() => window.fixtureClient.setQueryData(['tracking', 'roster', 'fixture-account', 'followers'], {
      pages: [{ items: [], nextCursor: 'tp1.preview-cursor' }, { items: [], nextCursor: null }], pageParams: [null, 'tp1.preview-cursor'],
    }));
    const before = state.feedCalls;
    await page.getByRole('region', { name: 'Trial preview' }).getByRole('button', { name: 'Activate now' }).click();
    await page.getByTestId('trial-activate-confirmation-dialog').waitFor();
    assert.equal(state.activationCalls, 0);
    await page.getByTestId('confirmation-activate').click();
    await page.getByRole('region', { name: 'Trial preview' }).getByRole('button', { name: 'Activating…' }).waitFor();
    assert.equal(state.activationCalls, 1);
    assert.equal(state.claimCalls, 0);
    assert.equal(await page.locator('[data-trial-preview]').count(), 12);
    state.status = 'active';
    await page.evaluate(() => window.fixtureClient.invalidateQueries({ queryKey: ['billing', 'access'] }));
    await page.getByRole('region', { name: 'Trial preview' }).waitFor({ state: 'detached' });
    await page.getByText('@real_fixture_follow', { exact: false }).first().waitFor();
    assert.ok(state.feedCalls > before);
    assert.equal(await page.locator('[data-trial-preview]').count(), 0);
    assert.equal(await page.evaluate(() => window.fixtureClient.getQueryData(['tracking', 'roster', 'fixture-account', 'followers'])), undefined);
    await page.getByRole('button', { name: 'View post details for fixturepost' }).click();
    await page.getByRole('dialog').waitFor();
    assert.ok(state.engagementCalls > 0);
  });
  await scenario('trial with no tracked accounts still has activation banner', async (page, state) => {
    state.empty = true; await page.goto(`${origin}/dashboard`);
    await page.getByRole('region', { name: 'Trial preview' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Activate now', exact: true }).count(), 1);
  });
  await scenario('activating response followed by asynchronous past_due sync redirects through unchanged PaidAccess', async (page, state) => {
    await page.goto(`${origin}/dashboard`);
    await page.getByRole('region', { name: 'Trial preview' }).getByRole('button', { name: 'Activate now' }).click();
    await page.getByTestId('trial-activate-confirmation-dialog').waitFor();
    assert.equal(state.activationCalls, 0);
    await page.getByTestId('confirmation-activate').click();
    await page.getByRole('region', { name: 'Trial preview' }).getByRole('button', { name: 'Activating…' }).waitFor();
    assert.equal(state.activationCalls, 1);
    assert.equal(state.claimCalls, 0);
    assert.equal(state.status, 'trialing');
    assert.equal(await page.locator('[data-trial-preview]').count(), 12);
    // Simulate the later webhook changing the local subscription. The actual
    // billing poll must discover it; do not manually change the query cache.
    state.status = 'past_due';
    await page.getByText('Fixture payment recovery').waitFor();
    assert.equal(new URL(page.url()).pathname, '/payment');
    assert.equal(await page.locator('[data-trial-preview]').count(), 0);
    assert.equal(state.engagementCalls, 0);
    assert.equal(state.activationCalls, 1);
    assert.equal(state.claimCalls, 0);
  });
  await scenario('legacy immediate payment_failed response offers Stripe portal and keeps PaidAccess recovery', async (page, state) => {
    state.fail = true; await page.goto(`${origin}/dashboard`);
    await page.getByRole('region', { name: 'Trial preview' }).getByRole('button', { name: 'Activate now' }).click();
    await page.getByTestId('trial-activate-confirmation-dialog').waitFor();
    assert.equal(state.activationCalls, 0);
    await page.getByTestId('confirmation-activate').click();
    await page.getByText('Fixture payment recovery').waitFor();
    await page.getByText('Payment failed — update card', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Update card', exact: true }).click();
    await page.getByText('Fixture Stripe portal').waitFor();
    assert.equal(state.portalCalls, 1);
  });
  await scenario('reports accept nullable preview metrics and replace generation and exports with activation', async (page, state) => {
    await page.goto(`${origin}/reports`);
    await page.getByRole('region', { name: 'Trial preview' }).waitFor();
    await page.locator('[data-trial-preview]').waitFor();
    assert.equal(await page.locator('a[download]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Generate report' }).count(), 0);
    assert.equal(state.reportMutations, 0);
  });
  const confirmation = page => page.getByTestId('trial-activate-confirmation-dialog');
  const rescue = page => page.getByTestId('trial-rescue-offer-dialog');
  const openConfirmation = async (page, overlay = false) => {
    await (overlay ? page.locator('[data-trial-preview]').first() : page.getByRole('region', { name: 'Trial preview' }))
      .getByRole('button', { name: 'Activate now', exact: true }).click();
    await confirmation(page).waitFor();
  };
  const dismiss = async (page, kind, method) => {
    const dialog = kind === 'confirmation' ? confirmation(page) : rescue(page);
    if (method === 'button') await page.getByTestId(kind === 'confirmation' ? 'confirmation-cancel' : 'rescue-decline').click();
    else if (method === 'x') await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    else if (method === 'escape') await page.keyboard.press('Escape');
    else await page.mouse.click(5, 5);
    await dialog.waitFor({ state: 'detached' });
  };
  for (const method of ['button', 'x', 'escape', 'outside']) {
    await scenario(`confirmation and rescue ${method} dismissal consume one offer across reload`, async (page, state) => {
      await page.goto(`${origin}/dashboard`);
      await openConfirmation(page, method === 'x');
      assert.equal(state.activationCalls, 0);
      assert.equal(state.claimCalls, 0);
      await dismiss(page, 'confirmation', method);
      await rescue(page).waitFor();
      assert.equal(state.claimCalls, 1);
      assert.equal(state.offered, true);
      assert.match(await rescue(page).innerText(), /50% off your first month/);
      assert.doesNotMatch(await rescue(page).innerText(), /\$5\.99/);
      await dismiss(page, 'rescue', method);
      assert.equal(state.activationCalls, 0);
      assert.equal(state.claimCalls, 1);
      await page.reload();
      await openConfirmation(page);
      const claimedAgain = page.waitForResponse('**/api/billing/rescue-offer/claim');
      await dismiss(page, 'confirmation', 'button');
      assert.deepEqual(await (await claimedAgain).json(), { eligible: false });
      assert.equal(state.claimCalls, 2);
      assert.equal(await rescue(page).count(), 0);
    });
  }
  await scenario('rescue acceptance posts signed offer once and waits for authoritative unlock', async (page, state) => {
    await page.goto(`${origin}/dashboard`);
    await openConfirmation(page, true);
    await dismiss(page, 'confirmation', 'button');
    await rescue(page).waitFor();
    await page.getByTestId('rescue-activate').evaluate(button => { button.click(); button.click(); });
    await page.getByTestId('rescue-activate').getByText('Activating…').waitFor();
    assert.equal(state.activationCalls, 1);
    assert.deepEqual(state.activationBodies, [{ offerId: 'fixture-signed-offer' }]);
    assert.equal(await page.locator('[data-trial-preview]').count(), 12);
    await page.keyboard.press('Escape');
    assert.equal(await rescue(page).count(), 1);
    state.status = 'active';
    await rescue(page).waitFor({ state: 'detached' });
    await page.getByText('@real_fixture_follow', { exact: false }).first().waitFor();
    assert.equal(await page.locator('[data-trial-preview]').count(), 0);
    assert.equal(state.claimCalls, 1);
  });
  await scenario('rescue request failure retries the same signed offer without reclaiming', async (page, state) => {
    state.retryFail = true;
    await page.goto(`${origin}/dashboard`);
    await openConfirmation(page);
    await dismiss(page, 'confirmation', 'button');
    await page.getByTestId('rescue-activate').click();
    await rescue(page).getByRole('alert').waitFor();
    assert.equal(await page.getByTestId('rescue-activate').isEnabled(), true);
    state.retryFail = false;
    await page.getByTestId('rescue-activate').click();
    await page.getByTestId('rescue-activate').getByText('Activating…').waitFor();
    assert.deepEqual(state.activationBodies, [{ offerId: 'fixture-signed-offer' }, { offerId: 'fixture-signed-offer' }]);
    assert.equal(state.claimCalls, 1);
  });
  await scenario('claim failure closes silently and ordinary activation remains available', async (page, state) => {
    state.claimFail = true;
    await page.goto(`${origin}/dashboard`);
    await openConfirmation(page);
    const claimed = page.waitForResponse('**/api/billing/rescue-offer/claim');
    await dismiss(page, 'confirmation', 'button');
    await claimed;
    assert.equal(await rescue(page).count(), 0);
    await openConfirmation(page);
    await page.getByTestId('confirmation-activate').click();
    await page.getByRole('region', { name: 'Trial preview' }).getByRole('button', { name: 'Activating…' }).waitFor();
    assert.deepEqual(state.activationBodies, [null]);
  });
  await scenario('late claim cannot replace a newly opened confirmation', async (page, state) => {
    state.claimDelay = 350;
    await page.goto(`${origin}/dashboard`);
    await openConfirmation(page);
    await dismiss(page, 'confirmation', 'button');
    await openConfirmation(page);
    await page.waitForTimeout(500);
    assert.equal(await confirmation(page).count(), 1);
    assert.equal(await rescue(page).count(), 0);
    assert.equal(state.activationCalls, 0);
  });
  await scenario('changed subscription aborts acceptance and restores activation on new trial', async (page, state) => {
    state.activationDelay = 400;
    await page.goto(`${origin}/dashboard`);
    await openConfirmation(page);
    await page.getByTestId('confirmation-activate').click();
    await page.getByRole('region', { name: 'Trial preview' }).getByRole('button', { name: 'Activating…' }).waitFor();
    state.subscriptionId = 'sub_replacement';
    await page.evaluate(() => window.fixtureClient.invalidateQueries({ queryKey: ['billing', 'access'] }));
    await page.getByRole('region', { name: 'Trial preview' }).getByRole('button', { name: 'Activate now' }).waitFor();
    await page.waitForTimeout(500);
    await openConfirmation(page);
    assert.equal(state.activationCalls, 1);
    assert.equal(state.claimCalls, 0);
  });
  await scenario('reports use the same confirmation and rescue flow', async (page, state) => {
    await page.goto(`${origin}/reports`);
    await openConfirmation(page, true);
    await dismiss(page, 'confirmation', 'button');
    await rescue(page).waitFor();
    assert.equal(state.claimCalls, 1);
    assert.equal(state.reportMutations, 0);
    assert.equal(state.activationCalls, 0);
  });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { await browser.close(); }
