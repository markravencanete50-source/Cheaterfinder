import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export const PREVIEW_MEDIA_URL = "/assets/preview-blur.png";

export type TrialPreviewKind = "account" | "accounts" | "viewer" | "feed" | "roster" |
  "posts" | "likers" | "comments" | "reports" | "notifications" | "realtime";

export interface TrialPreviewContext {
  trackedAccountId?: string;
  dimension?: "followers" | "following";
}

export interface PreviewCursorScope {
  userId: string;
  trackedAccountId: string;
  dimension: "followers" | "following";
}

export function isTrialPreview(subscription: { status?: string | null } | null | undefined): boolean {
  return subscription?.status === "trialing";
}

function keyFor(purpose: string): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret?.trim()) throw new Error("SESSION_SECRET is required for trial preview");
  return createHmac("sha256", secret).update(`cheaterfinder-trial-preview-v1:${purpose}`).digest();
}

function cursorScope(scope: PreviewCursorScope): Buffer {
  if (!scope.userId || !scope.trackedAccountId || !["followers", "following"].includes(scope.dimension)) {
    throw new Error("Invalid preview cursor scope");
  }
  return Buffer.from(JSON.stringify([scope.userId, scope.trackedAccountId, scope.dimension]));
}

/** Encrypt the original seek cursor: it contains a real Instagram username. */
export function wrapPreviewCursor(cursor: string | null, scope: PreviewCursorScope): string | null {
  if (cursor === null) return null;
  if (!cursor || Buffer.byteLength(cursor) > 4096) throw new Error("Invalid preview cursor");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor("cursor"), iv);
  cipher.setAAD(cursorScope(scope));
  const encrypted = Buffer.concat([cipher.update(cursor, "utf8"), cipher.final()]);
  return `tp1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}

/** Fail closed; never let invalid preview tokens fall back to a real seek cursor. */
export function unwrapPreviewCursor(cursor: string, scope: PreviewCursorScope): string {
  try {
    if (cursor.length > 5600 || !/^tp1\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const encoded = cursor.slice(4);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length <= 28 || bytes.toString("base64url") !== encoded) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", keyFor("cursor"), bytes.subarray(0, 12));
    decipher.setAAD(cursorScope(scope));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Invalid preview cursor");
  }
}

const PROFILE_FIELDS = new Set([
  "username", "igUsername", "displayName", "profilePicUrl", "isVerified", "isPrivate",
  "followerCount", "followingCount", "postCount",
]);
const INTERNAL_IDS = new Set(["id", "userId", "trackedAccountId", "reportId"]);
const OPERATIONAL_BOOLEANS = new Set([
  "isActive", "trackingActive", "hasMore", "isPartial", "isRead", "enabled", "postsPaginationDone",
  "unfollowDetectionTrusted", "followingEventsTrustworthy", "followerEventsTrustworthy",
]);
const ENVELOPE_COUNTS = new Set([
  "limit", "offset", "total", "loadedTotal", "expectedTotal", "reachableTotal", "enumerableCap",
  "completionPct", "postsTotal",
]);
const SAFE_NOTIFICATION_TYPES = new Set([
  "subscription_updated", "trial_ending", "payment_failed", "access_granted", "access_pending",
]);
const ENUM_VALUES = new Set([
  "photo", "video", "reel", "carousel", "all", "like", "follow", "unfollow", "weekly", "monthly",
  "generating", "ready", "failed", "public", "pending_access", "has_access", "access_denied",
  "complete", "capped", "syncing", "restricted", "available", "waiting_for_access", "not_collected",
  "collecting", "delayed", "empty_observed", "unavailable", "account", "shared_public_profile",
  "bot", "apify", "cached", "none", "queued", "running", "pending", "source_limited", "paused",
  "disabled", "waiting", "idle", "error", "new_like", "new_follow", "new_unfollow", "report_ready",
  "profile.updated", "posts.added", "stories.changed", "highlights.changed", "followers.changed", "following.changed",
]);
const ENUM_FIELDS = new Set([
  "type", "kind", "eventType", "postType", "mediaType", "postTypeFilter", "accessStatus", "syncState",
  "status", "state", "source", "dataSource", "headStatus",
]);
const MEDIA_FIELD = /(?:pfp|thumbnail|media|video|display|cover|profilepic)(?:url|urlhd)$/i;
const USERNAME_FIELD = /username$/i;
const NAME_FIELD = /(?:displayname|fullname)$/i;
const EXTERNAL_ID_FIELD = /^(?:shortcode|postId|storyId|highlightId|mediaId|igUserId|media_id|pk)$/;
const DATE_FIELD = /(?:At|Date|Start|End)$|^(?:at|date|day|start|end)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * The caller authorizes ownership/privacy before applying this projection.
 * Unknown fields are redacted by default, so a new data field does not silently
 * become trial-visible. Pagination cardinality is deliberately retained.
 */
export function sanitizeTrialPreview(
  kind: TrialPreviewKind,
  payload: unknown,
  userId: string,
  context: TrialPreviewContext = {},
): unknown {
  const pseudonymKey = keyFor("pseudonym");
  const hash = (value: string) => createHmac("sha256", pseudonymKey)
    .update(JSON.stringify([userId, value])).digest("hex");
  const alias = (value: unknown, prefix = "user") => `${prefix}_${hash(String(value).toLowerCase()).slice(0, 12)}`;
  const syntheticDate = (seed: string, dateOnly: boolean) => {
    const offset = parseInt(hash(seed).slice(0, 8), 16) % (365 * 86400);
    const iso = new Date(Date.UTC(2000, 0, 1) + offset * 1000).toISOString();
    return dateOnly ? iso.slice(0, 10) : iso;
  };
  const isProfile = (path: Array<string | number>) =>
    ((kind === "account" || kind === "viewer") && path.length === 0) ||
    (kind === "accounts" && path.length === 1 && typeof path[0] === "number") ||
    (kind === "viewer" && path.length === 1 && path[0] === "profileSnapshot") ||
    ((kind === "account" || kind === "accounts") && path.at(-2) === "profileSnapshots" && path.at(-1) === 0);
  const envelope = (path: Array<string | number>) => path.length === 0 ||
    path.includes("rosterStatus") || path.at(-1) === "background";

  function visit(value: unknown, path: Array<string | number>, seed: string): unknown {
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...path, index], `${seed}:${index}`));
    if (value instanceof Date) return syntheticDate(seed, false);
    if (!isRecord(value)) {
      if (value === null || value === undefined) return value;
      if (typeof value === "string") {
        if (path.includes("thumbnails")) return PREVIEW_MEDIA_URL;
        if (path.includes("hashtags")) return "preview";
        if (path.some(part => typeof part === "string" && /Sample$/.test(part))) return alias(value);
        return "Preview";
      }
      return typeof value === "boolean" ? false : null;
    }
    // Billing and private-access notices are operational; they remain actionable.
    if (kind === "notifications" && typeof value.type === "string" && SAFE_NOTIFICATION_TYPES.has(value.type)) {
      return { ...value };
    }
    const identity = value.id ?? value.shortcode ?? value.storyId ?? value.highlightId ??
      Object.entries(value).find(([key]) => USERNAME_FIELD.test(key) || key === "author")?.[1] ?? seed;
    const rowSeed = String(identity);
    const result: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(value)) {
      const fieldPath = [...path, field];
      if (field === "trialPreview") { result[field] = true; continue; }
      if (isProfile(path) && (PROFILE_FIELDS.has(field) || (path.length > 0 && field === "fullName"))) {
        result[field] = item;
      } else if (field === "nextCursor") {
        if (item === null) result[field] = null;
        else if (kind === "roster" && path.length === 0 && typeof item === "string" && context.trackedAccountId && context.dimension) {
          result[field] = wrapPreviewCursor(item, { userId, trackedAccountId: context.trackedAccountId, dimension: context.dimension });
        } else {
          throw new Error("Trial preview cursor requires an account and dimension scope");
        }
      } else if (INTERNAL_IDS.has(field)) {
        result[field] = item;
      } else if (USERNAME_FIELD.test(field) || field === "author") {
        result[field] = item == null ? item : alias(item);
      } else if (NAME_FIELD.test(field)) {
        result[field] = item == null ? item : "Instagram User";
      } else if (MEDIA_FIELD.test(field)) {
        result[field] = item == null ? item : PREVIEW_MEDIA_URL;
      } else if (EXTERNAL_ID_FIELD.test(field)) {
        result[field] = item == null ? item : alias(item, "preview");
      } else if (field === "postUrl" || field === "externalUrl" || field === "biography" || field === "postsNextCursor") {
        result[field] = null;
      } else if (field === "dedupeKey") {
        result[field] = item == null ? item : alias(item, "preview");
      } else if (Array.isArray(item) || isRecord(item)) {
        result[field] = visit(item, fieldPath, `${rowSeed}:${field}`);
      } else if (item === null || item === undefined) {
        result[field] = item;
      } else if (item instanceof Date || DATE_FIELD.test(field) ||
        (typeof item === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(item))) {
        result[field] = syntheticDate(`${rowSeed}:${field}`, field === "date" || field === "day");
      } else if (ENUM_FIELDS.has(field) && typeof item === "string" && ENUM_VALUES.has(item)) {
        result[field] = item;
      } else if (field === "tz" && typeof item === "string") {
        // Validated request input used for chart labels, not collected data.
        result[field] = item;
      } else if (typeof item === "boolean") {
        result[field] = OPERATIONAL_BOOLEANS.has(field) ? item : false;
      } else if (typeof item === "number") {
        // Hour is a chart coordinate, whereas its count is collected activity.
        const hourCoordinate = field === "hour" && path.includes("activityByHour") &&
          Number.isInteger(item) && item >= 0 && item < 24;
        // Engagement expectedTotal reveals the exact count on an individual
        // post. Keep page cardinality but redact this separate measurement.
        const engagementCount = (kind === "comments" || kind === "likers") && field === "expectedTotal";
        result[field] = hourCoordinate || (!engagementCount && envelope(path) && ENVELOPE_COUNTS.has(field)) ? item : null;
      } else if (field === "label" && path.includes("topLikedAccounts")) {
        result[field] = alias(item);
      } else if (field === "title") {
        result[field] = kind === "notifications" ? "Activity preview" : "Preview";
      } else if (field === "body" || field === "text" || field === "caption") {
        result[field] = "Activate subscription to view this content.";
      } else {
        result[field] = "Preview";
      }
    }
    const contentRow = ["shortcode", "storyId", "highlightId"].some(field => field in value) ||
      (!isProfile(path) && Object.keys(value).some(field => MEDIA_FIELD.test(field)));
    const topRow = (kind === "accounts" && path.length === 1) ||
      ((kind === "reports" || kind === "notifications") && path.length === 2 && path[0] === "items");
    if (path.length === 0 || contentRow || topRow) result.trialPreview = true;
    return result;
  }

  return visit(payload, [], kind);
}
