import { recordWelcomeEmail } from "./services/transactional-emails.js";
// ─── Mobile bearer-token authentication ──────────────────────────────────────
//
// The web SPA authenticates with an httpOnly session cookie plus a double-submit
// CSRF cookie that browser JS reads from `document.cookie`. Neither mechanism
// exists in React Native: there is no cookie jar the JS layer can read, and
// RN's fetch cookie handling is platform-inconsistent and invisible to us.
//
// This module adds a *purely additive* bearer path for the mobile client:
//
//   1. `POST /api/auth/mobile/{register,login,refresh}` mint HS256 JWTs.
//   2. `bearerAuth` populates `req.user` from a valid `Authorization: Bearer`.
//      Passport's `req.isAuthenticated()` is defined as `!!req.user`, so every
//      existing route guarded by `isAuthenticated` / `isAdmin` keeps working
//      with no changes at all.
//   3. `requireCsrfToken` skips requests flagged `req.mobileAuth` — a bearer
//      token is not ambient credentials, so CSRF does not apply.
//
// Tokens retain their password binding and now also reference revocable device
// sessions. Refresh is one-time and logout revokes the family. Legacy tokens
// remain usable through a one-time migration so deployment does not log out
// current users. No web-session behavior changes.
//
// The web session flow is untouched.

import crypto from "crypto";
import type { Express, Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { users } from "../shared/schema.js";
import type { User } from "../shared/schema.js";
import {
  validateBody,
  registerSchema,
  loginSchema,
} from "../shared/validation.js";
import type { RegisterInput, LoginInput } from "../shared/validation.js";
import { createMobileSession, mobileSessionActive, legacyMobileTokenActive,
  rotateMobileSession, revokeMobileSession, revokeLegacyMobileTokens } from "./services/mobile-session-store.js";

declare global {
  namespace Express {
    interface Request {
      /** True when this request was authenticated by a bearer token, not a session cookie. */
      mobileAuth?: boolean;
    }
  }
}

// ─── Configuration ───────────────────────────────────────────────────────────

const ACCESS_TTL_SEC = 60 * 60; // 1 hour
const REFRESH_TTL_SEC = 60 * 24 * 60 * 60; // 60 days
const BCRYPT_ROUNDS = 12; // matches server/auth.ts

type TokenType = "access" | "refresh";

interface MobileTokenClaims {
  sub: string; // user id
  typ: TokenType;
  pv: string; // password-hash fingerprint; changes when the password changes
  iat: number;
  exp: number;
  jti: string;
  sid?: string;
}

/**
 * Signing key for mobile tokens.
 *
 * Derived from SESSION_SECRET so no new environment variable is required, but
 * domain-separated so a mobile token can never be confused with (or forged
 * from) anything else signed with the same secret. MOBILE_JWT_SECRET overrides
 * it if operators want an independently rotatable key.
 */
function signingKey(): Buffer {
  const base = process.env.MOBILE_JWT_SECRET ?? process.env.SESSION_SECRET;
  if (!base) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[mobile-auth] FATAL: SESSION_SECRET (or MOBILE_JWT_SECRET) must be set in production.",
      );
    }
    return crypto
      .createHash("sha256")
      .update("cheaterfinder-fallback-secret|mobile-auth-v1")
      .digest();
  }
  return crypto.createHash("sha256").update(`${base}|mobile-auth-v1`).digest();
}

/**
 * Fingerprint of the user's current credential state.
 *
 * Binding tokens to this means a password change or reset silently revokes
 * every outstanding mobile token without needing a revocation table. Users
 * with no password (social-only, currently unused) get a stable sentinel.
 */
function passwordVersion(hashedPassword: string | null): string {
  return crypto
    .createHash("sha256")
    .update(hashedPassword ?? "no-password")
    .digest("hex")
    .slice(0, 16);
}

// ─── Minimal HS256 JWT (no new dependency) ───────────────────────────────────

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmac(data: string): Buffer {
  return crypto.createHmac("sha256", signingKey()).update(data).digest();
}

function signToken(claims: MobileTokenClaims): string {
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const body = `${header}.${payload}`;
  return `${body}.${b64urlEncode(hmac(body))}`;
}

/**
 * Verify signature, structure, and expiry. Returns null on any failure — the
 * caller never distinguishes *why* a token is bad, so this leaks nothing.
 */
function verifyToken(token: string): MobileTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  try {
    const parsedHeader = JSON.parse(b64urlDecode(header).toString("utf8"));
    if (parsedHeader.alg !== "HS256" || parsedHeader.typ !== "JWT") return null;
  } catch { return null; }

  const expected = hmac(`${header}.${payload}`);
  const provided = b64urlDecode(signature);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let claims: MobileTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString("utf8"));
  } catch {
    return null;
  }

  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (claims.typ !== "access" && claims.typ !== "refresh") return null;
  if (typeof claims.pv !== "string") return null;
  if (typeof claims.exp !== "number") return null;
  if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.iat > Math.floor(Date.now() / 1000) + 60) return null;
  if (typeof claims.jti !== "string" || !claims.jti || claims.jti.length > 128) return null;
  if (claims.sid !== undefined && (typeof claims.sid !== "string" || !claims.sid || claims.sid.length > 256)) return null;
  if (Math.floor(Date.now() / 1000) >= claims.exp) return null;

  return claims;
}

function issueToken(user: User, typ: TokenType, sid: string, jti = crypto.randomBytes(12).toString("hex")): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({
    sub: user.id,
    typ,
    pv: passwordVersion(user.hashedPassword),
    iat: now,
    exp: now + (typ === "access" ? ACCESS_TTL_SEC : REFRESH_TTL_SEC),
    jti,
    sid,
  });
}

export interface MobileTokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds, so the client can refresh proactively. */
  expiresIn: number;
  tokenType: "Bearer";
}

function buildTokenPair(user: User, sid: string, refreshJti: string): MobileTokenPair {
  return {
    accessToken: issueToken(user, "access", sid),
    refreshToken: issueToken(user, "refresh", sid, refreshJti),
    expiresIn: ACCESS_TTL_SEC,
    tokenType: "Bearer",
  };
}

async function issueTokenPair(user: User): Promise<MobileTokenPair> {
  const sid = crypto.randomUUID();
  const jti = crypto.randomBytes(24).toString("hex");
  await createMobileSession(sid, user.id, jti, new Date(Date.now() + REFRESH_TTL_SEC * 1000));
  return buildTokenPair(user, sid, jti);
}

async function rotateTokenPair(user: User, claims: MobileTokenClaims): Promise<MobileTokenPair | null> {
  const sid = claims.sid ?? `legacy:${user.id}:${claims.jti}`;
  if (!claims.sid && !await createMobileSession(sid, user.id, claims.jti, new Date(claims.exp * 1000))) {
    await revokeLegacyMobileTokens(user.id);
    return null;
  }
  const jti = crypto.randomBytes(24).toString("hex");
  if (!await rotateMobileSession(sid, user.id, claims.jti, jti, new Date(Date.now() + REFRESH_TTL_SEC * 1000))) {
    if (sid.startsWith("legacy:")) await revokeLegacyMobileTokens(user.id);
    return null;
  }
  return buildTokenPair(user, sid, jti);
}

function safeUser(user: User): Omit<User, "hashedPassword"> {
  const { hashedPassword: _omit, ...rest } = user;
  return rest;
}

// ─── Token → user resolution ─────────────────────────────────────────────────

/**
 * Resolve a token to a live user row, re-checking the password fingerprint so
 * a password change invalidates tokens minted before it.
 */
async function resolveUser(
  token: string,
  expected: TokenType,
): Promise<User | null> {
  const claims = verifyToken(token);
  if (!claims || claims.typ !== expected) return null;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, claims.sub))
    .limit(1);

  if (!user) return null;
  if (passwordVersion(user.hashedPassword) !== claims.pv) return null;
  if (claims.sid ? !await mobileSessionActive(claims.sid, user.id) : !await legacyMobileTokenActive(user.id, claims.iat)) return null;

  return user;
}

function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] : header);
  return match ? match[1].trim() : null;
}

/**
 * Populates `req.user` when a valid bearer access token is present.
 *
 * Install immediately after `passport.session()`. Cookie sessions win when both
 * are present (the web client never sends a bearer header, so in practice the
 * two paths never overlap). An invalid or expired bearer token is treated as
 * "not authenticated" rather than an error, so downstream `isAuthenticated`
 * returns the same 401 the web client would get.
 */
export function bearerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user) return next(); // already authenticated by session cookie

  const token = readBearer(req);
  if (!token) return next();

  void resolveUser(token, "access")
    .then((user) => {
      if (user) {
        req.user = user;
        req.mobileAuth = true;
      }
      next();
    })
    .catch(next);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Mirrors the limits on the cookie-session equivalents in server/auth.ts.
const mobileLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many login attempts, please try again in 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

const mobileRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { message: "Too many accounts created, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const mobileRefreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { message: "Too many refresh attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

export function setupMobileAuth(app: Express): void {
  // POST /api/auth/mobile/register
  app.post(
    "/api/auth/mobile/register",
    mobileRegisterLimiter,
    validateBody(registerSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { name, email, password } = req.body as RegisterInput;

        const [existing] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (existing) {
          // Same non-enumerable copy as the web register route.
          res.status(400).json({
            message:
              "Unable to complete registration with the provided details. If you already have an account, sign in or use the password reset option.",
          });
          return;
        }

        const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const newUser = await db.transaction(async tx => {
          const [created] = await tx.insert(users).values({ name: name.trim(), email, hashedPassword }).returning();
          await recordWelcomeEmail(tx, created.id);
          return created;
        });

        res.status(201).json({
          user: safeUser(newUser),
          ...await issueTokenPair(newUser),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/auth/mobile/login
  app.post(
    "/api/auth/mobile/login",
    mobileLoginLimiter,
    validateBody(loginSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { email, password } = req.body as LoginInput;

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        // One generic message for every failure mode — never reveal whether
        // the account exists or has no password set.
        const reject = (): void => {
          res.status(401).json({ message: "Invalid email or password" });
        };

        if (!user || !user.hashedPassword) {
          // Constant-ish work even when the user is absent, so response time
          // does not distinguish "no such account" from "wrong password".
          await bcrypt.compare(password, "$2a$12$" + "x".repeat(53));
          reject();
          return;
        }

        if (!(await bcrypt.compare(password, user.hashedPassword))) {
          reject();
          return;
        }

        res.json({ user: safeUser(user), ...await issueTokenPair(user) });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/auth/mobile/refresh
  //
  // Rotates both tokens. The client stores the new pair and discards the old.
  app.post(
    "/api/auth/mobile/refresh",
    mobileRefreshLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const raw = (req.body as { refreshToken?: unknown } | undefined)
          ?.refreshToken;
        const token =
          typeof raw === "string" && raw ? raw : readBearer(req);

        if (!token) {
          res.status(400).json({ message: "Missing refresh token" });
          return;
        }

        const user = await resolveUser(token, "refresh");
        if (!user) {
          res.status(401).json({ message: "Invalid or expired refresh token" });
          return;
        }

        const claims = verifyToken(token)!;
        const pair = await rotateTokenPair(user, claims);
        if (!pair) {
          res.status(401).json({ message: "Invalid or expired refresh token" });
          return;
        }
        res.json({ user: safeUser(user), ...pair });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/auth/mobile/logout
  //
  // Either family token can revoke the session; invalid/repeated logout is
  // idempotent. A signed token never authorizes revoking another user's session.
  app.post("/api/auth/mobile/logout", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
      const token = typeof raw === "string" ? raw : readBearer(req);
      const claims = token ? verifyToken(token) : null;
      if (claims && await resolveUser(token!, claims.typ)) {
        if (claims.sid) {
          await revokeMobileSession(claims.sid, claims.sub);
          if (claims.sid.startsWith("legacy:")) await revokeLegacyMobileTokens(claims.sub);
        }
        else await revokeLegacyMobileTokens(claims.sub);
      }
      res.json({ message: "Logged out successfully" });
    } catch (err) { next(err); }
  });
}

// Exported for tests.
export const __testing = {
  signToken,
  verifyToken,
  issueToken,
  issueTokenPair,
  rotateTokenPair,
  resolveUser,
  passwordVersion,
  ACCESS_TTL_SEC,
  REFRESH_TTL_SEC,
};
