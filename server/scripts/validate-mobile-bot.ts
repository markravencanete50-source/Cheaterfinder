// Validate ONE mobile-transport bot end-to-end through the exact production
// path: ensureBotReady() → parseMobileEnvelope() → createMobileReadClient(),
// then exercise several read endpoints against a public target. Read-only.
//
// Usage: npx tsx server/scripts/validate-mobile-bot.ts <bot_username> [target_username]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { parseMobileEnvelope } from "../services/mobile-session.js";
import { createMobileReadClient } from "../ig-mobile-read-client.js";

async function main(): Promise<void> {
  const botUsername = process.argv[2];
  const target = process.argv[3] ?? "instagram";
  if (!botUsername) throw new Error("usage: validate-mobile-bot.ts <bot_username> [target]");

  const { rows } = (await db.execute(sql`
    SELECT id, ig_username, transport FROM bot_accounts
    WHERE lower(ig_username) = ${botUsername.toLowerCase()} LIMIT 1
  `)) as unknown as { rows: Array<{ id: string; ig_username: string; transport: string }> };
  const bot = rows[0];
  if (!bot) throw new Error(`bot ${botUsername} not found`);
  console.log(`[validate] bot=${bot.ig_username} transport=${bot.transport}`);

  const ready = await ensureBotReady(bot.id);
  console.log(`[validate] ready: transport=${ready.transport} proxy=${ready.proxyEndpoint?.split(":").slice(0, 2).join(":")} autoIdent=${ready.automationIdentity ? "yes" : "no"}`);

  const session = parseMobileEnvelope(ready.sessionData);
  if (!session) throw new Error("session_data is not a valid mobile envelope");
  console.log(`[validate] envelope: dsUserId=${session.dsUserId} bearer=${session.bearer.slice(0, 18)}… androidId=${session.androidId}`);

  const client = createMobileReadClient({
    session,
    proxyEndpoint: ready.proxyEndpoint,
    botId: bot.id,
    botUsername: bot.ig_username,
  });

  const results: Record<string, string> = {};

  // Pace requests to mimic the production limiter (COLLECTION_IG_LIMITER_MAX=4/min
  // + jitter). A brand-new session on a fresh IP is soft-blocked by IG if it
  // fires a dozen endpoints in a few seconds — that is throttling, not a dead
  // session. Real collection never bursts like that.
  const paceMs = Number(process.argv[4] ?? "5000");
  let first = true;
  const run = async (name: string, fn: () => Promise<string>): Promise<void> => {
    if (!first) await new Promise((r) => setTimeout(r, paceMs));
    first = false;
    try {
      results[name] = `OK ${await fn()}`;
    } catch (e) {
      results[name] = `FAIL ${errmsg(e)}`;
    }
  };

  let pk = "";
  let firstMediaId = "";
  let highlightIds: string[] = [];

  await run("fetchProfile", async () => {
    const p = await client.fetchProfile(target);
    pk = p.pk;
    return `@${p.username} pk=${p.pk} followers=${p.followerCount} posts=${p.postCount}`;
  });
  if (!pk) {
    console.log("[validate] endpoint results:");
    for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${v}`);
    console.log("[validate] RESULT_DEAD (profile fetch failed — cannot chain)");
    await client.close();
    return;
  }

  await run("fetchProfileById", async () => {
    const b = await client.fetchProfileById(pk);
    return `@${b.username} followers=${b.followerCount}`;
  });
  await run("fetchUserFeed", async () => {
    const feed = await client.fetchUserFeed(pk, { count: 6 });
    firstMediaId = feed.items[0]?.id ?? "";
    return `items=${feed.items.length} firstMedia=${firstMediaId || "none"}`;
  });
  await run("fetchUserClips", async () => {
    const c = await client.fetchUserClips(pk, { count: 4 });
    return `items=${c.items.length}`;
  });
  await run("fetchUserTagged", async () => {
    const t = await client.fetchUserTagged(pk, { count: 4 });
    return `items=${t.items.length}`;
  });
  await run("fetchFollowers", async () => {
    const f = await client.fetchFollowers(pk, { count: 12 });
    return `users=${f.users.length} nextMaxId=${f.nextMaxId ? "yes" : "no"}`;
  });
  await run("fetchFollowing", async () => {
    const f = await client.fetchFollowing(pk, { count: 12 });
    return `users=${f.users.length} nextMaxId=${f.nextMaxId ? "yes" : "no"}`;
  });
  await run("fetchStoriesTray", async () => {
    const s = await client.fetchStoriesTray(pk);
    return `items=${s.items.length}`;
  });
  await run("fetchHighlightsTray", async () => {
    const h = await client.fetchHighlightsTray(pk);
    highlightIds = h.items.slice(0, 2).map((i) => i.id);
    return `trays=${h.items.length}`;
  });
  await run("fetchHighlightReels", async () => {
    if (highlightIds.length === 0) return "skipped (no highlight trays)";
    const reels = await client.fetchHighlightReels(highlightIds);
    return `reels=${reels.length} media=${reels.reduce((n, r) => n + r.items.length, 0)}`;
  });
  await run("fetchMediaComments", async () => {
    if (!firstMediaId) return "skipped (no media id)";
    const c = await client.fetchMediaComments(firstMediaId);
    return `comments=${c.comments.length}`;
  });
  await run("fetchMediaLikers", async () => {
    if (!firstMediaId) return "skipped (no media id)";
    const l = await client.fetchMediaLikers(firstMediaId);
    return `likers=${l.users.length} count=${l.totalCount ?? "?"}`;
  });

  await client.close();

  console.log("[validate] endpoint results:");
  for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${v}`);
  const anyOk = Object.values(results).some((v) => v.startsWith("OK"));
  console.log(anyOk ? "[validate] RESULT_LIVE (mobile session authenticated)" : "[validate] RESULT_DEAD (no endpoint returned data)");
}

function errmsg(e: unknown): string {
  const base = (e instanceof Error ? e.message : String(e)).slice(0, 120);
  const body = (e as { body?: string })?.body;
  return body ? `${base} :: ${body.slice(0, 200)}` : base;
}

void main()
  .catch((e: unknown) => {
    console.error("[validate] ERROR", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
