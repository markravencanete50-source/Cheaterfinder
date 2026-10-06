// Import bots that ship a READY WEB SESSION (cookie string containing BOTH
// sessionid AND csrftoken). Unlike the TOTP batches these need NO login, which
// removes the single most ban-prone step in onboarding, and unlike the mobile
// Bearer sessions they carry a csrftoken so the existing WEB transport (and
// therefore the likers endpoint) works directly.
//
// Line format (pipe-delimited):
//   username|password|cookie=v;cookie=v;...|email
//   username|password|TOTP|cookie=v;cookie=v;...|email|phone(optional)
//
// Usage:
//   npx tsx server/scripts/import-web-session-bots.ts --input FILE [--dry-run]
//        [--tier reserve] [--port-base 10800] [--tag sellerA]
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { encryptCredential, validateBotCredKey } from "../crypto/credentials.js";
import { encryptSessionData, validateSessionDataKey } from "../crypto/session-envelope.js";
import { provisionAutomationIdentity } from "../services/automation-identity-provision.js";
import { parseWebSessionBotInput } from "../services/web-session-bot-import.js";

function arg(f: string): string | undefined {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1]?.trim() : undefined;
}

/** Build the Playwright storage-state JSON the web client expects. */
function buildStorageState(c: Record<string, string>): string {
  const cookies = Object.entries(c)
    // x-mid is a header, not a cookie; skip anything obviously non-cookie.
    .filter(([k]) => !k.toLowerCase().startsWith("x-"))
    .map(([name, value]) => ({
      name, value,
      domain: ".instagram.com",
      path: "/",
      expires: -1,          // session cookie → filterLiveCookies keeps it
      httpOnly: name === "sessionid",
      secure: true,
      sameSite: "Lax" as const,
    }));
  return JSON.stringify({ cookies, origins: [] });
}

function proxyUrl(portBase: number, i: number): string {
  const rawUser = process.env.STATIC_PROXY_USERNAME ?? "";
  const account = rawUser.split("__")[0];
  const password = process.env.STATIC_PROXY_PASSWORD ?? "";
  const host = process.env.STATIC_PROXY_HOST ?? "gw.dataimpulse.com";
  if (!account || !password) throw new Error("STATIC_PROXY_* not configured");
  const proxy = new URL(`http://${host}:${portBase + i}`);
  proxy.username = `${account}__sessttl.120`;
  proxy.password = password;
  return proxy.toString().replace(/\/$/, "");
}

async function main(): Promise<void> {
  const input = arg("--input"); if (!input) throw new Error("--input required");
  const dry = process.argv.includes("--dry-run");
  const tier = arg("--tier") ?? "reserve";
  if (tier !== "reserve") throw new Error("Import into reserve; promote only after a live session check");
  const portBase = Number(arg("--port-base") ?? "10800");
  const tag = arg("--tag") ?? "web-session";

  const rows = parseWebSessionBotInput(readFileSync(input, "utf8"));
  if (!Number.isInteger(portBase) || portBase < 10000 || portBase + rows.length - 1 > 20000) throw new Error("Proxy ports must fit in the sticky range 10000–20000");

  if (dry) {
    console.log(JSON.stringify({ ok: true, dryRun: true, count: rows.length,
      sample: rows.slice(0, 3).map(r => ({ u: r.username, hasTotp: !!r.totp, hasEmail: !!r.email,
        cookieKeys: Object.keys(r.cookies).join(",") })) }, null, 1));
    return;
  }

  validateBotCredKey(); validateSessionDataKey();
  let n = 0;
  for (const [i, r] of rows.entries()) {
    const inserted = (await db.execute(sql`
      INSERT INTO bot_accounts (
        ig_username, ig_user_id, ig_password_encrypted, totp_secret, email_address,
        session_data, transport, automation_identity, proxy_url,
        status, tier, role, locale, timezone, display_name,
        last_login_at, last_login_error, login_attempt_count, updated_at
      ) VALUES (
        ${r.username}, ${r.cookies.ds_user_id ?? null}, ${encryptCredential(r.password)},
        ${r.totp ? encryptCredential(r.totp) : null}, ${r.email},
        ${encryptSessionData(buildStorageState(r.cookies))}, 'web', NULL, ${proxyUrl(portBase, i)},
        'session_expired', ${tier}, 'scraper', 'en-US', 'America/New_York', ${tag},
        NULL, 'Imported session awaiting verification', 0, NOW()
      )
      ON CONFLICT (ig_username) DO UPDATE SET
        ig_user_id = EXCLUDED.ig_user_id,
        ig_password_encrypted = EXCLUDED.ig_password_encrypted,
        totp_secret = EXCLUDED.totp_secret,
        email_address = EXCLUDED.email_address,
        session_data = EXCLUDED.session_data,
        transport = 'web', proxy_url = EXCLUDED.proxy_url,
        status = 'session_expired', tier = ${tier}, display_name = ${tag},
        last_login_at = NULL, last_login_error = 'Imported session awaiting verification', login_attempt_count = 0, updated_at = NOW()
      RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };
    // leaseBot requires automation_identity IS NOT NULL and the web client is
    // built from it — without this step an imported bot is never leased.
    const botId = inserted.rows[0]?.id;
    if (botId) {
      const identity = await provisionAutomationIdentity({
        id: botId, locale: "en-US", timezone: "America/New_York",
      });
      await db.execute(sql`
        UPDATE bot_accounts SET automation_identity = ${JSON.stringify(identity)}::jsonb
        WHERE id = ${botId} AND automation_identity IS NULL
      `);
    }
    n++;
  }
  console.log(JSON.stringify({ ok: true, imported: n, tag, tier, portRange: `${portBase}-${portBase + n - 1}` }));
}
main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => undefined); });
