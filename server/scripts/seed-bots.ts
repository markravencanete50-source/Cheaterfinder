// ─── Seed bot accounts from a local JSON file ───────────────────────────────
//
// Wave 4: idempotent loader for the human-supplied bot fixture at
// /tmp/ig-bots/accounts.json. It encrypts both the IG password and the email
// password before insert, leaves session_data empty (the auto-login worker
// fills it), and removes any stale bots that aren't in the fixture so the
// pool always reflects what we actually own.
//
// Run with:
//   tsx server/scripts/seed-bots.ts
//
// Env required:
//   DATABASE_URL
//   BOT_CRED_KEY (or SESSION_DATA_KEY for dev)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { encryptCredential, validateBotCredKey } from "../crypto/credentials.js";
import { imapHostFor } from "../services/imap-host.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "seed-bots" });

interface FixtureBot {
  ig_username: string;
  ig_password: string;
  email: string;
  email_password: string;
}

interface Fixture {
  bots: FixtureBot[];
}

async function main(): Promise<void> {
  validateBotCredKey();

  const path = process.env.BOT_FIXTURE_PATH ?? "/tmp/ig-bots/accounts.json";
  const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  if (!Array.isArray(fixture.bots) || fixture.bots.length === 0) {
    throw new Error(`[seed-bots] no bots in fixture at ${path}`);
  }

  const wantedUsernames = fixture.bots.map((b) => b.ig_username.toLowerCase());

  // Remove any bot not present in the fixture (e.g. session_expired ghosts).
  // Cascade FKs (bot_follow_requests) are configured to drop with the bot.
  const removed = await db.execute(sql`
    DELETE FROM bot_accounts
    WHERE LOWER(ig_username) NOT IN (${sql.join(
      wantedUsernames.map((u) => sql`${u}`),
      sql`, `,
    )})
    RETURNING ig_username
  `);
  logger.info(
    { removed: (removed as unknown as { rows?: unknown[] }).rows?.length ?? 0 },
    "[seed-bots] removed stale bot rows",
  );

  for (const bot of fixture.bots) {
    const igPassword = encryptCredential(bot.ig_password);
    const emailPassword = encryptCredential(bot.email_password);

    await db.execute(sql`
      INSERT INTO bot_accounts (
        ig_username,
        session_data,
        ig_password_encrypted,
        email_address,
        email_password_encrypted,
        imap_host,
        imap_port,
        status
      ) VALUES (
        ${bot.ig_username},
        NULL,
        ${igPassword},
        ${bot.email},
        ${emailPassword},
        ${imapHostFor(bot.email)},
        993,
        'available'
      )
      ON CONFLICT (ig_username) DO UPDATE SET
        ig_password_encrypted = EXCLUDED.ig_password_encrypted,
        email_address = EXCLUDED.email_address,
        email_password_encrypted = EXCLUDED.email_password_encrypted,
        imap_host = EXCLUDED.imap_host,
        imap_port = EXCLUDED.imap_port,
        updated_at = NOW()
    `);
    logger.info(
      { username: bot.ig_username },
      "[seed-bots] upserted bot",
    );
  }

  const final = await db.execute(sql`
    SELECT ig_username, status, email_address
    FROM bot_accounts
    ORDER BY ig_username
  `);
  logger.info(
    { rows: (final as unknown as { rows?: unknown[] }).rows },
    "[seed-bots] seed complete",
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, "[seed-bots] FAILED");
    process.exit(1);
  },
);
