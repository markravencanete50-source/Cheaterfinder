// Test whether a WEB watcher bot can actually follow/unfollow — the prerequisite
// for the "unfollow everything except tracked accounts" squad strategy.
//   GET  /friendships/show/<pk>/     (status)
//   POST /friendships/create/<pk>/   (follow)
//   GET  /friendships/<self>/following/  (how many it currently follows)
//   POST /friendships/destroy/<pk>/  (unfollow — tested on the same target to leave state clean)
// Usage: npx tsx server/scripts/test-web-follow.ts [bot_username]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createHttpBotClientWithFingerprint } from "../ig-http-client.js";

async function main(): Promise<void> {
  const uname = process.argv[2];
  const { rows } = (await db.execute(
    uname
      ? sql`SELECT id, ig_username, ig_user_id FROM bot_accounts WHERE lower(ig_username)=${uname.toLowerCase()} LIMIT 1`
      : sql`SELECT id, ig_username, ig_user_id FROM bot_accounts
             WHERE transport='web' AND role IN ('feed_watcher','reels_watcher')
               AND session_data IS NOT NULL AND (cooldown_until IS NULL OR cooldown_until<NOW())
             ORDER BY last_used_at ASC NULLS FIRST LIMIT 1`,
  )) as unknown as { rows: Array<{ id: string; ig_username: string; ig_user_id: string | null }> };
  const bot = rows[0];
  if (!bot) throw new Error("no web watcher found");

  const { rows: t } = (await db.execute(sql`
    SELECT ig_user_id, ig_username FROM tracked_accounts WHERE is_active=true AND ig_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1
  `)) as unknown as { rows: Array<{ ig_user_id: string; ig_username: string }> };
  const target = t[0];

  const ready = await ensureBotReady(bot.id);
  const client = createHttpBotClientWithFingerprint(
    ready.sessionData, null, bot.ig_username, ready.proxyEndpoint, bot.id, ready.automationIdentity,
  );
  console.log(`[follow] bot=@${bot.ig_username} target=@${target?.ig_username}(${target?.ig_user_id})`);

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const r = await fn();
      console.log(`[follow] ${name}: OK ${typeof r === "object" ? JSON.stringify(r).slice(0, 100) : r}`);
    } catch (e) {
      const status = (e as { status?: number })?.status ?? (e as { cause?: { status?: number } })?.cause?.status;
      const body = (e as { body?: string })?.body;
      console.log(`[follow] ${name}: FAIL status=${status ?? "?"} ${(e instanceof Error ? e.message : String(e)).slice(0, 70)} ${body ? ":: " + body.slice(0, 90) : ""}`);
    }
    await new Promise((r) => setTimeout(r, 3500));
  };

  await step("friendship_status(show)", () => client.fetchRaw!(`/api/v1/friendships/show/${target.ig_user_id}/`));
  await step("follow(create)", () => client.fetchRaw!(`/api/v1/friendships/create/${target.ig_user_id}/`, { method: "POST", body: "" }));
  await step("my_following", () => client.fetchRaw!(`/api/v1/friendships/${bot.ig_user_id ?? ready.igUsername}/following/?count=5`));
  await step("unfollow(destroy)", () => client.fetchRaw!(`/api/v1/friendships/destroy/${target.ig_user_id}/`, { method: "POST", body: "" }));

  await client.close();
}

main().catch((e) => console.error("[follow] ERR", e instanceof Error ? e.message : String(e)))
  .finally(() => pool.end().catch(() => undefined));
