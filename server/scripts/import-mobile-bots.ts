// Import pre-authenticated Instagram MOBILE sessions into the bot pool.
//
// Each raw line (pipe-delimited) is:
//   username:password:totp | user-agent | android-id;uuid;uuid;uuid | k=v;k=v;...
// carrying a live `Authorization: Bearer IGT:2:<base64>` token + an Android
// device fingerprint (see server/services/mobile-session.ts). These are driven
// against i.instagram.com by server/ig-mobile-read-client.ts — NO Firefox
// automation identity and NO csrftoken required.
//
// Imported rows are stored as:
//   transport = 'mobile'
//   session_data = encrypted mobile envelope   (round-trips via readSession)
//   status = 'available', tier = 'worker'       (immediately leasable)
//   proxy_url = a durable per-bot DataImpulse sticky lane
//   ig_password_encrypted + totp_secret         (for record / future re-login)
// so they enter rotation right away — the whole point of a pre-auth session is
// to skip the ban-prone login step.
//
// Usage:
//   npx tsx server/scripts/import-mobile-bots.ts --input /secure/path/mobile.txt
//   npx tsx server/scripts/import-mobile-bots.ts --input ... --dry-run
//   npx tsx server/scripts/import-mobile-bots.ts --input ... --port-base 10700
//   npx tsx server/scripts/import-mobile-bots.ts --input ... --tier reserve

import "dotenv/config";

import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { encryptCredential, validateBotCredKey } from "../crypto/credentials.js";
import {
  encryptSessionData,
  validateSessionDataKey,
} from "../crypto/session-envelope.js";
import {
  parseMobileSessionLine,
  serializeMobileSession,
  type ParsedMobileLine,
} from "../services/mobile-session.js";

const IG_ANDROID_APP_ID = "567067343352427";

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1]?.trim() : undefined;
}

/**
 * Build a durable per-bot DataImpulse sticky proxy_url from env. Uses the
 * configured account (STATIC_PROXY_USERNAME's account prefix + STATIC_PROXY_PASSWORD)
 * with a `__sessttl.120` sticky session and a distinct port per bot — the exact
 * shape the live web pool already runs on, so it passes the lease durability
 * guard and gives each mobile session a stable residential exit IP.
 */
function buildProxyUrl(portBase: number, index: number): string {
  const rawUser = process.env.STATIC_PROXY_USERNAME ?? "";
  const account = rawUser.split("__")[0];
  const password = process.env.STATIC_PROXY_PASSWORD ?? "";
  const host = process.env.STATIC_PROXY_HOST ?? "gw.dataimpulse.com";
  if (!account || !password) {
    throw new Error(
      "import-mobile-bots: STATIC_PROXY_USERNAME / STATIC_PROXY_PASSWORD not configured",
    );
  }
  const port = portBase + index;
  const username = `${account}__sessttl.120`;
  return `http://${username}:${password}@${host}:${port}`;
}

function parseInput(contents: string): ParsedMobileLine[] {
  const out: ParsedMobileLine[] = [];
  const seen = new Set<string>();
  for (const [offset, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let parsed: ParsedMobileLine;
    try {
      parsed = parseMobileSessionLine(line);
    } catch (err) {
      throw new Error(
        `line ${offset + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const key = parsed.credentials.username.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`line ${offset + 1}: duplicate username ${parsed.credentials.username}`);
    }
    seen.add(key);
    out.push(parsed);
  }
  if (out.length === 0) throw new Error("input contains no mobile session rows");
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const inputPath = argValue(argv, "--input");
  if (!inputPath) {
    throw new Error("usage: --input <mobile-session-file> [--dry-run] [--port-base N] [--tier worker|reserve]");
  }
  const portBase = Number(argValue(argv, "--port-base") ?? "10700");
  if (!Number.isInteger(portBase) || portBase < 10000 || portBase > 19900) {
    throw new Error("--port-base must be an integer in [10000, 19900]");
  }
  const tier = (argValue(argv, "--tier") ?? "worker").toLowerCase();
  if (tier !== "worker" && tier !== "reserve" && tier !== "canary") {
    throw new Error("--tier must be worker | canary | reserve");
  }

  const rows = parseInput(readFileSync(inputPath, "utf8"));

  if (dryRun) {
    console.log(
      JSON.stringify({
        ok: true,
        dryRun: true,
        botCount: rows.length,
        sample: rows.slice(0, 3).map((r) => ({
          username: r.credentials.username,
          dsUserId: r.session.dsUserId,
          hasTotp: Boolean(r.credentials.totpSecret),
          uaPrefix: r.session.userAgent.slice(0, 28),
        })),
      }),
    );
    return;
  }

  validateBotCredKey();
  validateSessionDataKey();

  let imported = 0;
  for (const [index, { credentials, session }] of rows.entries()) {
    const encryptedSession = encryptSessionData(serializeMobileSession(session));
    const encryptedPassword = encryptCredential(credentials.password);
    const proxyUrl = buildProxyUrl(portBase, index);

    await db.execute(sql`
      INSERT INTO bot_accounts (
        ig_username,
        ig_user_id,
        ig_password_encrypted,
        totp_secret,
        session_data,
        transport,
        automation_identity,
        proxy_url,
        proxy_endpoint,
        proxy_expires_at,
        device_user_agent,
        ig_app_id,
        status,
        tier,
        role,
        locale,
        timezone,
        last_login_at,
        last_login_error,
        login_attempt_count,
        updated_at
      ) VALUES (
        ${credentials.username},
        ${session.dsUserId},
        ${encryptedPassword},
        ${credentials.totpSecret},
        ${encryptedSession},
        'mobile',
        NULL,
        ${proxyUrl},
        NULL,
        NULL,
        ${session.userAgent},
        ${IG_ANDROID_APP_ID},
        'available',
        ${tier},
        'scraper',
        'en-US',
        'America/New_York',
        NOW(),
        NULL,
        0,
        NOW()
      )
      ON CONFLICT (ig_username) DO UPDATE SET
        ig_user_id = EXCLUDED.ig_user_id,
        ig_password_encrypted = EXCLUDED.ig_password_encrypted,
        totp_secret = EXCLUDED.totp_secret,
        session_data = EXCLUDED.session_data,
        transport = 'mobile',
        automation_identity = NULL,
        proxy_url = EXCLUDED.proxy_url,
        proxy_endpoint = NULL,
        proxy_expires_at = NULL,
        device_user_agent = EXCLUDED.device_user_agent,
        ig_app_id = EXCLUDED.ig_app_id,
        status = 'available',
        tier = ${tier},
        last_login_at = NOW(),
        last_login_error = NULL,
        login_attempt_count = 0,
        updated_at = NOW()
    `);
    imported += 1;
  }

  console.log(
    JSON.stringify({
      ok: true,
      imported,
      transport: "mobile",
      status: "available",
      tier,
      portRange: `${portBase}-${portBase + rows.length - 1}`,
    }),
  );
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
