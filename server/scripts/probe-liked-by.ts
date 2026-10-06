// Phase 0 probe: can we extract "Liked by @followed_user" social proof from a
// bot's home/explore/reels feeds? Tries several candidate endpoints with a live
// bot session and reports which return data + whether social-context fields are
// present. Raw payloads are written to scratch for inspection; only a masked
// summary is printed.

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { createBotClient } from "../ig-http-client.js";

const OUT_DIR = process.argv[2] ?? "/tmp";

interface Candidate {
  name: string;
  path: string;
  method: "GET" | "POST";
  body?: string;
}

const CANDIDATES: Candidate[] = [
  { name: "timeline", path: "/api/v1/feed/timeline/", method: "POST", body: "reason=cold_start_fetch&is_pull_to_refresh=0" },
  { name: "explore", path: "/api/v1/discover/topical_explore/?is_prefetch=false&omit_cover_media=true&use_sectional_payload=true&timezone_offset=0&include_fixed_destinations=true", method: "GET" },
  { name: "reels_tray", path: "/api/v1/feed/reels_tray/", method: "GET" },
  { name: "clips_home", path: "/api/v1/clips/home/", method: "POST", body: "" },
  { name: "clips_discover", path: "/api/v1/clips/discover/", method: "POST", body: "" },
];

// Substrings that would indicate "liked by someone you follow" social proof.
const SIGNALS = ["social_context", "liked_by", "liked by", "Liked by", "explore_story", "netego", "algorithm", "social_proof", "friendship_status", "seen_state"];

function scan(raw: unknown): { size: number; hits: Record<string, number>; samples: string[] } {
  const s = JSON.stringify(raw ?? {});
  const hits: Record<string, number> = {};
  for (const sig of SIGNALS) {
    const m = s.split(sig).length - 1;
    if (m > 0) hits[sig] = m;
  }
  // capture short snippets around the strongest "liked by"-style signal
  const samples: string[] = [];
  for (const sig of ["social_context", "Liked by", "liked by"]) {
    const i = s.indexOf(sig);
    if (i >= 0) samples.push(s.slice(Math.max(0, i - 40), i + 120));
  }
  return { size: s.length, hits, samples };
}

async function main(): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT b.id, b.ig_username,
           (SELECT count(*) FROM bot_follow_requests r WHERE r.bot_account_id = b.id AND r.status::text = 'accepted') AS follows
    FROM bot_accounts b
    WHERE b.status = 'available' AND b.session_data IS NOT NULL
      AND (b.cooldown_until IS NULL OR b.cooldown_until < NOW())
    ORDER BY follows DESC NULLS LAST, b.last_used_at ASC NULLS FIRST
    LIMIT 1
  `)) as unknown as { rows: Array<{ id: string; ig_username: string; follows: number }> };

  const bot = rows.rows[0];
  if (!bot) throw new Error("no live leasable bot found");
  console.log(`[probe] using bot @${bot.ig_username} (accepted_follows=${bot.follows ?? 0})`);

  const ready = await ensureBotReady(bot.id);
  const client = createBotClient(ready.sessionData, {
    botUsername: bot.ig_username,
    botId: bot.id,
    proxyEndpoint: ready.proxyEndpoint,
    automationIdentity: ready.automationIdentity,
  }) as ReturnType<typeof createBotClient> & {
    fetchRaw: (path: string, opts?: { method?: string; body?: string }) => Promise<unknown>;
  };

  for (const c of CANDIDATES) {
    try {
      const raw = await client.fetchRaw(c.path, { method: c.method, body: c.body });
      const r = scan(raw);
      writeFileSync(`${OUT_DIR}/probe_${c.name}.json`, JSON.stringify(raw, null, 2));
      console.log(`[probe] ${c.name.padEnd(15)} OK  bytes=${r.size}  signals=${JSON.stringify(r.hits)}`);
      for (const s of r.samples) console.log(`         ↳ ${s.replace(/\s+/g, " ")}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[probe] ${c.name.padEnd(15)} FAIL ${msg.slice(0, 120)}`);
    }
  }

  await client.close();
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
