// Focused browser regressions for the real admin component, bundled from source.
// Every request is fulfilled locally with synthetic data; no services/providers.
// Run: PLAYWRIGHT_BROWSERS_PATH=... node client/src/pages/admin/__tests__/tracked-detail.browser.mjs
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const origin = 'https://admin-detail.example.invalid';
const evidence = process.argv[2] ?? '/tmp/admin-tracked-detail-browser';
await mkdir(evidence, { recursive: true });
const output = await build({ stdin: { contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import './client/src/i18n';import Detail from './client/src/pages/admin/AdminTrackedAccountDetail';
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function Fixture(){const[id,setId]=useState('alpha');const[open,setOpen]=useState(true);
window.switchAccount=id=>{setId(id);setOpen(true)};return <QueryClientProvider client={client}>{open?<Detail accountId={id} onClose={()=>setOpen(false)}/>:<p>Fixture closed</p>}</QueryClientProvider>}
createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: repo, loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"test"' } });
let css = '';
try { const dir = path.join(repo, 'dist/public/assets'); const file = (await readdir(dir)).find(name => name.endsWith('.css')); if (file) css = await readFile(path.join(dir, file), 'utf8'); } catch { /* Functional checks do not depend on a previous build. */ }
const now = new Date().toISOString();
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#a855f7"/></svg>';
const post = (code, type = 'photo') => ({ shortcode: code, postType: type, thumbnailUrl: '/fixture.svg', displayUrl: '/fixture.svg', takenAt: now, caption: code + ' caption', likeCount: 2, commentCount: 1 });
const detail = id => ({ account: { id, igUsername: id + '_fixture', displayName: id + ' profile', profilePicUrl: '/fixture.svg',
  followerCount: 120, isActive: true, isPrivate: false, accessStatus: 'public', trackingStarted: now, userId: 'owner', userEmail: 'owner@example.invalid', userName: 'Fixture owner' },
  owners: [], stats: { likeCount: 3, followCount: 2, unfollowCount: 1 } });
const content = id => ({ access: { allowed: true, reason: null }, postsTotal: 27, postCounts: { all: 27, photo: 1, video: 0, reel: 26, carousel: 0 }, viewer: {
  igUsername: id + '_fixture', displayName: id + ' profile', profilePicUrl: '/fixture.svg', biography: id + ' biography', followerCount: 120, followingCount: 100, postCount: 40,
  dataSource: 'cached', cachedAt: now, contentCachedAt: { posts: now, stories: now, highlights: now }, recentPosts: [post(id + '_photo')],
  stories: [{ storyId: id + '_story', mediaType: 'photo', mediaUrl: '/fixture.svg', thumbnailUrl: '/fixture.svg', takenAt: now, expiresAt: new Date(Date.now() + 86400000).toISOString() }],
  highlights: [{ highlightId: id + '_highlight', title: id + ' highlights', coverUrl: '/fixture.svg', mediaCount: 1, items: [{ storyId: id + '_highlight_item', mediaType: 'photo', mediaUrl: '/fixture.svg', takenAt: now }] }],
} });
const like = n => ({ id: 'like_' + n, eventType: 'like', postId: 'liked_' + n, ownerUsername: 'liked_owner_' + n, postType: 'photo', postUrl: 'https://www.instagram.com/p/fixture/', thumbnailUrl: '/fixture.svg', detectedAt: now, postTakenAt: now });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const checks = [];
async function scenario(name, run, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const state = { requests: [], denied: null, contentError: false, likedError: false, rosterDenied: false, unknownRosterTotal: false, blankAvatar: false, pausedPublic: false, slowAlpha: false, releaseAlpha: null };
  const failures = [];
  await context.addInitScript(() => localStorage.setItem('i18nextLng', 'en'));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (url.origin !== origin) { failures.push('Unexpected external request'); return route.abort(); }
    if (request.method() !== 'GET') { failures.push('Unexpected mutation request'); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: output.outputFiles[0].text });
    if (p === '/fixture.svg') return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    if (p.startsWith('/api/')) {
      state.requests.push(p + url.search);
      const match = /^\/api\/admin\/tracked-accounts\/([^/]+)(.*)$/.exec(p);
      if (!match) { failures.push('Non-admin API request: ' + p); return json({}, 404); }
      const [, id, suffix] = match;
      if (!suffix) { const result = detail(id); if (state.pausedPublic) result.account.isActive = false; if (state.blankAvatar) result.account.profilePicUrl = ''; return json(result); }
      if (suffix === '/content') {
        if (state.slowAlpha && id === 'alpha') { await new Promise(resolve => { state.releaseAlpha = resolve; }); try { return await json(content(id)); } catch { return; } }
        if (state.contentError) return json({ message: 'Fixture outage' }, 503);
        return json(state.denied ? { ...content(id), access: { allowed: false, reason: state.denied }, viewer: null } : content(id));
      }
      if (suffix === '/posts') { const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 12); return json({ items: Array.from({ length: Math.min(limit, Math.max(0, 26 - offset)) }, (_, i) => post(id + '_reel_' + (offset + i), 'reel')), offset, limit, hasMore: offset + limit < 26 }); }
      if (suffix.endsWith('/likers')) return json({ items: [{ username: 'cached_liker' }], total: 1, expectedTotal: 2, isPartial: true });
      if (suffix.endsWith('/comments')) return json({ items: [{ author: 'cached_author', text: 'Saved fixture comment', createdAt: now }], total: 1 });
      if (suffix === '/liked-posts') { const offset = Number(url.searchParams.get('offset') ?? 0); if (offset && state.likedError) return json({}, 503); return json({ items: offset ? [like(3)] : [like(1), like(2)], total: 3 }); }
      if (suffix === '/roster') { if (state.rosterDenied) return json({ code: 'private_access_required' }, 403); const offset = Number(url.searchParams.get('offset') ?? 0); return json({ items: [{ username: offset ? 'later_member' : 'saved_member', displayName: 'Roster fixture', pfpUrl: '/fixture.svg', igUserId: String(123 + offset) }], total: 101, expectedTotal: state.unknownRosterTotal ? null : 120, offset, limit: 100, hasMore: offset === 0, baselineSettled: false, lastUpdatedAt: now, syncState: 'restricted', isPartial: true, failureKind: 'cooldown', nextRetryAt: null }); }
      if (suffix === '/activity') return json({ items: [{ id: 'follower_event', eventType: 'follower', followerUsername: 'new_member', detectedAt: now }, { id: 'lost_event', eventType: 'follower_unfollow', unfollowerUsername: 'lost_member', detectedAt: now }], total: 2, offset: 0, limit: 100, hasMore: false });
      failures.push('Unexpected admin API: ' + p); return json({}, 404);
    }
    return route.fulfill({ contentType: 'text/html', body: `<html><head><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  const page = await context.newPage(); page.on('pageerror', error => failures.push(error.message)); page.setDefaultTimeout(10000);
  try { await run(page, state); assert.deepEqual(failures, []); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
  finally { state.releaseAlpha?.(); await context.close(); }
}
try {
  await scenario('media tabs use cached admin routes and nested viewers keep the sheet open', async (page, state) => {
    await page.goto(origin); await page.getByTestId('admin-content-posts').waitFor();
    await page.locator('[data-media-state="loaded"] img[alt="@alpha_fixture"]').waitFor();
    await page.getByRole('button', { name: 'View post details for alpha_photo' }).click();
    await page.getByText('@cached_liker', { exact: true }).waitFor();
    await page.getByRole('tab', { name: /Comments \(1\)/ }).click(); await page.getByText('Saved fixture comment', { exact: true }).waitFor();
    await page.keyboard.press('Escape'); await page.getByTestId('admin-tracked-detail').waitFor();
    await page.getByTestId('admin-content-tab-stories').click(); await page.getByRole('button', { name: /Open story from/ }).click();
    await page.getByRole('dialog', { name: 'Story viewer' }).waitFor(); await page.keyboard.press('Escape');
    await page.getByTestId('admin-content-tab-highlights').click(); await page.getByRole('button', { name: 'View highlight details: alpha highlights' }).click();
    await page.getByRole('dialog', { name: /Highlight/ }).waitFor(); await page.keyboard.press('Escape'); await page.getByTestId('admin-tracked-detail').waitFor();
    assert.ok(state.requests.some(url => url.includes('/alpha/posts/alpha_photo/likers'))); assert.ok(state.requests.every(url => !url.includes('refresh=true')));
    assert.equal(await page.getByRole('button', { name: 'View as user' }).count(), 0);
  });
  await scenario('selected post type pages from the same scoped endpoint', async page => {
    await page.goto(origin); await page.getByRole('tab', { name: 'Reels', exact: true }).click();
    await page.getByRole('button', { name: 'View post details for alpha_reel_0' }).waitFor();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await page.getByRole('button', { name: 'View post details for alpha_reel_25' }).waitFor();
  });
  await scenario('liked pagination preserves captured rows and retries failures', async (page, state) => {
    state.likedError = true; await page.goto(origin); await page.getByTestId('admin-content-tab-liked').click();
    await page.getByText('2 of 3 saved posts', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Load more liked posts', exact: true }).click();
    await page.getByRole('button', { name: 'Retry liked posts', exact: true }).waitFor(); assert.equal(await page.getByText('2 of 3 saved posts', { exact: true }).count(), 1);
    state.likedError = false; await page.getByRole('button', { name: 'Retry liked posts', exact: true }).click(); await page.getByText('3 of 3 saved posts', { exact: true }).waitFor();
  });
  await scenario('roster paging, searching and activity distinguish observations', async page => {
    await page.goto(origin); await page.getByTestId('admin-content-tab-followers').click();
    await page.getByText('The baseline is not yet settled.', { exact: false }).waitFor();
    await page.getByRole('searchbox', { name: 'Search followers on this page' }).fill('absent'); await page.getByText('No saved members match on this page.').waitFor();
    await page.getByRole('button', { name: 'Next followers' }).click(); await page.getByText('@later_member', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Previous followers' }).click(); await page.getByText('@saved_member', { exact: true }).waitFor();
    await page.getByTestId('admin-content-tab-following').click(); await page.getByText('@saved_member', { exact: true }).waitFor();
    await page.getByTestId('admin-content-tab-activity').click(); await page.getByText('New follower: @new_member', { exact: true }).waitFor(); await page.getByText('Lost follower: @lost_member', { exact: true }).waitFor();
  }, 390);
  for (const reason of ['private_access_required', 'tracking_inactive', 'subscription_required']) await scenario('private content gated: ' + reason, async (page, state) => {
    state.denied = reason; await page.goto(origin); await page.getByTestId('admin-content-blocked').waitFor();
    assert.equal(await page.getByTestId('admin-content-tab-posts').count(), 0); assert.ok(state.requests.every(url => !/\/(liked-posts|roster|activity|posts)(\?|\/|$)/.test(url)));
  });
  await scenario('paused public history remains viewable when the server authorizes it', async (page, state) => {
    state.pausedPublic = true; await page.goto(origin); await page.getByText('Tracking paused', { exact: true }).waitFor();
    await page.getByTestId('admin-content-posts').waitFor(); assert.equal(await page.getByTestId('admin-content-blocked').count(), 0);
    assert.equal(state.requests.filter(url => url.endsWith('/content')).length, 1);
  });
  await scenario('missing profile totals stay unknown and an authorized cached avatar fills a blank header', async (page, state) => {
    state.unknownRosterTotal = true; state.blankAvatar = true; await page.goto(origin);
    await page.locator('[data-media-state="loaded"] img[alt="@alpha_fixture"]').waitFor();
    await page.getByTestId('admin-content-tab-followers').click(); await page.getByText('The profile total is not available yet.', { exact: false }).waitFor();
    assert.equal(await page.getByText('Profile reported 0.', { exact: false }).count(), 0);
  });
  await scenario('a permission change during roster browsing fails closed', async (page, state) => {
    await page.goto(origin); await page.getByTestId('admin-content-tab-followers').click(); await page.getByText('@saved_member', { exact: true }).waitFor();
    state.rosterDenied = true; await page.getByRole('button', { name: 'Next followers' }).click(); await page.getByText('Content is unavailable', { exact: true }).waitFor();
    assert.equal(await page.getByText('@saved_member', { exact: true }).count(), 0);
  });
  await scenario('content failure can retry without losing account metadata', async (page, state) => {
    state.contentError = true; await page.goto(origin); await page.getByText('Could not load collected content', { exact: true }).waitFor();
    await page.getByRole('heading', { name: '@alpha_fixture' }).waitFor(); state.contentError = false; await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.getByTestId('admin-content-posts').waitFor();
  });
  await scenario('late content from a previous account never populates the next account', async (page, state) => {
    state.slowAlpha = true; await page.goto(origin); await page.getByRole('heading', { name: '@alpha_fixture' }).waitFor();
    for (let i = 0; i < 100 && !state.releaseAlpha; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(state.releaseAlpha);
    await page.evaluate(() => window.switchAccount('beta')); await page.getByText('beta biography', { exact: true }).waitFor(); state.releaseAlpha(); await page.waitForTimeout(100);
    assert.equal(await page.getByText('alpha biography', { exact: true }).count(), 0); await page.getByRole('button', { name: 'View post details for beta_photo' }).waitFor();
  });
} finally { await browser.close(); }
const report = { sourceComponent: true, syntheticApi: true, providerRequests: 0, checks, passed: checks.every(check => check.passed) };
await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
