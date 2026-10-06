// Import a small, explicitly supplied Instagram test pool whose rows are:
//
//   username <whitespace> password <whitespace> Base32 TOTP secret
//
// Credentials are read from a caller-provided file, encrypted before storage,
// and never printed. Imported accounts are intentionally left
// `session_expired` + `reserve`: an operator must migrate/login one by one
// before any can be used.
//
// Usage:
//   npx tsx server/scripts/import-totp-bots.ts --input /secure/path/bots.tsv
//   npx tsx server/scripts/import-totp-bots.ts --input /secure/path/bots.tsv --dry-run
//   npx tsx server/scripts/import-totp-bots.ts --stdin
//
// `--stdin` is intended for operator tooling that can stream credentials
// without putting them in argv or a temporary plaintext file. The stream ends
// with a line containing only `__CHEATERFINDER_CREDENTIALS_END__`; this avoids
// requiring the caller to close a shared process pipe.

import "dotenv/config";

import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import {
  encryptCredential,
  validateBotCredKey,
} from "../crypto/credentials.js";

export interface TotpBotInput {
  username: string;
  password: string;
  totpSecret: string;
}

function inputPathArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--input");
  const path = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (!path) {
    throw new Error("usage: --input <credential-file> [--dry-run]");
  }
  return path;
}

const STDIN_SENTINEL = "__CHEATERFINDER_CREDENTIALS_END__";

async function readCredentialInputFromStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let contents = "";

    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("error", onError);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
    };
    const finish = (): void => {
      cleanup();
      resolve(contents);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => finish();
    const onData = (chunk: string): void => {
      contents += chunk;
      const lines = contents.split(/\r?\n/);
      const sentinelIndex = lines.findIndex((line) => line === STDIN_SENTINEL);
      if (sentinelIndex < 0) return;
      contents = lines.slice(0, sentinelIndex).join("\n");
      finish();
    };

    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
    process.stdin.on("end", onEnd);
  });
}

/** Parse credentials without ever embedding or logging their values. */
export function parseTotpBotInput(contents: string): TotpBotInput[] {
  const seen = new Set<string>();
  const bots: TotpBotInput[] = [];

  for (const [offset, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const fields = line.split(/\s+/);
    if (fields.length < 3) {
      throw new Error(`line ${offset + 1}: expected username, password, and TOTP secret`);
    }
    const [username, password, ...secretParts] = fields;
    const normalizedUsername = username.toLowerCase();
    const totpSecret = secretParts.join("").toUpperCase();

    if (!/^[A-Za-z0-9._]+$/.test(username)) {
      throw new Error(`line ${offset + 1}: invalid Instagram username`);
    }
    if (!password) {
      throw new Error(`line ${offset + 1}: password is empty`);
    }
    // RFC 4648 Base32, with whitespace stripped above. A shorter string cannot
    // represent a normal TOTP seed and is almost certainly a malformed row.
    if (!/^[A-Z2-7]+=*$/.test(totpSecret) || totpSecret.replace(/=/g, "").length < 16) {
      throw new Error(`line ${offset + 1}: invalid Base32 TOTP secret`);
    }
    if (seen.has(normalizedUsername)) {
      throw new Error(`line ${offset + 1}: duplicate username in input`);
    }
    seen.add(normalizedUsername);
    bots.push({ username, password, totpSecret });
  }

  if (bots.length === 0) {
    throw new Error("credential file contains no bot rows");
  }
  return bots;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const stdin = argv.includes("--stdin");
  if (stdin && argv.includes("--input")) {
    throw new Error("choose exactly one of --stdin or --input <credential-file>");
  }
  const contents = stdin
    ? await readCredentialInputFromStdin()
    : readFileSync(inputPathArgument(argv), "utf8");
  const bots = parseTotpBotInput(contents);

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, botCount: bots.length }));
    return;
  }

  validateBotCredKey();
  for (const bot of bots) {
    const encryptedPassword = encryptCredential(bot.password);
    await db.execute(sql`
      INSERT INTO bot_accounts (
        ig_username,
        ig_password_encrypted,
        totp_secret,
        session_data,
        automation_identity,
        status,
        tier,
        role,
        locale,
        timezone,
        last_login_error,
        login_attempt_count,
        updated_at
      ) VALUES (
        ${bot.username},
        ${encryptedPassword},
        ${encryptCredential(bot.totpSecret)},
        NULL,
        NULL,
        'session_expired',
        'reserve',
        'scraper',
        'en-US',
        'America/New_York',
        NULL,
        0,
        NOW()
      )
      ON CONFLICT (ig_username) DO UPDATE SET
        ig_password_encrypted = EXCLUDED.ig_password_encrypted,
        totp_secret = EXCLUDED.totp_secret,
        session_data = NULL,
        automation_identity = NULL,
        status = 'session_expired',
        tier = 'reserve',
        role = 'scraper',
        last_login_error = NULL,
        login_attempt_count = 0,
        updated_at = NOW()
    `);
  }

  console.log(JSON.stringify({ ok: true, imported: bots.length, status: "session_expired", tier: "reserve" }));
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
