import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ buildHttp: vi.fn(), evaluate: vi.fn(), launch: vi.fn(),
  goto: vi.fn(), url: vi.fn(), context: vi.fn(), storage: vi.fn(), close: vi.fn(), follow: vi.fn(), legacyFollow: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: f.launch } }));
vi.mock('../services/bot-follow-browser.js', () => ({ sendBrowserFollow: f.follow }));
vi.mock('../ig-playwright-client.js', () => ({ playwrightSendFollowByUsername: f.legacyFollow }));
vi.mock('../services/bandwidth-meter.js', () => ({ recordBytes: vi.fn() }));
vi.mock('../observability/logger.js', () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn() }) } }));
vi.mock('../ig-http-client.js', () => ({
  createHttpBotClientWithFingerprint: f.buildHttp,
  IGHttpError: class extends Error { constructor(readonly status: number, message: string, options: object) { super(message); Object.assign(this, options); } },
  IGAuthExpiredError: class extends Error { constructor(message: string, options: object) { super(message); Object.assign(this, options); this.name = 'IGAuthExpiredError'; } },
  IGRateLimitedError: class extends Error {},
}));
import { createBrowserReadClient, type BrowserReadClientOptions } from '../ig-browser-read-client.js';
const options = { sessionData: '{"cookies":[]}', fingerprint: { userAgent: 'fixture', locale: 'en-US', timezone: 'UTC', appId: 'fixture' },
  botUsername: 'viewer', botId: 'viewer-1', proxyEndpoint: 'proxy.invalid:10001:user:password', fallbackToHttp: false,
} as BrowserReadClientOptions;
let http: Record<string, ReturnType<typeof vi.fn>>;
const result = (body: unknown, status = 200, url = 'https://www.instagram.com/api/v1/example/') => ({ ok: status >= 200 && status < 300,
  status, statusText: '', url, text: typeof body === 'string' ? body : JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  http = { fetchFollowers: vi.fn(), fetchFollowing: vi.fn(), fetchProfile: vi.fn(), sendFollow: vi.fn(), close: vi.fn() };
  f.buildHttp.mockReturnValue(http);
  f.url.mockReturnValue('https://www.instagram.com/'); f.storage.mockResolvedValue({ cookies: [] });
  f.context.mockResolvedValue({ setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, close: f.close,
    storageState: f.storage, newPage: async () => ({ isClosed: () => false, goto: f.goto, url: f.url, evaluate: f.evaluate }) });
  f.launch.mockResolvedValue({ newContext: f.context, close: f.close });
  f.evaluate.mockResolvedValue(result({ status: 'ok' }));
});

describe('explicit browser API transport boundaries', () => {
  it.each(['fetchFollowers', 'fetchFollowing'] as const)('preserves a restricted %s result without secretly calling HTTP', async method => {
    f.evaluate.mockResolvedValue(result({ users: [], special_empty_state: { title: 'Limited' } }));
    const client = await createBrowserReadClient(options);
    expect(await client[method]('123')).toMatchObject({ users: [], restricted: true });
    expect(http[method]).not.toHaveBeenCalled();
    await client.close();
  });
  it('fails before browser launch when its assigned proxy is invalid', async () => {
    await expect(createBrowserReadClient({ ...options, proxyEndpoint: 'invalid' })).rejects.toThrow('refusing direct connection');
    expect(f.launch).not.toHaveBeenCalled();
  });
  it.each(['https://unrelated.invalid/api/', '//unrelated.invalid/api/', 'http://www.instagram.com/api/'])('rejects a foreign raw read %s before navigation', async path => {
    const client = await createBrowserReadClient(options);
    await expect(client.fetchRaw!(path)).rejects.toThrow('outside the Instagram origin');
    expect(f.launch).not.toHaveBeenCalled(); expect(f.evaluate).not.toHaveBeenCalled();
  });
  it('rejects a navigation redirected outside Instagram without issuing the API request', async () => {
    f.url.mockReturnValue('https://unrelated.invalid/');
    const client = await createBrowserReadClient(options);
    await expect(client.fetchRaw!('/api/v1/example/')).rejects.toThrow('navigation left');
    expect(f.evaluate).not.toHaveBeenCalled();
  });
  it.each([{ status: 'fail', message: 'temporary error' }, { status: 'fail', message: 'challenge_required' }])('does not accept a failed HTTP 200 envelope as empty data', async body => {
    f.evaluate.mockResolvedValue(result(body));
    const client = await createBrowserReadClient(options);
    await expect(client.fetchHighlightsTray('123')).rejects.toThrow();
    expect(http.fetchHighlightsTray).toBeUndefined();
  });
  it('rejects a story response for another owner', async () => {
    f.evaluate.mockResolvedValue(result({ reels_media: [{ id: '999', items: [] }] }));
    const client = await createBrowserReadClient(options);
    await expect(client.fetchStoriesTray('123')).rejects.toThrow('another account');
  });
  it('does not perform a pk-only HTTP follow write when the browser target was never verified', async () => {
    const client = await createBrowserReadClient(options);
    await expect(client.sendFollow('123')).rejects.toThrow('previously verified target');
    expect(http.sendFollow).not.toHaveBeenCalled(); expect(f.legacyFollow).not.toHaveBeenCalled();
  });
  it('routes a migrated verified follow through the real browser helper using refreshed cookies', async () => {
    http.fetchProfile.mockResolvedValue({ pk: '123', username: 'target' });
    http.exportSessionData = vi.fn(() => 'refreshed-cookie-state');
    f.follow.mockResolvedValue({ following: false, outgoingRequest: true });
    const client = await createBrowserReadClient({ ...options, automationIdentity: { bot_id: 'viewer-1' } as never });
    await client.fetchProfile('target');
    expect(await client.sendFollow('123')).toMatchObject({ outgoingRequest: true });
    expect(f.follow).toHaveBeenCalledWith(expect.objectContaining({ botId: 'viewer-1', sessionData: 'refreshed-cookie-state' }), 'target', '123');
    expect(http.sendFollow).not.toHaveBeenCalled();
    expect(f.buildHttp.mock.calls[0].at(-1)).toBe('browser');
  });
});
