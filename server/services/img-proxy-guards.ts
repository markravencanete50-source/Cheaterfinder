/**
 * Rate limiters for the /api/img-proxy media proxy.
 *
 * Two buckets, keyed per authenticated user (falling back to client IP for the
 * brief window before auth middleware has populated req.user — in practice the
 * route is auth-gated so req.user is always present):
 *
 *   - galleryProxyLimiter: generous, covers normal gallery / dashboard page
 *     loads that fan out into many <img>/<video> requests.
 *   - videoProxyLimiter: stricter, gates the expensive path that may lease a
 *     paid residential proxy and download up to 25 MB per .mp4.
 *
 * Style mirrors the existing limiters in server/auth.ts (standardHeaders,
 * legacyHeaders off, JSON message body).
 */

import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";

const FIVE_MIN_MS = 5 * 60 * 1000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Per-user key with per-IP fallback. express-rate-limit 7.x requires that
 * IP-derived keys be IPv6-safe; since an authenticated user id is the primary
 * key here we collapse any IPv6 client address to its /64 prefix for the rare
 * fallback case, and disable the keyGeneratorIpFallback validation that would
 * otherwise warn about the custom generator.
 */
function userOrIpKey(req: Request, _res: Response): string {
  const userId = req.user?.id;
  if (userId) return `u:${userId}`;
  const ip = req.ip ?? "unknown";
  // Collapse IPv6 to a /64-ish prefix so a single client can't trivially
  // rotate through addresses in its own subnet to multiply its quota.
  if (ip.includes(":")) {
    const segments = ip.split(":").slice(0, 4).join(":");
    return `ip6:${segments}`;
  }
  return `ip:${ip}`;
}

export const galleryProxyLimiter = rateLimit({
  windowMs: FIVE_MIN_MS,
  // A full roster paints 200 avatars at a time, and a normal visit can include
  // followers, following, post likers, comments, and report thumbnails in the
  // same five-minute window. 300 therefore blocked legitimate browsing and
  // left the later sections full of broken images. Keep the bucket finite and
  // per-user, but above the largest normal dashboard fan-out.
  max: () => envInt("IMG_PROXY_RATE_MAX", 2000),
  keyGenerator: userOrIpKey,
  message: { message: "Too many media requests, please slow down" },
  standardHeaders: true,
  legacyHeaders: false,
  // We supply a custom per-user keyGenerator (IP only as a rare fallback, with
  // IPv6 collapsed to a /64 prefix above), so express-rate-limit's built-in
  // IP-key validations don't apply. Disable them to stay version-agnostic.
  validate: false,
});

export const videoProxyLimiter = rateLimit({
  windowMs: FIVE_MIN_MS,
  max: () => envInt("IMG_PROXY_VIDEO_RATE_MAX", 60),
  keyGenerator: userOrIpKey,
  message: { message: "Too many video requests, please slow down" },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  // Only count requests that hit the expensive residential-proxy video path
  // (".mp4"); image requests fall through this limiter untouched and are
  // bounded by galleryProxyLimiter instead.
  skip: (req: Request) => {
    const raw = typeof req.query.url === "string" ? req.query.url : "";
    try {
      return !new URL(raw).pathname.toLowerCase().endsWith(".mp4");
    } catch {
      // Unparseable URL — let the route handler reject it (400); don't spend
      // the stricter video budget on it.
      return true;
    }
  },
});
