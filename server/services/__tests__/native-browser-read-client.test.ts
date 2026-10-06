import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ native: vi.fn(), http: vi.fn(), browserApi: vi.fn(), persist: vi.fn(), bytes: vi.fn() }));
vi.mock('../automation-client.js', () => ({ createAutomationClient: () => ({
  readNativePublicPage: f.native, requestInstagramHttp: f.http, requestInstagramBrowser: f.browserApi,
}) }));
vi.mock('../web-session-refresh.js', () => ({ persistRefreshedWebSession: f.persist }));
vi.mock('../bandwidth-meter.js', () => ({ recordBytes: f.bytes }));
vi.mock('../../observability/logger.js', () => {
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return { logger };
});
import { createNativeBrowserReadClient } from '../native-browser-read-client.js';
import { readNativePublic, type NativeViewer } from '../native-public-read.js';
import { IGHttpError, IGRateLimitedError } from '../../ig-http-client.js';
import { withMediaBrowserFallback } from '../media-browser-fallback.js';
import { classifyInstagramResponse } from '../ig-response-diagnostics.js';
import { logger } from '../../observability/logger.js';
import type { IGClientPort } from '../../domain/ig-client-port.js';

const viewer = { id: 'viewer-1', transport: 'web', automationIdentity: { bot_id: 'viewer-1' },
  proxyEndpoint: 'proxy.invalid:10001:user:password', sessionData: '{"cookies":[]}',
} as NativeViewer;
const profile = { status: 'ok', user: { pk: '123', username: 'fixture', is_private: false,
  follower_count: 2, following_count: 3, media_count: 1 } };
const response = (body: unknown, status = 200) => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body), headers: {} });
beforeEach(() => {
  vi.clearAllMocks();
  f.native.mockResolvedValue(response(profile));
  f.persist.mockResolvedValue(true);
  f.http.mockImplementation(() => { throw new Error('Unexpected HTTP replay'); });
  f.browserApi.mockImplementation(() => { throw new Error('Unexpected in-page API replay'); });
});

describe('genuine native browser UI boundary', () => {
  it('recovers the verified highlights homepage redirect through the UI boundary without API replay', async () => {
    const error = new IGHttpError(200, 'response not JSON for GET highlights', {
      responseDiagnostics: classifyInstagramResponse('<title>Instagram</title>', { 'content-type': 'text/html' }, 'instagram_home', true),
    });
    const primary = vi.fn().mockRejectedValue(error);
    f.native.mockResolvedValue(response({ status: 'ok', tray: [{ id: 'highlight:123', title: 'Fixture' }], reels_media: [] }));
    const beforeFallback = vi.fn();
    const client = withMediaBrowserFallback({ fetchHighlightsTray: primary } as unknown as IGClientPort, {
      beforeFallback,
      createBrowser: async () => createNativeBrowserReadClient({ viewer, username: 'fixture', reserveExtra: vi.fn() }),
    });
    await expect(client.fetchHighlightsTray('123')).resolves.toMatchObject({ items: [{ id: 'highlight:123' }] });
    expect(primary).toHaveBeenCalledOnce();
    expect(f.native).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'highlights', target_username: 'fixture', target_user_id: '123', identity: viewer.automationIdentity,
    }));
    expect(beforeFallback).toHaveBeenCalledExactlyOnceWith('highlights');
    expect(f.http).not.toHaveBeenCalled(); expect(f.browserApi).not.toHaveBeenCalled();
  });

  it.each(['native_highlights_response_missing', 'native_highlights_incomplete', 'native_authentication_unverified', 'native_read_deadline', 'native_browser_failed'])(
    'preserves the fixed native failure reason %s without serializing provider data', async reason => {
      f.native.mockResolvedValue(response({ status: 'fail', message: reason, detail: 'secret-fixture-payload' }, 502));
      await expect(readNativePublic(viewer, 'highlights', 'fixture', '123')).rejects.toMatchObject({
        status: 502, message: `Native highlights read failed (${reason})`,
      });
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith({ endpoint: 'highlights', status: 502, nativeReason: reason },
        'Native UI read did not complete');
      const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
      expect(logged).not.toContain('secret-fixture-payload');
      expect(logged).not.toContain('proxy.invalid');
      expect(logged).not.toContain('fixture');
      expect(f.persist).not.toHaveBeenCalled();
      expect(f.http).not.toHaveBeenCalled(); expect(f.browserApi).not.toHaveBeenCalled();
    },
  );

  it('does not reflect an unrecognized native reason into errors or diagnostics', async () => {
    f.native.mockResolvedValue(response({ status: 'fail', message: 'private-token-in-arbitrary-message' }, 502));
    await expect(readNativePublic(viewer, 'highlights', 'fixture', '123')).rejects.toMatchObject({
      message: 'Native highlights read failed (native_read_failed)',
    });
    expect(logger.warn).toHaveBeenCalledWith({ endpoint: 'highlights', status: 502, nativeReason: 'native_read_failed' },
      'Native UI read did not complete');
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('private-token');
  });

  it('uses public-page navigation with the exact viewer/proxy and never calls either API replay transport', async () => {
    const client = createNativeBrowserReadClient({ viewer, username: 'fixture', reserveExtra: vi.fn() });
    expect(await client.fetchProfile('fixture')).toMatchObject({ pk: '123', username: 'fixture' });
    expect(f.native).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ identity: viewer.automationIdentity,
      storage_state: { cookies: [] }, target_username: 'fixture', kind: 'profile',
      proxy: { server: 'http://proxy.invalid:10001', username: 'user', password: 'password' },
    }));
    expect(f.http).not.toHaveBeenCalled(); expect(f.browserApi).not.toHaveBeenCalled();
  });
  it('rejects an API cursor instead of replaying it as a native UI page', async () => {
    const reserveExtra = vi.fn();
    const client = createNativeBrowserReadClient({ viewer, username: 'fixture', reserveExtra });
    await expect(client.fetchUserFeed('123', { maxId: 'api-cursor' })).rejects.toThrow('API pagination cursors');
    expect(f.native).not.toHaveBeenCalled(); expect(reserveExtra).not.toHaveBeenCalled();
  });
  it('reserves UI pagination before navigating and preserves a valid empty result', async () => {
    f.native.mockResolvedValue(response({ status: 'ok', items: [], more_available: false, num_results: 0 }));
    const reserveExtra = vi.fn();
    const client = createNativeBrowserReadClient({ viewer, username: 'fixture', reserveExtra });
    expect(await client.fetchUserFeed('123', { count: 24 })).toMatchObject({ items: [] });
    expect(reserveExtra).toHaveBeenCalledExactlyOnceWith('posts', 2);
    expect(reserveExtra.mock.invocationCallOrder[0]).toBeLessThan(f.native.mock.invocationCallOrder[0]);
  });
  it.each(['fetchFollowers', 'fetchFollowing', 'fetchMediaComments', 'fetchMediaLikers', 'sendFollow', 'fetchRaw'] as const)('does not disguise unsupported %s as another API transport', async method => {
    const client = createNativeBrowserReadClient({ viewer, username: 'fixture', reserveExtra: vi.fn() });
    await expect(client[method]!('123')).rejects.toThrow('no API replay was attempted');
    expect(f.native).not.toHaveBeenCalled(); expect(f.http).not.toHaveBeenCalled(); expect(f.browserApi).not.toHaveBeenCalled();
  });
  it('does not turn a story reel owned by another profile into empty success', async () => {
    f.native.mockResolvedValue(response({ status: 'ok', reels_media: [{ id: '999', items: [] }] }));
    await expect(createNativeBrowserReadClient({ viewer, username: 'fixture', reserveExtra: vi.fn() }).fetchStoriesTray('123')).rejects.toThrow('requested owner');
  });
  it('keeps an HTML 429 as rate limited before attempting JSON parsing', async () => {
    f.native.mockResolvedValue(response('<html>Too many requests</html>', 429));
    await expect(readNativePublic(viewer, 'profile', 'fixture')).rejects.toBeInstanceOf(IGRateLimitedError);
  });
  it('does not invent expired credentials from a non-JSON policy rejection', async () => {
    f.native.mockResolvedValue(response('<html>Forbidden</html>', 403));
    await expect(readNativePublic(viewer, 'profile', 'fixture')).rejects.toMatchObject({ status: 403, authDiagnostics: { reason: 'request_rejected' } });
  });
  it.each([null, [], { status: 'fail', message: 'upstream-private-value' }, '<html>Login wall</html>'])('rejects malformed or failed envelopes without returning their contents', async body => {
    f.native.mockResolvedValue(response(body));
    await expect(readNativePublic(viewer, 'profile', 'fixture')).rejects.toBeInstanceOf(IGHttpError);
    expect(f.persist).not.toHaveBeenCalled();
  });
  it('does not repeat a completed native read when session persistence fails', async () => {
    f.native.mockResolvedValue({ ...response(profile), storage_state: { cookies: [] } });
    f.persist.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await readNativePublic(viewer, 'profile', 'fixture')).toEqual(profile);
    expect(f.native).toHaveBeenCalledTimes(1);
  });
  it("carries refreshed native cookies into the next UI read and exports them even when persistence fails", async () => {
    const refreshed = { cookies: [{ name: "csrftoken", value: "rotated", domain: ".instagram.com" }] };
    f.native.mockResolvedValueOnce({ ...response(profile), storage_state: refreshed });
    f.native.mockResolvedValueOnce(response({ status: "ok", items: [], more_available: false, num_results: 0 }));
    f.persist.mockRejectedValueOnce(new Error("database unavailable"));
    const client = createNativeBrowserReadClient({ viewer, username: "fixture", reserveExtra: vi.fn() });
    await client.fetchProfile("fixture");
    await client.fetchUserFeed("123", { count: 1 });
    expect(f.native.mock.calls[1][0].storage_state).toEqual(refreshed);
    expect(JSON.parse(client.exportSessionData!())).toEqual(refreshed);
  });
  it("does not accept another profile identity from the native bridge", async () => {
    f.native.mockResolvedValue(response({ ...profile, user: { ...profile.user, username: "another" } }));
    const client = createNativeBrowserReadClient({ viewer, username: "fixture", reserveExtra: vi.fn() });
    await expect(client.fetchProfile("fixture")).rejects.toThrow("identity mismatch");
  });

});
