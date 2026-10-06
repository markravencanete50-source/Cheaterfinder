// ─── Instagram MOBILE session parsing + envelope ─────────────────────────────
//
// The web transport (ig-http-client.ts) authenticates with a Playwright
// storage-state: a cookie jar containing `sessionid` AND `csrftoken`, replayed
// against www.instagram.com. Pre-authenticated MOBILE sessions are a different
// animal — they carry:
//   - sessionid + ds_user_id + mid cookies (NO csrftoken)
//   - an `Authorization: Bearer IGT:2:<base64>` token (the mobile app's auth)
//   - an Android device fingerprint (android-id + phone/device uuids + UA)
// and are replayed against i.instagram.com/api/v1 by ig-mobile-read-client.ts.
//
// This module parses the raw seller export format and defines the encrypted
// envelope we persist in bot_accounts.session_data so the runtime round-trips
// it exactly like a web session (readSession() just decrypts the JSON string).
//
// Raw line format (pipe-delimited, 4 fields):
//   username:password:totp | user-agent | android-id;uuid;uuid;uuid | k=v;k=v;...
// The user-agent field is sometimes empty (some exports omit it).

const MOBILE_ENVELOPE_MARKER = "instagram-mobile-bearer";

// A neutral, plausible modern Android UA used when the export omits one.
const DEFAULT_MOBILE_UA =
  "Instagram 432.0.0.0.66 Android (30/11; 420dpi; 1080x2340; samsung; SM-G991B; o1s; exynos2100; en_US; 980502218)";

/** Parsed, validated mobile session ready to drive the mobile-API client. */
export interface MobileSession {
  readonly __marker: typeof MOBILE_ENVELOPE_MARKER;
  readonly version: 1;
  /** IG numeric account id (also the ds_user_id cookie). */
  readonly dsUserId: string;
  /** Full `<id>%3A...` session cookie value (URL-encoded as IG issues it). */
  readonly sessionid: string;
  /** `mid` cookie / X-MID header value. */
  readonly mid: string;
  /** `Authorization: Bearer IGT:2:<base64>` — sent verbatim as the header. */
  readonly bearer: string;
  /** X-IG-WWW-Claim seed ("0" until IG hands us a real one at runtime). */
  readonly wwwClaim: string;
  /** IG-U-RUR / rur cookie value, if present (routing hint; optional). */
  readonly rur: string | null;
  /** Mobile app User-Agent string. */
  readonly userAgent: string;
  /** `android-<hex>` device id → X-IG-Android-ID. */
  readonly androidId: string;
  /** Primary device/phone uuid → X-IG-Device-ID. */
  readonly deviceUuid: string;
  /** The remaining device uuids from the export (family/pairing ids). */
  readonly extraUuids: ReadonlyArray<string>;
}

/** Credentials extracted alongside the session (for optional re-login later). */
export interface MobileCredentials {
  readonly username: string;
  readonly password: string;
  readonly totpSecret: string | null;
}

export interface ParsedMobileLine {
  readonly credentials: MobileCredentials;
  readonly session: MobileSession;
}

function splitCredentials(raw: string): MobileCredentials {
  // Format is username:password:totp. Passwords in these exports never contain
  // ':' but we split defensively: first token is the username, the last token
  // is the Base32 TOTP, everything between is the password.
  const parts = raw.split(":");
  if (parts.length < 2) {
    throw new Error("mobile-session: malformed credentials segment");
  }
  const username = parts[0].trim();
  let totpSecret: string | null = null;
  let passwordParts = parts.slice(1);
  const last = parts[parts.length - 1].replace(/\s+/g, "").toUpperCase();
  // Base32 secret: A–Z 2–7, typically 16–32 chars, no lowercase/other symbols.
  if (parts.length >= 3 && /^[A-Z2-7]{16,}$/.test(last)) {
    totpSecret = last;
    passwordParts = parts.slice(1, parts.length - 1);
  }
  const password = passwordParts.join(":");
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(username) || !password || /[\0\r\n]/.test(raw)) {
    throw new Error("mobile-session: invalid username/password segment");
  }
  return { username, password, totpSecret };
}

function parseCookieBlob(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of raw.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim(); // preserve Base64 padding and header content
    if (/[\0\r\n]/.test(key + value)) {
      throw new Error("mobile-session: invalid control character in session fields");
    }
    if (out.has(key) && out.get(key) !== value) {
      throw new Error("mobile-session: conflicting duplicate session field");
    }
    out.set(key, value);
  }
  return out;
}

/** Header names are case-insensitive, while their credential values are not. */
function readAliasedField(fields: Map<string, string>, ...names: string[]): string {
  const values = names.map((name) => fields.get(name)).filter((value): value is string => value !== undefined);
  if (new Set(values).size > 1) {
    throw new Error("mobile-session: conflicting aliased session field");
  }
  return values[0] ?? "";
}

function decodedSessionCookie(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (/[\0\r\n]/.test(decoded)) throw new Error();
    return decoded;
  } catch {
    throw new Error("mobile-session: invalid session cookie encoding");
  }
}

/** An export must name the same account in its cookie, id header and bearer. */
function validateSessionIdentity(dsUserId: string, sessionid: string, bearer: string): void {
  if (!/^[1-9][0-9]*$/.test(dsUserId)) {
    throw new Error("mobile-session: missing/invalid numeric account identity");
  }
  const cookie = decodedSessionCookie(sessionid);
  if (!cookie.startsWith(`${dsUserId}:`) || cookie.length <= dsUserId.length + 1) {
    throw new Error("mobile-session: session cookie identity mismatch");
  }
  const match = /^Bearer[ \t]+IGT:2:([A-Za-z0-9+/_-]+={0,2})$/.exec(bearer);
  if (!match) {
    throw new Error("mobile-session: missing/invalid Authorization bearer");
  }
  let token: unknown;
  try {
    token = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  } catch {
    throw new Error("mobile-session: malformed bearer payload");
  }
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    throw new Error("mobile-session: malformed bearer payload");
  }
  const payload = token as Record<string, unknown>;
  if (
    !["string", "number"].includes(typeof payload.ds_user_id) ||
    String(payload.ds_user_id) !== dsUserId ||
    typeof payload.sessionid !== "string" ||
    decodedSessionCookie(payload.sessionid) !== cookie
  ) {
    throw new Error("mobile-session: bearer/cookie identity mismatch");
  }
}

/**
 * Parse one raw seller-export line into credentials + a validated
 * MobileSession. Throws with a precise reason on any missing critical field so
 * a bad line is skipped loudly by the importer rather than silently stored.
 */
export function parseMobileSessionLine(line: string): ParsedMobileLine {
  const trimmed = line.trim();
  if (!trimmed) throw new Error("mobile-session: empty line");
  const fields = trimmed.split("|");
  if (fields.length < 4) {
    throw new Error(
      `mobile-session: expected 4 pipe-delimited fields, got ${fields.length}`,
    );
  }
  const [credsRaw, uaRaw, deviceRaw, cookieRaw] = fields;

  const credentials = splitCredentials(credsRaw);

  const deviceParts = deviceRaw.split(";").map((p) => p.trim()).filter(Boolean);
  const androidId = deviceParts[0] ?? "";
  if (!/^android-[0-9a-f]{8,}$/i.test(androidId)) {
    throw new Error(
      "mobile-session: invalid Android device id",
    );
  }
  const deviceUuid = deviceParts[1] ?? "";
  const extraUuids = deviceParts.slice(2);
  const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if ([deviceUuid, ...extraUuids].filter(Boolean).some((uuid) => !uuidPattern.test(uuid))) {
    throw new Error("mobile-session: invalid device UUID");
  }
  if (/[\0\r\n]/.test(uaRaw)) {
    throw new Error("mobile-session: invalid user-agent header");
  }

  const cookies = parseCookieBlob(cookieRaw);
  const sessionid = cookies.get("sessionid") ?? "";
  const dsUserId = readAliasedField(cookies, "ds_user_id", "ig-u-ds-user-id");
  const mid = readAliasedField(cookies, "mid", "x-mid");
  const bearer = cookies.get("authorization") ?? "";
  const wwwClaim = cookies.get("x-ig-www-claim") ?? "0";
  const rur = readAliasedField(cookies, "ig-u-rur", "rur") || null;

  if (!sessionid) {
    throw new Error(`mobile-session: ${credentials.username} missing sessionid cookie`);
  }
  validateSessionIdentity(dsUserId, sessionid, bearer);

  const session: MobileSession = {
    __marker: MOBILE_ENVELOPE_MARKER,
    version: 1,
    dsUserId,
    sessionid,
    mid,
    bearer: bearer.trim(),
    wwwClaim,
    rur,
    userAgent: uaRaw.trim() || DEFAULT_MOBILE_UA,
    androidId,
    deviceUuid: deviceUuid || androidId,
    extraUuids,
  };

  return { credentials, session };
}

/** Serialize a MobileSession to the JSON string stored (encrypted) in session_data. */
export function serializeMobileSession(session: MobileSession): string {
  return JSON.stringify(session);
}

/**
 * Parse the decrypted session_data string back into a MobileSession, or return
 * null if it is not a mobile envelope (a web storage-state, or garbage). Never
 * throws — callers use the null to fall through to the web transport.
 */
export function parseMobileEnvelope(decrypted: string | null | undefined): MobileSession | null {
  if (!decrypted) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(decrypted);
  } catch {
    return null;
  }
  if (
    !obj ||
    typeof obj !== "object" ||
    (obj as { __marker?: unknown }).__marker !== MOBILE_ENVELOPE_MARKER
  ) {
    return null;
  }
  const e = obj as Record<string, unknown>;
  if (
    typeof e.sessionid !== "string" ||
    typeof e.dsUserId !== "string" ||
    typeof e.bearer !== "string"
  ) {
    return null;
  }
  return {
    __marker: MOBILE_ENVELOPE_MARKER,
    version: 1,
    dsUserId: e.dsUserId,
    sessionid: e.sessionid,
    mid: typeof e.mid === "string" ? e.mid : "",
    bearer: e.bearer,
    wwwClaim: typeof e.wwwClaim === "string" ? e.wwwClaim : "0",
    rur: typeof e.rur === "string" ? e.rur : null,
    userAgent: typeof e.userAgent === "string" && e.userAgent ? e.userAgent : DEFAULT_MOBILE_UA,
    androidId: typeof e.androidId === "string" ? e.androidId : "",
    deviceUuid: typeof e.deviceUuid === "string" ? e.deviceUuid : "",
    extraUuids: Array.isArray(e.extraUuids)
      ? e.extraUuids.filter((u): u is string => typeof u === "string")
      : [],
  };
}

/** Quick predicate: is this decrypted session_data a mobile envelope? */
export function isMobileEnvelope(decrypted: string | null | undefined): boolean {
  return parseMobileEnvelope(decrypted) !== null;
}

export { MOBILE_ENVELOPE_MARKER, DEFAULT_MOBILE_UA };
