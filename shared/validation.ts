import { z } from "zod";
import { CHECKOUT_PLAN_IDS } from "./billing-plans.js";
import type { Request, Response, NextFunction } from "express";

// ─── Helper: validate request body against a Zod schema ─────────────────────

/**
 * Returns an Express middleware that parses `req.body` with the given Zod
 * schema.  On success the parsed (and typed) data is written back to
 * `req.body` so downstream handlers receive clean, validated input.
 *
 * On failure a 400 response is sent with user-friendly error messages.
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));

      res.status(400).json({
        message: "Validation failed",
        errors,
      });
      return;
    }

    // Replace body with the parsed (cleaned/coerced) data
    req.body = result.data;
    next();
  };
}

// ─── Person names ────────────────────────────────────────────────────────────

/**
 * What counts as a person's name, shared by registration and profile update so
 * a name accepted at sign-up cannot be refused on edit.
 *
 * Both previously asked only for a non-empty string, which is how names like
 * "Zohaib++++ 2323" and "++++++++(((((+" reached the users table.
 *
 * The character rule is Unicode-aware on purpose. An `[A-Za-z ]` rule would
 * refuse "José", "Gonçalves" and "Иван Петров" — real names of real customers,
 * and the product ships in Spanish, Portuguese and Russian. So it admits
 * letters in any script, plus the punctuation that genuinely occurs inside
 * names: the space, the hyphen in "Mary-Jane", the apostrophe in "O'Neil"
 * (both ' and the typographic ’ a phone keyboard substitutes) and the full
 * stop in "J. R.". `\p{M}` admits combining marks, so a decomposed "é" — two
 * code points, and what an iOS keyboard often produces — is not read as a
 * stray symbol. Digits and every other symbol are refused.
 *
 * Wording is kept identical to the mobile client's `lib/person-name.ts`, so
 * the two never disagree about the same name.
 */
const NAME_MAX_LENGTH = 50;
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\p{Zs}'’.\-]*$/u;

/**
 * One issue at most, in this order. Without the early returns an empty name
 * would report both "required" and "can only contain letters", and telling
 * someone their empty name has bad characters is nonsense.
 */
function checkPersonName(value: string, ctx: z.RefinementCtx): void {
  if (value.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Name is required" });
    return;
  }

  if (value.length > NAME_MAX_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Name must be ${NAME_MAX_LENGTH} characters or less`,
    });
    return;
  }

  if (!NAME_PATTERN.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Name can only contain letters, spaces, hyphens and apostrophes",
    });
  }
}

export const personNameSchema = z
  .string({ required_error: "Name is required" })
  .trim()
  .superRefine(checkPersonName);

// ─── Auth schemas ────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  name: personNameSchema,
  email: z
    .string({ required_error: "Email is required" })
    .trim()
    .toLowerCase()
    .email("Please enter a valid email address"),
  password: z
    .string({ required_error: "Password is required" })
    .min(8, "Password must be at least 8 characters"),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .trim()
    .toLowerCase()
    .email("Please enter a valid email address"),
  password: z
    .string({ required_error: "Password is required" })
    .min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .trim()
    .toLowerCase()
    .email("Please enter a valid email address"),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z
    .string({ required_error: "Token is required" })
    .min(1, "Token is required"),
  password: z
    .string({ required_error: "Password is required" })
    .min(8, "Password must be at least 8 characters"),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// ─── Tracking schemas ────────────────────────────────────────────────────────

export const addTrackedAccountSchema = z.object({
  igUsername: z
    .string({ required_error: "Instagram username is required" })
    .trim()
    .min(1, "Instagram username is required")
    .max(30, "Instagram username must be 30 characters or less")
    .regex(
      /^@?[a-zA-Z0-9._]+$/,
      "Instagram username can only contain letters, numbers, periods, and underscores",
    ),
});

export type AddTrackedAccountInput = z.infer<typeof addTrackedAccountSchema>;

// ─── Account schemas ─────────────────────────────────────────────────────────

export const updateProfileSchema = z.object({
  // `.optional()` after the rules, not instead of them: an absent name is
  // fine (the client may be saving only a toggle), but a present one is held
  // to exactly the same standard as at registration.
  name: personNameSchema.optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Please enter a valid email address")
    .optional(),
  emailAlerts: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
}).refine(
  (data) =>
    data.name !== undefined ||
    data.email !== undefined ||
    data.emailAlerts !== undefined ||
    data.pushNotifications !== undefined,
  {
  message: "At least one field is required",
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const updatePasswordSchema = z.object({
  currentPassword: z
    .string({ required_error: "Current password is required" })
    .min(1, "Current password is required"),
  newPassword: z
    .string({ required_error: "New password is required" })
    .min(8, "New password must be at least 8 characters"),
});

export type UpdatePasswordInput = z.infer<typeof updatePasswordSchema>;

// ─── Billing schemas ─────────────────────────────────────────────────────────

export const checkoutSchema = z.object({
  acceptedOfferVersion: z.string().min(1).max(160).optional(),
  igUsername: addTrackedAccountSchema.shape.igUsername.optional(),
  plan: z.enum(CHECKOUT_PLAN_IDS, {
    required_error: "Plan is required",
    invalid_type_error: "Plan must be Starter, Standard, or Pro",
  }),
  // Which client is checking out, so the server can pick the right post-checkout
  // redirect. Deliberately an enum and NOT a caller-supplied URL: letting a
  // client name its own redirect target in a payment flow is an open redirect.
  // The actual URLs are built server-side in createCheckoutSession.
  client: z.enum(["web", "mobile"]).optional().default("web"),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ─── Push device schemas ─────────────────────────────────────────────────────

export const deviceTokenSchema = z.object({
  // Expo issues `ExponentPushToken[...]`; the older `ExpoPushToken[...]` form is
  // still accepted so an app built against an earlier SDK can still register.
  token: z
    .string()
    .trim()
    .regex(
      /^Expo(nent)?PushToken\[[^\]]+\]$/,
      "Not a valid Expo push token",
    ),
  platform: z.enum(["ios", "android"], {
    required_error: "Platform is required",
    invalid_type_error: "Platform must be ios or android",
  }),
});

export type DeviceTokenInput = z.infer<typeof deviceTokenSchema>;

// ─── Bot session data schema (Fix #16) ───────────────────────────────────────
// Matches Playwright's context.storageState() output shape.

const BotCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().optional(),
});

export const BotSessionDataSchema = z.object({
  cookies: z.array(BotCookieSchema),
  origins: z.array(z.unknown()).optional(),
});

export type BotSessionData = z.infer<typeof BotSessionDataSchema>;

export const MAX_SESSION_DATA_BYTES = 64 * 1024;

/**
 * Validate bot sessionData. Returns the parsed object or an error message.
 * Accepts the raw JSON string stored in bot_accounts.session_data.
 */
export function validateBotSessionData(
  sessionData: string,
): { ok: true; data: BotSessionData } | { ok: false; error: string } {
  if (sessionData.length > MAX_SESSION_DATA_BYTES) {
    return {
      ok: false,
      error: `sessionData too large (max ${MAX_SESSION_DATA_BYTES} bytes)`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionData);
  } catch (err) {
    return {
      ok: false,
      error: `sessionData is not valid JSON: ${err instanceof Error ? err.message : "parse error"}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "sessionData must be a JSON object" };
  }
  const result = BotSessionDataSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `sessionData shape invalid: ${result.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  return { ok: true, data: result.data };
}
