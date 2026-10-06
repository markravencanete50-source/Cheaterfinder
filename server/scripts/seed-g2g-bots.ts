// Seed G2G-format bot accounts from CSV pasted on stdin.
//
// This path is for TOTP-first accounts where the Instagram login identifier is
// the email address and no usable mailbox password is available. Plaintext
// credentials are not written to disk; passwords are encrypted before DB write.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import {
  encryptCredential,
  validateBotCredKey,
} from "../crypto/credentials.js";

interface G2GBot {
  seat: number;
  email: string;
  password: string;
  totpSecret: string;
}

function tierForSeat(seat: number): "canary" | "worker" | "reserve" {
  if (seat <= 2) return "canary";
  if (seat <= 30) return "worker";
  return "reserve";
}

function parseG2G(raw: string): G2GBot[] {
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toLowerCase().startsWith("g2g code id,"));

  const bots: G2GBot[] = [];
  for (const line of rows) {
    const cols = line.split(",");
    const email = (cols[1] ?? "").replace(/^'+/, "").trim().toLowerCase();
    const password = (cols[3] ?? "").trim();
    const authMarker = (cols[5] ?? "").trim().toLowerCase();
    const totpSecret = (cols[6] ?? "").replace(/\s+/g, "").trim().toUpperCase();

    if (!email || !email.includes("@")) {
      throw new Error(`row ${bots.length + 1}: missing email`);
    }
    if (!password) {
      throw new Error(`row ${bots.length + 1}: missing password for ${email}`);
    }
    if (authMarker !== "2fa" || !totpSecret) {
      throw new Error(`row ${bots.length + 1}: missing TOTP secret for ${email}`);
    }

    bots.push({
      seat: bots.length + 1,
      email,
      password,
      totpSecret,
    });
  }

  const seen = new Set<string>();
  for (const bot of bots) {
    if (seen.has(bot.email)) throw new Error(`duplicate email ${bot.email}`);
    seen.add(bot.email);
  }

  return bots;
}

async function main(): Promise<void> {
  validateBotCredKey();
  const raw = readFileSync(0, "utf8");
  const bots = parseG2G(raw);
  if (bots.length === 0) throw new Error("no G2G rows found on stdin");

  let upserted = 0;
  for (const bot of bots) {
    const tier = tierForSeat(bot.seat);
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
        ${bot.email},
        NULL,
        ${encryptCredential(bot.password)},
        ${bot.email},
        NULL,
        NULL,
        NULL,
        ${bot.totpSecret},
        ${tier}::bot_tier,
        'available',
        NULL,
        NULL,
        NOW(),
        NOW()
      )
      ON CONFLICT (ig_username) DO UPDATE SET
        ig_password_encrypted = EXCLUDED.ig_password_encrypted,
        email_address = EXCLUDED.email_address,
        email_password_encrypted = NULL,
        imap_host = NULL,
        imap_port = NULL,
        totp_secret = EXCLUDED.totp_secret,
        tier = EXCLUDED.tier,
        status = 'available',
        cooldown_until = NULL,
        last_login_error = NULL,
        updated_at = NOW()
    `);
    upserted += 1;
  }

  const counts = bots.reduce<Record<string, number>>((acc, bot) => {
    const tier = tierForSeat(bot.seat);
    acc[tier] = (acc[tier] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `[seed-g2g-bots] upserted=${upserted} canary=${counts.canary ?? 0} worker=${counts.worker ?? 0} reserve=${counts.reserve ?? 0}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
