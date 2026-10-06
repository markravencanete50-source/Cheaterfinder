// Compile the real customer posts grid; every request is fulfilled offline.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = process.argv[2] ?? '/tmp/customer-posts-browser';
const origin = 'https://posts.example.invalid';
await mkdir(evidence, { recursive: true });
const output = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import './client/src/i18n';
import OwnPostsGrid from './client/src/components/dashboard/OwnPostsGrid';
const post=n=>({shortcode:'reel_'+n,postType:'reel',thumbnailUrl:'/fixture.svg'});
function Fixture(){const[account,setAccount]=useState('first');const[kind,setKind]=useState('reel');
const[status,setStatus]=useState({state:'available',savedTotal:51,recordedProfileCount:80,recordedProfileAt:'2026-09-20T12:00:00Z',lastPostsReadAt:'2026-09-20T12:10:00Z',lastAttemptAt:null,nextRetryAt:null,trackingActive:true,source:'account'});
window.configure=value=>{if(value.account)setAccount(value.account);if(value.kind)setKind(value.kind);if(value.status)setStatus(old=>({...old,...value.status}));};
const posts=account==='first'&&status.savedTotal>0&&kind==='reel'?Array.from({length:24},(_,i)=>post(i)):[];
return <OwnPostsGrid posts={posts} postType={kind} onPostTypeChange={setKind} accountId={account} dataSource={status.savedTotal?'cached':'none'} collectionStatus={status} postCounts={{all:status.savedTotal,photo:24,reel:27,video:0,carousel:0}}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"test"' } });
let css = '';
try { const assets = path.join(root, 'dist/public/assets'); const name = (await readdir(assets)).find(name => name.endsWith('.css')); if (name) css = await readFile(path.join(assets, name), 'utf8'); } catch {}
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const checks = [];
async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('i18nextLng', 'en'));
  const state = { calls: [], failures: [], failPage: false, delay: false, release: null };
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || route.request().method() !== 'GET') { state.failures.push('Unexpected request'); return route.abort(); }
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: output.outputFiles[0].text });
    if (url.pathname === '/fixture.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="purple"/></svg>' });
    if (url.pathname.startsWith('/api/')) {
      state.calls.push(url.pathname + url.search);
      if (url.pathname !== '/api/tracking/accounts/first/posts') { state.failures.push('Wrong customer scope'); return route.fulfill({ status: 404, json: {} }); }
      if (state.delay) await new Promise(resolve => { state.release = resolve; });
      if (state.failPage) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: { items: [24,25,26].map(n => ({ shortcode: 'reel_' + n, postType: 'reel', thumbnailUrl: '/fixture.svg' })), offset: 24, limit: 12, hasMore: false } }).catch(() => {});
    }
    return route.fulfill({ contentType: 'text/html', body: `<html><head><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => state.failures.push(error.message));
  try { await page.goto(origin); await run(page, state); assert.deepEqual(state.failures, []); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
  finally { state.release?.(); await context.close(); }
}
const loadPage = async page => { for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Load more', exact: true }).click(); };
try {
  await scenario('customer type paging sends the selected type and reveals later saved reels', async (page, state) => {
    await loadPage(page); await page.getByRole('button', { name: 'View post details for reel_26' }).waitFor();
    assert.deepEqual(state.calls, ['/api/tracking/accounts/first/posts?offset=24&limit=12&postType=reel']);
    assert.equal(await page.getByRole('button', { name: 'Load more', exact: true }).count(), 0);
  });
  await scenario('failed filtered page remains retryable and preserves the saved preview', async (page, state) => {
    state.failPage = true; await loadPage(page); await page.getByRole('button', { name: 'Retry loading posts' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'View post details for reel_0', exact: true }).count(), 1);
    state.failPage = false; await page.getByRole('button', { name: 'Retry loading posts' }).click(); await page.getByRole('button', { name: 'View post details for reel_26' }).waitFor();
  });
  await scenario('positive reported count and delayed empty cache do not claim an empty Instagram profile', async page => {
    await page.evaluate(() => window.configure({ kind: 'all', status: { state: 'delayed', savedTotal: 0, recordedProfileCount: 80, lastPostsReadAt: null, nextRetryAt: '2026-09-25T00:00:00Z' } }));
    await page.getByText('No posts saved yet.', { exact: true }).waitFor();
    const notice = page.getByTestId('posts-collection-status');
    assert.match(await notice.innerText(), /0 saved posts.*Last recorded profile count: 80 posts/s);
    assert.match(await notice.innerText(), /collection is delayed/); assert.match(await notice.innerText(), /Scheduled check/);
    assert.equal(await page.getByText('No posts to show.', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(evidence, 'delayed-empty-mobile.png'), fullPage: true });
  });
  await scenario('empty type preserves total saved evidence and says filter-empty', async page => {
    await page.getByRole('tab', { name: 'Videos', exact: true }).click();
    await page.getByText('No saved posts match this filter.', { exact: true }).waitFor();
    assert.match(await page.getByTestId('posts-collection-status').innerText(), /51 saved posts/);
    assert.equal(await page.getByText('No posts saved yet.', { exact: true }).count(), 0);
  });
  await scenario('unknown count and blocked private access are never displayed as reported zero', async page => {
    await page.evaluate(() => window.configure({ kind: 'all', status: { state: 'not_collected', savedTotal: 0, recordedProfileCount: null, recordedProfileAt: null, lastPostsReadAt: null } }));
    await page.getByText("Instagram's post count is not known yet.", { exact: false }).waitFor();
    assert.doesNotMatch(await page.getByTestId('posts-collection-status').innerText(), /recorded profile count: 0/);
    await page.evaluate(() => window.configure({ status: { state: 'waiting_for_access', savedTotal: null } }));
    await page.getByText('Posts are unavailable.', { exact: true }).waitFor();
    assert.doesNotMatch(await page.getByTestId('posts-collection-status').innerText(), /0 saved posts/);
  });
  await scenario('recorded zero retains dated cache evidence and paused tracking remains visible', async page => {
    await page.evaluate(() => window.configure({ kind: 'all', status: { state: 'empty_observed', savedTotal: 0, recordedProfileCount: 0, trackingActive: false } }));
    await page.getByText('No posts are saved from the last collection.', { exact: true }).waitFor();
    assert.match(await page.getByTestId('posts-collection-status').innerText(), /Profile recorded/);
    assert.match(await page.getByTestId('posts-collection-status').innerText(), /Posts last saved\/read/);
    assert.match(await page.getByTestId('posts-collection-status').innerText(), /Tracking is paused/);
  });
  await scenario('late filtered page cannot populate a different customer target', async (page, state) => {
    state.delay = true; await loadPage(page); await page.waitForFunction(() => document.querySelector('button')?.textContent !== '');
    const deadline = Date.now() + 10000;
    while (!state.release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(state.release, "Expected a pending customer pagination request");
    await page.evaluate(() => window.configure({ account: 'second', status: { savedTotal: 0, state: 'not_collected' } }));
    state.release(); await page.getByText('No saved posts match this filter.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'View post details for reel_26' }).count(), 0);
  });
} finally { await browser.close(); }
const report = { passed: checks.every(check => check.passed), scope: 'Compiled customer posts grid, synthetic responses, all external/provider requests blocked', checks };
await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
