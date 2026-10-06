// Migrate one bot from the legacy TS Playwright/Undici stack to the local
// FastAPI Firefox stack.  This is intentionally one-bot-at-a-time: a browser
// identity/session cutover should be verified on a real account before a pool
// rollout, and it must not cause the worker to re-login every available bot.
//
// Usage:
//   npx tsx server/scripts/migrate-bot-to-automation.ts --username example_bot
//
// Required env: DATABASE_URL, AUTOMATION_API_TOKEN

import "dotenv/config";

import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { createAutomationClient } from "../services/automation-client.js";
import { parseAutomationIdentity } from "../services/automation-identity.js";
import { ensureBotReady } from "../services/bot-runtime.js";

interface BotRow {
  id: string;
  ig_username: string;
  locale: string | null;
  timezone: string | null;
  automation_identity: unknown;
}

function usernameArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--username");
  const username = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (!username) {
    throw new Error("usage: --username <instagram username>");
  }
  return username.replace(/^@/, "");
}

async function main(): Promise<void> {
  const username = usernameArgument(process.argv.slice(2));
  const result = (await db.execute(sql`
    SELECT id, ig_username, locale, timezone, automation_identity
    FROM bot_accounts
    WHERE LOWER(ig_username) = LOWER(${username})
    LIMIT 1
  `)) as unknown as { rows: BotRow[] };
  const bot = result.rows[0];
  if (!bot) throw new Error(`bot @${username} was not found`);

  const automation = createAutomationClient({ timeoutMs: 10_000 });
  const current = parseAutomationIdentity(bot.automation_identity, bot.id);
  const identity = current ?? await automation.createIdentity({
    bot_id: bot.id,
    locale: bot.locale ?? "en-US",
    timezone: bot.timezone ?? "America/New_York",
  });

  // This session was made by legacy Chromium.  Clearing it here is deliberate:
  // ensureBotReady will drive a fresh Firefox login through FastAPI and store
  // only the resulting storage state.  The caller must run this while broad
  // workers are paused, so no unrelated job can race the cutover.
  await db.execute(sql`
    UPDATE bot_accounts SET
      automation_identity = ${JSON.stringify(identity)}::jsonb,
      session_data = NULL,
      status = 'session_expired',
      last_login_error = NULL,
      updated_at = NOW()
    WHERE id = ${bot.id}
  `);

  const ready = await ensureBotReady(bot.id);
  if (!ready.automationIdentity) {
    throw new Error("automation identity was not returned after cutover");
  }
  console.log(
    JSON.stringify({
      ok: true,
      botId: ready.botId,
      username: ready.igUsername,
      transport: "fastapi-firefox",
      identityVersion: ready.automationIdentity.identity_version,
    }),
  );
}

// Keep the CLI attached until the local FastAPI round-trip (which may include
// an email-code wait) has settled. A bare top-level await can be abandoned by
// short-lived TS runners once the PostgreSQL query queue goes idle.
const keepAlive = setInterval(() => undefined, 1_000);
void main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    clearInterval(keepAlive);
    await pool.end().catch(() => undefined);
  });
