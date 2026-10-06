import { describe, expect, it, vi } from 'vitest';
import type { IGClientPort } from '../../domain/ig-client-port.js';

vi.mock('../bandwidth-meter.js', () => ({ recordBytes: vi.fn() }));
vi.mock('../../observability/logger.js', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return { logger };
});

import { IGAuthExpiredError, IGHttpError, IGRateLimitedError } from '../../ig-http-client.js';
import { classifyInstagramResponse } from '../ig-response-diagnostics.js';
import { withMediaBrowserFallback } from '../media-browser-fallback.js';

function setup() {
  const http = {
    exportSessionData: vi.fn(() => 'http-state'),
    fetchStoriesTray: vi.fn().mockResolvedValue({ items: [] }),
    fetchHighlightsTray: vi.fn().mockResolvedValue({ items: [] }),
    fetchHighlightReels: vi.fn().mockResolvedValue([]),
    fetchUserFeed: vi.fn().mockResolvedValue({ items: [] }),
    fetchMediaComments: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    exportSessionData: vi.fn(() => 'browser-state'),
    fetchStoriesTray: vi.fn().mockResolvedValue({ items: [{ id: 'story-1' }] }),
    fetchHighlightsTray: vi.fn().mockResolvedValue({ items: [{ id: 'highlight:1' }] }),
    fetchHighlightReels: vi.fn().mockResolvedValue([{ id: 'highlight:1', items: [{ id: 'story-1' }] }]),
    fetchUserFeed: vi.fn().mockResolvedValue({ items: [{ id: 'post-1' }], nextMaxId: 'next-page', moreAvailable: true, numResults: 1 }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const createBrowser = vi.fn().mockResolvedValue(browser);
  const beforeFallback = vi.fn().mockResolvedValue(undefined);
  const onFallback = vi.fn();
  const client = withMediaBrowserFallback(http as unknown as IGClientPort, { createBrowser, beforeFallback, onFallback });
  return { client, http, browser, createBrowser, beforeFallback, onFallback };
}

const serverError = () => new IGHttpError(500, 'upstream error', {
  body: JSON.stringify({ status: 'fail', message: "We're sorry, but something went wrong. Please try again." }),
});
const homeDiagnostic = () => classifyInstagramResponse('<html><title>Instagram</title></html>',
  { 'content-type': 'text/html' }, 'instagram_home', true);
const homepageRedirect = () => new IGHttpError(200, 'response not JSON for GET highlights', {
  responseDiagnostics: homeDiagnostic(),
});

describe('same-viewer media browser fallback', () => {
  it('uses one native highlight read when the successful API response was redirected to the Instagram homepage', async () => {
    const f = setup();
    f.http.fetchHighlightsTray.mockRejectedValue(homepageRedirect());
    await expect(f.client.fetchHighlightsTray('123')).resolves.toEqual({ items: [{ id: 'highlight:1' }] });
    expect(f.http.fetchHighlightsTray).toHaveBeenCalledExactlyOnceWith('123');
    expect(f.browser.fetchHighlightsTray).toHaveBeenCalledExactlyOnceWith('123');
    expect(f.beforeFallback).toHaveBeenCalledExactlyOnceWith('highlights');
    expect(f.beforeFallback.mock.invocationCallOrder[0]).toBeLessThan(f.createBrowser.mock.invocationCallOrder[0]);
    expect(f.client.exportSessionData!()).toBe('browser-state');
    expect(f.createBrowser).toHaveBeenCalledOnce();
  });

  it.each([
    { responseUrlClass: 'login' }, { responseUrlClass: 'challenge' }, { responseUrlClass: 'suspended' },
    { responseUrlClass: 'instagram_api' }, { responseUrlClass: 'external' }, { responseUrlClass: 'unknown' },
    { responseRedirected: false }, { responseRedirected: undefined },
    { contentType: 'json' }, { contentType: 'unknown' },
    { titleClass: 'login' }, { titleClass: 'challenge' }, { titleClass: 'other' }, { titleClass: 'absent' },
  ])('does not reinterpret uncertain or auth-shaped HTML as the verified homepage redirect: %j', async change => {
    const f = setup();
    const error = new IGHttpError(200, 'response not JSON', {
      responseDiagnostics: { ...homeDiagnostic(), ...change } as ReturnType<typeof homeDiagnostic>,
    });
    f.http.fetchHighlightsTray.mockRejectedValue(error);
    await expect(f.client.fetchHighlightsTray('123')).rejects.toBe(error);
    expect(f.createBrowser).not.toHaveBeenCalled();
    expect(f.beforeFallback).not.toHaveBeenCalled();
  });

  it.each([
    { igErrorCode: 'checkpoint_required' as const },
    { authDiagnostics: { reason: 'challenge_required' as const, challengeKind: 'captcha' as const, codeMethod: null } },
    { body: '{"message":"login_required"}' }, { body: '{"message":"feedback_required"}' },
    { body: '{"status":"fail","require_login":true,"igweb_rollout":true}' }, { body: '{"spam":true}' },
  ])('preserves refusal evidence even with a homepage response diagnostic: %j', async detail => {
    const f = setup();
    const error = new IGHttpError(200, 'refusal', { responseDiagnostics: homeDiagnostic(), ...detail });
    f.http.fetchHighlightsTray.mockRejectedValue(error);
    await expect(f.client.fetchHighlightsTray('123')).rejects.toBe(error);
    expect(f.createBrowser).not.toHaveBeenCalled();
  });

  it('does not broaden the verified highlights redirect to posts or stories', async () => {
    const f = setup();
    const error = homepageRedirect();
    f.http.fetchStoriesTray.mockRejectedValue(error);
    f.http.fetchUserFeed.mockRejectedValue(error);
    await expect(f.client.fetchStoriesTray('123')).rejects.toBe(error);
    await expect(f.client.fetchUserFeed('123')).rejects.toBe(error);
    expect(f.createBrowser).not.toHaveBeenCalled();
  });

  it('preserves a native auth refusal after the one homepage-redirect fallback', async () => {
    const f = setup();
    const error = new IGAuthExpiredError('Native browser requires login', { status: 401 });
    f.http.fetchHighlightsTray.mockRejectedValue(homepageRedirect());
    f.browser.fetchHighlightsTray.mockRejectedValue(error);
    await expect(f.client.fetchHighlightsTray('123')).rejects.toBe(error);
    expect(f.http.fetchHighlightsTray).toHaveBeenCalledOnce();
    expect(f.browser.fetchHighlightsTray).toHaveBeenCalledOnce();
  });

  it('exports the cookies from the transport that completed the media read', async () => {
    const f = setup();
    await f.client.fetchStoriesTray('123');
    expect(f.client.exportSessionData!()).toBe('http-state');
    f.http.fetchStoriesTray.mockRejectedValueOnce(serverError());
    await f.client.fetchStoriesTray('123');
    expect(f.client.exportSessionData!()).toBe('browser-state');
    await f.client.fetchStoriesTray('123');
    expect(f.client.exportSessionData!()).toBe('http-state');
    await f.client.close();
  });

  it('accepts a successful empty tray without opening the browser', async () => {
    const f = setup();
    await expect(f.client.fetchStoriesTray('123')).resolves.toEqual({ items: [] });
    await expect(f.client.fetchHighlightsTray('123')).resolves.toEqual({ items: [] });
    await f.client.close();
    expect(f.createBrowser).not.toHaveBeenCalled();
    expect(f.beforeFallback).not.toHaveBeenCalled();
    expect(f.http.close).toHaveBeenCalledTimes(1);
  });

  it('recovers stories and both highlight reads with their exact original arguments and one browser', async () => {
    const f = setup();
    f.http.fetchStoriesTray.mockRejectedValue(serverError());
    f.http.fetchHighlightsTray.mockRejectedValue(new IGHttpError(502, 'bad gateway'));
    f.http.fetchHighlightReels.mockRejectedValue(new IGHttpError(503, 'unavailable'));
    await expect(f.client.fetchStoriesTray('123')).resolves.toEqual({ items: [{ id: 'story-1' }] });
    await expect(f.client.fetchHighlightsTray('123')).resolves.toEqual({ items: [{ id: 'highlight:1' }] });
    await expect(f.client.fetchHighlightReels(['highlight:1'])).resolves.toEqual([{ id: 'highlight:1', items: [{ id: 'story-1' }] }]);
    expect(f.browser.fetchStoriesTray).toHaveBeenCalledExactlyOnceWith('123');
    expect(f.browser.fetchHighlightsTray).toHaveBeenCalledExactlyOnceWith('123');
    expect(f.browser.fetchHighlightReels).toHaveBeenCalledExactlyOnceWith(['highlight:1']);
    expect(f.beforeFallback.mock.calls).toEqual([['stories'], ['highlights'], ['highlights']]);
    expect(f.onFallback.mock.calls).toEqual([['stories', 500], ['highlights', 502], ['highlights', 503]]);
    expect(f.beforeFallback.mock.invocationCallOrder[0]).toBeLessThan(f.createBrowser.mock.invocationCallOrder[0]);
    expect(f.createBrowser).toHaveBeenCalledTimes(1);
    await f.client.close();
    expect(f.http.close).toHaveBeenCalledTimes(1);
    expect(f.browser.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error('parse failure'),
    new IGHttpError(0, 'network failure'),
    new IGHttpError(404, 'not found'),
    new IGHttpError(429, 'throttle'),
    new IGAuthExpiredError('expired'),
    new IGRateLimitedError(60_000, 'rate limited'),
    new IGHttpError(500, 'checkpoint', { igErrorCode: 'checkpoint_required' }),
    new IGHttpError(500, 'checkpoint', { body: '{"message":"checkpoint_required"}' }),
    new IGHttpError(500, 'challenge', { authDiagnostics: { reason: 'challenge_required', challengeKind: 'captcha', codeMethod: null } }),
    new IGHttpError(500, 'feedback', { body: '{"message":"feedback_required"}' }),
    new IGHttpError(500, 'login', { body: '{"message":"login_required"}' }),
    new IGHttpError(500, 'throttle envelope', { body: '{"status":"fail","require_login":true,"igweb_rollout":true}' }),
    new IGHttpError(500, 'spam envelope', { body: '{"status":"fail","spam":true}' }),
    new IGHttpError(500, 'redirected login', { responseDiagnostics: classifyInstagramResponse('', {}, 'login', true) }),
    new IGHttpError(500, 'login page', { responseDiagnostics: classifyInstagramResponse('<title>Log in • Instagram</title>', { 'content-type': 'text/html' }) }),
  ])('returns a refusal or non-server error unchanged ($message)', async error => {
    const f = setup();
    f.http.fetchStoriesTray.mockRejectedValue(error);
    await expect(f.client.fetchStoriesTray('123')).rejects.toBe(error);
    expect(f.createBrowser).not.toHaveBeenCalled();
    expect(f.beforeFallback).not.toHaveBeenCalled();
  });

  it('stops after a single failed browser read and propagates the real failure', async () => {
    const f = setup();
    const error = new IGAuthExpiredError('browser login required');
    f.http.fetchStoriesTray.mockRejectedValue(serverError());
    f.browser.fetchStoriesTray.mockRejectedValue(error);
    await expect(f.client.fetchStoriesTray('123')).rejects.toBe(error);
    expect(f.http.fetchStoriesTray).toHaveBeenCalledTimes(1);
    expect(f.browser.fetchStoriesTray).toHaveBeenCalledTimes(1);
    await f.client.close();
    expect(f.browser.close).toHaveBeenCalledTimes(1);
  });

  it('recovers a post page without losing the original page size or pagination cursor', async () => {
    const f = setup();
    f.http.fetchUserFeed.mockRejectedValue(serverError());
    const options = { count: 12, maxId: 'requested-page' };
    await expect(f.client.fetchUserFeed('123', options)).resolves.toMatchObject({
      items: [{ id: 'post-1' }], nextMaxId: 'next-page', moreAvailable: true,
    });
    expect(f.http.fetchUserFeed).toHaveBeenCalledExactlyOnceWith('123', options);
    expect(f.browser.fetchUserFeed).toHaveBeenCalledExactlyOnceWith('123', options);
    expect(f.beforeFallback).toHaveBeenCalledExactlyOnceWith('posts');
    await f.client.close();
  });

  it('does not launch the browser when the extra budget cannot be reserved', async () => {
    const f = setup();
    const limit = new Error('daily budget exhausted');
    f.http.fetchStoriesTray.mockRejectedValue(serverError());
    f.beforeFallback.mockRejectedValue(limit);
    await expect(f.client.fetchStoriesTray('123')).rejects.toBe(limit);
    expect(f.createBrowser).not.toHaveBeenCalled();
    expect(f.onFallback).not.toHaveBeenCalled();
  });

  it('keeps other reads on their original transport even for a 500', async () => {
    const f = setup();
    const error = serverError();
    f.http.fetchMediaComments.mockRejectedValue(error);
    await expect(f.client.fetchMediaComments('123')).rejects.toBe(error);
    expect(f.createBrowser).not.toHaveBeenCalled();
  });

  it('closes the browser even if the HTTP close fails', async () => {
    const f = setup();
    const error = new Error('close failed');
    f.http.fetchStoriesTray.mockRejectedValue(serverError());
    f.http.close.mockRejectedValue(error);
    await f.client.fetchStoriesTray('123');
    await expect(f.client.close()).rejects.toBe(error);
    expect(f.browser.close).toHaveBeenCalledTimes(1);
  });
});
