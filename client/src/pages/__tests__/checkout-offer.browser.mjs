// Real checkout UI, bundled from source, with synthetic API responses only.
// No Stripe sessions, customer records, messages or provider calls are created.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const origin = 'https://checkout-offer.example.invalid';
const evidence = process.argv[2] ?? '/tmp/checkout-offer-browser';
await mkdir(evidence, { recursive: true });
const output = await build({ stdin: { contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{useLocation}from'wouter';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
import './client/src/i18n';import Payment from './client/src/pages/Payment';import Settings from './client/src/pages/Settings';
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
function Fixture(){const[location]=useLocation();return location==='/settings'?<><p>Fixture billing settings</p><Settings/></>:location==='/fixture-checkout'?<p>Fixture checkout reached</p>:<Payment/>}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><Fixture/></QueryClientProvider>);`, resolveDir: repo, loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env.PROD': 'false', 'import.meta.env.VITE_POSTHOG_KEY': '""' } });
let css = '';
try { const assets = path.join(repo, 'dist/public/assets'); const file = (await readdir(assets)).find(name => name.endsWith('.css')); if (file) css = await readFile(path.join(assets, file), 'utf8'); } catch { /* Source behavior does not need a previous production build. */ }
const prices = { starter: 1199, standard: 1999, pro: 3499 };
const offer = (plan, state) => ({ version: `${plan}-${state.version}`, plan, currency: 'usd', trialDays: state.trial ? 3 : 0,
  dueTodayAmount: state.trial ? state.advance ? 99 : 0 : prices[plan], creditAmount: state.trial && state.advance ? 99 : 0,
  recurringAmount: prices[plan], firstMonthlyAmount: prices[plan] - (state.trial && state.advance ? 99 : 0),
  requiresAcceptance: state.trial && state.advance, cancellationPolicy: state.trial && state.advance ? state.policy : 'none', ...state.overrides });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const checks = [];
async function scenario(name, run, { width = 1280, language = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, reducedMotion: 'reduce' });
  const state = { trial: true, advance: true, version: 'v1', policy: 'retain_credit', hasAccess: false, fail: false, overrides: {},
    checkouts: [], offers: [], stale: false, delayStarter: false, releaseStarter: null, creditStatus: 'credited', creditApplied: 99,
    canceled: false, retentionUnavailable: false, retentionAccepted: false };
  const failures = [];
  await context.addInitScript(language => { localStorage.setItem('i18nextLng', language); }, language);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    if (url.origin !== origin) { failures.push('Unexpected external request'); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/fixture.js') return route.fulfill({ contentType: 'application/javascript', body: output.outputFiles[0].text });
    if (p.startsWith('/celebs/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>' });
    if (p === '/api/auth/me') return json({ id: 'fixture_user', name: 'Fixture subscriber', email: 'fixture@example.invalid', role: 'user' });
    if (p === '/api/billing/eligibility') {
      const plan = url.searchParams.get('plan'); state.offers.push(plan);
      if (state.delayStarter && plan === 'starter') {
        await new Promise(resolve => { state.releaseStarter = resolve; });
        try { return await json({ trialEligible: state.trial, hasAccess: false, offer: offer(plan, state) }); } catch { return; }
      }
      return state.fail ? json({ message: 'Fixture unavailable' }, 503) : json({ trialEligible: state.trial, hasAccess: state.hasAccess, offer: offer(plan, state) });
    }
    if (p === '/api/billing/checkout' && request.method() === 'POST') {
      state.checkouts.push(JSON.parse(request.postData()));
      if (state.stale) { state.stale = false; state.version = 'v2'; return json({ code: 'offer_changed', message: 'Payment terms changed. Review the current offer.' }, 409); }
      return json({ url: `${origin}/fixture-checkout` });
    }
    if (p === '/api/billing/subscription') return json({ id: 'subscription_fixture', userId: 'fixture_user', stripeCustomerId: 'cus_fixture', stripeSubscriptionId: 'sub_fixture',
      status: 'trialing', plan: 'standard', trialEndsAt: new Date(Date.now() + 3 * 86400000).toISOString(), currentPeriodEnd: new Date(Date.now() + 3 * 86400000).toISOString(),
      cancelAtPeriodEnd: state.canceled, updatedAt: '2026-09-24T12:00:00.000Z', ...(state.advance ? { trialPayment: { amount: 99, currency: 'usd', creditStatus: state.creditStatus, cancellationPolicy: state.policy } } : {}) });
    if (p === '/api/billing/invoice-preview') return json({ amount: 1999 - state.creditApplied, currency: 'usd', invoiceTotal: 1999, creditApplied: state.creditApplied });
    if (p === '/api/billing/retention-offer' && request.method() === 'POST') return state.retentionUnavailable ? json({}, 503) : json({ eligible: true, offerId: 'offer_fixture', currency: 'usd', amount: 901, regularAmount: 1900, recurringAmount: 1999, creditApplied: 99, trial: true, expiresAt: new Date(Date.now() + 300000).toISOString() });
    if (p === '/api/billing/retention-accept' && request.method() === 'POST') { state.retentionAccepted = true; return json({ message: 'Fixture retention confirmed.' }); }
    if (p === '/api/billing/cancel' && request.method() === 'POST') { state.canceled = true; return json({ message: 'Your cancellation is confirmed.' }); }
    if (p.startsWith('/api/')) { failures.push('Unexpected API request: ' + p); return json({}, 404); }
    return route.fulfill({ contentType: 'text/html', body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` });
  });
  const page = await context.newPage(); page.on('pageerror', error => failures.push(error.message)); page.setDefaultTimeout(10000);
  try { await run(page, state); assert.deepEqual(failures, []); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
  finally { state.releaseStarter?.(); await context.close(); }
}
const open = async page => { await page.goto(`${origin}/payment`); await page.getByTestId('checkout-offer').waitFor(); };
const disabled = async page => assert.equal(await page.getByTestId('checkout-continue').isDisabled(), true);
try {
  await scenario('99-cent offer shows net estimate, requires consent and posts the accepted version', async (page, state) => {
    await open(page); assert.equal(await page.getByTestId('checkout-due-today').innerText(), '$0.99');
    await page.getByTestId('checkout-offer').getByText('$19.00', { exact: true }).waitFor();
    assert.match(await page.getByTestId('checkout-offer').innerText(), /\$19\.99\/month/);
    assert.doesNotMatch(await page.locator('body').innerText(), /free trial|continue for free|\$0 now/i);
    await disabled(page); await page.getByTestId('checkout-offer-accept').check();
    assert.equal(await page.getByTestId('checkout-continue').isEnabled(), true);
    await page.getByTestId('checkout-continue').click(); await page.getByText('Fixture checkout reached').waitFor();
    assert.deepEqual(state.checkouts, [{ plan: 'standard', acceptedOfferVersion: 'standard-v1' }]);
  });
  await scenario('grandfathered zero-cost trial does not display a new upfront payment or checkbox', async (page, state) => {
    state.advance = false; await open(page); assert.equal(await page.getByTestId('checkout-due-today').innerText(), '$0.00');
    assert.equal(await page.getByTestId('checkout-offer-accept').count(), 0); assert.equal(await page.getByTestId('checkout-continue').isEnabled(), true);
    await page.getByText('Your first 3 days have no membership charge.', { exact: false }).waitFor();
    assert.equal(await page.getByText('Credit toward your next invoice', { exact: true }).count(), 0);
  });
  await scenario('returning non-trial customer sees a before-credit estimate without another advance or trial consent', async (page, state) => {
    state.trial = false; await open(page); assert.equal(await page.getByTestId('checkout-due-today').innerText(), '$19.99');
    assert.equal(await page.getByTestId('checkout-offer-accept').count(), 0); assert.equal(await page.getByTestId('checkout-continue').isEnabled(), true);
    assert.equal(await page.getByText('Includes a 3-day trial', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Due today', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Estimate before existing credit', { exact: true }).count(), 2);
    await page.getByTestId('checkout-offer').getByText('Existing invoice credit can reduce this amount.', { exact: false }).waitFor();
    assert.equal(await page.getByText('Credit toward your next invoice', { exact: true }).count(), 0);
    assert.equal(await page.getByTestId('checkout-continue').innerText(), 'Continue to secure checkout');
  });
  await scenario('quote outage blocks payment until a successful explicit retry', async (page, state) => {
    state.fail = true; await page.goto(`${origin}/payment`); await page.getByRole('button', { name: 'Reload billing details' }).waitFor(); await disabled(page);
    state.fail = false; await page.getByRole('button', { name: 'Reload billing details' }).click(); await page.getByTestId('checkout-offer').waitFor();
    await disabled(page); assert.equal(state.checkouts.length, 0);
  });
  await scenario('malformed fractional minor units never become a displayed valid offer', async (page, state) => {
    state.overrides = { dueTodayAmount: 0.99 }; await page.goto(`${origin}/payment`);
    await page.getByRole('button', { name: 'Reload billing details' }).waitFor(); await disabled(page);
    assert.equal(await page.getByTestId('checkout-offer').count(), 0);
  });
  await scenario('stale offer rejects payment and requires renewed consent after refresh', async (page, state) => {
    state.stale = true; await open(page); await page.getByTestId('checkout-offer-accept').check(); await page.getByTestId('checkout-continue').click();
    await page.getByText('Payment terms changed. Review the current offer.').waitFor(); await page.getByTestId('checkout-offer').waitFor();
    assert.equal(await page.getByTestId('checkout-offer-accept').isChecked(), false); await disabled(page);
    await page.getByTestId('checkout-offer-accept').check(); await page.getByTestId('checkout-continue').click(); await page.getByText('Fixture checkout reached').waitFor();
    assert.deepEqual(state.checkouts.map(value => value.acceptedOfferVersion), ['standard-v1', 'standard-v2']);
  });
  await scenario('switching plans clears consent and ignores an older delayed plan offer', async (page, state) => {
    state.delayStarter = true; await open(page); await page.getByTestId('checkout-offer-accept').check();
    await page.getByRole('button', { name: /Starter.*Track 1 Instagram account/ }).click(); await disabled(page);
    for (let i = 0; i < 100 && !state.releaseStarter; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(state.releaseStarter);
    await page.getByRole('button', { name: /Pro.*Track up to 6 Instagram accounts/ }).click(); await page.getByTestId('checkout-offer').getByText('$34.00', { exact: true }).waitFor();
    state.releaseStarter(); await page.waitForTimeout(100); await page.getByTestId('checkout-offer').getByText('$34.00', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('checkout-offer-accept').isChecked(), false); await disabled(page);
    await page.getByTestId('checkout-offer-accept').check(); await page.getByTestId('checkout-continue').click(); await page.getByText('Fixture checkout reached').waitFor();
    assert.equal(state.checkouts[0].plan, 'pro'); assert.equal(state.checkouts[0].acceptedOfferVersion, 'pro-v1');
  });
  await scenario('cancel return makes no unsupported claim that payment was never taken', async page => {
    await page.goto(`${origin}/payment?checkout=cancelled`); await page.getByTestId('checkout-offer').waitFor();
    await page.getByText('You returned from checkout. Review your billing status before starting another payment.').waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /not been charged/i); assert.equal(new URL(page.url()).searchParams.has('checkout'), false);
  });
  await scenario('refundable policy appears only when provided by the server', async (page, state) => {
    state.policy = 'refund_during_trial'; await open(page); await page.getByText('end access immediately and receive a refund of your unused $0.99 advance', { exact: false }).waitFor();
    assert.equal(await page.getByText('not automatically refunded', { exact: false }).count(), 0);
  });
  await scenario('existing subscription redirects to billing without creating checkout', async (page, state) => {
    state.hasAccess = true; await page.goto(`${origin}/payment`); await page.getByText('Fixture billing settings').waitFor(); assert.equal(state.checkouts.length, 0);
  });
  await scenario('billing shows net amount due and separates applied balance from a past credit issuance', async page => {
    await page.goto(`${origin}/settings?tab=billing`); await page.getByTestId('billing-credit-breakdown').waitFor();
    await page.getByText('$19.00', { exact: true }).waitFor();
    assert.match(await page.getByTestId('billing-credit-breakdown').innerText(), /Invoice before balance credit[\s\S]*\$19\.99[\s\S]*Balance credit applied[\s\S]*−\$0\.99/);
    assert.match(await page.getByTestId('billing-trial-payment').innerText(), /may already have been applied/);
    assert.doesNotMatch(await page.getByTestId('billing-trial-payment').innerText(), /available credit/i);
  });
  await scenario('issued credit is not shown as still spendable after another invoice used it', async (page, state) => {
    state.creditApplied = 0; await page.goto(`${origin}/settings?tab=billing`); await page.getByTestId('billing-trial-payment').waitFor();
    await page.getByText('$19.99', { exact: true }).waitFor(); assert.equal(await page.getByTestId('billing-credit-breakdown').count(), 0);
  });
  await scenario('refunded credit and pending confirmation remain distinct in billing', async (page, state) => {
    state.creditApplied = 0; state.creditStatus = 'refunded'; await page.goto(`${origin}/settings?tab=billing`);
    await page.getByTestId('billing-trial-payment').getByText('refund is confirmed', { exact: false }).waitFor();
    assert.match(await page.getByTestId('billing-trial-payment').innerText(), /no longer available/);
    state.creditStatus = 'pending'; await page.reload(); await page.getByTestId('billing-trial-payment').getByText('still being confirmed', { exact: false }).waitFor();
    assert.doesNotMatch(await page.getByTestId('billing-trial-payment').innerText(), /refund is confirmed|was added once/);
  });
  await scenario('cancellation keeps net retention estimate, recurring rate and retained-credit policy separate', async (page, state) => {
    await page.goto(`${origin}/settings?tab=billing`); await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();
    await page.getByTestId('retention-accept').waitFor(); const dialog = page.getByTestId('cancellation-dialog');
    assert.match(await dialog.innerText(), /\$9\.01 estimated[\s\S]*Then \$19\.99 per month/);
    assert.match(await dialog.innerText(), /estimate includes \$0\.99 in balance credit/);
    assert.match(await dialog.innerText(), /unused advance remains as invoice credit/);
    await page.getByTestId('retention-accept').click(); await page.getByText('Fixture retention confirmed.').waitFor(); assert.equal(state.retentionAccepted, true);
  });
  await scenario('cancellation remains available when retention fails and shows only the persisted refund policy', async (page, state) => {
    state.policy = 'refund_during_trial'; state.retentionUnavailable = true; await page.goto(`${origin}/settings?tab=billing`);
    await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();
    await page.getByTestId('cancellation-dialog').getByText('access ends immediately', { exact: false }).waitFor();
    await page.getByTestId('cancellation-dialog').getByText('receive a refund of your unused advance', { exact: false }).waitFor();
    await page.getByText('We could not check offer availability. You can still cancel.').waitFor();
    await page.getByTestId('cancellation-confirm').click(); await page.getByText('Your cancellation is confirmed.').waitFor(); assert.equal(state.canceled, true);
  });
  for (const language of ['en', 'es', 'pt', 'ru']) await scenario(`mobile ${language} disclosure is translated, visible and has no horizontal overflow`, async (page, state) => {
    await open(page); const text = await page.getByTestId('checkout-offer').innerText();
    assert.ok(!text.includes('payment.')); assert.match(text, /0[.,]99/);
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.width + 1); await page.getByTestId('checkout-offer-accept').check();
    assert.equal(await page.getByTestId('checkout-continue').isEnabled(), true);
    state.trial = false; await page.reload(); await page.getByTestId('checkout-offer').waitFor();
    assert.doesNotMatch(await page.getByTestId('checkout-offer').innerText(), /\bpayment\.[A-Za-z]/);
    assert.equal(await page.getByTestId('checkout-offer-accept').count(), 0);
    const returningDimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(returningDimensions.scroll <= returningDimensions.width + 1);
  }, { width: 390, language });
} finally { await browser.close(); }
const report = { sourceComponent: true, syntheticApi: true, providerRequests: 0, checks, passed: checks.every(check => check.passed) };
await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
