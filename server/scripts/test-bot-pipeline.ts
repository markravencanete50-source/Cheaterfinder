// ─── Smoke test: encryption + proxy + IMAP for seeded bots ──────────────────
//
// Sanity-check the pieces of the auto-login pipeline that don't require IG
// itself: credential round-trip, proxy provider returning live endpoints, and
// each bot's mailbox accepting our IMAP creds.

import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { decryptCredential, validateBotCredKey } from "../crypto/credentials.js";
import { fetchHealthyEndpoints } from "../services/proxy-provider.js";
import { pingImap } from "../services/imap-code-fetcher.js";

interface BotRow {
  ig_username: string;
  email_address: string;
  email_password_encrypted: string;
  imap_host: string;
  imap_port: number;
}

async function main(): Promise<void> {
  validateBotCredKey();
  console.log("== Pipeline smoke test ==");

  // 1. Encrypted creds round-trip — read first bot and ensure decrypt works.
  const result = (await db.execute(sql`
    SELECT ig_username, email_address, email_password_encrypted, imap_host, imap_port
    FROM bot_accounts
    ORDER BY ig_username
  `)) as unknown as { rows: BotRow[] };
  const bots = result.rows;
  if (bots.length === 0) {
    throw new Error("no bots seeded");
  }
  for (const b of bots) {
    const decrypted = decryptCredential(b.email_password_encrypted);
    console.log(
      `  ✓ decrypt OK for ${b.ig_username} (${decrypted.length} chars)`,
    );
  }

  // 2. Proxy provider — request 3 healthy endpoints (auto-probes & filters).
  console.log("\n== proxy provider ==");
  const healthy = await fetchHealthyEndpoints(3, { country: "US" });
  for (const ep of healthy) {
    console.log(`  ✓ ${ep.endpoint} (sticky until ${ep.expiresAt.toISOString()})`);
  }

  // 3. IMAP — ping each mailbox.
  console.log("\n== imap mailboxes ==");
  for (const b of bots) {
    const password = decryptCredential(b.email_password_encrypted);
    try {
      const messages = await pingImap({
        host: b.imap_host,
        port: b.imap_port,
        user: b.email_address,
        password,
      });
      console.log(`  ✓ ${b.email_address} (${messages} msgs)`);
    } catch (err) {
      console.error(
        `  ✗ ${b.email_address}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  console.log("\n== done ==");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
