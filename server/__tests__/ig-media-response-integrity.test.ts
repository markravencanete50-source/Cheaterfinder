import { describe, expect, it } from 'vitest';
import { parseStoriesResponse, parseHighlightsTrayResponse, parseHighlightReelsResponse } from '../domain/ig-stories-schemas.js';

describe('media absence requires explicit provider data', () => {
  it.each([parseStoriesResponse, parseHighlightsTrayResponse, parseHighlightReelsResponse])('rejects missing structures and failed envelopes', parse => {
    expect(() => parse({ status: 'ok' })).toThrow();
    expect(() => parse({ status: 'fail', items: [], tray: [], reels_media: [] })).toThrow();
  });
  it('preserves explicitly empty successful collections', () => {
    expect(parseStoriesResponse({ items: [] })).toEqual({ items: [] });
    expect(parseHighlightsTrayResponse({ tray: [] })).toEqual({ items: [] });
    expect(parseHighlightReelsResponse({ reels_media: [] })).toEqual([]);
    expect(parseHighlightReelsResponse({ reels: {} })).toEqual([]);
  });
  it.each([{ reels_media: [{ id: '123' }] }, { reels: { '123': { id: '456', items: [] } } }])('rejects a reel with missing items or contradictory identity', response => {
    expect(() => parseHighlightReelsResponse(response)).toThrow();
  });
});
