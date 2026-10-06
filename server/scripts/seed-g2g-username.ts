// Seed G2G-format bot accounts (username-login variant) from CSV on stdin.
//
// This is for the G2G export where the Instagram login identifier is the
// USERNAME (no email / no mailbox) and 2FA is a TOTP authenticator secret.
// Column layout (0-indexed) of a data row:
//   [0] G2G Code ID   [1] username (may be quoted with a leading ')
//   [3] password      [5] TOTP secret (base32, space-grouped)
//
// Differs from seed-g2g-bots.ts (which expects an email login identifier in
// col[1], a "2fa" marker in col[5], and the TOTP in col[6]).
//
// Plaintext credentials are never written to disk; passwords are encrypted with
// the same BOT_CRED_KEY the runtime uses before the DB write. Idempotent UPSERT
// on ig_username; NEVER deletes existing rows. Freshly seeded bots are parked in
// the 'reserve' tier with no session — a separate login pass fills session_data.

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
  totpSecret: string;
}

const BASE32 = /^[A-Z2-7]+$/;

function parse(raw: string): G2GBot[] {
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toLowerCase().startsWith("g2g code id,"));

  const bots: G2GBot[] = [];
  for (const line of rows) {
    const cols = line.split(",");
    const username = (cols[1] ?? "").replace(/^'+/, "").trim().toLowerCase();
    const password = (cols[3] ?? "").trim();
    const totpSecret = (cols[5] ?? "").replace(/\s+/g, "").trim().toUpperCase();

    const n = bots.length + 1;
    if (!username) throw new Error(`row ${n}: missing username`);
    if (username.includes("@")) {
      throw new Error(`row ${n}: ${username} looks like an email — use seed-g2g-bots.ts`);
    }
    if (!password) throw new Error(`row ${n}: missing password for ${username}`);
    if (!BASE32.test(totpSecret) || totpSecret.length < 16) {
      throw new Error(`row ${n}: invalid TOTP secret for ${username}`);
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
        email_address = NULL,
        email_password_encrypted = NULL,
        imap_host = NULL,
        imap_port = NULL,
        totp_secret = EXCLUDED.totp_secret,
        status = 'available',
        cooldown_until = NULL,
        last_login_error = NULL,
        updated_at = NOW()
    `);
    upserted += 1;
  }

  console.log(`[seed-g2g-username] upserted=${upserted} (tier=reserve, session=NULL)`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
