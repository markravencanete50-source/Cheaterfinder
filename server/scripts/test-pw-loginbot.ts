// Bypass bot-runtime, ensureBotReady, loadBot, ensureProxy. Drive loginBot
// directly with the real codepath to see if it's environmental.

import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { fetchHealthyEndpoints } from "../services/proxy-provider.js";
import { decryptCredential } from "../crypto/credentials.js";
import { loginBot } from "../services/bot-login.js";

interface Row {
  ig_username: string;
  ig_password_encrypted: string;
}

const result = (await db.execute(sql`
  SELECT ig_username, ig_password_encrypted FROM bot_accounts
  WHERE LOWER(ig_username) = LOWER('amaliapaul37')
`)) as unknown as { rows: Row[] };
const bot = result.rows[0];
if (!bot) throw new Error("bot not found");

const igPassword = decryptCredential(bot.ig_password_encrypted);
const [endpoint] = await fetchHealthyEndpoints(1, { country: "US" });
if (!endpoint) throw new Error("no proxy");
console.log("Using proxy:", endpoint.endpoint);

const t0 = Date.now();
try {
  const r = await loginBot(
    { igUsername: bot.ig_username, igPassword },
    { endpoint: endpoint.endpoint },
  );
  console.log(
    "LOGIN OK in",
    Date.now() - t0,
    "ms — outcome:",
    r.outcome,
    "session bytes:",
    r.storageStateJson.length,
  );
} catch (e: any) {
  console.log("LOGIN FAIL after", Date.now() - t0, "ms:", e.message);
}
process.exit(0);
