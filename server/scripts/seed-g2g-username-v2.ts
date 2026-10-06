// Seed G2G-format bot accounts (username-login variants).
//
// Handles the G2G export where the Instagram username is col[1] and the
// password is col[3], plus older variants that carry a genuine Base32 TOTP
// secret in later columns. Do not infer a password from the generic "Mobile
// Number" column: account sellers may put opaque data there, but the provided
// G2G header explicitly marks col[3] as Password.
// That layout differs from BOTH existing seeders:
//   - seed-g2g-username.ts expects the TOTP at col[5]
//   - seed-g2g-bots.ts expects an EMAIL login id at col[1]
//
// Rather than hard-code a column index, we auto-detect the TOTP as the first
// space-stripped base32 token (>=16 chars) found among the trailing columns,
// which makes this robust to small column shifts between batches.
//
// The disposable email (col[5]) is intentionally NOT stored: it has no mailbox
// password, so the IMAP email-code login path can't use it. Leaving
// email_address NULL forces the login driver down the username+TOTP path.
//
// Plaintext credentials never touch disk; passwords are encrypted with the same
// BOT_CRED_KEY the runtime uses. Idempotent UPSERT on ig_username; NEVER deletes
// existing rows. Freshly seeded bots park in the 'reserve' tier with no session
// — a separate login pass (login-bots-by-username.ts) fills session_data.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import {
  encryptCredential,
  validateBotCredKey,
} from "../crypto/credentials.js";

interface G2GBot {
  username: string;
  password: string;
  totpSecret: string | null;
}

const BASE32 = /^[A-Z2-7]+$/;

function normalizeTotp(raw: string): string {
  return (raw ?? "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "L")
    .replace(/8/g, "B")
    .replace(/9/g, "G");
}

/** Find the TOTP secret among trailing columns (auto-detect, not hard-coded). */
function findTotp(cols: readonly string[]): string | null {
  // Scan likely columns; the secret is the only base32-shaped token here.
  for (let i = 4; i < Math.min(cols.length, 9); i += 1) {
    const candidate = normalizeTotp(cols[i] ?? "");
    if (BASE32.test(candidate) && candidate.length >= 16) return candidate;
  }
  return null;
}

/**
 * Extract (username, password, totpSecret) from a row in either supported
 * format:
 *   - CSV (G2G export): username@col1, password@col3, TOTP auto-detected.
 *   - Whitespace: "username  password  TOTP(space-grouped base32)" — fields
 *     separated by a tab or 2+ spaces; the TOTP's internal single spaces are
 *     preserved. No email column in this variant.
 */
function extractFields(line: string): {
  username: string;
  password: string;
  totpSecret: string | null;
} {
  if (line.includes(",")) {
    const cols = line.split(",");
    return {
      username: (cols[1] ?? "").replace(/^'+/, "").trim().toLowerCase(),
      password: (cols[3] ?? "").trim(),
      totpSecret: findTotp(cols),
    };
  }
  const parts = line.split(/\t+| {2,}/).map((s) => s.trim()).filter(Boolean);
  const totp = normalizeTotp(parts.slice(2).join(" "));
  return {
    username: (parts[0] ?? "").replace(/^'+/, "").trim().toLowerCase(),
    password: (parts[1] ?? "").trim(),
    totpSecret: BASE32.test(totp) && totp.length >= 16 ? totp : null,
  };
}

function parse(raw: string): G2GBot[] {
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toLowerCase().startsWith("g2g code id,"));

  const bots: G2GBot[] = [];
  for (const line of rows) {
    const { username, password, totpSecret } = extractFields(line);

    const n = bots.length + 1;
    if (!username) throw new Error(`row ${n}: missing username`);
    if (username.includes("@")) {
      throw new Error(`row ${n}: ${username} looks like an email — use seed-g2g-bots.ts`);
    }
    if (!password) throw new Error(`row ${n}: missing password for ${username}`);
    if (!totpSecret) {
      // No 2FA secret in the row — seed anyway with NULL totp_secret. Such an
      // account either has no 2FA (username+password login works) or will fail
      // at login if IG demands a code; either way, don't abort the whole batch.
      console.warn(`[seed-g2g-username-v2] row ${n}: no TOTP — seeding with NULL totp_secret`);
    }
    bots.push({ username, password, totpSecret });
  }

  const seen = new Set<string>();
  for (const bot of bots) {
    if (seen.has(bot.username)) throw new Error(`duplicate username ${bot.username}`);
    seen.add(bot.username);
  }
  return bots;
}

async function main(): Promise<void> {
  validateBotCredKey();
  const raw = readFileSync(0, "utf8");
  const bots = parse(raw);
  if (bots.length === 0) throw new Error("no G2G rows found on stdin");

  let upserted = 0;
  for (const bot of bots) {
    await db.execute(sql`
      INSERT INTO bot_accounts (
        ig_username,
        session_data,
        ig_password_encrypted,
        email_address,
        email_password_encrypted,
        imap_host,
        imap_port,
        totp_secret,
        tier,
        status,
        cooldown_until,
        last_login_error,
        created_at,
        updated_at
      ) VALUES (
        ${bot.username},
        NULL,
        ${encryptCredential(bot.password)},
        NULL,
        NULL,
        NULL,
        NULL,
        ${bot.totpSecret},
        'reserve'::bot_tier,
        'available',
        NULL,
        NULL,
        NOW(),
        NOW()
      )
      ON CONFLICT (ig_username) DO UPDATE SET
        ig_password_encrypted = EXCLUDED.ig_password_encrypted,
        totp_secret = EXCLUDED.totp_secret,
        status = 'available',
        cooldown_until = NULL,
        last_login_error = NULL,
        updated_at = NOW()
    `);
    upserted += 1;
  }

  console.log(`[seed-g2g-username-v2] upserted=${upserted} (tier=reserve, session=NULL)`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
