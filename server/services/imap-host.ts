// ─── IMAP host resolution ────────────────────────────────────────────────────
//
// Wave 5 task B: bots are seeded both from a shell script (server/scripts/
// seed-bots.ts) and from the new admin self-serve endpoint
// (POST /api/admin/bots/seed). Both code paths need to derive an IMAP host
// from the bot's email address so the worker can later poll the inbox for
// 6-digit IG verification codes.
//
// Centralizing the lookup here keeps the two call sites in lockstep — if we
// add a new provider mapping, both seed paths pick it up immediately.
// ─────────────────────────────────────────────────────────────────────────────

const IMAP_HOST_BY_DOMAIN: Readonly<Record<string, string>> = Object.freeze({
  "rambler.ru": "imap.rambler.ru",
  "gmail.com": "imap.gmail.com",
  "outlook.com": "outlook.office365.com",
  "hotmail.com": "outlook.office365.com",
  "yandex.ru": "imap.yandex.ru",
  "mail.ru": "imap.mail.ru",
});

/**
 * Map an email address to the IMAP host that serves its mailbox. Falls back
 * to `imap.<domain>` when the provider isn't in our explicit table — works
 * for most niche providers (e.g. cock.li → imap.cock.li) and is fine because
 * the worker validates the connection before trusting it.
 */
export function imapHostFor(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (domain.length === 0) {
    throw new Error(`[imap-host] cannot derive host from email "${email}"`);
  }
  const known = IMAP_HOST_BY_DOMAIN[domain];
  if (known) return known;
  return `imap.${domain}`;
}
