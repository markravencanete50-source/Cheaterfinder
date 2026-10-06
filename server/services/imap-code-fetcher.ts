// ─── IMAP IG verification-code fetcher ──────────────────────────────────────
//
// Wave 4: when a bot logs in from a fresh proxy IP, IG often gates the flow
// behind a 6-digit "security code" sent to the bot's registered email. The
// auto-login flow needs to read that code without a human in the loop.
//
// Strategy:
//   1. Open IMAP over TLS to the bot's mailbox.
//   2. Open INBOX.
//   3. Search for unseen messages from `*@mail.instagram.com` newer than
//      the moment login was triggered.
//   4. If none, IDLE (or short-poll fallback) until a new message arrives or
//      we hit `timeoutMs`.
//   5. Parse the body, pull the 6-digit code, mark the message seen, return.
//
// We never delete the email — the audit trail matters if a human needs to
// debug a flow later. Marking it seen is enough to avoid re-using the same
// code on a later login attempt.
// ─────────────────────────────────────────────────────────────────────────────

import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "imap-code-fetcher" });

const IG_FROM_PATTERNS = [
  /@mail\.instagram\.com$/i,
  /@instagram\.com$/i,
  /@facebookmail\.com$/i,
];

const CODE_REGEX = /\b(\d{6})\b/;

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface FetchCodeOptions {
  /** Only consider emails received at or after this instant. */
  since: Date;
  /** Total wall-clock budget for the wait, in ms. Default: 90s. */
  timeoutMs?: number;
  /** Poll interval between fetches when IDLE is unavailable. Default: 5s. */
  pollIntervalMs?: number;
}

function isFromInstagram(from: string | undefined): boolean {
  if (!from) return false;
  return IG_FROM_PATTERNS.some((re) => re.test(from));
}

/**
 * Connect, search, optionally wait, and return the 6-digit code IG sent.
 * Throws if no matching email arrives within the timeout.
 */
export async function fetchInstagramCode(
  creds: ImapCredentials,
  opts: FetchCodeOptions,
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true,
    auth: { user: creds.user, pass: creds.password },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      while (Date.now() < deadline) {
        const code = await tryReadCode(client, opts.since);
        if (code) return code;
        await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      /* swallow — connection cleanup */
    });
  }

  throw new Error(
    `[imap-code-fetcher] no IG verification code received in ${Math.round(
      timeoutMs / 1000,
    )}s`,
  );
}

async function tryReadCode(
  client: ImapFlow,
  since: Date,
): Promise<string | null> {
  // Search server-side for newish messages — keeps payloads small and we
  // don't have to walk the whole inbox.
  const sequence = await client.search({ since });
  if (!sequence || sequence.length === 0) return null;

  // Walk newest-first. ImapFlow returns ascending UIDs.
  const ordered = [...sequence].sort((a, b) => b - a);

  for (const seq of ordered) {
    const message = (await client.fetchOne(seq, {
      source: true,
      envelope: true,
    })) as FetchMessageObject | undefined;
    if (!message?.source) continue;
    const fromAddress = message.envelope?.from?.[0]?.address;
    if (!isFromInstagram(fromAddress)) continue;

    const parsed = await simpleParser(message.source);
    const haystack = `${parsed.subject ?? ""}\n${parsed.text ?? ""}`;
    const match = haystack.match(CODE_REGEX);
    if (!match) continue;

    // Mark seen so a later login attempt doesn't re-grab a stale code.
    await client.messageFlagsAdd(seq, ["\\Seen"]).catch(() => {
      /* non-fatal — we already have the code */
    });
    logger.info(
      { from: fromAddress, subject: parsed.subject },
      "[imap-code-fetcher] resolved IG verification code",
    );
    return match[1];
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

/**
 * Light connectivity probe — used by ops scripts to verify mailbox creds
 * before we ever try to log a bot in.
 */
export async function pingImap(creds: ImapCredentials): Promise<number> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true,
    auth: { user: creds.user, pass: creds.password },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = await client.status("INBOX", { messages: true });
      return status.messages ?? 0;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}
