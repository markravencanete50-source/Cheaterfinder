import type { IGClientPort } from '../domain/ig-client-port.js';
import { IGHttpError } from '../ig-http-client.js';
import { inspectInstagramAuthResponse } from './instagram-auth-diagnostics.js';
import { logger } from '../observability/logger.js';

type MediaEndpoint = 'posts' | 'stories' | 'highlights';

function hasNoProviderRefusal(error: IGHttpError): boolean {
  if (error.igErrorCode) return false;
  if (error.responseDiagnostics && (
    ['login', 'challenge', 'suspended'].includes(error.responseDiagnostics.responseUrlClass)
    || ['login', 'challenge'].includes(error.responseDiagnostics.titleClass)
  )) return false;
  // An upstream outage must not turn a provider login/throttle refusal into
  // a retry just because it was delivered with the wrong HTTP status.
  try {
    const body = JSON.parse(error.body ?? '{}');
    if (body?.require_login === true || body?.spam === true) return false;
  } catch { /* Generic HTML 5xx responses can still use the browser fallback. */ }
  const diagnostic = error.authDiagnostics ?? inspectInstagramAuthResponse(error.status, error.body ?? '');
  return diagnostic === null || diagnostic.reason === 'response_error';
}

export function isMediaServerError(error: unknown): error is IGHttpError {
  return error instanceof IGHttpError && error.status >= 500 && error.status < 600 && hasNoProviderRefusal(error);
}

/** A successful endpoint response redirected to the ordinary Instagram home
 * document contains no media data. This exact diagnostic can use the normal
 * profile UI; unknown HTML, external redirects and auth refusals cannot. */
export function isMediaHomepageRedirect(error: unknown): error is IGHttpError {
  if (!(error instanceof IGHttpError) || !Number.isInteger(error.status) || error.status < 200 || error.status >= 300) return false;
  const diagnostic = error.responseDiagnostics;
  return diagnostic?.responseUrlClass === 'instagram_home'
    && diagnostic.responseRedirected === true
    && diagnostic.contentType === 'html'
    && diagnostic.titleClass === 'instagram'
    && hasNoProviderRefusal(error);
}

/** One native UI attempt for a media 5xx or the verified highlights homepage
 * redirect, on the same viewer and proxy.
 * Other reads keep their existing transport. Auth/verification/rate-limit
 * refusals are returned directly, and a failed browser read is never retried here.
 */
export function withMediaBrowserFallback(
  http: IGClientPort,
  options: {
    createBrowser: () => Promise<IGClientPort>;
    beforeFallback: (endpoint: MediaEndpoint) => Promise<void>;
    onFallback?: (endpoint: MediaEndpoint, status: number) => void;
  },
): IGClientPort {
  let browserPromise: Promise<IGClientPort> | undefined;
  let lastSuccessfulClient = http;
  async function read<T>(endpoint: MediaEndpoint, primary: () => Promise<T>, fallback: (browser: IGClientPort) => Promise<T>): Promise<T> {
    try {
      const result = await primary();
      lastSuccessfulClient = http;
      return result;
    }
    catch (error) {
      const homepageRedirect = endpoint === 'highlights' && isMediaHomepageRedirect(error);
      if (!isMediaServerError(error) && !homepageRedirect) throw error;
      await options.beforeFallback(endpoint);
      if (homepageRedirect) {
        // Fixed classifications only. Do not log the provider body or target.
        logger.info({ endpoint, status: error.status, reason: 'redirected_home_html',
          responseUrlClass: 'instagram_home', contentType: 'html', titleClass: 'instagram' },
        'Highlights response redirected home; trying the same viewer native UI once');
      }
      options.onFallback?.(endpoint, error.status);
      browserPromise ??= options.createBrowser();
      const browser = await browserPromise;
      const result = await fallback(browser);
      lastSuccessfulClient = browser;
      return result;
    }
  }
  return {
    ...http,
    exportSessionData: () => lastSuccessfulClient.exportSessionData?.() ?? '',
    fetchUserFeed: (pk, opts) => read('posts', () => http.fetchUserFeed(pk, opts), browser => browser.fetchUserFeed(pk, opts)),
    fetchStoriesTray: pk => read('stories', () => http.fetchStoriesTray(pk), browser => browser.fetchStoriesTray(pk)),
    fetchHighlightsTray: pk => read('highlights', () => http.fetchHighlightsTray(pk), browser => browser.fetchHighlightsTray(pk)),
    fetchHighlightReels: ids => read('highlights', () => http.fetchHighlightReels(ids), browser => browser.fetchHighlightReels(ids)),
    close: async () => {
      const results = await Promise.allSettled([
        http.close(),
        browserPromise ? browserPromise.then(browser => browser.close()) : Promise.resolve(),
      ]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
