// Verify (and optionally repair) stored bot credentials against a source roster.
//
// The 2026-08-06 G2G batch shipped with a column layout that differs from the
// header: the real password sits in the "Mobile Number" column (col2) and the
// TOTP secret in the "Password" column (col3). seed-g2g-username-v2.ts trusts
// the header, so any row seeded by it stores the TOTP string as the password
// and IG rejects every login attempt.
//
// This script decrypts what is actually stored and diffs it against a
// tab-separated roster (username <TAB> password <TAB> totp), reporting every
// mismatch. With --fix it re-encrypts the correct password and TOTP in place.
// Read-only by default so a bad roster can never silently clobber the pool.
//
//   npx tsx server/scripts/verify-fix-g2g-creds.ts <roster.tsv> [--fix]

import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import {
  decryptCredential,
  encryptCredential,
  validateBotCredKey,
} from "../crypto/credentials.js";

interface RosterEntry {
  username: string;
  password: string;
  totpRaw: string;
}

const BASE32 = /^[A-Z2-7]+$/;

/**
 * Normalize a seller-supplied 2FA key to the RFC 4648 base32 alphabet.
 * Sellers transcribe secrets with visually ambiguous glyphs; 0/1/8/9 are not
 * valid base32, so map them to the letters they are routinely confused with.
 */
function normalizeTotp(raw: string): string | null {
  const candidate = (raw ?? "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "L")
    .replace(/8/g, "B")
    .replace(/9/g, "G");
  if (!BASE32.test(candidate) || candidate.length < 16) return null;
  return candidate;
}

function parseRoster(path: string): RosterEntry[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [username, password, totpRaw] = line.split("\t");
      if (!username || !password) {
        throw new Error(`[verify-creds] malformed roster line: ${line}`);
      }
      return {
        username: username.replace(/^'+/, "").trim().toLowerCase(),
        password: password.trim(),
        totpRaw: (totpRaw ?? "").trim(),
      };
    });
}

interface StoredRow {
  ig_username: string;
  ig_password_encrypted: string | null;
  totp_secret: string | null;
}

function safeDecrypt(envelope: string | null): string | null {
  if (!envelope) return null;
  try {
    return decryptCredential(envelope);
  } catch (err) {
    return `<DECRYPT_FAILED: ${(err as Error).message}>`;
  }
}

async function main(): Promise<void> {
  validateBotCredKey();

  const rosterPath = process.argv[2];
  if (!rosterPath) throw new Error("usage: verify-fix-g2g-creds.ts <roster.tsv> [--fix]");
  const applyFix = process.argv.includes("--fix");

  const roster = parseRoster(rosterPath);
  console.log(`[verify-creds] roster=${roster.length} mode=${applyFix ? "FIX" : "dry-run"}`);

  const result = (await db.execute(sql`
    SELECT ig_username, ig_password_encrypted, totp_secret
    FROM bot_accounts
    WHERE lower(ig_username) IN (${sql.join(
      roster.map((r) => sql`${r.username}`),
      sql`, `,
    )})
  `)) as unknown as { rows: StoredRow[] };

  const stored = new Map(
    result.rows.map((r) => [r.ig_username.toLowerCase(), r]),
  );

  const missing: string[] = [];
  const pwMismatch: string[] = [];
  const totpMismatch: string[] = [];
  const unusableTotp: string[] = [];
  let okCount = 0;

  for (const entry of roster) {
    const row = stored.get(entry.username);
    if (!row) {
      missing.push(entry.username);
      continue;
    }

    const expectedTotp = normalizeTotp(entry.totpRaw);
    if (entry.totpRaw && !expectedTotp) unusableTotp.push(entry.username);

    const actualPw = safeDecrypt(row.ig_password_encrypted);
    const pwWrong = actualPw !== entry.password;
    const totpWrong = (row.totp_secret ?? null) !== expectedTotp;

    if (pwWrong) pwMismatch.push(entry.username);
    if (totpWrong) totpMismatch.push(entry.username);
    if (!pwWrong && !totpWrong) {
      okCount += 1;
      continue;
    }

    console.log(
      `[verify-creds] MISMATCH @${entry.username}` +
        (pwWrong ? ` pw(stored=${JSON.stringify(actualPw)} expected=${JSON.stringify(entry.password)})` : "") +
        (totpWrong ? ` totp(stored=${row.totp_secret ?? "null"} expected=${expectedTotp ?? "null"})` : ""),
    );

    if (applyFix) {
      await db.execute(sql`
        UPDATE bot_accounts
        SET ig_password_encrypted = ${encryptCredential(entry.password)},
            totp_secret = ${expectedTotp},
            login_attempt_count = 0,
            last_login_error = NULL,
            status = CASE WHEN status = 'session_expired' THEN 'available'::bot_status ELSE status END,
            updated_at = now()
        WHERE lower(ig_username) = ${entry.username}
      `);
      console.log(`[verify-creds] repaired @${entry.username}`);
    }
  }

  console.log(
    `\n[verify-creds] summary: ok=${okCount} pwMismatch=${pwMismatch.length} ` +
      `totpMismatch=${totpMismatch.length} notInDb=${missing.length} unusableTotp=${unusableTotp.length}`,
  );
  if (pwMismatch.length) console.log(`[verify-creds] password wrong: ${pwMismatch.join(", ")}`);
  if (missing.length) console.log(`[verify-creds] not in DB: ${missing.join(", ")}`);
  if (unusableTotp.length) console.log(`[verify-creds] TOTP not base32: ${unusableTotp.join(", ")}`);
  if (!applyFix && (pwMismatch.length || totpMismatch.length)) {
    console.log(`[verify-creds] re-run with --fix to repair`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
