// Drive the normal ensureBotReady() login path for a specific set of bots,
// identified by username on argv (or newline-separated on stdin if no args).
//
// Unlike recover-missing-sessions.ts (which selects ALL available missing-
// session bots by criteria), this is scoped to an explicit username list so a
// freshly-seeded batch can be logged in without touching unrelated pool rows.
// Sequential (concurrency 1) to avoid hammering the proxy / IG login surface.
//
//   npx tsx server/scripts/login-bots-by-username.ts user1 user2 ...
//   printf 'user1\nuser2\n' | npx tsx server/scripts/login-bots-by-username.ts
//   ... --delay-ms=45000   # pause between logins (default 45s, jitter added)

import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { proxyEndpointLabel } from "../services/proxy-provider.js";

function readUsernames(): string[] {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (args.length > 0) return args.map((u) => u.replace(/^'+/, "").trim().toLowerCase());
  // Fallback: newline-separated on stdin.
  const raw = readFileSync(0, "utf8");
  return raw
    .split(/\r?\n/)
    .map((u) => u.replace(/^'+/, "").trim().toLowerCase())
    .filter(Boolean);
}

interface BotRow {
  id: string;
  ig_username: string;
  tier: string;
  has_session: boolean;
}

/** Base pause between consecutive logins, in ms (jitter added on top). */
function readDelayMs(): number {
  const flag = process.argv.find((a) => a.startsWith("--delay-ms="));
  if (!flag) return 45_000;
  const parsed = Number(flag.split("=")[1]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`[login-bots] invalid --delay-ms: ${flag}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const delayMs = readDelayMs();
  const usernames = readUsernames();
  if (usernames.length === 0) throw new Error("no usernames provided (argv or stdin)");

  const result = (await db.execute(sql`
    SELECT id, ig_username, tier, (session_data IS NOT NULL) AS has_session
    FROM bot_accounts
    WHERE lower(ig_username) IN (${sql.join(
      usernames.map((u) => sql`${u}`),
      sql`, `,
    )})
    ORDER BY ig_username
  `)) as unknown as { rows: BotRow[] };
  const bots = result.rows;

  const found = new Set(bots.map((b) => b.ig_username.toLowerCase()));
  const missing = usernames.filter((u) => !found.has(u));
  if (missing.length) console.log(`[login-bots] NOT IN DB (${missing.length}): ${missing.join(", ")}`);

  console.log(
    `[login-bots] candidates=${bots.length} (sequential, delay=${delayMs}ms+jitter)`,
  );

  let ok = 0;
  let failed = 0;
  let index = 0;
  for (const bot of bots) {
    // Space logins apart. Back-to-back attempts from one gateway are the
    // fastest way to trip Meta's reCAPTCHA challenge for the whole IP pool,
    // which fails otherwise-healthy accounts. Jittered so the cadence does not
    // look metronomic. Override with --delay-ms=0 for a single-bot retry.
    if (index > 0 && delayMs > 0) {
      const jittered = delayMs + Math.floor(Math.random() * delayMs * 0.5);
      await new Promise((resolve) => setTimeout(resolve, jittered));
    }
    index += 1;

    const start = Date.now();
    try {
      const ctx = await ensureBotReady(bot.id);
      ok += 1;
      console.log(
        `[login-bots] PASS @${bot.ig_username} tier=${bot.tier} proxy=${proxyEndpointLabel(ctx.proxyEndpoint)} ms=${Date.now() - start}`,
      );
    } catch (err) {
      failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      console.log(
        `[login-bots] FAIL @${bot.ig_username} tier=${bot.tier} ms=${Date.now() - start} reason=${reason.slice(0, 200)}`,
      );
    }
  }

  console.log(`[login-bots] done ok=${ok} failed=${failed} total=${bots.length}`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
