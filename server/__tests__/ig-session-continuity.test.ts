import { describe, expect, it, vi } from 'vitest';
import type { AutomationIdentity } from '../services/automation-client.js';

const { http, browser } = vi.hoisted(() => ({ http: vi.fn(), browser: vi.fn() }));
vi.mock('../services/bandwidth-meter.js', () => ({ recordBytes: vi.fn() }));
vi.mock('../services/automation-client.js', () => ({ createAutomationClient: () => ({ requestInstagramHttp: http, requestInstagramBrowser: browser }) }));
import { createHttpBotClientWithFingerprint } from '../ig-http-client.js';

const initial = { cookies: [
  { name: 'sessionid', value: 'saved-session', domain: '.instagram.com', expires: 4102444800 },
  { name: 'csrftoken', value: 'old-csrf', domain: '.instagram.com', expires: 4102444800 },
] };
const refreshed = { cookies: initial.cookies.map(c => c.name === 'csrftoken' ? { ...c, value: 'new-csrf' } : c) };

describe('automation cookie/CSRF continuity', () => {
  it.each(['http', 'browser'] as const)('uses the latest %s cookie and header on the next request and exported handoff', async lane => {
    const id = `continuity-${lane}`;
    const identity: AutomationIdentity = { identity_version: 1, client: 'instagram-firefox-web', bot_id: id,
      browser_seed: 1, browser_family: 'firefox', browser_version: 'fixture', platform: 'Windows',
      user_agent: 'fixture Firefox', http_impersonate: 'fixture', ja3: 'fixture', h2_fingerprint: 'fixture', locale: 'en-US', timezone: 'UTC' };
    const mock = lane === 'http' ? http : browser;
    mock.mockReset();
    mock.mockResolvedValueOnce({ status: 200, body: '{"status":"ok"}', headers: { 'content-type': 'application/json', 'x-ig-set-www-claim': 'next-claim' }, storage_state: refreshed });
    mock.mockResolvedValueOnce({ status: 200, body: '{"status":"ok"}', headers: { 'content-type': 'application/json' } });
    const client = createHttpBotClientWithFingerprint(JSON.stringify(initial), null, 'fixture_bot', 'localhost:19090', id, identity, lane);
    await client.fetchRaw!('/api/v1/feed/reels_media/?reel_ids=123');
    await client.fetchRaw!('/api/v1/feed/reels_media/?reel_ids=456');
    const next = mock.mock.calls[1][0];
    expect(next.storage_state).toEqual(refreshed);
    expect(next.request.headers['x-csrftoken']).toBe('new-csrf');
    expect(next.request.headers['x-ig-www-claim']).toBe('next-claim');
    expect(JSON.parse(client.exportSessionData!())).toEqual(refreshed);
    await client.close();
  });
});
