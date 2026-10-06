import type { IGClientPort } from '../domain/ig-client-port.js';
import { parseFeedResponse, parseProfileInfoResponse } from '../domain/ig-schemas.js';
import { parseHighlightReelsResponse, parseHighlightsTrayResponse } from '../domain/ig-stories-schemas.js';
import { readNativePublic, type NativeViewer } from './native-public-read.js';

export class NativeBrowserReadUnsupportedError extends Error {
  constructor(operation: string) {
    super(`Native browser UI does not support ${operation}; no API replay was attempted`);
    this.name = 'NativeBrowserReadUnsupportedError';
  }
}

/** Normal UI navigation only. Unsupported methods cannot silently replay APIs. */
export function createNativeBrowserReadClient(options: {
  viewer: NativeViewer;
  username?: string;
  reserveExtra: (endpoint: 'posts' | 'highlights', count: number) => Promise<void>;
}): IGClientPort {
  let username = options.username;
  let sessionData = options.viewer.sessionData;
  const read = (kind: "profile" | "posts" | "stories" | "highlights", name: string, id?: string, limit = 24, withItems = false) =>
    readNativePublic({ ...options.viewer, sessionData }, kind, name, id, limit, withItems, refreshed => { sessionData = refreshed; });
  let userId: string | undefined;
  let highlights: Promise<unknown> | undefined;
  const unsupported = async (operation: string): Promise<never> => { throw new NativeBrowserReadUnsupportedError(operation); };
  const target = () => {
    if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) throw new NativeBrowserReadUnsupportedError('a read without a verified target username');
    return username;
  };
  return {
    exportSessionData: () => sessionData,
    fetchProfile: async name => {
      if (username && username.toLowerCase() !== name.toLowerCase()) throw new NativeBrowserReadUnsupportedError('changing target identity');
      username = name;
      const result = parseProfileInfoResponse(await read('profile', target()));
      if (result.username.toLowerCase() !== name.toLowerCase()) throw new Error("Native browser profile identity mismatch");
      userId = result.pk;
      return result;
    },
    fetchUserFeed: async (id, args = {}) => {
      if (args.maxId) throw new NativeBrowserReadUnsupportedError('API pagination cursors');
      const count = args.count ?? 24;
      if (!Number.isInteger(count) || count < 1 || count > 48) throw new NativeBrowserReadUnsupportedError('an unbounded post window');
      const name = target();
      userId = id;
      // Initial read has already been reserved by the lease/fallback owner;
      // include bounded UI pagination and its one possible prefetched page.
      await options.reserveExtra('posts', Math.ceil(count / 12));
      return parseFeedResponse(await read('posts', name, id, count));
    },
    fetchStoriesTray: async id => {
      userId = id;
      const reels = parseHighlightReelsResponse(await read('stories', target(), id));
      const reel = reels.find(reel => reel.id === id);
      if (!reel) throw new Error('Native browser stories response missing the requested owner');
      return { items: reel.items };
    },
    fetchHighlightsTray: async id => {
      userId = id;
      return parseHighlightsTrayResponse(await read('highlights', target(), id));
    },
    fetchHighlightReels: async ids => {
      if (!ids.length) return [];
      const name = target();
      highlights ??= (async () => {
        await options.reserveExtra('highlights', 12);
        return read('highlights', name, userId, 24, true);
      })();
      const reels = parseHighlightReelsResponse(await highlights);
      return ids.map(id => {
        const reel = reels.find(reel => reel.id === id);
        if (!reel) throw new Error('Native browser highlight response missing a requested reel');
        return reel;
      });
    },
    fetchUserClips: () => unsupported('reels tab reads'),
    fetchUserTagged: () => unsupported('tagged tab reads'),
    fetchFollowing: () => unsupported('following lists'),
    fetchFollowers: () => unsupported('follower lists'),
    fetchMediaComments: () => unsupported('comment lists'),
    fetchMediaLikers: () => unsupported('liker lists'),
    sendFollow: () => unsupported('pk-only follow writes'),
    fetchRaw: () => unsupported('raw endpoint requests'),
    close: async () => {},
  };
}
