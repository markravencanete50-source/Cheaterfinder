// ─── tmailgg.site / tmail.gg web-inbox IG verification-code fetcher ─────────
//
// Wave 6: 20+ new bots use random `<name>@tmailgg.site` addresses. Unlike the
// onet.pl / rambler.ru bots (which expose IMAP), tmailgg is a web inbox only —
// no IMAP, no SMTP. We have to scrape the same HTTP endpoints the public web
// UI uses.
//
// Protocol (reverse-engineered, mirrors the `bertigert/temp-mails` Python
// wrapper for the same provider — see https://github.com/bertigert/temp-mails
// /blob/master/temp_mails/providers/tmail_gg.py):
//
//   1. GET /                                  → returns HTML with a meta tag
//                                                <meta name="csrf-token"
//                                                      content="<token>">
//                                                and a Laravel session cookie.
//   2. POST /create                           → `_token=<csrf>&name=<local>
//                                                &domain=<domain>` switches the
//                                                cookie-bound mailbox to the
//                                                desired address. Only needed
//                                                when we want a *specific*
//                                                address (we always do — the
//                                                bot's address is fixed).
//   3. POST /messages                         → `_token=<csrf>&captcha=`
//                                                returns JSON:
//                                                { mailbox, messages: [
//                                                    { id, receivedAt,
//                                                      subject, content }, …
//                                                ] }
//                                                `content` is HTML (rendered
//                                                inline preview).
//
// We never delete anything — keeps the audit trail intact. We also never
// preserve cookies between fetches: each call is a fresh session because the
// service is stateless from our perspective and we don't want a long-lived
// cookie picking up another bot's mailbox.
// ─────────────────────────────────────────────────────────────────────────────

import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "tmailgg-fetcher" });

// 6-digit code anywhere in body/subject. Same regex as imap-code-fetcher.ts
// for consistency.
const CODE_REGEX = /\b(\d{6})\b/;

// Heuristics for "this is an Instagram security email". We can't rely on
// `From:` headers in the JSON payload (the service truncates them), so we
// match against subject/body text.
const IG_SUBJECT_HINTS = [
  /instagram/i,
  /verification\s*code/i,
  /security\s*code/i,
  /confirm.*code/i,
  /code.*confirm/i,
  /\bcode\b/i,
];

const IG_BODY_HINTS = [
  /instagram/i,
  /security@mail\.instagram\.com/i,
  /verification/i,
];

// CSRF token regex — Laravel's standard <meta name="csrf-token" content="...">
const CSRF_META_REGEX =
  /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i;

const DEFAULT_BASE_URL = "https://tmailgg.site";
const DEFAULT_MAX_AGE_MS = 240_000; // 4 min freshness window
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000; // up to 30s of polling
const DEFAULT_POLL_INTERVAL_MS = 8_000; // wait 8s between polls

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// ─── public types ───────────────────────────────────────────────────────────

export interface FetchOptions {
  /** Base URL. Default: https://tmailgg.site */
  baseUrl?: string;
  /** Max age of an accepted message, in ms. Default: 4 minutes. */
  maxAgeMs?: number;
  /** Total polling budget, in ms. Default: 30 seconds. */
  totalTimeoutMs?: number;
  /** Wait between polls, in ms. Default: 8 seconds. */
  pollIntervalMs?: number;
  /** Fetch implementation override (for tests). */
  fetchImpl?: typeof fetch;
  /** Override "now" for deterministic tests. */
  now?: () => number;
}

interface RawMessage {
  id: string | number;
  // ISO timestamp from the service. Older entries can also be a unix-ms number.
  receivedAt: string | number;
  subject?: string;
  content?: string;
  from?: string;
}

interface SessionState {
  cookie: string;
  csrfToken: string;
}

// ─── exported entrypoint ────────────────────────────────────────────────────

/**
 * Polls a tmailgg.site mailbox for the freshest IG verification code.
 * Returns the 6-digit code or null if nothing usable arrives in time.
 */
export async function fetchLatestIgCode(
  emailAddress: string,
  optsOrMaxAgeMs?: FetchOptions | number,
): Promise<string | null> {
  const opts: FetchOptions =
    typeof optsOrMaxAgeMs === "number"
      ? { maxAgeMs: optsOrMaxAgeMs }
      : optsOrMaxAgeMs ?? {};

  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  const parsed = parseAddress(emailAddress);
  if (!parsed) {
    logger.warn(
      { emailAddress },
      "[tmailgg-fetcher] invalid email address — skipping",
    );
    return null;
  }

  const deadline = now() + totalTimeoutMs;

  // First poll: open session, claim address, fetch inbox, scan.
  let session: SessionState | null = null;

  while (true) {
    try {
      if (!session) {
        session = await openSession(baseUrl, fetchImpl);
        await claimAddress(baseUrl, session, parsed, fetchImpl);
      }
      const messages = await fetchMessages(baseUrl, session, fetchImpl);
      const code = pickFreshIgCode(messages, { maxAgeMs, now });
      if (code) {
        logger.info(
          { emailAddress },
          "[tmailgg-fetcher] resolved IG verification code",
        );
        return code;
      }
    } catch (err) {
      // A transient failure (Cloudflare 522, 5xx, network blip) shouldn't
      // crash the whole login flow — log and let the polling loop retry on
      // a fresh session next iteration.
      logger.warn(
        { emailAddress, err: errMessage(err) },
        "[tmailgg-fetcher] poll failed, will retry",
      );
      session = null;
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;

    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return null;
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function openSession(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<SessionState> {
  const res = await fetchImpl(joinUrl(baseUrl, "/"), {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`tmailgg GET / returned status ${res.status}`);
  }

  const html = await res.text();
  if (/bot verification/i.test(html)) {
    throw new Error("tmailgg captcha challenge — manual intervention needed");
  }

  const csrfMatch = html.match(CSRF_META_REGEX);
  if (!csrfMatch) {
    throw new Error("tmailgg CSRF token not found in landing HTML");
  }

  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = extractCookies(setCookie);
  if (!cookie) {
    throw new Error("tmailgg session cookie missing");
  }

  return { csrfToken: csrfMatch[1], cookie };
}

async function claimAddress(
  baseUrl: string,
  session: SessionState,
  addr: { local: string; domain: string },
  fetchImpl: typeof fetch,
): Promise<void> {
  const body = new URLSearchParams({
    _token: session.csrfToken,
    name: addr.local,
    domain: addr.domain,
  });

  const res = await fetchImpl(joinUrl(baseUrl, "/create"), {
    method: "POST",
    headers: postHeaders(session, baseUrl),
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`tmailgg /create returned status ${res.status}`);
  }
}

async function fetchMessages(
  baseUrl: string,
  session: SessionState,
  fetchImpl: typeof fetch,
): Promise<RawMessage[]> {
  const body = new URLSearchParams({
    _token: session.csrfToken,
    captcha: "",
  });

  const res = await fetchImpl(joinUrl(baseUrl, "/messages"), {
    method: "POST",
    headers: postHeaders(session, baseUrl),
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`tmailgg /messages returned status ${res.status}`);
  }

  const text = await res.text();
  if (!text || text.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("tmailgg /messages returned non-JSON payload");
  }

  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as { messages?: unknown };
  if (!Array.isArray(obj.messages)) return [];

  return obj.messages.filter(isRawMessage);
}

function postHeaders(session: SessionState, baseUrl: string): HeadersInit {
  return {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-TOKEN": session.csrfToken,
    Cookie: session.cookie,
    Origin: baseUrl,
    Referer: joinUrl(baseUrl, "/"),
  };
}

// ─── parsing / matching ─────────────────────────────────────────────────────

function pickFreshIgCode(
  messages: RawMessage[],
  ctx: { maxAgeMs: number; now: () => number },
): string | null {
  const cutoff = ctx.now() - ctx.maxAgeMs;

  // Walk newest-first.
  const ordered = [...messages].sort(
    (a, b) => receivedAtMs(b) - receivedAtMs(a),
  );

  for (const msg of ordered) {
    const ts = receivedAtMs(msg);
    if (Number.isNaN(ts) || ts < cutoff) continue;

    const subject = msg.subject ?? "";
    const content = stripHtml(msg.content ?? "");

    if (!looksLikeIgEmail(subject, content)) continue;

    const haystack = `${subject}\n${content}`;
    const match = haystack.match(CODE_REGEX);
    if (match) return match[1];
  }
  return null;
}

function looksLikeIgEmail(subject: string, body: string): boolean {
  const subjectHit = IG_SUBJECT_HINTS.some((re) => re.test(subject));
  const bodyHit = IG_BODY_HINTS.some((re) => re.test(body));
  return subjectHit || bodyHit;
}

function receivedAtMs(msg: RawMessage): number {
  const r = msg.receivedAt;
  if (typeof r === "number") {
    // Some endpoints return seconds, others ms. Treat anything < 1e12 as s.
    return r < 1e12 ? r * 1000 : r;
  }
  if (typeof r === "string") {
    const t = Date.parse(r);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

function stripHtml(html: string): string {
  // Lightweight scrub — we only care about the textual code, not formatting.
  // cheerio is overkill here and adds startup cost.
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function isRawMessage(value: unknown): value is RawMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.id === undefined) return false;
  if (v.receivedAt === undefined) return false;
  return true;
}

// ─── misc ───────────────────────────────────────────────────────────────────

function parseAddress(
  emailAddress: string,
): { local: string; domain: string } | null {
  if (!emailAddress || typeof emailAddress !== "string") return null;
  const idx = emailAddress.indexOf("@");
  if (idx <= 0 || idx === emailAddress.length - 1) return null;
  const local = emailAddress.slice(0, idx).trim();
  const domain = emailAddress.slice(idx + 1).trim().toLowerCase();
  if (!local || !domain) return null;
  return { local, domain };
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function extractCookies(setCookieHeader: string): string {
  // `set-cookie` may be multiple cookies joined by commas, but commas can also
  // appear inside Expires=…. We split on `, ` followed by a word-then-`=` to
  // be safe-ish — the service only sets a session cookie + XSRF-TOKEN anyway.
  const parts = setCookieHeader.split(/,(?=\s*[\w-]+=)/g);
  return parts
    .map((p) => p.split(";")[0]?.trim())
    .filter((s): s is string => !!s)
    .join("; ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "<unprintable error>";
  }
}

// ─── exposed for tests ──────────────────────────────────────────────────────

export const __test__ = {
  pickFreshIgCode,
  stripHtml,
  parseAddress,
  receivedAtMs,
  looksLikeIgEmail,
  CODE_REGEX,
};
