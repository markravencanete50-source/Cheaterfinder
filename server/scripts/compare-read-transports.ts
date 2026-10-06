// Supervised, bounded comparison. NO login, follows, session/proxy replacement,
// scheduling change, automatic promotion, or persistence of returned IG data.
// Exactly one browser read and one HTTP read from the SAME saved viewer state.
// Normal daily budgets apply. --apply is required to send either request.
import "dotenv/config";
import { randomUUID, createHash } from "node:crypto";
import { pool } from "../db.js";
import { decryptSessionData } from "../crypto/session-envelope.js";
import { reserveOrThrow } from "../behavior/daily-budget.js";
import { requireAutomationIdentity } from "../services/automation-identity.js";
import { createAutomationClient, type AutomationInstagramResponse } from "../services/automation-client.js";
import { assertDurableAccountProxyUrl } from "../services/proxy-durability.js";

function arg(name: string): string | undefined {
  return process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
}
function signature(response: AutomationInstagramResponse, endpoint: string) {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(response.body); } catch { /* HTTP 200 HTML is NOT data */ }
  if (!parsed || typeof parsed !== "object") parsed = {};
  const entries = parsed[endpoint === "likers" ? "users" : "comments"];
  const items = Array.isArray(entries) ? entries : [];
  const ids = items.map(item => String(item.pk ?? item.id ?? item.username ?? "")).filter(Boolean).sort();
  const fields = [...new Set(items.flatMap(item => Object.keys(item)))].sort();
  return {
    status: response.status, valid: response.status === 200 && parsed.status !== "fail" && Array.isArray(entries),
    count: items.length, distinct: new Set(ids).size,
    idsDigest: createHash("sha256").update(JSON.stringify(ids)).digest("hex"), fields,
    total: parsed[endpoint === "likers" ? "user_count" : "comment_count"] ?? null,
    hasMore: parsed.has_more_comments ?? parsed.has_more ?? false,
    cursor: parsed.next_max_id ?? parsed.next_min_id ?? null,
    wireBytes: response.wire_bytes_in == null ? null : response.wire_bytes_in + (response.wire_bytes_out ?? 0),
    payloadBytes: Buffer.byteLength(response.body), resources: response.wire_breakdown ?? null,
    reused: response.browser_reused ?? false,
    failure: response.transport_error ?? (parsed.status === "fail" ? String(parsed.error_type ?? "IG rejected read") : null),
  };
}

async function main() {
  const botId = arg("bot-id"), mediaId = arg("media-id"), endpoint = arg("endpoint") ?? "likers";
  if (!botId || !/^[a-f0-9-]{36}$/i.test(botId) || !mediaId || !/^\d+$/.test(mediaId) || !["likers", "comments"].includes(endpoint)) {
    throw new Error("Use --bot-id=<uuid> --media-id=<numeric id> --endpoint=likers|comments [--apply]");
  }
  const { rows: [bot] } = await pool.query(`
    SELECT id, ig_username, session_data, automation_identity, proxy_url
    FROM bot_accounts b WHERE id=$1 AND transport='web' AND role='scraper'
      AND tier IN ('worker','canary') AND status='available'
      AND session_data IS NOT NULL AND automation_identity IS NOT NULL AND proxy_url IS NOT NULL
      AND (cooldown_until IS NULL OR cooldown_until<now())
      AND EXISTS(SELECT 1 FROM scrape_outcome_log s WHERE s.bot_id=b.id AND s.endpoint=$2
        AND s.outcome='success' AND s.occurred_at>now()-interval '24 hours')`, [botId, endpoint]);
  if (!bot) throw new Error("No eligible previously successful viewer; do not use an unproven bot");
  const { rowCount } = await pool.query("SELECT 1 FROM posts_cache WHERE media_id=$1 LIMIT 1", [mediaId]);
  if (!rowCount) throw new Error("Use a post already in the product's cache");
  assertDurableAccountProxyUrl(bot.proxy_url);
  const proxyUrl = new URL(bot.proxy_url.includes("://") ? bot.proxy_url : `http://${bot.proxy_url}`);
  const state = JSON.parse(decryptSessionData(bot.session_data));
  const csrf = state.cookies?.find((c: { name: string }) => c.name === "csrftoken")?.value;
  if (!csrf || !state.cookies?.some((c: { name: string }) => c.name === "sessionid")) throw new Error("Incomplete saved session; no login will be attempted");
  const identity = requireAutomationIdentity(bot.automation_identity, bot.id);
  console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "bounded-live-comparison" : "dry-run", botId, endpoint, mediaId, requests: 2, autoPromote: false }));
  if (!process.argv.includes("--apply")) return;
  const automation = createAutomationClient({ timeoutMs: 65_000 });
  if ((await automation.health()).status !== "ok") throw new Error("Automation service is not ready");
  const results: ReturnType<typeof signature>[] = [];
  // Browser first supplies the working-path control. Both receive the same
  // ORIGINAL saved cookies; a control read must not silently upgrade HTTP auth.
  for (const transport of ["browser", "http"] as const) {
    await reserveOrThrow(botId, endpoint);
    const started = Date.now();
    const input = {
      operation_id: `parity:${randomUUID()}`, deadline_ms: 60_000, identity, storage_state: state,
      proxy: { server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: decodeURIComponent(proxyUrl.username), password: decodeURIComponent(proxyUrl.password) },
      request: { method: "GET" as const, path: `https://www.instagram.com/api/v1/media/${mediaId}/${endpoint}/`,
        headers: { "x-csrftoken": csrf, "x-ig-www-claim": "0" }, referer: "https://www.instagram.com/", timeout_ms: 30_000 },
    };
    const response = await (transport === "browser" ? automation.requestInstagramBrowser(input) : automation.requestInstagramHttp(input));
    const result = signature(response, endpoint);
    results.push(result);
    console.log(JSON.stringify({ transport, durationMs: Date.now() - started, ...result }));
    if (transport === "browser" && !result.valid) {
      console.log("INCONCLUSIVE: browser control failed; no second request and no route change.");
      return;
    }
  }
  const [browser, http] = results;
  const matched = http.valid && browser.count > 0 && browser.idsDigest === http.idsDigest
    && browser.total === http.total && browser.hasMore === http.hasMore && browser.cursor === http.cursor
    && browser.fields.every(field => http.fields.includes(field));
  console.log(JSON.stringify({ comparableSnapshot: matched, decision: matched
    ? "One snapshot matched. Repeat across targets and fresh updates before considering a scoped route canary."
    : "KEEP BROWSER: HTTP has not demonstrated equivalent data and visibility." }));
}

main().catch(error => {
  // Never print response bodies, saved cookies, proxy URLs, or raw SQL params.
  console.error("Comparison stopped:", error instanceof Error ? error.name : "error");
  process.exitCode = 1;
}).finally(() => pool.end());
