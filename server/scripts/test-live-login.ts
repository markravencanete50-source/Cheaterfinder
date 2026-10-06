// ─── Live IG login: end-to-end pipeline test ────────────────────────────────
//
// Picks one bot from bot_accounts (default: --username gennadijkonovalovvo3452,
// otherwise the first row), grabs a fresh sticky proxy, drives the Playwright
// login, handles the email-code challenge if IG triggers it, and persists the
// resulting storageState back into bot_accounts.session_data (envelope-encrypted).
//
// Run with:
//   npx tsx --env-file=.env server/scripts/test-live-login.ts
//   npx tsx --env-file=.env server/scripts/test-live-login.ts --username borispopovbc4566

import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { validateBotCredKey } from "../crypto/credentials.js";
import { ensureBotReady } from "../services/bot-runtime.js";

interface BotRow {
  id: string;
  ig_username: string;
  ig_password_encrypted: string;
  email_address: string;
  email_password_encrypted: string;
  imap_host: string;
  imap_port: number;
}

function parseUsername(): string | null {
  const idx = process.argv.indexOf("--username");
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function main(): Promise<void> {
  validateBotCredKey();

  const targetUsername = parseUsername();
  const queryWhere = targetUsername
    ? sql`WHERE LOWER(ig_username) = LOWER(${targetUsername})`
    : sql`WHERE ig_password_encrypted IS NOT NULL ORDER BY ig_username LIMIT 1`;

  const result = (await db.execute(sql`
    SELECT id, ig_username, ig_password_encrypted, email_address,
           email_password_encrypted, imap_host, imap_port
    FROM bot_accounts
    ${queryWhere}
  `)) as unknown as { rows: BotRow[] };

  const bot = result.rows[0];
  if (!bot) {
    throw new Error(
      `[test-live-login] no bot found ${targetUsername ? `for ${targetUsername}` : ""}`,
    );
  }
  console.log(`== logging in ${bot.ig_username} ==`);

  // Wave 5: drive the production path. ensureBotReady() handles proxy
  // refresh + auto-login (with retry, fresh proxy on each attempt) and
  // persists encrypted session_data back to the row.
  const t0 = Date.now();
  const ctx = await ensureBotReady(bot.id);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   ✓ ready in ${elapsed}s (proxy=${ctx.proxyEndpoint})`);
  console.log(`   ✓ session_data length = ${ctx.sessionData.length} chars`);
  console.log("\n== done ==");
}

main().then(
  () => process.exit(0),
  async (err) => {
    console.error("FAILED:", err instanceof Error ? err.message : err);
    // Best-effort error breadcrumb on the row.
    try {
      const targetUsername = parseUsername();
      if (targetUsername) {
        await db.execute(sql`
          UPDATE bot_accounts SET
            last_login_error = ${String(err instanceof Error ? err.message : err).slice(0, 500)},
            login_attempt_count = login_attempt_count + 1
          WHERE LOWER(ig_username) = LOWER(${targetUsername})
        `);
      }
    } catch {
      /* ignore */
    }
    process.exit(1);
  },
);
