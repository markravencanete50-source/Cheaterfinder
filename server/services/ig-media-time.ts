// Derive a post's PUBLISH time from its Instagram media id / shortcode.
//
// Instagram media ids are Snowflake-like: the high bits are milliseconds since
// a custom epoch. So the post's creation time is embedded in the id itself —
// no network round-trip to /media/{id}/info needed. This is what makes the
// liked-posts section sortable by post date even for the ~all rows whose
// `post_taken_at` was never captured from the feed (the feed's `taken_at` turned
// out to be absent on the liked-by facepile media).
//
// pk layout:  created_ms = (pk >> 23) + IG_EPOCH_MS
//   IG_EPOCH_MS = 1314220021721 (2011-08-24), the value Instagram uses.

import { shortcodeToMediaId } from "./media-cache.js";

const IG_EPOCH_MS = 1314220021721n;
const PK_TIME_SHIFT = 23n;

/**
 * Post publish time derived from a numeric media pk or a base64 shortcode.
 * Returns null when the id can't be decoded or the derived time is implausible
 * (before Instagram existed, or in the future — a sign the id wasn't a real pk).
 */
export function postCreatedAt(postIdOrShortcode: string | null | undefined): Date | null {
  if (!postIdOrShortcode) return null;
  const raw = postIdOrShortcode.trim();
  if (!raw) return null;

  // Numeric pk as-is; otherwise decode the shortcode to its pk.
  const pkStr = /^\d+$/.test(raw) ? raw : shortcodeToMediaId(raw);
  if (!pkStr) return null;

  let pk: bigint;
  try {
    pk = BigInt(pkStr);
  } catch {
    return null;
  }
  if (pk <= 0n) return null;

  const ms = Number((pk >> PK_TIME_SHIFT) + IG_EPOCH_MS);
  // Instagram launched in 2010; a future timestamp means the id wasn't a real
  // media pk (e.g. a composite id or non-IG shortcode).
  if (ms < Date.UTC(2010, 0, 1) || ms > Date.now() + 24 * 60 * 60 * 1000) {
    return null;
  }
  return new Date(ms);
}
