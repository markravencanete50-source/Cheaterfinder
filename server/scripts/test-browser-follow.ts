// Test whether the Firefox BROWSER transport can follow where HTTP got a login
// wall. If it works, ensureFollows can seed follows via the browser and the
// liked-by squad becomes viable.
// Usage: npx tsx server/scripts/test-browser-follow.ts [N]

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { ensureBotReady } from "../services/bot-runtime.js";
import { resolveFingerprint } from "../behavior/device-fingerprint.js";
import { createBrowserReadClient } from "../ig-browser-read-client.js";

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? "3");
  const { rows } = (await db.execute(sql`
    SELECT DISTINCT b.id, b.ig_username, b.device_id, b.device_user_agent, b.ig_app_id,
           b.timezone, b.locale, b.awake_hour_start, b.awake_hour_end
    FROM bot_accounts b
    JOIN scrape_outcome_log s ON s.bot_id = b.id
    WHERE b.transport='web' AND b.session_data IS NOT NULL AND b.automation_identity IS NOT NULL
      AND s.outcome='success' AND s.occurred_at > NOW()-INTERVAL '3 hours'
      AND (b.cooldown_until IS NULL OR b.cooldown_until < NOW())
    LIMIT ${n}
  `)) as unknown as { rows: Array<Record<string, unknown>> };

  const { rows: t } = (await db.execute(sql`
    SELECT ig_user_id, ig_username FROM tracked_accounts WHERE is_active=true AND ig_user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1
  `)) as unknown as { rows: Array<{ ig_user_id: string; ig_username: string }> };
  const target = t[0];
  console.log(`[bf] testing ${rows.length} web bots via BROWSER, follow target=@${target?.ig_username}(${target?.ig_user_id})`);

  for (const b of rows) {
    const botId = String(b.id), igUsername = String(b.ig_username);
    try {
      const ready = await ensureBotReady(botId);
      const client = await createBrowserReadClient({
        sessionData: ready.sessionData,
        fingerprint: resolveFingerprint({
          igUsername,
          deviceId: b.device_id as string | null,
          deviceUserAgent: b.device_user_agent as string | null,
          igAppId: b.ig_app_id as string | null,
          timezone: b.timezone as string | null,
          locale: b.locale as string | null,
          awakeHourStart: b.awake_hour_start as number | null,
          awakeHourEnd: b.awake_hour_end as number | null,
        }),
        botUsername: igUsername,
        proxyEndpoint: ready.proxyEndpoint,
        botId,
        fallbackToHttp: false,
        automationIdentity: ready.automationIdentity,
      });
      try {
        const r = (await client.fetchRaw!(`/api/v1/friendships/create/${target.ig_user_id}/`, { method: "POST", body: "" })) as {
          friendship_status?: { following?: boolean; outgoing_request?: boolean };
          status?: string;
        };
        console.log(`[bf] @${igUsername}: BROWSER-FOLLOW OK following=${!!r?.friendship_status?.following} outgoing=${!!r?.friendship_status?.outgoing_request} status=${r?.status}`);
      } catch (e) {
        const status = (e as { status?: number })?.status;
        const body = (e as { body?: string })?.body;
        console.log(`[bf] @${igUsername}: BROWSER-FOLLOW FAIL status=${status ?? "?"} ${(e instanceof Error ? e.message : String(e)).slice(0, 60)} ${body ? ":: " + body.slice(0, 90) : ""}`);
      } finally {
        await client.close();
      }
    } catch (e) {
      console.log(`[bf] @${igUsername}: ready/browser FAIL ${(e instanceof Error ? e.message : String(e)).slice(0, 70)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

main().catch((e) => console.error("[bf] ERR", e instanceof Error ? e.message : String(e)))
  .finally(() => pool.end().catch(() => undefined));
