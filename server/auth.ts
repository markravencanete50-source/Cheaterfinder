import { applicationEmailFrom } from "./services/email-config.js";
import { logger } from "./observability/logger.js";
import crypto from "crypto";
import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "./db.js";
import { users, passwordResetTokens } from "../shared/schema.js";
import type { User } from "../shared/schema.js";
import {
  validateBody,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../shared/validation.js";
import type {
  RegisterInput,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
} from "../shared/validation.js";
import { isResendConfigured } from "./integrations.js";
import { bearerAuth, setupMobileAuth } from "./mobile-auth.js";
import { customerSessionIdentity, customerSessionMatches, customerSessionUserId } from "./services/customer-session-identity.js";
import { applyCustomerPasswordReset } from "./services/customer-credentials.js";
import { EmailDeliveryError, sendApplicationEmail } from "./services/email-delivery.js";
import { passwordResetEmail } from "./services/email-templates.js";
import { recordWelcomeEmail } from "./services/transactional-emails.js";

// ─── Session augmentation ─────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      name: string;
      hashedPassword: string | null;
      sessionVersion?: number;
      // C2: authorization role ('user' | 'admin'); populated by the full-row
      // drizzle selects in the LocalStrategy and deserializeUser.
      role: string;
      createdAt: Date;
      updatedAt: Date;
    }
  }
}

// Fix #15: CSRF token cookie + verification for admin mutation routes.
// Double-submit pattern: server sets a non-HttpOnly `csrf_token` cookie on
// login; browser JS reads it and echoes it back via `X-CSRF-Token` on every
// unsafe admin request. Anyone without browser access to our origin can't
// read the cookie, so they can't forge a matching header.
const CSRF_COOKIE_NAME = "csrf_token";
const CSRF_HEADER_NAME = "x-csrf-token";

export function issueCsrfCookie(res: Response): void {
  const token = crypto.randomBytes(32).toString("hex");
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // client JS must read it
    sameSite: "strict",
    secure: process.env.HTTPS_ENABLED === "true",
    // Matches the 7-day session cookie
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE_NAME, { path: "/" });
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); }
      catch { return null; }
    }
  }
  return null;
}

export function requireCsrfToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  if (safeMethods.has(req.method)) {
    next();
    return;
  }
  // Bearer-authenticated (mobile) requests carry no ambient credentials: the
  // token is attached explicitly by the app, so a third-party site cannot make
  // the OS replay it. CSRF is a cookie-only concern and does not apply here.
  if (req.mobileAuth) {
    next();
    return;
  }
  const cookieToken = readCookie(req.headers.cookie, CSRF_COOKIE_NAME);
  const headerToken = req.headers[CSRF_HEADER_NAME];
  const headerStr = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (
    !cookieToken ||
    !headerStr ||
    cookieToken.length < 32 ||
    cookieToken !== headerStr
  ) {
    res.status(403).json({ message: "CSRF token missing or invalid" });
    return;
  }
  next();
}

function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ─── Passport configuration ───────────────────────────────────────────────────

passport.use(
  new LocalStrategy(
    { usernameField: "email", passwordField: "password" },
    async (email: string, password: string, done) => {
      try {
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email.toLowerCase()))
          .limit(1);

        if (!user) {
          return done(null, false, { message: "Invalid email or password" });
        }

        if (!user.hashedPassword) {
          // C8: same generic message as every other login failure — revealing
          // "social login" confirms the account exists (enumeration).
          return done(null, false, { message: "Invalid email or password" });
        }

        const valid = await bcrypt.compare(password, user.hashedPassword);
        if (!valid) {
          return done(null, false, { message: "Invalid email or password" });
        }

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    },
  ),
);

passport.serializeUser((user, done) => {
  done(null, customerSessionIdentity(user));
});

passport.deserializeUser(async (identity: unknown, done) => {
  try {
    const id = customerSessionUserId(identity);
    if (!id) { done(null, false); return; }
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    done(null, user && customerSessionMatches(identity, user) ? user : false);
  } catch (err) {
    done(err);
  }
});

// ─── Auth middleware helper ───────────────────────────────────────────────────

export function isAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ message: "Unauthorized" });
}

export function isAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // C2 fix: authorize via the role column, never by comparing the
  // user-editable email against ADMIN_EMAIL. Email-match auth meant anyone
  // who registered (or renamed themselves to) the admin email became admin.
  if (!req.isAuthenticated() || req.user?.role !== "admin") {
    res.status(403).json({ message: "Forbidden: admin access required" });
    return;
  }
  next();
}

// ─── Admin bootstrap (C2) ─────────────────────────────────────────────────────
// Persist completion independently of users. An admin's later deletion or
// demotion must never re-open email-based promotion for a newly registered user.
// Existing installations record their current owner without changing any role.
export async function bootstrapAdminRole(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const settingKey = "auth.adminBootstrapCompleted";
  const promoted = await db.transaction(async tx => {
    // Serialize concurrent server boots. The settings table is provisioned by migrations.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${settingKey}, 0))`);
    const prior = await tx.execute(sql`SELECT 1 FROM system_settings WHERE key=${settingKey}`);
    if (prior.rows.length > 0) return null;

    const [existingAdmin] = await tx.select({ id: users.id }).from(users)
      .where(eq(users.role, "admin")).orderBy(users.createdAt, users.id).limit(1);
    let owner = existingAdmin;
    let didPromote = false;
    if (!owner && adminEmail) {
      const [candidate] = await tx.update(users)
        .set({ role: "admin", updatedAt: new Date() })
        .where(and(eq(users.email, adminEmail), eq(users.role, "user")))
        .returning({ id: users.id });
      owner = candidate;
      didPromote = Boolean(candidate);
    }
    if (!owner) return null;

    await tx.execute(sql`INSERT INTO system_settings(key,value,updated_by)
      VALUES(${settingKey},${JSON.stringify({ completed: true, userId: owner.id })}::jsonb,${owner.id})`);
    return didPromote ? owner.id : null;
  });
  if (promoted) logger.info({ userId: promoted }, "[auth] Completed one-time admin bootstrap");
}

// ─── Setup function ───────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { message: "Too many login attempts, please try again in 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { message: "Too many accounts created, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many password reset attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

export function setupAuth(app: Express): void {
  const PgSession = connectPgSimple(session);

  // Fix #14: in production, require SESSION_SECRET
  if (!process.env.SESSION_SECRET) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("[auth] FATAL: SESSION_SECRET must be set in production. Refusing to start with insecure fallback.");
    }
    console.warn("[auth] WARNING: SESSION_SECRET not set — using insecure fallback. Set SESSION_SECRET in .env for production.");
  }

  const sessionMiddleware = session({
    store: new PgSession({
      pool,
      tableName: "session",
      createTableIfMissing: false,
      // Wave 2: prune expired session rows every 15 minutes so the session
      // table doesn't grow unbounded (default would be every 15 min too, but
      // we set it explicitly to make the retention policy auditable).
      pruneSessionInterval: 60 * 15,
    }),
    secret: process.env.SESSION_SECRET ?? "cheaterfinder-fallback-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.HTTPS_ENABLED === "true",
    },
    name: "cheaterfinder.sid",
  });

  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  // Mobile bearer auth. Runs after passport.session() so a cookie session
  // always wins; only fills in req.user when a valid Bearer token is present.
  // Every existing isAuthenticated/isAdmin route works unchanged as a result.
  app.use(bearerAuth);
  setupMobileAuth(app);

  // C2: one-shot admin promotion at boot (see bootstrapAdminRole). Failures
  // are logged but never block startup — admin routes simply stay locked
  // until an admin role exists.
  void bootstrapAdminRole().catch((err) => {
    logger.error({ err }, "[auth] Admin bootstrap failed:");
  });

  // ── Auth routes ─────────────────────────────────────────────────────────────

  // These routes precede index.ts's API CSRF middleware. Reject browser
  // cross-site authentication requests here too. Native clients have no
  // ambient browser Origin/Sec-Fetch-Site and remain supported.
  app.use("/api/auth", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) { next(); return; }
    const origin = req.get("origin");
    let foreignOrigin = false;
    if (origin) {
      try {
        const parsed = new URL(origin);
        const configured = process.env.APP_URL ? new URL(process.env.APP_URL).origin : null;
        foreignOrigin = parsed.origin !== configured && parsed.host !== req.get("host");
      } catch { foreignOrigin = true; }
    }
    if (req.get("sec-fetch-site") === "cross-site" || foreignOrigin) {
      res.status(403).json({ message: "Forbidden: cross-site authentication request" }); return;
    }
    next();
  });

  // POST /api/auth/register
  app.post("/api/auth/register", registerLimiter, validateBody(registerSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, email, password } = req.body as RegisterInput;

      const normalizedEmail = email; // already lowercased + trimmed by schema

      // Check for existing user
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      if (existing) {
        // C8: generic, non-enumerable response (same shape as the
        // forgot-password flow) — never confirm that an email is registered.
        res.status(400).json({
          message:
            "Unable to complete registration with the provided details. If you already have an account, sign in or use the password reset option.",
        });
        return;
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      const newUser = await db.transaction(async tx => {
        const [created] = await tx.insert(users).values({
          name: name.trim(), email: normalizedEmail, hashedPassword,
        }).returning();
        await recordWelcomeEmail(tx, created.id);
        return created;
      });

      // Auto-login after registration
      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((regenErr) => {
          if (regenErr) { reject(regenErr); return; }
          req.login(newUser, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });

      issueCsrfCookie(res);
      const { hashedPassword: _omit, ...safeUser } = newUser;
      res.status(201).json(safeUser);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/auth/login
  app.post("/api/auth/login", loginLimiter, validateBody(loginSchema), (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate(
      "local",
      (err: unknown, user: Express.User | false, info: { message: string } | undefined) => {
        if (err) return next(err);
        if (!user) {
          return res.status(401).json({ message: info?.message ?? "Invalid credentials" });
        }
        req.session.regenerate((regenErr) => {
          if (regenErr) return next(regenErr);
          req.login(user, (loginErr) => {
            if (loginErr) return next(loginErr);
            issueCsrfCookie(res);
            const { hashedPassword: _omit, ...safeUser } = user;
            return res.json(safeUser);
          });
        });
      },
    )(req, res, next);
  });

  // POST /api/auth/logout
  app.post("/api/auth/logout", (req: Request, res: Response, next: NextFunction) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => {
        res.clearCookie("cheaterfinder.sid");
        clearCsrfCookie(res);
        res.json({ message: "Logged out successfully" });
      });
    });
  });

  // GET /api/auth/me
  app.get("/api/auth/me", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    // The admin/customer fetch helpers probe this endpoint after a CSRF 403.
    // Restore a missing or malformed companion cookie only after validating
    // the session. Preserve valid cookies so parallel probes do not rotate
    // tokens underneath mutations that are already in flight.
    const csrfToken = readCookie(req.headers.cookie, CSRF_COOKIE_NAME);
    if (!req.mobileAuth && (!csrfToken || !/^[a-f0-9]{64}$/i.test(csrfToken))) {
      issueCsrfCookie(res);
    }
    const { hashedPassword: _omit, ...safeUser } = req.user;
    return res.json(safeUser);
  });

  app.post("/api/auth/onboarding-ack", isAuthenticated, requireCsrfToken, async (req, res, next) => {
    try {
      const [user] = await db.update(users).set({
        onboardingAcknowledgedAt: sql`COALESCE(${users.onboardingAcknowledgedAt}, NOW())`,
      }).where(eq(users.id, req.user!.id)).returning({ acknowledgedAt: users.onboardingAcknowledgedAt });
      if (!user) return res.status(401).json({ message: "Account no longer exists" });
      return res.json(user);
    } catch (error) { next(error); }
  });

  // POST /api/auth/forgot-password
  app.post("/api/auth/forgot-password", passwordResetLimiter, validateBody(forgotPasswordSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body as ForgotPasswordInput;

      const normalizedEmail = email; // already lowercased + trimmed by schema

      // Always return success (don't reveal if email exists)
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      if (user) {
        // Generate a secure random token
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        // Keep previously delivered links valid if a second request/mail
        // failure arrives. Successful redemption revokes all other links.
        await db.insert(passwordResetTokens).values({
          userId: user.id,
          token: hashResetToken(token),
          expiresAt,
        });

        // Send reset email.
        // Fix #21: avoid host-header injection by using APP_URL, never req.get("host").
        try {
          await sendApplicationEmail({
            from: applicationEmailFrom(),
            to: normalizedEmail,
            ...passwordResetEmail(user.name, token),
          }, `password-reset:${hashResetToken(token)}`);
        } catch (error) {
          // Keep the response non-enumerable and avoid logging recipient,
          // token or provider payload. A lost API response may still deliver.
          console.error("[auth] Password-reset email acceptance not confirmed", {
            code: error instanceof EmailDeliveryError ? error.code : "provider_error",
          });
        }
      }

      // Always return success to prevent email enumeration
      res.json({ message: "If an account with that email exists, check your inbox for a password reset link." });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/auth/reset-password
  app.post("/api/auth/reset-password", passwordResetLimiter, validateBody(resetPasswordSchema), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, password } = req.body as ResetPasswordInput;

      // bcrypt is deliberately outside the short atomic transaction.
      const hashedPassword = await bcrypt.hash(password, 12);
      const changed = await applyCustomerPasswordReset(hashResetToken(token), hashedPassword);
      if (!changed) { res.status(400).json({ message: "Invalid or expired reset link" }); return; }
      // A cookie session loaded before the reset must not be re-saved at end
      // of this request. New sessions are also password/version bound.
      await new Promise<void>(resolve => req.session.destroy(() => resolve()));
      res.clearCookie("cheaterfinder.sid");
      clearCsrfCookie(res);
      res.json({ message: "Password has been reset successfully" });
    } catch (err) {
      next(err);
    }
  });
}
